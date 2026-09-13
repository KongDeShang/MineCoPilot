import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import './styles/tokens.css'
import './styles/healthReport.css'
import zhCn from 'element-plus/dist/locale/zh-cn.mjs'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'

import App from './App.vue'
import router from './router'
import { useAppStore } from './stores/appStore'

async function bootstrap() {
  const app = createApp(App)

  // 注册 Element Plus 图标
  for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
    app.component(key, component)
  }

  app.use(createPinia())
  app.use(router)
  app.use(ElementPlus, { locale: zhCn })

  // 先把本地数据库装载完再挂载界面，避免首屏闪一下空数据
  const store = useAppStore()
  try {
    await store.initStore()
  } catch (error) {
    console.error('[启动] 本地数据装载失败：', error)
  }

  // 关窗/刷新前把未落盘的变更写回本地，保证「数据不出设备」且不丢失
  const flush = () => { store.saveNow() }
  window.addEventListener('beforeunload', flush)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })

  app.mount('#app')
}

bootstrap()
