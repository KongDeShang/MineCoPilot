/**
 * 矿山智工 - 日期工具
 *
 * 演示数据不写死绝对日期，而是以「相对今天的偏移天数」生成，
 * 保证任何一天演示时，"已超期 N 天""N 天后到期"这类数字都成立。
 */

/** 把 Date 格式化为 YYYY-MM-DD */
export function formatDate(date) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 把 Date 格式化为 YYYY-MM-DD HH:mm */
export function formatDateTime(date) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${formatDate(d)} ${hh}:${mm}`
}

/** 今天往前 offset 天的 YYYY-MM-DD（offset 为负数即未来） */
export function daysAgoDate(offset) {
  const d = new Date()
  d.setDate(d.getDate() - offset)
  return formatDate(d)
}

/** 今天往前 offset 天的 YYYY-MM-DD HH:mm */
export function daysAgoDateTime(offset) {
  const d = new Date()
  d.setDate(d.getDate() - offset)
  return formatDateTime(d)
}

/** 当前时刻的 YYYY-MM-DD HH:mm */
export function now() {
  return formatDateTime(new Date())
}

/** 解析 YYYY-MM-DD 或 YYYY-MM-DD HH:mm，非法输入返回 null（不返回 NaN 时间） */
export function parseDate(value) {
  if (!value) return null
  const raw = String(value).trim()
  if (!raw) return null
  const normalized = raw.replace(/\//g, '-').replace(' ', 'T')
  const d = new Date(normalized)
  return Number.isNaN(d.getTime()) ? null : d
}

/** 自 value 起过去了多少天；无法解析时返回 null */
export function daysSince(value) {
  const d = parseDate(value)
  if (!d) return null
  return Math.floor((Date.now() - d.getTime()) / 86400000)
}

/** 在 value 之上加 days 天，返回 YYYY-MM-DD */
export function addDays(value, days) {
  const d = parseDate(value)
  if (!d) return ''
  d.setDate(d.getDate() + Number(days || 0))
  return formatDate(d)
}

/** 设备计划维保到期日（上次维保日期 + 周期天数） */
export function dueDate(lastMaintenanceDate, cycleDays) {
  return addDays(lastMaintenanceDate, cycleDays || 90)
}

/** 距到期还有几天（负数表示已超期）；无法计算时返回 null */
export function daysUntilDue(lastMaintenanceDate, cycleDays) {
  const due = parseDate(dueDate(lastMaintenanceDate, cycleDays))
  if (!due) return null
  const base = new Date()
  base.setHours(0, 0, 0, 0)
  return Math.round((due.getTime() - base.getTime()) / 86400000)
}

/** 设备年龄（年）；无法计算时返回 null，调用方需自行处理 */
export function equipmentAgeYears(purchaseDate) {
  const d = parseDate(purchaseDate)
  if (!d) return null
  return (Date.now() - d.getTime()) / (365.25 * 86400000)
}

/**
 * 把种子数据里的绝对日期整体平移到「距今相同的偏移」
 * @param {string} value    形如 2026-09-12 或 2026-09-12 09:30
 * @param {number} dayShift 天数偏移（正数=往前挪）
 */
export function shiftDate(value, dayShift) {
  if (!value) return value
  const raw = String(value).trim()
  const timePart = raw.length > 10 ? raw.slice(10) : ''
  const shifted = addDays(raw, dayShift)
  if (!shifted) return value
  return timePart ? `${shifted}${timePart}` : shifted
}

/**
 * 演示数据的基准日：种子数据里的日期都按这一天编写，
 * 运行时统一平移到真实今天，保证演示数字稳定。
 */
export const SEED_BASE_DATE = '2026-09-12'

/** 种子基准日到今天的平移天数 */
export function seedShiftDays() {
  const base = parseDate(SEED_BASE_DATE)
  if (!base) return 0
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  base.setHours(0, 0, 0, 0)
  return Math.round((today.getTime() - base.getTime()) / 86400000)
}
