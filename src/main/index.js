const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const { registerLlmIpc, runSelfVerify } = require('./llmEngine')

let mainWindow

const DB_FILE_NAME = 'kuangshan-zhigong.db'

/** 本地数据库文件路径（放在 userData 目录，卸载应用不误删用户数据） */
function dbPath() {
  return path.join(app.getPath('userData'), DB_FILE_NAME)
}

function registerIpc() {
  // 本地模型引擎（node-llama-cpp，仅主进程）
  registerLlmIpc({ ipcMain })

  // 读取数据库字节
  ipcMain.handle('db:read', async () => {
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
  ipcMain.handle('db:clear', async () => {
    try {
      const file = dbPath()
      if (fs.existsSync(file)) await fs.promises.unlink(file)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  })

  ipcMain.handle('db:info', async () => {
    const file = dbPath()
    try {
      const stat = fs.existsSync(file) ? await fs.promises.stat(file) : null
      return { path: file, exists: !!stat, size: stat ? stat.size : 0 }
    } catch (error) {
      return { path: file, exists: false, size: 0, error: error.message }
    }
  })

  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('app:userDataPath', () => app.getPath('userData'))
  ipcMain.handle('app:openPath', async (event, p) => {
    if (typeof p !== 'string' || !p) return { ok: false, error: '路径为空' }
    try {
      const result = await shell.openPath(p)
      return { ok: result === '', error: result || '' }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  })

  // ---------- 数据备份与迁移（一键换机） ----------
  // 导出：弹保存对话框，把备份 JSON 写入用户选择的位置
  ipcMain.handle('backup:export', async (event, payload) => {
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
  ipcMain.handle('backup:import', async () => {
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
  const DOCS_DIR = () => path.join(app.getPath('userData'), 'documents')

  // 保存文档文件（文件名做安全清洗，禁止路径穿越）
  ipcMain.handle('docs:addFile', async (event, payload) => {
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
    const p = String(payload && payload.path || '')
    if (!p.startsWith(DOCS_DIR())) return { ok: false, error: '拒绝打开资料库之外的文件' }
    if (!fs.existsSync(p)) return { ok: false, error: '文件不存在（可能已被移动或删除）' }
    const err = await shell.openPath(p)
    return err ? { ok: false, error: err } : { ok: true }
  })

  // 删除文档文件（同样限制在 documents/ 目录内）
  ipcMain.handle('docs:delete', async (event, payload) => {
    const p = String(payload && payload.path || '')
    if (!p.startsWith(DOCS_DIR())) return { ok: false, error: '拒绝删除资料库之外的文件' }
    try {
      await fs.promises.unlink(p)
      return { ok: true }
    } catch (error) {
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
      sandbox: false
    }
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
