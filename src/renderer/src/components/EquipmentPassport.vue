<template>
  <div class="passport" ref="passportRef">
    <!-- 顶部彩色条 -->
    <div class="passport-bar" :class="'lv-' + level"></div>

    <!-- 头部 -->
    <div class="passport-header">
      <div class="passport-title-row">
        <h2 class="passport-title">设备身份证</h2>
        <span class="passport-id">{{ equipment.id }}</span>
      </div>
      <p class="passport-subtitle">Equipment Passport</p>
    </div>

    <!-- 主体 -->
    <div class="passport-body">
      <!-- 左栏：基本信息 -->
      <div class="passport-left">
        <div class="passport-avatar">
          <el-icon :size="48"><Monitor /></el-icon>
        </div>
        <table class="info-table">
          <tr><td class="label">设备名称</td><td>{{ equipment.name }}</td></tr>
          <tr><td class="label">型&emsp;号</td><td>{{ equipment.model }}</td></tr>
          <tr><td class="label">类&emsp;别</td><td>{{ equipment.category }}</td></tr>
          <tr><td class="label">所在位置</td><td>{{ equipment.location }}</td></tr>
          <tr><td class="label">购置日期</td><td>{{ equipment.purchase_date }}</td></tr>
          <tr><td class="label">当前状态</td><td><span class="status-dot" :class="equipment.status"></span>{{ statusText }}</td></tr>
          <tr><td class="label">维保周期</td><td>{{ equipment.maintenance_cycle_days }} 天</td></tr>
        </table>
      </div>

      <!-- 右栏：健康画像 -->
      <div class="passport-right">
        <!-- 健康分圆环 -->
        <div class="health-ring" :class="'lv-' + level">
          <svg viewBox="0 0 120 120">
            <circle cx="60" cy="60" r="52" fill="none" stroke="#eee" stroke-width="8" />
            <circle
              cx="60" cy="60" r="52" fill="none"
              :stroke="ringColor"
              stroke-width="8"
              stroke-linecap="round"
              :stroke-dasharray="circumference"
              :stroke-dashoffset="dashOffset"
              transform="rotate(-90 60 60)"
            />
          </svg>
          <div class="ring-text">
            <span class="ring-score">{{ health.score }}</span>
            <span class="ring-label">{{ health.levelLabel }}</span>
          </div>
        </div>

        <!-- 四因子 -->
        <div class="factors-compact">
          <div class="fc-row" v-for="f in factorsWithColor" :key="f.name">
            <span class="fc-name">{{ f.name }}</span>
            <div class="fc-bar-wrap">
              <div class="fc-bar" :style="{ width: f.score + '%', background: f.color }"></div>
            </div>
            <span class="fc-val">{{ f.score }}</span>
          </div>
        </div>

        <!-- 统计摘要 -->
        <div class="stat-grid">
          <div class="stat-item">
            <span class="stat-num">{{ summary.orderTotal }}</span>
            <span class="stat-label">累计工单</span>
          </div>
          <div class="stat-item">
            <span class="stat-num" :class="{ warn: summary.orderActive > 0 }">{{ summary.orderActive }}</span>
            <span class="stat-label">进行中</span>
          </div>
          <div class="stat-item">
            <span class="stat-num">{{ summary.faultCount }}</span>
            <span class="stat-label">历史故障</span>
          </div>
          <div class="stat-item">
            <span class="stat-num">{{ summary.maintCount }}</span>
            <span class="stat-label">维保次数</span>
          </div>
        </div>

        <!-- 最近维保 -->
        <div class="last-maint" v-if="summary.lastMaintDate">
          <el-icon><Calendar /></el-icon>
          <span>最近维保：{{ summary.lastMaintDate }}</span>
        </div>
        <div class="last-maint" v-else>
          <el-icon><Calendar /></el-icon>
          <span>暂无维保记录</span>
        </div>
      </div>
    </div>

    <!-- 底部 -->
    <div class="passport-footer">
      <div class="footer-left">
        <span class="footer-note">※ 本卡由矿山智工系统自动生成，数据截止 {{ generatedAt }}</span>
      </div>
      <div class="footer-right">
        <div class="qr-placeholder">
          <el-icon :size="36"><Iphone /></el-icon>
          <span>扫码查看</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Monitor, Calendar, Iphone } from '@element-plus/icons-vue'
import { getHealthColor } from '../utils/health'
import { equipmentStatusLabel } from '../utils/dictionaries'

const props = defineProps({
  equipment:  { type: Object, required: true },
  health:     { type: Object, required: true },
  factors:    { type: Array,  default: () => [] },
  summary:    { type: Object, default: () => ({ orderTotal: 0, orderActive: 0, faultCount: 0, maintCount: 0, lastMaintDate: '' }) }
})

const factorsWithColor = computed(() =>
  props.factors.map(f => ({ ...f, color: getHealthColor(f.score) }))
)

const level = computed(() => props.health.level?.toLowerCase() || 'a')

// 状态文案走共享字典（self-check 门禁：禁止页面自建状态文案表）；
// 字典未收录的扩展状态（standby）留一个最小兜底
const STATUS_FALLBACK = { standby: '待机' }
const statusText = computed(() => {
  const label = equipmentStatusLabel(props.equipment.status)
  return label === props.equipment.status
    ? (STATUS_FALLBACK[props.equipment.status] || props.equipment.status)
    : label
})

// SVG ring
const circumference = 2 * Math.PI * 52
const dashOffset = computed(() => circumference * (1 - props.health.score / 100))

const ringColor = computed(() => {
  const m = { a: '#2ecc71', b: '#3498db', c: '#f39c12', d: '#e74c3c' }
  return m[level.value] || '#3498db'
})

const generatedAt = computed(() => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})
</script>

<style scoped>
.passport {
  --p-font: 'Noto Sans SC', 'PingFang SC', sans-serif;
  font-family: var(--p-font);
  width: 680px;
  background: #fff;
  border: 1.5px solid #e0e0e0;
  border-radius: 8px;
  overflow: hidden;
  position: relative;
}

/* 顶部色条 */
.passport-bar {
  height: 6px;
}
.passport-bar.lv-a { background: linear-gradient(90deg, #2ecc71, #27ae60); }
.passport-bar.lv-b { background: linear-gradient(90deg, #3498db, #2980b9); }
.passport-bar.lv-c { background: linear-gradient(90deg, #f39c12, #e67e22); }
.passport-bar.lv-d { background: linear-gradient(90deg, #e74c3c, #c0392b); }

/* 头部 */
.passport-header {
  padding: 20px 28px 12px;
  border-bottom: 1px solid #f0f0f0;
}
.passport-title-row {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.passport-title {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: #1a1a2e;
  letter-spacing: 2px;
}
.passport-id {
  font-size: 12px;
  color: #999;
  font-family: 'Consolas', monospace;
}
.passport-subtitle {
  margin: 2px 0 0;
  font-size: 11px;
  color: #bbb;
  letter-spacing: 1px;
}

/* 主体 */
.passport-body {
  display: flex;
  padding: 20px 28px;
  gap: 24px;
}

/* 左栏 */
.passport-left {
  flex: 0 0 240px;
}
.passport-avatar {
  width: 80px;
  height: 80px;
  background: #f5f7fa;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #909399;
  margin-bottom: 12px;
}
.info-table {
  width: 100%;
  font-size: 12px;
  border-collapse: collapse;
}
.info-table tr {
  border-bottom: 1px dashed #f0f0f0;
}
.info-table td {
  padding: 5px 0;
  vertical-align: top;
}
.info-table .label {
  color: #999;
  width: 60px;
  white-space: nowrap;
  padding-right: 8px;
}
.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 4px;
  vertical-align: middle;
}
.status-dot.running { background: #2ecc71; }
.status-dot.standby { background: #f39c12; }
.status-dot.maintenance { background: #e74c3c; }
.status-dot.idle { background: #95a5a6; }

/* 右栏 */
.passport-right {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* 健康圆环 */
.health-ring {
  position: relative;
  width: 100px;
  height: 100px;
  margin: 0 auto;
}
.health-ring svg {
  width: 100%;
  height: 100%;
}
.ring-text {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.ring-score {
  font-size: 26px;
  font-weight: 800;
  line-height: 1;
  color: #1a1a2e;
}
.ring-label {
  font-size: 10px;
  color: #999;
  margin-top: 2px;
}

/* 四因子 */
.factors-compact {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.fc-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
}
.fc-name {
  flex: 0 0 60px;
  color: #666;
}
.fc-bar-wrap {
  flex: 1;
  height: 6px;
  background: #f0f0f0;
  border-radius: 3px;
  overflow: hidden;
}
.fc-bar {
  height: 100%;
  border-radius: 3px;
  transition: width 0.6s ease;
}
.fc-val {
  flex: 0 0 24px;
  text-align: right;
  font-weight: 600;
  color: #333;
}

/* 统计格 */
.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  text-align: center;
}
.stat-item {
  padding: 8px 4px;
  background: #f8f9fa;
  border-radius: 6px;
}
.stat-num {
  display: block;
  font-size: 18px;
  font-weight: 700;
  color: #1a1a2e;
  line-height: 1.2;
}
.stat-num.warn {
  color: #e67e22;
}
.stat-label {
  display: block;
  font-size: 10px;
  color: #999;
  margin-top: 2px;
}

/* 最近维保 */
.last-maint {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #666;
  padding: 6px 10px;
  background: #fafafa;
  border-radius: 4px;
}

/* 底部 */
.passport-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 28px;
  border-top: 1px solid #f0f0f0;
  background: #fafbfc;
}
.footer-note {
  font-size: 10px;
  color: #bbb;
}
.qr-placeholder {
  width: 52px;
  height: 52px;
  border: 1.5px dashed #ddd;
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #ccc;
  font-size: 9px;
  gap: 2px;
}

/* 打印适配 */
@media print {
  .passport {
    border: 1px solid #ccc;
    box-shadow: none;
    page-break-inside: avoid;
  }
  .passport-bar { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  .stat-item { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  .fc-bar { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
}
</style>
