import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import './styles/tokens.css'
import './styles/healthReport.css'
// driver.js 引导卡的主题覆盖。这里静态引入是**必需的**：driver.css 由
// demoTour.js 动态 import、插到 <head> 最后，覆盖规则必须在它之前就位，
// 再靠提高优先级取胜（原因写在该文件头部）。规则本身在没人启动引导时
// 匹配不到任何元素，代价只是一小段文本。
import './styles/driverTheme.css'
import zhCn from 'element-plus/dist/locale/zh-cn.mjs'

import App from './App.vue'
import router from './router'
import { APP_ICONS } from './utils/appIcons'
import { useAppStore } from './stores/appStore'

async function bootstrap() {
  const app = createApp(App)

  // 注册 Element Plus 图标（白名单，见 utils/appIcons.js）
  //
  // 不要退回 `import * as ElementPlusIconsVue` 再全量遍历：
  // 图标在模板里以字符串形式使用（icon="ArrowLeft"、<component :is="section.icon" />），
  // 依赖全局注册，所以拿不掉；但全量注册会让打包器无法摇树，
  // 293 个图标会被整包打进主 chunk（实测全部存在），而实际只用 69 个。
  for (const [key, component] of Object.entries(APP_ICONS)) {
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
