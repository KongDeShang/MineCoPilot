/**
 * 矿山智工 - 窄屏响应式工具
 *
 * 现状问题：所有表格在窗口窄于约 1200px 时一律回退为横向滚动，
 * 次要信息（创建时间/来源/单价…）把关键信息（标题/状态/闭环）挤出视野。
 * 本模块提供一个组合式函数：窗口宽度跨过断点时给出响应式标志，
 * 各表格据此用 v-if 摘掉次要列 —— 关键列始终可见，次要列让位而不是挤出滚动条。
 *
 * 断点取 1200px 的理由：列宽是按 1440 视口配平的（见 WorkOrder.vue 注释），
 * e2e / 对比度门禁的视口均为 1440 宽，不会触碰此断点，验收不受影响。
 *
 * 注意：此文件会被 store-check 镜像到 Node 下执行，window 访问必须带守卫；
 * onMounted 之外的顶层代码不触碰 window。
 */
import { ref, onMounted, onBeforeUnmount } from 'vue'

/**
 * @param {number} breakpoint 宽度小于该值视为窄屏（默认 1200px）
 * @returns {{ isNarrow: import('vue').Ref<boolean> }}
 */
export function useNarrowMode(breakpoint = 1200) {
  const isNarrow = ref(false)

  const update = () => {
    isNarrow.value = typeof window !== 'undefined' && window.innerWidth < breakpoint
  }

  onMounted(() => {
    update()
    window.addEventListener('resize', update, { passive: true })
  })
  onBeforeUnmount(() => {
    if (typeof window !== 'undefined') window.removeEventListener('resize', update)
  })

  return { isNarrow }
}
