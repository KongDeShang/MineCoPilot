/**
 * 系统设置域 - 域声明与注册
 *
 * 样板域：第一个迁入 domains/ 结构的模块，验证域规范可行。
 * 设置状态仍在 stores/appStore.js + stores/settingsDomain.js 中，
 * 这里只做声明和注册，不搬运状态（先解耦再清理）。
 */
import { registerDomain } from '../registry'
import { routes } from './routes'
import { commands } from './commands'
import { capabilities } from './capabilities'

registerDomain({
  id: 'settings',
  name: '系统设置',
  group: '系统',
  icon: 'Setting',
  route: '/settings',
  component: () => import('../../views/Settings.vue'),
  routes,
  commands,
  capabilities
})