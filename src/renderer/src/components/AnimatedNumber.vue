<template>{{ shown }}</template>

<script setup>
/**
 * 会滚动的数字
 *
 * 全站 KPI 大数字原来是直接渲染终值的（Dashboard 统计卡、AlertCenter / PartsInventory
 * 的仪表块、落地页底部三个行业数字）。数据在 `store.initStore()` 里就绪、挂载时已是
 * 终值，所以看起来像一张静态截图 —— 这是"静态感"最大的单一来源。
 *
 * 只负责把一个整数滚到另一个整数：外面包着的元素怎么排版、字号多少、什么颜色，
 * 全部由使用方原有的 class 决定，所以替换掉一段 `{{ n }}` 不会动到任何布局。
 *
 * 用 `value` 而不是 `text`：调用方传进来的都是算好的数字，不接受字符串，
 * 避免把 "60 台" 这种带单位的文本塞进来之后补间失败。
 */
import { onBeforeUnmount, ref, watch } from 'vue'
import { prefersReducedMotion, useEnter, tweenNumber } from '../utils/motion'

const props = defineProps({
  /** 目标整数 */
  value: { type: Number, default: 0 },
  /** 时长（秒） */
  duration: { type: Number, default: 0.9 }
})

// 系统要求减少动效时，**初值就必须是终值**。
//
// 只让 tweenNumber 内部走"直接跳到终值"那条分支是不够的：gsap 是动态 import
// 拿到的，写回终值最早也要等一个微任务之后，而那时首帧已经画出来了 ——
// 用户看到的是一排 0 然后突然跳成真实数字，比不动画更糟。
// 所以这里在**构造时**就把初值定死，并且彻底不去 import gsap。
const reduced = prefersReducedMotion()

const shown = ref(reduced ? props.value : 0)
const entered = useEnter()

let tween = null
// 补间是异步拿到的（gsap 走动态 import），用一个序号保证只有最新一次能写回 DOM，
// 否则快速连续变更时先发起的那次可能后到达，把数字改回旧值
let seq = 0

function run(from, to) {
  if (reduced) {
    shown.value = to
    return
  }
  const mine = ++seq
  tween?.kill?.()
  tween = null
  tweenNumber(from, to, props.duration, (v) => {
    if (mine === seq) shown.value = v
  }).then((t) => {
    if (mine === seq) tween = t
    else t?.kill?.()
  })
}

// 首次入场：等首帧真的画过之后再滚，和同屏那些 .xxx-fill 的增长同一个节拍
watch(entered, (ok) => {
  if (ok) run(0, props.value)
})

// 之后数据变了（重置演示数据、导入台账）从当前值接着滚，不要跳回 0 再滚一遍
watch(
  () => props.value,
  (to, from) => {
    if (entered.value) run(typeof from === 'number' ? from : 0, to)
  }
)

onBeforeUnmount(() => {
  seq += 1
  tween?.kill?.()
})
</script>
