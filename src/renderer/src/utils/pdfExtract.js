/**
 * 文档资料库 · PDF 文本提取（本地离线，无网络依赖）
 *
 * 用 pdfjs-dist 逐页提取文字层：
 *   - 有文字层的 PDF → 按页切块，供 AI 带出处检索（出处 = 文件名 + 页码）
 *   - 扫描件（无文字层）→ 返回 ok:false，仅可查看、诚实标注"暂不能问答"
 *
 * worker 通过 ?url 导入，vite 打包时把 worker 复制进产物，不依赖任何 CDN。
 */
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

if (typeof GlobalWorkerOptions !== 'undefined') {
  GlobalWorkerOptions.workerSrc = workerUrl
}

/**
 * @param {File|Blob} file
 * @returns {Promise<{ok:true,pages:number,chunks:Array<{page:number,text:string}>}|{ok:false,error:string}>}
 */
export async function extractPdfText(file) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    return { ok: false, error: '文件不可读' }
  }
  try {
    const data = await file.arrayBuffer()
    const pdf = await getDocument({ data }).promise
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
    const pages = pdf.numPages
    await pdf.destroy()
    return { ok: true, pages, chunks }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

/** 提取关键词用于检索加权：机型、类型、标题里的 2 字以上片段 */
export function keywordsFromDoc({ title, model, category }) {
  const words = new Set()
  for (const w of [title, model, category].filter(Boolean)) {
    const cleaned = String(w).replace(/[《》（）()（）\s]/g, '')
    if (cleaned.length >= 2) words.add(cleaned)
    if (cleaned.length > 4) {
      for (const part of cleaned.split(/[·\-_/]/)) {
        if (part.length >= 2) words.add(part)
      }
    }
  }
  return [...words].slice(0, 12)
}
