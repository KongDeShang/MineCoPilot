const { contextBridge, ipcRenderer } = require('electron')

/**
 * 渲染进程唯一可用的原生能力入口。
 * 只暴露白名单方法，不透传 ipcRenderer，保持 contextIsolation 的安全边界。
 */
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  isElectron: true,

  // 本地数据库文件读写（数据不出设备）
  db: {
    read: () => ipcRenderer.invoke('db:read'),
    write: (arrayBuffer) => ipcRenderer.invoke('db:write', arrayBuffer),
    clear: () => ipcRenderer.invoke('db:clear'),
    info: () => ipcRenderer.invoke('db:info')
  },

  // 应用信息
  app: {
    version: () => ipcRenderer.invoke('app:version'),
    userDataPath: () => ipcRenderer.invoke('app:userDataPath'),
    // ⚠️ 仅允许打开 documents/ 目录内的文件（主进程做边界校验，传越界路径会被拒）
    openPath: (p) => ipcRenderer.invoke('app:openPath', p)
  },

  // 数据备份与迁移（一键换机）
  backup: {
    export: (payload) => ipcRenderer.invoke('backup:export', payload),
    import: () => ipcRenderer.invoke('backup:import'),
    // 导入前的自动备份：静默写入 userData/backups/，不弹框
    autoBackup: (payload) => ipcRenderer.invoke('backup:auto-backup', payload)
  },

  // 文档资料库（文件只在本机 documents/ 目录内读写）
  docs: {
    addFile: (payload) => ipcRenderer.invoke('docs:addFile', payload),
    open: (payload) => ipcRenderer.invoke('docs:open', payload),
    deleteFile: (payload) => ipcRenderer.invoke('docs:delete', payload),
    // 随包示例手册：由主进程从 resources/manuals 复制进 documents/ 后再读
    importBundled: (payload) => ipcRenderer.invoke('docs:importBundled', payload),
    // 备份/恢复用：读取或还原 documents/ 目录全部文件
    readAll: () => ipcRenderer.invoke('docs:readAll'),
    restoreAll: (payload) => ipcRenderer.invoke('docs:restoreAll', payload)
  },

  // 本地模型引擎（node-llama-cpp，仅 Electron 模式可用）
  llm: {
    status: () => ipcRenderer.invoke('llm:status'),
    load: () => ipcRenderer.invoke('llm:load'),
    generate: (prompt) => ipcRenderer.invoke('llm:generate', { prompt }),
    cancel: () => ipcRenderer.invoke('llm:cancel'),
    listModels: () => ipcRenderer.invoke('llm:listModels'),
    switchModel: (id) => ipcRenderer.invoke('llm:switchModel', id),
    onProgress: (cb) => {
      const listener = (_event, payload) => cb(payload)
      ipcRenderer.on('llm:progress', listener)
      return () => ipcRenderer.removeListener('llm:progress', listener)
    },
    onDone: (cb) => {
      const listener = (_event, payload) => cb(payload)
      ipcRenderer.on('llm:done', listener)
      return () => ipcRenderer.removeListener('llm:done', listener)
    }
  },

  // 模型云端分发（任务 07：清单/下载/删除/进度）
  models: {
    list: () => ipcRenderer.invoke('models:list'),
    download: (id) => ipcRenderer.invoke('models:download', { id }),
    delete: (id) => ipcRenderer.invoke('models:delete', { id }),
    onProgress: (cb) => {
      const listener = (_event, payload) => cb(payload)
      ipcRenderer.on('models:progress', listener)
      return () => ipcRenderer.removeListener('models:progress', listener)
    }
  }
})
