/**
 * 矿山智工 - 持久化层（行映射 / 落盘 / 从库恢复 / 演示数据装载）
 *
 * 为什么单独成模块：
 *   appStore 一度近 1800 行，其中一大半是"内存对象 ↔ 数据库行"的搬运代码。
 *   这类代码机械、极易漏 —— `archived_at` 就曾因为漏在写库映射里，
 *   列建好了却永远存不下，重启后归档幂等直接失效。挤在业务逻辑中间时，
 *   没人愿意逐行核对"表里这几列是不是都写进去了"。
 *
 *   抽出来之后：
 *     1) 行映射集中一处，加列时只有一个地方要改；
 *     2) self-check 可以对这一个文件做结构校验（表里的每一列都必须出现在映射里）；
 *     3) appStore 剩下的就都是业务规则了。
 *
 * 依赖注入而不是第二份状态：store 的 ref 和几个工厂函数由 appStore 传进来，
 * ref 还是那些 ref，不存在"内存里有两份数据各说各话"。
 */
import * as db from '../utils/database'
import { now, addDays } from '../utils/dates'
import { parseAliases, formatAliases } from '../utils/aliases'

/**
 * 操作日志的保留条数（内存窗口与落库窗口**必须是同一个数**）。
 *
 * 为什么强调"同一个"：曾经内存留 500、落库写 50，于是刷新后又只剩 50 条 ——
 * 改了一处等于没改。更糟的是 stores/nlActions.js 里还藏着第三个窗口（50），
 * 任何一次口述录入都会把已落库的历史永久删掉一段。
 * 现在只在这里定义一次，appStore 与 nlActions 都引用它。
 */
export const LOG_WINDOW = 500

export function createPersistence(ctx) {
  const {
    // 数据 ref（与 appStore 共用同一批）
    equipmentList, maintenanceRecords, workOrders, healthSnapshots, knowledgeItems,
    documents, faultCases, partsInventory, partTransactions, recentLogs,
    // 连接状态 ref
    dbReady, dbError, storageBackend, lastSavedAt, saving,
    // 工厂函数（仍留在 appStore，因为它们依赖备件/知识库等领域逻辑）
    buildSeed, partsSeed, seedLogs, buildDefaultKnowledge, consumePartsFromText
  } = ctx

  /**
   * undefined → null。
   * sql.js 的 bind 不接受 undefined，而 JS 对象里"字段没设"和"字段显式设成 null"
   * 在落库时应当同义。
   */
  function toRow(value) {
    return value === undefined ? null : value
  }

  // ============================================================
  // 内存 → 数据库行
  //
  // ⚠️ 这里的每一列都必须与 utils/database.js 的建表语句一一对应。
  //    自检里的 B2 组会对本文件做结构校验：表里有哪一列，这里就得给哪一列。
  // ============================================================

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
      /* 口述别名：台账里按顿号/逗号录入，库里存成顿号分隔的一行文本。
         它是 nlCommand 别名匹配层唯一的取数来源 —— 不落库的话，
         用户录完别名一重启就没了，那一层又会退回永不命中。 */
      aliases: toRow(formatAliases(eq.aliases)),
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
      recheck_status: order.recheck_status || 'not_needed',
      // 必须落库：归档标记如果只活在内存里，重启后已完成的工单又变成"没归档过"，
      // 「完成 → 退回处理中 → 再完成」会重新跑一遍病历/快照/复诊/案例卡的副作用。
      archived_at: toRow(order.archived_at)
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
      // 截断前的切片总数（见 database.js 的 documents.chunk_total 迁移说明）。
      // 老记录没有这个字段，回落到已存切片数 —— 那对老库等价于"没被截断"，
      // 与旧版行为一致（旧版本来就不标注截断），不会凭空冒出警告。
      chunk_total: Number(doc.chunkTotal) || (doc.chunks || []).length,
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
      updated_at: p.updatedAt || stamp
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
    // 落库窗口与内存窗口共用 LOG_WINDOW：两个数字必须一起动，
    // 否则会出现"内存留 500、写回 50，刷新后只剩 50 —— 改了等于没改"。
    const list = recentLogs.value.slice(0, LOG_WINDOW)
    return list.map((log, index) => ({
      id: list.length - index,
      time: log.time || now(),
      content: log.content || '',
      source: log.source || '',
      type: log.type || 'info',
      tag_type: log.tagType || log.type || 'info'
    }))
  }

  // ============================================================
  // 落盘
  // ============================================================

  let saveTimer = null

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

  // ============================================================
  // 数据库行 → 内存
  // ============================================================

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
   * 把库里所有表读回内存。
   *
   * @param {object} [options]
   * @param {boolean} [options.seedFallbacks=true] 空表是否用演示数据补位。
   *   首启/老库升级走 true（"经验传承开箱即有内容"、"备件页首启不为空"）；
   *   **导入备份必须走 false** —— 备份是用户的东西，空表就该是空的，
   *   不能让 seedLogs()/buildDefaultKnowledge()/partsSeed() 往里面掺演示内容。
   * @returns {boolean} 设备台账是否有内容（false = 台账为空，是用户状态而非全新安装）
   */
  function hydrateFromDb({ seedFallbacks = true } = {}) {
    const equipmentRows = db.all('equipment').sort((a, b) => Number(a.id) - Number(b.id))
    /**
     * ⚠️ 这里原来在台账为空时直接 `return false`，下面的表全部不装载。
     *
     * 后果：导入一份"不含设备台账"的备份后，内存里仍是导入前的旧数据，
     * 而磁盘上已经是导入后的库 —— 之后任何一次 persistAll() 都会把旧数据
     * 整库写回，把用户刚导入的备份覆盖掉。现在改为继续装载，由调用方
     * 按返回值决定"台账为空"如何呈现（见 appStore.reloadFromDb）。
     */
    const ledgerHasContent = equipmentRows.length > 0

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
      : (seedFallbacks ? seedLogs() : [])

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
      // 顿号/逗号/分号都能当分隔符：用户录入时想到哪个打哪个，不该因此匹配不上。
      aliases: parseAliases(row.aliases),
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
        recheck_status: row.recheck_status || 'not_needed',
        archived_at: row.archived_at || null
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
      : (seedFallbacks ? buildDefaultKnowledge() : [])

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
      // 老库没有这一列（迁移刚补的），此时 chunk_total 为 null：
      // 回落到已存切片数，语义是"没被截断"，与旧版行为一致。
      chunkTotal: row.chunk_total != null
        ? Number(row.chunk_total)
        : safeJson(row.chunks_json, []).length,
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

    // 备件台账（首启无数据时写入演示备件；导入备份时不补位，免得往用户的库里掺演示数据）
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
      : (seedFallbacks ? partsSeed() : [])
    if (!partRows.length && seedFallbacks) persistAll()

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

    return ledgerHasContent
  }

  // ============================================================
  // 演示数据装载
  // ============================================================

  /**
   * 用近 30 天的演示维保记录回冲备件库存
   *
   * 不回冲的话，设备病历里几十条记录都写着"换了XX件"，备件台账却停在期初数——
   * 评委随手点开一台设备的病历就能看出账实不符。只回冲 30 天，
   * 既让"领用流水"有真实内容，又不会把库存一路扣到 0。
   *
   * ⚠️ silent: true 是必须的。每个配件名都会走一次 consumePartsFromText →
   *    adjustPartStock，而后者默认每次都 persistAll()（DELETE 10 张表 + 全量
   *    re-INSERT）。实测近 30 天有 34 个配件名，等于首屏挂载前白跑 34 次全表
   *    重写（约 0.4 s）。这里改成只改内存，由 applySeedData 的调用方
   *    （initStore / reloadFromDb）在末尾统一 persistAll + saveNow 一次。
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
      count += consumePartsFromText(record.parts_used, '期初回冲', Number(equipmentId), { silent: true }).consumed
    }
    return count
  }

  /** 把内存状态整体换成一套全新的演示数据（不落盘，由调用方决定是否保存） */
  function applySeedData() {
    const seed = buildSeed()
    equipmentList.value = seed.equipment
    maintenanceRecords.value = seed.maintenanceRecords
    workOrders.value = seed.workOrders
    healthSnapshots.value = seed.healthSnapshots
    knowledgeItems.value = buildDefaultKnowledge()
    recentLogs.value = seedLogs()
    /**
     * 故障案例卡：由已完成的维修工单派生（工厂在 buildSeed 里就派生好了）。
     *
     * 这里原来什么都没做，于是 faultCases 首次启动是空的 ——
     * 而工单上还写着 archived_at（"已归档"），相当于数据模型承诺了案例卡存在。
     * 后果是"最新自动沉淀案例"整块卡片在首启时根本不显示。
     */
    faultCases.value = seed.faultCases || []
    // 备件必须在这里就位：之前只在 hydrateFromDb 里补种子，导致首次启动
    // parts_inventory 写了一张空表，备件库存页要重启一次才有数据。
    partsInventory.value = partsSeed()
    partTransactions.value = []
    replayRecentPartUsage(seed.maintenanceRecords)
  }

  return {
    toRow,
    equipmentToRows,
    maintenanceToRows,
    workOrdersToRows,
    healthSnapshotsToRows,
    documentsToRows,
    knowledgeToRows,
    faultCasesToRows,
    partsToRows,
    partTxToRows,
    logsToRows,
    saveNow,
    scheduleSave,
    persistAll,
    safeJson,
    hydrateFromDb,
    applySeedData,
    replayRecentPartUsage,
    storageBackend
  }
}
