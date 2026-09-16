/**
 * 矿山智工 - 本地模型叙述层
 *
 * 把规则引擎/知识库已经核实的结论（HTML）交给本地模型改写成"人话"。
 * 铁律（与"可审计 AI"叙事一致）：
 *   · 模型不参与任何数字计算，只润色表达；
 *   · 任何环节失败（浏览器模式 / 引擎未就绪 / 生成失败 / 输出为空）
 *     都静默回退 —— 主答案照常展示，演示永不露怯；
 *   · 生成文本中的数字必须 ⊆ 原结论数字（verifyNumbersSubset 兜底）。
 */
import {
  llmAvailable,
  llmStatus,
  llmGenerate,
  buildNarratePrompt,
  verifyNumbersSubset,
  normalizeNarrated
} from './llmClient'

/** HTML 转纯文本（去掉标签与空白压缩），供 prompt 使用 */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 单次叙述（非流式）：适合自检/测试场景
 * @param {string} html 结论 HTML
 * @returns {Promise<{mode:'local'|'fallback', text?:string, reason?:string}>}
 */
export async function narrateConclusion(html, { maxChars = 1200 } = {}) {
  const r = await narrateConclusionStream(html, { maxChars })
  return r
}

/**
 * 流式叙述：增量通过 onChunk 回调
 * @param {string} html
 * @param {{ maxChars?: number, onChunk?: (t:string)=>void }} opts
 */
export async function narrateConclusionStream(html, { maxChars = 1200, onChunk, persona } = {}) {
  if (!llmAvailable()) return { mode: 'fallback', reason: 'browser' }

  const st = await llmStatus()
  if (st.state !== 'ready' && st.state !== 'generating') {
    return { mode: 'fallback', reason: st.state || 'unknown', error: st.error }
  }

  const plain = htmlToText(html).slice(0, maxChars)
  if (!plain) return { mode: 'fallback', reason: 'empty-conclusion' }

  const prompt = buildNarratePrompt(plain, persona)
  const r = await llmGenerate(prompt, { onChunk })
  if (!r.ok || !r.text || !r.text.trim()) {
    return { mode: 'fallback', reason: r.error || 'empty-output' }
  }

  const text = normalizeNarrated(r.text)
  // 数字不变量兜底：模型新造的数字一律丢弃叙述，回退主答案（序号化输出已被清洗）
  const check = verifyNumbersSubset(plain, text)
  if (!check.ok) {
    return { mode: 'fallback', reason: 'number-mismatch', violated: check.violated }
  }
  return { mode: 'local', text }
}
