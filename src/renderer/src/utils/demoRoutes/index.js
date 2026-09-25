/**
 * 演示路线注册表
 *
 * 路线 = 纯 JSON 结构（见各文件），播放器只认 { id, name, steps }，
 * 新增路线只需在这里登记一个文件。
 *
 * 这里原有第三条「大屏线」（big-screen.js），内容是 `pending: true` + 空步骤数组，
 * 只等任务 10 数据大屏上线后填。任务 10 已于 2026-09-25 明确搁置
 * （见 docs/完善计划.md），菜单里那条永远点不动的「待上线」因而删除——
 * 留着一个不会上线的入口，与本项目"如实标注边界"的立场相悖。
 * 日后真要做大屏：新建路线文件并在此登记即可，播放器无需改动。
 */
import main from './main'
import aiLine from './ai-line'

export const DEMO_ROUTES = [main, aiLine]

/** 按 id 取路线（找不到返回主线兜底） */
export function getDemoRoute(id) {
  return DEMO_ROUTES.find((r) => r.id === id) || DEMO_ROUTES[0]
}
