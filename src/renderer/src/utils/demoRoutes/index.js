/**
 * 演示路线注册表
 *
 * 路线 = 纯 JSON 结构（见各文件），播放器只认 { id, name, steps }，
 * 新增路线只需在这里登记一个文件。
 */
import main from './main'
import aiLine from './ai-line'
import bigScreen from './big-screen'

export const DEMO_ROUTES = [main, aiLine, bigScreen]

/** 按 id 取路线（找不到返回主线兜底） */
export function getDemoRoute(id) {
  return DEMO_ROUTES.find((r) => r.id === id) || DEMO_ROUTES[0]
}
