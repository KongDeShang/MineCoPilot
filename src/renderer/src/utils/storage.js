/**
 * 矿山智工 - 本地存储适配层
 *
 * 三层兜底，保证「数据不出设备」：
 *   1. Electron 桌面版：通过 preload 暴露的 IPC 白名单接口写入 userData 目录下的 .db 文件
 *   2. 浏览器 + IndexedDB：存入本机浏览器数据库（Web 版离线可用）
 *   3. localStorage：最后的降级方案（容量有限，仅保证不丢）
 *
 * 数据库以 Uint8Array 序列化后存储：Electron 走 ArrayBuffer，浏览器走 base64。
 */

const DB_FILE_NAME = 'kuangshan-zhigong.db'
const IDB_NAME = 'kuangshan-zhigong'
const IDB_STORE = 'kv'
const IDB_KEY = 'database'
const LS_KEY = 'kuangshan-zhigong:database'

/**
 * 最近一次**实际写入成功**的后端。
 *
 * 为什么需要它：storageInfo.backend() 原来只看 `typeof indexedDB !== 'undefined'`，
 * 于是 IndexedDB 配额满、写入已静默降级到 localStorage 之后，状态栏仍然显示
 * "IndexedDB" —— 用户看到的存储位置与真实位置不一致。现在按真实写入结果上报。
 */
let lastBackend = null

/** 当前运行在 Electron 壳内？ */
export function isElectron() {
  return typeof window !== 'undefined' && !!(window.electronAPI && window.electronAPI.db)
}

// ---------- base64 <-> Uint8Array（浏览器存储用） ----------

function bytesToBase64(bytes) {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function base64ToBytes(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// ---------- IndexedDB ----------

function openIDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB 不可用'))
      return
    }
    const request = indexedDB.open(IDB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('IndexedDB 打开失败'))
  })
}

function idbRequest(store, mode, fn) {
  return openIDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode)
    const req = fn(tx.objectStore(store))
    tx.oncomplete = () => { db.close(); resolve(req ? req.result : undefined) }
    tx.onerror = () => { db.close(); reject(tx.error) }
    tx.onabort = () => { db.close(); reject(tx.error || new Error('IndexedDB 事务中止')) }
  }))
}

function idbGet() {
  return idbRequest(IDB_STORE, 'readonly', store => store.get(IDB_KEY))
}

function idbSet(value) {
  return idbRequest(IDB_STORE, 'readwrite', store => store.put(value, IDB_KEY))
}

function idbClear() {
  return idbRequest(IDB_STORE, 'readwrite', store => store.delete(IDB_KEY))
}

// ---------- localStorage ----------

function lsGet() {
  try {
    return localStorage.getItem(LS_KEY)
  } catch {
    return null
  }
}

function lsSet(value) {
  try {
    localStorage.setItem(LS_KEY, value)
    return true
  } catch {
    return false
  }
}

function lsClear() {
  try {
    localStorage.removeItem(LS_KEY)
  } catch {
    /* 忽略：隐私模式下不可写 */
  }
}

// ---------- 对外 API ----------

/**
 * 读取数据库字节
 * @returns {Promise<Uint8Array|null>} 无历史数据时返回 null
 */
export async function loadDatabaseBytes() {
  if (isElectron()) {
    const buffer = await window.electronAPI.db.read()
    return buffer ? new Uint8Array(buffer) : null
  }

  try {
    const base64 = await idbGet()
    if (base64) return base64ToBytes(base64)
  } catch {
    /* 落到 localStorage */
  }

  const fallback = lsGet()
  return fallback ? base64ToBytes(fallback) : null
}

/**
 * 写入数据库字节
 *
 * ⚠️ 失败必须抛错，不能静默返回。
 * 此前这里把 `db:write` 的返回值整个丢掉、localStorage 的 `lsSet` 返回值也丢掉，
 * 于是磁盘满/文件被占用/超配额时：database.persist() 照样清 dirty 并返回 true，
 * 状态栏显示"已保存 HH:MM"，而关窗时 database.persist() 又因为 dirty 已被清掉
 * 直接提前返回 —— 这段改动既不重试、也不报错，随关窗一起消失。
 * 抛错后由 stores/persistence.js 的 saveNow() catch 住并写入 dbError，用户能看见。
 */
export async function saveDatabaseBytes(bytes) {
  if (isElectron()) {
    // 复制一份独立的 ArrayBuffer，避免把渲染进程的视图直接交给 IPC
    let result
    try {
      result = await window.electronAPI.db.write(bytes.slice().buffer)
    } catch (error) {
      // 主进程 handler 抛错时，IPC 会把异常原样传回来
      throw new Error(`写入数据库文件失败：${error && error.message ? error.message : error}`, { cause: error })
    }
    // 主进程约定失败时返回 { ok: false, error }（见 src/main/index.js db:write）
    if (!result || result.ok !== true) {
      throw new Error(`写入数据库文件失败：${(result && result.error) || '主进程未返回成功'}`)
    }
    lastBackend = 'electron-file'
    return
  }

  const base64 = bytesToBase64(bytes)
  try {
    await idbSet(base64)
    lastBackend = 'indexeddb'
    return
  } catch {
    /* IndexedDB 不可用/配额满，落到 localStorage */
  }
  if (!lsSet(base64)) {
    throw new Error('本地存储写入失败：IndexedDB 不可用且 localStorage 也写不进去（可能已超出配额）')
  }
  lastBackend = 'localstorage'
}

/** 清空持久化数据（重置演示数据时使用） */
export async function clearDatabaseBytes() {
  if (isElectron()) {
    const result = await window.electronAPI.db.clear()
    if (result && result.ok === false) {
      throw new Error(`清空数据库文件失败：${result.error || '主进程未返回成功'}`)
    }
    return
  }
  try {
    await idbClear()
  } catch {
    /* 忽略 */
  }
  lsClear()
}

export const storageInfo = {
  fileName: DB_FILE_NAME,
  backend() {
    // 以真实写入结果为准；还没写过才回退到能力探测
    if (lastBackend) return lastBackend
    if (isElectron()) return 'electron-file'
    if (typeof indexedDB !== 'undefined') return 'indexeddb'
    return 'localstorage'
  }
}
