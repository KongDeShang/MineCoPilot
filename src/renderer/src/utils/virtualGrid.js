/**
 * 卡片网格虚拟滚动
 *
 * 当设备量 >100 时，DOM 节点过多导致滚动卡顿。
 * 本工具只渲染可见行的卡片，通过 paddingTop/paddingBottom 占位保持滚动条位置。
 *
 * 用法（Vue 3 Composition API）：
 *   const { visibleItems, containerProps, wrapperStyle } = useVirtualGrid({
 *     items: filteredEquipment,
 *     cardHeight: 280,    // 每张卡片高度
 *     cardMinWidth: 280,  // 卡片最小宽度（与 CSS flex-basis 一致）
 *     gap: 16,            // 网格间距
 *     overscan: 2         // 额外渲染上下各 2 行
 *   })
 *
 * 模板：
 *   <div v-bind="containerProps" class="equip-grid">
 *     <div :style="wrapperStyle" class="virtual-grid-inner">
 *       <div v-for="eq in visibleItems" :key="eq.id" class="equip-card">...</div>
 *     </div>
 *   </div>
 */
import { ref, computed } from 'vue'

export function useVirtualGrid(options) {
  const {
    items,
    cardHeight = 280,
    cardMinWidth = 280,
    gap = 16,
    overscan = 2
  } = options

  const containerRef = ref(null)
  const scrollTop = ref(0)
  const containerWidth = ref(1200) // 默认宽度，挂载后更新
  const containerHeight = ref(600)

  // 每行卡片数
  const colsPerRow = computed(() => {
    const w = containerWidth.value
    return Math.max(1, Math.floor((w + gap) / (cardMinWidth + gap)))
  })

  // 总行数
  const totalRows = computed(() => Math.ceil((items.value?.length || 0) / colsPerRow.value))

  // 可见行范围
  const visibleRange = computed(() => {
    const rowHeight = cardHeight + gap
    const startRow = Math.max(0, Math.floor(scrollTop.value / rowHeight) - overscan)
    const visibleRows = Math.ceil(containerHeight.value / rowHeight)
    const endRow = Math.min(totalRows.value, startRow + visibleRows + overscan * 2)
    return { startRow, endRow }
  })

  // 可见卡片
  const visibleItems = computed(() => {
    const all = items.value || []
    const { startRow, endRow } = visibleRange.value
    const cols = colsPerRow.value
    const startIdx = startRow * cols
    const endIdx = endRow * cols
    return all.slice(startIdx, endIdx)
  })

  // 占位样式
  const wrapperStyle = computed(() => {
    const { startRow, endRow } = visibleRange.value
    const rowHeight = cardHeight + gap
    const paddingTop = startRow * rowHeight
    const paddingBottom = Math.max(0, (totalRows.value - endRow) * rowHeight)
    return {
      paddingTop: `${paddingTop}px`,
      paddingBottom: `${paddingBottom}px`
    }
  })

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

  function setup(el) {
    containerRef.value = el
    if (!el) return

    el.addEventListener('scroll', onScroll, { passive: true })

    resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        containerWidth.value = entry.contentRect.width
        containerHeight.value = entry.contentRect.height
      }
    })
    resizeObserver.observe(el)

    // 初始化尺寸
    containerWidth.value = el.clientWidth
    containerHeight.value = el.clientHeight
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

  // containerProps 用于 v-bind 绑定到容器元素
  const containerProps = computed(() => ({
    ref: (el) => {
      if (el) setup(el)
    },
    style: { overflow: 'auto', position: 'relative' }
  }))

  return {
    visibleItems,
    containerProps,
    wrapperStyle,
    colsPerRow,
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
