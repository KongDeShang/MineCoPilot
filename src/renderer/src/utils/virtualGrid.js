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

  // 渲染出来的卡片换了就重量一次（量稳后 measureDom 内部会早退）
  if (itemSelector) {
    watch(visibleItems, () => nextTick(measureDom), { flush: 'post' })
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
      nextTick(measureDom)
    })
    resizeObserver.observe(el)

    // 初始化尺寸
    if (el.clientWidth > 0) containerWidth.value = el.clientWidth
    if (el.clientHeight > 0) containerHeight.value = el.clientHeight
    nextTick(measureDom)
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
    /** 手动重置（数据量变化后调用） */
    reset() {
      scrollTop.value = 0
      if (containerRef.value) containerRef.value.scrollTop = 0
    },
    /** 清理 */
    destroy: cleanup
  }
}
