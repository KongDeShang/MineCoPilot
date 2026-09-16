/**
 * 主题偏好与切换（浅色 / 深色 / 跟随系统）+ 色彩主题变体
 *
 * ## 两条存储路径，各司其职
 *
 * - **meta 表（权威）**：`theme_pref` 随 .mbak 备份一起走，换机导入后偏好不丢。
 * - **localStorage（镜像）**：`ks:theme`。唯一作用是让 `index.html` 里的
 *   `theme-init.js`（CSP 下唯一允许的同步脚本，见该文件注释）能在**首帧前**
 *   同步拿到偏好、直接写 `data-theme` —— 否则深色偏好用户每次启动都会闪一帧白。
 *
 * 数据流：
 *   theme-init.js（同步，localStorage）→ 首帧即正确主题
 *   main.js bootstrap（async，meta 权威）→ 修正/同步镜像 → mount（无闪烁）
 *   Settings.vue 改偏好 → 写 meta + localStorage + applyTheme + 存镜像
 *
 * ## 为什么有 'system'
 *
 * 矿场演示大多是白天开灯环境（浅色），但晚上答辩/报告可能关灯（系统切深色）。
 * 提供"跟随系统"是为了不强制用户二选一：系统切了它自己跟着切。
 */
export const THEME_PREF_META_KEY = 'theme_pref'
export const THEME_PREF_MIRROR_KEY = 'ks:theme'
export const COLOR_PREF_MIRROR_KEY = 'ks:color'
export const THEME_MODES = ['light', 'dark', 'system']

/** 色彩主题定义：name → { label, accent, signal } */
export const COLOR_THEMES = {
  blue:   { label: '默认蓝', accent: '#0b3a82', signal: '#0bb4c4' },
  green:  { label: '工程绿', accent: '#1a6b3c', signal: '#2ecc71' },
  orange: { label: '矿石橙', accent: '#a0522d', signal: '#f39c12' },
  red:    { label: '警示红', accent: '#8b1a1a', signal: '#e74c3c' }
}

/** 归一化非法值：meta/localStorage 里的脏数据一律回落 system */
export function normalizePref(v) {
  return THEME_MODES.includes(v) ? v : 'system'
}

/** 归一化色彩主题：非法值回落 blue */
export function normalizeColor(v) {
  return (v && v in COLOR_THEMES) ? v : 'blue'
}

/** 偏好 → 实际模式：system 按系统色 */
export function resolveMode(pref) {
  const p = normalizePref(pref)
  if (p !== 'system') return p
  if (typeof window === 'undefined' || !window.matchMedia) return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * 应用一个实际模式到文档：
 * - `<html data-theme="dark|light">`：tokens.css 的深色令牌块挂在这里
 * - `<html class="dark">`：Element Plus 暗色方案（element-plus dark css-vars）
 */
export function applyMode(mode) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.setAttribute('data-theme', mode)
  root.classList.toggle('dark', mode === 'dark')
}

/**
 * 应用色彩主题到文档：
 * - `<html data-color="blue|green|orange|red">`：tokens.css 的色彩变体块挂在这里
 * - blue 为默认色，不写 data-color 属性
 */
export function applyColor(color) {
  if (typeof document === 'undefined') return
  const c = normalizeColor(color)
  const root = document.documentElement
  if (c === 'blue') {
    root.removeAttribute('data-color')
  } else {
    root.setAttribute('data-color', c)
  }
}

/**
 * 应用偏好（写镜像并应用实际模式）。meta 的写入由调用方负责
 * （本模块不 import database，保持纯浏览器工具，便于 theme-init 复用）。
 */
export function applyPref(pref) {
  const p = normalizePref(pref)
  try { localStorage.setItem(THEME_PREF_MIRROR_KEY, p) } catch { /* 隐私模式忽略 */ }
  applyMode(resolveMode(p))
  return p
}

/** 读取镜像（theme-init 与 bootstrap 共用） */
export function readMirror() {
  try { return normalizePref(localStorage.getItem(THEME_PREF_MIRROR_KEY)) } catch { return 'system' }
}

/** 读取色彩主题镜像 */
export function readColorMirror() {
  try { return normalizeColor(localStorage.getItem(COLOR_PREF_MIRROR_KEY)) } catch { return 'blue' }
}

/** 保存色彩主题到 localStorage 镜像 */
export function saveColorMirror(color) {
  try { localStorage.setItem(COLOR_PREF_MIRROR_KEY, normalizeColor(color)) } catch { /* ignore */ }
}

const MQ = '(prefers-color-scheme: dark)'

/**
 * 跟随系统监听：只在偏好为 system 时有效。
 * 返回取消函数；组件卸载时应调用（见 App.vue / Settings.vue）。
 */
export function watchSystem(onChange) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const mq = window.matchMedia(MQ)
  const handler = (e) => {
    // 当前偏好是 system 才跟着切；用户手动选了浅/深则忽略系统变化
    if (readMirror() === 'system') applyMode(e.matches ? 'dark' : 'light')
    if (typeof onChange === 'function') onChange(e)
  }
  // 老版 Safari 只有 addListener
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', handler)
  else mq.addListener(handler)
  return () => {
    if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', handler)
    else mq.removeListener(handler)
  }
}
