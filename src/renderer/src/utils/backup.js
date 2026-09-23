/**
 * 矿山智工 - 数据备份与迁移
 *
 * 一键换机流程：
 *   旧电脑：系统设置 → 数据备份与迁移 → 一键导出备份（生成单个 .mbak 文件）
 *   新电脑：安装应用 → 系统设置 → 数据备份与迁移 → 一键导入备份 → 重启生效
 *
 * 备份内容（一个 .mbak JSON 文件，v2）：
 *   - 整库字节（设备台账 / 维保记录 / 工单 / 健康快照 / 知识库 / 文档索引 / 故障案例 / 备件 / 日志）
 *   - AI 聊天记录（localStorage，独立于数据库文件）
 *   - 用户设置（主题 / 色彩 / 向导状态 / 导航钉住等 localStorage 白名单键）
 *   - 文档资料库文件（Electron：userData/documents/ 磁盘文件；浏览器：IndexedDB）
 *   - SHA-256 完整性校验（防损坏 / 半截 / 篡改文件）
 *   - 导出时间与版本号，导入时校验（兼容 v1 旧备份）
 */
import * as db from './database'
import { formatDate } from './dates'

const BACKUP_KIND = 'kuangshan-zhigong-backup'
const CHAT_KEY = 'ai_chat_messages'

/**
 * 备份里的聊天记录是否真的有内容。
 *
 * ⚠️ 这里必须同时认两种形状，否则导入备份会**删掉**用户的对话历史：
 * AI 助手写入 `ai_chat_messages` 的是一个对象
 * `{ savedAt, equipmentCount, messages, conversation }`（见 views/AIAssistant.vue 的
 * scheduleChatSave），而导入侧原来只判 `Array.isArray(...)` —— 对对象恒为 false，
 * 于是走 else 分支 removeItem，把备份里明明存在的聊天记录抹掉。
 * 数组是更早版本的形状，保留兼容。
 */
function hasChatContent(chat) {
  if (Array.isArray(chat)) return chat.length > 0
  if (!chat || typeof chat !== 'object') return false
  const messages = Array.isArray(chat.messages) ? chat.messages : null
  if (messages) return messages.length > 0
  const conversation = Array.isArray(chat.conversation) ? chat.conversation : null
  if (conversation) return conversation.length > 0
  // 认不出的对象形状：只要不是空对象就当作有内容，宁可还原也不要误删
  return Object.keys(chat).length > 0
}

/** 纳入备份的 localStorage 白名单（用户设置类键；数据库兜底键天然排除） */
const SETTINGS_KEYS = [
  'ks:theme',          // 深浅主题
  'ks:color',          // 色彩主题
  'ks:wizard-dismissed', // 模型向导已跳过
  'mining-nav-pinned', // 侧边栏钉住项
  'hasSeenLanding',    // 落地页已看过
  'ks:master-mode',    // AI 老师傅模式开关（任务 17）
  'ks:troubleshoot-maps' // 四类排查思路表用户版（任务 17）
]

// 浏览器模式的文档文件库（与 docFileStore 同一库）
const DOCS_IDB_NAME = 'kuangshan-docs'
const DOCS_IDB_STORE = 'files'

function isElectron() {
  return typeof window !== 'undefined' && !!(window.electronAPI && window.electronAPI.backup)
}

// ---------- SHA-256（Web Crypto，浏览器/Electron 渲染进程均可用） ----------

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ---------- 设置收集/恢复 ----------

function collectSettings() {
  const out = {}
  for (const key of SETTINGS_KEYS) {
    try {
      const v = localStorage.getItem(key)
      if (v !== null) out[key] = v
    } catch { /* 隐私模式忽略 */ }
  }
  return out
}

function restoreSettings(settings) {
  if (!settings || typeof settings !== 'object') return
  for (const key of SETTINGS_KEYS) {
    try {
      if (Object.prototype.hasOwnProperty.call(settings, key)) {
        localStorage.setItem(key, settings[key])
      }
    } catch { /* 写入失败不阻断 */ }
  }
}

// ---------- 文档文件收集/恢复（浏览器模式走 IndexedDB） ----------

function idbDocsOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DOCS_IDB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DOCS_IDB_STORE)) req.result.createObjectStore(DOCS_IDB_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function collectDocsBrowser() {
  const files = []
  try {
    const idb = await idbDocsOpen()
    const tx = idb.transaction(DOCS_IDB_STORE, 'readonly')
    const store = tx.objectStore(DOCS_IDB_STORE)
    const rows = await new Promise((resolve, reject) => {
      const req = store.getAll()
      req.onsuccess = () => resolve(req.result || [])
      req.onerror = () => reject(req.error)
    })
    const keys = await new Promise((resolve, reject) => {
      const req = store.getAllKeys()
      req.onsuccess = () => resolve(req.result || [])
      req.onerror = () => reject(req.error)
    })
    idb.close()
    for (let i = 0; i < rows.length; i++) {
      const blob = rows[i]
      if (!(blob instanceof Blob)) continue
      const key = String(keys[i] || '')
      const name = key.startsWith('doc:') ? key.slice(4) : key
      files.push({ name, dataBase64: await blobToBase64(blob), size: blob.size })
    }
  } catch { /* 无文档库视为空 */ }
  return files
}

async function restoreDocsBrowser(files) {
  if (!Array.isArray(files) || !files.length) return
  try {
    const idb = await idbDocsOpen()
    const tx = idb.transaction(DOCS_IDB_STORE, 'readwrite')
    const store = tx.objectStore(DOCS_IDB_STORE)
    store.clear()
    for (const f of files) {
      if (!f || !f.name || !f.dataBase64) continue
      store.put(base64ToBlob(f.dataBase64), `doc:${f.name}`)
    }
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error) })
    idb.close()
  } catch { /* 恢复失败不阻断主流程 */ }
}

function blobToBase64(blob) {
  if (typeof FileReader === 'undefined') return Promise.resolve('')
  // Blob 较大时分块读避免栈溢出
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result === 'string') {
        // FileReader 的 dataURL 形式：data:...;base64,xxx
        const comma = result.indexOf(',')
        resolve(comma >= 0 ? result.slice(comma + 1) : result)
      } else {
        resolve('')
      }
    }
    reader.onerror = () => resolve('')
    reader.readAsDataURL(blob)
  })
}

function base64ToBlob(base64) {
  try {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new Blob([bytes])
  } catch {
    return new Blob([])
  }
}

// ---------- 组装备份 ----------

/** 组装备份对象（JSON 字符串），v2：设置 + 文档 + SHA 校验 */
export async function buildBackup() {
  const dbBase64 = db.exportBase64()
  let chatHistory = []
  try {
    const raw = localStorage.getItem(CHAT_KEY)
    if (raw) chatHistory = JSON.parse(raw)
  } catch {
    /* 聊天记录缺失不影响备份 */
  }
  const settings = collectSettings()

  // 文档文件：Electron 走主进程读 userData/documents/；浏览器读 IndexedDB
  let docFiles
  if (isElectron()) {
    const r = await window.electronAPI.docs.readAll()
    /**
     * ⚠️ readAll 失败时必须中止导出，不能当成"没有文档"继续。
     *
     * 主进程在单文件 >50MB 或总量 >200MB 时会返回 { ok:false, error }（见 src/main/index.js）。
     * 此前这里 `if (r && r.ok)` 不成立时 docFiles 保持空数组，备份照样导出并提示"导出成功"，
     * 于是换机后出现最坏的一种不一致：数据库里有手册元数据、documents/ 目录里没有文件，
     * 手册资料库全部打不开，而用户在导出当天看到的是成功提示。
     */
    if (!r || !r.ok) {
      throw new Error(`读取手册文件失败，已中止导出以免备份缺少手册：${(r && r.error) || '主进程未返回成功'}`)
    }
    docFiles = r.files || []
  } else {
    docFiles = await collectDocsBrowser()
  }

  const contentDigest = dbBase64 + '|' + JSON.stringify({ chatHistory, settings, docFiles })
  const sha256 = await sha256Hex(contentDigest)

  return JSON.stringify({
    app: BACKUP_KIND,
    version: '2.0.0',
    exportedAt: new Date().toISOString(),
    dbBase64,
    chatHistory,
    settings,
    docFiles,
    sha256
  })
}

/**
 * 一键导出备份
 * @param {object} [opts]
 * @param {boolean} [opts.auto] - 自动备份（导入前防呆）：Electron 下静默写入 userData/backups/，不弹框
 */
export async function exportBackup(opts = {}) {
  const json = await buildBackup()
  // 文件名用本地日期：早 8 点前导出，toISOString 会写成前一天
  const defaultName = `矿山智工备份_${formatDate(new Date())}.mbak`

  if (isElectron()) {
    if (opts.auto) {
      const r = await window.electronAPI.backup.autoBackup({ content: json })
      if (r && r.ok) return { ok: true, path: r.path, size: json.length, auto: true }
      return { ok: false, error: (r && r.error) || '自动备份失败' }
    }
    const r = await window.electronAPI.backup.export({ content: json, defaultName })
    if (r && r.ok) return { ok: true, path: r.path, size: json.length }
    if (r && r.canceled) return { ok: false, canceled: true }
    return { ok: false, error: (r && r.error) || '导出失败' }
  }

  // 浏览器降级：Blob 下载
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = defaultName
  a.click()
  URL.revokeObjectURL(url)
  return { ok: true, size: json.length }
}

/** 解析并做基础校验（app 标识 + 版本 + SHA 完整性），返回 { ok, parsed, error } */
async function parseBackup(content) {
  let parsed
  try {
    parsed = JSON.parse(content)
  } catch {
    return { ok: false, error: '备份文件格式不正确（不是有效的 .mbak 文件）' }
  }
  if (!parsed || parsed.app !== BACKUP_KIND || !parsed.dbBase64) {
    return { ok: false, error: '备份文件校验失败：不是矿山智工的备份文件' }
  }

  // 版本校验：v1 旧备份（无 settings/docFiles/sha256）兼容导入；不认识的未来大版本拒绝
  const version = String(parsed.version || '1.0.0')
  const major = Number(version.split('.')[0])
  if (major < 1 || major > 2) {
    return { ok: false, error: `备份版本 ${version} 与当前应用不兼容（支持 v1/v2）` }
  }

  // SHA-256 完整性校验（v2+）
  if (parsed.sha256) {
    const digest = parsed.dbBase64 + '|' + JSON.stringify({
      chatHistory: parsed.chatHistory || [],
      settings: parsed.settings || {},
      docFiles: parsed.docFiles || []
    })
    const actual = await sha256Hex(digest)
    if (actual !== parsed.sha256) {
      return { ok: false, error: '备份文件完整性校验失败（内容已损坏或被修改）' }
    }
  }

  return { ok: true, parsed }
}

/**
 * 一键导入备份：Electron 弹打开框；浏览器模式需外部传入文件内容
 * 导入前会先自动备份当前数据到 userData/backups/（防呆：导入错了能回滚）
 */
export async function importBackup(fileContent) {
  let content = fileContent
  let autoBackupPath = null
  if (!content && isElectron()) {
    // 自动备份当前数据（静默写入 backups/ 目录）
    try {
      const auto = await exportBackup({ auto: true })
      if (auto.ok) autoBackupPath = auto.path
      else console.warn('[备份] 导入前自动备份失败：', auto.error)
    } catch { /* 自动备份失败不阻断导入 */ }

    const r = await window.electronAPI.backup.import()
    if (!r || !r.ok) {
      if (r && r.canceled) return { ok: false, canceled: true }
      return { ok: false, error: (r && r.error) || '未选择备份文件' }
    }
    content = r.content
  }
  if (!content) return { ok: false, error: '未读取到备份内容' }

  const check = await parseBackup(content)
  if (!check.ok) return { ok: false, error: check.error }
  const parsed = check.parsed

  // 恢复数据库字节
  try {
    const binary = atob(parsed.dbBase64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    await db.restoreFromBytes(bytes)
  } catch (error) {
    return { ok: false, error: `数据库恢复失败：${error.message}` }
  }

  // 恢复 AI 聊天记录
  try {
    if (hasChatContent(parsed.chatHistory)) {
      localStorage.setItem(CHAT_KEY, JSON.stringify(parsed.chatHistory))
    } else {
      localStorage.removeItem(CHAT_KEY)
    }
  } catch {
    /* 聊天记录写入失败不阻断主流程 */
  }

  // 恢复用户设置
  restoreSettings(parsed.settings)

  // 恢复文档文件（Electron 走主进程还原 documents/；浏览器写回 IndexedDB）
  try {
    if (isElectron()) {
      await window.electronAPI.docs.restoreAll({ files: parsed.docFiles || [] })
    } else {
      await restoreDocsBrowser(parsed.docFiles)
    }
  } catch {
    /* 文档恢复失败不阻断主流程 */
  }

  return { ok: true, exportedAt: parsed.exportedAt, version: parsed.version || '1.0.0', autoBackupPath }
}
