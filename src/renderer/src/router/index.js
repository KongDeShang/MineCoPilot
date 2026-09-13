import { createRouter, createWebHashHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    name: 'Landing',
    component: () => import('../views/Landing.vue')
  },
  {
    path: '/dashboard',
    name: 'Dashboard',
    component: () => import('../views/Dashboard.vue')
  },
  {
    path: '/equipment',
    name: 'Equipment',
    component: () => import('../views/Equipment.vue')
  },
  {
    path: '/alert-center',
    name: 'AlertCenter',
    component: () => import('../views/AlertCenter.vue')
  },
  {
    path: '/parts-inventory',
    name: 'PartsInventory',
    component: () => import('../views/PartsInventory.vue')
  },
  {
    path: '/workorder',
    name: 'WorkOrder',
    component: () => import('../views/WorkOrder.vue')
  },
  {
    path: '/ai-assistant',
    name: 'AIAssistant',
    component: () => import('../views/AIAssistant.vue')
  },
  {
    path: '/maintenance-calendar',
    name: 'MaintenanceCalendar',
    component: () => import('../views/MaintenanceCalendar.vue')
  },
  {
    path: '/knowledge-base',
    name: 'KnowledgeBase',
    component: () => import('../views/KnowledgeBase.vue')
  },
  {
    path: '/medical-records',
    name: 'DeviceRecords',
    component: () => import('../views/DeviceRecords.vue')
  },
  {
    path: '/recheck',
    name: 'RecheckManage',
    component: () => import('../views/RecheckManage.vue')
  },
  {
    path: '/fault-cases',
    name: 'FaultCases',
    component: () => import('../views/FaultCases.vue')
  },
  {
    path: '/logs',
    name: 'Logs',
    component: () => import('../views/Logs.vue')
  },
  {
    path: '/documents',
    name: 'Documents',
    component: () => import('../views/Documents.vue')
  },
  {
    path: '/model-hub',
    name: 'ModelHub',
    component: () => import('../views/ModelHub.vue')
  },
  {
    path: '/settings',
    name: 'Settings',
    component: () => import('../views/Settings.vue')
  }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

export default router
