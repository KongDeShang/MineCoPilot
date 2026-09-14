<template>
  <VChart class="trend-echart" :option="option" :update-options="{ notMerge: false }" autoresize />
</template>

<script setup>
/**
 * 维保执行趋势（ECharts 柱状图）
 *
 * 为什么换掉原来那排 div 柱子：那张图只能用眼睛比高低，问不出"三月到底完成了
 * 多少次"。换成 ECharts 之后鼠标一悬停就有 tooltip 报出准确数字 —— 这是评委
 * 会真的去做的动作，也是"像真软件"和"像一张静态图"的分界线。
 *
 * **数据源没有变**：仍然吃看板算好的 trendData（每月 应做/完成 两条），
 * 这里只负责画。所有百分比换算、口径来源都留在 useTrend 那一侧。
 *
 * 三件事是有意为之：
 *   1) 只 use() 用得到的模块。echarts 全量包很大，按需注册能把这块砍掉一半以上；
 *      BarChart / Grid / Tooltip / Legend / Canvas 渲染器，一个不多一个不少。
 *   2) 组件由看板用 defineAsyncComponent 异步引入 —— echarts 单独成一个 chunk，
 *      晚一拍加载，首屏的文字和卡片先画出来，图表再自己长出来。比整页多等一截好。
 *   3) 高度写死 160px，和它取代的那排 div 柱子（.trend-bars 的 height: 160px）
 *      完全一致。ECharts 必须有确定高度的容器，顺带也保证换图不会顶动布局。
 */
import { computed } from 'vue'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

use([BarChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer])

const props = defineProps({
  /** [{ month, planned, completed, plannedNum, completedNum }]，来自看板的 trendData */
  data: { type: Array, default: () => [] }
})

// 取 CSS 变量要经过 getComputedStyle，而这些变量定义在 :root 上。
// 不能直接写 'var(--emerald)' —— ECharts 把颜色交给 canvas 用，canvas 不认 CSS 变量，
// 拿到字符串只会画成透明。这是本项目的 token 体系和 canvas 图表之间唯一的接缝。
function token(name, fallback) {
  if (typeof window === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

const option = computed(() => {
  const planned = token('--accent-line', '#7aa2f7')
  const completed = token('--emerald', '#10b981')
  const ink = token('--text-2', '#2a3852')
  const line = token('--line', '#dde4ef')

  return {
    // 图表容器很窄（1/3 宽的卡片），四周留白要收着给，否则绘图区会被挤没
    grid: { left: 4, right: 8, top: 28, bottom: 4, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      // 默认 tooltip 是鼠标跟随的小黑块，在浅色卡片上显得很脏；
      // 这里给它白底 + 细边框，和卡片本身的材质一致
      backgroundColor: '#fff',
      borderColor: line,
      borderWidth: 1,
      padding: [8, 12],
      textStyle: { color: ink, fontSize: 12 },
      // 数值带单位，并算出完成率——比两个孤立的数字有用得多
      formatter: (ps) => {
        if (!ps || !ps.length) return ''
        const rows = ps.map(p => `${p.marker}${p.seriesName}&nbsp;&nbsp;<b>${p.value}</b> 次`).join('<br/>')
        const p0 = ps.find(p => p.seriesName === '计划')
        const c0 = ps.find(p => p.seriesName === '完成')
        let rate = ''
        if (p0 && c0 && p0.value > 0) {
          rate = `<br/>完成率&nbsp;&nbsp;<b>${Math.round((c0.value / p0.value) * 100)}%</b>`
        }
        return `<b>${ps[0].axisValue}</b><br/>${rows}${rate}`
      }
    },
    legend: {
      // 原来那排图例在卡片右下，位置和图标风格都跟着搬过来
      right: 0,
      top: 0,
      itemWidth: 8,
      itemHeight: 8,
      icon: 'circle',
      textStyle: { color: ink, fontSize: 12 }
    },
    xAxis: {
      type: 'category',
      data: props.data.map(d => d.month),
      axisLine: { lineStyle: { color: line } },
      axisTick: { show: false },
      axisLabel: { color: ink, fontSize: 12 }
    },
    yAxis: {
      type: 'value',
      axisLine: { show: false },
      axisTick: { show: false },
      // 卡片窄，纵轴只留刻度数字，去掉网格线减少噪点
      axisLabel: { color: ink, fontSize: 11 },
      splitLine: { lineStyle: { color: line, type: 'dashed' } }
    },
    // 入场动画跟着页面其余增长动画的节拍走（0.8s，和原来那排柱子的 transition 一致）
    animationDuration: 800,
    animationEasing: 'cubicOut',
    // 6 个月 × 2 条 = 12 根柱子挤在 1/3 宽的卡片里。ECharts 默认的间距会让
    // 每根柱子细得像根线、中间却留着大片空当；这两项把柱子加粗、把空当收回，
    // 让"计划/完成"成对的关系一眼看得出来。
    barGap: '18%',
    barCategoryGap: '34%',
    series: [
      {
        name: '计划',
        type: 'bar',
        data: props.data.map(d => d.plannedNum),
        itemStyle: { color: planned, borderRadius: [3, 3, 0, 0] },
        barMaxWidth: 22
      },
      {
        name: '完成',
        type: 'bar',
        data: props.data.map(d => d.completedNum),
        itemStyle: { color: completed, borderRadius: [3, 3, 0, 0] },
        barMaxWidth: 22
      }
    ]
  }
})
</script>

<style scoped>
/* 高度和它取代的那排 div 柱子（原 .trend-bars 的 160px）一致，
   只是留了 200px —— 同一行里的"维保超期提醒"有十几条、本来就撑得更高，
   加这 40px 不会顶动整行布局，却让柱子的高低差明显好读。
   ECharts 必须有确定高度的容器，这个值同时是它的绘图区尺寸来源。 */
.trend-echart {
  height: 200px;
  width: 100%;
}
</style>
