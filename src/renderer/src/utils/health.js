/**
 * 矿山智工 - 设备健康评分与风险等级（公共模块）
 *
 * 设计原则：**全部可解释、可复现、可审计**。
 * 每个因子除了分数，还带上"计算式（formula）"与"数据来源（source）"，
 * 供体检报告做溯源标注——工业场景需要的不是更聪明的结论，是敢签字的结论。
 *
 * 四因子：维保及时性 / 设备机龄 / 故障状态 / 数据完整度
 *
 * 本模块是唯一评分实现：Equipment.vue、WorkOrder.vue、体检报告、知识库问答全部引用这里，
 * 不再各自维护一份（历史遗留的重复实现已删除）。
 *
 * ⚠️ 四条已修正的历史缺陷（不要在重构时写回去）：
 *   1) 超期扣分与"逼近周期扣 10"曾叠加 → 改为互斥，超期设备只按超期扣分
 *   2) 购置日期缺失时曾用 parseInt('') 得到 NaN，所有比较为 false → 机龄分满分
 *      （"数据越缺失、健康分越高"的反向激励）→ 现显式处理为 0 年并扣数据完整度分
 *   3) 停机估算曾忽略设备状态 → 已趴窝设备算出最低损失 → 现由 getDowntimeDays 补偿
 *   4) 风险分档曾只有 3 级且超期>30 天强制 high → 所有超期设备挤在同一等级
 *      → 现为 4 级（A/B/C/D）+ 分级强制升级规则
 */
import { parseDate, daysUntilDue, equipmentAgeYears } from './dates'

// ============================================================
// 风险等级（4 级）
// ============================================================

/**
 * 四个等级的颜色 = tokens.css 里的同名令牌值（翠绿/品牌中蓝/琥珀/危险）。
 * 为什么这里写死 hex 而不用 var(--emerald)：
 *   这四个值会被绑到 SVG 的 stroke / fill 上（看板饼图、病历趋势线、台账评级条），
 *   而 **SVG 表现属性不解析 var()** —— 写成 var() 不会报错，图直接变黑。
 *   所以色值只能在这里以字面量形式存在一份；它同时被 CSS 与 SVG 两条路消费，
 *   改色只需改这一处。改这里时记得同步 tokens.css 的对应令牌。
 * 旧值是 Element Plus 默认色板（#67c23a/#409eff/#e6a23c/#f56c6c）——
 * 与本项目的品牌蓝并排放是两套绿、两套蓝，故统一到品牌色板。
 */
export const RISK_LEVELS = {
  A: { label: '优', desc: '状态良好，按计划执行即可', color: '#12a06b', factor: 0.1 },
  B: { label: '良', desc: '需关注，建议本周期内安排', color: '#3d5f9c', factor: 0.3 },
  C: { label: '预警', desc: '建议尽快安排处置', color: '#e0a020', factor: 0.5 },
  D: { label: '严重', desc: '需立即处置，存在停机风险', color: '#e0413e', factor: 0.7 }
}

/** 各等级健康分下限（用于 health.js 内部判定，与 §2.B 表格一致） */
const LEVEL_BOUNDS = { A: 85, B: 70, C: 55 }

// ============================================================
// 演示参数覆盖（系统设置页可调，存储于本地库 meta）
// 所有读取点都走 overrideXxx()，未配置时回退到上方常量
// ============================================================
const HEALTH_OVERRIDES = {}

/**
 * 应用演示参数覆盖（幂等，可重复调用）
 * @param {Object} cfg
 *   - dailyOutputLoss: { 类别: 元/日 }
 *   - riskFactor: { A|B|C|D: 系数 }
 *   - bounds: { A|B|C: 分数下限 }
 */
export function configureHealth(cfg = {}) {
  for (const key of ['dailyOutputLoss', 'riskFactor', 'bounds']) {
    if (cfg[key] && typeof cfg[key] === 'object') {
      HEALTH_OVERRIDES[key] = { ...(HEALTH_OVERRIDES[key] || {}), ...cfg[key] }
    }
  }
}

/** 重置为内置默认参数 */
export function resetHealthConfig() {
  for (const key of ['dailyOutputLoss', 'riskFactor', 'bounds']) delete HEALTH_OVERRIDES[key]
}

function overrideBounds() {
  return HEALTH_OVERRIDES.bounds || LEVEL_BOUNDS
}

/**
 * 停机损失估算用的日产出假设（演示参数，可按类别调整）
 *
 * 口径说明：数值为"该设备停机一天，对矿山产线造成的产出损失"的演示假设，
 * 参照公开行业台班费 / 租赁报价量级（徐工官方渠道与主流租赁平台公开区间）取合理值，
 * 非真实财务数据。分类与设备台账类别一一对应，缺类设备走"其他"。
 */
export const DAILY_OUTPUT_LOSS = {
  挖掘机: 80000,   // 矿用大挖（XE490 级）：装车主设备，停机直接停采
  矿卡: 120000,    // 非公路矿卡（XDE130 级）：运输主通道，单台日运量最大
  钻机: 60000,     // 凿岩钻机（XKY120 级）：制约爆破循环节奏
  破碎机: 90000,   // 移动破碎站（XGY1500 级）：产线咽喉，堵料即全线停
  装载机: 35000,   // 轮式装载机（LW500KN 级）：装运辅助
  推土机: 45000,   // 履带推土机（SD16 级）：土方剥离主力
  压路机: 30000,   // 单钢轮压路机（XS223J 级）：路基作业
  平地机: 32000,   // 平地机（GR180 级）：场地平整
  其他: 30000
}

/**
 * 预设生产场景（一键切换整套估算口径）
 * factor：相对基准日产出的场景系数；risk：各等级停机风险系数
 */
export const PRESET_SCENARIOS = {
  openPit: {
    name: '露天铁矿 · 高负载',
    desc: '矿卡 / 大挖 / 破碎为核心，连续开采、停机损失放大',
    factor: 1.6,
    risk: { A: 0.1, B: 0.35, C: 0.6, D: 0.85 }
  },
  aggregate: {
    name: '砂石骨料 · 中负载',
    desc: '破碎 / 装载为核心，两班制、产出中等',
    factor: 1.0,
    risk: { A: 0.1, B: 0.3, C: 0.5, D: 0.7 }
  },
  construction: {
    name: '基建施工 · 低负载',
    desc: '压路 / 平地 / 推土为主，单班制、停机影响较小',
    factor: 0.55,
    risk: { A: 0.08, B: 0.25, C: 0.45, D: 0.65 }
  }
}

export function dailyOutputLossOf(category) {
  const o = HEALTH_OVERRIDES.dailyOutputLoss
  if (o && o[category]) return Number(o[category]) || 0
  return DAILY_OUTPUT_LOSS[category] || DAILY_OUTPUT_LOSS.其他
}

// ============================================================
// 单因子计算
// ============================================================

/** 距上次维保天数；无法解析返回 null */
function sinceDays(eq) {
  if (!eq || !eq.last_maintenance_date) return null
  const d = parseDate(eq.last_maintenance_date)
  if (!d) return null
  return Math.floor((Date.now() - d.getTime()) / 86400000)
}

function cycleDays(eq) {
  const c = Number(eq && eq.maintenance_cycle_days)
  return Number.isFinite(c) && c > 0 ? c : 90
}

/**
 * 维保及时性因子
 * 规则：超期每天扣 2 分，**单因子扣分上限 45 分**；未超期但已过周期 80% 扣 10 分（二者互斥）
 *
 * 为什么必须有上限：
 *   无上限时（如超期 51 天 = 扣 102 分）再叠加"故障状态扣 30"，总分必然压到 0，
 *   于是"超期 35 天"与"超期 51 天"的分数完全一样，报告与告警失去区分度——
 *   这恰恰违背了当初修正分档问题的初衷。上限 45 分保证最差设备仍有梯度。
 */
export const MAINTENANCE_PENALTY_CAP = 45

export function maintenanceFactor(eq) {
  const since = sinceDays(eq)
  const cycle = cycleDays(eq)
  const overdue = computeOverdueDays(eq)

  if (since === null) {
    /**
     * 无维保记录：扣 30 分，因子得分 = 70。
     *
     * 这里原来是 score: 0 / penalty: 30 —— 总分靠 penalty 求和是对的，
     * 但报告里的因子条形图取的是 score，于是同一行出现"0 分"的条和"扣 30 分"的算式。
     * 全文件其余因子的约定都是 score = 100 − penalty，这里对齐它。
     */
    const penalty = 30
    return {
      key: 'timeliness',
      name: '维保及时性',
      score: 100 - penalty,
      penalty,
      detail: '无维保记录，无法评估',
      formula: `无维保记录 → 扣 ${penalty} 分（本因子计 ${100 - penalty} 分）`,
      source: '维保记录表（空）'
    }
  }

  if (overdue !== null && overdue > 0) {
    const raw = overdue * 2
    const penalty = Math.min(MAINTENANCE_PENALTY_CAP, raw)
    const capped = raw > MAINTENANCE_PENALTY_CAP
    return {
      key: 'timeliness',
      name: '维保及时性',
      score: Math.max(0, 100 - penalty),
      penalty,
      detail: `已超期 ${overdue} 天`,
      formula: `距上次维保 ${since} 天 − 周期 ${cycle} 天 = 超期 ${overdue} 天，每超期 1 天扣 2 分 → 扣 ${raw} 分` +
        (capped ? `，单因子上限 ${MAINTENANCE_PENALTY_CAP} 分，实际扣 ${penalty} 分` : ''),
      source: `上次维保 ${eq.last_maintenance_date} / 周期 ${cycle} 天`
    }
  }

  const approaching = since > cycle * 0.8
  const penalty = approaching ? 10 : 0
  return {
    key: 'timeliness',
    name: '维保及时性',
    score: 100 - penalty,
    penalty,
    detail: approaching ? `距到期还剩 ${cycle - since} 天，接近保养周期` : `正常（距到期 ${cycle - since} 天）`,
    formula: approaching
      ? `距上次维保 ${since} 天 > 周期 ${cycle} 天的 80%（${Math.round(cycle * 0.8)} 天）→ 扣 10 分`
      : `距上次维保 ${since} 天 ≤ 周期 ${cycle} 天的 80% → 不扣分`,
    source: `上次维保 ${eq.last_maintenance_date} / 周期 ${cycle} 天`
  }
}

/**
 * 机龄因子的扣分上限，与维保因子的 45 分对齐。
 *
 * 为什么需要：不加限制时扣分 = (机龄 − 5) × 5 是无界的，30 年设备扣 125 分，
 * 把总分压穿到 0 之后，"机龄 15 年"与"机龄 30 年"在报告上再无区别 ——
 * 与维保因子当初加上限的理由完全相同：最差设备之间也要保留梯度。
 * 同时它保证了报告里"健康分 = 100 − Σ扣分"这个等式在常见取值下成立。
 */
export const AGE_PENALTY_CAP = 45

/**
 * 设备机龄因子
 * 规则：机龄 > 5 年，每多 1 年扣 5 分（单因子扣分上限 45 分）；
 *      购置日期缺失按 0 年计并单独扣数据完整度分；购置日期在未来按数据异常标注。
 */
export function ageFactor(eq) {
  const age = equipmentAgeYears(eq && eq.purchase_date)
  if (age === null) {
    return {
      key: 'age',
      name: '设备机龄',
      score: 100,
      penalty: 0,
      detail: '购置日期未录入（本因子不扣分，另计入数据完整度）',
      formula: '购置日期缺失 → 机龄无法计算，本因子不扣分',
      source: '设备台账（购置日期为空）',
      missing: true
    }
  }

  if (age < 0) {
    /**
     * 购置日期晚于当前日期：这是录入错误，不是"设备很新"。
     * 原来它静默落进下面的 age > 5 判断，拿满分且不留痕迹，账面上看不出任何异常。
     * 这里如实标注（anomaly 供界面/报告提示），扣分仍为 0 ——
     * 扣分应当反映设备状态，而不是反映台账录错了。
     */
    return {
      key: 'age',
      name: '设备机龄',
      score: 100,
      penalty: 0,
      detail: `购置日期 ${eq.purchase_date} 晚于当前日期，数据异常（按 0 年计）`,
      formula: '购置日期为未来日期 → 机龄不成立，本因子不扣分（请在台账中修正购置日期）',
      source: `设备台账（购置日期 ${eq.purchase_date}）`,
      anomaly: true
    }
  }

  const raw = age > 5 ? Math.round((age - 5) * 5) : 0
  const penalty = Math.min(AGE_PENALTY_CAP, raw)
  const capped = raw > AGE_PENALTY_CAP
  return {
    key: 'age',
    name: '设备机龄',
    score: Math.max(0, 100 - penalty),
    penalty,
    detail: `机龄 ${age.toFixed(1)} 年`,
    formula: age > 5
      ? `机龄 ${age.toFixed(1)} 年 > 5 年，超出 ${(age - 5).toFixed(1)} 年 × 5 分 → 扣 ${raw} 分` +
        (capped ? `，单因子上限 ${AGE_PENALTY_CAP} 分，实际扣 ${penalty} 分` : '')
      : `机龄 ${age.toFixed(1)} 年 ≤ 5 年 → 不扣分`,
    source: `购置日期 ${eq.purchase_date}`
  }
}

/** 故障状态因子：fault 扣 30 分 */
export function statusFactor(eq) {
  const isFault = eq && eq.status === 'fault'
  return {
    key: 'status',
    name: '故障状态',
    score: isFault ? 70 : 100,
    penalty: isFault ? 30 : 0,
    detail: isFault ? '当前处于故障状态' : '当前无故障标记',
    formula: isFault ? '状态 = 故障 → 扣 30 分' : '状态 ≠ 故障 → 不扣分',
    source: `台账状态：${statusLabel(eq && eq.status)}`
  }
}

/**
 * 数据完整度因子（新增）
 * 目的：消除"数据越缺失、健康分越高"的反向激励
 */
export function dataCompletenessFactor(eq) {
  const missing = []
  if (!eq || !eq.purchase_date || !parseDate(eq.purchase_date)) missing.push('购置日期')
  if (!eq || !eq.last_maintenance_date || !parseDate(eq.last_maintenance_date)) missing.push('上次维保日期')
  if (!eq || !eq.model) missing.push('设备型号')

  const penalty = missing.length * 5
  return {
    key: 'data',
    name: '数据完整度',
    score: Math.max(0, 100 - penalty),
    penalty,
    detail: missing.length ? `缺失：${missing.join('、')}` : '台账字段完整',
    formula: missing.length
      ? `每项缺失字段扣 5 分：${missing.join('、')} → 扣 ${penalty} 分`
      : '无缺失字段 → 不扣分',
    source: '设备台账字段校验',
    missing: missing.length > 0
  }
}

function statusLabel(status) {
  return { running: '运行中', idle: '闲置', maintenance: '维保中', fault: '故障' }[status] || status || '未知'
}

// ============================================================
// 综合评估
// ============================================================

/** 超期天数：未超期或无法计算返回 null */
export function computeOverdueDays(eq) {
  if (!eq || !eq.last_maintenance_date) return null
  const until = daysUntilDue(eq.last_maintenance_date, cycleDays(eq))
  if (until === null) return null
  return until < 0 ? -until : null
}

/**
 * 设备健康评估
 * @returns {{
 *   score: number, level: 'A'|'B'|'C'|'D', levelLabel: string, levelDesc: string,
 *   color: string, riskFactor: number, overdueDays: number|null,
 *   factors: Array<Object>, conclusion: string
 * }}
 */
export function evaluateHealth(eq) {
  const factors = [
    maintenanceFactor(eq),
    ageFactor(eq),
    statusFactor(eq),
    dataCompletenessFactor(eq)
  ]

  const totalPenalty = factors.reduce((sum, f) => sum + f.penalty, 0)
  const score = Math.max(0, Math.min(100, Math.round(100 - totalPenalty)))
  const overdueDays = computeOverdueDays(eq)

  let level
  const bounds = overrideBounds()
  if (score >= bounds.A) level = 'A'
  else if (score >= bounds.B) level = 'B'
  else if (score >= bounds.C) level = 'C'
  else level = 'D'

  // 分级强制升级：分数可能"看起来还行"，但客观事实（长期超期/已故障）必须优先
  const rawLevel = level
  const escalateReasons = []
  if (overdueDays !== null && overdueDays > 30 && rank(level) < rank('C')) {
    level = 'C'
    escalateReasons.push(`维保超期 ${overdueDays} 天（> 30 天），等级上调至 C`)
  }
  if (overdueDays !== null && overdueDays > 45 && rank(level) < rank('D')) {
    level = 'D'
    escalateReasons.push(`维保超期 ${overdueDays} 天（> 45 天），等级上调至 D`)
  }
  if (eq && eq.status === 'fault' && rank(level) < rank('D')) {
    level = 'D'
    escalateReasons.push('设备处于故障状态，等级上调至 D')
  }

  const meta = RISK_LEVELS[level]
  return {
    score,
    level,
    levelLabel: meta.label,
    levelDesc: meta.desc,
    color: meta.color,
    riskFactor: getRiskFactor(level, overdueDays),
    overdueDays,
    rawLevel,
    escalateReasons,
    factors,
    conclusion: buildConclusion(eq, { score, level, overdueDays, factors })
  }
}

const LEVEL_RANK = { A: 0, B: 1, C: 2, D: 3 }
function rank(level) {
  return LEVEL_RANK[level] ?? 0
}

/** 兼容旧调用：只要健康分 */
export function getHealthScore(eq) {
  return evaluateHealth(eq).score
}

/**
 * 纯分数 → 等级（走系统设置页可调的阈值，不要再在页面里硬编码 85/70/55）
 * @param {number} score
 * @returns {'A'|'B'|'C'|'D'}
 */
export function levelOf(score) {
  const bounds = overrideBounds()
  const s = Number(score)
  if (!Number.isFinite(s)) return 'D'
  if (s >= bounds.A) return 'A'
  if (s >= bounds.B) return 'B'
  if (s >= bounds.C) return 'C'
  return 'D'
}

/**
 * 设备 → 等级（含分级强制升级：超期 > 30/> 45 天、故障状态会被上调）
 * 与 evaluateHealth 的 level 完全同源，供页面直接展示。
 * @param {Object} eq
 */
export function getHealthLevel(eq) {
  return evaluateHealth(eq).level
}

/** 等级 → 展示元数据（标签/说明/颜色） */
export function levelMeta(level) {
  return RISK_LEVELS[level] || RISK_LEVELS.A
}

/**
 * 当前生效的分档阈值（含系统设置页的覆盖值）。
 * 页面文案里的"≥85 / 70-84"应当从它取，不要再硬编码——
 * 否则设置页改完阈值，界面标签就会与实际分档打架。
 */
export function levelBounds() {
  const b = overrideBounds()
  return { A: b.A, B: b.B, C: b.C }
}

/** 等级与超期天数 → 风险系数（0.1 ~ 0.9，系数可在系统设置中调整） */
export function getRiskFactor(level, overdueDays = null) {
  const overridden = HEALTH_OVERRIDES.riskFactor
  let factor = overridden && overridden[level] != null
    ? Number(overridden[level])
    : (RISK_LEVELS[level] || RISK_LEVELS.A).factor
  if (overdueDays !== null && overdueDays > 30) factor += 0.2
  return Math.min(0.9, Math.max(0.1, Math.round(factor * 100) / 100))
}

/** 兼容旧调用：按分数取色 */
export function getHealthColor(score) {
  const bounds = overrideBounds()
  if (score >= bounds.A) return RISK_LEVELS.A.color
  if (score >= bounds.B) return RISK_LEVELS.B.color
  if (score >= bounds.C) return RISK_LEVELS.C.color
  return RISK_LEVELS.D.color
}

/** 一句话结论（模板生成，不含任何新数字） */
function buildConclusion(eq, { score, level, overdueDays, factors }) {
  if (!eq) return '设备信息缺失，无法体检'

  const name = eq.name
  if (level === 'D') {
    const worst = factors.find(f => f.key === 'status' && f.penalty > 0)
    if (overdueDays !== null && overdueDays > 45) {
      return `${name} 健康分 ${score} 分（严重）：维保已超期 ${overdueDays} 天，存在停机风险，建议立即安排保养并纳入本周计划。`
    }
    if (worst) {
      return `${name} 健康分 ${score} 分（严重）：设备当前处于故障状态，建议立即安排检修，检修完成后 7 天内复诊确认。`
    }
    return `${name} 健康分 ${score} 分（严重）：多项指标不达标，建议立即安排专项检查。`
  }
  if (level === 'C') {
    if (overdueDays !== null) {
      return `${name} 健康分 ${score} 分（预警）：维保已超期 ${overdueDays} 天，建议尽快安排保养。`
    }
    return `${name} 健康分 ${score} 分（预警）：存在影响健康度的因子，建议本周期内安排检查。`
  }
  if (level === 'B') {
    const aging = factors.find(f => f.key === 'age' && f.penalty > 0)
    if (aging) {
      return `${name} 健康分 ${score} 分（良）：主要扣分为设备机龄，建议加强关键件巡检频次。`
    }
    return `${name} 健康分 ${score} 分（良）：整体状态可接受，按计划维保即可。`
  }
  return `${name} 健康分 ${score} 分（优）：各项指标正常，按计划执行即可。`
}

// ============================================================
// 停机损失估算（口径公开，可现场改）
// ============================================================

/**
 * 预估停机天数
 * ⚠️ 已修正：v1 公式忽略设备状态，导致"已经趴窝"的设备算出最低损失
 * 口径：以"不处置而继续拖"的停时为参照，系数 0.3（偏保守），并设上限 20 天，
 *       避免几十天的夸张数字——演示数字宁可保守，也要经得起追问。
 */
export const DOWNTIME_CAP_DAYS = 20

export function getDowntimeDays(eq) {
  const overdue = computeOverdueDays(eq) || 0
  const base = Math.max(3, Math.round(overdue * 0.3))
  const faultPenalty = eq && eq.status === 'fault' ? 5 : 0
  return Math.min(DOWNTIME_CAP_DAYS, base + faultPenalty)
}

/**
 * 停机损失估算
 * 公式：预计损失 = 风险系数 × 日产出假设 × 预估停时天数
 * @returns {{ riskFactor, dailyOutputLoss, downtimeDays, estimatedLoss, formula, note }}
 */
export function estimateLoss(eq) {
  const health = evaluateHealth(eq)
  const daily = dailyOutputLossOf(eq && eq.category)
  const downtimeDays = getDowntimeDays(eq)
  const estimatedLoss = Math.round(health.riskFactor * daily * downtimeDays)
  const faultPenalty = eq && eq.status === 'fault' ? 5 : 0
  const overdue = health.overdueDays || 0

  return {
    level: health.level,
    riskFactor: health.riskFactor,
    dailyOutputLoss: daily,
    downtimeDays,
    estimatedLoss,
    formula:
      `预计损失 = 风险系数(${health.riskFactor}) × 日产出假设(${daily.toLocaleString('zh-CN')} 元/日) × 预估停时(${downtimeDays} 天)` +
      ` ≈ ${estimatedLoss.toLocaleString('zh-CN')} 元`,
    downtimeFormula: faultPenalty
      ? `预估停时 = min(${DOWNTIME_CAP_DAYS}, max(3, 超期 ${overdue} 天 × 0.3) + 故障状态补偿 5 天) = ${downtimeDays} 天`
      : `预估停时 = max(3, 超期 ${overdue} 天 × 0.3) = ${downtimeDays} 天`,
    note: '估算口径：风险系数 × 日产出假设 × 预估停时。日产出为演示参数，非真实财务数据，可在系统设置中调整。'
  }
}

// ============================================================
// 健康分趋势
// ============================================================

export const TREND_KINDS = {
  improving: { label: '改善中', color: 'var(--success-ink)' },
  stable: { label: '稳定', color: 'var(--accent-mid)' },
  fluctuating: { label: '波动', color: 'var(--warn-ink)' },
  worsening: { label: '恶化中', color: 'var(--danger-ink)' },
  insufficient: { label: '数据积累中', color: 'var(--text-3)' }
}

/**
 * 趋势判定
 * @param {Array<{score:number, date:string}>} snapshots 快照（自动按日期升序）
 * @returns {{ kind, label, color, delta, consecutiveDown, points, summary }}
 */
export function evaluateTrend(snapshots = []) {
  const points = [...snapshots]
    .filter(s => s && Number.isFinite(Number(s.score)))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map(s => ({ date: s.date, score: Number(s.score) }))

  if (points.length < 3) {
    return {
      kind: 'insufficient',
      label: TREND_KINDS.insufficient.label,
      color: TREND_KINDS.insufficient.color,
      delta: null,
      consecutiveDown: 0,
      points,
      summary: points.length
        ? `已积累 ${points.length} 期数据，至少需要 3 期才能判断趋势`
        : '暂无健康分快照，完成一次工单或录入维保后开始积累'
    }
  }

  let consecutiveDown = 0
  for (let i = points.length - 1; i > 0; i--) {
    if (points[i].score < points[i - 1].score) consecutiveDown++
    else break
  }

  const delta = points[points.length - 1].score - points[points.length - 2].score
  const scores = points.map(p => p.score)
  const spread = Math.max(...scores) - Math.min(...scores)

  let kind
  if (consecutiveDown >= 3) kind = 'worsening'
  else if (delta <= -8) kind = 'worsening'
  else if (delta >= 5) kind = 'improving'
  else if (spread < 5) kind = 'stable'
  else kind = 'fluctuating'

  const meta = TREND_KINDS[kind]
  let summary
  if (kind === 'worsening') {
    summary = consecutiveDown >= 3
      ? `健康分连续 ${consecutiveDown} 期下降，从 ${points[points.length - 1 - consecutiveDown].score} 分降至 ${points[points.length - 1].score} 分，建议提前介入`
      : `最近一期下降 ${Math.abs(delta)} 分（${points[points.length - 2].score} → ${points[points.length - 1].score}），降幅超过阈值，建议提前介入`
  } else if (kind === 'improving') {
    summary = `最近一期上升 ${delta} 分（${points[points.length - 2].score} → ${points[points.length - 1].score}），保养措施见效`
  } else if (kind === 'stable') {
    summary = `近 ${points.length} 期波动 ${spread} 分，状态稳定`
  } else {
    summary = `近 ${points.length} 期波动 ${spread} 分，最近一期${delta >= 0 ? '上升' : '下降'} ${Math.abs(delta)} 分`
  }

  return {
    kind,
    label: meta.label,
    color: meta.color,
    delta,
    consecutiveDown,
    points,
    summary,
    worsening: kind === 'worsening'
  }
}

/** 是否需要"恶化中"预警（供 Dashboard 汇总） */
export function isWorsening(snapshots = []) {
  const trend = evaluateTrend(snapshots)
  return trend.kind === 'worsening'
}

/**
 * 把趋势点映射成 SVG 折线坐标（纯函数，不依赖任何组件）
 *
 * 为什么放在 utils 而不是组件里：设备台账、设备病历、体检报告三处都要画同一条折线，
 * 之前各写一份，坐标域还不一样（报告用的是固定 0-100，走势被压平得看不出变化）。
 * 现在统一为"围绕实际分数上下留 pad 的自动缩放"，三处图形形状一致。
 *
 * @param {Array<{score:number, date:string}>} points 已按日期升序的趋势点
 * @param {{ width?: number, height?: number, pad?: number }} options
 * @returns {{ width, height, min, max, d, polyline, points }|null} 点不足 2 个返回 null
 */
export function buildTrendPath(points, options = {}) {
  const { width = 320, height = 80, pad = 5 } = options
  const pts = (points || []).filter(p => p && Number.isFinite(Number(p.score)))
  if (pts.length < 2) return null

  const scores = pts.map(p => Number(p.score))
  const min = Math.max(0, Math.min(...scores) - pad)
  const max = Math.min(100, Math.max(...scores) + pad)
  const range = max - min || 1
  const stepX = width / (pts.length - 1)

  const mapped = pts.map((p, i) => ({
    x: Math.round(i * stepX),
    y: Math.round(height - ((Number(p.score) - min) / range) * height),
    score: Number(p.score),
    date: p.date
  }))

  return {
    width,
    height,
    min,
    max,
    d: mapped.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' '),
    polyline: mapped.map(p => `${p.x},${p.y}`).join(' '),
    points: mapped
  }
}
