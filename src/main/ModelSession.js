/**
 * 矿山智工 - 模型会话管理
 *
 * 职责：管理"当前档位"模型的完整生命周期——加载（懒）、生成、释放。
 *   - 换档时先释放旧会话，再加载新档（内存不被两份模型占用）；
 *   - getLlama 运行时实例进程级共享，不随会话释放（避免反复初始化）；
 *   - 本模块只做 llama.cpp 层操作（loadModel / createContext / generate / dispose），
 *     叙述 prompt 组装与数字不变量校验分别在 llmEngine / llmClient 层，职责分离。
 *
 * 仅主进程使用（node-llama-cpp 在渲染进程会崩溃）。
 * 铁律：skipDownload 禁止联网下载二进制；离线不足即报错，不静默挂起。
 */
const fs = require('fs')

class ModelSession {
  constructor() {
    this.llama = null       // node-llama-cpp Llama 实例（进程级共享）
    this.tier = null        // 当前档位元数据（ModelRegistry TIERS 条目）
    this.tierId = null      // 当前档位 id
    this.model = null
    this.context = null
    this.completion = null
  }

  get loaded() {
    return !!this.completion
  }

  /**
   * 加载指定档位（幂等：同档位已加载则直接返回；换档先释放旧会话）。
   * @param {object} tier 档位元数据（含 file/contextSize）
   * @param {string} filePath GGUF 绝对路径
   * @returns {Promise<{ok: true, tierId: string}>}
   */
  async load(tier, filePath) {
    if (this.loaded && this.tierId === tier.id) return { ok: true, tierId: tier.id }

    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(
        `模型文件不存在：${filePath || tier.file}\n` +
        `（请将 GGUF 放入 resources/models/${tier.id}/ 或 userData/models/${tier.id}/，再到模型中心切换）`
      )
    }

    // 换档：先释放旧会话，避免两份模型同时占用内存
    await this.dispose()

    // node-llama-cpp 是 ESM-only 包，commonjs 主进程必须用动态 import
    const { getLlama, LlamaCompletion } = await import('node-llama-cpp')
    // skipDownload：node-llama-cpp 默认会在找不到本地预编译二进制时联网下载。
    // 本应用承诺"全离线"，一旦走到那条路径就不只是违背承诺，而是在矿场/内网机器上
    // 静默挂起直到超时。这里明确禁止联网：二进制缺失就如实报错，宁可不加载模型。
    this.llama = this.llama || await getLlama({ skipDownload: true })

    this.model = await this.llama.loadModel({ modelPath: filePath })
    this.context = await this.model.createContext({ contextSize: tier.contextSize || 1024 })
    this.completion = new LlamaCompletion({ contextSequence: this.context.getSequence() })
    this.tier = tier
    this.tierId = tier.id
    return { ok: true, tierId: tier.id }
  }

  /**
   * 生成文字（流式回调 onChunk），参数按当前档位元数据取值。
   * @param {string} prompt 已组装的模型输入（含 chat 模板）
   * @param {(text: string) => void} onChunk
   * @param {AbortSignal} signal
   * @returns {Promise<{ok: true, text: string, tierId: string}>}
   */
  async generate(prompt, onChunk, signal) {
    if (!this.loaded) return { ok: false, error: '模型未加载' }
    const tier = this.tier || {}
    const res = await this.completion.generateCompletion(prompt, {
      maxTokens: tier.maxTokens || 128,
      temperature: tier.temperature !== undefined ? tier.temperature : 0.2,
      topP: 0.9,
      customStopTriggers: ['<|im_end|>'],
      onTextChunk: (text) => {
        if (typeof onChunk === 'function') onChunk(text)
      },
      signal
    })
    return {
      ok: true,
      // 清理自定义停止词触发的残留分隔符（node-llama-cpp 会把 trigger 片段留在末尾）
      text: String(res || '').replace(/\|+$/g, '').trim(),
      tierId: this.tierId
    }
  }

  /**
   * 释放当前会话（切档/退出前调用）。防御式：dispose 不存在或失败都不阻塞主流程。
   */
  async dispose() {
    const targets = [this.completion, this.context, this.model]
    this.completion = null
    this.context = null
    this.model = null
    this.tier = null
    this.tierId = null
    for (const t of targets) {
      if (t && typeof t.dispose === 'function') {
        try { await t.dispose() } catch { /* 释放失败不影响主流程 */ }
      }
    }
  }
}

module.exports = ModelSession
