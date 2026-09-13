/**
 * 矿山智工 - 统一数据 Store
 *
 * 数据生命周期：
 *   首次启动 → 数据工厂生成演示数据（相对今天、固定种子、分布可控）→ 落盘到本地 SQLite
 *   再次启动 → 从本地 SQLite 恢复，用户的所有增删改都会自动保存
 *
 * 数据全部留在本机：Electron 写 userData 下的 .db 文件，浏览器走 IndexedDB。
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as db from '../utils/database'
import {
  daysAgoDate, daysAgoDateTime, now, formatDate,
  daysSince, dueDate, daysUntilDue, equipmentAgeYears, parseDate, addDays
} from '../utils/dates'
import { buildDemoDataset, auditDataset, DEFAULT_FLEET_SIZE } from '../utils/fleetData'
import { evaluateHealth, evaluateTrend, computeOverdueDays as healthComputeOverdueDays,
  resetHealthConfig } from '../utils/health'
import { buildFaultStats } from '../utils/faultStats'
import { buildDefaultKnowledge, extractKnowledgeFromOrders } from '../utils/knowledgeBase'
import { draftFaultCase, buildFaultCasesFromOrders } from '../utils/faultCaseDraft'
import { createNlActions } from './nlActions'
import { createPersistence } from './persistence'
import { createPartsDomain } from './partsDomain'
import { createDocumentDomain } from './documentDomain'
import { createSettingsDomain } from './settingsDomain'

// 界面文案字典（设备/工单状态、优先级、类型、维保类型样式）统一放在 utils/dictionaries.js。
// 这里只做转发，不保留第二份实现 —— 之前那份躺在这里，一个页面都没用上。
export {
  MAINTENANCE_TYPES,
  MAINTENANCE_TYPE_STYLE,
  maintenanceStyle,
  WORK_ORDER_STATUS,
  statusLabel as orderStatusLabel,
  statusTagType as orderStatusTagType
} from '../utils/dictionaries'

const SEED_VERSION = '3'
const FLEET_SIZE = DEFAULT_FLEET_SIZE

/**
 * meta 标记：随包示例手册是否已经导入过
 *
 * 与 SEED_VERSION 分开：种子版本升级时会重写演示数据，但用户自己删掉的手册
 * 不该因为"种子升级了"而复活。两者管的是不同的事，所以不共用一个键。
 */
const BUNDLED_DOCS_META = 'bundled_docs_seeded'

/** 超期天数：未超期返回 null（统一由 utils/health.js 提供，此处转发以保持旧调用可用） */
export function computeOverdueDays(eq) {
  return healthComputeOverdueDays(eq)
}

/** 工单类型 → 对应的复诊间隔（天）；巡检不需要复诊 */
export const RECHECK_INTERVAL = {
  repair: 7,
  maintenance: 30,
  inspection: null
}

/**
 * 工单状态机：只允许这些流转，其余一律拒绝（返回 null）。
 *
 * 为什么 completed 还能退回 processing：
 *   口述录入的"撤销上一步"要把已完成的工单退回去（nlCommand.js 的 undo）。
 *   退回**不会**清掉 archived_at，所以再次完成时不会重复归档 ——
 *   幂等性靠 archived_at 保证，不靠状态回退路径。
 */
export const WORK_ORDER_TRANSITIONS = {
  pending: ['assigned', 'processing', 'completed'],
  assigned: ['processing', 'completed', 'pending'],
  processing: ['completed', 'assigned'],
  completed: ['processing']
}

/**
 * 生成演示数据：委托给数据工厂（utils/fleetData.js）
 * 工厂负责规模、机型白名单、分布与可复现性；这里只做一次分布审计并打印，
 * 便于开发期及时发现"演示数据撑不起画面"的问题。
 */
function buildSeed() {
  const dataset = buildDemoDataset({ size: FLEET_SIZE })
  const audit = auditDataset(dataset)
  /**
   * 故障案例卡不是独立造的一份数据，而是从"已完成的维修工单"派生出来的 ——
   * 与运行时工单完工归档用的是同一个函数（utils/faultCaseDraft.js）。
   *
   * 为什么不手写一批案例：案例卡的全部说服力在于"可溯源到工单 #NNNN"。
   * 手写的案例症状写得再漂亮，点开源头工单要么对不上、要么根本不存在，
   * 那比案例库空着更糟。演示数据里每一张卡都能点到它那张单子。
   */
  const seedFaultCases = buildFaultCasesFromOrders(dataset.workOrders, dataset.equipment, buildDefaultKnowledge())
  console.info(
    `[演示数据] ${audit.equipmentCount} 台设备 / 超期 ${audit.overdueCount} 台（重度 ${audit.severeOverdueCount}）/ ` +
    `健康分档 A${audit.levels.A} B${audit.levels.B} C${audit.levels.C} D${audit.levels.D} / ` +
    `${audit.workOrderCount} 张工单 / ${audit.maintenanceCount} 条维保记录 / ${audit.snapshotCount} 条健康快照 / ` +
    `${seedFaultCases.length} 张故障案例卡`
  )
  return {
    equipment: dataset.equipment,
    maintenanceRecords: dataset.maintenanceRecords,
    workOrders: dataset.workOrders,
    healthSnapshots: dataset.healthSnapshots,
    faultCases: seedFaultCases
  }
}

// ============================================================
// Store
// ============================================================

export const useAppStore = defineStore('app', () => {
  // ---------- 状态 ----------
  const equipmentList = ref([])
  const maintenanceRecords = ref({})
  const workOrders = ref([])
  const healthSnapshots = ref([])
  const knowledgeItems = ref([])
  const documents = ref([])
  const faultCases = ref([])
  const partsInventory = ref([])
  const partTransactions = ref([])
  const recentLogs = ref([])

  const dbReady = ref(false)
  const dbError = ref('')
  const storageBackend = ref('')
  const lastSavedAt = ref('')
  const saving = ref(false)

  // ---------- 备件库存 ----------
  // 领域逻辑在 stores/partsDomain.js：种子、按名找件、出入库、维保联动扣减、缺料预警。
  // 必须建在 createPersistence 之前 —— 持久化层要拿 partsSeed 建期初台账、
  // 拿 consumePartsFromText 做期初回冲，这里是 const（不提升），到那行就已求值。
  // persistAll 反过来要等持久化层建好，所以包一层延迟取用：真正调它是在
  // 用户改库存的时候，那时早就建好了。
  const parts = createPartsDomain({
    partsInventory, partTransactions,
    persistAll: (...args) => persistAll(...args)
  })
  // 备件领域对外的接口原样接回 store（页面/端到端脚本刚才怎么用，现在还怎么用）
  const {
    getPartByName, adjustPartStock, restockPart, issuePart,
    addPart, consumePartsFromText, lowStockParts
  } = parts

  // ---------- 手册库 ----------
  // 领域逻辑在 stores/documentDomain.js（存字节 / 抽文字层 / 打开原文）。
  // 同上，persistAll 与 addLog 都要等后面才就绪，包一层延迟取用。
  const { addDocument, removeDocument, openDocument, seedBundledDocuments } = createDocumentDomain({
    documents,
    persistAll: (...args) => persistAll(...args),
    addLog: (...args) => addLog(...args)
  })

  // ---------- 演示操作日志 ----------
  // 必须定义在 createPersistence 之前：它是 const（不提升），
  // 在下面那行把它交给持久化层时就已经被求值了。
  const SEED_LOGS = () => [
    { time: daysAgoDateTime(1), content: '从「生产部_设备清单.xlsx」导入 60 台设备至台账', source: 'Excel', type: 'primary', tagType: 'primary' },
    { time: daysAgoDateTime(1), content: '通过语音创建工单：液压系统压力异常', source: '语音', type: 'success', tagType: 'success' },
    { time: daysAgoDateTime(2), content: '拍照识别巡检单，自动生成 3 张巡检工单', source: 'OCR', type: 'warning', tagType: 'warning' },
    { time: daysAgoDateTime(3), content: '完成 12 台设备健康体检，生成 3 份风险报告', source: 'AI', type: 'info', tagType: 'info' },
    { time: daysAgoDateTime(4), content: '从「维修部_维保记录.xlsx」导入 40 条维保记录', source: 'Excel', type: 'primary', tagType: 'primary' }
  ]

  /**
   * 持久化层：行映射 / 落盘 / 从库恢复 / 演示数据装载，全部在 stores/persistence.js。
   * 这里只把 ref 和几个工厂函数注入进去 —— ref 还是这些 ref，不存在第二份状态。
   * 注入的工厂函数都是函数声明（有提升），所以在本行之前定义与否都不影响。
   */
  const persistence = createPersistence({
    equipmentList, maintenanceRecords, workOrders, healthSnapshots, knowledgeItems,
    documents, faultCases, partsInventory, partTransactions, recentLogs,
    dbReady, dbError, storageBackend, lastSavedAt, saving,
    buildSeed, seedLogs: SEED_LOGS, buildDefaultKnowledge,
    partsSeed: parts.partsSeed, consumePartsFromText: parts.consumePartsFromText
  })
  const {
    persistAll, scheduleSave, saveNow, hydrateFromDb, applySeedData
  } = persistence

  // ---------- 演示参数设置 / meta / 告警处置 ----------
  const settings = ref(null)

  // 领域逻辑在 stores/settingsDomain.js。三者的共同点是"存在库的 meta 表里、
  // 不属于任何业务实体"。这里建在持久化层之后——scheduleSave 已经就绪；
  // addLog 是函数声明（提升），当成闭包传进去即可。
  const {
    defaultSettings, loadSettings, updateSettings, resetSettings,
    getAlertDispositions, setAlertDispositions, clearAlertDispositions
  } = createSettingsDomain({
    settings, dbReady, scheduleSave,
    addLog: (...args) => addLog(...args)
  })

  /**
   * 确保随包示例手册在库里（幂等）
   *
   * 只在 meta 里没有标记时导入一次。为什么要有这个标记：
   * 手册库是用户能删东西的地方，如果每次启动都"补齐缺的那几份"，
   * 用户删掉的示例手册下次启动就会自己回来——那不是补齐，是删不掉。
   * 于是改成"只补这一次"，删了就一直是删了。
   *
   * 代价是「恢复演示数据」必须把标记一起清掉才会重新出现——而 resetToSeedData
   * 会整库重建（meta 表一并清空），所以那里天然就是对的，无需额外处理。
   */
  async function ensureBundledDocuments() {
    if (dbReady.value && db.getMeta(BUNDLED_DOCS_META)) return []
    const added = await seedBundledDocuments()
    if (dbReady.value) {
      db.setMeta(BUNDLED_DOCS_META, now())
      await saveNow()
    }
    return added
  }

  /**
   * 启动时调用：打开本地数据库 → 有数据就恢复，没有就写入演示数据
   */
  async function initStore() {
    try {
      await db.initDatabase()
      storageBackend.value = db.storageInfo.backend()
      dbReady.value = true
      dbError.value = ''

      const seedVersion = db.getMeta('seed_version')
      const hasData = db.count('equipment') > 0

      if (!hasData) {
        applySeedData()
        persistAll()
        await saveNow()
        db.setMeta('seed_version', SEED_VERSION)
        await saveNow()
      } else {
        hydrateFromDb()
        if (seedVersion !== SEED_VERSION) {
          // 种子结构升级：只记录版本，不覆盖用户数据
          db.setMeta('seed_version', SEED_VERSION)
          await saveNow()
        }
        await saveNow()
      }
      // 老库（本次升级前装的）也要有示例手册：标记只在"这一版之后"才存在，
      // 所以这里对新装和升级是同一段代码，不需要分别处理
      await ensureBundledDocuments()
      loadSettings()
      return true
    } catch (error) {
      // 数据库不可用时降级为纯内存演示，功能仍然可用
      dbReady.value = false
      dbError.value = error.message
      console.warn('[数据库] 初始化失败，降级为内存模式：', error)
      applySeedData()
      await ensureBundledDocuments()
      return false
    }
  }

  /**
   * 从数据库重新装载全部内存状态（导入备份后必须调用）
   *
   * ⚠️ 为什么必须有这一步：导入备份替换的是整库字节，而 Pinia 里的数组
   * 仍然是"导入前"的那一份。此时哪怕只是记一条操作日志触发 persistAll()，
   * 也会把旧数据整表写回，等于把用户刚导入的备份又覆盖掉——界面上却提示"导入成功"。
   */
  async function reloadFromDb() {
    if (!dbReady.value) return false
    const hydrated = hydrateFromDb()
    if (!hydrated) {
      // 备份里没有设备台账（空库）→ 按新装处理，避免旧数据残留在内存里被再次写回
      applySeedData()
    }
    db.setMeta('seed_version', SEED_VERSION)
    persistAll()
    await saveNow()
    return true
  }

  /** 恢复演示数据：清空本地库并重新生成（日期重新对齐到今天） */
  async function resetToSeedData() {
    await db.destroyDatabase({ clearStorage: true })
    dbReady.value = false
    await db.initDatabase()
    storageBackend.value = db.storageInfo.backend()
    dbReady.value = true
    dbError.value = ''

    applySeedData()
    persistAll()
    db.setMeta('seed_version', SEED_VERSION)
    resetHealthConfig()
    clearAlertDispositions()
    settings.value = defaultSettings()
    // 整库刚被重建，示例手册的标记也一起没了 → 这里会重新导入，
    // 也就是"恢复演示数据"确实把手册库也恢复成出厂状态
    await ensureBundledDocuments()
    await saveNow()
  }

  // ---------- 计算属性 ----------
  const stats = computed(() => {
    const list = equipmentList.value
    return {
      equipmentCount: list.length,
      runningCount: list.filter(e => e.status === 'running').length,
      maintenanceCount: list.filter(e => e.status === 'maintenance').length,
      faultCount: list.filter(e => e.status === 'fault').length,
      idleCount: list.filter(e => e.status === 'idle').length
    }
  })

  /** 品牌分布（体现"在管设备不挑品牌"） */
  const brandStats = computed(() => {
    const map = {}
    for (const eq of equipmentList.value) {
      const brand = eq.model && eq.model.includes(' ') ? eq.model.split(' ')[0] : '其他'
      map[brand] = (map[brand] || 0) + 1
    }
    return Object.entries(map).map(([brand, count]) => ({ brand, count }))
      .sort((a, b) => b.count - a.count)
  })

  /** 设备 + 其健康评估（列表页与看板共用，避免每处各算一次） */
  const equipmentWithHealth = computed(() => equipmentList.value.map(eq => ({
    ...eq,
    health: evaluateHealth(eq)
  })))

  /** 健康分档分布 */
  const healthLevelStats = computed(() => {
    const levels = { A: 0, B: 0, C: 0, D: 0 }
    for (const item of equipmentWithHealth.value) levels[item.health.level]++
    return levels
  })

  /** 超期设备列表（含超期天数），按超期严重程度排序 */
  const overdueList = computed(() => {
    return equipmentList.value
      .map(eq => {
        const overdueDays = computeOverdueDays(eq)
        if (overdueDays === null) return null
        return { ...eq, overdueDays, daysSince: daysSince(eq.last_maintenance_date) }
      })
      .filter(Boolean)
      .sort((a, b) => b.overdueDays - a.overdueDays)
  })

  /** 维保即将到期（默认 14 天内）的设备 */
  const upcomingList = computed(() => {
    return equipmentList.value
      .map(eq => {
        const daysUntil = daysUntilDue(eq.last_maintenance_date, eq.maintenance_cycle_days)
        if (daysUntil === null || daysUntil < 0 || daysUntil > 14) return null
        return { ...eq, daysUntil, dueDate: dueDate(eq.last_maintenance_date, eq.maintenance_cycle_days) }
      })
      .filter(Boolean)
      .sort((a, b) => a.daysUntil - b.daysUntil)
  })

  /** 需立即处置的设备（D 级或超期 > 45 天），看板红色预警用 */
  const criticalList = computed(() =>
    equipmentWithHealth.value
      .filter(item => item.health.level === 'D')
      .sort((a, b) => a.health.score - b.health.score)
  )

  const nextWorkOrderId = computed(() => {
    const maxId = workOrders.value.reduce((max, o) => Math.max(max, Number(o.id) || 0), 1000)
    return maxId + 1
  })

  const nextEquipmentId = computed(() => {
    const maxId = equipmentList.value.reduce((max, e) => Math.max(max, Number(e.id) || 0), 0)
    return maxId + 1
  })

  const nextFaultCaseId = computed(() => {
    const maxId = faultCases.value.reduce((max, c) => Math.max(max, Number(c.id) || 0), 0)
    return maxId + 1
  })

  // ---------- 故障案例自动沉淀 ----------
  function addFaultCase(item) {
    const record = {
      id: nextFaultCaseId.value,
      equipment_name: item.equipment_name || '',
      category: item.category || '',
      symptom: item.symptom || '',
      cause: item.cause || '',
      solution: item.solution || '',
      parts_used: item.parts_used || '',
      source_order_id: item.source_order_id || null,
      repair_hours: item.repair_hours != null ? Number(item.repair_hours) : null,
      // 允许调用方指定产生时间：演示数据是"历史工单派生的历史案例"，
      // 一律用 now() 会把半年的案例全堆在启动那一天
      createdAt: item.createdAt || now()
    }
    faultCases.value.unshift(record)
    persistAll()
    return record
  }

  function getFaultCases() {
    return faultCases.value
  }


  // ---------- 健康快照 ----------
  function getSnapshots(equipmentId) {
    return healthSnapshots.value
      .filter(s => String(s.equipment_id) === String(equipmentId))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
  }

  /** 记录一条健康快照（工单完成、录入维保时自动调用） */
  function addHealthSnapshot(equipmentId, { date, score, level, factors } = {}, { silent = false } = {}) {
    const eq = equipmentList.value.find(e => String(e.id) === String(equipmentId))
    if (!eq) return null
    const health = score === undefined ? evaluateHealth(eq) : null
    const snap = {
      equipment_id: Number(equipmentId),
      date: date || now().slice(0, 10),
      score: score === undefined ? health.score : Number(score),
      level: level || (health ? health.level : null),
      factors_json: factors ? JSON.stringify(factors) : null
    }
    healthSnapshots.value.push(snap)
    if (!silent) persistAll()
    return snap
  }

  /** 某台设备的健康趋势 */
  function getTrend(equipmentId) {
    return evaluateTrend(getSnapshots(equipmentId))
  }

  /** 全部"恶化中"设备（看板预警用） */
  const worseningList = computed(() =>
    equipmentWithHealth.value
      .map(item => ({ ...item, trend: getTrend(item.id) }))
      .filter(item => item.trend.kind === 'worsening')
      .sort((a, b) => (a.trend.delta ?? 0) - (b.trend.delta ?? 0))
  )

  /** 高频故障 TOP（数据来自本地真实工单 + 维保记录，自动沉淀） */
  const faultTopStats = computed(() =>
    buildFaultStats({ workOrders: workOrders.value, maintenanceRecords: maintenanceRecords.value })
  )

  // ---------- 复诊闭环 ----------
  const recheckList = computed(() =>
    workOrders.value
      .filter(o => o.recheck_date && o.recheck_status === 'pending')
      .sort((a, b) => String(a.recheck_date).localeCompare(String(b.recheck_date)))
  )

  const recheckStats = computed(() => {
    const due = workOrders.value.filter(o => o.recheck_status === 'done' || o.recheck_status === 'pending').length
    const done = workOrders.value.filter(o => o.recheck_status === 'done').length
    return {
      due,
      done,
      pending: due - done,
      rate: due > 0 ? Math.round((done / due) * 100) : null
    }
  })

  function markRecheckDone(orderId) {
    const order = workOrders.value.find(o => o.id === orderId)
    if (!order) return null
    order.recheck_status = 'done'
    addLog({
      content: `复诊完成：${order.equipment_name}「${order.title}」`,
      source: '复诊',
      type: 'success',
      tagType: 'success'
    })
    persistAll()
    return order
  }

  function markRecheckNotNeeded(orderId) {
    const order = workOrders.value.find(o => o.id === orderId)
    if (!order) return null
    order.recheck_status = 'not_needed'
    persistAll()
    return order
  }

  // ---------- 方法 ----------
  function addEquipment(eq, { silent = false } = {}) {
    const record = {
      id: nextEquipmentId.value,
      name: eq.name || '未命名设备',
      model: eq.model || '',
      category: eq.category || '',
      location: eq.location || '',
      purchase_date: eq.purchase_date || '',
      status: eq.status || 'running',
      maintenance_cycle_days: Number(eq.maintenance_cycle_days) || 90,
      last_maintenance_date: eq.last_maintenance_date || null,
      notes: eq.notes || ''
    }
    equipmentList.value.push(record)
    if (!silent) persistAll()
    return record
  }

  function addWorkOrder(order) {
    const record = {
      id: nextWorkOrderId.value,
      status: 'pending',
      source: 'manual',
      created_at: now(),
      recheck_date: null,
      recheck_status: 'not_needed',
      ...order
    }
    // 关联设备：优先按 id，其次按名称匹配
    if (!record.equipment_id && record.equipment_name) {
      const eq = equipmentList.value.find(e => e.name === record.equipment_name)
      if (eq) record.equipment_id = eq.id
    }
    workOrders.value.unshift(record)
    persistAll()
    return record
  }

  /**
   * 工单状态流转
   * 完成时会自动做三件事（这是"病历归档 + 处方闭环"的落点）：
   *   1) 写回一条维保记录（设备病历）
   *   2) 落一条健康快照（趋势的来源）
   *   3) 生成复诊任务（维修 7 天 / 保养 30 天；巡检不复诊）
   */
  function updateWorkOrderStatus(id, newStatus) {
    const order = workOrders.value.find(o => o.id === id)
    if (!order) return null
    if (newStatus === order.status) return order   // 同状态重复设置视为无操作
    if (!WORK_ORDER_TRANSITIONS[order.status]?.includes(newStatus)) return null

    order.status = newStatus
    order.completed_at = newStatus === 'completed' ? now() : undefined

    // 归档只做一次：以 archived_at 这个**落库的**标记为准，而不是看当前 status。
    // 否则"完成 → 改回处理中 → 再完成"会把病历、健康快照、复诊任务、
    // 知识草案、故障案例卡、日志各再生产一份，而且没有任何报错。
    if (newStatus === 'completed' && !order.archived_at) {
      order.archived_at = now()
      archiveWorkOrder(order)
    }
    persistAll()
    return order
  }

  /** 工单完成 → 归档病历 + 落快照 + 生成复诊任务 */
  function archiveWorkOrder(order) {
    const eq = order.equipment_id
      ? equipmentList.value.find(e => String(e.id) === String(order.equipment_id))
      : equipmentList.value.find(e => e.name === order.equipment_name)

    if (eq) {
      addMaintenanceRecord(eq.id, {
        date: now().slice(0, 10),
        type: order.type === 'repair' ? '故障维修' : (order.type === 'inspection' ? '巡检' : '定期保养'),
        description: order.title || '工单归档',
        technician: order.assigned_to || '',
        parts_used: ''
      }, { silent: true })

      // 病历写入后设备状态恢复，快照记录的是"处置完成后的健康状态"
      if (eq.status === 'fault') eq.status = 'maintenance'
      addHealthSnapshot(eq.id, {}, { silent: true })
    }

    const interval = RECHECK_INTERVAL[order.type]
    if (interval) {
      order.recheck_date = addDays(now().slice(0, 10), interval)
      order.recheck_status = 'pending'
    } else {
      order.recheck_date = null
      order.recheck_status = 'not_needed'
    }

    addLog({
      content: `工单 #${order.id}「${order.title}」已完成，已归档至${order.equipment_name}设备病历` +
        (interval ? `，${interval} 天后复诊` : ''),
      source: '工单',
      type: 'success',
      tagType: 'success'
    }, { silent: true })

    // AI 知识提炼：工单完成后自动分析是否存在高频故障模式
    if (order.equipment_id) {
      const drafted = extractKnowledgeFromOrders(
        { equipmentList: equipmentList.value, workOrders: workOrders.value, knowledgeItems: knowledgeItems.value, getMaintenanceByEquipmentId },
        order.equipment_id
      )
      if (drafted > 0) {
        addLog({
          content: `AI 自动提炼：从${order.equipment_name}的工单记录中发现 ${drafted} 条高频故障模式，已生成知识草案`,
          source: 'AI',
          type: 'primary',
          tagType: 'primary'
        }, { silent: true })
      }
    }

    // 故障案例自动沉淀：维修工单完工 → 生成结构化案例卡（症状/原因/处理，可溯源）。
    // 推导规则在 utils/faultCaseDraft.js —— 演示数据工厂用的是同一份，两边不会漂移。
    const draft = draftFaultCase(order, {
      equipmentList: equipmentList.value,
      knowledgeItems: knowledgeItems.value
    })
    if (draft) {
      addFaultCase(draft)
      addLog({
        content: `故障案例自动沉淀：「${order.title}」已归档为结构化案例，可在故障案例库查看`,
        source: 'AI',
        type: 'success',
        tagType: 'success'
      }, { silent: true })
    }
  }

  function updateWorkOrder(id, patch) {
    const order = workOrders.value.find(o => o.id === id)
    if (!order) return null
    Object.assign(order, patch)
    persistAll()
    return order
  }

  /**
   * 派单：指定维修班组/人员，工单进入"已派单"（待处理）
   * 状态机：待派单(pending) → 已派单(assigned) → 维修中(processing) → 已完成(completed)
   */
  function dispatchWorkOrder(id, assignedTo) {
    const order = workOrders.value.find(o => o.id === id)
    if (!order) return null
    Object.assign(order, { assigned_to: assignedTo, status: 'assigned', updated_at: now() })
    persistAll()
    addLog({
      content: `工单 #${id}「${order.title}」已派单给 ${assignedTo}`,
      source: '工单',
      type: 'primary',
      tagType: 'primary'
    })
    return order
  }

  function addMaintenanceRecord(equipmentId, record, { silent = false } = {}) {
    const key = String(equipmentId)
    if (!maintenanceRecords.value[key]) maintenanceRecords.value[key] = []
    maintenanceRecords.value[key].unshift({
      type: '定期保养',
      ...record,
      date: record.date || now().slice(0, 10),
      typeLabel: record.type || '定期保养'
    })
    // 同步设备的上次维保日期
    const eq = equipmentList.value.find(e => String(e.id) === key)
    if (eq && record.date && (!eq.last_maintenance_date || record.date > eq.last_maintenance_date)) {
      eq.last_maintenance_date = record.date
      if (eq.status === 'maintenance') eq.status = 'running'
    }
    // 备件联动：记录里填的配件自动从台账扣减并记流水（缺料会进告警中心）
    if (record.parts_used) {
      const r = consumePartsFromText(record.parts_used, '维保记录', Number(equipmentId))
      if (r.consumed > 0) {
        addLog({
          content: `备件联动：维保记录自动扣减 ${r.consumed} 项配件库存（${r.matched.join('、')}）`,
          source: '备件',
          type: 'warning',
          tagType: 'warning'
        }, { silent: true })
      }
      // 对不上台账 / 库存为 0 的配件必须在操作日志里留痕，否则"账实不符"无人知晓
      if (r.unmatched.length) {
        addLog({
          content: `备件联动：配件「${r.unmatched.join('、')}」在备件台账中不存在，未扣减库存（可到备件库存页新增后补录出库）`,
          source: '备件',
          type: 'warning',
          tagType: 'warning'
        }, { silent: true })
      }
      if (r.short.length) {
        addLog({
          content: `备件联动：配件「${r.short.join('、')}」库存为 0，已用超领未扣减，请及时补货`,
          source: '备件',
          type: 'danger',
          tagType: 'danger'
        }, { silent: true })
      }
    }
    if (!silent) persistAll()
  }

  // ---------- 知识库管理（增删改即时生效，演示爆点：录一条 → AI 立刻能答） ----------
  function nextKnowledgeId() {
    const stamp = now().slice(0, 10).replace(/-/g, '')
    const ids = new Set(knowledgeItems.value.map(i => i.id))
    let n = 1
    while (ids.has(`custom-${stamp}-${n}`)) n++
    return `custom-${stamp}-${n}`
  }

  function normalizeKeywords(value) {
    if (Array.isArray(value)) return value.map(k => String(k).trim()).filter(Boolean)
    return String(value || '').split(/[,，]/).map(k => k.trim()).filter(Boolean)
  }

  function normalizeLines(value) {
    if (Array.isArray(value)) return value.map(s => String(s).trim()).filter(Boolean)
    return String(value || '').split('\n').map(s => s.trim()).filter(Boolean)
  }

  function addKnowledgeItem(item) {
    const record = {
      id: item.id || nextKnowledgeId(),
      title: String(item.title || '').trim(),
      category: item.category || '其他',
      keywords: normalizeKeywords(item.keywords),
      symptoms: String(item.symptoms || '').trim(),
      causes: normalizeLines(item.causes),
      steps: normalizeLines(item.steps),
      source: String(item.source || '').trim() || '现场录入',
      created_at: now(),
      // AI 知识进化扩展字段
      status: item.status || 'confirmed',
      frequency: Number(item.frequency) || 0,
      avg_repair_hours: Number(item.avg_repair_hours) || null
    }
    if (!record.title) return null
    knowledgeItems.value.unshift(record)
    addLog({
      content: `知识库新增条目「${record.title}」`,
      source: '知识库',
      type: 'success',
      tagType: 'success'
    }, { silent: true })
    persistAll()
    return record
  }

  function updateKnowledgeItem(id, patch) {
    const item = knowledgeItems.value.find(i => i.id === id)
    if (!item) return null
    if (patch.title !== undefined) item.title = String(patch.title).trim()
    if (patch.category !== undefined) item.category = patch.category
    if (patch.keywords !== undefined) item.keywords = normalizeKeywords(patch.keywords)
    if (patch.symptoms !== undefined) item.symptoms = String(patch.symptoms).trim()
    if (patch.causes !== undefined) item.causes = normalizeLines(patch.causes)
    if (patch.steps !== undefined) item.steps = normalizeLines(patch.steps)
    if (patch.source !== undefined) item.source = String(patch.source).trim() || '现场录入'
    addLog({
      content: `知识库更新条目「${item.title}」`,
      source: '知识库',
      type: 'primary',
      tagType: 'primary'
    }, { silent: true })
    persistAll()
    return item
  }

  function removeKnowledgeItem(id) {
    const item = knowledgeItems.value.find(i => i.id === id)
    if (!item) return false
    knowledgeItems.value = knowledgeItems.value.filter(i => i.id !== id)
    addLog({
      content: `知识库删除条目「${item.title}」`,
      source: '知识库',
      type: 'warning',
      tagType: 'warning'
    }, { silent: true })
    persistAll()
    return true
  }

  function resetKnowledgeBase() {
    knowledgeItems.value = buildDefaultKnowledge()
    addLog({
      content: `知识库已重置为默认 ${knowledgeItems.value.length} 条规程`,
      source: '知识库',
      type: 'info',
      tagType: 'info'
    }, { silent: true })
    persistAll()
  }

  // ---------- 手册资料库 ----------
  const documentStats = computed(() => {
    const list = documents.value
    return {
      total: list.length,
      ready: list.filter(d => d.status === 'ready').length,
      viewOnly: list.filter(d => d.status === 'view_only').length,
      pages: list.reduce((sum, d) => sum + (Number(d.pages) || 0), 0)
    }
  })

  /**
   * 添加文档：保存文件 → 提取文本 → 登记元数据
   * @param {Object} input { file: File, title, docType, model, category }
   * @returns {Promise<{ok:boolean, doc?:Object, error?:string}>}
   */

  /** 删除文档：删记录 + 删文件字节 */

  /** 用系统阅读器 / 新窗口打开文档原文 */

  /**
   * AI 检索池：内置规程 + 手册文本切片（命中时出处 = 手册名 + 页码）
   * 切片转成与知识条目同构的对象，复用 searchKnowledge 的关键词打分与渲染
   */
  const answerItems = computed(() => {
    const base = [...knowledgeItems.value]
    for (const doc of documents.value) {
      if (doc.status !== 'ready' || !doc.chunks || !doc.chunks.length) continue
      for (const chunk of doc.chunks.slice(0, 120)) {
        base.push({
          id: `${doc.id}-p${chunk.page}`,
          title: `《${doc.title}》· 第 ${chunk.page} 页`,
          category: '手册原文',
          keywords: [doc.title, doc.docType, doc.model, doc.category].filter(Boolean),
          symptoms: `手册原文片段（${doc.title} 第 ${chunk.page} 页）`,
          causes: [],
          steps: [chunk.text],
          source: `本地手册 · ${doc.title}`,
          caveat: '本条为手册原文节选，完整内容请打开手册核对'
        })
      }
    }
    return base
  })

  /** Excel 导入：按设备名 upsert 台账，并把维保类行落成维保记录 */
  function importFromExcel(rows) {
    const result = { created: 0, updated: 0, records: 0, skipped: 0, issues: [], equipmentNames: [] }

    for (const row of rows || []) {
      const name = String(row['设备名称'] ?? row['name'] ?? '').trim()
      if (!name) { result.skipped++; continue }

      const patch = {
        model: row['设备型号'] ? String(row['设备型号']).trim() : '',
        category: row['设备类别'] ? String(row['设备类别']).trim() : '',
        location: row['所在位置'] ? String(row['所在位置']).trim() : '',
        purchase_date: normalizeDateCell(row['购置日期'])
      }

      let equipment = equipmentList.value.find(e => e.name === name)
      if (equipment) {
        for (const [key, value] of Object.entries(patch)) {
          if (value) equipment[key] = value
        }
        result.updated++
      } else {
        equipment = addEquipment({ name, ...patch }, { silent: true })
        result.created++
      }
      if (!result.equipmentNames.includes(name)) result.equipmentNames.push(name)

      const recordDate = normalizeDateCell(row['维保日期'])
      const description = String(row['维保内容'] ?? row['故障描述'] ?? '').trim()
      if (recordDate && description) {
        addMaintenanceRecord(equipment.id, {
          date: recordDate,
          type: row['故障描述'] && !row['维保内容'] ? '故障维修' : '定期保养',
          description,
          technician: String(row['维保人员'] ?? '').trim(),
          parts_used: String(row['配件名称'] ?? '').trim()
        }, { silent: true })
        result.records++
      }

      if (!recordDate && !patch.model) {
        result.issues.push(`${name}：缺少型号与维保日期，仅导入名称`)
      }
    }

    if (!result.created && !result.updated) result.skipped = (rows || []).length

    addLog({
      content: `Excel 导入台账：新增 ${result.created} 台 / 更新 ${result.updated} 台 / 生成 ${result.records} 条维保记录`,
      source: 'Excel',
      type: 'primary',
      tagType: 'primary'
    }, { silent: true })
    persistAll()
    return result
  }

  /** 把 Excel 里的日期单元格统一成 YYYY-MM-DD */
  function normalizeDateCell(value) {
    if (value === undefined || value === null || value === '') return ''
    if (value instanceof Date) return formatDate(value)
    if (typeof value === 'number') {
      // Excel 序列号（1900 日期系统）
      const ms = Math.round((value - 25569) * 86400 * 1000)
      const date = new Date(ms)
      return Number.isNaN(date.getTime()) ? '' : formatDate(date)
    }
    const parsed = parseDate(value)
    return parsed ? formatDate(parsed) : String(value).trim()
  }

  function getEquipmentByName(name) {
    return equipmentList.value.find(e => e.name === name)
  }

  function getMaintenanceByEquipmentId(id) {
    return maintenanceRecords.value[String(id)] || maintenanceRecords.value[id] || []
  }

  function getOrdersByEquipmentName(name) {
    return workOrders.value.filter(o => o.equipment_name === name)
  }

  function addLog(entry, { silent = false } = {}) {
    recentLogs.value.unshift({ time: now(), ...entry })
    recentLogs.value = recentLogs.value.slice(0, 50)
    if (!silent) persistAll()
  }

  /** 演示数据分布审计（开发期与验收用） */
  function audit() {
    return auditDataset({
      equipment: equipmentList.value,
      maintenanceRecords: maintenanceRecords.value,
      workOrders: workOrders.value,
      healthSnapshots: healthSnapshots.value
    })
  }

  /**
   * 口述录入所需的扩展动作（撤销、状态直改、快照还原、溯源日志）
   * 放在独立模块里避免 appStore 继续膨胀；这里注入依赖并并入对外接口。
   * undoStack 必须是响应式的：侧边栏的撤销入口依赖它触发更新。
   */
  const undoStack = ref([])

  const nlActions = createNlActions({
    equipmentList,
    maintenanceRecords,
    healthSnapshots,
    workOrders,
    recentLogs,
    undoStack,
    persistAll,
    addLog,
    now
  })

  return {
    // 数据
    equipmentList,
    maintenanceRecords,
    workOrders,
    healthSnapshots,
    knowledgeItems,
    recentLogs,
    settings,
    // 状态
    dbReady,
    dbError,
    storageBackend,
    lastSavedAt,
    saving,
    // 计算属性
    stats,
    brandStats,
    equipmentWithHealth,
    healthLevelStats,
    overdueList,
    upcomingList,
    criticalList,
    worseningList,
    faultTopStats,
    recheckList,
    recheckStats,
    nextWorkOrderId,
    nextEquipmentId,
    // 生命周期
    initStore,
    reloadFromDb,
    resetToSeedData,
    saveNow,
    getAlertDispositions,
    setAlertDispositions,
    clearAlertDispositions,
    // 方法
    addEquipment,
    addWorkOrder,
    updateWorkOrderStatus,
    updateWorkOrder,
    dispatchWorkOrder,
    addMaintenanceRecord,
    addHealthSnapshot,
    getSnapshots,
    getTrend,
    markRecheckDone,
    markRecheckNotNeeded,
    archiveWorkOrder,
    importFromExcel,
    getEquipmentByName,
    getMaintenanceByEquipmentId,
    getOrdersByEquipmentName,
    addKnowledgeItem,
    updateKnowledgeItem,
    removeKnowledgeItem,
    addFaultCase,
    getFaultCases,
    faultCases,
    partsInventory,
    partTransactions,
    lowStockParts,
    addPart,
    restockPart,
    issuePart,
    adjustPartStock,
    getPartByName,
    consumePartsFromText,
    resetKnowledgeBase,
    documents,
    documentStats,
    answerItems,
    addDocument,
    removeDocument,
    openDocument,
    updateSettings,
    resetSettings,
    addLog,
    audit,
    // 口述录入扩展动作
    removeWorkOrder: nlActions.removeWorkOrder,
    updateEquipment: nlActions.updateEquipment,
    replaceMaintenanceRecords: nlActions.replaceMaintenanceRecords,
    replaceHealthSnapshots: nlActions.replaceHealthSnapshots,
    logVoiceAction: nlActions.logVoiceAction,
    // 口述录入的撤销（全局能力，与聊天消息解耦）
    pushUndo: nlActions.pushUndo,
    getUndoStack: nlActions.getUndoStack,
    canUndo: nlActions.canUndo,
    peekUndo: nlActions.peekUndo,
    performUndo: nlActions.performUndo,
    clearUndoStack: nlActions.clearUndoStack
  }
})

export { daysSince, dueDate, daysUntilDue, equipmentAgeYears, now, daysAgoDate, daysAgoDateTime }
