<template>
  <div class="records-page">
    <!-- 顶部：设备选择 + 概览 -->
    <el-card shadow="never" class="records-head">
      <div class="records-head-row">
        <div class="records-picker">
          <span class="records-label">选择设备</span>
          <el-select
            v-model="selectedId"
            filterable
            placeholder="搜索设备名称 / 型号"
            style="width: 300px"
            @change="onSelect"
          >
            <el-option
              v-for="eq in sortedEquipment"
              :key="eq.id"
              :label="`${eq.name}（${eq.model || eq.category}）`"
              :value="eq.id"
            >
              <div class="eq-option">
                <span>{{ eq.name }} <span class="eq-model">{{ eq.model }}</span></span>
                <el-tag :type="eq.levelType" size="small" effect="plain">{{ eq.levelLabel }}</el-tag>
              </div>
            </el-option>
          </el-select>
        </div>
      </div>
      <div v-if="selected" class="record-profile">
        <div class="rp-photo">
          <img :src="equipmentPhoto(selected.category)" :alt="selected.name" />
          <span class="rp-level" :style="{ background: scoreColor(health?.score ?? 0) }">{{ health?.level ?? '未体检' }} 级</span>
        </div>
        <div class="rp-main">
          <div class="rp-name">{{ selected.name }}</div>
          <div class="rp-sub">{{ selected.model }} · {{ selected.category }} · {{ selected.location || '未定位' }}</div>
          <div class="rp-factors" v-if="health && health.factors && health.factors.length">
            <div v-for="f in health.factors" :key="f.key" class="rp-factor" :title="(f.formula || f.detail || '') + (f.source ? ' · 来源:' + f.source : '')">
              <span class="rp-factor-name">{{ f.name }}</span>
              <div class="rp-factor-track">
                <div class="rp-factor-fill" :style="{ width: Math.min(100, f.score) + '%', background: scoreColor(f.score) }"></div>
              </div>
              <span class="rp-factor-score">{{ f.score }}</span>
            </div>
          </div>
        </div>
        <div class="rp-score">
          <div class="rp-score-num" :style="{ color: scoreColor(health?.score ?? 0) }">{{ health?.score ?? '—' }}</div>
          <div class="rp-score-label">健康分</div>
          <div v-if="spark" class="rp-spark">
            <svg :viewBox="`0 0 ${spark.width} ${spark.height}`" class="rp-spark-svg">
              <polyline :points="spark.polyline" :stroke="scoreColor(health?.score ?? 0)" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span class="rp-trend" :style="{ color: trend.color }">{{ trendGlyph(trend.kind) }} {{ trend.label }}</span>
          </div>
          <div v-else class="rp-nospark">快照积累中</div>
        </div>
      </div>
    </el-card>

    <!-- 病历统计条 -->
    <div v-if="recordStats" class="record-stats">
      <div class="rs-item"><b>{{ recordStats.count }}</b><span>历史体检</span></div>
      <div class="rs-item"><b>{{ recordStats.latest }}</b><span>最近体检</span></div>
      <div class="rs-item"><b>{{ recordStats.first }}</b><span>首次体检</span></div>
      <div class="rs-item"><b :style="{ color: scoreColor(recordStats.max) }">{{ recordStats.max }}</b><span>历史最高分</span></div>
      <div class="rs-item"><b :style="{ color: scoreColor(recordStats.min) }">{{ recordStats.min }}</b><span>历史最低分</span></div>
    </div>

    <!-- 主区：报告 + 历史 -->
    <div v-if="selected" class="records-body">
      <el-card shadow="never" class="report-card">
        <template #header>
          <div class="card-header">
            <span><el-icon><Notebook /></el-icon> 体检报告（{{ selected.name }}）</span>
            <div>
              <el-button size="small" @click="refreshReport">重新生成</el-button>
              <el-button size="small" type="primary" @click="printReport">
                <el-icon style="margin-right: 4px"><Printer /></el-icon>打印 / 导出 PDF
              </el-button>
            </div>
          </div>
        </template>
        <div v-if="reportHtml" class="report-html" v-html="reportHtml"></div>
        <el-empty v-else description="暂无报告，请先选择设备" />
      </el-card>

      <el-card shadow="never" class="history-card">
        <template #header>
          <div class="card-header">
            <span><el-icon><DataLine /></el-icon> 健康病历（历史快照）</span>
            <el-tag v-if="trend" :type="trend.kind === 'worsening' ? 'danger' : trend.kind === 'improving' ? 'success' : 'info'" size="small">
              {{ trend.label }}
            </el-tag>
          </div>
        </template>
        <el-table :data="snapshots" size="small" max-height="420" stripe>
          <el-table-column prop="date" label="体检日期" width="120" />
          <el-table-column label="健康分" width="90">
            <template #default="{ row }">
              <span class="score-cell" :style="{ color: scoreColor(row.score) }">{{ row.score }}</span>
            </template>
          </el-table-column>
          <el-table-column label="等级" width="80">
            <template #default="{ row }">
              <el-tag size="small" :type="levelTypeByScore(row.score)" effect="plain">{{ levelLabelByScore(row.score) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="与上次变化" width="110">
            <template #default="{ row, $index }">
              <span v-if="$index < snapshots.length - 1" class="diff-cell" :class="diffClass(row.score, snapshots[$index + 1].score)">
                {{ diffText(row.score, snapshots[$index + 1].score) }}
              </span>
              <span v-else class="diff-cell first">首份快照</span>
            </template>
          </el-table-column>
          <el-table-column prop="note" label="备注" min-width="160" show-overflow-tooltip />
        </el-table>
        <div class="history-note">
          快照在每次生成体检报告、工单完成归档时自动落库——这就是"病历越攒越全、经验越用越厚"的数据资产。
        </div>
      </el-card>
    </div>
    <el-empty v-else description="请选择一台设备查看病历" style="margin-top: 60px" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { useAppStore } from '../stores/appStore'
import { generateHealthReport } from '../utils/healthReport'
import { levelOf, levelMeta, buildTrendPath } from '../utils/health'
import { equipmentPhoto } from '../utils/equipmentPhoto'

const store = useAppStore()
const selectedId = ref(null)
const reportHtml = ref('')

/**
 * 设备列表（按健康分降序），顺带把健康评估与等级标签一次性带上。
 * 模板里每个 option 都要显示等级，若各自回查一遍就是 O(n²) 次全表扫描。
 */
const sortedEquipment = computed(() =>
  [...store.equipmentWithHealth]
    .sort((a, b) => (b.health?.score ?? 0) - (a.health?.score ?? 0))
    .map(eq => ({
      ...eq,
      levelLabel: eq.health ? eq.health.levelLabel : '未体检',
      levelType: eq.health ? LEVEL_TAG_TYPES[eq.health.level] || 'info' : 'info'
    }))
)

/** 设备 id → 健康评估（一次建表，避免模板里反复 find） */
const healthById = computed(() => {
  const map = new Map()
  for (const item of store.equipmentWithHealth) map.set(item.id, item.health || null)
  return map
})

const selected = computed(() =>
  selectedId.value != null ? store.equipmentList.find(eq => eq.id === Number(selectedId.value)) : null
)

function healthOf(eq) {
  return healthById.value.get(Number(eq?.id)) ?? null
}

const health = computed(() => (selected.value ? healthOf(selected.value) : null))

const snapshots = computed(() => {
  if (!selected.value) return []
  const snaps = store.getSnapshots(selected.value.id) || []
  return snaps.map(s => ({
    date: s.date,
    score: s.score,
    note: s.factors_json ? '含四因子明细' : ''
  })).reverse()
})

const trend = computed(() => {
  if (!selected.value) return null
  return store.getTrend(selected.value.id)
})

function onSelect() {
  refreshReport()
}

function refreshReport() {
  if (!selected.value) return
  const result = generateHealthReport(selected.value, store)
  reportHtml.value = result.html
  ElMessage.success(`已生成 ${selected.value.name} 的体检报告`)
}

function printReport() {
  const win = window.open('', '_blank')
  if (!win) {
    ElMessage.warning('浏览器拦截了打印窗口，请允许弹窗')
    return
  }
  win.document.write(`<html><head><title>${selected.value.name} 体检报告</title></head><body>${reportHtml.value}</body></html>`)
  win.document.close()
  win.focus()
  setTimeout(() => win.print(), 300)
}

/** 等级 → Element Plus tag 类型（唯一一处映射，避免各页面各写一套） */
const LEVEL_TAG_TYPES = { A: 'success', B: 'primary', C: 'warning', D: 'danger' }

function levelLabelByScore(score) {
  return levelOf(score)
}

function levelTypeByScore(score) {
  return LEVEL_TAG_TYPES[levelOf(score)] || 'info'
}

/** 分色统一取 RISK_LEVELS，与台账/看板/报告同一套色板 */
function scoreColor(score) {
  return levelMeta(levelOf(score)).color
}

/** 趋势箭头（文案统一用 TREND_KINDS.label，不再手写三元） */
function trendGlyph(kind) {
  if (kind === 'worsening') return '↓'
  if (kind === 'improving') return '↑'
  return '→'
}

/** 病历统计：历史体检次数 / 首次 / 最近 / 最高 / 最低 */
const recordStats = computed(() => {
  const snaps = snapshots.value
  if (!snaps.length) return null
  const scores = snaps.map(x => Number(x.score)).filter(n => Number.isFinite(n))
  if (!scores.length) return null
  return {
    count: snaps.length,
    first: snaps[snaps.length - 1].date,
    latest: snaps[0].date,
    max: Math.max(...scores),
    min: Math.min(...scores)
  }
})

/** 健康分趋势迷你折线（SVG）：坐标计算与台账页、体检报告共用 buildTrendPath */
const spark = computed(() => buildTrendPath(trend.value && trend.value.points, { width: 150, height: 46 }))

function diffText(cur, prev) {
  const d = Number(cur) - Number(prev)
  if (!Number.isFinite(d)) return '—'
  return d > 0 ? `+ ${d}` : d < 0 ? `- ${Math.abs(d)}` : '持平'
}
function diffClass(cur, prev) {
  const d = Number(cur) - Number(prev)
  if (!Number.isFinite(d)) return 'first'
  return d > 0 ? 'up' : d < 0 ? 'down' : 'flat'
}

onMounted(() => {
  if (sortedEquipment.value.length && selectedId.value == null) {
    const first = store.criticalList[0] || sortedEquipment.value[0]
    selectedId.value = first.id
    refreshReport()
  }
})

</script>

<style scoped>
.records-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.records-head-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}

.records-picker {
  display: flex;
  align-items: center;
  gap: 10px;
}

.records-label {
  font-size: 13px;
  color: var(--text-2);
  font-weight: 600;
}

.eq-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.eq-model {
  color: var(--text-3);
  font-size: 12px;
}

.records-body {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  align-items: flex-start;
}

.report-card {
  flex: 2 1 480px;
  min-width: 0;
}

.history-card {
  flex: 1 1 300px;
  min-width: 0;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.score-cell {
  font-weight: 700;
  font-size: 15px;
}

.history-note {
  margin-top: 10px;
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.6;
}

.record-profile {
  display: flex;
  align-items: stretch;
  gap: 16px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--line-2);
  flex-wrap: wrap;
}
.rp-photo {
  position: relative;
  width: 200px;
  height: 130px;
  border-radius: 10px;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--bg-sunken);
}
.rp-photo img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.rp-level {
  position: absolute;
  left: 8px;
  top: 8px;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  padding: 2px 9px;
  border-radius: 999px;
  box-shadow: 0 1px 4px rgba(0,0,0,0.25);
}
.rp-main {
  flex: 1 1 280px;
  min-width: 0;
}
.rp-name {
  font-size: 17px;
  font-weight: 700;
  color: var(--text-1);
}
.rp-sub {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 2px;
}
.rp-factors {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 10px;
}
.rp-factor {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rp-factor-name {
  width: 76px;
  font-size: 11px;
  color: var(--text-3);
  text-align: right;
  flex-shrink: 0;
}
.rp-factor-track {
  flex: 1;
  height: 5px;
  background: var(--line-2);
  border-radius: 3px;
  overflow: hidden;
}
.rp-factor-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.4s;
}
.rp-factor-score {
  width: 26px;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-2);
  text-align: right;
}
.rp-score {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0 16px;
  border-left: 1px solid var(--line-2);
}
.rp-score-num {
  font-size: 34px;
  font-weight: 800;
  line-height: 1;
}
.rp-score-label {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 4px;
}
.rp-spark {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.rp-spark-svg {
  width: 150px;
  height: 46px;
}
.rp-trend {
  font-size: 11px;
  font-weight: 700;
}
.rp-nospark {
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-mute);
}

.record-stats {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.rs-item {
  flex: 1 1 130px;
  min-width: 110px;
  background: #fff;
  border: 1px solid var(--line-2);
  border-radius: 10px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.rs-item b {
  font-size: 16px;
  color: var(--text-1);
}
.rs-item span {
  font-size: 11px;
  color: var(--text-3);
}

.diff-cell {
  font-size: 12px;
  font-weight: 700;
}
.diff-cell.up { color: var(--success-ink); }
.diff-cell.down { color: var(--danger-ink); }
.diff-cell.flat { color: var(--text-3); }
.diff-cell.first { color: var(--text-mute); font-weight: 400; }

</style>
