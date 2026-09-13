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
import { PARTS_CATALOG } from '../utils/equipmentCatalog'
import { evaluateHealth, evaluateTrend, computeOverdueDays as healthComputeOverdueDays,
  configureHealth, resetHealthConfig, DAILY_OUTPUT_LOSS } from '../utils/health'
import { buildFaultStats } from '../utils/faultStats'
import { buildDefaultKnowledge, extractKnowledgeFromOrders } from '../utils/knowledgeBase'
import { docFileStore } from '../utils/docFileStore'
import { extractPdfText } from '../utils/pdfExtract'
import { createNlActions } from './nlActions'

const SEED_VERSION = '3'
const FLEET_SIZE = DEFAULT_FLEET_SIZE

/** 维保类型 → 展示样式（入库存中文类型，展示层映射颜色） */
export const MAINTENANCE_TYPES = ['定期保养', '故障维修', '部件更换', '巡检']

export const MAINTENANCE_TYPE_STYLE = {
  定期保养: { tagType: 'success', timelineType: 'success' },
  故障维修: { tagType: 'danger', timelineType: 'warning' },
  部件更换: { tagType: 'warning', timelineType: 'primary' },
  巡检: { tagType: 'info', timelineType: 'info' }
}

export function maintenanceStyle(type) {
  return MAINTENANCE_TYPE_STYLE[type] || { tagType: 'info', timelineType: 'info' }
}

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
 * 生成演示数据：委托给数据工厂（utils/fleetData.js）
 * 工厂负责规模、机型白名单、分布与可复现性；这里只做一次分布审计并打印，
 * 便于开发期及时发现"演示数据撑不起画面"的问题。
 */
function buildSeed() {
  const dataset = buildDemoDataset({ size: FLEET_SIZE })
  const audit = auditDataset(dataset)
  console.info(
    `[演示数据] ${audit.equipmentCount} 台设备 / 超期 ${audit.overdueCount} 台（重度 ${audit.severeOverdueCount}）/ ` +
    `健康分档 A${audit.levels.A} B${audit.levels.B} C${audit.levels.C} D${audit.levels.D} / ` +
    `${audit.workOrderCount} 张工单 / ${audit.maintenanceCount} 条维保记录 / ${audit.snapshotCount} 条健康快照`
  )
  return {
    equipment: dataset.equipment,
    maintenanceRecords: dataset.maintenanceRecords,
    workOrders: dataset.workOrders,
    healthSnapshots: dataset.healthSnapshots
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

  // ---------- 自动保存 ----------
  let saveTimer = null

  function toRow(value) {
    return value === undefined ? null : value
  }

  function equipmentToRows() {
    const stamp = now()
    return equipmentList.value.map(eq => ({
      id: Number(eq.id),
      name: eq.name || '',
      model: toRow(eq.model),
      category: toRow(eq.category),
      location: toRow(eq.location),
      purchase_date: toRow(eq.purchase_date),
      status: eq.status || 'running',
      maintenance_cycle_days: Number(eq.maintenance_cycle_days) || 90,
      last_maintenance_date: toRow(eq.last_maintenance_date),
      notes: toRow(eq.notes),
      created_at: eq.created_at || stamp,
      updated_at: stamp
    }))
  }

  function maintenanceToRows() {
    const stamp = now()
    const rows = []
    for (const [equipmentId, records] of Object.entries(maintenanceRecords.value)) {
      for (const record of records || []) {
        rows.push({
          equipment_id: Number(equipmentId),
          type: record.type || '定期保养',
          description: toRow(record.description),
          parts_used: toRow(record.parts_used || record.parts),
          cost: Number(record.cost) || 0,
          technician: toRow(record.technician),
          date: record.date || stamp.slice(0, 10),
          next_due_date: toRow(record.next_due_date),
          created_at: record.created_at || stamp
        })
      }
    }
    return rows
  }

  function workOrdersToRows() {
    const stamp = now()
    return workOrders.value.map(order => ({
      id: Number(order.id),
      equipment_id: order.equipment_id ?? null,
      equipment_name: toRow(order.equipment_name),
      title: order.title || '',
      description: toRow(order.description),
      type: order.type || 'maintenance',
      priority: order.priority || 'normal',
      status: order.status || 'pending',
      source: order.source || 'manual',
      assigned_to: toRow(order.assigned_to),
      created_at: order.created_at || stamp,
      completed_at: toRow(order.completed_at),
      updated_at: stamp,
      recheck_date: toRow(order.recheck_date),
      recheck_status: order.recheck_status || 'not_needed'
    }))
  }

  function healthSnapshotsToRows() {
    return healthSnapshots.value.map(snap => ({
      equipment_id: Number(snap.equipment_id),
      date: snap.date,
      score: Number(snap.score),
      level: snap.level || null,
      factors_json: snap.factors_json || null
    }))
  }

  function documentsToRows() {
    const stamp = now()
    return documents.value.map(doc => ({
      id: String(doc.id),
      title: doc.title || '',
      doc_type: doc.docType || '使用手册',
      model: toRow(doc.model),
      category: toRow(doc.category),
      file_name: toRow(doc.fileName),
      file_path: toRow(doc.filePath),
      file_size: Number(doc.fileSize) || 0,
      pages: Number(doc.pages) || 0,
      status: doc.status || 'ready',
      chunks_json: JSON.stringify(doc.chunks || []),
      note: toRow(doc.note),
      added_at: doc.addedAt || stamp
    }))
  }

  function knowledgeToRows() {
    const stamp = now()
    return knowledgeItems.value.map(item => ({
      id: String(item.id),
      title: item.title || '',
      category: item.category || '',
      keywords: Array.isArray(item.keywords) ? item.keywords.join(',') : String(item.keywords || ''),
      symptoms: item.symptoms || '',
      causes_json: JSON.stringify(item.causes || []),
      steps_json: JSON.stringify(item.steps || []),
      source: item.source || '',
      created_at: item.created_at || stamp,
      updated_at: stamp,
      status: item.status || 'confirmed',
      frequency: Number(item.frequency) || 0,
      avg_repair_hours: item.avg_repair_hours !== null && item.avg_repair_hours !== undefined ? Number(item.avg_repair_hours) : null
    }))
  }

  function faultCasesToRows() {
    const stamp = now()
    return faultCases.value.map(c => ({
      id: Number(c.id),
      equipment_name: c.equipment_name || '',
      category: c.category || '',
      symptom: c.symptom || '',
      cause: c.cause || '',
      solution: c.solution || '',
      parts_used: c.parts_used || '',
      source_order_id: c.source_order_id || null,
      repair_hours: c.repair_hours !== null && c.repair_hours !== undefined ? Number(c.repair_hours) : null,
      created_at: c.created_at || stamp
    }))
  }

  function partsToRows() {
    const stamp = now()
    return partsInventory.value.map(p => ({
      id: Number(p.id),
      name: p.name || '',
      category: p.category || '',
      stock: Number(p.stock) || 0,
      safety_stock: Number(p.safety_stock) || 0,
      unit_price: Number(p.unit_price) || 0,
      unit: p.unit || '件',
      updated_at: p.updated_at || stamp
    }))
  }

  function partTxToRows() {
    const stamp = now()
    return partTransactions.value.map(t => ({
      id: Number(t.id),
      part_id: Number(t.part_id),
      type: t.type || 'out',
      quantity: Number(t.quantity) || 0,
      ref_type: t.ref_type || '',
      ref_id: t.ref_id != null ? Number(t.ref_id) : null,
      note: t.note || '',
      created_at: t.created_at || stamp
    }))
  }

  /**
   * 操作日志落库
   *
   * ⚠️ 此前 recentLogs 只是内存里的种子数据：刷新即回到固定 4 条演示文案，
   * 用户真实操作（导入、体检、口述录入、撤销）全部丢失，而日志页却把它们
   * 当成"历史记录"展示。现在按 id 倒序落库——最新一条 id 最大，
   * 恢复时按 id 倒排即可还原时间顺序，不依赖字符串时间排序。
   */
  function logsToRows() {
    const list = recentLogs.value.slice(0, 50)
    return list.map((log, index) => ({
      id: list.length - index,
      time: log.time || now(),
      content: log.content || '',
      source: log.source || '',
      type: log.type || 'info',
      tag_type: log.tagType || log.type || 'info'
    }))
  }

  /** 立即写盘 */
  async function saveNow() {
    if (!dbReady.value) return false
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    saving.value = true
    try {
      const written = await db.persist()
      if (written) lastSavedAt.value = now()
      return written
    } catch (error) {
      dbError.value = `保存失败：${error.message}`
      console.error('[数据库] 保存失败', error)
      return false
    } finally {
      saving.value = false
    }
  }

  /** 去抖保存：避免连续编辑时频繁导出整库 */
  function scheduleSave() {
    if (!dbReady.value) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { saveNow() }, 600)
  }

  function persistAll() {
    // 降级为纯内存演示时（数据库不可用）不能抛异常：
    // persistAll 被二十多处调用，任何一处炸掉都会让"功能仍然可用"的承诺落空。
    if (!dbReady.value) return
    db.replaceAll({
      equipment: equipmentToRows(),
      maintenance_records: maintenanceToRows(),
      work_orders: workOrdersToRows(),
      health_snapshots: healthSnapshotsToRows(),
      knowledge_base: knowledgeToRows(),
      documents: documentsToRows(),
      fault_cases: faultCasesToRows(),
      parts_inventory: partsToRows(),
      parts_transactions: partTxToRows(),
      operation_logs: logsToRows()
    })
    scheduleSave()
  }

  // ---------- 演示参数设置（可审计：所有估算口径可在系统设置中调整并落盘） ----------
  const settings = ref(null)

  const defaultSettings = () => ({
    dailyOutputLoss: { ...DAILY_OUTPUT_LOSS },
    riskFactor: { A: 0.1, B: 0.3, C: 0.5, D: 0.7 },
    bounds: { A: 85, B: 70, C: 55 },
    llmEnabled: true
  })

  function applySettings(cfg) {
    if (!cfg) return
    configureHealth({
      dailyOutputLoss: cfg.dailyOutputLoss,
      riskFactor: cfg.riskFactor,
      bounds: cfg.bounds
    })
  }

  /** 从本地库 meta 恢复设置（启动时调用） */
  function loadSettings() {
    try {
      const raw = db.getMeta('app_settings')
      if (raw) {
        const parsed = JSON.parse(raw)
        settings.value = { ...defaultSettings(), ...parsed, dailyOutputLoss: { ...DAILY_OUTPUT_LOSS, ...(parsed.dailyOutputLoss || {}) } }
        applySettings(settings.value)
        return
      }
    } catch (error) {
      console.warn('[设置] 读取失败，使用默认参数：', error)
    }
    settings.value = defaultSettings()
  }

  /** 更新设置并立即生效（健康分/停机损失/等级分档全部实时重算） */
  function updateSettings(patch) {
    if (!settings.value) settings.value = defaultSettings()
    settings.value = {
      ...settings.value,
      ...(patch.dailyOutputLoss ? { dailyOutputLoss: { ...settings.value.dailyOutputLoss, ...patch.dailyOutputLoss } } : {}),
      ...(patch.riskFactor ? { riskFactor: { ...settings.value.riskFactor, ...patch.riskFactor } } : {}),
      ...(patch.bounds ? { bounds: { ...settings.value.bounds, ...patch.bounds } } : {})
    }
    applySettings(settings.value)
    setMetaSafe('app_settings', JSON.stringify(settings.value))
    scheduleSave()
    addLog({ content: '更新演示参数设置（日产出/风险系数/健康分档）', source: '设置', type: 'info', tagType: 'info' })
  }

  /** 恢复默认演示参数 */
  function resetSettings() {
    resetHealthConfig()
    settings.value = defaultSettings()
    setMetaSafe('app_settings', JSON.stringify(settings.value))
    scheduleSave()
    addLog({ content: '恢复默认演示参数', source: '设置', type: 'info', tagType: 'info' })
  }

  // ---------- 告警处置记录 ----------
  //
  // 为什么从 localStorage 搬到本地库 meta：
  //   1) 备份包（.mbak）只带数据库字节 + 聊天记录，放 localStorage 的处置记录换机就丢了，
  //      新电脑上已处理的告警会"复活"，与"数据全带走"的说法不一致；
  //   2) 「重置演示数据」清库时无法一并清除，导致重置后告警仍是已处理状态。
  const ALERT_DONE_META_KEY = 'alert_done'

  function getAlertDispositions() {
    try {
      const raw = db.getMeta(ALERT_DONE_META_KEY)
      const parsed = raw ? JSON.parse(raw) : null
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch (error) {
      console.warn('[告警] 处置记录读取失败，按未处理处理：', error)
      return {}
    }
  }

  function setAlertDispositions(map) {
    setMetaSafe(ALERT_DONE_META_KEY, JSON.stringify(map || {}))
    scheduleSave()
  }

  function clearAlertDispositions() {
    setMetaSafe(ALERT_DONE_META_KEY, '{}')
    scheduleSave()
  }

  /** 写 meta：数据库不可用（纯内存演示）时静默跳过，不打断用户操作 */
  function setMetaSafe(key, value) {
    if (!dbReady.value) return
    db.setMeta(key, value)
  }

  // ---------- 演示操作日志 ----------
  const SEED_LOGS = () => [
    { time: daysAgoDateTime(1), content: '从「生产部_设备清单.xlsx」导入 60 台设备至台账', source: 'Excel', type: 'primary', tagType: 'primary' },
    { time: daysAgoDateTime(1), content: '通过语音创建工单：液压系统压力异常', source: '语音', type: 'success', tagType: 'success' },
    { time: daysAgoDateTime(2), content: '拍照识别巡检单，自动生成 3 张巡检工单', source: 'OCR', type: 'warning', tagType: 'warning' },
    { time: daysAgoDateTime(3), content: '完成 12 台设备健康体检，生成 3 份风险报告', source: 'AI', type: 'info', tagType: 'info' },
    { time: daysAgoDateTime(4), content: '从「维修部_维保记录.xlsx」导入 40 条维保记录', source: 'Excel', type: 'primary', tagType: 'primary' }
  ]

  // ---------- 装载 ----------
  function applySeedData() {
    const seed = buildSeed()
    equipmentList.value = seed.equipment
    maintenanceRecords.value = seed.maintenanceRecords
    workOrders.value = seed.workOrders
    healthSnapshots.value = seed.healthSnapshots
    knowledgeItems.value = buildDefaultKnowledge()
    recentLogs.value = SEED_LOGS()
    // 备件必须在这里就位：之前只在 hydrateFromDb 里补种子，导致首次启动
    // parts_inventory 写了一张空表，备件库存页要重启一次才有数据。
    partsInventory.value = partsSeed()
    partTransactions.value = []
    replayRecentPartUsage(seed.maintenanceRecords)
  }

  /**
   * 用近 30 天的演示维保记录回冲备件库存
   *
   * 不回冲的话，设备病历里几十条记录都写着"换了XX件"，备件台账却停在期初数——
   * 评委随手点开一台设备的病历就能看出账实不符。只回冲 30 天，
   * 既让"领用流水"有真实内容，又不会把库存一路扣到 0。
   */
  function replayRecentPartUsage(records) {
    const since = addDays(now().slice(0, 10), -30)
    const rows = []
    for (const [equipmentId, list] of Object.entries(records || {})) {
      for (const r of list || []) {
        if (r.parts_used && String(r.date) >= since) rows.push({ equipmentId, record: r })
      }
    }
    rows.sort((a, b) => String(a.record.date).localeCompare(String(b.record.date)))
    let count = 0
    for (const { equipmentId, record } of rows) {
      count += consumePartsFromText(record.parts_used, '期初回冲', Number(equipmentId)).consumed
    }
    return count
  }

  function hydrateFromDb() {
    const equipmentRows = db.all('equipment').sort((a, b) => Number(a.id) - Number(b.id))
    if (!equipmentRows.length) return false

    // 操作日志：先恢复，后面任何 persistAll() 都不会把种子文案写回覆盖真实历史
    const logRows = db.all('operation_logs').sort((a, b) => Number(b.id) - Number(a.id))
    recentLogs.value = logRows.length
      ? logRows.map(row => ({
          time: row.time || '',
          content: row.content || '',
          source: row.source || '',
          type: row.type || 'info',
          tagType: row.tag_type || row.type || 'info'
        }))
      : SEED_LOGS()

    equipmentList.value = equipmentRows.map(row => ({
      id: Number(row.id),
      name: row.name,
      model: row.model || '',
      category: row.category || '',
      location: row.location || '',
      purchase_date: row.purchase_date || '',
      status: row.status || 'running',
      maintenance_cycle_days: Number(row.maintenance_cycle_days) || 90,
      last_maintenance_date: row.last_maintenance_date || null,
      notes: row.notes || ''
    }))

    const records = {}
    for (const row of db.all('maintenance_records')) {
      const equipmentId = String(row.equipment_id)
      if (!records[equipmentId]) records[equipmentId] = []
      records[equipmentId].push({
        id: row.id,
        type: row.type,
        typeLabel: row.type,
        description: row.description || '',
        parts_used: row.parts_used || '',
        parts: row.parts_used || '',
        cost: Number(row.cost) || 0,
        technician: row.technician || '',
        date: row.date,
        next_due_date: row.next_due_date || ''
      })
    }
    for (const key of Object.keys(records)) {
      records[key].sort((a, b) => String(b.date).localeCompare(String(a.date)))
    }
    maintenanceRecords.value = records

    workOrders.value = db.all('work_orders')
      .sort((a, b) => Number(b.id) - Number(a.id))
      .map(row => ({
        id: Number(row.id),
        equipment_id: row.equipment_id,
        equipment_name: row.equipment_name || '',
        title: row.title,
        description: row.description || '',
        type: row.type,
        priority: row.priority,
        status: row.status,
        source: row.source,
        assigned_to: row.assigned_to || '',
        created_at: row.created_at,
        completed_at: row.completed_at || undefined,
        recheck_date: row.recheck_date || null,
        recheck_status: row.recheck_status || 'not_needed'
      }))

    healthSnapshots.value = db.all('health_snapshots')
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .map(row => ({
        id: row.id,
        equipment_id: Number(row.equipment_id),
        date: row.date,
        score: Number(row.score),
        level: row.level || null,
        factors_json: row.factors_json || null
      }))

    // 知识库：老库无此表/无条目时回退默认 30 条，保证"经验传承"开箱即有内容
    const kbRows = db.all('knowledge_base')
    knowledgeItems.value = kbRows.length
      ? kbRows.map(row => ({
          id: String(row.id),
          title: row.title || '',
          category: row.category || '',
          keywords: String(row.keywords || '').split(',').filter(Boolean),
          symptoms: row.symptoms || '',
          causes: safeJson(row.causes_json, []),
          steps: safeJson(row.steps_json, []),
          source: row.source || '',
          created_at: row.created_at || '',
          status: row.status || 'confirmed',
          frequency: Number(row.frequency) || 0,
          avg_repair_hours: row.avg_repair_hours != null ? Number(row.avg_repair_hours) : null
        }))
      : buildDefaultKnowledge()

    // 手册资料库
    documents.value = db.all('documents').map(row => ({
      id: String(row.id),
      title: row.title || '',
      docType: row.doc_type || '使用手册',
      model: row.model || '',
      category: row.category || '',
      fileName: row.file_name || '',
      filePath: row.file_path || '',
      fileSize: Number(row.file_size) || 0,
      pages: Number(row.pages) || 0,
      status: row.status || 'ready',
      chunks: safeJson(row.chunks_json, []),
      note: row.note || '',
      addedAt: row.added_at || ''
    }))

    // 自动沉淀的故障案例（工单完工自动归档生成）
    faultCases.value = db.all('fault_cases')
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map(row => ({
        id: Number(row.id),
        equipment_name: row.equipment_name || '',
        category: row.category || '',
        symptom: row.symptom || '',
        cause: row.cause || '',
        solution: row.solution || '',
        parts_used: row.parts_used || '',
        source_order_id: row.source_order_id || null,
        repair_hours: row.repair_hours != null ? Number(row.repair_hours) : null,
        createdAt: row.created_at || ''
      }))

    // 备件台账（首启无数据时写入演示备件）
    const partRows = db.all('parts_inventory')
    partsInventory.value = partRows.length
      ? partRows.map(row => ({
          id: Number(row.id),
          name: row.name || '',
          category: row.category || '',
          stock: Number(row.stock) || 0,
          safety_stock: Number(row.safety_stock) || 0,
          unit_price: Number(row.unit_price) || 0,
          unit: row.unit || '件',
          updatedAt: row.updated_at || ''
        }))
      : partsSeed()
    if (!partRows.length) persistAll()

    partTransactions.value = db.all('parts_transactions')
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map(row => ({
        id: Number(row.id),
        part_id: Number(row.part_id),
        type: row.type || 'out',
        quantity: Number(row.quantity) || 0,
        ref_type: row.ref_type || '',
        ref_id: row.ref_id != null ? Number(row.ref_id) : null,
        note: row.note || '',
        createdAt: row.created_at || ''
      }))

    return true
  }

  /** 容错解析 JSON 字段（老数据损坏时降级为空数组，不抛异常） */
  function safeJson(raw, fallback) {
    if (!raw) return fallback
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : fallback
    } catch {
      return fallback
    }
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
      loadSettings()
      return true
    } catch (error) {
      // 数据库不可用时降级为纯内存演示，功能仍然可用
      dbReady.value = false
      dbError.value = error.message
      console.warn('[数据库] 初始化失败，降级为内存模式：', error)
      applySeedData()
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
      createdAt: now()
    }
    faultCases.value.unshift(record)
    persistAll()
    return record
  }

  function getFaultCases() {
    return faultCases.value
  }

  // ---------- 备件库存 ----------

  /**
   * 备件台账种子：直接由 PARTS_CATALOG 派生
   *
   * ⚠️ 以前这里是另写一份清单（"制动片/轮胎螺栓/液压油缸密封件"），
   * 与维保记录用的 PARTS_CATALOG（"刹车片/工程轮胎/液压油管密封圈"）各写各的，
   * 记录里的配件只有 2 种能在库存里找到，演示时"填了配件却不扣库存"，
   * 备件联动链路看着就是坏的。现在单一来源，件名天然对齐。
   * 库存水位刻意留出 3 项低于安全库存，让"缺料预警"有真实内容。
   */
  const PART_CATEGORY = {
    '液压油46号': '润滑系统',
    机油滤芯: '动力系统',
    工程轮胎: '行走系统',
    刹车片: '行走系统',
    高锰钢衬板: '工作装置',
    斗齿: '工作装置',
    液压油管密封圈: '液压系统',
    耐水极压锂基脂: '润滑系统',
    液压油滤芯: '液压系统',
    空气滤芯: '动力系统',
    液压油缸密封件: '液压系统',
    发电机皮带: '动力系统',
    轮胎螺栓: '行走系统'
  }

  const PART_UNIT = {
    '液压油46号': '桶',
    耐水极压锂基脂: '桶',
    刹车片: '副',
    液压油缸密封件: '套'
  }

  /**
   * 现场常见叫法 → 台账标准名
   *
   * 只收"同一种东西的不同写法"。不把"机油"映射成"机油滤芯"、
   * 不把"液压油缸密封件"映射成"液压油管密封圈"——那是两种不同零件，
   * 硬凑匹配会让库存账目错得看不出错。对不上的配件一律如实上报"台账无此件"。
   */
  const PART_ALIASES = {
    刹车摩擦片: '刹车片',
    闸片: '刹车片',
    制动片: '刹车片',
    液压油密封圈: '液压油管密封圈',
    液压油: '液压油46号',
    液压油46: '液压油46号',
    锂基脂: '耐水极压锂基脂',
    润滑脂: '耐水极压锂基脂'
  }

  /**
   * 相对安全库存的水位偏移
   *
   * 期初水位按"近 30 天演示维保记录的领用量"留足余量：回冲之后既要有几项
   * 落到安全库存以下（缺料预警页才有内容），又不能有哪一项被扣到 0——
   * 库存为 0 会让演示中的后续领用全部走"超领"分支，页面看着像坏了。
   */
  const STOCK_OFFSET = {
    '液压油46号': 9,
    机油滤芯: 6,
    工程轮胎: 6,
    刹车片: 2,
    高锰钢衬板: -1,
    斗齿: 5,
    液压油管密封圈: -8,
    耐水极压锂基脂: 3,
    液压油滤芯: 5,
    空气滤芯: 4
  }

  function partsSeed() {
    const stamp = now()
    return PARTS_CATALOG.map((p, i) => ({
      id: i + 1,
      name: p.name,
      category: PART_CATEGORY[p.name] || '其他',
      stock: Math.max(1, Number(p.minStock) + (STOCK_OFFSET[p.name] ?? 3)),
      safety_stock: Number(p.minStock) || 0,
      unit_price: Number(p.price) || 0,
      unit: PART_UNIT[p.name] || '件',
      updatedAt: stamp
    }))
  }

  const nextPartId = computed(() => {
    const maxId = partsInventory.value.reduce((max, p) => Math.max(max, Number(p.id) || 0), 0)
    return maxId + 1
  })

  /**
   * 按名字找备件：精确 → 别名 → 唯一包含匹配
   *
   * 三级都命不中时返回 null（调用方必须把"对不上"如实报出来，
   * 而不是当作"这件没用到"悄悄跳过）。包含匹配只在唯一命中时采信，
   * 命中多件（如"滤芯"同时匹配到机油/空气/液压油滤芯）一律不猜。
   */
  function getPartByName(name) {
    const clean = String(name || '').trim()
    if (!clean) return null
    const exact = partsInventory.value.find(p => p.name === clean)
    if (exact) return exact
    const alias = PART_ALIASES[clean]
    if (alias) {
      const hit = partsInventory.value.find(p => p.name === alias)
      if (hit) return hit
    }
    const loose = partsInventory.value.filter(p => p.name.includes(clean) || clean.includes(p.name))
    return loose.length === 1 ? loose[0] : null
  }

  /** 调整库存（delta 可为正入库 / 负出库），并记流水 */
  function adjustPartStock(partId, delta, { type = 'in', refType = '', refId = null, note = '' } = {}) {
    const part = partsInventory.value.find(p => p.id === partId)
    if (!part) return null
    part.stock = Math.max(0, Number(part.stock) + Number(delta))
    part.updatedAt = now()
    if (Number(delta) !== 0) {
      partTransactions.value.unshift({
        id: nextPartTxId.value,
        part_id: part.id,
        type: Number(delta) > 0 ? 'in' : 'out',
        quantity: Math.abs(Number(delta)),
        ref_type: type === 'in' ? (refType || 'manual') : refType,
        ref_id: refId,
        note,
        createdAt: now()
      })
    }
    persistAll()
    return part
  }

  const nextPartTxId = computed(() => {
    const maxId = partTransactions.value.reduce((max, t) => Math.max(max, Number(t.id) || 0), 0)
    return maxId + 1
  })

  /** 入库 */
  function restockPart(partId, quantity, note = '手动入库') {
    return adjustPartStock(partId, Number(quantity), { type: 'in', note })
  }

  /** 出库 */
  function issuePart(partId, quantity, note = '手动出库') {
    return adjustPartStock(partId, -Number(quantity), { type: 'out', note })
  }

  function addPart(item) {
    const record = {
      id: nextPartId.value,
      name: String(item.name || '').trim(),
      category: item.category || '其他',
      stock: Number(item.stock) || 0,
      safety_stock: Number(item.safety_stock) || 0,
      unit_price: Number(item.unit_price) || 0,
      unit: item.unit || '件',
      updatedAt: now()
    }
    if (!record.name) return null
    partsInventory.value.push(record)
    persistAll()
    return record
  }

  /**
   * 备件联动：从一段文本（如维保记录的"配件"字段，逗号/顿号分隔）逐个匹配备件名并扣减库存
   * 用于"维保/维修记录填配件 → 台账自动扣减 → 缺料预警"
   *
   * 返回值是明细而不是一个数字：对不上台账的配件、库存为 0 的配件都必须能被上层看见。
   * 之前这里对这两种情况都是静默 `continue`——记录里明明白白写着换了件，
   * 库存却分文未动，界面上也没有任何提示，账实不符却查不出原因。
   *
   * @returns {{ consumed: number, matched: string[], unmatched: string[], short: string[] }}
   */
  function consumePartsFromText(text, refType, refId) {
    const result = { consumed: 0, matched: [], unmatched: [], short: [] }
    if (!text) return result
    const names = String(text)
      .split(/[,，、;；/]/)
      .map(s => s.trim())
      .filter(Boolean)
    for (const name of names) {
      const part = getPartByName(name)
      if (!part) { result.unmatched.push(name); continue }
      if (Number(part.stock) <= 0) { result.short.push(part.name); continue }
      adjustPartStock(part.id, -1, { type: 'out', refType, refId, note: `维保/维修领用（${refType} #${refId}）` })
      result.consumed++
      result.matched.push(part.name)
    }
    return result
  }

  /** 缺料预警：库存 ≤ 安全库存 */
  const lowStockParts = computed(() =>
    partsInventory.value
      .filter(p => Number(p.stock) <= Number(p.safety_stock))
      .sort((a, b) => a.stock - b.stock)
  )

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

    const wasCompleted = order.status === 'completed'
    order.status = newStatus
    order.completed_at = newStatus === 'completed' ? now() : undefined

    if (newStatus === 'completed' && !wasCompleted) {
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

    // 故障案例自动沉淀：维修工单完工 → 生成结构化案例卡（症状/原因/处理，可溯源）
    if (order.type === 'repair' && order.title) {
      const eqCat = eq ? eq.category : ''
      // 从知识库匹配最相关的条目作为"原因 / 处理"参考（命中失败则如实留空，不编造）
      const kb = knowledgeItems.value.find(k => {
        const kws = Array.isArray(k.keywords) ? k.keywords : String(k.keywords || '').split(/[,，]/)
        return kws.some(w => w && String(order.title).includes(w))
      })
      const cause = kb ? kb.title : ''
      const solution = kb && Array.isArray(kb.steps) && kb.steps.length ? kb.steps[0] : (order.description || '')
      addFaultCase({
        equipment_name: order.equipment_name || '',
        category: eqCat,
        symptom: order.title,
        cause,
        solution,
        parts_used: '',
        source_order_id: order.id,
        repair_hours: kb && kb.avg_repair_hours != null ? Number(kb.avg_repair_hours) : null
      })
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
  async function addDocument(input) {
    const { file, title, docType = '使用手册', model = '', category = '' } = input || {}
    if (!file) return { ok: false, error: '未选择文件' }

    // 1) 保存文件字节（Electron 落盘 / 浏览器 IndexedDB）
    const saved = await docFileStore.save(file.name, file)
    if (!saved || !saved.ok) return { ok: false, error: (saved && saved.error) || '文件保存失败' }

    // 2) 本地提取 PDF 文本（无网络；扫描件降级为仅查看）
    const extracted = await extractPdfText(file)
    const doc = {
      id: `doc-${Date.now()}`,
      title: title || file.name.replace(/\.pdf$/i, ''),
      docType,
      model,
      category,
      fileName: file.name,
      filePath: saved.path,
      fileSize: saved.size || file.size,
      pages: extracted.ok ? extracted.pages : 0,
      status: extracted.ok && extracted.chunks.length ? 'ready' : 'view_only',
      chunks: extracted.ok ? extracted.chunks.slice(0, 300) : [],
      note: extracted.ok
        ? ''
        : '未提取到文字层（扫描件），可打开查看原文，暂不能直接问答',
      addedAt: now()
    }
    documents.value = [doc, ...documents.value]
    addLog({
      content: `添加手册「${doc.title}」${doc.status === 'ready' ? `（${doc.pages} 页，可问答）` : '（扫描件，仅查看）'}`,
      source: '手册库',
      type: doc.status === 'ready' ? 'success' : 'warning',
      tagType: doc.status === 'ready' ? 'success' : 'warning'
    }, { silent: true })
    persistAll()
    return { ok: true, doc }
  }

  /** 删除文档：删记录 + 删文件字节 */
  async function removeDocument(id) {
    const doc = documents.value.find(d => d.id === id)
    if (!doc) return false
    documents.value = documents.value.filter(d => d.id !== id)
    if (doc.filePath) await docFileStore.remove(doc.filePath, doc.fileName)
    addLog({
      content: `删除手册「${doc.title}」`,
      source: '手册库',
      type: 'warning',
      tagType: 'warning'
    }, { silent: true })
    persistAll()
    return true
  }

  /** 用系统阅读器 / 新窗口打开文档原文 */
  async function openDocument(doc) {
    if (!doc || !doc.filePath) return false
    return docFileStore.open(doc.filePath, doc.fileName)
  }

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
