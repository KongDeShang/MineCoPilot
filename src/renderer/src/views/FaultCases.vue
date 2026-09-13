<template>
  <div class="fault-page">
    <!-- 顶部统计 -->
    <StatCards :items="statItems" />

    <!-- 自动沉淀案例（工单完工自动归档：症状 → 原因 → 处理） -->
    <el-card v-if="recentCases.length" shadow="never">
      <template #header>
        <div class="card-header">
          <span><el-icon><MagicStick /></el-icon> 最新自动沉淀案例（维修工单完工自动归档）</span>
          <el-tag size="small" type="success" effect="plain">症状 → 原因 → 处理 · 可溯源到工单</el-tag>
        </div>
      </template>
      <div class="cases-grid">
        <div v-for="c in recentCases" :key="c.id" class="case-card">
          <div class="case-head">
            <el-tag size="small" type="danger" effect="dark">{{ c.category || '通用' }}</el-tag>
            <span class="case-name">{{ c.equipment_name }}</span>
            <span class="case-date">{{ (c.createdAt || '').slice(5, 10) }}</span>
          </div>
          <div class="case-row"><span class="case-k">症状</span><span class="case-v">{{ c.symptom }}</span></div>
          <div class="case-row"><span class="case-k">原因</span><span class="case-v">{{ c.cause || '（知识库未命中，留待人工补充）' }}</span></div>
          <div class="case-row"><span class="case-k">处理</span><span class="case-v">{{ c.solution || '—' }}</span></div>
          <div class="case-foot">
            <el-icon><Link /></el-icon> 来源工单 #{{ c.source_order_id }}
            <span v-if="c.repair_hours != null" class="case-hours">· 参考工时 {{ c.repair_hours }}h</span>
          </div>
        </div>
      </div>
    </el-card>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span><el-icon><Warning /></el-icon> 高频故障案例库（数据沉淀 → 反哺）</span>
          <el-tag size="small" type="info" effect="plain">按故障描述自动归类 · 一条记录只计一次 · 可点开原文</el-tag>
        </div>
      </template>      <div class="fault-bars">
        <div v-for="(item, i) in faultStats.top" :key="item.system"
          class="fault-row" :class="{ active: expanded === item.system }"
          @click="toggle(item)">
          <div class="fault-rank" :class="'rank-' + Math.min(i + 1, 5)">{{ i + 1 }}</div>
          <div class="fault-system">{{ item.system }}</div>
          <div class="fault-bar-wrap">
            <div class="fault-bar" :style="{ width: barWidth(item.percent) + '%', background: barColor(i) }"></div>
          </div>
          <div class="fault-count">{{ item.count }} 次</div>
          <div class="fault-percent">{{ item.percent }}%</div>
          <el-icon class="fault-arrow"><ArrowDown /></el-icon>
        </div>
      </div>

      <!-- 展开原文（可审计） -->
      <div v-if="expandedItem" class="fault-samples">
        <div class="fault-sample-head">
          <strong>{{ expandedItem.system }}</strong> 共 {{ expandedItem.count }} 条原文
          <el-button size="small" link type="primary" @click="expanded = null">收起</el-button>
        </div>
        <el-table :data="expandedItem.samples" size="small" max-height="380" stripe>
          <el-table-column label="来源" width="100">
            <template #default="{ row }">
              <el-tag size="small" :type="row.source === '工单' ? 'warning' : 'info'" effect="plain">{{ row.source }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="equipmentName" label="设备" width="140" />
          <el-table-column prop="title" label="故障描述（原文）" min-width="260" show-overflow-tooltip />
          <el-table-column prop="date" label="日期" width="110" />
        </el-table>
      </div>

      <div class="fault-note">
        每条案例都是真实工单/维保记录的原文，可追溯到设备与日期——这是"数据不出设备、每个数字可溯源"的审计式 AI 的证据。
        系统不生成"通用建议"，只呈现本地发生过的真实故障。
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { Warning, MagicStick, Link } from '@element-plus/icons-vue'
import { useAppStore } from '../stores/appStore'
import StatCards from '../components/StatCards.vue'

const store = useAppStore()
const expanded = ref(null)

const faultStats = computed(() => store.faultTopStats)
const top1 = computed(() => faultStats.value.top?.[0] || null)

const statItems = computed(() => {
  const s = faultStats.value
  return [
    { label: '自动分类样本（本地真实记录）', value: s.total || 0, unit: '条' },
    { label: '系统分类', value: s.top?.length || 0, unit: '类' },
    { label: 'TOP1 系统', value: top1.value?.system || '—', color: '#0b3a82', small: true }
  ]
})
const expandedItem = computed(() =>
  expanded.value ? faultStats.value.top.find(s => s.system === expanded.value) || null : null
)
const recentCases = computed(() => (store.faultCases || []).slice(0, 6))

function toggle(item) {
  expanded.value = expanded.value === item.system ? null : item.system
}

function barWidth(percent) {
  return Math.max(6, Math.round((percent / (faultStats.value.top?.[0]?.percent || 1)) * 100))
}

function barColor(i) {
  const colors = ['#e0413e', '#e0a020', '#0b3a82', '#0bb4c4', '#12a06b', '#8a95a7']
  return colors[i % colors.length]
}
</script>

<style scoped>
.fault-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.fault-bars {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.fault-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 9px;
  cursor: pointer;
  transition: background .2s;
  border: 1px solid transparent;
}

.fault-row:hover { background: var(--chrome-hover); }
.fault-row.active { background: var(--accent-soft); border-color: var(--accent-line); }

.fault-rank {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
}

.fault-rank.rank-1 { background: var(--danger); }
.fault-rank.rank-2 { background: var(--amber); }
.fault-rank.rank-3 { background: var(--accent); }
.fault-rank.rank-4, .fault-rank.rank-5 { background: var(--ink-4); }

.fault-system {
  width: 88px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  flex-shrink: 0;
}

.fault-bar-wrap {
  flex: 1;
  height: 14px;
  background: var(--bg-sunken);
  border-radius: 7px;
  overflow: hidden;
}

.fault-bar {
  height: 100%;
  border-radius: 7px;
  transition: width .6s ease;
  min-width: 6px;
}

.fault-count {
  width: 52px;
  text-align: right;
  font-size: 14px;
  font-weight: 700;
  color: var(--text-1);
  flex-shrink: 0;
}

.fault-percent {
  width: 48px;
  text-align: right;
  font-size: 12px;
  color: var(--text-3);
  flex-shrink: 0;
}

.fault-arrow { color: var(--text-mute); flex-shrink: 0; transition: transform .2s; }
.fault-row.active .fault-arrow { transform: rotate(180deg); }

.fault-samples {
  margin-top: 14px;
  border-top: 1px dashed var(--line);
  padding-top: 12px;
}

.fault-sample-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-1);
  margin-bottom: 10px;
}

.fault-note {
  margin-top: 12px;
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.7;
}

/* 自动沉淀案例卡 */
.cases-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.case-card {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px 14px;
  background: linear-gradient(135deg, var(--card-2), var(--line-2));
  transition: box-shadow .2s, transform .2s;
}
.case-card:hover {
  box-shadow: 0 6px 16px rgba(11, 58, 130, 0.1);
  transform: translateY(-1px);
}
.case-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.case-name {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-1);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.case-date {
  font-size: 11px;
  color: var(--text-3);
}
.case-row {
  display: flex;
  gap: 8px;
  font-size: 12.5px;
  line-height: 1.6;
  margin-bottom: 6px;
}
.case-k {
  flex-shrink: 0;
  width: 26px;
  font-weight: 700;
  color: var(--accent);
}
.case-v {
  color: var(--text-2);
  min-width: 0;
}
.case-foot {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--line);
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  color: var(--text-3);
}
.case-hours { color: var(--accent); }
</style>
