const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const { registerLlmIpc, runSelfVerify } = require('./llmEngine')
const { registerModelsIpc } = require('./modelManager')

let mainWindow

// ── CSP 策略常量 ──────────────────────────────────────────────────────────────
// 生产（file://）使用严格策略；开发（http://localhost:5173）放行 Vite HMR 所需的 ws/inline。
// script-src 含 'wasm-unsafe-eval'：sql.js 纯 JS 版通过 new Function() 加载 WASM；
// 若未来切换为 WebAssembly.instantiate 路径，可改回 'self'。
const CSP_PROD = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

const CSP_DEV = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self'",
  "connect-src 'self' ws: http://localhost:5173",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

const DB_FILE_NAME = 'kuangshan-zhigong.db'

/** 本地数据库文件路径（放在 userData 目录，卸载应用不误删用户数据） */
function dbPath() {
  return path.join(app.getPath('userData'), DB_FILE_NAME)
}

function registerIpc() {
  // ── IPC 来源校验 ──────────────────────────────────────────────────────────
  // 所有 handler 首行调用 assertTrusted(event)，非可信页面直接拒绝。
  // 渲染层有用户可写内容（知识库/工单描述/文档文本），若出现 XSS 且无来源校验，
  // 注入脚本可调用 preload 暴露的全部能力（db:clear / docs:delete / app:openPath 等）。
  const assertTrusted = (event) => {
    const url = event.senderFrame?.url || event.sender.getURL()
    const ok = app.isPackaged
      ? url.startsWith('file://')
      : url.startsWith('http://localhost:5173')
    if (!ok) throw new Error('拒绝来自不可信来源的 IPC 调用')
  }

  // 本地模型引擎（node-llama-cpp，仅主进程）
  registerLlmIpc({ ipcMain })

  // 模型云端分发（清单/下载/删除/进度）
  registerModelsIpc({ ipcMain, assertTrusted })

  // ── 路径边界工具（app:openPath / docs:* 共用）───────────────────────────────
  const DOCS_DIR = () => path.join(app.getPath('userData'), 'documents')

  /**
   * 把外部传入的路径解析为绝对路径，并确认它确实落在 documents/ 之内。
   * 越界返回 null，调用方一律拒绝。
   *
   * 为什么不能只用 startsWith(DOCS_DIR())：
   *   DOCS_DIR() 结尾没有路径分隔符，于是两种越界都能"通过"前缀检查 ——
   *     1) documents\..\..\重要文件.txt   （.. 让真实路径跑出目录）
   *     2) documents2\secret.txt          （兄弟目录共享前缀）
   *   path.resolve 会消解 ..，再按 "root + 分隔符" 比对前缀，两条都被挡住。
   */
  const resolveInDocs = (p) => {
    const root = path.resolve(DOCS_DIR())
    const target = path.resolve(String(p || ''))
    if (target === root || !target.startsWith(root + path.sep)) return null
    return target
  }

  // 读取数据库字节
  ipcMain.handle('db:read', async (event) => {
    assertTrusted(event)
    const file = dbPath()
    try {
      if (!fs.existsSync(file)) return null
      const buffer = await fs.promises.readFile(file)
      // 转成 ArrayBuffer 才能跨 IPC 结构化克隆传回渲染进程
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    } catch (error) {
      console.error('[IPC] 读取数据库失败：', error)
      return null
    }
  })

  // 写入数据库字节（先写临时文件再改名，避免写入中途崩溃损坏数据）
  ipcMain.handle('db:write', async (event, arrayBuffer) => {
    assertTrusted(event)
    const file = dbPath()
    const tmp = `${file}.tmp`
    try {
      const buffer = Buffer.from(arrayBuffer)
      await fs.promises.writeFile(tmp, buffer)
      await fs.promises.rename(tmp, file)
      return { ok: true, bytes: buffer.length }
    } catch (error) {
      console.error('[IPC] 写入数据库失败：', error)
      try { if (fs.existsSync(tmp)) await fs.promises.unlink(tmp) } catch { /* 清理失败可忽略 */ }
      return { ok: false, error: error.message }
    }
  })

  // 清空数据库文件
  ipcMain.handle('db:clear', async (event) => {
    assertTrusted(event)
    try {
      const file = dbPath()
      if (fs.existsSync(file)) await fs.promises.unlink(file)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  })

  ipcMain.handle('db:info', async (event) => {
    assertTrusted(event)
    const file = dbPath()
    try {
      const stat = fs.existsSync(file) ? await fs.promises.stat(file) : null
      return { path: file, exists: !!stat, size: stat ? stat.size : 0 }
    } catch (error) {
      return { path: file, exists: false, size: 0, error: error.message }
    }
  })

  ipcMain.handle('app:version', (event) => { assertTrusted(event); return app.getVersion() })
  ipcMain.handle('app:userDataPath', (event) => { assertTrusted(event); return app.getPath('userData') })
  ipcMain.handle('app:openPath', async (event, p) => {
    assertTrusted(event)
    const safe = resolveInDocs(p)
    if (!safe) return { ok: false, error: '拒绝打开资料库之外的文件' }
    try {
      const result = await shell.openPath(safe)
      return { ok: result === '', error: result || '' }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  })

  // ---------- 数据备份与迁移（一键换机） ----------
  // 导出：弹保存对话框，把备份 JSON 写入用户选择的位置
  ipcMain.handle('backup:export', async (event, payload) => {
    assertTrusted(event)
    const content = payload && payload.content
    // 本地日期，不用 toISOString（会转 UTC，东八区早 8 点前会写成前一天）
    const d = new Date()
    const localDay = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const defaultName = (payload && payload.defaultName) || `矿山智工备份_${localDay}.mbak`
    if (typeof content !== 'string') return { ok: false, error: '备份内容为空' }
    try {
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: '导出数据备份',
        defaultPath: defaultName,
        filters: [{ name: '矿山智工备份', extensions: ['mbak'] }, { name: '所有文件', extensions: ['*'] }]
      })
      if (canceled || !filePath) return { ok: false, canceled: true }
      await fs.promises.writeFile(filePath, content, 'utf8')
      return { ok: true, path: filePath }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  })

  // 导入：弹打开对话框，读取备份文件内容返回给渲染进程
  ipcMain.handle('backup:import', async (event) => {
    assertTrusted(event)
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        title: '选择备份文件',
        properties: ['openFile'],
        filters: [{ name: '矿山智工备份', extensions: ['mbak'] }, { name: '所有文件', extensions: ['*'] }]
      })
      if (canceled || !filePaths || !filePaths.length) return { ok: false, canceled: true }
      const filePath = filePaths[0]
      const content = await fs.promises.readFile(filePath, 'utf8')
      return { ok: true, path: filePath, content }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  })

  // ---------- 文档资料库：文件只存在本机 documents/ 目录 ----------
  // DOCS_DIR / resolveInDocs 定义见 registerIpc() 顶部（app:openPath 也要用）

  // 保存文档文件（文件名做安全清洗，禁止路径穿越）
  ipcMain.handle('docs:addFile', async (event, payload) => {
    assertTrusted(event)
    try {
      const dir = DOCS_DIR()
      await fs.promises.mkdir(dir, { recursive: true })
      const safeName = String(payload && payload.fileName || 'unnamed.pdf')
        .split(/[\\/]/).pop()
        .replace(/[^\w.\-\u4e00-\u9fa5]/g, '_')
        .slice(0, 80)
      const target = path.join(dir, `${Date.now()}-${safeName}`)
      const buffer = Buffer.from(payload && payload.data)
      await fs.promises.writeFile(target, buffer)
      return { ok: true, path: target, size: buffer.length }
    } catch (error) {
      console.error('[IPC] 保存文档失败：', error)
      return { ok: false, error: error.message }
    }
  })

  // 用系统默认阅读器打开文档（只允许打开 documents/ 目录内的文件）
  ipcMain.handle('docs:open', async (event, payload) => {
    assertTrusted(event)
    const p = resolveInDocs(payload && payload.path)
    if (!p) return { ok: false, error: '拒绝打开资料库之外的文件' }
    if (!fs.existsSync(p)) return { ok: false, error: '文件不存在（可能已被移动或删除）' }
    const err = await shell.openPath(p)
    return err ? { ok: false, error: err } : { ok: true }
  })

  // 删除文档文件（同样限制在 documents/ 目录内）
  ipcMain.handle('docs:delete', async (event, payload) => {
    assertTrusted(event)
    const p = resolveInDocs(payload && payload.path)
    if (!p) return { ok: false, error: '拒绝删除资料库之外的文件' }
    try {
      await fs.promises.unlink(p)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  })

  // 随包示例手册目录：开发时是仓库里的 public/manuals，安装后是 resources/manuals。
  // 打包后不能用 asar 里的路径——shell.openPath 打不开 asar 内的文件，
  // 所以由 electron-builder 的 extraResources 把它复制到 resources/ 下再读。
  const BUNDLED_DIR = () => (app.isPackaged
    ? path.join(process.resourcesPath, 'manuals')
    : path.join(__dirname, '..', 'renderer', 'public', 'manuals'))

  /**
   * 把随包示例手册导入资料库（返回文件路径 + 已抽好的文字层）
   *
   * 为什么必须由主进程来做：资料库只认 DOCS_DIR（userData/documents）里的文件，
   * docs:open / docs:delete 都按这个边界校验。渲染进程既拿不到 resources 路径，
   * 也无权往 documents/ 里写文件，所以复制这一步只能在主进程完成。
   *
   * 目标文件名固定为 bundled-<slug>.pdf，不含时间戳：
   * 重复导入落到同一个路径上，天然幂等，不会每启动一次就堆一份副本。
   * 但尺寸不同就覆盖——换版本时随包的是另一份手册，别让旧副本留在磁盘上。
   */
  ipcMain.handle('docs:importBundled', async (event, payload) => {
    assertTrusted(event)
    const slug = String((payload && payload.slug) || '')
    // slug 会被拼进文件路径，只放行小写字母/数字/连字符，挡住路径穿越
    if (!/^[a-z0-9-]{1,64}$/.test(slug)) return { ok: false, error: '非法的随包手册标识' }
    const source = path.join(BUNDLED_DIR(), `${slug}.pdf`)
    const textSource = path.join(BUNDLED_DIR(), `${slug}.json`)
    try {
      if (!fs.existsSync(source)) return { ok: false, error: `随包手册缺失：${slug}.pdf` }
      const dir = DOCS_DIR()
      await fs.promises.mkdir(dir, { recursive: true })
      const target = path.join(dir, `bundled-${slug}.pdf`)
      const sameSize = fs.existsSync(target) && fs.statSync(target).size === fs.statSync(source).size
      if (!sameSize) await fs.promises.copyFile(source, target)
      const stat = await fs.promises.stat(target)
      const text = fs.existsSync(textSource) ? await fs.promises.readFile(textSource, 'utf8') : ''
      return { ok: true, path: target, size: stat.size, text }
    } catch (error) {
      console.error('[IPC] 导入随包手册失败：', error)
      return { ok: false, error: error.message }
    }
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 800,
    title: '矿山智工 - 工程机械运维AI工作台',
    backgroundColor: '#f5f7fa',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 渲染进程只通过 preload 白名单调用原生能力，preload 本身只用
      // contextBridge / ipcRenderer / process.platform —— 都在沙箱 preload 的允许集内，
      // 开启后 preload 无需任何改动，但"渲染层被注入 → 直接拿到 Node 能力"这条路被切断。
      sandbox: true
    }
  })

  // ── CSP：通过响应头注入（比 meta 标签更可靠，file:// 下也生效）────────────
  // 同时在 index.html 放了 meta 兜底——两处策略一致，任一生效即保底。
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [app.isPackaged ? CSP_PROD : CSP_DEV]
      }
    })
  })

  // 首屏渲染完成再显示，避免白屏闪烁
  mainWindow.once('ready-to-show', () => mainWindow.show())

  // 外部链接交给系统浏览器，不在应用内打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'))
  } else {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()

  // 本地模型健康自检：环境变量触发（安装后首次启动 / 自动化验收用）
  if (process.env.KUANGSHAN_LLM_VERIFY === '1') {
    runSelfVerify().then((r) => {
      console.log('[LLM-VERIFY]', JSON.stringify(r))
      if (process.env.KUANGSHAN_LLM_VERIFY_EXIT === '1') {
        setTimeout(() => app.quit(), 500)
      }
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
