/**
 * 数据洞察卡计算引擎
 *
 * 自动从 appStore 中提取核心运营指标，
 * 生成 3 张数据洞察卡（设备可用率、维保执行率、故障集中度）。
 *
 * 每张卡包含：label / value / level / advice / trend（可选）
 * level: 'ok' | 'warn' | 'danger'
 */

/**
 * 计算设备可用率
 * 可用率 = 运行中设备数 / 总设备数 * 100
 */
function calcAvailabilityRate(store) {
  const total = store.equipmentList.length
  if (total === 0) return { value: '—', level: 'ok', advice: '暂无设备数据', raw: 0 }

  const running = store.stats?.running ?? store.equipmentList.filter(e => e.status === 'running').length
  const rate = (running / total * 100)

  let level, advice
  if (rate >= 90) {
    level = 'ok'
    advice = '设备运行状态良好，保持当前维保节奏'
  } else if (rate >= 80) {
    level = 'warn'
    advice = '可用率有下降趋势，建议关注故障设备的维修进度'
  } else {
    level = 'danger'
    advice = '可用率低于 80%，建议排查停机设备原因并优先恢复'
  }

  return {
    value: `${rate.toFixed(1)}%`,
    level,
    advice,
    raw: rate,
    detail: `${running} / ${total} 台运行中`
  }
}

/**
 * 计算维保执行率
 * 执行率 = 已完成维保记录数 / 应执行维保数 * 100
 * 应执行 = 设备数 × (当前月天数 / 维保周期天数) 的理论次数
 */
function calcMaintenanceRate(store) {
  const total = store.equipmentList.length
  if (total === 0) return { value: '—', level: 'ok', advice: '暂无设备数据', raw: 0 }

  // 实际完成数：本月的维保记录
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  const records = store.maintenanceRecords || {}
  let completed = 0
  for (const eqId of Object.keys(records)) {
    const eqRecords = Array.isArray(records[eqId]) ? records[eqId] : []
    completed += eqRecords.filter(r => (r.date || r.completedAt || 0) >= monthStart).length
  }

  // 超期设备数（反面指标：超期越多，执行率越低）
  const overdueCount = (store.overdueList || []).length
  const rate = total > 0 ? Math.max(0, ((total - overdueCount) / total * 100)) : 100

  let level, advice
  if (rate >= 85) {
    level = 'ok'
    advice = '维保计划执行正常，本月完成质量良好'
  } else if (rate >= 70) {
    level = 'warn'
    advice = '部分设备维保积压，建议近期集中安排补保'
  } else {
    level = 'danger'
    advice = '维保积压严重，建议增加维保资源或调整排期计划'
  }

  return {
    value: `${rate.toFixed(1)}%`,
    level,
    advice,
    raw: rate,
    detail: `本月 ${completed} 次维保 · ${overdueCount} 台超期`
  }
}

/**
 * 计算故障集中度
 * 集中度 = TOP3 设备故障数 / 总故障数 * 100
 * 集中度越高，说明故障集中在少数设备，可能是老化或操作问题
 */
function calcFaultConcentration(store) {
  const faultStats = store.faultTopStats || []
  if (faultStats.length === 0) return { value: '暂无', level: 'ok', advice: '暂无故障数据或设备运行良好', raw: 0 }

  const totalFaults = faultStats.reduce((sum, f) => sum + (f.count || f.total || 0), 0)
  if (totalFaults === 0) return { value: '0%', level: 'ok', advice: '无故障记录', raw: 0 }

  const top3 = faultStats.slice(0, 3).reduce((sum, f) => sum + (f.count || f.total || 0), 0)
  const concentration = (top3 / totalFaults * 100)

  let level, advice
  if (concentration < 40) {
    level = 'ok'
    advice = '故障分布均匀，无异常集中现象'
  } else if (concentration < 60) {
    level = 'warn'
    advice = 'TOP3 设备故障占比偏高，建议针对性排查'
  } else {
    level = 'danger'
    advice = '故障高度集中于少数设备，建议对 TOP3 做根因分析或评估换新'
  }

  const topNames = faultStats.slice(0, 3).map(f => f.name || f.equipmentName || f.equipmentId).join('、')

  return {
    value: `${concentration.toFixed(0)}%`,
    level,
    advice,
    raw: concentration,
    detail: `TOP3 占 ${top3}/${totalFaults} 次 · ${topNames || '—'}`
  }
}

/**
 * 生成全部数据洞察
 * @param {object} store - appStore 实例
 * @returns {Array<{ icon: string, label: string, value: string, level: string, advice: string, detail: string }>}
 */
export function buildInsights(store) {
  return [
    {
      icon: 'Monitor',
      label: '设备可用率',
      ...calcAvailabilityRate(store)
    },
    {
      icon: 'Finished',
      label: '维保执行率',
      ...calcMaintenanceRate(store)
    },
    {
      icon: 'Warning',
      label: '故障集中度',
      ...calcFaultConcentration(store)
    }
  ]
}
