/**
 * 矿山智工 - 渲染端本地模型客户端
 *
 * 统一封装 preload 的 llm 桥：
 *   · Electron 模式：走 window.electronAPI.llm（主进程 node-llama-cpp）
 *   · 浏览器模式（vite dev / e2e）：无桥可用，统一降级为 "unavailable"，
 *     由叙述层回退模板——演示永不露怯，e2e 也天然覆盖降级路径。
 */

/** 当前环境是否有本地模型引擎（仅 Electron 打包/开发模式） */
export function llmAvailable() {
  return !!(
    typeof window !== 'undefined' &&
    window.electronAPI &&
    window.electronAPI.llm
  )
}

/** 查询引擎状态：{ state, error, info }，state: idle|loading|ready|generating|failed|unavailable */
export async function llmStatus() {
  if (!llmAvailable()) return { state: 'unavailable', error: '当前为浏览器模式，无本地模型引擎', info: null }
  try {
    return await window.electronAPI.llm.status()
  } catch (err) {
    return { state: 'failed', error: err && err.message || String(err), info: null }
  }
}

/** 触发加载（幂等，主进程内部状态机去重） */
export async function llmLoad() {
  if (!llmAvailable()) return { ok: false, error: '浏览器模式无本地模型引擎' }
  try {
    return await window.electronAPI.llm.load()
  } catch (err) {
    return { ok: false, error: err && err.message || String(err) }
  }
}

/**
 * 流式生成：返回 Promise（完整结果），增量通过 onChunk 回调
 * @param {string} prompt
 * @param {{ onChunk?: (text:string)=>void, signal?: AbortSignal }} opts
 */
export async function llmGenerate(prompt, { onChunk, signal } = {}) {
  if (!llmAvailable()) return { ok: false, error: '浏览器模式无本地模型引擎', aborted: false }

  const stop = onChunk
    ? window.electronAPI.llm.onProgress(({ text }) => { if (text) onChunk(text) })
    : null
  const doneStop = window.electronAPI.llm.onDone((r) => { /* 结果已由 invoke 返回，此处仅保持通道活跃 */ })

  try {
    return await window.electronAPI.llm.generate(prompt)
  } finally {
    if (stop) stop()
    if (doneStop) doneStop()
  }
}

/** 取消当前生成 */
export async function llmCancel() {
  if (!llmAvailable()) return false
  try {
    const r = await window.electronAPI.llm.cancel()
    return !!(r && r.ok)
  } catch {
    return false
  }
}

/**
 * 叙述 prompt 模板（"结论说成人话"）
 * 硬约束：逐条复述要点、只润色、不新增数字/事实；原结论数字原样保留
 * （0.5B 模型自由概括会失真，必须引导它"复述"，语义才能保真）
 * @param {string} conclusionText 规则引擎已核实的结论（纯文本）
 */
export function buildNarratePrompt(conclusionText) {
  const text = String(conclusionText || '').trim()
  if (!text) return ''
  return [
    '你是矿山设备健康管理助理。请把下面这段已经核实的结论，逐条复述要点，改写成几句口语化的中文说明，给矿场一线人员看。',
    '要求：只润色表达、逐条复述，禁止新增、删减或改写任何数字、型号、日期、健康状态、设备名称等事实；原结论中的数字必须原样保留。',
    '重要：不要使用任何序号、编号或项目符号（如 加括号的编号、第一、其一），直接按要点自然连成通顺的话。',
    '重要：不要提到原结论中没有的任何设备、编号或数值。',
    '原结论如下：',
    text
  ].join('\n')
}

/** 从文本中提取数字集合（用于"数字不变量"断言） */
export function extractNumbers(text) {
  const matches = String(text || '').match(/-?\d+(?:\.\d+)?/g)
  return matches ? Array.from(new Set(matches)) : []
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

/**
 * 数字不变量校验：生成结果里的数字必须都来自原结论
 * @param {string} conclusion 原结论纯文本
 * @param {string} generated  模型生成文本
 */
export function verifyNumbersSubset(conclusion, generated) {
  const src = new Set(extractNumbers(conclusion))
  const gen = extractNumbers(generated)
  const violated = gen.filter((n) => !src.has(n))
  return { ok: violated.length === 0, violated, sourceNumbers: Array.from(src) }
}

/**
 * 清理 0.5B 模型常见的"序号化"输出（无法靠指令禁止，只能在输出侧清洗）：
 * 剥掉括号序号 (1)（2）、"要点一/第X点"前缀与"改写成"字样，压缩空白。
 * 只影响展示与校验，不参与任何数字计算；正常正文中的数字不受影响。
 * @param {string} text
 */
export function normalizeNarrated(text) {
  const s = String(text || '')
  // 先剥离模型对 prompt 的复读段（"…改写结果"之后才是真正回答）
  const echoIdx = s.lastIndexOf('改写结果')
  const body = echoIdx >= 0 ? s.slice(echoIdx + 4) : s
  return dedupeLoop(body)
    .replace(/[（(]\s*\d+\s*[)）]/g, '')
    .replace(/(要点[一二三四五六七八九十\d]+|第[一二三四五六七八九十\d]+[点项])[：:，,、\s]*/g, '')
    .replace(/[一二三四五六七八九十]{1,3}[、.．]/g, '')
    // 阿拉伯数字点序号（"1. xxx"）：仅当紧跟在行首或标点之后，避免误伤"78.5 分"
    .replace(/(^|[：:，,、\n])\s*\d+[.．、]\s*/g, '$1')
    .replace(/(要点如下|口语化的中文说明|改写结果)[：:，,]?/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
