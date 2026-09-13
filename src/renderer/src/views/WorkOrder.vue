<template>
  <div class="workorder">
    <el-card>
      <template #header>
        <div class="card-header">
          <span><el-icon><EditPen /></el-icon> 工单管理</span>
          <div>
            <el-radio-group v-model="statusFilter" size="small">
              <el-radio-button label="">全部 ({{ orders.length }})</el-radio-button>
              <el-radio-button label="pending">待派单 ({{ stats.pending }})</el-radio-button>
              <el-radio-button label="assigned">已派单 ({{ stats.assigned }})</el-radio-button>
              <el-radio-button label="processing">处理中 ({{ stats.processing }})</el-radio-button>
              <el-radio-button label="completed">已完成 ({{ stats.completed }})</el-radio-button>
            </el-radio-group>
            <el-button type="primary" style="margin-left: 12px" @click="openCreate">
              <el-icon><Plus /></el-icon> 新建工单
            </el-button>
          </div>
        </div>
      </template>

      <el-table :data="filteredOrders" stripe border style="width: 100%">
        <template #empty>
          <div class="empty-state">
            <el-icon :size="48" color="#c0c4cc"><EditPen /></el-icon>
            <p class="empty-title">暂无工单数据</p>
            <p class="empty-desc">点击"新建工单"创建第一张工单，或通过语音/拍照快速创建</p>
          </div>
        </template>
        <el-table-column prop="id" label="工单号" width="80" />
        <el-table-column prop="title" label="标题" min-width="200" />
        <el-table-column prop="equipment_name" label="关联设备" width="140">
          <template #default="{ row }">
            <span class="clickable-link" @click="goToEquipment(row.equipment_name)">{{ row.equipment_name }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="type" label="类型" width="100">
          <template #default="{ row }">
            <el-tag :type="typeTag(row.type)">{{ typeLabel(row.type) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="priority" label="优先级" width="80">
          <template #default="{ row }">
            <el-tag :type="priorityTag(row.priority)" effect="dark" size="small">
              {{ priorityLabel(row.priority) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="statusTag(row.status)">{{ statusLabel(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="source" label="来源" width="80">
          <template #default="{ row }">
            <el-tag type="info" effect="plain" size="small">{{ sourceLabel(row.source) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="created_at" label="创建时间" width="160" />
        <el-table-column label="复诊" width="90">
          <template #default="{ row }">
            <el-tag v-if="row.recheck_status === 'pending'" type="warning" size="small">待复诊</el-tag>
            <el-tag v-else-if="row.recheck_status === 'done'" type="success" size="small">已复诊</el-tag>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" size="small" link @click.stop="openDetail(row)">详情</el-button>
            <el-button
              v-if="row.status === 'pending'"
              type="warning"
              size="small"
              link
              @click.stop="openDispatch(row)"
            >派单</el-button>
            <el-button
              v-if="row.status === 'assigned'"
              type="success"
              size="small"
              link
              @click="updateStatus(row, 'processing')"
            >开始处理</el-button>
            <el-button
              v-if="row.status === 'processing'"
              type="success"
              size="small"
              link
              @click="updateStatus(row, 'completed')"
            >完成</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 工单详情抽屉 -->
    <el-drawer v-model="showDetail" :title="`工单 #${current?.id ?? ''} 详情`" size="520px">
      <template v-if="current">
        <div class="detail-title">{{ current.title }}</div>
        <div class="detail-tags">
          <el-tag :type="typeTag(current.type)">{{ typeLabel(current.type) }}</el-tag>
          <el-tag :type="priorityTag(current.priority)" effect="dark">{{ priorityLabel(current.priority) }}</el-tag>
          <el-tag :type="statusTag(current.status)">{{ statusLabel(current.status) }}</el-tag>
          <el-tag type="info" effect="plain">{{ sourceLabel(current.source) }}</el-tag>
        </div>

        <!-- 工单全生命周期链路 -->
        <div class="lifecycle">
          <div class="lc-step" :class="lcState(0)">
            <span class="lc-dot"></span>
            <b>报修</b>
            <span class="lc-time">{{ current.created_at }}</span>
          </div>
          <div class="lc-line" :class="{ on: lcState(1) !== 'todo' }"></div>
          <div class="lc-step" :class="lcState(1)">
            <span class="lc-dot"></span>
            <b>派单</b>
            <span class="lc-time">{{ current.assigned_to || '待派单' }}</span>
          </div>
          <div class="lc-line" :class="{ on: lcState(2) !== 'todo' }"></div>
          <div class="lc-step" :class="lcState(2)">
            <span class="lc-dot"></span>
            <b>维修</b>
            <span class="lc-time">{{ ['processing','completed'].includes(current.status) ? '处理中 / 已完成' : '—' }}</span>
          </div>
          <div class="lc-line" :class="{ on: lcState(3) !== 'todo' }"></div>
          <div class="lc-step" :class="lcState(3)">
            <span class="lc-dot"></span>
            <b>复检</b>
            <span class="lc-time">{{ current.recheck_status === 'done' ? '已完成' : (current.completed_at ? '待复检' : '—') }}</span>
          </div>
          <div class="lc-line" :class="{ on: lcState(4) !== 'todo' }"></div>
          <div class="lc-step" :class="lcState(4)">
            <span class="lc-dot"></span>
            <b>归档</b>
            <span class="lc-time">{{ current.completed_at || '—' }}</span>
          </div>
        </div>

        <el-descriptions :column="1" border size="small" style="margin-top: 16px">
          <el-descriptions-item label="关联设备">
            <el-button type="primary" link @click="goToEquipment(current.equipment_name)">
              {{ current.equipment_name || '未关联' }}
            </el-button>
          </el-descriptions-item>
          <el-descriptions-item label="问题描述">{{ current.description || '—' }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ current.created_at }}</el-descriptions-item>
          <el-descriptions-item label="完成时间">{{ current.completed_at || '—' }}</el-descriptions-item>
          <el-descriptions-item label="复诊">
            <template v-if="current.recheck_date">
              <el-tag :type="current.recheck_status === 'done' ? 'success' : 'warning'" size="small">
                {{ current.recheck_status === 'done' ? '已复诊' : '待复诊' }}
              </el-tag>
              <span class="recheck-date">应复诊日期：{{ current.recheck_date }}</span>
            </template>
            <span v-else>无需复诊</span>
          </el-descriptions-item>
        </el-descriptions>

        <!-- 关联设备健康度：工单不是孤立的，要能直接看到设备状态 -->
        <div v-if="currentEquipment" class="detail-block">
          <h4>关联设备状态</h4>
          <div class="equip-summary">
            <div class="equip-score" :style="{ borderColor: equipHealthColor }">
              <span :style="{ color: equipHealthColor }">{{ equipHealth }}</span>
              <small>健康分</small>
            </div>
            <div class="equip-meta">
              <div>{{ currentEquipment.name }} · {{ currentEquipment.model }}</div>
              <div class="equip-sub">{{ currentEquipment.location }} · {{ currentEquipment.category }}</div>
              <div class="equip-sub">上次维保：{{ currentEquipment.last_maintenance_date || '无记录' }}</div>
              <el-tag v-if="equipOverdue" type="danger" size="small" effect="plain">
                已超期 {{ equipOverdue }} 天
              </el-tag>
              <el-tag v-else type="success" size="small" effect="plain">维保正常</el-tag>
            </div>
          </div>
        </div>

        <!-- 该设备最近的维保记录 -->
        <div v-if="equipRecords.length" class="detail-block">
          <h4>该设备最近维保记录</h4>
          <el-timeline>
            <el-timeline-item
              v-for="(record, i) in equipRecords"
              :key="i"
              :timestamp="record.date"
              :type="maintenanceStyle(record.type).timelineType"
              placement="top"
            >
              <div class="record-line">
                <el-tag :type="maintenanceStyle(record.type).tagType" size="small">{{ record.type }}</el-tag>
                <span>{{ record.description }}</span>
              </div>
              <div class="record-sub">{{ record.technician }}<template v-if="record.parts_used"> · 配件：{{ record.parts_used }}</template></div>
            </el-timeline-item>
          </el-timeline>
        </div>

        <!-- AI 知识推荐：根据工单内容智能推荐相关维保知识 -->
        <div v-if="knowledgeRecommendations.length" class="detail-block">
          <h4 style="display:flex;align-items:center;gap:6px">🤖 AI 相关知识推荐</h4>
          <div v-for="(rec, ri) in knowledgeRecommendations" :key="ri" class="kb-recommend-card">
            <div class="kb-rec-head">
              <span class="kb-rec-title">{{ rec.entry.title }}</span>
              <el-tag type="primary" size="small" effect="plain">相关度 {{ rec.relevance }}%</el-tag>
            </div>
            <div class="kb-rec-symptoms">典型现象：{{ rec.entry.symptoms }}</div>
            <div class="kb-rec-source">来源：{{ rec.entry.source }}</div>
            <el-button size="small" type="primary" link @click="copyToNote(rec.entry)">引用到工单备注</el-button>
          </div>
        </div>
      </template>

      <template #footer>
        <div class="drawer-footer">
          <el-button @click="showDetail = false">关闭</el-button>
          <el-button
            v-if="current?.recheck_status === 'pending'"
            type="success"
            plain
            @click="completeRecheck(current)"
          >标记已复诊</el-button>
          <el-button
            v-if="current?.status === 'pending'"
            type="warning"
            plain
            @click="openDispatch(current)"
          >派单</el-button>
          <el-button
            v-if="current?.status === 'assigned'"
            type="primary"
            @click="updateStatus(current, 'processing')"
          >开始处理</el-button>
          <el-button
            v-if="current?.status === 'processing'"
            type="success"
            @click="updateStatus(current, 'completed')"
          >标记完成</el-button>
        </div>
      </template>
    </el-drawer>

    <!-- 派单对话框 -->
    <el-dialog v-model="showDispatch" title="派单" width="440">
      <div v-if="dispatchTarget" class="dispatch-info">
        <div class="dispatch-id">工单 #{{ dispatchTarget.id }}</div>
        <div class="dispatch-title">{{ dispatchTarget.title }}</div>
        <div class="dispatch-meta">{{ dispatchTarget.equipment_name || '未关联设备' }} · {{ typeLabel(dispatchTarget.type) }} · {{ priorityLabel(dispatchTarget.priority) }}</div>
      </div>
      <el-form label-width="70px" style="margin-top: 12px">
        <el-form-item label="指派给">
          <el-select v-model="dispatchTo" placeholder="选择维修班组 / 人员（可输入自定义）" filterable allow-create style="width: 100%">
            <el-option v-for="p in techTeams" :key="p" :label="p" :value="p" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showDispatch = false">取消</el-button>
        <el-button type="primary" :disabled="!dispatchTo" @click="confirmDispatch">确认派单</el-button>
      </template>
    </el-dialog>

    <!-- 新建工单对话框 -->
    <el-dialog v-model="showAddDialog" title="新建工单" width="500">
      <el-form :model="newOrder" label-width="80px">
        <el-form-item label="工单标题">
          <el-input v-model="newOrder.title" placeholder="简要描述问题" />
        </el-form-item>
        <el-form-item label="关联设备">
          <el-select v-model="newOrder.equipment_name" placeholder="选择设备">
            <el-option v-for="e in equipmentOptions" :key="e" :label="e" :value="e" />
          </el-select>
        </el-form-item>
        <el-form-item label="类型">
          <el-select v-model="newOrder.type">
            <el-option label="维保" value="maintenance" />
            <el-option label="维修" value="repair" />
            <el-option label="巡检" value="inspection" />
          </el-select>
        </el-form-item>
        <el-form-item label="优先级">
          <el-select v-model="newOrder.priority">
            <el-option label="紧急" value="urgent" />
            <el-option label="高" value="high" />
            <el-option label="普通" value="normal" />
            <el-option label="低" value="low" />
          </el-select>
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="newOrder.description" type="textarea" :rows="3" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddDialog = false">取消</el-button>
        <el-button type="primary" @click="addOrder">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore, maintenanceStyle, computeOverdueDays } from '../stores/appStore'
import { getHealthScore, levelOf, levelMeta } from '../utils/health'
import { recommendKnowledge } from '../utils/knowledgeBase'

const store = useAppStore()
const route = useRoute()
const router = useRouter()

const statusFilter = ref('')
const showAddDialog = ref(false)
const showDetail = ref(false)
const current = ref(null)

const newOrder = ref({
  title: '', equipment_name: '', type: 'maintenance', priority: 'normal', description: ''
})

const equipmentOptions = computed(() => store.equipmentList.map(e => e.name))

const orders = computed(() => store.workOrders)

const stats = computed(() => ({
  total: orders.value.length,
  pending: orders.value.filter(o => o.status === 'pending').length,
  assigned: orders.value.filter(o => o.status === 'assigned').length,
  processing: orders.value.filter(o => o.status === 'processing').length,
  completed: orders.value.filter(o => o.status === 'completed').length
}))

const filteredOrders = computed(() => {
  if (!statusFilter.value) return orders.value
  return orders.value.filter(o => o.status === statusFilter.value)
})

// ---------- 详情抽屉 ----------
const currentEquipment = computed(() => {
  if (!current.value?.equipment_name) return null
  return store.getEquipmentByName(current.value.equipment_name) || null
})

// 健康分统一走 utils/health 的四因子实现：这里曾经有一份"简化版"本地算法
// （只算维保及时性 + 故障 + 机龄），同一个设备在工单页和台账页会显示两个分数。
// 任何页面都不再自己算分，只做展示。
const equipHealth = computed(() => (currentEquipment.value ? getHealthScore(currentEquipment.value) : 0))
const equipHealthColor = computed(() => levelMeta(levelOf(equipHealth.value)).color)

const equipOverdue = computed(() => computeOverdueDays(currentEquipment.value))

const equipRecords = computed(() => {
  if (!currentEquipment.value) return []
  return store.getMaintenanceByEquipmentId(currentEquipment.value.id).slice(0, 5)
})

// AI 知识库智能推荐
const knowledgeRecommendations = computed(() => {
  if (!current.value) return []
  const faultText = current.value.title + ' ' + (current.value.description || '')
  return recommendKnowledge(currentEquipment.value, faultText, store.answerItems)
})

function copyToNote(entry) {
  const note = `【知识库参考】${entry.title}\n现象：${entry.symptoms}\n排查步骤：${entry.steps.join('；')}\n来源：${entry.source}`
  if (current.value) {
    current.value.description = (current.value.description || '') + '\n\n' + note
    store.updateWorkOrder(current.value.id, { description: current.value.description })
    ElMessage.success('已引用到工单备注')
  }
}

function openDetail(row) {
  current.value = row
  showDetail.value = true
}

function openCreate() {
  newOrder.value = { title: '', equipment_name: '', type: 'maintenance', priority: 'normal', description: '' }
  showAddDialog.value = true
}

/** 支持从维保日历「创建工单」带参跳转，自动预填设备与标题 */
function applyQuery() {
  const { new: equipmentName, type } = route.query
  if (!equipmentName) return
  newOrder.value = {
    title: `${equipmentName} ${type === 'repair' ? '故障维修' : '定期保养'}`,
    equipment_name: String(equipmentName),
    type: type ? String(type) : 'maintenance',
    priority: 'high',
    description: `由维保日历发起：${equipmentName} 维保到期，需安排处理`
  }
  showAddDialog.value = true
  router.replace({ path: '/workorder' })
}

/** 支持从全局搜索结果直接跳进来并打开那一条工单（否则用户跳过来还得自己再找一遍） */
function applyFocusQuery() {
  const id = route.query.focus
  if (!id) return
  const hit = store.workOrders.find(o => String(o.id) === String(id))
  if (hit) openDetail(hit)
  router.replace({ path: '/workorder' })
}

onMounted(() => { applyQuery(); applyFocusQuery() })
watch(() => route.query.new, applyQuery)
watch(() => route.query.focus, applyFocusQuery)

// ---------- 标签映射 ----------
function typeLabel(type) {
  return { maintenance: '维保', repair: '维修', inspection: '巡检' }[type] || type
}
function typeTag(type) {
  return { maintenance: 'primary', repair: 'danger', inspection: 'success' }[type] || 'info'
}
function priorityLabel(p) {
  return { urgent: '紧急', high: '高', normal: '普通', low: '低' }[p] || p
}
function priorityTag(p) {
  return { urgent: 'danger', high: 'warning', normal: '', low: 'info' }[p] || ''
}
function statusLabel(s) {
  return { pending: '待派单', assigned: '已派单', processing: '处理中', completed: '已完成', cancelled: '已取消' }[s] || s
}
function statusTag(s) {
  return { pending: 'warning', assigned: 'warning', processing: 'primary', completed: 'success', cancelled: 'info' }[s] || ''
}
function sourceLabel(s) {
  return { manual: '手动', voice: '语音', ocr: '拍照', excel: 'Excel' }[s] || s
}

function updateStatus(row, newStatus) {
  store.updateWorkOrderStatus(row.id, newStatus)
  if (newStatus === 'completed') {
    const interval = row.recheck_date ? `，已生成 ${row.recheck_date} 的复诊任务` : ''
    ElMessage.success(`工单 #${row.id} 已完成，病历已归档${interval}`)
  } else {
    store.addLog({
      content: `工单 #${row.id}「${row.title}」状态更新为 ${statusLabel(newStatus)}`,
      source: '工单',
      type: 'primary',
      tagType: 'primary'
    })
    ElMessage.success(`工单 #${row.id} 状态已更新为 ${statusLabel(newStatus)}`)
  }
}

/** 复诊：确认处置效果，闭环的最后一环 */
function completeRecheck(order) {
  store.markRecheckDone(order.id)
  ElMessage.success(`「${order.equipment_name}」复诊完成，闭环率已更新`)
  if (current.value && current.value.id === order.id) {
    current.value = { ...order, recheck_status: 'done' }
  }
}

function goToEquipment(name) {
  const eq = store.getEquipmentByName(name)
  if (!eq) {
    ElMessage.warning('台账中未找到该设备')
    return
  }
  router.push({ path: '/equipment', query: { id: String(eq.id) } })
}

// ---------- 派单 ----------
const showDispatch = ref(false)
const dispatchTarget = ref(null)
const dispatchTo = ref('')
const techTeams = ['维修一班（动力）', '维修二班（液压）', '电控组', '结构组', '外协服务队']

function openDispatch(row) {
  dispatchTarget.value = row
  dispatchTo.value = row.assigned_to || ''
  showDispatch.value = true
}

function confirmDispatch() {
  if (!dispatchTarget.value || !dispatchTo.value) return
  store.dispatchWorkOrder(dispatchTarget.value.id, dispatchTo.value)
  ElMessage.success(`工单 #${dispatchTarget.value.id} 已派单给 ${dispatchTo.value}，等待开工`)
  showDispatch.value = false
  if (current.value && current.value.id === dispatchTarget.value.id) {
    current.value = { ...dispatchTarget.value, assigned_to: dispatchTo.value, status: 'assigned' }
  }
}

// ---------- 工单生命周期链路（报修→派单→维修→复检→归档） ----------
function lcState(i) {
  const o = current.value
  if (!o) return 'todo'
  const doneFlags = [
    true,
    !!o.assigned_to || ['assigned', 'processing', 'completed'].includes(o.status),
    ['processing', 'completed'].includes(o.status),
    o.recheck_status === 'done',
    !!o.completed_at
  ]
  if (doneFlags[i]) return 'done'
  for (let k = 0; k < i; k++) if (!doneFlags[k]) return 'todo'
  return 'active'
}

function addOrder() {
  if (!newOrder.value.title) {
    ElMessage.warning('请输入工单标题')
    return
  }
  const created = store.addWorkOrder({
    ...newOrder.value,
    status: 'pending',
    source: 'manual',
    created_at: new Date().toLocaleString('zh-CN')
  })
  store.addLog({
    content: `新建工单 #${created.id}「${created.title}」`,
    source: '工单',
    type: 'primary',
    tagType: 'primary'
  })
  showAddDialog.value = false
  newOrder.value = { title: '', equipment_name: '', type: 'maintenance', priority: 'normal', description: '' }
  ElMessage.success(`工单 #${created.id} 创建成功`)
}
</script>

<style scoped>
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.clickable-link {
  color: #409eff;
  cursor: pointer;
}
.clickable-link:hover {
  text-decoration: underline;
}

.muted { color: #c0c4cc; }

.recheck-date {
  margin-left: 8px;
  font-size: 12px;
  color: #909399;
}

/* 详情抽屉 */
.detail-title {
  font-size: 18px;
  font-weight: 700;
  color: #303133;
  margin-bottom: 10px;
}

.detail-tags {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

/* 工单全生命周期链路 */
.lifecycle {
  display: flex;
  align-items: flex-start;
  margin-top: 16px;
  padding: 14px 12px;
  background: linear-gradient(135deg, rgba(11, 58, 130, 0.05), rgba(28, 107, 212, 0.08));
  border: 1px solid rgba(11, 58, 130, 0.12);
  border-radius: 10px;
}
.lc-step {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-width: 52px;
  position: relative;
}
.lc-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid #c8d1de;
  background: #fff;
  transition: all 0.3s;
}
.lc-step b {
  font-size: 12px;
  color: #8a95a7;
  font-weight: 600;
}
.lc-time {
  font-size: 10.5px;
  color: #b0b7c3;
  max-width: 84px;
  text-align: center;
  line-height: 1.3;
}
.lc-line {
  flex: 1;
  height: 2px;
  background: #dde4ef;
  margin-top: 6px;
  min-width: 14px;
  transition: background 0.3s;
}
.lc-line.on { background: #0b3a82; }
.lc-step.done .lc-dot {
  background: #0b3a82;
  border-color: #0b3a82;
}
.lc-step.done b { color: #0b3a82; }
.lc-step.active .lc-dot {
  background: #e0a020;
  border-color: #e0a020;
  box-shadow: 0 0 0 4px rgba(224, 160, 32, 0.18);
}
.lc-step.active b { color: #e0a020; }

.dispatch-info {
  background: #f4f7fb;
  border-radius: 8px;
  padding: 10px 12px;
}
.dispatch-id { font-size: 12px; color: #8a95a7; }
.dispatch-title { font-size: 14px; font-weight: 700; color: #111827; margin-top: 2px; }
.dispatch-meta { font-size: 12px; color: #6b7280; margin-top: 2px; }

.detail-block {
  margin-top: 24px;
}

.detail-block h4 {
  font-size: 14px;
  color: #303133;
  margin-bottom: 12px;
  padding-left: 8px;
  border-left: 3px solid #409eff;
}

.equip-summary {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px;
  background: #f8f9fa;
  border-radius: 10px;
}

.equip-score {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  border: 3px solid;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.equip-score span {
  font-size: 24px;
  font-weight: 800;
  line-height: 1;
}

.equip-score small {
  font-size: 11px;
  color: #909399;
}

.equip-meta {
  font-size: 13px;
  color: #303133;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.equip-sub {
  font-size: 12px;
  color: #909399;
}

.record-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #303133;
}

.record-sub {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
}

.drawer-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* 空状态 */
.empty-state {
  padding: 40px 20px;
  text-align: center;
}
.empty-title {
  font-size: 16px;
  color: #909399;
  margin: 12px 0 6px;
}
.empty-desc {
  font-size: 13px;
  color: #c0c4cc;
}

/* AI 知识推荐卡片 */
.kb-recommend-card {
  padding: 10px 12px;
  background: #f0f5ff;
  border: 1px solid #d6e4ff;
  border-radius: 8px;
  margin-bottom: 8px;
}

.kb-rec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.kb-rec-title {
  font-weight: 600;
  font-size: 13px;
  color: #303133;
}

.kb-rec-symptoms {
  font-size: 12px;
  color: #606266;
  margin-bottom: 4px;
  line-height: 1.5;
}

.kb-rec-source {
  font-size: 11px;
  color: #909399;
  margin-bottom: 6px;
}
</style>
