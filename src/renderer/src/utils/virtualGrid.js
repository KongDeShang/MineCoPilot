/**
 * 卡片网格虚拟滚动
 *
 * 只渲染可见行的卡片，用上下占位保持滚动条位置。
 *
 * ⚠️ 占位必须加在**内层包裹元素**上，不能加在滚动容器上。
 *    容器带 max-height，而全局 CSS 是 box-sizing: border-box —— padding 一旦超过
 *    max-height，按 CSS 规范内容盒会被压成 0、元素高度反而等于 padding，max-height 直接失效；
 *    何况 ResizeObserver 的 contentRect 本来就不含 padding，"可视高"会恒为 0。
 *    （2026-09-25 修：这两条叠加 ⇒ 容器被撑成 4736px 且只渲染 overscan 那 4 行，
 *     60 台设备里只看得见 12 台，往下滚全是空白。）
 *
 * ⚠️ 滚动位置**以 DOM 为准**：容器的 scrollTop 会在不派发 scroll 事件的情况下变
 *    （虚拟滚动关掉又打开时，浏览器会撤掉/恢复那个偏移），所以除了监听 scroll，
 *    每次渲染后还要对齐一次（applyScrollTop）—— 只靠事件会让渲染窗口落在看不见的地方，
 *    屏幕上就是一片空白。
 *
 * 行高/列数默认按 cardHeight/cardMinWidth 推算；传了 itemSelector 则从真实 DOM 量，
 * 免得 CSS 一改（卡片变高、flex-basis 变化）占位就与实际错位、最后几行滚不到。
 *
 * 用法（Vue 3 Composition API）：
 *   const { visibleItems, wrapperStyle, bind } = useVirtualGrid({
 *     items: filteredEquipment,
 *     cardHeight: 280,             // 卡片高度估计值（仅在还没量到真实高度前使用）
 *     cardMinWidth: 300,           // 卡片最小宽度（与 CSS flex-basis 一致）
 *     gap: 16,                     // 网格间距
 *     overscan: 2,                 // 额外渲染上下各 2 行
 *     itemSelector: '.equip-card'  // 卡片选择器：给了就从 DOM 量真实行高与列数
 *   })
 *
 * 模板（容器只负责滚，内层负责占位）：
 *   <div ref="gridContainerRef" class="equip-grid" :class="{ 'virtual-scroll': useVirtual }">
 *     <div :style="useVirtual ? wrapperStyle : undefined" class="equip-grid-inner">
 *       <div v-for="eq in visibleItems" :key="eq.id" class="equip-card">...</div>
 *     </div>
 *   </div>
 */
import { ref, computed, nextTick, watch } from 'vue'

export function useVirtualGrid(options) {
  const {
    items,
    cardHeight = 280,
    cardMinWidth = 280,
    gap = 16,
    overscan = 2,
    itemSelector = null
  } = options

  const containerRef = ref(null)
  const scrollTop = ref(0)
  const containerWidth = ref(1200) // 默认宽度，挂载后更新
  const containerHeight = ref(600)

  // reset() 的意图还没兑现（容器当时不可滚，写入被浏览器忽略），见 applyScrollTop
  let pendingReset = false

  // 从真实 DOM 量到的几何；量到之前用 cardHeight/cardMinWidth 推算
  const measured = ref(null)

  // 每行卡片数（推算值，也是没量到真实值前的兜底）
  const colsPerRow = computed(() => {
    const w = containerWidth.value
    return Math.max(1, Math.floor((w + gap) / (cardMinWidth + gap)))
  })

  const cols = computed(() => (measured.value && measured.value.cols) || colsPerRow.value)
  const rowHeight = computed(() => (measured.value && measured.value.rowHeight) || cardHeight + gap)

  // 总行数
  const totalRows = computed(() => Math.ceil((items.value?.length || 0) / cols.value))

  // 可见行范围
  const visibleRange = computed(() => {
    const h = rowHeight.value
    const startRow = Math.max(0, Math.floor(scrollTop.value / h) - overscan)
    const visibleRows = Math.ceil(containerHeight.value / h)
    const endRow = Math.min(totalRows.value, startRow + visibleRows + overscan * 2)
    return { startRow, endRow }
  })

  // 可见卡片（按整行切：首行必须是完整一行，否则量出来的列数是错的）
  const visibleItems = computed(() => {
    const all = items.value || []
    const { startRow, endRow } = visibleRange.value
    const c = cols.value
    return all.slice(startRow * c, endRow * c)
  })

  // 占位样式：加在**内层**包裹元素上（见文件头说明）
  const wrapperStyle = computed(() => {
    const { startRow, endRow } = visibleRange.value
    const h = rowHeight.value
    return {
      paddingTop: `${startRow * h}px`,
      paddingBottom: `${Math.max(0, (totalRows.value - endRow) * h)}px`
    }
  })

  /**
   * 从真实 DOM 量行高与列数。
   * 只在量到的值与当前用的不同时才写回 —— 否则"量→渲染→再量"会来回抖。
   */
  function measureDom() {
    const el = containerRef.value
    if (!el || !itemSelector) return
    const nodes = el.querySelectorAll(itemSelector)
    if (!nodes.length) return
    const first = nodes[0].getBoundingClientRect()
    if (!first.height) return
    let c = 0
    for (const n of nodes) {
      if (Math.abs(n.getBoundingClientRect().top - first.top) < 1) c++
    }
    const h = Math.round(first.height) + gap
    if (c < 1 || h <= gap) return
    const prev = measured.value
    if (prev && prev.cols === c && prev.rowHeight === h) return
    measured.value = { cols: c, rowHeight: h }
  }

  /**
   * 把容器的滚动位置与组件里的 scrollTop 对齐（组件里的值是"意图"，DOM 是执行）。
   *
   * 为什么不能只靠 scroll 事件：容器的滚动位置会在**不派发 scroll 事件**的情况下变。
   * 实测（2026-09-26，探针 `node_modules/.probe/stale-scroll2.mjs` 带插桩）：滚到台账深处
   * → 搜索到 ≤50 台（`max-height` 撤掉、容器不再可滚）→ 清空搜索（`max-height` 回来）时，
   * 浏览器把容器恢复成 5659px，而**清空之后一条 scroll 事件都没有**（事件流水里只有我们
   * 自己滚下去时那两条）—— 组件里的 scrollTop 还停在 reset() 写的 0，于是只渲染最前 6 行、
   * 占位 padding 全在下方，18 张卡全在视口**上方** 5393px 处，屏幕上就是一片空白。
   *
   * 两条规矩：
   *   ① reset() 的意图优先，但得**等容器能滚了再兑现** —— 容器不可滚时浏览器会忽略
   *      对 scrollTop 的写入，那一刻写一次等于没写（所以有 pendingReset 跨过这段时间）。
   *   ② 其余情况以 DOM 为准：渲染窗口按 DOM 的真实位置算，最坏是"位置不理想"；
   *      按一个 DOM 兑现不了的 scrollTop 算，就是白屏。
   */
  function applyScrollTop() {
    const el = containerRef.value
    if (!el || el.scrollHeight <= el.clientHeight) return // 没得滚：写了也会被忽略，等能滚了再来
    if (pendingReset) {
      el.scrollTop = scrollTop.value
      pendingReset = false
    }
    if (Math.abs(el.scrollTop - scrollTop.value) > 1) scrollTop.value = el.scrollTop
  }

  /** 渲染之后要做的事：量几何 + 对齐滚动位置（两件都要求节点已经在 DOM 里） */
  function syncAfterRender() {
    measureDom()
    applyScrollTop()
  }

  // 渲染出来的卡片换了就重量一次（量稳后 measureDom 内部会早退）
  if (itemSelector) {
    watch(visibleItems, () => nextTick(syncAfterRender), { flush: 'post' })
  }

  // 滚动事件处理
  let raf = null
  function onScroll() {
    if (raf) cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => {
      if (containerRef.value) {
        scrollTop.value = containerRef.value.scrollTop
      }
    })
  }

  // ResizeObserver 监听容器尺寸
  let resizeObserver = null

  /**
   * 绑定滚动容器。
   * 用 bind(el) 而不是 v-bind="containerProps"：容器需要的是**事件与观测**，
   * 不是一组能 v-bind 的 props（原来那个 containerProps 没人 v-bind，
   * 消费方只借它调了一次 .ref()，等于绕开契约走偏门 —— 这次缺陷就出在这条偏门上）。
   */
  function bind(el) {
    cleanup() // 重复绑定（例如虚拟开关切换）时先摘掉旧的监听与观测，别叠加
    containerRef.value = el
    if (!el) return

    el.addEventListener('scroll', onScroll, { passive: true })

    resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        const w = entry.target.clientWidth
        const h = entry.target.clientHeight
        if (w > 0) containerWidth.value = w
        if (h > 0) containerHeight.value = h // 元素隐藏时别把它记成 0，否则会只渲染 overscan 那几行
      }
      nextTick(syncAfterRender)
    })
    resizeObserver.observe(el)

    // 初始化尺寸
    if (el.clientWidth > 0) containerWidth.value = el.clientWidth
    if (el.clientHeight > 0) containerHeight.value = el.clientHeight
    nextTick(syncAfterRender)
  }

  function cleanup() {
    if (containerRef.value) {
      containerRef.value.removeEventListener('scroll', onScroll)
    }
    if (resizeObserver) {
      resizeObserver.disconnect()
      resizeObserver = null
    }
    if (raf) cancelAnimationFrame(raf)
  }

  return {
    visibleItems,
    wrapperStyle,
    bind,
    colsPerRow,
    cols,
    rowHeight,
    totalRows,
    visibleRange,
    /**
     * 手动重置（数据量变化后调用）。
     * 容器**不可滚**时（例如搜索把列表筛到 50 台以下、`max-height` 正在撤掉/回来）浏览器会
     * 忽略这次写入，所以除了当场写一次，还要立一个 pendingReset 让它在容器能滚之后再兑现。
     */
    reset() {
      scrollTop.value = 0
      pendingReset = true
      if (containerRef.value) containerRef.value.scrollTop = 0
      nextTick(applyScrollTop)
    },
    /** 清理 */
    destroy: cleanup
  }
}
