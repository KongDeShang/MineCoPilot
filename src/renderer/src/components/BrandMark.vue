<template>
  <svg
    class="brand-mark"
    :width="size"
    :height="size"
    viewBox="0 0 100 100"
    aria-hidden="true"
    focusable="false"
  >
    <polyline
      points="11,72 31,28 50,58 69,28 89,72"
      fill="none"
      stroke="currentColor"
      stroke-width="12.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>

<script setup>
/**
 * 品牌标识：一条折线同时读作「山脊」与字母 M（Mine / Mountain）
 *
 * 为什么是内联 SVG 而不是图标字体或位图：
 * - 侧栏、落地页、打印件三种场合的字号差得很远，矢量在任意尺寸下都不糊；
 * - 描边用 currentColor，浅色/深色主题各由外层 .logo-mark 的 color 决定，
 *   标识本身不需要知道当前是哪个主题（tokens.css 的深浅切换对它透明）；
 * - 与 exe / 安装向导 / 桌面快捷方式 / 浏览器标签页用的是同一份造型
 *   （build/icon.ico 与 public/favicon.svg 由同一组坐标生成），改一处要三处一起改。
 *
 * 造型取舍：小到 16px 时，多元素（"山 + 心电图 + 齿轮"）会糊成一团，
 * 单条粗折线还能辨认 —— 所以这里只有一个元素，靠粗细和圆角接头撑住辨识度。
 */
defineProps({
  /** 边长（px），与 viewBox 等比缩放 */
  size: { type: Number, default: 24 },
})
</script>

<style scoped>
.brand-mark {
  display: block;
}
</style>
