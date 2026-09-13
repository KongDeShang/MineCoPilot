/**
 * 维修工单 → 故障案例卡（症状 / 原因 / 处理）
 *
 * 为什么单独成模块：同一套推导有两个入口——
 *   · 运行时：工单完工自动归档（appStore.archiveWorkOrder → addFaultCase）
 *   · 演示数据：首启时，已完成的维修工单本来就该带着案例卡（buildSeed → applySeedData）
 * 两边各写一份必然漂移，表现成"演示数据里有案例、新完成一张却没有"或者反过来。
 * 所以规则只留这一份，两边都调它。
 *
 * 不编造：症状永远是工单原文；原因/处理来自知识库命中的那一条，
 * 命中不到就如实留空（界面会显示"知识库未命中，留待人工补充"），不现编一个像样的原因。
 */

/** 知识库条目的 keywords 有数组与逗号串两种形态，这里统一成数组 */
function keywordsOf(item) {
  return Array.isArray(item.keywords)
    ? item.keywords
    : String(item.keywords || '').split(/[,，]/)
}

/** 按"工单标题包含关键词"命中一条知识（只需一条可溯源的原因，不参与打分排序） */
export function matchKnowledge(orderTitle, knowledgeItems) {
  const title = String(orderTitle || '')
  if (!title) return null
  return (knowledgeItems || []).find(k => keywordsOf(k).some(w => w && title.includes(w))) || null
}

/**
 * 单张案例卡；不是维修类工单（或没有标题）返回 null
 *
 * 设备按 id 找、找不到再按名字找 —— 与 archiveWorkOrder 里的取法一致，
 * 手写工单里 equipment_id 缺失的情况也认得出设备。
 */
export function draftFaultCase(order, { equipmentList = [], knowledgeItems = [] } = {}) {
  if (!order || order.type !== 'repair' || !order.title) return null
  const eq = order.equipment_id
    ? equipmentList.find(e => String(e.id) === String(order.equipment_id))
    : equipmentList.find(e => e.name === order.equipment_name)
  const kb = matchKnowledge(order.title, knowledgeItems)
  return {
    equipment_name: order.equipment_name || (eq ? eq.name : ''),
    category: eq ? eq.category : '',
    symptom: order.title,
    cause: kb ? kb.title : '',
    solution: kb && Array.isArray(kb.steps) && kb.steps.length ? kb.steps[0] : (order.description || ''),
    parts_used: '',
    source_order_id: order.id,
    repair_hours: kb && kb.avg_repair_hours != null ? Number(kb.avg_repair_hours) : null
  }
}

/**
 * 由一批工单派生整份案例列表（演示数据工厂用）
 *
 * 只取"已完成的维修工单"：未完成的单子还没有处置结论，不该出现在案例库里——
 * 那正是这类沉淀最容易出的错（把在建的、取消的都算成"经验"）。
 *
 * id 按时间递增（旧 → 新），返回的数组则按**最新在前**排——
 * 与运行时 unshift 的语义一致，也和界面"最新自动沉淀案例"的叫法一致。
 */
export function buildFaultCasesFromOrders(orders, equipmentList, knowledgeItems) {
  const completed = (orders || [])
    .filter(o => o.status === 'completed' && o.type === 'repair' && o.title)
    .sort((a, b) => String(a.completed_at || a.created_at || '').localeCompare(String(b.completed_at || b.created_at || '')))
  const list = completed.map((order, i) => {
    const draft = draftFaultCase(order, { equipmentList, knowledgeItems })
    return draft && {
      id: i + 1,
      ...draft,
      // 案例的产生时间 = 工单完成时间：案例库是"按时间沉淀"的，
      // 全用 now() 会让历史案例全部堆在启动那一天
      createdAt: order.completed_at || order.created_at || ''
    }
  }).filter(Boolean)
  return list.reverse()
}
