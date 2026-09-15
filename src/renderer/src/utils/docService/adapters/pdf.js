/**
 * docService · PDF 适配器（pdfjs-dist，按需 worker）
 *
 * 从 utils/pdfExtract.js 迁移：逐页提取文字层，按页切块供带出处检索。
 * 无文字层（扫描件）→ { ok:false, reason:'no_text_layer' }，调用方据此降级"仅查看"。
 */
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

if (typeof GlobalWorkerOptions !== 'undefined') {
  GlobalWorkerOptions.workerSrc = workerUrl
}

export async function parsePdf(file) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    return { ok: false, error: '文件不可读', reason: 'corrupt' }
  }
  let pdf = null
  try {
    const data = await file.arrayBuffer()
    pdf = await getDocument({ data }).promise
    const chunks = []
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p)
      const content = await page.getTextContent()
      const text = (content.items || [])
        .map(it => (it && typeof it.str === 'string' ? it.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (text) chunks.push({ page: p, text })
    }
    if (chunks.length === 0) {
      return { ok: false, error: '未提取到文字层（扫描件）', reason: 'no_text_layer' }
    }
    return {
      ok: true,
      format: 'pdf',
      pages: pdf.numPages,
      text: chunks.map(c => c.text).join('\n'),
      chunks
    }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error), reason: 'corrupt' }
  } finally {
    // 必须放 finally：pdfjs 默认跑在独立 Web Worker 里，
    // 出错时若不销毁，worker 与它占的缓冲区会一直留到标签页关闭。
    if (pdf) {
      try { await pdf.destroy() } catch { /* 已被销毁或 worker 已退出，忽略 */ }
    }
  }
}
