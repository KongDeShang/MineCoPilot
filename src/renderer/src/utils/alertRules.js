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
  // 下面两条按"累计维修次数"判定：数据源是维修类工单（见 buildContext）。
  // 文案写「累计」而不是「近期」—— 手上没有时间窗口的定义，统计的是全部历史工单。
  {
    id: 'fault-repeat',
    name: '高频故障设备',
    severity: 'warning',
    test: (eq, ctx) => (ctx.faultCounts[String(eq.id)] || 0) >= 3,
    reason: (eq, ctx) => `${eq.name} 累计维修 ${ctx.faultCounts[String(eq.id)]} 次，属高频故障`,
    suggestion: (eq) => `建议对 ${eq.name} 进行根因分析（RCA），评估是否需要大修或更换`
  },
  {
    id: 'fault-repeat-severe',
    name: '极高频故障设备',
    severity: 'critical',
    test: (eq, ctx) => (ctx.faultCounts[String(eq.id)] || 0) >= 5,
    reason: (eq, ctx) => `${eq.name} 累计维修 ${ctx.faultCounts[String(eq.id)]} 次，严重影响产线`,
    suggestion: (eq) => `建议评估 ${eq.name} 是否需要停用更换，并上报管理层`
  },
  /**
   * 这里原先有一条 'parts-low'（备件库存不足）。已删除，原因是它按设备挂靠备件，
   * 而备件台账里根本没有这层关系：
   *   · 取数路径写的是 store.partsDomain?.lowStockParts，可 store 是把 lowStockParts
   *     直接暴露出来的（partsDomain 那一层不存在），所以 ctx.lowParts 恒为空数组；
   *   · 就算取到了，参数也是 p.equipmentId === eq.id || p.eqCategory === eq.category ——
   *     备件没有 equipmentId；备件的 category（液压件/滤芯/易损件…）与设备的 category
   *     （挖掘机/装载机/矿卡…）是两套分类体系，永远不可能相等。
   * 低库存这件事已经有正经出口：备件台账的缺料标记 + 告警中心的「备件缺料」。
   * 与其留一条只会静默的空转规则，不如删掉。
   */
  {
    id: 'idle-long',
    // 名字不写「长期」：台账里没有"闲置起始日"这类字段，判不了闲置多久，
    // 这条规则实际只看当前状态。名字与判定对不上的话，日后有人照着名字改阈值会踩空。
    name: '闲置设备',
    severity: 'info',
    test: (eq) => eq.status === 'idle',
    reason: (eq) => `${eq.name} 当前闲置状态，建议评估是否有调度价值`,
    suggestion: (eq) => `检查 ${eq.name} 是否可调拨至其他作业面，避免资源浪费`
  }
]

/**
 * 构建扫描上下文
 *
 * 键一律用 String(设备 id)：工单的 equipment_id 可能来自 Excel 导入或表单，
 * 是数字还是字符串不确定，faultCounts 用字符串键、规则里也用 String(eq.id) 取，
 * 两边对齐才不会出现"明明有 3 张维修单却查不到"。
 *
 * @param {object} store - appStore 实例
 * @returns {object}
 */
function buildContext(store) {
  /**
   * 故障次数：按设备累计"维修类工单"张数。
   *
   * 原先这里有两处字段全对不上，导致 fault-repeat / fault-repeat-severe 永远不触发：
   *   1) 拿 faultTopStats.top 当数据源 —— 那是**按系统**汇总的高频故障榜，
   *      条目形如 { system, count, samples, percent }，压根没有 equipmentId/id，
   *      写进去的是 faultCounts[undefined]；
   *   2) 工单循环判 `wo.type === 'fault' || wo.category === '故障'` ——
   *      真实工单的 type 枚举是 maintenance/repair/inspection，没有 'fault'，
   *      工单表也没有 category 字段，而设备外键叫 equipment_id 不是 equipmentId。
   *
   * 口径：repair 类工单，排除已取消（取消的单不代表真的坏过）。
   * 不叠加维保记录 —— 完成归档时会把维修工单写成一条「故障维修」病历，
   * 两个都数等于同一件事计两次。
   */
  const faultCounts = {}
  for (const wo of store.workOrders || []) {
    if (!wo || wo.type !== 'repair' || wo.status === 'cancelled') continue
    const key = wo.equipment_id ?? wo.equipmentId
    if (key === null || key === undefined || key === '') continue
    faultCounts[String(key)] = (faultCounts[String(key)] || 0) + 1
  }

  return {
    worseningIds: new Set((store.worseningList || []).map(e => e.id)),
    faultCounts
  }
}

/**
 * 扫描所有设备，返回触发的预警列表
 *
 * @param {object} store - appStore 实例
 *   需要：equipmentWithHealth（健康等级/评分）、overdueList（超期天数）、
 *        workOrders（故障次数）、worseningList（恶化趋势）
 * @param {object} [options]
 * @param {Severity} [options.severity] - 只返回该严重级别
 * @param {string[]} [options.equipmentIds] - 只扫描指定设备
 * @returns {Array<{ruleId: string, ruleName: string, severity: Severity, equipmentId: string, equipmentName: string, reason: string, suggestion: string, at: number}>}
 */
export function scanAlerts(store, options = {}) {
  const { severity = null, equipmentIds = null } = options

  const ctx = buildContext(store)

  /**
   * 超期天数要单独取：equipmentWithHealth 只带 health，**没有 overdueDays**，
   * 所以 `eq.overdueDays ?? 0` 永远是 0，overdue-30 / overdue-45 两条规则
   * 无论设备超期多少天都不会命中。真正带这列的是 store.overdueList。
   */
  const overdueById = new Map(
    (store.overdueList || []).map(e => [String(e.id), e.overdueDays])
  )

  // 设备池：带健康评估的设备列表
  const allEquipment = (store.equipmentWithHealth || []).map(eq => ({
    ...eq,
    healthLevel: eq.health?.level || eq.healthLevel || 'A',
    healthScore: eq.health?.score ?? eq.healthScore ?? 100,
    overdueDays: overdueById.get(String(eq.id)) ?? eq.overdueDays ?? 0
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
          reason: rule.reason(eq, ctx),
          suggestion: rule.suggestion(eq, ctx),
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
