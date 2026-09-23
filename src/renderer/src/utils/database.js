/**
 * 矿山智工 - 本地数据库模块（sql.js 纯 JS SQLite）
 *
 * 职责：
 *   - 建表与版本迁移
 *   - 从持久化存储（Electron 文件 / IndexedDB / localStorage）恢复数据库
 *   - 提供查询、批量写入、导出落盘的 API
 *
 * 数据全部保存在本机，不走网络。渲染进程用 sql.js 在内存中操作，
 * 变更后导出字节流交给 storage 层落盘。
 */
import initSqlJs from 'sql.js'
import { loadDatabaseBytes, saveDatabaseBytes, clearDatabaseBytes, storageInfo } from './storage'
import { now } from './dates'

let SQL = null
let db = null
let dirty = false

/**
 * 获取 sql.js 初始化函数。
 * 允许运行环境注入自定义实现（例如 Node 验证脚本需要显式指定 wasm 路径，
 * 或将来换成 asm.js 版本），默认使用打包进应用的 sql.js。
 */
function getSqlJsInitializer() {
  const override = globalThis.__DSH_INIT_SQL_JS__
  return typeof override === 'function' ? override : initSqlJs
}

/**
 * 定位 sql.js 的 wasm 二进制。
 *   - 开发模式：vite 插件把它挂在 /sql-wasm.wasm
 *   - 生产构建：它被复制到 assets/sql-wasm.wasm
 * 两者都基于当前模块的 URL 解析，保证 Electron file:// 与浏览器 http 下都能找到。
 *
 * Electron 打包细节（2026-09-16 修复，真机白屏根因）：
 * Chromium 网络栈禁止 file:// 页面用 fetch() 读 file:// 资源，sql.js 的
 * wasm 永远加载不出来。因此打包版优先走 getWasmBinary()（主进程 fs 读
 * asar 内文件经 IPC 传入 wasmBinary，见 preload app.readWasm / main app:readWasm）；
 * fetch locateFile 仅作浏览器模式兜底。asarUnpack 配置同时保留，主进程读
 * asar 内外路径均兼容。
 */
function locateSqlWasm() {
  const bundled = typeof __SQLJS_WASM_URL__ !== 'undefined' ? __SQLJS_WASM_URL__ : './assets/sql-wasm.wasm'
  const isDev = typeof import.meta !== 'undefined' && import.meta.url && import.meta.url.includes('/src/')
  if (isDev) return '/sql-wasm.wasm'
  return new URL(bundled, import.meta.url).href.replace('/app.asar/', '/app.asar.unpacked/')
}

/**
 * 优先拿主进程注入的 wasm 二进制（Electron 打包版，绕开 fetch file:// 限制）；
 * 拿不到返回 null（浏览器模式走 locateFile 正常 fetch）。
 */
async function getWasmBinary() {
  try {
    if (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.app && window.electronAPI.app.readWasm) {
      const buf = await window.electronAPI.app.readWasm()
      if (buf) return new Uint8Array(buf)
    }
  } catch { /* 静默降级为 locateFile */ }
  return null
}

/** 组装 sql.js 初始化参数：Electron 走 wasmBinary，浏览器走 locateFile */
async function createSqlJsConfig() {
  const wasmBinary = await getWasmBinary()
  return {
    locateFile: (file) => (file.endsWith('.wasm') ? locateSqlWasm() : file),
    ...(wasmBinary ? { wasmBinary } : {})
  }
}

/**
 * 表结构版本号。
 *
 * ⚠️ 它**不驱动迁移**：真正的迁移是下面 `runMigrations()` 里那份"必需列清单"
 * 逐列 `ALTER TABLE ADD COLUMN`，幂等、每次启动都跑一遍，不需要版本分派。
 * 这个值只是"这个库是哪个结构版本建的"的标记，供排查与将来做真正的版本分派用。
 * 因此它只写不读（自检里断言它确实被写进去了，见 scripts/store-check.mjs）。
 * 曾经它写在一个注释为"用于将来的迁移"的位置上，读代码的人会以为迁移靠它 —— 不是。
 */
const SCHEMA_VERSION = 1

const TABLES = {
  equipment: `
    CREATE TABLE IF NOT EXISTS equipment (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      model TEXT,
      category TEXT,
      location TEXT,
      purchase_date TEXT,
      status TEXT DEFAULT 'running',
      maintenance_cycle_days INTEGER DEFAULT 90,
      last_maintenance_date TEXT,
      notes TEXT,
      created_at TEXT,
      updated_at TEXT
    )`,
  maintenance_records: `
    CREATE TABLE IF NOT EXISTS maintenance_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      parts_used TEXT,
      cost REAL DEFAULT 0,
      technician TEXT,
      date TEXT NOT NULL,
      next_due_date TEXT,
      created_at TEXT
    )`,
  work_orders: `
    CREATE TABLE IF NOT EXISTS work_orders (
      id INTEGER PRIMARY KEY,
      equipment_id INTEGER,
      equipment_name TEXT,
      title TEXT NOT NULL,
      description TEXT,
      type TEXT DEFAULT 'maintenance',
      priority TEXT DEFAULT 'normal',
      status TEXT DEFAULT 'pending',
      source TEXT DEFAULT 'manual',
      assigned_to TEXT,
      created_at TEXT,
      completed_at TEXT,
      updated_at TEXT,
      recheck_date TEXT,
      recheck_status TEXT DEFAULT 'not_needed',
      archived_at TEXT
    )`,
  health_snapshots: `
    CREATE TABLE IF NOT EXISTS health_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      score INTEGER NOT NULL,
      level TEXT,
      factors_json TEXT
    )`,
/**
 * ⚠️ 这里原来还有一张 `excel_imports` 表（filename / sheet_name / row_count / raw_data…）。
 * 从建表那天起就**没有任何 insert / select** —— 表建好了、列也全，却从来没写过一个字节。
 * 已于 2026-09-17 删除：与其留一张"看起来导入是有留痕的"空表，不如让代码如实反映
 * 现状 —— **Excel 导入的原始行不落库**，因此导入本身不可追溯、不可回滚。
 * （旧库里那张空表会留着，无副作用；真要"导入可追溯"，就由那个功能把表、写入与
 *  界面查询一起加回来，而不是先建表。）
 */
  knowledge_base: `
    CREATE TABLE IF NOT EXISTS knowledge_base (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT,
      keywords TEXT,
      symptoms TEXT,
      causes_json TEXT,
      steps_json TEXT,
      source TEXT,
      created_at TEXT,
      updated_at TEXT,
      status TEXT DEFAULT 'confirmed',
      frequency INTEGER DEFAULT 0,
      avg_repair_hours REAL
    )`,
  meta: `
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    )`,
  documents: `
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      doc_type TEXT DEFAULT '使用手册',
      model TEXT,
      category TEXT,
      file_name TEXT,
      file_path TEXT,
      file_size INTEGER DEFAULT 0,
      pages INTEGER DEFAULT 0,
      status TEXT DEFAULT 'ready',
      chunks_json TEXT,
      note TEXT,
      added_at TEXT
    )`,
  fault_cases: `
    CREATE TABLE IF NOT EXISTS fault_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_name TEXT NOT NULL,
      category TEXT,
      symptom TEXT,
      cause TEXT,
      solution TEXT,
      parts_used TEXT,
      source_order_id INTEGER,
      repair_hours REAL,
      created_at TEXT
    )`,
  parts_inventory: `
    CREATE TABLE IF NOT EXISTS parts_inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT,
      stock INTEGER DEFAULT 0,
      safety_stock INTEGER DEFAULT 0,
      unit_price REAL DEFAULT 0,
      unit TEXT DEFAULT '件',
      updated_at TEXT
    )`,
  parts_transactions: `
    CREATE TABLE IF NOT EXISTS parts_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      ref_type TEXT,
      ref_id INTEGER,
      note TEXT,
      created_at TEXT
    )`,
  operation_logs: `
    CREATE TABLE IF NOT EXISTS operation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT,
      type TEXT,
      tag_type TEXT
    )`
}

function createSchema() {
  for (const sql of Object.values(TABLES)) db.run(sql)
  runMigrations()
  db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', ['schema_version', String(SCHEMA_VERSION)])
}

/**
 * 轻量迁移：老版本数据库里没有的列在这里补齐。
 * CREATE TABLE IF NOT EXISTS 不会给已存在的表补列，所以必须显式 ALTER。
 */
function runMigrations() {
  const required = {
    equipment: [
      // 口述别名（顿号/逗号分隔的一行文本）：nlCommand 设备指代解析的第二层要用，
      // 不落库的话用户录完一重启就没了，那一层又会退回永不命中。
      ['aliases', 'TEXT']
    ],
    work_orders: [
      ['recheck_date', 'TEXT'],
      ['recheck_status', "TEXT DEFAULT 'not_needed'"],
      // 归档标记：工单一旦"完成并归档"，其病历/快照/复诊/案例卡/日志都已生成。
      // 只看 status 会误判——完成 → 改回处理中 → 再完成，会把上面这些副作用全部再做一遍。
      ['archived_at', 'TEXT']
    ],
    knowledge_base: [
      ['status', "TEXT DEFAULT 'confirmed'"],
      ['frequency', 'INTEGER DEFAULT 0'],
      ['avg_repair_hours', 'REAL']
    ]
  }

  for (const [table, columns] of Object.entries(required)) {
    const existing = new Set(query('PRAGMA table_info(' + table + ')').map(row => row.name))
    for (const [name, type] of columns) {
      if (existing.has(name)) continue
      db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
      console.info(`[数据库] 迁移：${table} 新增列 ${name}`)
    }
  }

  // 数据回填：archived_at 是后加的列，老库里已完成的工单全是 NULL。
  // 这些单的病历/快照/复诊/案例卡早已生成，本来就是"已归档"的状态，
  // 不补的话重启后会被当成没归档过 —— 删除入口会照常放开，
  // 「完成 → 退回 → 再完成」也会把副作用重做一遍。
  db.run(`UPDATE work_orders SET archived_at = completed_at
          WHERE status = 'completed' AND archived_at IS NULL AND completed_at IS NOT NULL`)
  const backfilled = db.getRowsModified()
  if (backfilled > 0) console.info(`[数据库] 迁移：回填 ${backfilled} 张已完成工单的归档标记`)
}

/**
 * 打开（或创建）数据库
 * @returns {Promise<object>} sql.js Database 实例
 */
export async function initDatabase() {
  if (db) return db

  if (!SQL) SQL = await getSqlJsInitializer()(await createSqlJsConfig())

  /**
   * 三态语义（与 src/main/index.js 的 db:read 约定一致）：
   *   restored === null        → 没有库文件：真正的首次启动，建新库
   *   restored 有内容但解析失败 → 库损坏：**必须抛错**，绝不能就地新建
   *   restored 解析成功        → 正常恢复
   *
   * ⚠️ 这里原来把两种失败都吞成"新建一个空库"（各只 console.warn 一行）。
   * 后果是：文件被占用/权限不足/半截写入/内容损坏时，磁盘上用户真实的库
   * 一个字节都没被动过，内存里却变成了空库；紧接着 appStore.initStore()
   * 看到"没有设备"就播种演示数据并整库写回 —— 用户的历史被 60 台假设备覆盖，
   * 全程只在控制台留下一行 warn。现在改为抛错，由 appStore 转成
   * "只读内存模式 + 明确告知"，磁盘文件保持原样不动。
   */
  let restored
  try {
    restored = await loadDatabaseBytes()
  } catch (error) {
    const e = new Error(`本地数据库读取失败：${error && error.message ? error.message : error}`, { cause: error })
    e.code = 'db-read-failed'
    throw e
  }

  if (restored && restored.length > 0) {
    try {
      db = new SQL.Database(restored)
      createSchema() // 幂等：老库补齐新增的表
    } catch (error) {
      /**
       * ⚠️ 必须先把 db 置回 null 再抛。
       *
       * sql.js 的 `new SQL.Database(垃圾字节)` 不一定当场抛错 —— 它可能先返回一个
       * 实例、到第一次查询（createSchema）才炸。此时 db 已经被赋值，isReady() 会返回
       * true，调用方（appStore.initStore）就会把它当成"已就绪的空库"，接着看到
       * "没有设备"并播种演示数据、整库写回 —— 正是这条修复要堵的那条路。
       * 自检里"损坏后不得留下一个已就绪的空库"这条断言抓的就是这个半初始化状态。
       */
      db = null
      const e = new Error(`本地数据库文件已损坏，无法打开：${error && error.message ? error.message : error}`, { cause: error })
      e.code = 'db-corrupt'
      throw e
    }
  } else {
    db = new SQL.Database()
    createSchema()
  }

  // 显式校验核心表确实建好了（查询 sqlite_master，表不存在会直接抛错）
  for (const table of ['equipment', 'maintenance_records', 'work_orders']) {
    const exists = queryOne('SELECT name FROM sqlite_master WHERE type = ? AND name = ?', ['table', table])
    if (!exists) throw new Error(`核心表 ${table} 初始化失败`)
  }

  return db
}

/** 数据库是否已就绪 */
export function isReady() {
  return db !== null
}

function requireDB() {
  if (!db) throw new Error('数据库未初始化，请先调用 initDatabase()')
  return db
}

/**
 * 查询若干行
 * @param {string} sql
 * @param {Array} params
 * @returns {Array<Object>} 行对象数组
 */
export function query(sql, params = []) {
  const stmt = requireDB().prepare(sql)
  try {
    stmt.bind(params)
    const rows = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    return rows
  } finally {
    stmt.free()
  }
}

/** 查询单行，无结果返回 null */
export function queryOne(sql, params = []) {
  const rows = query(sql, params)
  return rows.length ? rows[0] : null
}

/** 读取整张表 */
export function all(table) {
  return query(`SELECT * FROM ${table}`)
}

/** 表行数 */
export function count(table) {
  const row = queryOne(`SELECT COUNT(*) AS n FROM ${table}`)
  return row ? Number(row.n) : 0
}

// 这里原来有一个 `maxNumber(table, column)`（SELECT MAX(col)），没有任何调用方 ——
// 设备/工单等编号都由 store 里的 nextXxxId 依据内存列表计算，不走 SQL。2026-09-17 删除。

function normalizeValue(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return now()
  if (typeof value === 'object') return JSON.stringify(value)
  return value
}

/**
 * 批量插入
 * @param {string} table
 * @param {Array<Object>} rows 每行的字段名需一致（以第一行为准）
 */
export function insertRows(table, rows = []) {
  if (!rows.length) return
  const columns = Object.keys(rows[0])
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
  const stmt = requireDB().prepare(sql)
  try {
    for (const row of rows) {
      stmt.run(columns.map(col => normalizeValue(row[col])))
    }
  } finally {
    stmt.free()
  }
}

/**
 * 用内存数据整体替换若干张表（在一个事务里完成，避免出现半写状态）
 * @param {Object<string, Array<Object>>} tableRows
 */
export function replaceAll(tableRows) {
  const database = requireDB()
  database.run('BEGIN TRANSACTION')
  try {
    for (const [table, rows] of Object.entries(tableRows)) {
      database.run(`DELETE FROM ${table}`)
      insertRows(table, rows)
    }
    database.run('COMMIT')
    dirty = true
  } catch (error) {
    database.run('ROLLBACK')
    throw error
  }
}

/** 写入一条键值元数据 */
export function setMeta(key, value) {
  requireDB().run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, String(value)])
  dirty = true
}

/** 读取一条键值元数据 */
export function getMeta(key, fallback = null) {
  const row = queryOne('SELECT value FROM meta WHERE key = ?', [key])
  return row ? row.value : fallback
}

/** 把数据库导出为字节流 */
export function exportBytes() {
  return requireDB().export()
}

/** 导出整库为 base64 字符串（用于备份文件） */
export function exportBase64() {
  const bytes = exportBytes()
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/**
 * 从备份字节整体恢复数据库（导入备份用）
 * 重建内存库 + 建表 + 立即落盘；调用方应随后提示重启应用以重载各页数据。
 */
export async function restoreFromBytes(bytes) {
  if (!SQL) SQL = await getSqlJsInitializer()(await createSqlJsConfig())
  db = new SQL.Database(bytes)
  createSchema()
  await persist(true)
  return true
}

/**
 * 落盘。只有数据发生变化时才会真正写入。
 * @param {boolean} force 强制写入
 * @returns {Promise<boolean>} 是否写入了
 */
export async function persist(force = false) {
  if (!db) return false
  if (!dirty && !force) return false
  const bytes = exportBytes()
  /**
   * ⚠️ 这里**不要**加 try/catch 吞掉异常。
   *
   * saveDatabaseBytes() 现在失败即抛（磁盘满 / 文件被占用 / 超配额）。
   * 异常在 `dirty = false` 之前抛出，于是 dirty 保持 true —— 下一次
   * saveNow()、下一次去抖保存、以及关窗时的 flush 都会**继续重试**，
   * 直到真正写成功为止。异常继续上抛给 persistence.saveNow()，由它写入
   * dbError，界面才看得见"保存失败"。
   * 反过来说：任何在这里吞掉异常、或者先把 dirty 清掉的改动，都会让
   * 失败的写入既不重试也不报错，静默丢数据。
   */
  await saveDatabaseBytes(bytes)
  dirty = false
  return true
}

/** 是否还有未落盘的变更 */
export function isDirty() {
  return dirty
}

/** 销毁内存实例并可选清除持久化数据（重置演示数据用） */
export async function destroyDatabase({ clearStorage = false } = {}) {
  if (db) {
    db.close()
    db = null
  }
  dirty = false
  if (clearStorage) await clearDatabaseBytes()
}

/**
 * 兼容旧接口的便捷导出（DOMPurify 无关，仅 SQL 执行）
 */
export function execute(sql, params = []) {
  requireDB().run(sql, params)
  dirty = true
}

export { storageInfo }
