/**
 * 矿山智工 - 智能周报/月报生成器
 *
 * 从 store 实时数据聚合生成结构化报告，支持导出为 HTML/PDF。
 * 所有数字均由本地台账实时计算，不编造。
 */
import { now, daysAgoDate, daysSince } from './dates'
import { evaluateHealth } from './health'

/**
 * 获取本周/本月的时间范围
 * @param {'week'|'month'} period
 * @returns {{start: string, end: string, label: string}}
 */
export function getPeriodRange(period = 'week') {
  const today = new Date()
  const end = today.toISOString().slice(0, 10)

  if (period === 'month') {
    const start = new Date(today.getFullYear(), today.getMonth(), 1)
    return {
      start: start.toISOString().slice(0, 10),
      end,
      label: `${today.getFullYear()}年${today.getMonth() + 1}月`
    }
  }

  // 本周（周一到今天）
  const dayOfWeek = today.getDay() || 7 // 周日=7
  const monday = new Date(today)
  monday.setDate(today.getDate() - dayOfWeek + 1)
  const weekNum = Math.ceil((today.getDate() + new Date(today.getFullYear(), today.getMonth(), 1).getDay()) / 7)
  return {
    start: monday.toISOString().slice(0, 10),
    end,
    label: `${today.getFullYear()}年${today.getMonth() + 1}月第${weekNum}周`
  }
}

/**
 * 生成周报/月报数据
 * @param {object} store appStore 实例
 * @param {'week'|'month'} period
 * @returns {object} 报告数据对象
 */
export function generateReportData(store, period = 'week') {
  const range = getPeriodRange(period)
  const equipment = store.equipmentList
  const orders = store.workOrders

  // 1. 车队概况
  const healthScores = store.equipmentWithHealth.map(e => e.health.score)
  const healthAvg = healthScores.length > 0
    ? Math.round(healthScores.reduce((s, v) => s + v, 0) / healthScores.length)
    : 0
  const healthLevels = store.healthLevelStats

  const newOrders = orders.filter(o => o.created_at >= range.start)
  const completedOrders = orders.filter(o =>
    o.completed_at && o.completed_at.slice(0, 10) >= range.start)

  const repairOrders = newOrders.filter(o => o.type === 'repair')
  const maintenanceOrders = newOrders.filter(o => o.type === 'maintenance')

  // 2. 重点预警
  const critical = store.criticalList.slice(0, 5).map(eq => ({
    name: eq.name,
    model: eq.model,
    score: eq.health.score,
    level: eq.health.level,
    levelLabel: eq.health.levelLabel,
    overdueDays: eq.health.overdueDays,
    reason: eq.health.overdueDays > 45
      ? `维保超期 ${eq.health.overdueDays} 天，严重逾期`
      : eq.health.overdueDays > 0
        ? `维保超期 ${eq.health.overdueDays} 天`
        : eq.status === 'fault'
          ? '设备处于故障状态'
          : `健康分 ${eq.health.score}（${eq.health.level}级）`
  }))

  const worsening = store.worseningList.slice(0, 5).map(item => ({
    name: item.name,
    model: item.model,
    trend: item.trend.summary,
    delta: item.trend.delta
  }))

  // 3. 亮点（健康分显著恢复的设备）
  const improving = equipment.map(eq => {
    const snaps = store.getSnapshots(eq.id)
    if (snaps.length < 2) return null
    const latest = snaps[snaps.length - 1]
    const prev = snaps[snaps.length - 2]
    if (latest.score > prev.score + 8) {
      return {
        name: eq.name,
        model: eq.model,
        from: prev.score,
        to: latest.score,
        improvement: latest.score - prev.score
      }
    }
    return null
  }).filter(Boolean).sort((a, b) => b.improvement - a.improvement).slice(0, 5)

  // 4. 下周计划
  const upcoming = store.upcomingList.slice(0, 5)
  const pendingRechecks = store.recheckList.slice(0, 5)

  // 5. 复诊闭环
  const recheckStats = store.recheckStats

  // 6. 高频故障
  const faultTop = store.faultTopStats.slice(0, 5)

  return {
    period,
    range,
    label: range.label,
    generatedAt: now(),
    overview: {
      total: equipment.length,
      healthAvg,
      healthLevels,
      newOrderCount: newOrders.length,
      repairCount: repairOrders.length,
      maintenanceCount: maintenanceOrders.length,
      completedCount: completedOrders.length,
      completionRate: newOrders.length > 0
        ? Math.round((completedOrders.length / newOrders.length) * 100)
        : null,
      recheckDone: recheckStats.done,
      recheckTotal: recheckStats.due,
      recheckRate: recheckStats.rate,
      overdueCount: store.overdueList.length
    },
    critical,
    worsening,
    improving,
    upcoming,
    pendingRechecks,
    faultTop
  }
}

/**
 * 将报告数据渲染为 HTML
 * @param {object} data generateReportData 的返回值
 * @returns {string} HTML 字符串
 */
export function renderReportHTML(data) {
  const lines = []
  const p = data.period === 'week' ? '周' : '月'

  // 标题
  lines.push(`<div style="font-size:16px;font-weight:800;margin-bottom:16px">📊 ${data.label} 设备运维${p}报 <span style="font-size:12px;color:#909399;font-weight:400">[AI 生成 · ${data.generatedAt.slice(0, 16)}]</span></div>`)

  // 车队概况
  const ov = data.overview
  lines.push(`<div style="margin-bottom:16px">`)
  lines.push(`<div style="font-weight:700;margin-bottom:8px">📋 车队概况</div>`)
  lines.push(`<ul style="margin:0;padding-left:18px;line-height:2">`)
  lines.push(`<li>在管 <strong>${ov.total}</strong> 台设备，健康均分 <strong>${ov.healthAvg}</strong>（A:${ov.healthLevels.A} B:${ov.healthLevels.B} C:${ov.healthLevels.C} D:${ov.healthLevels.D}）</li>`)
  lines.push(`<li>新增工单 <strong>${ov.newOrderCount}</strong> 单（维修 ${ov.repairCount} / 保养 ${ov.maintenanceCount}）</li>`)
  lines.push(`<li>已完成 <strong>${ov.completedCount}</strong> 单${ov.completionRate !== null ? `（完成率 ${ov.completionRate}%）` : ''}</li>`)
  if (ov.recheckTotal > 0) {
    lines.push(`<li>复诊完成 ${ov.recheckDone}/${ov.recheckTotal}（闭环率 ${ov.recheckRate}%）</li>`)
  }
  lines.push(`<li>维保超期 <span style="color:#f56c6c;font-weight:700">${ov.overdueCount}</span> 台</li>`)
  lines.push(`</ul></div>`)

  // 重点预警
  if (data.critical.length || data.worsening.length) {
    lines.push(`<div style="margin-bottom:16px">`)
    lines.push(`<div style="font-weight:700;margin-bottom:8px">⚠️ 重点关注</div>`)
    lines.push(`<ul style="margin:0;padding-left:18px;line-height:2">`)
    for (const eq of data.critical.slice(0, 3)) {
      lines.push(`<li><span style="color:#f56c6c;font-weight:600">${eq.name}</span>（${eq.model || ''}）— ${eq.reason}</li>`)
    }
    for (const eq of data.worsening.slice(0, 2)) {
      lines.push(`<li><span style="color:#e6a23c;font-weight:600">${eq.name}</span> — ${eq.trend}</li>`)
    }
    lines.push(`</ul></div>`)
  }

  // 亮点
  if (data.improving.length) {
    lines.push(`<div style="margin-bottom:16px">`)
    lines.push(`<div style="font-weight:700;margin-bottom:8px">🏆 亮点</div>`)
    lines.push(`<ul style="margin:0;padding-left:18px;line-height:2">`)
    for (const eq of data.improving.slice(0, 3)) {
      lines.push(`<li>${eq.name} 经过维修，健康分从 ${eq.from} 恢复至 <strong>${eq.to}</strong>（↑${eq.improvement}）</li>`)
    }
    lines.push(`</ul></div>`)
  }

  // 高频故障
  if (data.faultTop.length) {
    lines.push(`<div style="margin-bottom:16px">`)
    lines.push(`<div style="font-weight:700;margin-bottom:8px">📈 高频故障 TOP</div>`)
    lines.push(`<ul style="margin:0;padding-left:18px;line-height:2">`)
    for (const f of data.faultTop.slice(0, 3)) {
      lines.push(`<li>${f.label}：${f.count} 次（${f.percent}%）</li>`)
    }
    lines.push(`</ul></div>`)
  }

  // 下周计划
  if (data.upcoming.length || data.pendingRechecks.length) {
    lines.push(`<div style="margin-bottom:8px">`)
    lines.push(`<div style="font-weight:700;margin-bottom:8px">📋 下${p === '周' ? '周' : '月'}计划</div>`)
    lines.push(`<ul style="margin:0;padding-left:18px;line-height:2">`)
    if (data.upcoming.length) {
      lines.push(`<li>${data.upcoming.length} 台设备维保到期，请提前安排</li>`)
    }
    if (data.pendingRechecks.length) {
      lines.push(`<li>${data.pendingRechecks.length} 单待复诊</li>`)
    }
    if (data.critical.length > 0) {
      lines.push(`<li>建议优先处置 ${data.critical[0].name}（${data.critical[0].reason}）</li>`)
    }
    lines.push(`</ul></div>`)
  }

  lines.push(`<div style="margin-top:12px;padding:8px 12px;background:#f0f9eb;border-radius:6px;font-size:12px;color:#529b2e">` +
    `以上所有数字均由本地台账实时计算，未联网、未编造。报告生成于 ${data.generatedAt}。</div>`)

  return lines.join('')
}

/**
 * 一键生成完整报告（数据 + HTML）
 * @param {object} store
 * @param {'week'|'month'} period
 * @returns {{data: object, html: string}}
 */
export function generateReport(store, period = 'week') {
  const data = generateReportData(store, period)
  const html = renderReportHTML(data)
  return { data, html }
}
