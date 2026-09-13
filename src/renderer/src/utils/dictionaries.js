/**
 * 界面文案字典：设备状态 / 工单状态 / 优先级 / 类型 / 来源 / 维保类型
 *
 * 为什么集中一处：
 *   同一套文案此前在 Store、全局搜索、工单页、设备台账里各写了一份，
 *   于是"同一个状态在不同页面叫不同名字"：
 *   工单页把 pending 叫「待派单」，搜索面板和设备病历里叫「待处理」，
 *   用户看到会以为是两个不同的状态。
 *   副本还各缺一块：设备台账里的工单状态配色表没有 assigned 分支
 *   （已派单的标签会掉到灰色兜底色），Store 里那份则一个页面都没在用。
 *
 *   这里给一份，谁要谁取。自检里有一组源码级断言盯着"不许再各写一份"——
 *   光靠自觉统一，下一次加状态时又会冒出新副本。
 *
 * 约定：标签（label）+ 配色（tagType）成对给出，避免"文案统一了、颜色没统一"。
 */

// ============================================================
// 设备状态
// ============================================================

export const EQUIPMENT_STATUS = {
  running: { label: '运行中', tagType: 'success' },
  idle: { label: '闲置', tagType: 'info' },
  maintenance: { label: '维保中', tagType: 'warning' },
  fault: { label: '故障', tagType: 'danger' }
}

export function equipmentStatusLabel(status) {
  return (EQUIPMENT_STATUS[status] || {}).label || status
}

export function equipmentStatusTagType(status) {
  return (EQUIPMENT_STATUS[status] || {}).tagType || 'info'
}

// ============================================================
// 工单
// ============================================================

/**
 * 工单状态
 *
 * pending 的文案取「待派单」而不是「待处理」：这一档的准确含义是
 * "已建单、还没派给班组"，工单页的筛选按钮也是这么写的。
 * 「待处理」更像是 processing 的近义词，容易和「处理中」混。
 */
export const WORK_ORDER_STATUS = {
  pending: { label: '待派单', tagType: 'warning' },
  assigned: { label: '已派单', tagType: 'warning' },
  processing: { label: '处理中', tagType: 'primary' },
  completed: { label: '已完成', tagType: 'success' },
  cancelled: { label: '已取消', tagType: 'info' }
}

export function statusLabel(status) {
  return (WORK_ORDER_STATUS[status] || {}).label || status
}

export function statusTagType(status) {
  return (WORK_ORDER_STATUS[status] || {}).tagType || 'info'
}

export const WORK_ORDER_PRIORITY = {
  urgent: { label: '紧急', tagType: 'danger' },
  high: { label: '高', tagType: 'warning' },
  normal: { label: '普通', tagType: '' },
  low: { label: '低', tagType: 'info' }
}

export function priorityLabel(priority) {
  return (WORK_ORDER_PRIORITY[priority] || {}).label || priority
}

export function priorityTagType(priority) {
  return (WORK_ORDER_PRIORITY[priority] || {}).tagType || ''
}

export const WORK_ORDER_TYPE = {
  maintenance: { label: '维保', tagType: 'primary' },
  repair: { label: '维修', tagType: 'danger' },
  inspection: { label: '巡检', tagType: 'success' }
}

export function orderTypeLabel(type) {
  return (WORK_ORDER_TYPE[type] || {}).label || type
}

export function orderTypeTagType(type) {
  return (WORK_ORDER_TYPE[type] || {}).tagType || 'info'
}

/** 工单来源：怎么进系统的（手工/口述/拍照/Excel 导入） */
export const WORK_ORDER_SOURCE = {
  manual: '手动',
  voice: '语音',
  ocr: '拍照',
  excel: 'Excel'
}

export function orderSourceLabel(source) {
  return WORK_ORDER_SOURCE[source] || source
}

// ============================================================
// 维保记录类型（注意：这是入库的中文枚举值，不是工单 type 的英文枚举）
// ============================================================

export const MAINTENANCE_TYPES = ['定期保养', '故障维修', '部件更换', '巡检']

export const MAINTENANCE_TYPE_STYLE = {
  定期保养: { tagType: 'success', timelineType: 'success' },
  故障维修: { tagType: 'danger', timelineType: 'warning' },
  部件更换: { tagType: 'warning', timelineType: 'primary' },
  巡检: { tagType: 'info', timelineType: 'info' }
}

export function maintenanceStyle(type) {
  return MAINTENANCE_TYPE_STYLE[type] || { tagType: 'info', timelineType: 'info' }
}
