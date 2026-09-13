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

/**
 * 随包静态资源的 URL
 *
 * 用 document.baseURI 解析而不是 import.meta.url：随包手册在 public/manuals 下，
 * 由 vite 原样拷到产物根目录（base: './'），所以它相对的是**页面**，不是某个模块。
 * 用 import.meta.url 拼出来的会是 /src/renderer/src/utils/manuals/... 这类错路径。
 */
function assetUrl(name) {
  const base = typeof document !== 'undefined' && document.baseURI ? document.baseURI : './'
  return new URL(`manuals/${name}`, base).href
}

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
    // 随包示例手册在浏览器模式下记的是静态 URL（原件没进 IndexedDB），直接交给浏览器
    if (/^https?:/i.test(filePath || '')) {
      window.open(filePath, '_blank')
      return true
    }
    const blob = await idbGet(idbKeyOf(fileName))
    if (!blob) return false
    const url = URL.createObjectURL(blob)
    window.open(url, '_blank')
    return true
  },

  /**
   * 把随包示例手册取进资料库，返回 { ok, path, size, pages, chunks }
   *
   * 两种环境取字节的方式不同，但读的是同一份静态资源（src/renderer/public/manuals）：
   *   Electron：由主进程从 resources/manuals 复制进 documents/ —— 资料库只认这个目录，
   *             渲染进程既看不到 resources 路径，也无权往 documents/ 里写文件；
   *   浏览器：直接 fetch 随包静态文件取文字层；原件不落库（记 URL、打开时现取）。
   *
   * 失败一律返回 ok:false 而不是抛异常：示例手册缺失是打包问题，
   * 不该让整个应用起不来（调用方跳过即可，self-check 会单独盯着资源是否齐全）。
   */
  async importBundled(slug) {
    // 整段兜底：fetch 断网/被拦、IPC 主进程异常都会抛，而调用方在启动路径上，
    // 一份示例手册的缺失绝不能把启动流程带走
    try {
      if (ELECTRON) {
        const res = await window.electronAPI.docs.importBundled({ slug })
        if (!res || !res.ok) return { ok: false, error: (res && res.error) || '导入失败' }
        let parsed = null
        try { parsed = JSON.parse(res.text || 'null') } catch { parsed = null }
        return {
          ok: true,
          path: res.path,
          size: res.size,
          pages: parsed && Number.isFinite(parsed.pages) ? parsed.pages : 0,
          chunks: parsed && Array.isArray(parsed.chunks) ? parsed.chunks : []
        }
      }

      const textRes = await fetch(assetUrl(`${slug}.json`))
      if (!textRes.ok) return { ok: false, error: `随包手册文字层缺失：${slug}.json` }
      const parsed = await textRes.json()

      /**
       * 文字层（一百多 KB）拿下来，原件 PDF 只做一次 HEAD 确认它真的在，
       * 不下载、也不写进 IndexedDB —— 三份原件加起来 4.8 MB，
       * 为了"可能有人点一下查看原文"就在每次首启时拷一遍，代价不成比例。
       * 于是 filePath 直接记静态 URL，open() 认得 http(s) 就直接开（见下）。
       */
      const pdfRes = await fetch(assetUrl(`${slug}.pdf`), { method: 'HEAD' })
      if (!pdfRes.ok) return { ok: false, error: `随包手册原件缺失：${slug}.pdf` }

      return {
        ok: true,
        path: assetUrl(`${slug}.pdf`),
        size: Number(pdfRes.headers.get('content-length')) || 0,
        pages: Number.isFinite(parsed.pages) ? parsed.pages : 0,
        chunks: Array.isArray(parsed.chunks) ? parsed.chunks : []
      }
    } catch (error) {
      return { ok: false, error: (error && error.message) || String(error) }
    }
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
