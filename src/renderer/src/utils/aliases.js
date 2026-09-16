/**
 * 设备口语别名
 *
 * 为什么需要：
 *   台账上的设备名形如「徐工 XE215C 挖掘机-03」，但现场口述时说的是
 *   「小松」「挖机三号」「老李那台泵车」。nlCommand 的设备指代解析里，
 *   别名是仅次于全名精确匹配的第二层 —— 没有别名，用户的口语说法就落到
 *   最后一层模糊打分上，命中不稳定甚至猜错设备。
 *
 * 存法：
 *   库里是**一行文本**（equipment.aliases，顿号/逗号/分号分隔），
 *   内存里是**字符串数组**。列表页/表单直接改数组，落库与回读都由
 *   parseAliases/formatAliases 两个函数转换，别处不要再写一套切分逻辑。
 */

/** 分隔符：用户想到哪个打哪个，中英文都认 */
const SEPARATORS = /[、,，;；/|]+/

/**
 * 把库里/表单里的一行别名文本切成数组
 * @param {string|string[]|null|undefined} value
 * @returns {string[]} 去空、去重后的别名数组（永远是数组，不会是 null）
 */
export function parseAliases(value) {
  if (Array.isArray(value)) {
    return dedupe(value.map(v => String(v == null ? '' : v).trim()))
  }
  if (value === null || value === undefined) return []
  return dedupe(String(value).split(SEPARATORS).map(s => s.trim()))
}

/**
 * 把别名数组拼成库里存的一行文本
 * @param {string|string[]|null|undefined} value
 * @returns {string} 顿号分隔，空则返回空串
 */
export function formatAliases(value) {
  return parseAliases(value).join('、')
}

function dedupe(list) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    if (!item || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}
