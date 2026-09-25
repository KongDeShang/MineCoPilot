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

// ============================================================
// 体验优化：润色开关 + 结果缓存
// ============================================================

/**
 * 用户可关闭"本地模型润色"（AI 助手头部的开关）。
 * 关闭后叙述层不再被调用，直接展示规则引擎原始结论 ——
 * 慢机器上避免等待感，也符合"功能不降级"原则。
 * 持久化在 localStorage（仅界面偏好，不进 .mbak 备份）。
 */
const NARRATION_KEY = 'ks:narration-enabled'

export function isNarrationEnabled() {
  if (typeof localStorage === 'undefined') return true
  return localStorage.getItem(NARRATION_KEY) !== '0'
}

export function setNarrationEnabled(enabled) {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(NARRATION_KEY, enabled ? '1' : '0')
}

/**
 * 叙述结果缓存：同一结论（同人设、同原文）的润色结果直接复用，不再重复生成。
 * 0.5B 纯 CPU 每次生成要数秒，而 AI 助手里"同一台设备反复问"是高频场景。
 * 仅内存缓存（刷新失效），最多 50 条，FIFO 淘汰；内容已经过数字不变量校验才入缓存。
 */
const narrateCache = new Map()
const NARRATE_CACHE_LIMIT = 50

function cacheKey(plain, persona) {
  return `${persona || ''}${plain}`
}

function cacheGet(key) {
  const v = narrateCache.get(key)
  if (v === undefined) return undefined
  // LRU：命中后移到末尾
  narrateCache.delete(key)
  narrateCache.set(key, v)
  return v
}

function cacheSet(key, value) {
  if (narrateCache.has(key)) narrateCache.delete(key)
  narrateCache.set(key, value)
  while (narrateCache.size > NARRATE_CACHE_LIMIT) {
    narrateCache.delete(narrateCache.keys().next().value)
  }
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
  if (!isNarrationEnabled()) return { mode: 'fallback', reason: 'narration-off' }
  if (!llmAvailable()) return { mode: 'fallback', reason: 'browser' }

  const st = await llmStatus()
  if (st.state !== 'ready' && st.state !== 'generating') {
    return { mode: 'fallback', reason: st.state || 'unknown', error: st.error }
  }

  const plain = htmlToText(html).slice(0, maxChars)
  if (!plain) return { mode: 'fallback', reason: 'empty-conclusion' }

  const key = cacheKey(plain, persona)
  const cached = cacheGet(key)
  if (cached) {
    // 缓存命中：文本已过数字不变量校验，直接回放（含流式回调，保持调用方行为一致）
    if (onChunk) onChunk(cached)
    return { mode: 'local', text: cached, cached: true }
  }

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
  cacheSet(key, text)
  return { mode: 'local', text }
}
