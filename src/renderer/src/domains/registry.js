/**
 * 域注册中心
 *
 * 所有业务域在此注册，提供菜单 / 路由 / 命令的统一数据源。
 * 当前只有 settings 域完成迁移，其余 14 个页面保持硬编码过渡，
 * 后续逐个迁入。
 */

// ── 已注册域 ──────────────────────────────────────────────────────────────────
const domains = []

export function registerDomain(def) {
  domains.push(def)
}

export function getDomain(id) {
  return domains.find(d => d.id === id) || null
}

// ── 菜单（侧边栏） ───────────────────────────────────────────────────────────
// 四组保持硬编码过渡，系统组由已注册的域动态生成。
const LEGACY_MENUS = [
  {
    name: '设备健康',
    items: [
      { path: '/dashboard', label: '数据看板', icon: 'DataBoard' },
      { path: '/equipment', label: '设备台账', icon: 'SetUp' },
      { path: '/medical-records', label: '设备病历', icon: 'Notebook', badge: '体检' }
    ]
  },
  {
    name: '运维执行',
    items: [
      { path: '/alert-center', label: '告警中心', icon: 'Bell', badge: '告警' },
      { path: '/maintenance-calendar', label: '维保日历', icon: 'Calendar' },
      { path: '/workorder', label: '工单管理', icon: 'EditPen' },
      { path: '/recheck', label: '复诊管理', icon: 'CircleCheck', badge: '闭环' }
    ]
  },
  {
    name: 'AI 智能',
    items: [
      { path: '/ai-assistant', label: 'AI 助手', icon: 'ChatDotRound' },
      { path: '/model-hub', label: '本地模型', icon: 'Cpu', badge: '本地' },
      { path: '/knowledge-base', label: '维修规程库', icon: 'Reading', badge: '规程' },
      { path: '/documents', label: '手册资料库', icon: 'FolderOpened', badge: '文档' }
    ]
  },
  {
    name: '数据资产',
    items: [
      { path: '/fault-cases', label: '故障案例库', icon: 'Warning', badge: 'TOP' },
      { path: '/parts-inventory', label: '备件库存', icon: 'Box', badge: '联动' },
      { path: '/logs', label: '操作日志', icon: 'List' }
    ]
  }
]

/**
 * 返回完整侧边栏菜单结构。
 *
 * 5 组 15 项，顺序与视觉必须与升级前逐项一致。
 * 前 4 组取硬编码过渡数据；系统组从已注册的域动态组装。
 */
export function getMenus() {
  const systemDomains = domains.filter(d => d.group === '系统')
  const systemGroup = {
    name: '系统',
    items: systemDomains.map(d => ({
      path: d.route,
      label: d.name,
      icon: d.icon
    }))
  }
  return [...LEGACY_MENUS, systemGroup]
}

// ── 路由 ──────────────────────────────────────────────────────────────────────
const LEGACY_ROUTES = [
  { path: '/', name: 'Landing', component: () => import('../views/Landing.vue') },
  { path: '/dashboard', name: 'Dashboard', component: () => import('../views/Dashboard.vue') },
  { path: '/equipment', name: 'Equipment', component: () => import('../views/Equipment.vue') },
  { path: '/alert-center', name: 'AlertCenter', component: () => import('../views/AlertCenter.vue') },
  { path: '/parts-inventory', name: 'PartsInventory', component: () => import('../views/PartsInventory.vue') },
  { path: '/workorder', name: 'WorkOrder', component: () => import('../views/WorkOrder.vue') },
  { path: '/ai-assistant', name: 'AIAssistant', component: () => import('../views/AIAssistant.vue') },
  { path: '/maintenance-calendar', name: 'MaintenanceCalendar', component: () => import('../views/MaintenanceCalendar.vue') },
  { path: '/knowledge-base', name: 'KnowledgeBase', component: () => import('../views/KnowledgeBase.vue') },
  { path: '/medical-records', name: 'DeviceRecords', component: () => import('../views/DeviceRecords.vue') },
  { path: '/recheck', name: 'RecheckManage', component: () => import('../views/RecheckManage.vue') },
  { path: '/fault-cases', name: 'FaultCases', component: () => import('../views/FaultCases.vue') },
  { path: '/logs', name: 'Logs', component: () => import('../views/Logs.vue') },
  { path: '/documents', name: 'Documents', component: () => import('../views/Documents.vue') },
  { path: '/model-hub', name: 'ModelHub', component: () => import('../views/ModelHub.vue') }
]

/**
 * 返回完整路由表。
 *
 * 已注册域的路由由域声明提供；未迁移的页面取硬编码过渡数据。
 * 与 router/index.js 的原始路由表逐条一致。
 */
export function getRoutes() {
  const domainRoutes = domains.flatMap(d => d.routes || [])
  // 域路由覆盖同 path 的硬编码条目（settings 的 /settings 会替换硬编码）
  const domainPaths = new Set(domainRoutes.map(r => r.path))
  const legacy = LEGACY_ROUTES.filter(r => !domainPaths.has(r.path))
  return [...legacy, ...domainRoutes]
}

// ── 命令（命令面板用，Task 12 实现后生效） ────────────────────────────────────
export function getCommands() {
  return domains.flatMap(d => (d.commands || []).map(c => ({ ...c, domain: d.id })))
}

// ── 能力声明 ──────────────────────────────────────────────────────────────────
export function getCapabilities() {
  return domains.reduce((acc, d) => {
    acc[d.id] = d.capabilities || []
    return acc
  }, {})
}