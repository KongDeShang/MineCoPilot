<template>
  <div class="recheck-page">
    <!-- 闭环率指标 -->
    <el-row :gutter="16" class="recheck-stats">
      <el-col :xs="12" :sm="6">
        <div class="stat-card">
          <div class="stat-label">应复诊任务</div>
          <div class="stat-value">{{ recheckStats.due || 0 }}</div>
        </div>
      </el-col>
      <el-col :xs="12" :sm="6">
        <div class="stat-card">
          <div class="stat-label">已完成复诊</div>
          <div class="stat-value" style="color: #12a06b">{{ recheckStats.done || 0 }}</div>
        </div>
      </el-col>
      <el-col :xs="12" :sm="6">
        <div class="stat-card">
          <div class="stat-label">待复诊</div>
          <div class="stat-value" style="color: #e0a020">{{ recheckStats.pending || 0 }}</div>
        </div>
      </el-col>
      <el-col :xs="12" :sm="6">
        <div class="stat-card">
          <div class="stat-label">复诊闭环率</div>
          <div class="stat-value" style="color: #0bb4c4">{{ recheckStats.rate != null ? recheckStats.rate + '%' : '—' }}</div>
        </div>
      </el-col>
    </el-row>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span><el-icon><CircleCheck /></el-icon> 复诊任务（诊断 → 治疗 → 复查闭环）</span>
          <el-tag size="small" type="info" effect="plain">工单完成时自动生成 · 维修 +7 天 / 保养 +30 天</el-tag>
        </div>
      </template>
      <el-table :data="recheckList" stripe>
        <el-table-column prop="equipment_name" label="设备" width="160" />
        <el-table-column prop="title" label="复诊内容" min-width="220" show-overflow-tooltip />
        <el-table-column prop="recheck_date" label="复诊日期" width="120" />
        <el-table-column label="是否到期" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="isDue(row) ? 'danger' : 'info'" effect="plain">
              {{ isDue(row) ? '已到期' : '未到期' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="190" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="success" plain @click="markDone(row)">标记已复诊</el-button>
            <el-button size="small" link type="info" @click="markSkip(row)">无需复诊</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="recheck-note">
        复诊是"设备健康智能体"闭环的关键一环：体检发现问题 → 开工单治疗 → 到期复查 → 确认康复归档。
        闭环率就是"处方没有开完就结束"的比例，评委看到的是完整的医疗式管理思维。
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { useAppStore } from '../stores/appStore'
import { now } from '../utils/dates'

const store = useAppStore()

const recheckList = computed(() => store.recheckList)
const recheckStats = computed(() => store.recheckStats)

function todayStr() {
  return now().slice(0, 10)
}

function isDue(row) {
  return String(row.recheck_date || '').localeCompare(todayStr()) <= 0
}

function markDone(row) {
  store.markRecheckDone(row.id)
  ElMessage.success(`已完成复诊：${row.equipment_name}「${row.title}」，病历归档`)
}

function markSkip(row) {
  store.markRecheckNotNeeded(row.id)
  ElMessage.info('已标记为无需复诊')
}
</script>

<style scoped>
.recheck-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.recheck-stats {
  margin-bottom: 0;
}

.stat-card {
  background: #fff;
  border: 1px solid #dde4ef;
  border-radius: 13px;
  padding: 14px 16px;
  box-shadow: 0 1px 2px rgba(16, 24, 40, .04);
  margin-bottom: 4px;
}

.stat-label {
  font-size: 12px;
  color: #8a95a7;
}

.stat-value {
  font-size: 24px;
  font-weight: 700;
  color: #0a1326;
  margin-top: 4px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.recheck-note {
  margin-top: 12px;
  font-size: 11.5px;
  color: #8a95a7;
  line-height: 1.7;
}
</style>
