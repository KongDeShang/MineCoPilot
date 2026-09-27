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

/** 列出所有模型档位及安装状态 */
export async function llmListModels() {
  if (!llmAvailable()) return { ok: false, error: '浏览器模式无本地模型引擎', models: [], current: null }
  try {
    return await window.electronAPI.llm.listModels()
  } catch (err) {
    return { ok: false, error: err && err.message || String(err), models: [], current: null }
  }
}

/** 切换模型档位 */
export async function llmSwitchModel(id) {
  if (!llmAvailable()) return { ok: false, error: '浏览器模式无本地模型引擎' }
  try {
    return await window.electronAPI.llm.switchModel(id)
  } catch (err) {
    return { ok: false, error: err && err.message || String(err) }
  }
}

/**
 * 叙述 prompt 模板（"结论说成人话"）
 * 硬约束：逐条复述要点、只润色、不新增数字/事实；原结论数字原样保留
 * （0.5B 模型自由概括会失真，必须引导它"复述"，语义才能保真）
 * @param {string} conclusionText 规则引擎已核实的结论（纯文本）
 */
export function buildNarratePrompt(conclusionText, persona) {
  const text = String(conclusionText || '').trim()
  if (!text) return ''
  return [
    persona
      ? `你是矿山设备健康管理助理。${persona}`
      : '你是矿山设备健康管理助理。请把下面这段已经核实的结论，逐条复述要点，改写成几句口语化的中文说明，给矿场一线人员看。',
    persona
      ? '请把下面这段已经核实的结论，按上面的要求逐条复述要点，改写成几句口语化的中文说明，给矿场一线人员看。'
      : '',
    '要求：只润色表达、逐条复述，禁止新增、删减或改写任何数字、型号、日期、健康状态、设备名称等事实；原结论中的数字必须原样保留。',
    '重要：不要使用任何序号、编号或项目符号（如 加括号的编号、第一、其一），直接按要点自然连成通顺的话。',
    '重要：不要提到原结论中没有的任何设备、编号或数值。',
    '原结论如下：',
    text
  ].filter(Boolean).join('\n')
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
 * 叙述形状守卫：模型"接不上"的时候会改成**反问 / 复读 prompt**，而不是复述结论。
 *
 * 与 verifyNumbersSubset 是**两件事**，互不替代：那个管"数字有没有新造"（内容不变量），
 * 这个管"这段话到底是不是在复述结论"（形状）。0.5B 在老师傅模式下实测回过：
 *   「根据上述文档内容，以下哪些是徐工设计、制造的起重机的配置和特点？」
 *   「请告知维保到期后，是否需要进行维保或更换设备？」
 * 这两句**数字一个都不违规**（原文里有的数字它照抄），所以数字校验拦不住；
 * 它也不算"生成失败"（非空、没报错、没有异常），于是会原样显示给用户 ——
 * 屏幕上印一句反问，比"回退到规则原文"难看得多。
 *
 * 判据只取**能枚举、能测**的三类特征，不去判断"像不像叙述"：
 *   ① 结尾是问号 —— 复述结论是陈述句。**只看结尾**：结论原文里本身可能有问号
 *      （手册切片、用户原话），模型的忠实复述不会以它收尾；
 *   ② 指的是 **prompt 本身** 的措辞（"上述/以上文档"、"以下哪些"、"问题中的"）——
 *      叙述要指也是指设备与结论，永远不需要引用"上面那段文字"；
 *   ③ 把问题推回给用户的措辞（"请告知"、"麻烦提供"、"需要我"…）——
 *      实测那两句里的"请告知"；后面几个是同一类的泛化，没单独实测过；
 *   ④ 去掉标点后过短（0.5B 偶尔只吐一句"好的"）。
 *
 * 取舍方向与数字校验一致：**宁可少说，不可说错**。误判的代价只是"这次展示内置结论"
 * （叙述是锦上添花），漏判的代价是屏幕上出现一句答非所问。特征表刻意保持**窄** ——
 * "根据以上"这类会出现在正常叙述里的词就没有放进来（放了会把锦上添花一起打掉）。
 *
 * 如实说明一处边界：输出**中间**夹一句反问、既不收尾、也不含 ②③ 那几类措辞时拦不住。
 * 这是已知的不覆盖，不是"已覆盖"。
 *
 * @param {string} text 已 normalizeNarrated 的文本
 * @returns {{ok: boolean, reason: string, hit: string}}
 */
export function verifyNarrationShape(text) {
  const s = String(text || '').trim()
  const compact = s.replace(/[\s，。、；：…·'"（）()【】]/g, '')
  if (compact.length < 8) return { ok: false, reason: 'shape-empty', hit: compact }

  if (/[？?]\s*$/.test(s)) return { ok: false, reason: 'shape-question', hit: '结尾问号' }

  const echo = s.match(/(上述|以上)(文档|资料|内容|文字|段落|问题)|以下哪些|下列哪些|问题中的|这份(文档|资料)/)
  if (echo) return { ok: false, reason: 'shape-echo', hit: echo[0] }

  const askBack = s.match(/请告知|麻烦(您)?(提供|告知)|需要我|能否提供|您可以(先)?告诉我/)
  if (askBack) return { ok: false, reason: 'shape-ask-back', hit: askBack[0] }

  return { ok: true, reason: '', hit: '' }
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
