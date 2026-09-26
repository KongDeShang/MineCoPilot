/**
 * 矿山智工 - 模型注册表
 *
 * 管理可用模型档位的元数据、安装状态检测、自动选档逻辑。
 *
 * 档位设计（Q4_K_M 量化，2026-09-16 修正：Qwen2.5 无 1.7B 型号，标准档实为 1.5B）：
 *   light     — Qwen2.5-0.5B  468MB  任意内存   narrate（叙述润色）
 *   standard  — Qwen2.5-1.5B  ~1.04GB ≥8GB     narrate（诊断/摘要为声明，未接线）
 *   enhanced  — Qwen3-4B      ~2.5GB  ≥16GB    预留，无云端下载源
 *
 * ⚠️ capabilities 里除 narrate 外的能力（diagnose / summarize / reason）**目前没有任何
 * 调用方**：全仓渲染它们的只有两处界面角标（ModelHub.vue / ModelWizard.vue），
 * llmGenerate 的调用方是 utils/narrate.js（叙述）与模型页自测按钮。也就是说，
 * 换成标准档目前只买到"叙述更长 + 上下文窗口更大"，**不产生任何新功能**。
 * `description` 是直接渲染到界面上的文案，因此按实现如实写，不写没接线的能力；
 * 角标侧由 ModelHub.vue 的 ACTIVE_CAPS 区分「已启用 / 预留」。
 * （决策见 docs/完善计划.md P1-6：先收敛口径，接线列为后续可选项。）
 *
 * 铁律：注册表只做元数据和选档，不加载模型。
 */
const path = require('path')
const fs = require('fs')
const os = require('os')

/** 档位定义 */
const TIERS = [
  {
    id: 'light',
    name: '轻量档',
    displayName: 'Qwen2.5-0.5B-Instruct（本地内置）',
    file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
    sizeBytes: 468 * 1024 * 1024,
    minMemoryGB: 0,
    capabilities: ['narrate'],
    description: '叙述润色：把规则引擎结论改写成人话',
    contextSize: 1024,
    temperature: 0.2,
    maxTokens: 128
  },
  {
    id: 'standard',
    name: '标准档',
    displayName: 'Qwen2.5-1.5B-Instruct',
    file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    sizeBytes: 1117320736,
    minMemoryGB: 8,
    capabilities: ['narrate', 'diagnose', 'summarize'],
    description: '叙述润色加强：叙述更长、上下文窗口更大（诊断 / 摘要尚未接线）',
    contextSize: 2048,
    temperature: 0.3,
    maxTokens: 256
  },
  {
    id: 'enhanced',
    name: '增强档',
    displayName: 'Qwen3-4B-Instruct',
    file: 'qwen3-4b-instruct-q4_k_m.gguf',
    sizeBytes: 2.5 * 1024 * 1024 * 1024,
    minMemoryGB: 16,
    capabilities: ['narrate', 'diagnose', 'summarize', 'reason'],
    description: '预留档位：暂无云端下载源，当前不可安装',
    contextSize: 4096,
    temperature: 0.3,
    maxTokens: 512
  }
]

/**
 * 扫描模型目录，检测哪些档位已安装。
 * 预留双源：resources/models + userData/models（Task 07 落地）。
 * 目录约定：<root>/<tier.id>/<file>；旧版 light 档按模型名目录（qwen2.5-0.5b/）自动兼容。
 *
 * @param {string[]} searchDirs 模型搜索目录列表
 * @returns {Object[]} 每个档位附加 installed / installedPath / installedSize
 */
const LEGACY_DIRS = { light: ['qwen2.5-0.5b'] } // 旧版模型目录（按模型名），向后兼容

function scanTiers(searchDirs) {
  return TIERS.map(tier => {
    let installed = false
    let installedPath = null
    let installedSize = 0

    const candidateSubs = [tier.id, ...(LEGACY_DIRS[tier.id] || [])]
    for (const dir of searchDirs) {
      for (const sub of candidateSubs) {
        const filePath = path.join(dir, sub, tier.file)
        try {
          if (fs.existsSync(filePath)) {
            const stat = fs.statSync(filePath)
            installed = true
            installedPath = filePath
            installedSize = stat.size
            break
          }
        } catch { /* 文件系统错误静默跳过 */ }
      }
      if (installed) break
    }

    return { ...tier, installed, installedPath, installedSize }
  })
}

/**
 * 逐根定位某档位（**不短路**），回答"这个档位在哪几份、哪一份会被真正加载"。
 *
 * 为什么不复用 scanTiers：它在第一个命中的根目录就 break。随包副本与下载副本同时存在时，
 * 它只报靠前的那一份 —— 而"这个档位能不能删"问的恰恰是"用户下载的那份在不在"，
 * 短路取值会把"有可删副本"误报成"没有"（删除按钮不出现，1GB 空间释放不掉）；
 * 也会把"删掉下载副本后随包那份还在、档位依然可用"误判成"档位消失"（当前档位被错误改掉）。
 * 删除功能的两类错误（删不掉 / 删了还在）都出在这个短路语义上。
 *
 * @param {Object} tier TIERS 中的档位定义
 * @param {string[]} searchDirs 搜索根，顺序即优先级（靠前的先被加载）
 * @returns {{ effective: string|null, roots: Array<{dir:string, path:string|null, sub:string|null}> }}
 */
function locateTier(tier, searchDirs) {
  const subs = [tier.id, ...(LEGACY_DIRS[tier.id] || [])]
  const roots = searchDirs.map((dir) => {
    for (const sub of subs) {
      const filePath = path.join(dir, sub, tier.file)
      try {
        if (fs.existsSync(filePath)) return { dir, path: filePath, sub }
      } catch { /* 同 scanTiers：文件系统错误跳过 */ }
    }
    return { dir, path: null, sub: null }
  })
  const first = roots.find(r => r.path)
  return { effective: first ? first.path : null, roots }
}

/**
 * 档位在磁盘上可能用的目录名：`<tier.id>` 加上旧版按模型名命名的目录。
 * 删除时要一并清理 —— 只删 `<tier.id>` 会把旧目录留在磁盘上，
 * 界面显示"已删除"而档位仍然 installed（且空间没释放）。
 */
function tierDirNames(tierId) {
  return [tierId, ...(LEGACY_DIRS[tierId] || [])]
}

/**
 * 自动选档：根据系统内存选择最高可用档位。
 *
 * ⚠️ 调用方注意：**一个档位都没装时它也会返回 'light'**（最后那行兜底）。因此它不适合
 * 用来判断"还剩什么可用"，也不能拿它给"刚刚被删掉的档位"重新选档 —— 会把指针指到
 * 一个不存在的档位上。调用方需自行过滤掉将被删除的档位，并处理"一个都不剩"的情况。
 *
 * @param {Object[]} scannedTiers scanTiers 的返回结果
 * @returns {string} 推荐档位 id
 */
function autoSelectTier(scannedTiers) {
  const totalGB = os.totalmem() / (1024 * 1024 * 1024)
  // 从高到低尝试：内存足够且已安装的最高档位
  for (const tier of [...scannedTiers].reverse()) {
    if (totalGB >= tier.minMemoryGB && tier.installed) {
      return tier.id
    }
  }
  // 内存不足或没有任何模型已安装，回退到 light（如果已安装）
  const light = scannedTiers.find(t => t.id === 'light')
  if (light && light.installed) return 'light'
  // 什么都没有，返回 light 作为默认（加载时会报文件不存在）
  return 'light'
}

/**
 * 获取档位元数据（不含安装状态）
 * @param {string} id
 * @returns {Object|null}
 */
function getTierMeta(id) {
  return TIERS.find(t => t.id === id) || null
}

// 这里曾有一个 getAllTiers()（返回 TIERS 的浅拷贝）。它没有任何调用方——
// 需要全量档位的 modelManager 直接 `for (const t of TIERS)`，渲染层的档位列表
// 走 models:list → modelManager，也不经过它。留着只会让人以为档位有两条出口。
module.exports = { TIERS, scanTiers, locateTier, tierDirNames, autoSelectTier, getTierMeta }