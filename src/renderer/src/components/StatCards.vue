<template>
  <el-row :gutter="16" class="stat-cards">
    <el-col v-for="(item, i) in items" :key="i" :xs="12" :sm="span">
      <div class="stat-card">
        <div class="stat-label">{{ item.label }}</div>
        <div class="stat-value" :style="valueStyle(item)">
          <!-- 只有纯数字才滚动：value 里还可能是 "—"（无数据）或 TOP1 系统名这类文本，
               补间不上就原样输出，排版和原来逐字一致 -->
          <AnimatedNumber v-if="typeof item.value === 'number'" :value="item.value" />
          <template v-else>{{ item.value }}</template>
          <span v-if="item.unit" class="stat-unit">{{ item.unit }}</span>
        </div>
      </div>
    </el-col>
  </el-row>
</template>

<script setup>
/**
 * 一排指标卡（"标签 + 大数字 + 单位"）
 *
 * 手册资料库、故障案例库、复诊管理三个页面的顶部指标条，原本是同一段
 * 模板和同一份样式各抄了一遍 —— 三份 .stat-card / .stat-label / .stat-value
 * 连颜色值都逐字相同，改一次配色要改三处。
 *
 * 看板页的统计卡不在这里：那张卡是"图标 + 数值 + 环比趋势"的另一种排版，
 * 硬塞进同一个组件只会得到一个带两套分支布局的组件，比两份代码更难改。
 */
import AnimatedNumber from './AnimatedNumber.vue'

defineProps({
  /**
   * 指标项：{ label, value, unit?, color?, small? }
   * value 由调用方算好（含 "—" 这类占位），组件不做业务判断
   */
  items: { type: Array, required: true },
  /** 每张卡在大屏上占几列（4 张卡用 6，3 张卡用 8） */
  span: { type: Number, default: 8 }
})

/** color 只作用于数字本身；small 用于放不下的长文本值（如 TOP1 系统名） */
function valueStyle(item) {
  const style = {}
  if (item.color) style.color = item.color
  if (item.small) style.fontSize = '18px'
  return style
}
</script>

<style scoped>
.stat-card {
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 13px;
  padding: 14px 16px;
  box-shadow: 0 1px 2px rgba(16, 24, 40, .04);
  margin-bottom: 4px;
}

.stat-label {
  font-size: 12px;
  color: var(--text-3);
}

.stat-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--text-1);
  margin-top: 4px;
}

.stat-unit {
  font-size: 12px;
  color: var(--text-3);
  font-weight: 400;
}
</style>
