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
 */
export async function saveDatabaseBytes(bytes) {
  if (isElectron()) {
    // 复制一份独立的 ArrayBuffer，避免把渲染进程的视图直接交给 IPC
    await window.electronAPI.db.write(bytes.slice().buffer)
    return
  }

  const base64 = bytesToBase64(bytes)
  try {
    await idbSet(base64)
    return
  } catch {
    /* 落到 localStorage */
  }
  lsSet(base64)
}

/** 清空持久化数据（重置演示数据时使用） */
export async function clearDatabaseBytes() {
  if (isElectron()) {
    await window.electronAPI.db.clear()
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
    if (isElectron()) return 'electron-file'
    if (typeof indexedDB !== 'undefined') return 'indexeddb'
    return 'localstorage'
  }
}
