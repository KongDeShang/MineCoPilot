/**
 * 矿山智工 - 本地模型引擎（node-llama-cpp 封装）
 *
 * 职责：在主进程加载本地 GGUF 模型，向渲染端提供流式生成能力。
 * 设计立场（与"可审计 AI"叙事一致）：
 *   1. 本地模型只做"叙述层"——把规则引擎已核实的结论改写成人话，
 *      不参与任何数字计算（数字永远由规则引擎出，可审计）；
 *   2. 完全离线：模型文件随安装包内置（extraResources），无任何云端依赖；
 *   3. 状态机清晰可观测：idle → loading → ready / failed → generating，
 *      任何失败都带原因，渲染端据此降级回模板叙述；
 *   4. 模型可插拔（Task 06）：档位元数据/自动选档在 ModelRegistry，
 *      会话加载/生成/释放在 ModelSession，本引擎负责状态机与 IPC。
 *
 * 仅主进程使用（node-llama-cpp 在渲染进程会崩溃）。
 */
const path = require('path')
const fs = require('fs')
const { app } = require('electron')
const ModelRegistry = require('./ModelRegistry')
const ModelSession = require('./ModelSession')

const { scanTiers, autoSelectTier, getTierMeta } = ModelRegistry

/** 会话实例：管理当前档位的模型加载/生成/释放 */
const session = new ModelSession()

/**
 * 模型搜索根（双源，Task 07 落地后 userData/models 为可下载落盘目录）：
 *   1. resources/models（dev 用项目根 resources，打包后用安装目录 resources）——只读随包
 *   2. userData/models（用户下载/自放的模型）——可写
 */
function modelRoots() {
  const base = app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '../../resources')
  const roots = [path.join(base, 'models')]
  try { roots.push(path.join(app.getPath('userData'), 'models')) } catch { /* userData 不可用时仅用随包目录 */ }
  return roots
}

/** 档位偏好持久化（userData/model-pref.json） */
function prefPath() {
  try { return path.join(app.getPath('userData'), 'model-pref.json') } catch { return '' }
}
function readPref() {
  try { return JSON.parse(fs.readFileSync(prefPath(), 'utf8')) } catch { return {} }
}
function writePref() {
  try { fs.writeFileSync(prefPath(), JSON.stringify({ tierId: currentTierId }, null, 2), 'utf8') } catch { /* 写失败不阻塞 */ }
}

/**
 * 解析当前档位：优先取持久化偏好（且已安装），否则按内存自动选档。
 * 目录约定：<root>/<tier.id>/<file>；light 档兼容旧版按模型名目录（qwen2.5-0.5b/）。
 */
function resolveCurrentTierId() {
  const scanned = scanTiers(modelRoots())
  const pref = readPref().tierId
  if (pref && scanned.find(t => t.id === pref && t.installed)) return pref
  return autoSelectTier(scanned)
}

/** 当前档位 id（可切换并持久化） */
let currentTierId = resolveCurrentTierId()

/** 按档位解析模型文件绝对路径；找不到返回 null */
function resolveModelFile(tier) {
  const subs = [tier.id]
  if (tier.id === 'light') subs.push('qwen2.5-0.5b') // 旧版目录兼容
  for (const root of modelRoots()) {
    for (const sub of subs) {
      const p = path.join(root, sub, tier.file)
      if (fs.existsSync(p)) return p
    }
  }
  return null
}

let activeController = null

let state = 'idle' // idle | loading | ready | generating | failed
let loadError = ''
let modelInfo = null

/**
 * 内置系统提示词：把"可审计 AI"立场写死在引擎层
 * （模型只能润色，不能创造事实——与渲染端 prompt 双保险）
 */
const SYSTEM_PROMPT = [
  '你是矿山智工内置的本地叙述助手。',
  '你的唯一任务：把用户给出的已经核实的结论，改写成 2-4 句口语化中文，给矿场一线人员看。',
  '硬性要求：',
  '1. 禁止新增任何数字、型号、日期、百分比或结论之外的事实；',
  '2. 原结论中的数字必须原样保留，一字不改；',
  '3. 不得改变原结论的含义，不得输出"根据分析""综上所述"等前缀；',
  '4. 只输出改写后的文字本身。'
].join('\n')

/**
 * 组装 Qwen2.5 chat 模板（手动构造，规避 wrapper 的 eogToken 空输出问题）
 * @param {string} userPrompt 渲染端已生成的"润色指令 + 结论"
 */
function buildChatPrompt(userPrompt) {
  return [
    '<|im_start|>system\n' + SYSTEM_PROMPT + '<|im_end|>\n',
    '<|im_start|>user\n' + userPrompt + '<|im_end|>\n',
    '<|im_start|>assistant\n'
  ].join('')
}

/** 当前引擎状态（供 IPC 查询） */
function getStatus() {
  return {
    state,
    error: loadError,
    info: modelInfo,
    currentTierId,
    modelDir: modelRoots()[0] || null
  }
}

/**
 * 确保模型已加载（幂等）。
 * 返回 { ok, error?, info? }
 */
async function ensureLoaded() {
  if (state === 'ready' || state === 'generating') return { ok: true, info: modelInfo }
  if (state === 'loading') return { ok: false, error: '模型加载中，请稍候' }
  if (state === 'failed') {
    // 允许重试：清掉失败标记，重新走加载
    state = 'idle'
  }

  const tier = getTierMeta(currentTierId) || getTierMeta('light')
  currentTierId = tier.id
  const file = resolveModelFile(tier)

  state = 'loading'
  loadError = ''
  const started = Date.now()
  try {
    if (!file) {
      throw new Error(
        `模型文件不存在（档位：${tier.id} · ${tier.displayName}）\n` +
        `请将 GGUF 放入 resources/models/${tier.id}/ 或 userData/models/${tier.id}/，再到模型中心切换。`
      )
    }

    await session.load(tier, file)

    const stat = fs.statSync(file)
    modelInfo = {
      name: tier.displayName,
      file: tier.file,
      size: stat.size,
      path: file,
      loadMs: Date.now() - started,
      tierId: tier.id,
      capabilities: tier.capabilities
    }
    state = 'ready'
    return { ok: true, info: modelInfo }
  } catch (err) {
    state = 'failed'
    loadError = err && err.message ? err.message : String(err)
    return { ok: false, error: loadError }
  }
}

/**
 * 生成文字（流式回调 onChunk）
 * @param {string} prompt
 * @param {(text: string) => void} onChunk
 * @param {AbortSignal} signal
 */
async function generate(prompt, onChunk, signal) {
  const loaded = await ensureLoaded()
  if (!loaded.ok) return { ok: false, error: loaded.error }

  state = 'generating'
  const started = Date.now()
  try {
    const built = buildChatPrompt(prompt)
    const res = await session.generate(built, onChunk, signal)
    const result = {
      ok: res.ok,
      text: res.text || '',
      elapsedMs: Date.now() - started,
      tierId: res.tierId
    }
    state = 'ready'
    return result
  } catch (err) {
    const msg = err && err.message ? err.message : String(err)
    const aborted = !!(err && (err.name === 'AbortError' || /abort/i.test(msg)))
    // 中断不视为失败：回到 ready 可继续用
    state = aborted ? 'ready' : 'failed'
    if (!aborted) loadError = msg
    return { ok: false, error: msg, aborted }
  }
}

/** 取消当前生成 */
function cancel() {
  if (activeController) {
    try { activeController.abort() } catch { /* 忽略 */ }
    activeController = null
    return true
  }
  return false
}

/**
 * 列出所有档位：元数据 + 安装状态 + 当前档位
 */
function listModels() {
  const tiers = scanTiers(modelRoots())
  return { ok: true, tiers, current: currentTierId, state }
}

/**
 * 切换档位：校验 → 释放旧会话（若换档）→ 加载新档；失败回退原档不成立（原档已释放，
 * 但状态机回到 failed 且带原因，渲染层可一键切回）。
 */
async function switchModel(id) {
  const tier = getTierMeta(id)
  if (!tier) return { ok: false, error: `未知档位：${id}` }

  if (id === currentTierId && (state === 'ready' || state === 'generating')) {
    return { ok: true, info: modelInfo, state, current: currentTierId, switched: false }
  }

  currentTierId = id
  writePref()
  if (session.loaded && session.tierId !== id) {
    await session.dispose()
  }
  state = 'idle'
  loadError = ''
  modelInfo = null
  const r = await ensureLoaded()
  return { ok: r.ok, error: r.error || '', info: modelInfo, state, current: currentTierId, switched: true }
}

/**
 * 注册 IPC（由主进程 registerIpc 调用）
 */
function registerLlmIpc({ ipcMain }) {
  const assertTrusted = (event) => {
    const url = event.senderFrame?.url || event.sender.getURL()
    const ok = app.isPackaged ? url.startsWith('file://') : url.startsWith('http://localhost:5173')
    if (!ok) throw new Error('拒绝来自不可信来源的 IPC 调用')
  }

  ipcMain.handle('llm:status', (event) => { assertTrusted(event); return getStatus() })

  ipcMain.handle('llm:load', async (event) => {
    assertTrusted(event)
    const r = await ensureLoaded()
    return { ok: r.ok, error: r.error || '', info: modelInfo, state }
  })

  ipcMain.handle('llm:generate', async (event, payload) => {
    assertTrusted(event)
    const prompt = String(payload && payload.prompt || '').slice(0, 4000)
    if (!prompt) return { ok: false, error: '提示词为空' }

    const controller = new AbortController()
    activeController = controller

    const send = (chunk) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('llm:progress', { text: chunk })
      }
    }
    const r = await generate(prompt, send, controller.signal)
    if (!event.sender.isDestroyed()) {
      event.sender.send('llm:done', r)
    }
    return r
  })

  ipcMain.handle('llm:cancel', (event) => { assertTrusted(event); return { ok: cancel() } })

  ipcMain.handle('llm:listModels', (event) => { assertTrusted(event); return listModels() })

  ipcMain.handle('llm:switchModel', async (event, payload) => {
    assertTrusted(event)
    const id = String(payload && payload.id || '')
    if (!id) return { ok: false, error: '缺少档位 id' }
    return switchModel(id)
  })
}

/**
 * 安装/启动自检（环境变量 KUANGSHAN_LLM_VERIFY=1 触发）：
 * 加载模型 + 生成一次测试文本 + 校验数字不变量，结果写入 userData/llm-verify.json。
 * 正式交付功能：安装后首次启动可做健康自检；也用于自动化验证打包产物。
 */
async function runSelfVerify() {
  const result = {
    at: new Date().toISOString(),
    state: 'pending',
    ok: false,
    faithful: false,
    loadMs: null,
    generateMs: null,
    text: '',
    error: '',
    tierId: currentTierId
  }
  try {
    const t0 = Date.now()
    const loaded = await ensureLoaded()
    result.loadMs = Date.now() - t0
    if (!loaded.ok) {
      result.state = 'failed'
      result.error = loaded.error || '模型加载失败'
    } else {
      const conclusion = '【1号挖掘机】健康分 78.5 分（B级），维保超期 5 天，液压油压力偏低，建议 3 天内完成保养。'
      const tg = Date.now()
      const r = await generate(buildNarrateTestPrompt(conclusion), null, new AbortController().signal)
      result.generateMs = Date.now() - tg
      if (!r.ok) {
        result.state = 'failed'
        result.error = r.error || '生成失败'
      } else {
        // 清洗 0.5B 常见序号化输出（(1)(2)… / 要点X… / 编号循环），再校验数字不变量
        const text = normalizeNarrated(r.text)
        const src = new Set((conclusion.match(/-?\d+(?:\.\d+)?/g) || []))
        const gen = new Set((text.match(/-?\d+(?:\.\d+)?/g) || []))
        const violated = [...gen].filter((n) => !src.has(n))
        result.state = 'ready'
        // ok = 链路健康（加载 + 非空生成），是安装验收口径
        result.ok = text.length > 0
        // faithful = 数字保真（尽力而为；0.5B 偶发幻觉时由叙述层自动回退，不阻断产品）
        result.faithful = violated.length === 0
        result.text = text
        if (!result.ok) result.error = '生成文本为空'
        else if (!result.faithful) result.error = `数字保真未达标（模型新造数字：${violated.join(',')}，叙述层将自动回退规则叙述）`
      }
    }
  } catch (err) {
    result.state = 'failed'
    result.error = err && err.message ? err.message : String(err)
  }
  try {
    const out = path.join(app.getPath('userData'), 'llm-verify.json')
    fs.writeFileSync(out, JSON.stringify(result, null, 2), 'utf8')
  } catch (err) {
    result.error += `（写验证文件失败：${err.message}）`
  }
  return result
}

function buildNarrateTestPrompt(conclusion) {
  return [
    '你是矿山设备健康管理助理。请把下面这段已经核实的结论，逐条复述要点，改写成几句口语化的中文说明，给矿场一线人员看。',
    '要求：只润色表达、逐条复述，禁止新增、删减或改写任何数字、型号、日期、健康状态、设备名称等事实；原结论中的数字必须原样保留。',
    '重要：不要使用任何序号、编号或项目符号（如 加括号的编号、第一、其一），直接按要点自然连成通顺的话。',
    '重要：不要提到原结论中没有的任何设备、编号或数值。',
    '原结论如下：',
    conclusion
  ].join('\n')
}

/** 与渲染进程 llmClient.normalizeNarrated 一致：剥 prompt 复读、序号与循环，压缩空白 */
function normalizeNarrated(text) {
  const s = String(text || '')
  const echoIdx = s.lastIndexOf('改写结果')
  const body = echoIdx >= 0 ? s.slice(echoIdx + 4) : s
  return dedupeLoop(body)
    .replace(/[（(]\s*\d+\s*[)）]/g, '')
    .replace(/(要点[一二三四五六七八九十\d]+|第[一二三四五六七八九十\d]+[点项])[：:，,、\s]*/g, '')
    .replace(/[一二三四五六七八九十]{1,3}[、.．]/g, '')
    .replace(/(^|[：:，,、\n])\s*\d+[.．、]\s*/g, '$1')
    .replace(/(要点如下|口语化的中文说明|改写结果)[：:，,]?/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 压缩 0.5B 常见的循环重复输出：找到首个长句的第二次出现位置并截断 */
function dedupeLoop(text) {
  const t = String(text || '').trim()
  if (t.length <= 60) return t
  const firstClause = t.slice(0, 40)
  const secondIdx = t.indexOf(firstClause, 20)
  if (secondIdx > 20) return t.slice(0, secondIdx).trim()
  return t
}

module.exports = { registerLlmIpc, getStatus, ensureLoaded, runSelfVerify, listModels, switchModel }
