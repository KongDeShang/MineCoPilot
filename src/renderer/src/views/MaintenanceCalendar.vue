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

      <!-- 图例：只列日历上真会出现的状态。
           level 的取值只有 nodata / overdue / today / upcoming / normal 五种，
           原先的「已完成」没有任何一条计划会产生（日历画的是"下次该保养"，
           保养做没做看工单），而真会出现的「无维保记录」（新录入的设备还没保养过）
           反倒没写 —— 等于图例同时多编了一个状态、漏掉了一个状态。 -->
      <div class="calendar-legend">
        <span class="legend-item"><span class="legend-dot overdue"></span> 已超期</span>
        <span class="legend-item"><span class="legend-dot today"></span> 今日到期</span>
        <span class="legend-item"><span class="legend-dot upcoming"></span> 即将到期</span>
        <span class="legend-item"><span class="legend-dot normal"></span> 计划维保</span>
        <span class="legend-item"><span class="legend-dot nodata"></span> 无维保记录</span>
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
            {{ event.level === 'overdue' ? '紧急建单' : '发起建单' }}
          </el-button>
        </div>
      </div>
      <el-empty v-else description="当日无维保计划" :image-size="60" />
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useAppStore } from '../stores/appStore'
import { dueDate, daysUntilDue } from '../utils/dates'

const store = useAppStore()
const route = useRoute()
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

/**
 * 支持从全局搜索结果直达：跳到该设备的应保养月份并选中那一天。
 * 不做这一步的话，用户搜到一条记录点进来，只会看到"当月"的日历，
 * 而目标设备的到期日可能在好几个月之后 —— 等于什么都没定位到。
 */
function applyFocusQuery() {
  const name = route.query.focus
  if (!name) return
  const target = maintenanceSchedule.value.find(s => s.equipment === String(name))
  router.replace({ path: '/maintenance-calendar' })
  if (!target || !target.dueDate) return
  const [y, m] = String(target.dueDate).split('-').map(Number)
  if (!y || !m) return
  currentYear.value = y
  currentMonth.value = m
  selectedDate.value = {
    dateStr: target.dueDate,
    events: maintenanceSchedule.value.filter(s => s.dueDate === target.dueDate)
  }
}

onMounted(applyFocusQuery)
watch(() => route.query.focus, applyFocusQuery)

/**
 * 把维保计划带到工单页并预填建单表单。
 *
 * 这里**不建单**：工单要选优先级、指派负责人，交给工单页的建单表单确认更合适。
 * 原先的文案写成"由维保日历发起工单…"、提示"正在创建工单…"，
 * 但工单此时并不存在 —— 操作日志里会多出一条查无此单的记录，
 * 用户若没在工单页点保存，日志就成了假的。文案按实际动作说。
 */
function createWorkOrder(event) {
  store.addLog({
    content: `维保日历发起建单：${event.equipment} ${event.type}（已带入工单页，待确认保存）`,
    source: '日历',
    type: event.level === 'overdue' ? 'danger' : 'primary',
    tagType: event.level === 'overdue' ? 'danger' : 'primary'
  })
  ElMessage.success(`已带出「${event.equipment}」的建单表单，确认后保存即建单`)
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
  background: var(--card-2);
  border-radius: 8px;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-2);
}

.legend-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.legend-dot.overdue { background: var(--danger); }
.legend-dot.today { background: var(--accent); }
.legend-dot.upcoming { background: var(--amber); }
.legend-dot.normal { background: var(--ink-4); }
/* 空心点对应日历格子里那条虚线边（.event-tag.nodata），一眼能对上"这条没数据" */
.legend-dot.nodata { background: transparent; border: 1px dashed var(--text-3); }

.calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 1px;
  background: var(--line);
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
}

.weekday-header {
  text-align: center;
  padding: 10px;
  background: var(--line-2);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
}

.calendar-cell {
  min-height: 90px;
  padding: 6px 8px;
  background: var(--card);
  cursor: pointer;
  transition: background 0.2s;
}

.calendar-cell:hover {
  background: var(--accent-soft);
}

.calendar-cell.is-other-month {
  background: var(--card-2);
  opacity: 0.5;
}

.calendar-cell.is-today {
  background: var(--accent-soft);
}

.cell-date {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
  margin-bottom: 4px;
}

.cell-date.today-badge {
  display: inline-block;
  width: 24px;
  height: 24px;
  line-height: 24px;
  text-align: center;
  border-radius: 50%;
  background: var(--accent);
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
  background: var(--danger-soft);
  color: var(--danger-ink);
  border: 1px solid var(--danger-line);
}

.event-tag.today {
  background: var(--accent-soft);
  color: var(--accent);
  border: 1px solid var(--accent-line);
}

.event-tag.upcoming {
  background: var(--amber-soft);
  color: var(--warn-ink);
  border: 1px solid var(--amber-soft);
}

.event-tag.normal {
  background: var(--line-2);
  color: var(--text-3);
  border: 1px solid var(--line-2);
}

.event-tag.nodata {
  background: var(--line-2);
  /* 里面写的是设备名，属正文不是占位符 —— --text-mute 规范上只留给占位/分隔/网格线。
     边线取 --line-strong：原来用的 --line-2 和底色同值，等于没有边框，
     虚线这个"没数据"的视觉信号其实是看不见的。 */
  color: var(--text-3);
  border: 1px dashed var(--line-strong);
}

.event-more {
  font-size: 11px;
  color: var(--text-3);
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
  background: var(--card-2);
}

.detail-item.overdue {
  background: var(--danger-soft);
  border: 1px solid var(--danger-line);
}

.detail-status {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.detail-status.overdue { background: var(--danger); }
.detail-status.upcoming { background: var(--amber); }
.detail-status.normal { background: var(--accent); }

.detail-info { flex: 1; }

.detail-equipment {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1);
  margin-bottom: 4px;
}

.detail-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--text-3);
}
</style>
