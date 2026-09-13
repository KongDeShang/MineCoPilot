/**
 * 文档资料库 · 文件存储兼容层
 *
 * 两种运行环境，一套接口：
 *   - Electron 模式：文件复制进 userData/documents/，打开走系统 PDF 阅读器（shell.openPath）
 *   - 浏览器模式（e2e / 网页演示降级）：文件存 IndexedDB，打开走 objectURL 新窗口
 *
 * 元数据（标题/机型/页码/可问答状态）由 sql.js 的 documents 表管理，这里只管文件字节。
 */

const ELECTRON = typeof window !== 'undefined' && !!window.electronAPI && window.electronAPI.isElectron

// ---------- IndexedDB（浏览器降级） ----------
const IDB_NAME = 'kuangshan-docs'
const IDB_STORE = 'files'

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbPut(key, blob) {
  const db = await idbOpen()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(blob, key)
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => reject(tx.error)
  })
}

async function idbGet(key) {
  const db = await idbOpen()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly')
    const req = tx.objectStore(IDB_STORE).get(key)
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => reject(req.error)
  })
}

async function idbDelete(key) {
  const db = await idbOpen()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).delete(key)
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => reject(tx.error)
  })
}

function idbKeyOf(name) {
  return `doc:${name}`
}

export const docFileStore = {
  isElectron: ELECTRON,

  /** 保存文件字节，返回 { ok, path, size } */
  async save(fileName, blob) {
    if (ELECTRON) {
      const data = await blob.arrayBuffer()
      return window.electronAPI.docs.addFile({ fileName, data })
    }
    const key = idbKeyOf(fileName)
    await idbPut(key, blob)
    return { ok: true, path: `idb://${fileName}`, size: blob.size }
  },

  /** 打开文档（Electron 系统阅读器 / 浏览器新窗口） */
  async open(filePath, fileName) {
    if (ELECTRON) {
      const res = await window.electronAPI.docs.open({ path: filePath })
      return res.ok
    }
    const blob = await idbGet(idbKeyOf(fileName))
    if (!blob) return false
    const url = URL.createObjectURL(blob)
    window.open(url, '_blank')
    return true
  },

  /** 删除文件字节 */
  async remove(filePath, fileName) {
    if (ELECTRON) {
      const res = await window.electronAPI.docs.deleteFile({ path: filePath })
      return res.ok
    }
    await idbDelete(idbKeyOf(fileName))
    return true
  }
}
