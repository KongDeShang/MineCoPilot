import { createApp } from 'vue'
import { createPinia } from 'pinia'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
// ── 样式层叠顺序（从低到高）──
// EP 默认色 < tokens.css 主题覆盖 < 业务组件内联样式
// order 必须严格：EP 全量 CSS 在前，tokens.css 在后，业务样式最后。
import 'element-plus/dist/index.css'
import './styles/tokens.css'
import './styles/healthReport.css'
import './styles/driverTheme.css'
// 命令式组件（ElMessage / ElMessageBox）的独立样式——unplugin 无法自动引入
import 'element-plus/theme-chalk/el-message.css'
import 'element-plus/theme-chalk/el-message-box.css'

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
  // 中文 locale：按需引入模式下由 globalProperties 注入，与全量 app.use(ElementPlus, { locale }) 等效
  app.config.globalProperties.$ELEMENT = { locale: zhCn }

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
