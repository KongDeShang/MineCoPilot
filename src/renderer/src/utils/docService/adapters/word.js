/**
 * docService · Word 适配器（docx 用 mammoth；老 .doc 明确返回 unsupported）
 *
 * mammoth 是纯 JS（零 .node、无原生依赖），符合离线铁律。
 * 老 .doc（OLE 二进制格式）mammoth 不支持，如实返回 unsupported + 提示转存，不硬撑。
 */
import mammoth from 'mammoth/mammoth.browser'

export async function parseWord(file) {
  const name = String(file.name || '').toLowerCase()
  if (!name.endsWith('.docx')) {
    return { ok: false, error: '旧版 .doc 格式暂不支持，请在 Word 中另存为 .docx 后重试', reason: 'unsupported' }
  }
  const arrayBuffer = await file.arrayBuffer()
  let value
  try {
    const r = await mammoth.extractRawText({ arrayBuffer })
    value = (r && r.value) || ''
  } catch (e) {
    return { ok: false, error: `Word 解析失败：${e && e.message || e}`, reason: 'corrupt' }
  }
  const text = String(value || '').replace(/\r\n/g, '\n').trim()
  if (!text) return { ok: false, error: '未能从文档中提取到文本（可能内容为空或文档损坏）', reason: 'corrupt' }
  return { ok: true, format: 'word', pages: 1, text, tables: [] }
}
