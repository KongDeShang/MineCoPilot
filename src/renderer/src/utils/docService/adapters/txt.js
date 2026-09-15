/**
 * docService · TXT 适配器（txt / md / log / json 直读）
 *
 * 编码处理：优先 UTF-8；若解码结果含替换符 U+FFFD（说明不是合法 UTF-8），
 * 回退尝试 GBK——矿场设备清单、导出日志常是 GBK 编码的 txt。
 */
export async function parseTxt(file) {
  const buf = await file.arrayBuffer()
  let text = new TextDecoder('utf-8').decode(buf)
  if (text.includes('\uFFFD')) {
    try {
      const gbk = new TextDecoder('gbk').decode(buf)
      if (gbk && !gbk.includes('\uFFFD')) text = gbk
    } catch { /* GBK 不可用时保留 UTF-8 结果 */ }
  }
  const trimmed = text.replace(/\r\n/g, '\n').trim()
  if (!trimmed) return { ok: false, error: '文件内容为空', reason: 'corrupt' }
  return { ok: true, format: 'txt', pages: 1, text: trimmed, tables: [] }
}
