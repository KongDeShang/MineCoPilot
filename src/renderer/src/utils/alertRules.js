/**
 * 预警规则引擎（确定性、可解释、不依赖 AI）
 *
 * 职责：
 *   扫描设备列表，按预定义规则生成预警列表。
 *   每条预警包含：ruleId / ruleName / severity / equipmentId / equipmentName / reason / suggestion / at
 *
 * 设计原则（参考辅导员平台 alert-rules.js）：
 *   - 纯 JS，无外部依赖，5000 台 < 5s
 *   - 规则可从外部注册（registerRule）
 *   - 结果按 severity 排序：critical > warning > info
 *   - reason 和 suggestion 是函数，保证与设备数据同源
 */

/**
 * @typedef {'info' | 'warning' | 'critical'} Severity
 * @typedef {{ id: string, name: string, severity: Severity, test: (eq, ctx) => boolean, reason: (eq) => string, suggestion: (eq) => string }} Rule
 */

/** @type {Rule[]} */
const RULES = [
  {
    id: 'overdue-30',
    name: '维保超期30天',
    severity: 'warning',
    test: (eq) => eq.overdueDays > 30 && eq.overdueDays <= 45,
    reason: (eq) => `${eq.name} 维保超期 ${eq.overdueDays} 天，已进入预警区间`,
    suggestion: (eq) => `建议 3 日内安排 ${eq.name} 的维保作业`
  },
  {
    id: 'overdue-45',
    name: '维保严重超期',
    severity: 'critical',
    test: (eq) => eq.overdueDays > 45,
    reason: (eq) => `${eq.name} 维保超期 ${eq.overdueDays} 天，已达强制升级线`,
    suggestion: (eq) => `立即安排 ${eq.name} 停机检修，防止带病运行`
  },
  {
    id: 'health-d',
    name: '健康等级D级',
    severity: 'critical',
    test: (eq) => eq.healthLevel === 'D',
    reason: (eq) => `${eq.name} 健康等级 D 级，综合评分 ${eq.healthScore}，存在重大隐患`,
    suggestion: (eq) => `建议对 ${eq.name} 进行全面体检，评估是否需要停机维修`
  },
  {
    id: 'health-c',
    name: '健康等级C级',
    severity: 'warning',
    test: (eq) => eq.healthLevel === 'C',
    reason: (eq) => `${eq.name} 健康等级 C 级，综合评分 ${eq.healthScore}，需关注`,
    suggestion: (eq) => `建议排查 ${eq.name} 近期维保记录，确认是否有潜在故障`
  },
  {
    id: 'health-degrading',
    name: '健康趋势恶化',
    severity: 'warning',
    test: (eq, ctx) => ctx.worseningIds.has(eq.id),
    reason: (eq) => `${eq.name} 连续多个周期健康评分下降，趋势恶化`,
    suggestion: (eq) => `排查 ${eq.name} 是否存在隐性故障或老化加速`
  },
  {
    id: 'fault-repeat',
    name: '高频故障设备',
    severity: 'warning',
    test: (eq, ctx) => (ctx.faultCounts[eq.id] || 0) >= 3,
    reason: (eq) => `${eq.name} 近期故障 ${ctx.faultCounts[eq.id]} 次，属高频故障`,
    suggestion: (eq) => `建议对 ${eq.name} 进行根因分析（RCA），评估是否需要大修或更换`
  },
  {
    id: 'fault-repeat-severe',
    name: '极高频故障设备',
    severity: 'critical',
    test: (eq, ctx) => (ctx.faultCounts[eq.id] || 0) >= 5,
    reason: (eq) => `${eq.name} 近期故障 ${ctx.faultCounts[eq.id]} 次，严重影响产线`,
    suggestion: (eq) => `建议评估 ${eq.name} 是否需要停用更换，并上报管理层`
  },
  {
    id: 'parts-low',
    name: '备件库存不足',
    severity: 'info',
    test: (eq, ctx) => ctx.lowParts.some(p => p.equipmentId === eq.id || p.eqCategory === eq.category),
    reason: (eq) => `${eq.name} 关联备件库存不足，可能影响维保时效`,
    suggestion: (eq) => `建议补充 ${eq.name} 常用备件，确保维保时有件可用`
  },
  {
    id: 'idle-long',
    name: '长期闲置设备',
    severity: 'info',
    test: (eq) => eq.status === 'idle',
    reason: (eq) => `${eq.name} 当前闲置状态，建议评估是否有调度价值`,
    suggestion: (eq) => `检查 ${eq.name} 是否可调拨至其他作业面，避免资源浪费`
  }
]

/**
 * 构建扫描上下文
 * @param {object} store - appStore 实例
 * @returns {object}
 */
function buildContext(store) {
  const faultCounts = {}
  if (store.faultTopStats) {
    for (const f of store.faultTopStats) {
      faultCounts[f.equipmentId || f.id] = f.count || f.total || 0
    }
  }

  // 从工单统计故障次数
  if (store.workOrders) {
    for (const wo of store.workOrders) {
      if (wo.type === 'fault' || wo.category === '故障') {
        faultCounts[wo.equipmentId] = (faultCounts[wo.equipmentId] || 0) + 1
      }
    }
  }

  const lowParts = []
  if (store.partsDomain?.lowStockParts) {
    lowParts.push(...store.partsDomain.lowStockParts)
  }

  return {
    worseningIds: new Set((store.worseningList || []).map(e => e.id)),
    faultCounts,
    lowParts
  }
}

/**
 * 扫描所有设备，返回触发的预警列表
 *
 * @param {object} store - appStore 实例（需要 equipmentWithHealth / worseningList / faultTopStats）
 * @param {object} [options]
 * @param {Severity} [options.severity] - 只返回该严重级别
 * @param {string[]} [options.equipmentIds] - 只扫描指定设备
 * @returns {Array<{ruleId: string, ruleName: string, severity: Severity, equipmentId: string, equipmentName: string, reason: string, suggestion: string, at: number}>}
 */
export function scanAlerts(store, options = {}) {
  const { severity = null, equipmentIds = null } = options

  const ctx = buildContext(store)

  // 设备池：带健康评估的设备列表
  const allEquipment = (store.equipmentWithHealth || []).map(eq => ({
    ...eq,
    healthLevel: eq.health?.level || eq.healthLevel || 'A',
    healthScore: eq.health?.score ?? eq.healthScore ?? 100,
    overdueDays: eq.overdueDays ?? 0
  }))

  const pool = equipmentIds
    ? allEquipment.filter(e => equipmentIds.includes(e.id))
    : allEquipment

  const alerts = []

  for (const eq of pool) {
    for (const rule of RULES) {
      if (severity && rule.severity !== severity) continue
      if (rule.test(eq, ctx)) {
        alerts.push({
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          equipmentId: eq.id,
          equipmentName: eq.name,
          reason: rule.reason(eq),
          suggestion: rule.suggestion(eq),
          at: Date.now()
        })
      }
    }
  }

  // 按 severity 排序：critical > warning > info
  const order = { critical: 0, warning: 1, info: 2 }
  alerts.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3))

  return alerts
}

/**
 * 统计预警概要
 *
 * @param {object} store
 * @returns {{ critical: number, warning: number, info: number, total: number, topSuggestions: string[] }}
 */
export function getAlertSummary(store) {
  const alerts = scanAlerts(store)
  const critical = alerts.filter(a => a.severity === 'critical').length
  const warning = alerts.filter(a => a.severity === 'warning').length
  const info = alerts.filter(a => a.severity === 'info').length

  // 去重取前 3 条建议
  const seen = new Set()
  const topSuggestions = []
  for (const a of alerts) {
    if (!seen.has(a.ruleId) && topSuggestions.length < 3) {
      seen.add(a.ruleId)
      topSuggestions.push(a.suggestion)
    }
  }

  return { critical, warning, info, total: alerts.length, topSuggestions }
}

/**
 * 注册自定义规则（支持外部扩展）
 * @param {Rule} rule
 */
export function registerRule(rule) {
  if (rule && rule.id && rule.test) {
    RULES.push(rule)
  }
}

/**
 * 获取当前所有规则定义（只读，用于展示）
 * @returns {Rule[]}
 */
export function listRules() {
  return RULES.map(r => ({ ...r, test: undefined, reason: r.reason.toString(), suggestion: r.suggestion.toString() }))
}
