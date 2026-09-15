/**
 * docService —— 统一文档解析入口
 *
 * 任何域"丢进一个文件 → 拿到结构化文本"：
 *   parse(file) → { ok, format, name, pages, text, tables?, chunks?, cached? }
 *     | { ok:false, error, reason: 'no_text_layer' | 'unsupported' | 'corrupt' | 'too_large' }
 *
 * 支持：pdf / xlsx / xls / csv / docx / txt / md / log / json
 * 老 .doc 明确 unsupported（提示转存 docx），不硬撑。
 *
 * 缓存：key = sha256(文件前 64KB) + 文件大小，存 IndexedDB（Electron 下同样在 userData），
 *       同一文件二次解析秒出（同时解决手册库首启抽文字层的开销）。
 * 铁律：本模块不做任何网络请求，纯本地解析。
 */
import { parsePdf } from './adapters/pdf'
import { parseExcel } from './adapters/excel'
import { parseWord } from './adapters/word'
import { parseTxt } from './adapters/txt'

/** 单文件大小上限（超过判定 too_large，提示拆分） */
export const MAX_SIZE = 80 * 1024 * 1024

const ADAPTERS = {
  pdf: parsePdf,
  xlsx: parseExcel,
  xls: parseExcel,
  csv: parseExcel,
  docx: parseWord,
  doc: parseWord,
  txt: parseTxt,
  md: parseTxt,
  log: parseTxt,
  json: parseTxt
}

export function supportedExts() {
  return Object.keys(ADAPTERS)
}

function fail(error, reason) {
  return { ok: false, error, reason }
}

function extOf(name) {
  const idx = String(name || '').lastIndexOf('.')
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : ''
}

// ---------------------------------------------------------------------------
// 缓存（IndexedDB）
// ---------------------------------------------------------------------------

const IDB_NAME = 'kuangshan-doc-cache'
const IDB_STORE = 'parses'
const MAX_ENTRIES = 60

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
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

async function idbPut(key, value) {
  const db = await idbOpen()
  await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(value, key)
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => reject(tx.error)
  })
  await idbTrim(db)
}

/** 超过 MAX_ENTRIES 时删最旧的缓存条目（按 extractedAt） */
async function idbTrim(db) {
  try {
    const all = await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly')
      const req = tx.objectStore(IDB_STORE).openCursor()
      const items = []
      req.onsuccess = () => {
        const cur = req.result
        if (cur) { items.push({ key: cur.key, at: (cur.value && cur.value.extractedAt) || 0 }); cur.continue() }
        else resolve(items)
      }
      req.onerror = () => reject(req.error)
    })
    if (all.length <= MAX_ENTRIES) return
    const victims = all.sort((a, b) => a.at - b.at).slice(0, all.length - MAX_ENTRIES)
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite')
      for (const v of victims) tx.objectStore(IDB_STORE).delete(v.key)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => reject(tx.error)
    })
  } catch { /* 清理失败不影响主流程 */ }
}

async function cacheKeyOf(file) {
  const head = await file.slice(0, 65536).arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', head)
  const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
  return `${hex}:${file.size}`
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 统一解析入口
 * @param {File|Blob} file
 * @returns {Promise<{ok:boolean, format?:string, name?:string, pages?:number, text?:string, tables?:any, chunks?:Array, cached?:boolean, error?:string, reason?:string}>}
 */
export async function parse(file) {
  const name = file && file.name
  if (!name || typeof file.arrayBuffer !== 'function') {
    return fail('文件不可读', 'corrupt')
  }
  const ext = extOf(name)
  const adapter = ADAPTERS[ext]
  if (!adapter) return fail(`不支持的文件格式 .${ext || '?'}（支持：${supportedExts().join(' / ')}）`, 'unsupported')
  if (file.size > MAX_SIZE) return fail('文件过大（超过 80MB），请拆分后重试', 'too_large')

  // 命中缓存直接返回（只缓存成功结果）
  try {
    const key = await cacheKeyOf(file)
    const hit = await idbGet(key)
    if (hit && hit.ok) return { ...hit, cached: true }
    const r = await adapter(file)
    if (!r.ok) return r
    const result = {
      ok: true,
      format: r.format,
      name,
      pages: r.pages || 1,
      text: r.text || '',
      tables: r.tables,
      chunks: r.chunks || [],
      extractedAt: Date.now()
    }
    await idbPut(key, result)
    return result
  } catch (e) {
    // 缓存层故障不影响解析本身
    try {
      const r = await adapter(file)
      if (!r.ok) return r
      return {
        ok: true,
        format: r.format,
        name,
        pages: r.pages || 1,
        text: r.text || '',
        tables: r.tables,
        chunks: r.chunks || [],
        extractedAt: Date.now()
      }
    } catch (e2) {
      return fail(`解析失败：${(e2 && e2.message) || e2}`, 'corrupt')
    }
  }
}
