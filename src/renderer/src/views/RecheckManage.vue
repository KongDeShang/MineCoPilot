<template>
  <div class="recheck-page">
    <!-- 闭环率指标 -->
    <StatCards :items="statItems" :span="6" />

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
        <el-table-column label="操作" width="280" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="success" plain @click="markDone(row)">标记已复诊</el-button>
            <el-button size="small" type="danger" plain @click="markFailed(row)">未通过</el-button>
            <el-button size="small" link type="info" @click="markSkip(row)">无需复诊</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="recheck-note">
        复诊是"设备健康智能体"闭环的关键一环：体检发现问题 → 开工单治疗 → 到期复查 → 确认康复归档；
        <strong>复查没通过</strong>就点「未通过」，系统会重新开一张维修工单，闭环继续往下走。
        闭环率就是"处方没有开完就结束"的比例，评委看到的是完整的医疗式管理思维。
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { confirmAction } from '../utils/confirmAction'
import { useAppStore } from '../stores/appStore'
import StatCards from '../components/StatCards.vue'
import { now } from '../utils/dates'

const store = useAppStore()

const recheckList = computed(() => store.recheckList)
const recheckStats = computed(() => store.recheckStats)

const statItems = computed(() => {
  const s = recheckStats.value
  return [
    { label: '应复诊任务', value: s.due || 0 },
    // 这三个色是落在白底上当"文字"用的，必须取 —*-ink；
    // 原来的 #12a06b / #e0a020 / #0bb4c4 是"面色"，实测 2.28~3.26:1
    { label: '已完成复诊', value: s.done || 0, color: 'var(--success-ink)' },
    { label: '待复诊', value: s.pending || 0, color: 'var(--warn-ink)' },
    { label: '复诊闭环率', value: s.rate != null ? s.rate + '%' : '—', color: 'var(--signal-ink)' }
  ]
})

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

/**
 * 复诊未通过：把本次复诊结掉，并按同一台设备重新开一张维修工单。
 *
 * 这是闭环"复诊仍异常 → 再开工单"的入口。原先只有"标记已复诊 / 无需复诊"，
 * 复诊查出没修好之后没有去处，闭环实际到复诊就停了。
 */
async function markFailed(row) {
  // 取消与失败的区分统一在 utils/confirmAction.js：原来那个空 catch 会把
  // recheckFailedAndReopen（写工单 + 写健康快照 + 落盘）的异常一起吞掉，
  // 用户点了"重新开工单"却什么也没发生。
  await confirmAction(
    ElMessageBox.confirm(
      `复诊确认「${row.equipment_name}」仍未恢复正常？<br/>将重新开一张维修工单（7 天后再次复诊），并把本次复诊标记为已完成。`,
      '复诊未通过',
      {
        type: 'warning',
        dangerouslyUseHTMLString: true,
        confirmButtonText: '重新开工单',
        cancelButtonText: '取消'
      }
    ),
    () => {
      const order = store.recheckFailedAndReopen(row.id)
      if (!order) {
        ElMessage.warning('这条复诊任务已经处理过了，请刷新后重试')
        return
      }
      ElMessage.success(`已重新开出工单 #${order.id}，可到「工单管理」派单处理`)
    },
    { label: '重新开工单' }
  )
}
</script>

<style scoped>
.recheck-page {
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

.recheck-note {
  margin-top: 12px;
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.7;
}
</style>
