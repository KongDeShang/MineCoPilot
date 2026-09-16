<template>
  <div class="alert-center">
    <!-- 顶部仪表 -->
    <div class="alert-dash">
      <div class="dash-item dash-total">
        <div class="dash-value"><AnimatedNumber :value="alerts.length" /></div>
        <div class="dash-label">未处置告警</div>
      </div>
      <div class="dash-item dash-high">
        <div class="dash-value"><AnimatedNumber :value="highCount" /></div>
        <div class="dash-label">高危（D级 / 超期45天+）</div>
      </div>
      <div class="dash-item dash-rate">
        <div class="dash-value"><AnimatedNumber :value="handledRate" />%</div>
        <div class="dash-label">已处置率</div>
      </div>
      <div class="dash-item dash-action">
        <el-button size="small" @click="resetAll" :disabled="doneCount === 0">
          <el-icon><Refresh /></el-icon> 重置处置记录
        </el-button>
        <div class="dash-note">规则引擎实时扫描 · 数据不出本机</div>
      </div>
    </div>

    <!-- 告警时间线 -->
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span><el-icon><Bell /></el-icon> 告警时间线（按风险从高到低）</span>
          <el-tag size="small" type="info" effect="plain">每条告警可一键生成工单 → 进入运维闭环</el-tag>
        </div>
      </template>

      <!-- 原先描述末尾挂了个 🎉。el-empty 自带的插图已经在表达"空/正常"，
           文案本身也写全了，这个 emoji 属于纯装饰，删掉即可，不必再配图标。 -->
      <el-empty v-if="alerts.length === 0" description="暂无未处置告警，设备状态良好" />

      <div v-else class="alert-list">
        <div v-for="a in alerts" :key="a.key" class="alert-row" :class="a.level">
          <div class="alert-bar"></div>
          <div class="alert-icon">
            <el-icon :size="18"><Warning v-if="a.level === 'danger'" /><AlarmClock v-else /></el-icon>
          </div>
          <div class="alert-photo">
            <img :src="equipmentPhoto(a.equipment.category)" :alt="a.equipment.name" />
          </div>
          <div class="alert-main">
            <div class="alert-head">
              <el-tag size="small" :type="a.level === 'danger' ? 'danger' : 'warning'" effect="dark">{{ a.typeLabel }}</el-tag>
              <span class="alert-name">{{ a.equipment.name }}</span>
              <span class="alert-model">{{ a.equipment.model || '' }}</span>
            </div>
            <div class="alert-value">{{ a.value }}</div>
            <div class="alert-suggest"><el-icon><ChatLineRound /></el-icon> {{ a.suggestion }}</div>
          </div>
          <div class="alert-time">今日扫描发现</div>
          <div class="alert-actions">
            <el-button v-if="a.typeLabel === '备件缺料'" type="warning" size="small" plain @click="goParts">
              <el-icon><Box /></el-icon> 去补货
            </el-button>
            <!-- 复诊逾期不给"生成工单"：正确动作是先复诊，未通过再重开单。
                直接在此建单会绕开原复诊任务，把它一直挂在"待复诊"里。 -->
            <el-button v-if="a.typeLabel === '复诊逾期'" type="warning" size="small" plain @click="goRecheck">
              <el-icon><CircleCheck /></el-icon> 去复诊
            </el-button>
            <el-button v-if="a.orderTitle" type="primary" size="small" plain @click="generateOrder(a)">
              <el-icon><DocumentAdd /></el-icon> 生成工单
            </el-button>
            <el-button type="success" size="small" link @click="markDone(a, 'handled')">标记已处理</el-button>
            <el-button type="info" size="small" link @click="markDone(a, 'ignored')">忽略</el-button>
          </div>
        </div>
      </div>

      <div class="alert-note">
        告警全部由本地规则引擎实时计算（不联网、不落库）：D 级设备 / 维保超期 / 健康恶化 / 复诊逾期。
        处置记录仅存本机，用于计算处置率；重置后可重新演示。
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Warning, AlarmClock, Bell, ChatLineRound, DocumentAdd, Refresh, Box, CircleCheck } from '@element-plus/icons-vue'
import { useAppStore } from '../stores/appStore'
import { evaluateHealth } from '../utils/health'
import { equipmentPhoto } from '../utils/equipmentPhoto'
import { formatDate } from '../utils/dates'
import AnimatedNumber from '../components/AnimatedNumber.vue'

const store = useAppStore()
const router = useRouter()

function goParts() {
  router.push('/parts-inventory')
}

function goRecheck() {
  router.push('/recheck')
}

// 处置记录落在本地库 meta（随备份包一起迁移、随"重置演示数据"一起清空），
// 不再用 localStorage——那样换台电脑就丢，已处理的告警会在新机器上"复活"。
const doneMap = ref(store.getAlertDispositions())

function saveDone() {
  store.setAlertDispositions(doneMap.value)
}

const doneKeys = computed(() => new Set(Object.keys(doneMap.value)))
const doneCount = computed(() => Object.keys(doneMap.value).length)

/** 规则引擎实时扫描全部告警 */
const alerts = computed(() => {
  const list = []
  // 必须用本地日期：toISOString 会先转 UTC，东八区早 8 点前算出来的是昨天，
  // 于是"今天到期"的复诊不会被判为逾期——漏提醒，而且是静默的。
  const todayStr = formatDate(new Date())

  // 1) D 级设备（最高优先级）
  for (const e of store.criticalList) {
    const h = evaluateHealth(e)
    list.push({
      key: `critical:${e.id}`,
      level: 'danger',
      typeLabel: 'D 级设备',
      equipment: e,
      value: `健康分 ${h.score} · ${h.levelLabel}${e.last_maintenance_date ? ` · 上次维保 ${e.last_maintenance_date}` : ''}`,
      suggestion: '需立即处置：停机检查、排查原因并派维修工单',
      orderTitle: `${e.name} 健康分低（${h.score} 分 D 级），需立即排查处置`,
      orderType: 'repair',
      orderPriority: 'urgent',
      sortWeight: 1000 + (100 - h.score)
    })
  }

  // 2) 维保超期
  for (const e of store.overdueList) {
    list.push({
      key: `overdue:${e.id}`,
      level: e.overdueDays > 45 ? 'danger' : 'warning',
      typeLabel: '维保超期',
      equipment: e,
      value: `已超期 ${e.overdueDays} 天（上次维保 ${e.last_maintenance_date}）`,
      suggestion: `安排 ${e.name} 进站保养，避免健康分持续下降`,
      orderTitle: `${e.name} 维保超期 ${e.overdueDays} 天，安排保养`,
      orderType: 'maintenance',
      orderPriority: e.overdueDays > 45 ? 'urgent' : 'high',
      sortWeight: 500 + e.overdueDays
    })
  }

  // 3) 健康持续恶化（与 D 级去重）
  for (const e of store.worseningList) {
    if (list.some(a => a.typeLabel === 'D 级设备' && a.equipment.id === e.id)) continue
    list.push({
      key: `worsening:${e.id}`,
      level: 'warning',
      typeLabel: '健康恶化',
      equipment: e,
      value: '健康分连续下降，趋势预警',
      suggestion: `关注 ${e.name} 下降趋势，建议安排一次体检评估`,
      orderTitle: `${e.name} 健康分持续下降，安排体检评估`,
      orderType: 'maintenance',
      orderPriority: 'high',
      sortWeight: 300
    })
  }

  // 4) 复诊逾期（工单已闭环但未确认效果）
  for (const o of store.workOrders) {
    if (o.recheck_status === 'pending' && o.recheck_date && o.recheck_date < todayStr) {
      const eq = store.getEquipmentByName(o.equipment_name)
      list.push({
        key: `recheck:${o.id}`,
        level: 'warning',
        typeLabel: '复诊逾期',
        equipment: eq || { name: o.equipment_name || '未知设备', category: '', model: '' },
        value: `工单 #${o.id}「${o.title}」应复诊 ${o.recheck_date} 已逾期`,
        suggestion: '复诊确认处置效果；未通过需重新派单处理',
        orderTitle: '',
        orderType: 'inspection',
        orderPriority: 'high',
        sortWeight: 400
      })
    }
  }

  // 5) 备件缺料（库存 ≤ 安全库存，来自备件台账联动）
  for (const p of store.lowStockParts) {
    list.push({
      key: `part:${p.id}`,
      level: 'warning',
      typeLabel: '备件缺料',
      equipment: { name: p.name, category: '', model: `类别：${p.category}` },
      value: `库存 ${p.stock} / 安全库存 ${p.safety_stock} ${p.unit}`,
      suggestion: `建议立即补货至 ${p.safety_stock * 2} ${p.unit}，缺料会拖累维保排期`,
      orderTitle: '',
      orderType: 'maintenance',
      orderPriority: 'high',
      sortWeight: 200
    })
  }

  return list
    .filter(a => !doneKeys.value.has(a.key))
    .sort((a, b) => b.sortWeight - a.sortWeight)
})

const highCount = computed(() => alerts.value.filter(a => a.level === 'danger').length)

const handledRate = computed(() => {
  const total = doneCount.value + alerts.value.length
  if (!total) return 100
  return Math.round((doneCount.value / total) * 100)
})

/** 一键生成工单并标记已处理 */
function generateOrder(a) {
  store.addWorkOrder({
    equipment_name: a.equipment.name,
    title: a.orderTitle,
    type: a.orderType,
    priority: a.orderPriority,
    source: 'alert',
    description: `${a.value}\n建议：${a.suggestion}`
  })
  doneMap.value[a.key] = 'handled'
  saveDone()
  store.addLog({ content: `告警中心：为「${a.equipment.name}」生成工单「${a.orderTitle}」`, source: '告警', type: 'warning', tagType: 'warning' })
  ElMessage.success(`已为 ${a.equipment.name} 生成工单，可到「工单管理」派单处理`)
}

function markDone(a, mode) {
  doneMap.value[a.key] = mode
  saveDone()
  ElMessage.success(mode === 'handled' ? `已标记「${a.equipment.name} · ${a.typeLabel}」为已处理` : `已忽略「${a.equipment.name} · ${a.typeLabel}」`)
}

function resetAll() {
  doneMap.value = {}
  store.clearAlertDispositions()
  ElMessage.success('已重置全部处置记录，告警重新扫描')
}
</script>

<style scoped>
.alert-center {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 顶部仪表 */
.alert-dash {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.dash-item {
  flex: 1 1 150px;
  min-width: 130px;
  border-radius: 12px;
  padding: 14px 18px;
  color: #fff;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dash-total { background: linear-gradient(120deg, #0b3a82, #1457b3); }
.dash-high { background: linear-gradient(120deg, #b91c1c, #e0413e); }
/* 白字一律走 .dash-label 的 opacity:0.88 / .dash-unit 的 0.85，
   而 #22a55f 这一端太亮：即便文字用纯白也只有 3.9:1，是**底色**不达标，改文字色没用。
   前面叠一层 rgba(0,0,0,.3) 把整条渐变压深一档 —— 用叠层而不是换色标，
   是为了保住这个"成功绿"的色相（换深色标会滑向墨绿，和 .dash-total 的亮蓝不成一组）。
   压深后标签 4.9:1、数字 5.8:1。 */
.dash-rate { background: linear-gradient(rgba(0, 0, 0, 0.3), rgba(0, 0, 0, 0.3)), linear-gradient(120deg, #15803d, #22a55f); }
.dash-action {
  background: var(--card);
  border: 1px solid var(--line-2);
  color: var(--text-1);
  justify-content: center;
}
.dash-value { font-size: 26px; font-weight: 800; line-height: 1; }
.dash-label { font-size: 12px; opacity: 0.88; }
.dash-note { font-size: 11px; color: var(--text-3); margin-top: 4px; }

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

/* 告警时间线 */
.alert-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.alert-row {
  display: flex;
  align-items: center;
  gap: 12px;
  border: 1px solid var(--line-2);
  border-radius: 10px;
  padding: 10px 12px;
  background: var(--card);
  position: relative;
  overflow: hidden;
  transition: box-shadow 0.2s;
}
.alert-row:hover {
  box-shadow: 0 4px 14px var(--accent-shadow);
}
.alert-bar {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
}
.alert-row.danger .alert-bar { background: var(--danger); }
.alert-row.warning .alert-bar { background: var(--amber); }
.alert-icon {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.alert-row.danger .alert-icon { background: rgba(224, 65, 62, 0.12); color: var(--danger-ink); }
.alert-row.warning .alert-icon { background: rgba(224, 160, 32, 0.12); color: var(--warn-ink); }
.alert-photo {
  width: 64px;
  height: 44px;
  border-radius: 6px;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--bg-sunken);
}
.alert-photo img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.alert-main {
  flex: 1;
  min-width: 0;
}
.alert-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.alert-name {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-1);
}
.alert-model {
  font-size: 11px;
  color: var(--text-3);
}
.alert-value {
  font-size: 12.5px;
  color: var(--text-2);
  margin-top: 4px;
}
.alert-suggest {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-3);
  margin-top: 3px;
}
.alert-time {
  font-size: 11px;
  /* 时间戳是正文信息，不是占位符 —— --text-mute 规范上只留给占位/分隔/网格线，实测 4.34:1 差一点 */
  color: var(--text-3);
  flex-shrink: 0;
}
.alert-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.alert-note {
  margin-top: 14px;
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.7;
  background: var(--line-2);
  border-radius: 8px;
  padding: 8px 12px;
}
</style>
