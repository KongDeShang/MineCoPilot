/**
 * 演示路线 · 大屏线（待任务 10 数据大屏上线）
 *
 * pending: true —— 任务 10 未上线前，入口处标注"待上线"并禁用；
 * 任务 10 落地后，把 steps 按实际大屏页元素填上即可，无需改播放器代码。
 */
export default {
  id: 'big-screen',
  name: '大屏线',
  desc: '数据大屏 → 看板 → 退出',
  pending: true,
  steps: [
    // TODO(任务 10)：大屏路由与元素就位后按主线格式填写，例如：
    // { route: '/big-screen', target: '.big-screen-wrap', title: '…', content: '…', waitFor: 1200 }
  ]
}
