/**
 * 矿山智工 · 首帧主题初始化（同步脚本，非 module）
 *
 * ## 为什么必须是一个独立文件、且在 <head> 里同步执行
 *
 * 主题偏好（深色）写在 IndexedDB 的 meta 表里，而 IndexedDB 读取是异步的，
 * Vue bootstrap 拿到它之前，页面会用默认浅色渲染 —— 深色用户每次启动
 * 都会先闪一帧白。要消灭这一帧，只能在做任何渲染之前就定下 `data-theme`。
 *
 * CSP（script-src 'self'，见 src/main/index.js）禁止内联脚本，所以这个脚本
 * 必须是一个**真实文件**（<script src>），由 Vite 从 public/ 复制到构建产物。
 * 它只读同步的 localStorage 镜像（真正的权威在 meta 表，main.js bootstrap
 * 启动后会读 meta 再校正一次并回写镜像，见 utils/theme.js 注释）。
 *
 * 命名空间避开全局污染：`window.__ksThemeInit` 只写属性，不定义全局变量。
 */
(function () {
  try {
    var pref = null
    try { pref = localStorage.getItem('ks:theme') } catch (e) { /* 隐私模式 */ }
    var mode = 'light'
    if (pref === 'light' || pref === 'dark') {
      mode = pref
    } else {
      // 无偏好（新装）或 system：跟随系统，避免新装用户打开就是白底
      mode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }
    var root = document.documentElement
    root.setAttribute('data-theme', mode)
    if (mode === 'dark') root.classList.add('dark')
  } catch (e) {
    // 任何异常都不许挡住应用启动；最坏情况是闪一帧白，bootstrap 会再校正
  }
})()
