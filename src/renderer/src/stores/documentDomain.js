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
import { BUNDLED_DOCS } from '../utils/bundledDocs'
import { docFileStore } from '../utils/docFileStore'

/**
 * docService 只在"真的要解析一份文件"时才加载。
 *
 * 它原本是模块顶部的静态 import，而本模块经 appStore 被 main.js 引用，
 * 于是 pdfjs 主库（pdf.min.mjs 约 448 KB）被打进 index 主 chunk ——
 * **每次启动都要解析它**，而绝大多数会话根本不会添加手册。
 * 随包手册的文字层是构建期抽好的，也不走这条路径（见 seedBundledDocuments），
 * 所以这里改成按需动态导入，主 chunk 少掉这一整块。
 */
async function loadDocService() {
  const mod = await import('../utils/docService')
  return mod.parse
}

export function createDocumentDomain(ctx) {
  const { documents, persistAll, addLog } = ctx

  /**
   * 入库时保留的文字层上限（够问答检索，又不至于把整库撑大）
   *
   * ⚠️ 这个上限**必须与检索口径一致**。曾经它被写成 300，而 appStore 的检索池
   * 另写了一个 `slice(0, 120)` —— 于是超过 120 页的手册，第 121 页起的正文
   * 在 AI 问答里永久检索不到，而界面照旧按 PDF 总页数显示"可问答（N 页）"，
   * 用户无从察觉（随包 3 本手册是 36/32/18 页，正好演示不出来）。
   * 现在检索池取全量已存切片，截断与否由下面的 readinessOf 如实标注。
   */
  const CHUNK_LIMIT = 300

  /**
   * 由文字层判定"可问答 / 仅查看"
   *
   * 抽不到文字层不算失败：扫描件照样收下，只是降级为"仅查看"，
   * 界面上如实写明，不硬撑成"可问答"。手工添加与随包示例共用这一套判定，
   * 免得两处对"什么算可问答"给出不同答案。
   *
   * @param {Array} chunks 抽取到的逐页文字层（一页一片）
   * @returns {{status:string, note:string, total:number, indexed:number, truncated:boolean}}
   *   total     —— 抽取到的切片总数（截断前）
   *   indexed   —— 实际可被 AI 检索的页数（= 入库保留的切片数）
   *   truncated —— 是否被 CHUNK_LIMIT 截断
   */
  function readinessOf(chunks) {
    const total = Array.isArray(chunks) ? chunks.length : 0
    if (!total) {
      return {
        status: 'view_only',
        note: '未提取到文字层（扫描件），可打开查看原文，暂不能直接问答',
        total: 0,
        indexed: 0,
        truncated: false
      }
    }
    const indexed = Math.min(total, CHUNK_LIMIT)
    const truncated = total > CHUNK_LIMIT
    return {
      status: 'ready',
      total,
      indexed,
      truncated,
      // 截断一定要写进 note —— 界面按 note 渲染，不写就等于瞒着用户。
      // 注意这里报的是"可检索的页数"，不是 PDF 总页数：两者在被截断时并不相等。
      note: truncated
        ? `文字层共 ${total} 页，超出单份上限 ${CHUNK_LIMIT} 页 —— 仅前 ${indexed} 页可被 AI 检索，其余请在原文中查看`
        : ''
    }
  }

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

    // 2) 本地提取文本（无网络；扫描件/损坏文件降级为仅查看，不阻塞入库）
    //    docService 在这里才按需加载，见 loadDocService 的说明
    const parseDoc = await loadDocService()
    const parsed = await parseDoc(file)
    const chunks = parsed.ok ? parsed.chunks : []
    const readiness = readinessOf(chunks)
    const doc = {
      id: `doc-${Date.now()}`,
      title: title || file.name.replace(/\.pdf$/i, ''),
      docType,
      model,
      category,
      fileName: file.name,
      filePath: saved.path,
      fileSize: saved.size || file.size,
      pages: parsed.ok ? parsed.pages : 0,
      status: readiness.status,
      // 截断前的切片总数：光看 chunks.length 分不清"本来就这么长"与"被截了"
      chunkTotal: readiness.total,
      chunks: chunks.slice(0, CHUNK_LIMIT),
      note: readiness.note,
      addedAt: now()
    }
    documents.value = [doc, ...documents.value]
    addLog({
      // 日志里报"可问答 N 页"而不是 PDF 总页数：被截断时两者不相等，
      // 按总页数记会让操作日志本身成为不实记录。
      content: `添加手册「${doc.title}」${doc.status === 'ready' ? `（可问答 ${readiness.indexed} 页）` : '（扫描件，仅查看）'}`,
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

  /**
   * 随包示例手册入库（幂等，只补缺的那几份）
   *
   * 为什么要有它：手册库空着时，第一眼像是"这个模块还没做"。演示数据能造设备台账、
   * 能造工单，唯独造不出真手册——手册必须是真的 PDF，所以只能随包发。
   *
   * 幂等按 id 判、不按文件名判：用户删掉某一本之后不会再被塞回来。
   * "删了还要不要重新给"由 appStore 的记忆标记决定（见 ensureBundledDocuments），
   * 这里只负责补齐当前列表里缺的那些。
   *
   * 单份导入失败只跳过、不中断：随包资源缺失是打包问题，
   * 不该让整个应用起不来；资源齐不齐由 self-check 单独盯着。
   */
  async function seedBundledDocuments() {
    const added = []
    for (const item of BUNDLED_DOCS) {
      if (documents.value.some(d => d.id === item.id)) continue
      const imported = await docFileStore.importBundled(item.slug)
      if (!imported.ok) {
        console.warn(`[手册库] 随包示例「${item.title}」导入失败：${imported.error}`)
        continue
      }
      const readiness = readinessOf(imported.chunks)
      documents.value = [{
        id: item.id,
        title: item.title,
        docType: item.docType,
        model: item.model,
        category: item.category,
        fileName: `${item.slug}.pdf`,
        filePath: imported.path,
        fileSize: imported.size,
        pages: imported.pages,
        status: readiness.status,
        chunkTotal: readiness.total,
        chunks: imported.chunks.slice(0, CHUNK_LIMIT),
        note: readiness.note,
        addedAt: now()
      }, ...documents.value]
      added.push(item.title)
    }
    if (added.length) {
      addLog({
        content: `随包示例手册就位 ${added.length} 份（${added.join('、')}）`,
        source: '手册库',
        type: 'success',
        tagType: 'success'
      }, { silent: true })
      persistAll()
    }
    return added
  }

  return { addDocument, removeDocument, openDocument, seedBundledDocuments }
}
