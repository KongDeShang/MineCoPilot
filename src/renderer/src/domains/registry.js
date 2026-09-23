/**
 * 域注册中心
 *
 * 所有业务域在此注册，提供**菜单与路由**的统一数据源。
 * 当前只有 settings 域完成迁移，其余 14 个页面保持硬编码过渡，
 * 后续逐个迁入。
 *
 * 命令与能力声明两处 accessor 已删除（无任何调用方，见文件末尾说明）——
 * 所以这里能提供的就只有菜单和路由，别把它当成"域化架构已完成"的证据。
 */

// ── 已注册域 ──────────────────────────────────────────────────────────────────
const domains = []

export function registerDomain(def) {
  domains.push(def)
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
 * 兜底路由
 *
 * 在此之前没有任何兜底条目：跳到不存在的路径（例如误写的 /alerts）时
 * vue-router 匹配不到任何路由，<router-view> 渲染成空白，界面没有任何反馈。
 * 这里统一重定向回看板，任何路径都不会再出现白屏。
 *
 * 必须追加在路由表最末：vue-router 按声明顺序匹配，放在前面会把
 * /settings、/dashboard 这些真实路由一起吞掉。
 */
const FALLBACK_ROUTE = { path: '/:pathMatch(.*)*', redirect: '/dashboard' }

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
  // 兜底路由不放进 LEGACY_ROUTES：那会被按 path 过滤、也会排在域路由之前。
  // 独立常量 + 追加在最末，既不会被 domainPaths 过滤掉，也不会重复。
  return [...legacy, ...domainRoutes, FALLBACK_ROUTE]
}

/**
 * 这里原来还有三个导出：`getDomain(id)`、`getCommands()`、`getCapabilities()`。
 * 三个都**没有任何调用方**（域声明里的 commands / capabilities 字段也无人读取），
 * 已于 2026-09-17 删除：
 *
 *   · `getCapabilities()` + `domains/settings/capabilities.js` —— 它代表的是
 *     "模型档位不够就隐藏入口"的能力灰度，而那套机制从未实现（全仓 `capabilities`
 *     只被渲染成文字角标）。留着它，读代码的人会以为能力分级已经落地。
 *   · `getCommands()` + `domains/settings/commands.js` —— 命令面板（任务 12）未开工，
 *     其中一条命令的 action 还是 null。它是为未来任务预留的接口，但"预留"一旦没人读，
 *     就只剩下"这段架构已经做完"的错觉。
 *   · `getDomain(id)` —— 连未来调用方都没有。
 *
 * 这些都是几行的东西：真要落地命令面板或能力灰度时，**由那个任务**连带把
 * accessor 和消费方一起加回来（`docs/tasks/12-CtrlK命令面板.md` 已注明）。
 * 判据很简单：声明的接口如果没有消费方，就不算完成，只算占位。
 */