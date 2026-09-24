/**
 * 评委引导演示（driver.js）· 路线解析器 + 播放器
 *
 * ## 为什么需要它
 *
 * 这套工具有 15 个页面，5 分钟里评委不可能自己摸清主线；演示的人也很容易
 * 在某个页面上讲超时。把"该看什么"固化成**多条可重复播放的路线**，等于给演示
 * 上了一道保险：谁按这个按钮，都是同一条叙事、同一个节奏。
 *
 * ## 三个刻意的设计
 *
 * 1) **整条路线跨路由**，所以每一步都带 `route`。切页之后元素不是立刻就有
 *    （路由有 `fade-slide` 过渡，而且是 out-in 模式：旧页先走、新页才来），
 *    所以先 `waitFor` 按配置等待渲染，再轮询等元素出现，**等不到就跳过这一步**
 *    而不是抛错 —— 演示途中弹一个错误框，比少讲一页糟糕得多。
 *
 * 2) **driver.js 与它的样式表都在这里动态 import**。原因有两层：
 *    - 体积：没人点"引导演示"的时候不该付这份下载；
 *    - 更要紧的是，`scripts/self-check.mjs` 会把 utils 下的模块真在 Node 里
 *      import 一遍做静态检查。顶层 `import 'driver.js/dist/driver.css'` 会让
 *      Node 去解析一个 .css 文件，直接让整个 verify 挂掉。
 *      放在函数里就绕开了 —— 这条路走通过一次，别再搬回顶层。
 *
 * 3) 文案写的是**"这台设备/这条数据"能看出什么**，不是"这个按钮能点"。
 *    评委关心的是结论，操作说明留在演示脚本里。
 *
 * 路线配置见 utils/demoRoutes/（main / ai-line / big-screen），纯 JSON 结构，
 * 改文案、加步骤不需要动播放器。
 */

// 静态引入路线注册表（App.vue 同源使用，动态 import 不会拆 chunk 反而多一次往返）。
// demoRoutes 是纯 JSON 结构，Node 自检（self-check.mjs 镜像 import）可安全解析。
import { getDemoRoute } from './demoRoutes'

/** 一步的等待上限。超过就跳过 —— 宁可少一步，不要卡住。 */
const STEP_TIMEOUT_MS = 2500

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 系统是否要求减弱动效。
 *
 * **不从 utils/motion 里 import 现成的 `prefersReducedMotion`**，尽管那边有一个：
 * demoTour 被 `scripts/self-check.mjs` 镜像进 Node 真实导入，而 motion.js 不在
 * 那份镜像清单里 —— 一旦 import，Node 会 ERR_MODULE_NOT_FOUND，整个 verify
 * 链路的第一个环节就断。为了两行判断去扩镜像清单不划算，就地写掉。
 */
function prefersReducedMotion() {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 读一个 CSS 变量的值。变量的定义在 styles/tokens.css 的 :root 上。 */
function token(name, fallback) {
  if (typeof document === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/**
 * 轮询等元素出现。
 * @returns {Promise<Element|null>} 超时返回 null，调用方据此跳过该步
 */
async function waitFor(selector, timeoutMs = STEP_TIMEOUT_MS) {
  if (!selector) return null
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const el = document.querySelector(selector)
    if (el) return el
    await sleep(80)
  }
  return null
}

/** 把 JSON 路线步骤转成 driver.js 的 step 结构（element + popover） */
function toDriverSteps(steps) {
  return steps.map((s) => ({
    element: s.target || undefined,
    popover: { title: s.title, description: s.content }
  }))
}

/**
 * 启动引导演示。
 *
 * @param {import('vue-router').Router} router 用于步骤之间切页
 * @param {string} [routeId] 路线 id（缺省主线）
 * @param {{ auto?: boolean, onState?: (s: object|null) => void }} opts
 *        auto: 自动演示（每步停留后自动前进）；onState: 进度回调
 *        { routeName, step, total, paused, playing }，null 表示演示已结束/关闭
 * @returns {Promise<{ok:boolean, reason?:string, api?:object}>}
 *        api: { next, prev, togglePause, reset, destroy, getState }
 */
export async function startTour(router, routeId, { auto = false, onState } = {}) {
  if (typeof document === 'undefined') return { ok: false, reason: '当前环境不支持引导演示' }

  // 路线注册表（纯 JSON，Node 自检可安全 import）
  const route = getDemoRoute(routeId)
  if (!route.steps || route.steps.length === 0) {
    return { ok: false, reason: `路线「${route.name}」暂无可播放步骤` }
  }

  // 动态引入 driver.js 与样式（见文件头说明，别搬回顶层）
  await Promise.all([
    import('driver.js'),
    import('driver.js/dist/driver.css')
  ])
  const { driver } = await import('driver.js')

  // 遮罩取项目自己的墨色（--text-1），而不是 driver 默认的纯黑。
  // 纯黑压在浅蓝白的界面上会发灰、发脏，带一点蓝调才是同一套颜色。
  const overlayColor = token('--text-1', '#0a1326')
  // 卡片淡入由 CSS 动画驱动，tokens.css 里那条 prefers-reduced-motion 全局
  // 覆盖本来就能把它压到 0.01ms；这里再显式关掉，是为了连那一下也不闪。
  const animate = !prefersReducedMotion()

  let tour = null
  let index = 0
  let paused = false
  let autoTimer = null

  const state = {
    routeName: route.name,
    step: 0,
    total: route.steps.length,
    playing: auto,
    paused: false
  }
  const emit = () => {
    state.step = Math.min(index + 1, state.total)
    if (typeof onState === 'function') onState({ ...state })
  }
  const clearAuto = () => { if (autoTimer) { clearTimeout(autoTimer); autoTimer = null } }

  /** 自动演示的下一步计时（每步停留 autoAdvanceMs） */
  function scheduleAuto() {
    clearAuto()
    if (!state.playing || paused) return
    const step = route.steps[index] || {}
    const ms = step.autoAdvanceMs || route.autoAdvanceMs || 3000
    autoTimer = setTimeout(() => {
      if (paused || !tour) return
      void goto(index + 1)
    }, ms)
  }

  /**
   * 跳到第 i 步：先切页、等元素，再交给 driver 去高亮。
   *
   * 必须自己接管前进/后退，因为 driver.js 只会在**当前页**找元素；
   * 跨页的步骤得先把路由推过去。
   */
  async function goto(i) {
    if (!tour || i < 0) return
    if (i >= route.steps.length) {
      destroy()
      return
    }
    const step = route.steps[i]
    index = i
    emit()

    if (step.route && router.currentRoute.value.path !== step.route) {
      await router.push(step.route)
      if (step.waitFor) await sleep(step.waitFor)
      const el = await waitFor(step.target)
      if (step.target && !el) {
        console.warn(`[引导演示] 找不到元素「${step.target}」，跳过第 ${i + 1} 步`)
        return goto(i + 1)
      }
      // 再等一小会儿：路由是 out-in 的 fade-slide，元素刚出现时位置还在动，
      // 这时候高亮，框会套在一个正在滑动的元素上。
      await sleep(180)
    } else if (step.target) {
      const el = await waitFor(step.target)
      if (!el) {
        console.warn(`[引导演示] 找不到元素「${step.target}」，跳过第 ${i + 1} 步`)
        return goto(i + 1)
      }
      await sleep(120)
    }

    tour.moveTo(i)
    scheduleAuto()
  }

  function destroy() {
    clearAuto()
    if (tour) { tour.destroy(); tour = null }
    if (typeof onState === 'function') onState(null)
  }

  tour = driver({
    steps: toDriverSteps(route.steps),
    showProgress: true,
    progressText: '{{current}} / {{total}}',
    nextBtnText: '下一步',
    prevBtnText: '上一步',
    doneBtnText: '完成',
    // 点遮罩即关闭：演示被打断时不用去找那个 ×
    allowClose: true,
    overlayColor,
    overlayOpacity: 0.55,
    animate,
    // 高亮元素周围留一点呼吸，别贴边
    stagePadding: 8,
    stageRadius: 12,
    // 兜底：万一某页的元素没能出现（数据为空、面板折叠），
    // 让 driver 自己跳过这一步，而不是停在那里报"找不到元素"。
    // 注意它对"压根没写 element"的开场/收尾卡不生效 —— 那两步照常显示。
    skipMissingElement: true,
    waitForElement: 1500,
    // 提供 onNextClick / onPrevClick 之后，driver.js 就不再自动前进，
    // 改由上面的 goto() 决定何时 moveTo。opts 里带着 driver 和当前下标，
    // 比自己在外面记一份副本可靠。
    onNextClick: (_el, _step, opts) => { void goto(opts.index + 1) },
    onPrevClick: (_el, _step, opts) => { void goto(opts.index - 1) },
    onDestroyed: () => {
      clearAuto()
      if (typeof onState === 'function') onState(null)
    }
  })

  const api = {
    /** 手动下一步 */
    next: () => { clearAuto(); void goto(index + 1) },
    /** 手动上一步 */
    prev: () => { clearAuto(); void goto(index - 1) },
    /** 暂停 / 继续自动演示 */
    togglePause() {
      paused = !paused
      state.paused = paused
      emit()
      if (!paused) scheduleAuto()
    },
    /**
     * 从手动模式切到自动演示（工具条上的 ▶）。
     *
     * 默认是手动（`auto:false`，逐步点「下一步」），所以需要一条回头路：讲超时了
     * 想让它自己走，按一下就从当前这步开始自动。已在自动模式时是空操作 ——
     * 那种情况该用 togglePause。
     */
    startAuto() {
      if (state.playing) return
      state.playing = true
      paused = false
      state.paused = false
      emit()
      scheduleAuto()
    },
    /** 重置到第一步 */
    reset: () => { clearAuto(); void goto(0) },
    /** 退出演示 */
    destroy,
    getState: () => ({ ...state })
  }

  state.playing = auto
  state.paused = paused
  await goto(0)
  return { ok: true, route, api }
}
