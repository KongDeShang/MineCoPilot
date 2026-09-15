/**
 * 系统设置域 - 命令声明
 *
 * 接口占位：命令面板（Task 12）实现后，这些命令会出现在 Ctrl+K 面板中。
 */
export const commands = [
  {
    id: 'settings.open',
    label: '打开系统设置',
    icon: 'Setting',
    action: (router) => router.push('/settings')
  },
  {
    id: 'settings.reset-demo',
    label: '重置演示数据',
    icon: 'RefreshLeft',
    action: null // 由 App.vue 侧边栏的 resetDemo 处理
  }
]