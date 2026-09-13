<template>
  <div class="maintenance-calendar">
    <el-card>
      <template #header>
        <div class="card-header">
          <span><el-icon><Calendar /></el-icon> 维保日历</span>
          <div class="header-controls">
            <el-button-group>
              <el-button @click="prevMonth" icon="ArrowLeft" size="small" />
              <el-button size="small" disabled>{{ currentYear }}年{{ currentMonth }}月</el-button>
              <el-button @click="nextMonth" icon="ArrowRight" size="small" />
            </el-button-group>
            <el-button size="small" @click="goToday" style="margin-left: 8px">今天</el-button>
          </div>
        </div>
      </template>

      <!-- 图例 -->
      <div class="calendar-legend">
        <span class="legend-item"><span class="legend-dot overdue"></span> 已超期</span>
        <span class="legend-item"><span class="legend-dot today"></span> 今日到期</span>
        <span class="legend-item"><span class="legend-dot upcoming"></span> 即将到期</span>
        <span class="legend-item"><span class="legend-dot normal"></span> 计划维保</span>
        <span class="legend-item"><span class="legend-dot completed"></span> 已完成</span>
      </div>

      <!-- 日历主体 -->
      <div class="calendar-grid">
        <!-- 星期头 -->
        <div class="weekday-header" v-for="day in weekdays" :key="day">{{ day }}</div>

        <!-- 日期格子 -->
        <div
          v-for="(cell, i) in calendarCells"
          :key="i"
          class="calendar-cell"
          :class="{
            'is-today': cell.isToday,
            'is-other-month': cell.isOtherMonth,
            'has-events': cell.events.length > 0
          }"
          @click="selectDate(cell)"
        >
          <div class="cell-date" :class="{ 'today-badge': cell.isToday }">
            {{ cell.day }}
          </div>
          <div class="cell-events">
            <div
              v-for="(event, j) in cell.events.slice(0, 3)"
              :key="j"
              class="event-tag"
              :class="event.level"
              :title="event.equipment + ' - ' + event.type"
            >
              {{ event.equipment }}
            </div>
            <div v-if="cell.events.length > 3" class="event-more">
              +{{ cell.events.length - 3 }} 更多
            </div>
          </div>
        </div>
      </div>
    </el-card>

    <!-- 选中日期的详情 -->
    <el-card v-if="selectedDate" style="margin-top: 20px">
      <template #header>
        <div class="card-header">
          <span>{{ selectedDate.dateStr }} 维保计划</span>
          <el-tag :type="selectedDate.events.length > 0 ? 'primary' : 'info'" size="small">
            {{ selectedDate.events.length }} 条记录
          </el-tag>
        </div>
      </template>
      <div v-if="selectedDate.events.length > 0" class="date-detail">
        <div v-for="(event, i) in selectedDate.events" :key="i" class="detail-item" :class="event.level">
          <div class="detail-status" :class="event.level"></div>
          <div class="detail-info">
            <div class="detail-equipment">{{ event.equipment }}</div>
            <div class="detail-meta">
              <el-tag :type="event.tagType" size="small">{{ event.type }}</el-tag>
              <span>上次维保：{{ event.lastDate || '无记录' }}</span>
              <span>周期：{{ event.cycle }}天</span>
              <span v-if="event.dueDate">到期日：{{ event.dueDate }}</span>
              <span v-if="event.daysUntil !== null">
                {{ event.daysUntil < 0 ? `已超期 ${Math.abs(event.daysUntil)} 天` : `还剩 ${event.daysUntil} 天` }}
              </span>
            </div>
          </div>
          <el-button type="primary" size="small" @click="createWorkOrder(event)">
            {{ event.level === 'overdue' ? '紧急建单' : '创建工单' }}
          </el-button>
        </div>
      </div>
      <el-empty v-else description="当日无维保计划" :image-size="60" />
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useAppStore } from '../stores/appStore'
import { dueDate, daysUntilDue } from '../utils/dates'

const store = useAppStore()
const router = useRouter()
const weekdays = ['日', '一', '二', '三', '四', '五', '六']

// 默认打开今天所在的月份（不再写死演示月份）
const today = new Date()
const currentYear = ref(today.getFullYear())
const currentMonth = ref(today.getMonth() + 1)
const selectedDate = ref(null)

// 从台账生成维保计划
const maintenanceSchedule = computed(() => {
  return store.equipmentList.map(eq => {
    const daysUntil = daysUntilDue(eq.last_maintenance_date, eq.maintenance_cycle_days)
    const dueDateStr = dueDate(eq.last_maintenance_date, eq.maintenance_cycle_days)
    let level = 'normal'
    let tagType = 'primary'
    if (daysUntil === null) {
      level = 'nodata'
      tagType = 'info'
    } else if (daysUntil < 0) {
      level = 'overdue'
      tagType = 'danger'
    } else if (daysUntil === 0) {
      level = 'today'
      tagType = 'primary'
    } else if (daysUntil <= 7) {
      level = 'upcoming'
      tagType = 'warning'
    }
    return {
      equipmentId: eq.id,
      equipment: eq.name,
      type: eq.maintenance_cycle_days <= 30 ? '月度保养' : '定期保养',
      lastDate: eq.last_maintenance_date,
      cycle: eq.maintenance_cycle_days,
      dueDate: dueDateStr,
      daysUntil,
      level,
      tagType
    }
  })
})

// 生成日历数据
const calendarCells = computed(() => {
  const year = currentYear.value
  const month = currentMonth.value
  const firstDay = new Date(year, month - 1, 1)
  const lastDay = new Date(year, month, 0)
  const startDay = firstDay.getDay()
  const totalDays = lastDay.getDate()

  const cells = []

  // 上月填充
  const prevMonthLast = new Date(year, month - 1, 0).getDate()
  for (let i = startDay - 1; i >= 0; i--) {
    cells.push({
      day: prevMonthLast - i,
      date: new Date(year, month - 2, prevMonthLast - i),
      isOtherMonth: true,
      isToday: false,
      events: []
    })
  }

  // 本月
  const now = new Date()
  for (let d = 1; d <= totalDays; d++) {
    const date = new Date(year, month - 1, d)
    const isToday = date.toDateString() === now.toDateString()

    // 当天的维保事件 = 到期日落在这一天的设备
    const events = []
    for (const item of maintenanceSchedule.value) {
      if (item.dueDate === formatCellDate(date)) events.push(item)
    }

    // 超期设备在今天统一汇总提醒
    if (isToday) {
      for (const item of maintenanceSchedule.value) {
        if (item.level !== 'overdue') continue
        if (events.find(e => e.equipment === item.equipment)) continue
        events.push({ ...item, type: `${item.type}（已超期${Math.abs(item.daysUntil)}天）` })
      }
    }

    cells.push({ day: d, date, isOtherMonth: false, isToday, events })
  }

  // 下月填充
  const remaining = 42 - cells.length
  for (let d = 1; d <= remaining; d++) {
    cells.push({
      day: d,
      date: new Date(year, month, d),
      isOtherMonth: true,
      isToday: false,
      events: []
    })
  }

  return cells
})

function formatCellDate(date) {
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${m}-${d}`
}

function prevMonth() {
  if (currentMonth.value === 1) {
    currentMonth.value = 12
    currentYear.value--
  } else {
    currentMonth.value--
  }
  selectedDate.value = null
}

function nextMonth() {
  if (currentMonth.value === 12) {
    currentMonth.value = 1
    currentYear.value++
  } else {
    currentMonth.value++
  }
  selectedDate.value = null
}

function goToday() {
  const now = new Date()
  currentYear.value = now.getFullYear()
  currentMonth.value = now.getMonth() + 1
  selectedDate.value = null
}

function selectDate(cell) {
  if (!cell.day) return
  const dateStr = cell.isOtherMonth
    ? formatCellDate(cell.date)
    : `${currentYear.value}-${String(currentMonth.value).padStart(2, '0')}-${String(cell.day).padStart(2, '0')}`
  selectedDate.value = { dateStr, events: cell.events }
}

/** 一键把维保计划变成工单，带到工单页并自动预填 */
function createWorkOrder(event) {
  store.addLog({
    content: `由维保日历发起工单：${event.equipment} ${event.type}`,
    source: '日历',
    type: event.level === 'overdue' ? 'danger' : 'primary',
    tagType: event.level === 'overdue' ? 'danger' : 'primary'
  })
  ElMessage.success(`正在为「${event.equipment}」创建工单…`)
  router.push({
    path: '/workorder',
    query: {
      new: event.equipment,
      type: event.level === 'overdue' ? 'repair' : 'maintenance'
    }
  })
}
</script>

<style scoped>
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.calendar-legend {
  display: flex;
  gap: 20px;
  margin-bottom: 16px;
  padding: 10px 16px;
  background: #f8f9fa;
  border-radius: 8px;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #606266;
}

.legend-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.legend-dot.overdue { background: #f56c6c; }
.legend-dot.today { background: #409eff; }
.legend-dot.upcoming { background: #e6a23c; }
.legend-dot.normal { background: #909399; }
.legend-dot.completed { background: #67c23a; }

.calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 1px;
  background: #e4e7ed;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  overflow: hidden;
}

.weekday-header {
  text-align: center;
  padding: 10px;
  background: #f5f7fa;
  font-size: 13px;
  font-weight: 600;
  color: #606266;
}

.calendar-cell {
  min-height: 90px;
  padding: 6px 8px;
  background: #fff;
  cursor: pointer;
  transition: background 0.2s;
}

.calendar-cell:hover {
  background: #ecf5ff;
}

.calendar-cell.is-other-month {
  background: #fafafa;
  opacity: 0.5;
}

.calendar-cell.is-today {
  background: #ecf5ff;
}

.cell-date {
  font-size: 14px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 4px;
}

.cell-date.today-badge {
  display: inline-block;
  width: 24px;
  height: 24px;
  line-height: 24px;
  text-align: center;
  border-radius: 50%;
  background: #409eff;
  color: white;
}

.cell-events {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.event-tag {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.event-tag.overdue {
  background: #fef0f0;
  color: #f56c6c;
  border: 1px solid #fde2e2;
}

.event-tag.today {
  background: #ecf5ff;
  color: #409eff;
  border: 1px solid #d9ecff;
}

.event-tag.upcoming {
  background: #fdf6ec;
  color: #e6a23c;
  border: 1px solid #faecd8;
}

.event-tag.normal {
  background: #f4f4f5;
  color: #909399;
  border: 1px solid #e9e9eb;
}

.event-tag.nodata {
  background: #f4f4f5;
  color: #c0c4cc;
  border: 1px dashed #e9e9eb;
}

.event-more {
  font-size: 11px;
  color: #909399;
  text-align: center;
}

.date-detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.detail-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px;
  border-radius: 8px;
  background: #f8f9fa;
}

.detail-item.overdue {
  background: #fef0f0;
  border: 1px solid #fde2e2;
}

.detail-status {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.detail-status.overdue { background: #f56c6c; }
.detail-status.upcoming { background: #e6a23c; }
.detail-status.normal { background: #409eff; }

.detail-info { flex: 1; }

.detail-equipment {
  font-size: 15px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 4px;
}

.detail-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: #909399;
}
</style>
