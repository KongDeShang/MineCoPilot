import { createRouter, createWebHashHistory } from 'vue-router'
import { getRoutes } from '../domains/registry'

const router = createRouter({
  history: createWebHashHistory(),
  routes: getRoutes()
})

export default router