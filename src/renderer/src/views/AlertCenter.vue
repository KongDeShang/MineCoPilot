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
        <div class="dash-label">高危（D 级 / 超期 45 天+ / 极高频故障）</div>
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
        告警全部由本地规则引擎实时计算（不联网、不落库），当前启用 {{ ruleCount }} 条规则：
        D 级 / 健康 C 级 / 健康恶化 / 维保超期 30·45 天 / 高频与极高频故障 / 闲置设备，
        另加按工单判定的复诊逾期与按备件判定的缺料。
        看板上的「严重预警」与本页「高危」取的是同一份规则结果，数字必然一致。
        处置记录仅存本机，用于计算处置率；重置后可重新演示。
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Warning, AlarmClock, Bell, ChatLineRound, DocumentAdd, Refresh, Box, CircleCheck } from '@element-plus/icons-vue'
import { useAppStore } from '../stores/appStore'
import { toAlertRows, listRules } from '../utils/alertRules'
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
//
// ⚠️ 这里**不能**再存本地快照（原来是 `ref(store.getAlertDispositions())`）。
// 本地快照 = 第二个真相源：侧边栏的「重置演示数据」会调 clearAlertDispositions()
// 把库里的记录清空，而**已经挂载的**本页手里那份快照还是重置前的 key 集合，
// 于是界面继续按旧 key 过滤（已处置的行不显示、已处置率按旧数算），
// 只有离开本页再回来才自愈。现在直接绑 store 里那个响应式对象，改哪边都同步。
const doneMap = computed(() => store.alertDispositions || {})

const doneKeys = computed(() => new Set(Object.keys(doneMap.value)))
const doneCount = computed(() => Object.keys(doneMap.value).length)

/**
 * 告警列表。
 *
 * 设备类告警**全部来自 utils/alertRules.js 的规则引擎**：看板的「严重预警」用的是
 * 同一个 scanAlerts 结果的 critical 计数，而本页的「高危」取映射后 level==='danger'
 * 的行 —— 一一对应，两页的数字必然相等，不可能再各算各的。
 *
 * 此前本页内联了第二套扫描，问题有两个：
 *   1) 与看板是两套算法，只是碰巧算出同一个数（cafcd1c 修好字段之后），
 *      任何一边改动都会立刻分叉；
 *   2) 内联那套漏掉了规则引擎里的「高频故障 / 极高频故障 / 闲置设备」——
 *      规则明明命中了，告警中心却看不见，而这些恰恰是最该被处置的设备。
 *
 * 只有下面两类**不是设备规则**（一个按工单判定、一个按备件判定），继续留在本页。
 */
const alerts = computed(() => {
  const list = toAlertRows(store)

  // 必须用本地日期：toISOString 会先转 UTC，东八区早 8 点前算出来的是昨天，
  // 于是"今天到期"的复诊不会被判为逾期——漏提醒，而且是静默的。
  const todayStr = formatDate(new Date())

  // 复诊逾期（工单已闭环但未确认效果）
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

  // 备件缺料（库存 ≤ 安全库存，来自备件台账联动）
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

/**
 * 当前启用的规则条数。
 * 顺带把 alertRules.listRules() 接上界面 —— 它此前没有任何调用方，
 * 界面上能直接看到"引擎里到底跑了几条规则"，规则表也就可被当场确认。
 */
const ruleCount = listRules().length

const handledRate = computed(() => {
  const total = doneCount.value + alerts.value.length
  if (!total) return 100
  return Math.round((doneCount.value / total) * 100)
})

/** 一键生成工单并标记已处理 */
function generateOrder(a) {
  // origin 只进日志（「告警：新建工单 #N「…」」），由 store.addWorkOrder 统一写 ——
  // 原先这条日志写在这里，于是"新建工单"这个动作本身没留痕（P2-2 口径）。
  store.addWorkOrder({
    equipment_name: a.equipment.name,
    title: a.orderTitle,
    type: a.orderType,
    priority: a.orderPriority,
    source: 'alert',
    description: `${a.value}\n建议：${a.suggestion}`
  }, { origin: '告警' })
  // 写处置记录只有**一条**路径：store.setAlertDispositions()。
  // 不直接改 store.alertDispositions 的属性，是为了让"改内存 + 写 meta + scheduleSave"
  // 三件事永远一起发生 —— 直接改属性会写进内存却不落库。
  store.setAlertDispositions({ ...doneMap.value, [a.key]: 'handled' })
  ElMessage.success(`已为 ${a.equipment.name} 生成工单，可到「工单管理」派单处理`)
}

function markDone(a, mode) {
  store.setAlertDispositions({ ...doneMap.value, [a.key]: mode })
  ElMessage.success(mode === 'handled' ? `已标记「${a.equipment.name} · ${a.typeLabel}」为已处理` : `已忽略「${a.equipment.name} · ${a.typeLabel}」`)
}

function resetAll() {
  // 走 store 的清理入口：内存里的响应式对象与库里的 meta 一起清掉，
  // 侧边栏「重置演示数据」用的是同一个入口，两处不会再各清一半。
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
