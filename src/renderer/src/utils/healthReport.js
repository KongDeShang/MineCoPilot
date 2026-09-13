/**
 * 矿山智工 - 设备体检报告生成器
 *
 * 定位：这是"设备健康智能体"的实体交付物，也是"可审计"的载体。
 *
 * 三条设计原则：
 *   1) 离线确定性生成——文本全部由模板 + 本地真实数据拼装，不依赖网络，路演断网可用
 *   2) 每个数字可溯源——所有数值都带 { value, formula, source }，报告中以脚注形式列出
 *   3) 数据不足就说不足——缺购置日期、快照不足 3 期时明确标注，不猜、不补默认值
 *
 * 报告 HTML 自带样式，可直接 v-html 渲染、window.print() 打印（A4 版式）
 */
import { evaluateHealth, estimateLoss, evaluateTrend, RISK_LEVELS, levelOf, levelMeta, buildTrendPath, dailyOutputLossOf } from './health'
import { addDays, daysUntilDue, now } from './dates'
import { escapeHtml } from './html'

/** 停机损失的演示参数说明（必须随报告一起展示） */
const LOSS_NOTE = '估算口径：风险系数 × 日产出假设 × 预估停时。日产出为演示参数，非真实财务数据，可在系统设置中调整。'
const ACTION_LABELS = {
  repair: '维修',
  maintenance: '保养',
  inspection: '巡检'
}

const TYPE_LABELS = {
  定期保养: '定期保养',
  故障维修: '故障维修',
  部件更换: '部件更换',
  巡检: '巡检'
}

/**
 * 生成风险清单（每条都带知识库出处，供"结论有出处"的溯源要求）
 */
function buildRiskItems(eq, health, factors) {
  const items = []
  const overdue = health.overdueDays

  const timeliness = factors.find(f => f.key === 'timeliness')
  // ⚠️ 顺序不能改：无维保记录时维保及时性因子也扣 30 分，若先判 penalty > 0，
  // "根本没有记录"会被写成"临近保养周期"，既误导处置方向，也让下一条永远走不到。
  if (!eq.last_maintenance_date) {
    items.push({
      level: 'medium',
      title: '缺少维保记录',
      desc: '台账中无维保记录，无法评估维保及时性。',
      suggestion: '建议先补录最近一次保养信息，建立保养基线。',
      ref: '《工程机械定期保养分级规范》'
    })
  } else if (overdue !== null && overdue > 0) {
    items.push({
      level: overdue > 30 ? 'high' : 'medium',
      title: `维保已超期 ${overdue} 天`,
      desc: `上次维保 ${eq.last_maintenance_date}，维保周期 ${eq.maintenance_cycle_days || 90} 天。`,
      suggestion: '参考《工程机械定期保养分级规范》安排保养，优先检查液压油与滤芯。',
      ref: '《保养周期与油品规格》'
    })
  } else if (timeliness && timeliness.penalty > 0) {
    items.push({
      level: 'low',
      title: '临近保养周期',
      desc: `${timeliness.detail}。`,
      suggestion: '建议在本周期内提前安排，避免超期后集中抢修。',
      ref: '《保养周期与油品规格》'
    })
  }

  if (eq.status === 'fault') {
    items.push({
      level: 'high',
      title: '设备处于故障状态',
      desc: '当前状态标记为故障，存在停机风险。',
      suggestion: '建议立即安排检修；检修完成后 7 天内复诊确认处置效果。',
      ref: '《维修作业安全与停机挂牌》'
    })
  }

  const age = factors.find(f => f.key === 'age')
  if (age && age.penalty > 0) {
    items.push({
      level: 'medium',
      title: `设备机龄偏大（${age.detail}）`,
      desc: '机龄超过 5 年后，关键件磨损与故障概率上升。',
      suggestion: '建议缩短关键件巡检周期，关注液压系统与行走机构的渗漏与异响。',
      ref: '《履带与行走机构检查》'
    })
  }

  const data = factors.find(f => f.key === 'data')
  if (data && data.missing) {
    items.push({
      level: 'low',
      title: '台账数据不完整',
      desc: `${data.detail}。数据缺失会导致健康评估偏乐观。`,
      suggestion: '建议补全台账字段后重新体检。',
      ref: '本系统数据完整度校验'
    })
  }

  return items
}

/**
 * 建议保养计划：基于周期与最近保养推算未来 3 次
 * 若上次维保已超期，则第一次计划为"立即"
 */
function buildMaintenancePlan(eq) {
  const cycle = Number(eq.maintenance_cycle_days) || 90
  const plan = []
  const last = eq.last_maintenance_date
  const base = last || now().slice(0, 10)
  const overdue = daysUntilDue(last, cycle)

  for (let i = 0; i < 3; i++) {
    const due = addDays(base, cycle * (i + 1))
    const isFirst = i === 0
    const overdueFirst = isFirst && overdue !== null && overdue < 0
    plan.push({
      dueDate: overdueFirst ? now().slice(0, 10) : due,
      item: cycle <= 30 ? '月度保养（全车检查 + 机油机滤）'
        : cycle <= 60 ? '定期保养（液压系统 + 传动系统）'
          : '定期保养（全车油液 + 三滤 + 关键件检查）',
      cycleDays: cycle,
      urgent: overdueFirst
    })
  }
  return plan
}

/**
 * 汇总可溯源条目：报告中出现的每个关键数字都在这里能查到来源与算式
 */
function buildTraceability(eq, health, loss) {
  const rows = []

  /**
   * 因子扣分之和理论上可以超过 100（每个因子各有上限，但上限相加大于 100），
   * 此时总分被 evaluateHealth 的 Math.max(0, …) 截断。
   * 算式里如实写出实际合计，否则"100 − Σ"这个等式在最差设备上对不上。
   */
  const totalPenalty = health.factors.reduce((sum, f) => sum + f.penalty, 0)
  rows.push({
    label: '健康分',
    value: `${health.score} / 100`,
    formula: totalPenalty > 100
      ? `健康分 = 100 − Σ各因子扣分（合计 ${totalPenalty} 分）< 0，按 0 分计`
      : `健康分 = 100 − Σ各因子扣分（合计 ${totalPenalty} 分）`,
    source: '四因子明细见下表'
  })

  for (const f of health.factors) {
    rows.push({
      label: f.name,
      value: `扣 ${f.penalty} 分`,
      formula: f.formula,
      source: f.source
    })
  }

  rows.push({
    label: '风险等级',
    value: `${health.level}（${health.levelLabel}）`,
    formula: health.escalateReasons.length
      ? health.escalateReasons.join('；')
      : `健康分 ${health.score} 落入该等级区间`,
    source: 'health.js 风险分档规则'
  })

  rows.push({
    label: '风险系数',
    value: String(loss.riskFactor),
    formula: `等级基准系数 + ${health.overdueDays !== null && health.overdueDays > 30 ? '超期 > 30 天加 0.2' : '无超期加成'}，上限 0.9`,
    source: 'health.js getRiskFactor'
  })

  rows.push({
    label: '预估停时',
    value: `${loss.downtimeDays} 天`,
    formula: loss.downtimeFormula,
    // 停时只由"维保超期天数"推算（+ 故障状态补偿），维修记录不参与——原来源说明写错了
    source: '维保周期与上次维保日期推算的超期天数（health.js getDowntimeDays，不使用维修记录）'
  })

  rows.push({
    label: '日产出假设',
    value: `${loss.dailyOutputLoss.toLocaleString('zh-CN')} 元/日`,
    formula: `按设备类别取值：${eq.category} → ${dailyOutputLossOf(eq.category).toLocaleString('zh-CN')} 元/日`,
    source: '演示参数表（可在系统设置中调整）'
  })

  rows.push({
    label: '预计停机损失',
    value: `${loss.estimatedLoss.toLocaleString('zh-CN')} 元`,
    formula: loss.formula,
    source: LOSS_NOTE
  })

  return rows
}

/**
 * 生成完整体检报告
 * @param {object} eq    设备对象
 * @param {object} store Pinia store（用于取维保记录与健康快照）
 * @returns {object} 报告对象（含 html）
 */
export function generateHealthReport(eq, store) {
  if (!eq) throw new Error('生成体检报告需要设备对象')

  const health = evaluateHealth(eq)
  const factors = health.factors
  const loss = estimateLoss(eq)
  const riskItems = buildRiskItems(eq, health, factors)
  const maintenancePlan = buildMaintenancePlan(eq)
  const traceability = buildTraceability(eq, health, loss)

  // 维保历史与故障统计（真实数据，不是估算）
  const records = store && store.getMaintenanceByEquipmentId ? store.getMaintenanceByEquipmentId(eq.id) : []
  const faultRecords = records.filter(r => r.type === '故障维修')
  const halfYearAgo = addDays(now().slice(0, 10), -180)
  const recentFaults = faultRecords.filter(r => String(r.date) >= halfYearAgo)
  const orders = store && store.getOrdersByEquipmentName ? store.getOrdersByEquipmentName(eq.name) : []
  const totalCost = records.reduce((sum, r) => sum + (Number(r.cost) || 0), 0)

  // 健康趋势（快照不足 3 期时明确标注"数据积累中"）
  const snapshots = store && store.getSnapshots ? store.getSnapshots(eq.id) : []
  const trend = evaluateTrend(snapshots)

  const generatedAt = now()
  const conclusion = health.conclusion

  const report = {
    equipment: {
      id: eq.id,
      name: eq.name,
      model: eq.model,
      brand: eq.model && eq.model.includes(' ') ? eq.model.split(' ')[0] : '',
      category: eq.category,
      location: eq.location,
      purchase_date: eq.purchase_date,
      status: eq.status,
      maintenance_cycle_days: eq.maintenance_cycle_days,
      last_maintenance_date: eq.last_maintenance_date
    },
    generatedAt,
    summary: {
      score: health.score,
      level: health.level,
      levelLabel: health.levelLabel,
      levelDesc: health.levelDesc,
      color: health.color,
      conclusion,
      overdueDays: health.overdueDays
    },
    factors,
    riskItems,
    lossEstimate: { ...loss, note: LOSS_NOTE },
    maintenancePlan,
    trend,
    history: {
      maintenanceCount: records.length,
      faultCount: faultRecords.length,
      recentFaultCount: recentFaults.length,
      orderCount: orders.length,
      totalCost,
      records: records.slice(0, 6)
    },
    traceability
  }

  report.html = renderReportHtml(report)
  return report
}

// ============================================================
// HTML 渲染（自带样式，用于抽屉展示与打印）
// ============================================================

function levelBadgeColor(level) {
  return (RISK_LEVELS[level] || RISK_LEVELS.A).color
}

function renderFactorRow(factor) {
  const width = Math.max(0, Math.min(100, factor.score))
  return `
    <div class="hr-factor">
      <div class="hr-factor-head">
        <span class="hr-factor-name">${escapeHtml(factor.name)}</span>
        <span class="hr-factor-score" style="color:${levelMeta(levelOf(factor.score)).color}">
          ${factor.score} 分
        </span>
      </div>
      <div class="hr-bar"><div class="hr-bar-fill" style="width:${width}%"></div></div>
      <div class="hr-factor-detail">${escapeHtml(factor.detail)}</div>
      <div class="hr-factor-formula">算式：${escapeHtml(factor.formula)}</div>
    </div>`
}

function renderRiskItem(item) {
  const colors = { high: 'var(--danger)', medium: 'var(--amber)', low: 'var(--ink-4)' }
  return `
    <tr>
      <td><span class="hr-dot" style="background:${colors[item.level]}"></span>${escapeHtml(item.title)}</td>
      <td>${escapeHtml(item.desc)}</td>
      <td>${escapeHtml(item.suggestion)}</td>
      <td class="hr-ref">${escapeHtml(item.ref)}</td>
    </tr>`
}

function renderTrendBlock(trend) {
  if (trend.kind === 'insufficient') {
    return `<div class="hr-note">健康分趋势：${escapeHtml(trend.summary)}</div>`
  }
  const points = trend.points
  // 与设备台账/设备病历共用同一套坐标计算（自动缩放）。
  // 此前这里是写死的 0-100 纵轴，几分的波动在报告里被压成一条直线，
  // 打印出来看不出"恶化中"，与屏幕上看到的趋势图也对不上。
  const chart = buildTrendPath(points, { width: 520, height: 90 })
  if (!chart) return `<div class="hr-note">健康分趋势：${escapeHtml(trend.summary)}</div>`

  const dots = chart.points.map(p => `<circle cx="${p.x}" cy="${p.y}" r="3" fill="${trend.color}" />`).join('')

  return `
    <div class="hr-trend">
      <svg viewBox="0 0 ${chart.width} ${chart.height + 20}" class="hr-trend-svg" preserveAspectRatio="none">
        <path d="${chart.d}" fill="none" stroke="${trend.color}" stroke-width="2" />
        ${dots}
      </svg>
      <div class="hr-trend-axis">
        ${points.map(p => `<span>${escapeHtml(String(p.date).slice(5))}·${p.score}</span>`).join('')}
      </div>
      <div class="hr-trend-summary" style="color:${trend.color}">
        ${escapeHtml(trend.label)}：${escapeHtml(trend.summary)}
      </div>
      <div class="hr-note">纵轴按 ${chart.min}-${chart.max} 分自动缩放，便于看清期间波动。</div>
    </div>`
}

function renderReportHtml(report) {
  const eq = report.equipment
  const s = report.summary
  const badgeColor = levelBadgeColor(s.level)

  const statusLabels = { running: '运行中', idle: '闲置', maintenance: '维保中', fault: '故障' }

  return `
<div class="print-doc health-report">
  <header class="hr-head">
    <div>
      <h1>设备体检报告</h1>
      <div class="hr-sub">矿山智工 · 设备健康智能体（本地离线生成）</div>
    </div>
    <div class="hr-badge" style="border-color:${badgeColor};color:${badgeColor}">
      <span class="hr-badge-score">${s.score}</span>
      <span class="hr-badge-level">${escapeHtml(s.level)} ${escapeHtml(s.levelLabel)}</span>
    </div>
  </header>

  <section class="hr-meta">
    <div><span>设备名称</span><strong>${escapeHtml(eq.name)}</strong></div>
    <div><span>规格型号</span><strong>${escapeHtml(eq.model || '未录入')}</strong></div>
    <div><span>设备类别</span><strong>${escapeHtml(eq.category || '未录入')}</strong></div>
    <div><span>所在位置</span><strong>${escapeHtml(eq.location || '未录入')}</strong></div>
    <div><span>购置日期</span><strong>${escapeHtml(eq.purchase_date || '未录入')}</strong></div>
    <div><span>当前状态</span><strong>${escapeHtml(statusLabels[eq.status] || eq.status)}</strong></div>
    <div><span>维保周期</span><strong>${escapeHtml(eq.maintenance_cycle_days)} 天</strong></div>
    <div><span>上次维保</span><strong>${escapeHtml(eq.last_maintenance_date || '无记录')}</strong></div>
    <div><span>报告生成</span><strong>${escapeHtml(report.generatedAt)}</strong></div>
  </section>

  <section>
    <h2>一、体检结论</h2>
    <div class="hr-conclusion" style="border-left-color:${badgeColor}">
      ${escapeHtml(s.conclusion)}
    </div>
    <div class="hr-history-line">
      维保记录 ${report.history.maintenanceCount} 条（其中故障维修 ${report.history.faultCount} 条，近半年 ${report.history.recentFaultCount} 条）；
      关联工单 ${report.history.orderCount} 张；
      记录在册维保费用合计 ¥${report.history.totalCost.toLocaleString('zh-CN')}。
    </div>
  </section>

  <section>
    <h2>二、健康度四因子</h2>
    <div class="hr-factors">${report.factors.map(renderFactorRow).join('')}</div>
  </section>

  <section>
    <h2>三、健康分趋势</h2>
    ${renderTrendBlock(report.trend)}
  </section>

  <section>
    <h2>四、风险清单</h2>
    ${report.riskItems.length
      ? `<table class="hr-table">
          <thead><tr><th style="width:22%">风险项</th><th style="width:30%">依据</th><th style="width:32%">处置建议</th><th>参考规程</th></tr></thead>
          <tbody>${report.riskItems.map(renderRiskItem).join('')}</tbody>
        </table>`
      : '<div class="hr-note">未发现明显风险项。</div>'}
  </section>

  <section>
    <h2>五、停机损失估算<span class="hr-estimate-tag">估算 · 演示口径</span></h2>
    <div class="hr-loss">
      <div class="hr-loss-value">¥${report.lossEstimate.estimatedLoss.toLocaleString('zh-CN')}</div>
      <div class="hr-loss-formula">${escapeHtml(report.lossEstimate.formula)}</div>
    </div>
    <div class="hr-note">${escapeHtml(report.lossEstimate.note)}</div>
  </section>

  <section>
    <h2>六、建议保养计划</h2>
    <table class="hr-table">
      <thead><tr><th style="width:22%">计划日期</th><th>保养项目</th><th style="width:16%">周期</th></tr></thead>
      <tbody>
        ${report.maintenancePlan.map(p => `
          <tr>
            <td>${escapeHtml(p.dueDate)}${p.urgent ? '<span class="hr-urgent">立即</span>' : ''}</td>
            <td>${escapeHtml(p.item)}</td>
            <td>${escapeHtml(p.cycleDays)} 天</td>
          </tr>`).join('')}
      </tbody>
    </table>
  </section>

  <section class="hr-trace">
    <h2>七、数字溯源（可审计）</h2>
    <div class="hr-note">本报告每个数字都可追溯到计算式与数据来源。数据不足时系统会明确标注，不会推测补全。</div>
    <table class="hr-table hr-trace-table">
      <thead><tr><th style="width:18%">指标</th><th style="width:16%">数值</th><th style="width:40%">计算式</th><th>数据来源</th></tr></thead>
      <tbody>
        ${report.traceability.map(row => `
          <tr>
            <td>${escapeHtml(row.label)}</td>
            <td><strong>${escapeHtml(row.value)}</strong></td>
            <td class="hr-mono">${escapeHtml(row.formula)}</td>
            <td class="hr-mono">${escapeHtml(row.source)}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  </section>

  <footer class="hr-foot">
    <div class="hr-sign">
      <div>设备主管签字：____________________</div>
      <div>维保负责人签字：____________________</div>
    </div>
    <div class="hr-foot-note">
      本报告由矿山智工在本地生成，数据未离开本机。演示参数（日产出、风险系数）请以企业实际口径为准。
    </div>
  </footer>
</div>`
}

export { LOSS_NOTE, ACTION_LABELS, TYPE_LABELS }
