/**
 * 矿山智工 - 数据备份与迁移
 *
 * 一键换机流程：
 *   旧电脑：系统设置 → 数据备份与迁移 → 一键导出备份（生成单个 .mbak 文件）
 *   新电脑：安装应用 → 系统设置 → 数据备份与迁移 → 一键导入备份 → 重启生效
 *
 * 备份内容（一个 .mbak JSON 文件）：
 *   - 整库字节（设备台账 / 维保记录 / 工单 / 健康快照 / 知识库 / 文档索引 / 设置 meta）
 *   - AI 聊天记录（localStorage，独立于数据库文件）
 *   - 导出时间与版本号，导入时校验
 */
import * as db from './database'
import { formatDate } from './dates'

const BACKUP_KIND = 'kuangshan-zhigong-backup'
const CHAT_KEY = 'ai_chat_messages'

function isElectron() {
  return typeof window !== 'undefined' && !!(window.electronAPI && window.electronAPI.backup)
}

/** 组装备份对象（JSON 字符串） */
export async function buildBackup() {
  const dbBase64 = db.exportBase64()
  let chatHistory = []
  try {
    const raw = localStorage.getItem(CHAT_KEY)
    if (raw) chatHistory = JSON.parse(raw)
  } catch {
    /* 聊天记录缺失不影响备份 */
  }
  return JSON.stringify({
    app: BACKUP_KIND,
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    dbBase64,
    chatHistory
  })
}

/** 一键导出备份：Electron 弹保存框；浏览器模式直接下载 */
export async function exportBackup() {
  const json = await buildBackup()
  // 文件名用本地日期：早 8 点前导出，toISOString 会写成前一天
  const defaultName = `矿山智工备份_${formatDate(new Date())}.mbak`

  if (isElectron()) {
    const r = await window.electronAPI.backup.export({ content: json, defaultName })
    if (r && r.ok) return { ok: true, path: r.path, size: json.length }
    if (r && r.canceled) return { ok: false, canceled: true }
    return { ok: false, error: (r && r.error) || '导出失败' }
  }

  // 浏览器降级：Blob 下载
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = defaultName
  a.click()
  URL.revokeObjectURL(url)
  return { ok: true, size: json.length }
}

/** 一键导入备份：Electron 弹打开框；浏览器模式需外部传入文件内容 */
export async function importBackup(fileContent) {
  let content = fileContent
  if (!content && isElectron()) {
    const r = await window.electronAPI.backup.import()
    if (!r || !r.ok) {
      if (r && r.canceled) return { ok: false, canceled: true }
      return { ok: false, error: (r && r.error) || '未选择备份文件' }
    }
    content = r.content
  }
  if (!content) return { ok: false, error: '未读取到备份内容' }

  let parsed
  try {
    parsed = JSON.parse(content)
  } catch {
    return { ok: false, error: '备份文件格式不正确（不是有效的 .mbak 文件）' }
  }
  if (!parsed || parsed.app !== BACKUP_KIND || !parsed.dbBase64) {
    return { ok: false, error: '备份文件校验失败：不是矿山智工的备份文件' }
  }

  // 恢复数据库字节
  try {
    const binary = atob(parsed.dbBase64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    await db.restoreFromBytes(bytes)
  } catch (error) {
    return { ok: false, error: `数据库恢复失败：${error.message}` }
  }

  // 恢复 AI 聊天记录
  try {
    if (Array.isArray(parsed.chatHistory) && parsed.chatHistory.length) {
      localStorage.setItem(CHAT_KEY, JSON.stringify(parsed.chatHistory))
    } else {
      localStorage.removeItem(CHAT_KEY)
    }
  } catch {
    /* 聊天记录写入失败不阻断主流程 */
  }

  return { ok: true, exportedAt: parsed.exportedAt }
}
