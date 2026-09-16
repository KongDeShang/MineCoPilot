/**
 * 矿山智工 - AI 会话摘要（任务 17 Batch B4）
 *
 * 规则生成，不依赖本地模型（0.5B 干不了结构化总结，1.5B 也不承诺）：
 * 统计问答轮数 / 提到的设备 / 涉及的故障系统 / 现场待办提醒。
 * 供导出对话、交接班使用；抽成独立模块以便 e2e 直调断言。
 *
 * @param {Array} conversation [{ role, text, equipmentName?, timestamp }]
 * @param {{ overdueCount?: number, equipmentCount?: number }} [ctx]
 * @returns {string|null} Markdown 摘要；无用户轮次返回 null
 */
export function buildConversationSummary(conversation, ctx = {}) {
  const userTurns = (conversation || []).filter(c => c && c.role === 'user')
  if (!userTurns.length) return null

  const devices = [...new Set((conversation || []).map(c => c && c.equipmentName).filter(Boolean))]
  const sysKeywords = {
    '液压系统': ['液压', '油压', '油缸', '泵', '阀'],
    '动力系统': ['发动机', '水温', '过热', '异响', '动力'],
    '电气系统': ['电气', '电路', '电瓶', '传感器', '线束'],
    '行走机构': ['轮胎', '履带', '行走', '制动', '刹车']
  }
  const systems = []
  const allText = (conversation || []).map(c => (c && c.text) || '').join('')
  for (const [sys, kws] of Object.entries(sysKeywords)) {
    if (kws.some(kw => allText.includes(kw))) systems.push(sys)
  }

  const lines = [
    `## AI 对话摘要`,
    ``,
    `- 问答轮数：${userTurns.length} 轮`,
    devices.length ? `- 涉及设备：${devices.join('、')}` : '- 涉及设备：未明确提及',
    systems.length ? `- 涉及系统：${systems.join('、')}` : '- 涉及系统：未明确',
    ctx.overdueCount > 0
      ? `- 现场待办：仍有 ${ctx.overdueCount} 台设备维保超期（可在维保日历一键建单）`
      : '',
    ``
  ].filter(Boolean)
  return lines.join('\n')
}
