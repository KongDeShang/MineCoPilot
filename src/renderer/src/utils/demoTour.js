/**
 * 评委引导演示（driver.js）
 *
 * ## 为什么需要它
 *
 * 这套工具有 15 个页面，5 分钟里评委不可能自己摸清主线；演示的人也很容易
 * 在某个页面上讲超时。把"该看什么"固化成一条可重复播放的路线，等于给演示
 * 上了一道保险：谁按这个按钮，都是同一条叙事、同一个节奏。
 *
 * ## 三个刻意的设计
 *
 * 1) **整条路线跨路由**，所以每一步都带 `route`。切页之后元素不是立刻就有
 *    （路由有 `fade-slide` 过渡，而且是 out-in 模式：旧页先走、新页才来），
 *    所以用 `waitFor` 轮询等元素出现，**等不到就跳过这一步**而不是抛错 ——
 *    演示途中弹一个错误框，比少讲一页糟糕得多。
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
 */

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

/**
 * 演示路线。
 *
 * `element` 为空表示"不指向具体元素"的整屏说明卡（开场 / 收尾）。
 * `route` 为空表示沿用上一步所在页面。
 *
 * ⚠️ **title / description 必须写在 `popover` 里面。**
 *    driver.js 1.8 读的是 `step.popover.title`（源码 `let r = n.popover || {}`
 *    之后取 `r.title`），不是 `step.title`。平铺着写**不会报错**：卡片照样弹、
 *    高亮照样准、进度照样走，只是标题和正文两个元素都被 `display:none` 掉，
 *    屏幕上只剩一排「上一步 / 下一步」的空框。
 *    这个坑是真踩过的 —— 整条路线跑通了 10 步高亮全对，才发现每张卡都是空的。
 *    改这里之后，`.tmp-materials/tour-probe.mjs` 会把每步的标题打出来核对。
 *
 * ⚠️ 改这里的顺序或增删步骤时，记得 `docs/演示脚本.md` 也要跟着改口径 ——
 *    两边讲的东西不一样，演示的人就会在台上被自己的稿子绊倒。
 */
export const TOUR_STEPS = [
  {
    popover: {
      title: '欢迎：矿山智工 · 设备健康智能体',
      // 刻意**不写步数**。driver.js 自己会在卡片右上角显示 "3 / 12"，
      // 而文案里的数字没人会在增删步骤时想起来改 —— 这里曾经写着"10 步"，
      // 实际上有 12 步，差了整整两步。少一个会过期的数字，少一个坑。
      description:
        '一台离线运行的设备健康工作台。下面按顺序过一遍主线：' +
        '看清今天的账 → 找到最该管的那台设备 → 一路做到复诊闭环。'
    }
  },
  {
    route: '/dashboard',
    element: '.status-strip',
    popover: {
      title: '一屏看清今天的账',
      description:
        '预计停机损失、需立即处置台数、数据是否出本机 —— 三个数都在本机算出来，' +
        '鼠标不用点任何地方。'
    }
  },
  {
    route: '/dashboard',
    element: '.focus-card',
    popover: {
      title: '最该管的那几台，自动浮上来',
      description:
        '按健康分升序、只留 D 级与超期 45 天以上的设备，并写明"为什么是它"。' +
        '点任意一张卡片直接进设备画像。'
    }
  },
  {
    route: '/dashboard',
    element: '.pie-chart',
    popover: {
      title: '设备状态分布',
      description:
        '运行 / 维保 / 故障 / 闲置四态实时统计。把鼠标停在图上，看每一段的准确台数。'
    }
  },
  {
    route: '/equipment',
    element: '.equip-grid',
    popover: {
      title: '设备台账：每台一条健康条',
      description:
        '60 台设备的健康分、状态、上次维保时间一眼扫完。健康条按分数长短不同，' +
        '不用逐台点开。'
    }
  },
  {
    route: '/medical-records',
    element: '.record-profile',
    popover: {
      title: '设备病历：分数是怎么算出来的',
      description:
        '四因子（维保及时率、故障频次、机龄、工况）分别打分并给出算式与来源，' +
        '右侧是健康分趋势。结论可追溯到算法，不是一句"AI 认为"。'
    }
  },
  {
    route: '/workorder',
    element: '.workorder .el-radio-group',
    popover: {
      title: '工单状态机',
      description:
        '待派单 → 已派单 → 处理中 → 已完成。非法流转会被拒绝，' +
        '每次流转都留痕，可在操作日志里回放。'
    }
  },
  {
    route: '/ai-assistant',
    element: '.chat-card',
    popover: {
      title: '一句话建单，也能问到手册原文',
      description:
        '用大白话说"3 号挖掘机履带松了"，会给出一张待确认的理解卡，' +
        '确认后才写库 —— 不替用户猜设备。'
    }
  },
  {
    route: '/knowledge-base',
    element: '.kb-table-card',
    popover: {
      title: '回答带页码，可回原文核对',
      description:
        '随包 3 份手册（共 86 页）已提取文字层，检索结果标出命中页码，' +
        '点"查看原文"跳过去对。这是全场唯一不靠"信 AI"的功能。'
    }
  },
  {
    route: '/recheck',
    element: '.stat-cards',
    popover: {
      title: '复诊闭环：处方之后真的复查了吗',
      description:
        '工单完成会自动生成复诊任务（维修 7 天 / 保养 30 天），' +
        '闭环率是本机实算的。多数设备管理软件做到"派单"就结束了。'
    }
  },
  {
    route: '/model-hub',
    element: '.hero',
    popover: {
      title: '断网可用，数据不出本机',
      description:
        '内置 Qwen2.5-0.5B 量化模型在本机推理，全过程零联网、零上传。' +
        '这也是它能进矿区的技术前提。'
    }
  },
  {
    popover: {
      title: '演示结束',
      description:
        '全部数据、算法、模型都在这一台机器上。需要我再走一遍某个环节，' +
        '或者换一条数据推演都可以。'
    }
  }
]

/**
 * 启动引导演示。
 *
 * @param {import('vue-router').Router} router 用于步骤之间切页
 * @returns {Promise<{ok:boolean, reason?:string}>} 失败时给出原因，调用方负责提示
 */
export async function startTour(router) {
  if (typeof document === 'undefined') return { ok: false, reason: '当前环境不支持引导演示' }

  // 动态引入样式：Vite 会把它单独切出来，用到才加载。
  // 顶层静态引入会让 Node 侧的自检去解析 .css 并整个崩掉（见文件头说明）。
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

  /**
   * 跳到第 i 步：先切页、等元素，再交给 driver 去高亮。
   *
   * 必须自己接管前进/后退，因为 driver.js 只会在**当前页**找元素；
   * 跨页的步骤得先把路由推过去。
   */
  async function goto(i) {
    if (!tour || i < 0) return
    if (i >= TOUR_STEPS.length) { tour.destroy(); return }
    const step = TOUR_STEPS[i]

    if (step.route && router.currentRoute.value.path !== step.route) {
      await router.push(step.route)
      await waitFor(step.element)
      // 再等一小会儿：路由是 out-in 的 fade-slide，元素刚出现时位置还在动，
      // 这时候高亮，框会套在一个正在滑动的元素上。
      await sleep(180)
    }
    tour.moveTo(i)
  }

  tour = driver({
    steps: TOUR_STEPS,
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
    onPrevClick: (_el, _step, opts) => { void goto(opts.index - 1) }
  })

  await goto(0)
  return { ok: true }
}
