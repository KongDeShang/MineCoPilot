/**
 * 入场动效工具
 *
 * ## 这个文件解决什么
 *
 * `main.js:34` 在 `app.mount()` **之前** `await store.initStore()`，好处是首屏不会
 * 闪一下空数据 —— 那条注释写明了是有意为之，所以不去动它。代价是：首帧渲染时数据
 * 已经是终值，各页写好的 `.xxx-fill { transition: width .6s }` 一次都不会播放。
 *
 * CSS transition 需要"值发生变化"才触发，而值从头到尾没变过。全站这几处增长动画
 * 因此全是死代码：
 *   Dashboard   .hd-seg / .trend-bar / .brand-bar-fill / .fault-bar
 *   Equipment   .equip-healthbar-fill
 *   DeviceRecords .rp-factor-fill
 *   FaultCases  .fault-bar
 * 另外 Dashboard 的设备状态饼（.pie-arc）与复诊闭环圆弧（.closing-arc）走同一套
 * 两阶段入场：SVG 的 stroke-dasharray 从"零长度"补到实际弧度。
 *
 * 注意 Equipment 的 `.health-ring` 不是进度环，是"档位计数"的彩色描边圈
 * （优/良/预警/严重各多少台），本来就没有比例可言 —— 别把它改成圆弧。
 *
 * 解法是在组件侧做"两阶段"：首帧先按 0 渲染，等浏览器**真的画过一帧**之后，
 * 再翻成真实值，已有的 transition 就自然播起来了。
 *
 * 为什么不用 GSAP 直接动画宽度：这些终值是以百分比写在模板里的，窗口一缩放就
 * 自适应。用 JS 把宽度补间成 px 会把这个性质弄丢。GSAP 只用在它真正划算的地方
 * （数字滚动、SVG 描边生长），CSS 负责它本来就能做好的部分。
 */

import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * 系统是否要求"减少动效"。
 *
 * `tokens.css` 里那条 `@media (prefers-reduced-motion: reduce)` 全局兜底只压得住
 * CSS 动画与过渡 —— **GSAP 是 JS 驱动的，它拦不住**。所以凡是用 GSAP 的地方都必须
 * 单独问一次这个函数，不能指望那条兜底。
 *
 * @returns {boolean}
 */
export function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * 入场开关：首帧 0，绘制过一帧之后翻成 1。
 *
 * 必须连等**两帧**：`onMounted` 在首次绘制之前执行，此时把值改成 1，浏览器只会
 * 画一次「终值」—— 仍然没有起点，transition 照样不播。第二个 rAF 的回调排在
 * 第一帧的绘制之后，从这里翻值才保证「0 已经被画出来过」。
 *
 * 用法：`:style="{ width: (entered ? seg.pct : 0) + '%' }"`
 *
 * @param {number} delayMs 同一页里想让多组元素错开时用
 * @returns {import('vue').Ref<boolean>}
 */
export function useEnter(delayMs = 0) {
  const entered = ref(false)
  let raf1 = 0
  let raf2 = 0
  let timer = 0

  onMounted(() => {
    // 减少动效时直接落到终值：这里如果也走两阶段，用户会先看到一排 0
    if (prefersReducedMotion()) {
      entered.value = true
      return
    }
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (delayMs > 0) {
          timer = setTimeout(() => { entered.value = true }, delayMs)
        } else {
          entered.value = true
        }
      })
    })
  })

  onBeforeUnmount(() => {
    cancelAnimationFrame(raf1)
    cancelAnimationFrame(raf2)
    clearTimeout(timer)
  })

  return entered
}

/**
 * 数字滚动。
 *
 * 不用 GSAP 的 innerText 补间（那会逐帧改 DOM 文本），而是补间一个普通对象、
 * 再把取整结果写进 ref —— 这样调用方拿到的始终是整数，不会渲染出 17.2847。
 *
 * @param {number} from 起始值
 * @param {number} to 目标值
 * @param {number} durationSec 时长（秒）
 * @param {(v:number)=>void} onUpdate 每帧回调（已取整）
 * @returns {gsap.core.Tween|null} 调用方负责 kill
 */
export function tweenNumber(from, to, durationSec, onUpdate) {
  // 动态 import 让 gsap 不进主 chunk —— 首屏用不到它
  return import('gsap').then(({ default: gsap }) => {
    if (prefersReducedMotion()) {
      onUpdate(to)
      return null
    }
    const proxy = { v: from }
    return gsap.to(proxy, {
      v: to,
      duration: durationSec,
      ease: 'power2.out',
      onUpdate: () => onUpdate(Math.round(proxy.v))
    })
  })
}
