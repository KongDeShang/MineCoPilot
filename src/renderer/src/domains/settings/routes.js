/**
 * 系统设置域 - 路由声明
 */
export const routes = [
  {
    path: '/settings',
    name: 'Settings',
    component: () => import('../../views/Settings.vue')
  }
]