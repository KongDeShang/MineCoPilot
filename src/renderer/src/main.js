import { createApp } from 'vue'
import { createPinia } from 'pinia'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
// ── 样式层叠顺序（从低到高）──
// EP 默认色 < tokens.css 主题覆盖 < 业务组件内联样式
// order 必须严格：EP 全量 CSS 在前，tokens.css 在后，业务样式最后。
import 'element-plus/dist/index.css'
// Element Plus 暗色方案（html.dark 下的 --el-* 底子；色相对齐见 tokens.css 深色块）
import 'element-plus/theme-chalk/dark/css-vars.css'
import './styles/tokens.css'
import './styles/healthReport.css'
import './styles/driverTheme.css'
// 命令式组件（ElMessage / ElMessageBox）的独立样式——unplugin 无法自动引入
import 'element-plus/theme-chalk/el-message.css'
import 'element-plus/theme-chalk/el-message-box.css'

// ── 域注册（域名 side-effect import 触发 registerDomain）──────────────────────
import './domains/settings/domain'

import App from './App.vue'
import router from './router'
import { APP_ICONS } from './utils/appIcons'
import { useAppStore } from './stores/appStore'
import { applyPref, readMirror, readColorMirror, applyColor, watchSystem, THEME_PREF_META_KEY } from './utils/theme'
import * as db from './utils/database'
import { bootStep } from './utils/bootSplash'
import { installErrorBoundaries } from './utils/errorBoundary'

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

  // 主题：meta 表是权威（随 .mbak 备份走），localStorage 只是首帧镜像。
  // theme-init.js 已在首帧按镜像设过一次，这里用权威值校正（含换机导入备份的场景）。
  // watchSystem() 让"跟随系统"模式在系统切换深浅时自动跟随。
  applyPref(db.getMeta(THEME_PREF_META_KEY) || readMirror())
  applyColor(readColorMirror())
  watchSystem()

  /**
   * 错误边界：让运行期异常变成"一条提示 + 一行日志"，而不是一块白屏。
   *
   * 必须在 mount 之前装好 —— 首帧渲染就抛错的组件同样要被接住（那正是最像
   * "软件打开就坏了"的一种）。addLog 用闭包延迟取用：store 此刻已就绪，
   * 但写成闭包可以让"日志层自己出问题"不会变成 install 阶段的失败。
   */
  installErrorBoundaries(app, {
    router,
    log: (entry, options) => store.addLog(entry, options)
  })

  // 挂载后 #app 内的启动闪屏被 Vue 整体替换，无需手动清理
  bootStep('正在加载界面…')
  app.mount('#app')
}

bootstrap()
