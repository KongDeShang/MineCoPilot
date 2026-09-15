/**
 * docService · Excel 适配器（xlsx / xls / csv）
 *
 * 核心逻辑与 excelParser 保持一致（同一套 FIELD_ALIASES / identifyHeaders 表头识别），
 * 但走 file.arrayBuffer() 而不是 FileReader —— 这样在 Node 测试环境也能跑。
 * 产出：结构化 tables（给导入类调用方）+ Markdown 表格文本 text（给问答/检索类调用方）。
 */
import * as XLSX from 'xlsx'
import { identifyHeaders } from '../../excelParser'

/** 单个值转文本（表格排版用） */
function cellText(v) {
  if (v === null || v === undefined) return ''
  return String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

export async function parseExcel(file) {
  const data = new Uint8Array(await file.arrayBuffer())
  let workbook
  try {
    workbook = XLSX.read(data, { type: 'array' })
  } catch (e) {
    return { ok: false, error: `Excel 解析失败：${e && e.message || e}`, reason: 'corrupt' }
  }

  const result = { filename: file.name, sheets: [] }

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName]
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 })
    if (!jsonData || jsonData.length === 0) continue

    // 找到表头行（第一个非空行）
    let headerRowIndex = 0
    for (let i = 0; i < Math.min(5, jsonData.length); i++) {
      if (jsonData[i] && jsonData[i].length > 1) { headerRowIndex = i; break }
    }

    const headers = jsonData[headerRowIndex].map(h => String(h || '').trim())
    const headerMapping = identifyHeaders(headers)

    const rows = []
    for (let i = headerRowIndex + 1; i < jsonData.length; i++) {
      const row = jsonData[i]
      if (!row || row.every(cell => cell === null || cell === undefined || cell === '')) continue
      const rowObj = {}
      headers.forEach((header, index) => {
        if (header) {
          const standardField = headerMapping[header] || header
          rowObj[standardField] = row[index] !== undefined ? row[index] : ''
        }
      })
      rows.push(rowObj)
    }

    result.sheets.push({
      name: sheetName,
      headers: headers.filter(h => h),
      headerMapping,
      rows,
      totalRows: rows.length,
      totalCols: headers.filter(h => h).length
    })
  }

  if (result.sheets.length === 0) {
    return { ok: false, error: '未从文件中解析出任何表格内容', reason: 'corrupt' }
  }

  // 多 Sheet 合并为 Markdown 风格表格文本（供问答/检索）
  const parts = []
  for (const sheet of result.sheets) {
    parts.push(`## ${sheet.name}`)
    parts.push(`| ${sheet.headers.join(' | ')} |`)
    parts.push(`|${sheet.headers.map(() => '---').join('|')}|`)
    for (const row of sheet.rows.slice(0, 500)) {
      parts.push(`| ${sheet.headers.map(h => cellText(row[h])).join(' | ')} |`)
    }
  }

  return { ok: true, format: 'excel', pages: result.sheets.length, text: parts.join('\n'), tables: result }
}
