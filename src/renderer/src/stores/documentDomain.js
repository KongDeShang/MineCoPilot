/**
 * 矿山智工 - 手册库领域逻辑（添加 / 删除 / 打开原文）
 *
 * 为什么单独成模块：
 *   这三件事的共同点是"都要碰文件本身"——存字节、抽文字层、交给系统阅读器。
 *   留在 store 里时，一处 PDF 解析失败的处理细节会跟工单、设备逻辑混在一起看。
 *   抽出来之后 appStore 只管"手册列表变了要落盘、要记日志"。
 *
 * 依赖注入而不是第二份状态：documents 还是 appStore 里那个 ref。
 * persistAll / addLog 由 appStore 传进来（分属持久化层与操作日志层）。
 */
import { now } from '../utils/dates'
import { docFileStore } from '../utils/docFileStore'
import { extractPdfText } from '../utils/pdfExtract'

export function createDocumentDomain(ctx) {
  const { documents, persistAll, addLog } = ctx

  /**
   * 添加手册：存字节 → 抽文字层 → 入列表
   *
   * 抽不到文字层不算失败：扫描件照样收下，只是降级为"仅查看"。
   * 这一点在界面上如实写明（status='view_only' + note），不硬撑成"可问答"。
   */
  async function addDocument(input) {
    const { file, title, docType = '使用手册', model = '', category = '' } = input || {}
    if (!file) return { ok: false, error: '未选择文件' }

    // 1) 保存文件字节（Electron 落盘 / 浏览器 IndexedDB）
    const saved = await docFileStore.save(file.name, file)
    if (!saved || !saved.ok) return { ok: false, error: (saved && saved.error) || '文件保存失败' }

    // 2) 本地提取 PDF 文本（无网络；扫描件降级为仅查看）
    const extracted = await extractPdfText(file)
    const doc = {
      id: `doc-${Date.now()}`,
      title: title || file.name.replace(/\.pdf$/i, ''),
      docType,
      model,
      category,
      fileName: file.name,
      filePath: saved.path,
      fileSize: saved.size || file.size,
      pages: extracted.ok ? extracted.pages : 0,
      status: extracted.ok && extracted.chunks.length ? 'ready' : 'view_only',
      chunks: extracted.ok ? extracted.chunks.slice(0, 300) : [],
      note: extracted.ok
        ? ''
        : '未提取到文字层（扫描件），可打开查看原文，暂不能直接问答',
      addedAt: now()
    }
    documents.value = [doc, ...documents.value]
    addLog({
      content: `添加手册「${doc.title}」${doc.status === 'ready' ? `（${doc.pages} 页，可问答）` : '（扫描件，仅查看）'}`,
      source: '手册库',
      type: doc.status === 'ready' ? 'success' : 'warning',
      tagType: doc.status === 'ready' ? 'success' : 'warning'
    }, { silent: true })
    persistAll()
    return { ok: true, doc }
  }

  /** 删除手册：先摘列表再删文件，文件删不掉也不影响列表已经干净 */
  async function removeDocument(id) {
    const doc = documents.value.find(d => d.id === id)
    if (!doc) return false
    documents.value = documents.value.filter(d => d.id !== id)
    if (doc.filePath) await docFileStore.remove(doc.filePath, doc.fileName)
    addLog({
      content: `删除手册「${doc.title}」`,
      source: '手册库',
      type: 'warning',
      tagType: 'warning'
    }, { silent: true })
    persistAll()
    return true
  }

  /** 用系统阅读器 / 新窗口打开文档原文 */
  async function openDocument(doc) {
    if (!doc || !doc.filePath) return false
    return docFileStore.open(doc.filePath, doc.fileName)
  }

  return { addDocument, removeDocument, openDocument }
}
