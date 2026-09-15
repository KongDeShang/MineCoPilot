/**
 * 文档资料库 · PDF 文本提取（兼容层）
 *
 * 已收敛到 docService（统一文档解析入口），本文件保留旧导出名供既有调用方过渡：
 *   extractPdfText(file) → { ok, pages, chunks }
 * 逻辑本体在 utils/docService/adapters/pdf.js，这里只做转发。
 */
import { parsePdf } from './docService/adapters/pdf'

/** @param {File|Blob} file @returns {Promise<{ok:true,pages:number,chunks:Array<{page:number,text:string}>}|{ok:false,error:string}>} */
export async function extractPdfText(file) {
  const r = await parsePdf(file)
  if (r.ok) return { ok: true, pages: r.pages, chunks: r.chunks }
  return { ok: false, error: r.error }
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
