/**
 * 系统设置域 - 域声明与注册
 *
 * 样板域：第一个迁入 domains/ 结构的模块，验证域规范可行。
 * 设置状态仍在 stores/appStore.js + stores/settingsDomain.js 中，
 * 这里只做声明和注册，不搬运状态（先解耦再清理）。
 *
 * ⚠️ 域声明只需给注册中心**真的会读**的字段：
 *   · getMenus() 读 id/name/group/icon/route
 *   · getRoutes() 读 routes
 * 原来的 `commands`、`capabilities`、`component` 三个字段都没有任何读取方
 * （父级 component 由 routes.js 里的路由条目自己提供），已随同对应的 accessor 一并删除。
 * 加字段前先确认有消费方，否则声明的越多、越像"这套架构已经跑起来了"。
 */
import { registerDomain } from '../registry'
import { routes } from './routes'

registerDomain({
  id: 'settings',
  name: '系统设置',
  group: '系统',
  icon: 'Setting',
  route: '/settings',
  routes
})