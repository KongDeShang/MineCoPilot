<template>
  <div class="equipment">
    <!-- 设备列表视图 -->
    <el-card v-if="!selectedEquipment">
      <template #header>
        <div class="card-header">
          <span><el-icon><SetUp /></el-icon> 设备台账</span>
          <div>
            <el-input
              v-model="searchText"
              placeholder="搜索设备名称、型号..."
              style="width: 240px; margin-right: 12px"
              clearable
            >
              <template #prefix>
                <el-icon><Search /></el-icon>
              </template>
            </el-input>
            <el-button type="primary" @click="openAddDialog">
              <el-icon><Plus /></el-icon> 新增设备
            </el-button>
          </div>
        </div>
      </template>

      <!-- 健康度概览 -->
      <div class="health-overview">
        <div class="health-item" v-for="(item, i) in healthOverview" :key="i">
          <div class="health-ring" :style="{ borderColor: item.color }">
            <span class="health-num" :style="{ color: item.color }">{{ item.count }}</span>
          </div>
          <span class="health-label">{{ item.label }}</span>
        </div>
      </div>

      <!-- 设备卡片网格（照片 + 健康分 + 状态，一眼看全；>50 台自动启用虚拟滚动） -->
      <div
        v-if="filteredEquipment.length"
        ref="gridContainerRef"
        class="equip-grid"
        :class="{ 'virtual-scroll': useVirtual }"
        :style="useVirtual ? vgrid.wrapperStyle.value : undefined"
      >
        <div v-for="(eq, i) in displayItems" :key="eq.id" class="equip-card" @click="viewDetail(eq)">
          <div class="equip-photo">
            <img :src="equipmentPhoto(eq.category)" :alt="eq.name" loading="lazy" />
            <span class="equip-level" :class="'lv-' + eq.health.level.toLowerCase()">
              {{ eq.health.level }} 级 · {{ eq.health.score }} 分
            </span>
            <span class="equip-status" :class="eq.status">
              <i class="status-dot"></i>{{ statusLabel(eq.status) }}
            </span>
          </div>
          <div class="equip-info">
            <div class="equip-name-row">
              <span class="equip-name">{{ eq.name }}</span>
              <el-tag size="small" effect="plain">{{ eq.category }}</el-tag>
            </div>
            <div class="equip-model">{{ eq.model || '—' }} · {{ eq.location || '未定位' }}</div>
            <div class="equip-healthbar">
              <div class="equip-healthbar-track">
                <!-- 依次长出：每张卡延后 40ms，扫过去像一排仪表同时上电。
                     上限 0.4s 免得屏幕外的卡片等到天荒地老。 -->
                <div
                  class="equip-healthbar-fill"
                  :style="{
                    width: (entered ? eq.health.score : 0) + '%',
                    background: eq.health.color,
                    transitionDelay: Math.min(i * 0.04, 0.4) + 's'
                  }"
                ></div>
              </div>
            </div>
            <div class="equip-meta-row">
              <span class="equip-meta">上次维保：{{ eq.last_maintenance_date || '暂无记录' }}</span>
              <el-tag :type="eq.maint.type" size="small">{{ eq.maint.label }}</el-tag>
            </div>
            <div class="equip-actions" @click.stop>
              <el-button type="primary" size="small" link @click="viewDetail(eq)">
                <el-icon><View /></el-icon> 详情
              </el-button>
              <el-button type="success" size="small" link @click="openRecordDialog(eq)">
                <el-icon><Stamp /></el-icon> 记录维保
              </el-button>
              <el-button type="warning" size="small" link @click="openReport(eq)">
                <el-icon><Document /></el-icon> 体检
              </el-button>
              <!-- 台账此前只有"新增"，录错了改不了（型号/位置/口述别名都只能删了重建）。
                   图标用已登记白名单里的 EditPen，避免为一个按钮把包体白名单再加一项。 -->
              <el-button size="small" link @click="openEditDialog(eq)">
                <el-icon><EditPen /></el-icon> 编辑
              </el-button>
            </div>
          </div>
        </div>
      </div>
      <el-empty v-else description="暂无匹配设备" />
    </el-card>

    <!-- 设备详情视图 -->
    <div v-else class="detail-view">
      <div class="detail-header">
        <el-button @click="closeDetail" icon="ArrowLeft">返回列表</el-button>
        <h2>{{ selectedEquipment.name }} — 设备画像</h2>
        <el-tag
          v-if="selectedHealth"
          effect="dark"
          :class="'lv-' + selectedHealth.level.toLowerCase()"
          style="border: none; background: var(--lv); color: var(--accent-contrast)"
        >
          健康分 {{ selectedHealth.score }} · {{ selectedHealth.level }} {{ selectedHealth.levelLabel }}
        </el-tag>
        <el-button @click="openPassport">
          <el-icon><Postcard /></el-icon> 设备身份证
        </el-button>
        <el-button type="primary" @click="openReport(selectedEquipment)">
          <el-icon><Document /></el-icon> 生成体检报告
        </el-button>
      </div>

      <el-row :gutter="20">
        <!-- 左侧：基本信息 + 健康度 -->
        <el-col :span="8">
          <el-card>
            <template #header><span>基本信息</span></template>
            <el-descriptions :column="1" border size="small">
              <el-descriptions-item label="设备名称">{{ selectedEquipment.name }}</el-descriptions-item>
              <el-descriptions-item label="型号">{{ selectedEquipment.model }}</el-descriptions-item>
              <el-descriptions-item label="类别">{{ selectedEquipment.category }}</el-descriptions-item>
              <el-descriptions-item label="所在位置">{{ selectedEquipment.location }}</el-descriptions-item>
              <el-descriptions-item label="购置日期">{{ selectedEquipment.purchase_date }}</el-descriptions-item>
              <el-descriptions-item label="当前状态">
                <el-tag :type="statusType(selectedEquipment.status)">{{ statusLabel(selectedEquipment.status) }}</el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="维保周期">{{ selectedEquipment.maintenance_cycle_days }} 天</el-descriptions-item>
            </el-descriptions>
          </el-card>

          <!-- 健康度评分 -->
          <el-card style="margin-top: 16px">
            <template #header>
              <div class="card-header">
                <span>健康度四因子</span>
                <span class="factor-hint">每项均标注计算式，可追溯</span>
              </div>
            </template>
            <div class="health-detail">
              <div class="health-circle-big" :class="'lv-' + selectedHealth.level.toLowerCase()">
                <span class="big-score">
                  {{ selectedHealth.score }}
                </span>
                <span class="score-label">{{ selectedHealth.levelLabel }}</span>
              </div>
              <div class="health-factors">
                <div class="factor" v-for="(f, i) in healthFactors" :key="i">
                  <div class="factor-row">
                    <span class="factor-name">{{ f.name }}</span>
                    <span class="factor-penalty" :class="{ zero: f.penalty === 0 }">
                      {{ f.penalty > 0 ? `−${f.penalty}` : '不扣分' }}
                    </span>
                  </div>
                  <el-progress :percentage="f.score" :color="getHealthColor(f.score)" :stroke-width="8" :show-text="false" />
                  <div class="factor-detail">{{ f.detail }}</div>
                </div>
              </div>
            </div>
          </el-card>

          <!-- 健康分趋势 -->
          <el-card style="margin-top: 16px">
            <template #header>
              <div class="card-header">
                <span>健康分趋势</span>
                <el-tag :color="healthTrend.color" effect="dark" size="small" style="border: none; color: var(--accent-contrast)">
                  {{ healthTrend.label }}
                </el-tag>
              </div>
            </template>
            <div v-if="trendPath" class="trend-block">
              <svg :viewBox="`0 0 ${trendPath.width} ${trendPath.height}`" class="trend-svg" preserveAspectRatio="none">
                <path :d="trendPath.d" fill="none" :stroke="trendPath.color" stroke-width="2" />
                <circle v-for="(p, i) in trendPath.points" :key="i" :cx="p.x" :cy="p.y" r="3" :fill="trendPath.color" />
              </svg>
              <div class="trend-axis">
                <span v-for="(p, i) in trendPath.points" :key="i">{{ String(p.date).slice(5) }} · {{ p.score }}</span>
              </div>
              <div class="trend-summary" :style="{ color: healthTrend.color }">{{ healthTrend.summary }}</div>
            </div>
            <div v-else class="trend-empty">
              <el-icon :size="20"><DataLine /></el-icon>
              {{ healthTrend.summary }}
            </div>
          </el-card>

          <!-- 关联工单 -->
          <el-card style="margin-top: 16px">
            <template #header>
              <span>关联工单</span>
              <el-badge :value="relatedOrders.length" type="primary" style="margin-left: 8px" />
            </template>
            <div class="related-orders">
              <div v-for="order in relatedOrders" :key="order.id" class="order-item">
                <div class="order-priority" :class="order.priority"></div>
                <div class="order-info">
                  <div class="order-title">{{ order.title }}</div>
                  <div class="order-meta">
                    <el-tag :type="statusTag(order.status)" size="small">{{ statusLabel2(order.status) }}</el-tag>
                    <span>{{ order.created_at }}</span>
                  </div>
                </div>
              </div>
              <el-empty v-if="relatedOrders.length === 0" description="暂无关联工单" :image-size="60" />
            </div>
          </el-card>
        </el-col>

        <!-- 右侧：维保时间轴 -->
        <el-col :span="16">
          <el-card>
            <template #header>
              <div class="card-header">
                <span>维保时间轴</span>
                <el-button type="primary" size="small" @click="openRecordDialog(selectedEquipment)">
                  <el-icon><Plus /></el-icon> 新增维保记录
                </el-button>
              </div>
            </template>
            <el-timeline>
              <el-timeline-item
                v-for="(record, i) in maintenanceTimeline"
                :key="i"
                :timestamp="record.date"
                :type="record.type"
                placement="top"
              >
                <el-card shadow="never" class="timeline-card">
                  <div class="timeline-header">
                    <el-tag :type="maintenanceStyle(record.type).tagType" size="small">{{ record.type }}</el-tag>
                    <span class="timeline-tech">维保人员：{{ record.technician || '未记录' }}</span>
                  </div>
                  <p class="timeline-desc">{{ record.description }}</p>
                  <div class="timeline-footer" v-if="record.parts">
                    <el-icon><Box /></el-icon>
                    <span>使用配件：{{ record.parts }}</span>
                  </div>
                </el-card>
              </el-timeline-item>
            </el-timeline>
            <el-empty v-if="maintenanceTimeline.length === 0" description="暂无维保记录" />
          </el-card>
        </el-col>
      </el-row>
    </div>

    <!-- 体检报告抽屉 -->
    <el-drawer v-model="showReport" size="880px" :with-header="false" class="report-drawer">
      <div class="report-toolbar">
        <div class="report-toolbar-title">
          <el-icon><Document /></el-icon>
          设备体检报告
          <span class="report-toolbar-sub">本地离线生成 · 每个数字可溯源</span>
        </div>
        <div class="report-toolbar-actions">
          <el-button @click="printReport">
            <el-icon><Printer /></el-icon> 打印 / 导出 PDF
          </el-button>
          <el-button type="primary" @click="createOrderFromReport">
            <el-icon><EditPen /></el-icon> 一键生成维保工单
          </el-button>
          <el-button @click="showReport = false">关闭</el-button>
        </div>
      </div>
      <div v-if="report" class="report-body" v-html="report.html"></div>
    </el-drawer>

    <!-- 新增维保记录对话框 -->
    <el-dialog v-model="showRecordDialog" title="新增维保记录" width="520">
      <el-form :model="newRecord" label-width="90px">
        <el-form-item label="设备">
          <el-input :model-value="recordTarget?.name" disabled />
        </el-form-item>
        <el-form-item label="维保日期">
          <el-date-picker v-model="newRecord.date" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" />
        </el-form-item>
        <el-form-item label="维保类型">
          <el-select v-model="newRecord.type">
            <el-option v-for="type in MAINTENANCE_TYPES" :key="type" :label="type" :value="type" />
          </el-select>
        </el-form-item>
        <el-form-item label="维保内容">
          <el-input v-model="newRecord.description" type="textarea" :rows="3" placeholder="如：更换液压油，检查液压系统压力" />
        </el-form-item>
        <el-form-item label="维保人员">
          <el-input v-model="newRecord.technician" placeholder="如：张工" />
        </el-form-item>
        <el-form-item label="使用配件">
          <el-input v-model="newRecord.parts_used" placeholder="如：液压油46号 200L" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showRecordDialog = false">取消</el-button>
        <el-button type="primary" @click="submitRecord">保存</el-button>
      </template>
    </el-dialog>

    <!-- 新增 / 编辑设备对话框（同一套表单，编辑时回填并改标题） -->
    <el-dialog v-model="showAddDialog" :title="editingId ? '编辑设备' : '新增设备'" width="500">
      <el-form :model="newEquipment" label-width="80px">
        <el-form-item label="设备名称">
          <el-input v-model="newEquipment.name" placeholder="如：7号挖掘机" />
        </el-form-item>
        <el-form-item label="型号">
          <el-input v-model="newEquipment.model" placeholder="如：CAT 336" />
        </el-form-item>
        <el-form-item label="类别">
          <el-select v-model="newEquipment.category" placeholder="选择类别">
            <el-option label="挖掘机" value="挖掘机" />
            <el-option label="装载机" value="装载机" />
            <el-option label="矿卡" value="矿卡" />
            <el-option label="钻机" value="钻机" />
            <el-option label="破碎机" value="破碎机" />
            <el-option label="其他" value="其他" />
          </el-select>
        </el-form-item>
        <el-form-item label="所在位置">
          <el-input v-model="newEquipment.location" placeholder="如：A矿区" />
        </el-form-item>
        <el-form-item label="购置日期">
          <el-date-picker v-model="newEquipment.purchase_date" type="date" value-format="YYYY-MM-DD" />
        </el-form-item>
        <!-- 口述录入时用户不会把「徐工 XE215C 挖掘机-03」念全，多半说"小松""三号挖机"。
             这里录的别名进的是设备指代解析的第二层匹配（nlCommand resolveEquipment）。 -->
        <el-form-item label="口述别名">
          <el-input v-model="newEquipment.aliases" placeholder="如：小松、三号挖机（多个用、隔开）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddDialog = false">取消</el-button>
        <el-button type="primary" @click="addEquipment">{{ editingId ? '保存' : '确定' }}</el-button>
      </template>
    </el-dialog>

    <!-- 设备身份证 -->
    <el-dialog
      v-model="showPassport"
      title=""
      width="720"
      :show-close="true"
      class="passport-dialog"
      append-to-body
    >
      <EquipmentPassport
        v-if="selectedEquipment && selectedHealth"
        :equipment="selectedEquipment"
        :health="selectedHealth"
        :factors="healthFactors"
        :summary="passportSummary"
      />
      <template #footer>
        <el-button @click="showPassport = false">关闭</el-button>
        <el-button type="primary" @click="printPassport">
          <el-icon><Printer /></el-icon> 打印身份证
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useAppStore } from '../stores/appStore'
// 设备状态与工单状态的文案/配色统一取自 utils/dictionaries.js（单一来源）。
// 模板里沿用旧函数名，这里用 import 别名对上，避免为改名而改模板。
import {
  MAINTENANCE_TYPES, maintenanceStyle,
  equipmentStatusLabel as statusLabel, equipmentStatusTagType as statusType,
  statusLabel as statusLabel2, statusTagType as statusTag
} from '../utils/dictionaries'
import { now, daysSince } from '../utils/dates'
import { parseAliases, formatAliases } from '../utils/aliases'
import { evaluateHealth, getHealthColor, levelBounds, buildTrendPath } from '../utils/health'
import { equipmentPhoto } from '../utils/equipmentPhoto'
import { generateHealthReport } from '../utils/healthReport'
import { useEnter } from '../utils/motion'
import { useVirtualGrid } from '../utils/virtualGrid'
import EquipmentPassport from '../components/EquipmentPassport.vue'

const store = useAppStore()
const route = useRoute()
const router = useRouter()

// 卡片健康条的入场开关：数据在挂载前就绪，首帧即终值，
// `.equip-healthbar-fill` 上的 transition 从来没播过（详见 utils/motion.js）。
const entered = useEnter()

const searchText = ref('')
const showAddDialog = ref(false)
const showRecordDialog = ref(false)
const showReport = ref(false)
const report = ref(null)
const showPassport = ref(false)
const selectedEquipment = ref(null)
const recordTarget = ref(null)

const newRecord = ref({
  date: now().slice(0, 10), type: '定期保养', description: '', technician: '', parts_used: ''
})

const newEquipment = ref({
  name: '', model: '', category: '', location: '', purchase_date: '', aliases: ''
})

/** 非空表示当前对话框处于"编辑"模式（值是设备 id），空表示"新增" */
const editingId = ref(null)

/**
 * 卡片网格的数据源直接取 store 缓存的 equipmentWithHealth，而不是原始台账。
 *
 * 原来这里是 `store.equipmentList`，模板里再对每张卡分别调
 * getHealthLevel / getHealthScore / levelColor —— 每个函数都会跑一次完整
 * evaluateHealth（四因子 + 日期解析）。60 张卡 ≈ 每次渲染 300 次评估，
 * 而 store 里这份结果早就算好并缓存了。
 */
const equipmentList = computed(() => store.equipmentWithHealth)

/** 当前选中设备的健康评估（统一走 utils/health.js，评分口径全项目唯一） */
const selectedHealth = computed(() => (selectedEquipment.value ? evaluateHealth(selectedEquipment.value) : null))

/** 健康度概览：按四级分档统计（区间文案跟随系统设置页的阈值）
    色走 CSS 变量通道（--level-text-*）：浅色下与 ink 同值，深色下自动切亮版。
    圆环描边与数字都是"字/细线"场景，深色下必须可辨，不能用字面 hex。 */
const healthOverview = computed(() => {
  const levels = store.healthLevelStats
  const b = levelBounds()
  return [
    { label: `优 A（≥${b.A}）`, count: levels.A, color: 'var(--level-text-a)' },
    { label: `良 B（${b.B}-${b.A - 1}）`, count: levels.B, color: 'var(--level-text-b)' },
    { label: `预警 C（${b.C}-${b.B - 1}）`, count: levels.C, color: 'var(--level-text-c)' },
    { label: `严重 D（<${b.C}）`, count: levels.D, color: 'var(--level-text-d)' }
  ]
})

/** 四因子（来自公共评分模块，带的算式与来源用于溯源展示） */
const healthFactors = computed(() => selectedHealth.value ? selectedHealth.value.factors : [])

/** 健康分趋势（快照不足 3 期时如实显示"数据积累中"） */
const healthTrend = computed(() => {
  if (!selectedEquipment.value) return null
  return store.getTrend(selectedEquipment.value.id)
})

/** 趋势折线的 SVG 坐标 */
const trendPath = computed(() => {
  const trend = healthTrend.value
  const path = buildTrendPath(trend && trend.points, { width: 320, height: 80 })
  return path ? { ...path, color: trend.color } : null
})

const relatedOrders = computed(() => {
  if (!selectedEquipment.value) return []
  return store.getOrdersByEquipmentName(selectedEquipment.value.name)
})

const maintenanceTimeline = computed(() => {
  if (!selectedEquipment.value) return []
  return store.getMaintenanceByEquipmentId(selectedEquipment.value.id)
})

const filteredEquipment = computed(() => {
  let rows = equipmentList.value
  if (searchText.value) {
    const keyword = searchText.value.toLowerCase()
    rows = rows.filter(e =>
      e.name.toLowerCase().includes(keyword) ||
      (e.model || '').toLowerCase().includes(keyword) ||
      (e.category || '').includes(keyword)
    )
  }
  // 维保徽标在这里算一次：原模板对同一张卡调了两次 maintenanceStatus(eq)
  return rows.map(eq => ({ ...eq, maint: maintenanceStatus(eq) }))
})

// ── 虚拟列表（设备量 >50 时启用，只渲染可见卡片） ──
const VIRTUAL_THRESHOLD = 50
const useVirtual = computed(() => filteredEquipment.value.length > VIRTUAL_THRESHOLD)
const gridContainerRef = ref(null)

const vgrid = useVirtualGrid({
  items: filteredEquipment,
  cardHeight: 280,
  cardMinWidth: 280,
  gap: 16,
  overscan: 2
})

// 当容器挂载且启用虚拟滚动时，手动绑定
watch([gridContainerRef, useVirtual], ([el, active]) => {
  if (active && el) {
    vgrid.containerProps.value.ref(el)
  }
}, { immediate: true })

// 虚拟滚动的可见卡片：小数据量时直接用全部数据
const displayItems = computed(() => {
  return useVirtual.value ? vgrid.visibleItems.value : filteredEquipment.value
})

// 搜索关键词变化时重置滚动位置
watch(searchText, () => {
  if (useVirtual.value) vgrid.reset()
})


/** 生成设备体检报告 */
function openReport(eq) {
  const target = eq || selectedEquipment.value
  if (!target) return
  try {
    report.value = generateHealthReport(target, store)
    showReport.value = true
    store.addLog({
      content: `生成体检报告：${target.name}（健康分 ${report.value.summary.score} · ${report.value.summary.levelLabel}）`,
      source: '体检',
      type: 'info',
      tagType: 'info'
    })
  } catch (error) {
    ElMessage.error(`报告生成失败：${error.message}`)
  }
}

/** 设备身份证：汇总数据 */
const passportSummary = computed(() => {
  const eq = selectedEquipment.value
  if (!eq) return {}
  // 工单的 equipment_id 在不同写入路径上可能是数字或字符串（告警建单曾整段漏写该字段），
  // 统一按字符串比对，否则同一台设备的单子会被数成两台。
  const eqOrders = store.workOrders.filter(o => String(o.equipment_id) === String(eq.id))
  // 维保记录不在设备对象上——持久化时按 equipment_id 键控存在 store 的独立 ref 里，
  // 早先这里读 eq.maintenance_records 恒为 undefined，"维保次数"永远是 0。
  const eqMaints = store.getMaintenanceByEquipmentId(eq.id)
  // "历史故障"取已完成的维修工单。注意口径是 'repair' 不是 '故障'：
  // 工单 type 落库为英文枚举（repair/inspection/maintenance），早先按 '故障' 匹配
  // 恒为空数组，于是这一格显示的数字全部来自"机龄 × 1.5"的估算——
  // 设备身份证上不允许出现推算出来的数字，这里必须是可追溯到工单的真实计数。
  const faultOrders = eqOrders.filter(o => o.status === 'completed' && o.type === 'repair')
  const sortedMaints = [...eqMaints].sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  return {
    orderTotal: eqOrders.length,
    orderActive: eqOrders.filter(o => o.status !== 'completed').length,
    faultCount: faultOrders.length,
    maintCount: eqMaints.length,
    // 维保记录为空时回退到设备上的权威字段（addMaintenanceRecord 会维护它）
    lastMaintDate: sortedMaints[0]?.date || eq.last_maintenance_date || ''
  }
})

function openPassport() {
  if (!selectedEquipment.value) return
  showPassport.value = true
}

function printPassport() {
  document.documentElement.classList.add('print-passport-active')
  setTimeout(() => {
    window.print()
    document.documentElement.classList.remove('print-passport-active')
  }, 100)
}

/** 打印报告：给根节点加打印类，只渲染 .print-doc */
function printReport() {
  document.documentElement.classList.add('print-doc-active')
  const cleanup = () => {
    document.documentElement.classList.remove('print-doc-active')
    window.removeEventListener('afterprint', cleanup)
  }
  window.addEventListener('afterprint', cleanup)
  window.print()
}

/** 报告 → 处方工单（闭环：体检结论直接变成可执行任务） */
function createOrderFromReport() {
  if (!report.value) return
  const r = report.value
  const created = store.addWorkOrder({
    equipment_id: r.equipment.id,
    equipment_name: r.equipment.name,
    title: `${r.equipment.name} 体检处置（${r.summary.levelLabel}）`,
    description: `${r.summary.conclusion}\n风险项：${r.riskItems.map(i => i.title).join('；') || '无'}`,
    type: r.equipment.status === 'fault' ? 'repair' : 'maintenance',
    priority: r.summary.level === 'D' ? 'urgent' : r.summary.level === 'C' ? 'high' : 'normal',
    source: 'manual',
    assigned_to: ''
  })
  store.addLog({
    content: `体检报告转为工单 #${created.id}：${created.title}`,
    source: '体检',
    type: 'primary',
    tagType: 'primary'
  })
  ElMessage.success(`已生成工单 #${created.id}，可在工单管理中跟进`)
  showReport.value = false
  router.push({ path: '/workorder' })
}

function viewDetail(row) {
  selectedEquipment.value = row
  router.replace({ path: '/equipment', query: { id: String(row.id) } })
}

function closeDetail() {
  selectedEquipment.value = null
  router.replace({ path: '/equipment' })
}

/** 支持从工单/日历跳转过来时直接打开某台设备的画像 */
function openFromQuery() {
  const id = route.query.id
  if (!id) return
  const target = equipmentList.value.find(e => String(e.id) === String(id))
  if (target) selectedEquipment.value = target
}

onMounted(openFromQuery)
watch(() => route.query.id, openFromQuery)

// 状态文案/配色见 utils/dictionaries.js（原本这里另有两份，且工单状态配色缺 assigned 分支）

function maintenanceStatus(row) {
  const since = daysSince(row.last_maintenance_date)
  if (since === null) return { type: 'info', label: '无记录' }
  const cycle = Number(row.maintenance_cycle_days) || 90
  if (since > cycle) return { type: 'danger', label: `超期${since - cycle}天` }
  if (since > cycle * 0.8) return { type: 'warning', label: '即将到期' }
  return { type: 'success', label: '正常' }
}

function addEquipment() {
  if (!newEquipment.value.name) { ElMessage.warning('请输入设备名称'); return }
  // 别名在台账里是一行文本，进 store 前切成数组（落库/回读都走 utils/aliases）
  const patch = { ...newEquipment.value, aliases: parseAliases(newEquipment.value.aliases) }
  if (editingId.value) {
    // 编辑：只改表单里这几个字段，status / 维保周期 / 最近维保日期不归这张表单管
    delete patch.status
    delete patch.maintenance_cycle_days
    delete patch.last_maintenance_date
    store.updateEquipment(editingId.value, patch)
    ElMessage.success('设备信息已更新')
  } else {
    store.addEquipment({
      ...patch,
      status: 'running', last_maintenance_date: null, maintenance_cycle_days: 90
    })
    ElMessage.success('设备添加成功')
  }
  closeEquipDialog()
}

function closeEquipDialog() {
  showAddDialog.value = false
  editingId.value = null
  newEquipment.value = { name: '', model: '', category: '', location: '', purchase_date: '', aliases: '' }
}

/**
 * 打开新增表单。
 * 原先模板里是 `@click="showAddDialog = true"` 直接改标志位，没有重置动作，
 * 改成编辑再回到新增时会残留上一次的输入。
 */
function openAddDialog() {
  closeEquipDialog()
  showAddDialog.value = true
}

/** 打开编辑表单：回填现有设备，别名数组换回一行文本给输入框 */
function openEditDialog(eq) {
  editingId.value = eq.id
  newEquipment.value = {
    name: eq.name || '',
    model: eq.model || '',
    category: eq.category || '',
    location: eq.location || '',
    purchase_date: eq.purchase_date || '',
    aliases: formatAliases(eq.aliases)
  }
  showAddDialog.value = true
}

// ---------- 维保记录 ----------
function openRecordDialog(row) {
  recordTarget.value = row
  newRecord.value = {
    date: now().slice(0, 10),
    type: '定期保养',
    description: '',
    technician: '',
    parts_used: ''
  }
  showRecordDialog.value = true
}

function submitRecord() {
  if (!recordTarget.value) return
  if (!newRecord.value.date) { ElMessage.warning('请选择维保日期'); return }
  if (!newRecord.value.description) { ElMessage.warning('请填写维保内容'); return }

  // snapshot: true —— 与口述录入那条路保持一致。维保推进了"上次维保日期"，
  // 健康分随之变化，必须落一个快照点，否则趋势曲线上查不到这次变化
  store.addMaintenanceRecord(recordTarget.value.id, { ...newRecord.value }, { snapshot: true })
  store.addLog({
    content: `记录维保：${recordTarget.value.name} ${newRecord.value.type} — ${newRecord.value.description}`,
    source: '维保',
    type: 'success',
    tagType: 'success'
  })
  showRecordDialog.value = false
  ElMessage.success(`已为「${recordTarget.value.name}」记录维保，设备上次维保日期已同步更新`)
}
</script>

<style scoped>
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.clickable {
  color: var(--accent);
  cursor: pointer;
}
.clickable:hover { text-decoration: underline; }

.health-overview {
  display: flex;
  gap: 24px;
  margin-bottom: 20px;
  padding: 16px;
  background: var(--card-2);
  border-radius: 10px;
}

.health-item {
  display: flex;
  align-items: center;
  gap: 10px;
}

.health-ring {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: 3px solid;
  display: flex;
  align-items: center;
  justify-content: center;
}

.health-num {
  font-size: 18px;
  font-weight: 800;
}

.health-label {
  font-size: 13px;
  color: var(--text-2);
}

.detail-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
}

.detail-header h2 {
  font-size: 20px;
  color: var(--text-1);
}

.health-detail {
  display: flex;
  align-items: center;
  gap: 24px;
}

.health-circle-big {
  width: 100px;
  height: 100px;
  border-radius: 50%;
  border: 4px solid;
  /* 圆环是非文字图形，按 3:1 要求取 ink（--amber 在白底只有 2.17:1） */
  border-color: var(--lv);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.big-score {
  font-size: 36px;
  font-weight: 800;
  line-height: 1;
  color: var(--lv);
}

.score-label {
  font-size: 12px;
  color: var(--text-3);
}

.health-factors {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.factor-name {
  font-size: 13px;
  color: var(--text-2);
  margin-bottom: 2px;
  display: block;
}

.related-orders {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.order-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  background: var(--card-2);
  border-radius: 8px;
}

.order-priority {
  width: 6px;
  height: 32px;
  border-radius: 3px;
  flex-shrink: 0;
}
.order-priority.urgent { background: var(--danger); }
.order-priority.high { background: var(--amber); }
.order-priority.normal { background: var(--accent); }

.order-info { flex: 1; }

.order-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}

.order-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-3);
}

.timeline-card {
  border: 1px solid var(--line);
}

.timeline-card :deep(.el-card__body) {
  padding: 12px;
}

.timeline-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.timeline-tech {
  font-size: 12px;
  color: var(--text-3);
}

.timeline-desc {
  font-size: 14px;
  color: var(--text-1);
  margin: 0 0 8px;
  line-height: 1.5;
}

.timeline-footer {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-3);
  padding-top: 8px;
  border-top: 1px solid var(--line-2);
}

/* 空状态 */
.empty-state {
  padding: 40px 20px;
  text-align: center;
}
.empty-title {
  font-size: 16px;
  color: var(--text-3);
  margin: 12px 0 6px;
}
.empty-desc {
  font-size: 13px;
  color: var(--text-mute);
}

/* ===== 设备卡片网格 ===== */
.equip-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 16px;
}

/* 虚拟滚动模式：固定高度 + 滚动 */
.equip-grid.virtual-scroll {
  max-height: calc(100vh - 280px);
  overflow-y: auto;
  align-content: flex-start;
}
.equip-card {
  flex: 1 1 300px;
  max-width: 400px;
  min-width: 260px;
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
  cursor: pointer;
  background: var(--card);
  transition: all 0.2s;
}
.equip-card:hover {
  box-shadow: 0 6px 18px var(--accent-shadow);
  transform: translateY(-2px);
  border-color: var(--accent);
}
.equip-photo {
  position: relative;
  height: 150px;
  background: var(--bg-sunken);
}
.equip-photo img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.equip-level {
  position: absolute;
  left: 10px;
  top: 10px;
  /* 面色（--emerald/--amber/--danger）配白字只有 2.28~4.20:1，等级徽标改用实色版 --lv */
  background: var(--lv);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  padding: 3px 9px;
  border-radius: 999px;
  box-shadow: 0 1px 4px rgba(0,0,0,0.25);
}
.equip-status {
  position: absolute;
  right: 10px;
  top: 10px;
  font-size: 11.5px;
  color: #fff;
  background: rgba(0, 0, 0, 0.55);
  padding: 3px 9px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.equip-status .status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
/* 状态色只给圆点，文字保持白色。
   这块标签压在设备照片上，照片明暗不可控 —— 深色文字会随照片深浅时好时坏，
   白字压 55% 黑底才是稳定的。原来颜色直接写在 .equip-status 上（文字与圆点共用
   currentColor），一旦按状态换色文字就跟着变深，等于把标签读没了。 */
.equip-status.running .status-dot { background: var(--emerald); }
.equip-status.maintenance .status-dot { background: var(--amber); }
.equip-status.fault .status-dot { background: var(--danger); }
.equip-status.idle .status-dot { background: var(--ink-4); }
.equip-info { padding: 12px 14px 10px; }
.equip-name-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.equip-name {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.equip-model {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 2px;
}
.equip-healthbar { margin-top: 10px; }
.equip-healthbar-track {
  height: 6px;
  background: var(--line-2);
  border-radius: 4px;
  overflow: hidden;
}
.equip-healthbar-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.4s;
}
.equip-meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-3);
}
.equip-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--line-2);
}
.equip-actions .el-button + .el-button { margin-left: 0; }

/* 设备身份证弹窗 */
.passport-dialog :deep(.el-dialog__body) {
  padding: 0;
  display: flex;
  justify-content: center;
}
.passport-dialog :deep(.el-dialog__header) {
  display: none;
}

/* 打印模式：只显示身份证 */
:global(html.print-passport-active body > *:not(.el-overlay)) {
  display: none !important;
}
:global(html.print-passport-active .el-overlay) {
  position: static !important;
  background: none !important;
}
:global(html.print-passport-active .el-overlay .el-dialog) {
  position: static !important;
  margin: 0 !important;
  box-shadow: none !important;
  border: none !important;
  width: 700px !important;
}
:global(html.print-passport-active .el-overlay .el-dialog__header) {
  display: none !important;
}
:global(html.print-passport-active .el-overlay .el-dialog__footer) {
  display: none !important;
}
:global(html.print-passport-active .el-overlay .el-dialog__body) {
  padding: 0 !important;
}

</style>

<!-- 体检报告样式见 src/styles/healthReport.css（main.js 全局引入，屏幕与打印共用一份） -->
<style scoped>
.report-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 4px 12px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 12px;
  position: sticky;
  top: 0;
  background: var(--card);
  z-index: 5;
}

.report-toolbar-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1);
}

.report-toolbar-sub {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-3);
}

.report-toolbar-actions {
  display: flex;
  gap: 8px;
}

.report-body {
  padding: 0 4px 24px;
}

/* 四因子 */
.factor-hint {
  font-size: 11px;
  color: var(--text-3);
  font-weight: 400;
}

.factor-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.factor-penalty {
  font-size: 12px;
  font-weight: 700;
  color: var(--danger-ink);
}

.factor-penalty.zero {
  color: var(--success-ink);
}

.factor-detail {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
}

/* 趋势图 */
.trend-block { padding: 4px 0; }

.trend-svg {
  width: 100%;
  height: 80px;
}

.trend-axis {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--text-mute);
  margin-top: 4px;
}

.trend-summary {
  margin-top: 8px;
  font-size: 12px;
}

.trend-empty {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 18px 0;
  font-size: 13px;
  color: var(--text-3);
}

.detail-header {
  flex-wrap: wrap;
}
</style>
