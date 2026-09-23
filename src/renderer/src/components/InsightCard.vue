<template>
  <div class="insight-card" :class="`insight-${level}`">
    <div class="insight-icon">
      <el-icon :size="24"><component :is="icon" /></el-icon>
    </div>
    <div class="insight-body">
      <div class="insight-label">{{ label }}</div>
      <div class="insight-value tnum">{{ displayValue }}</div>
      <div class="insight-detail">{{ detail }}</div>
    </div>
    <div class="insight-bar" :class="`bar-${level}`"></div>
    <div class="insight-advice">{{ advice }}</div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { tweenNumber, prefersReducedMotion } from '../utils/motion'

const props = defineProps({
  icon: { type: String, default: 'Monitor' },
  label: { type: String, required: true },
  value: { type: String, required: true },
  level: { type: String, default: 'ok' },
  advice: { type: String, default: '' },
  detail: { type: String, default: '' },
  raw: { type: Number, default: 0 }
})

const displayValue = ref(props.value)

onMounted(() => {
  // 数字滚动：0 → 真值，百分比格式。
  //
  // 时长单位是**秒**（见 utils/motion.js 的 `@param durationSec`）。这里原先写的是
  // `800`，被当成 800 秒 —— 动画永远滚不完，卡片上的大数字在整场演示里一直从 0 慢慢
  // 往上爬：截图时停在 "3.0%"，而真值是 88.3%。改成 0.8s，与全站其它数字滚动同节拍。
  if (!prefersReducedMotion() && props.raw > 0 && props.value.includes('%')) {
    tweenNumber(0, props.raw, 0.8, (v) => {
      displayValue.value = `${v.toFixed(1)}%`
    }).then(() => {
      // tweenNumber 逐帧取整（避免渲染出 17.2847），所以末帧是 88.0 而非 88.3。
      // 收尾时对回精确字符串，保证停下的值与 insights.js 算出来的完全一致。
      displayValue.value = props.value
    })
  }
})
</script>

<style scoped>
.insight-card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--r);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  position: relative;
  overflow: hidden;
  transition: box-shadow 0.25s var(--ease-out), transform 0.25s var(--ease-out);
  box-shadow: var(--sh-xs);
}

.insight-card:hover {
  box-shadow: var(--sh-sm);
  transform: translateY(-2px);
}

/* 顶部颜色条 */
.insight-bar {
  height: 3px;
  border-radius: 2px;
  transition: width 0.8s var(--ease-out);
  width: 0;
}

.insight-card:hover .insight-bar,
.insight-card .insight-bar {
  width: 100%;
}

.bar-ok { background: var(--emerald); }
.bar-warn { background: var(--amber); }
.bar-danger { background: var(--danger); }

/* 图标 */
.insight-icon {
  width: 40px;
  height: 40px;
  border-radius: var(--r-sm);
  display: flex;
  align-items: center;
  justify-content: center;
}

.insight-ok .insight-icon {
  background: var(--emerald-soft);
  color: var(--success-ink);
}

.insight-warn .insight-icon {
  background: var(--amber-soft);
  color: var(--warn-ink);
}

.insight-danger .insight-icon {
  background: var(--danger-soft);
  color: var(--danger-ink);
}

/* 标签 */
.insight-label {
  font-size: 12.5px;
  color: var(--text-3);
  font-weight: 500;
  letter-spacing: 0.3px;
}

/* 大数字 */
.insight-value {
  font-size: 26px;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -0.5px;
}

.insight-ok .insight-value { color: var(--success-ink); }
.insight-warn .insight-value { color: var(--warn-ink); }
.insight-danger .insight-value { color: var(--danger-ink); }

/* 细节 */
.insight-detail {
  font-size: 11.5px;
  color: var(--text-mute);
}

/* 建议文案 */
.insight-advice {
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.5;
  border-top: 1px solid var(--line-2);
  padding-top: 8px;
  margin-top: auto;
}
</style>
