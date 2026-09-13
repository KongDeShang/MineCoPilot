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
    openPath: (p) => ipcRenderer.invoke('app:openPath', p),
    backup: {
      export: (payload) => ipcRenderer.invoke('backup:export', payload),
      import: () => ipcRenderer.invoke('backup:import')
    }
  },

  // 文档资料库（文件只在本机 documents/ 目录内读写）
  docs: {
    addFile: (payload) => ipcRenderer.invoke('docs:addFile', payload),
    open: (payload) => ipcRenderer.invoke('docs:open', payload),
    deleteFile: (payload) => ipcRenderer.invoke('docs:delete', payload)
  },

  // 本地模型引擎（node-llama-cpp，仅 Electron 模式可用）
  llm: {
    status: () => ipcRenderer.invoke('llm:status'),
    load: () => ipcRenderer.invoke('llm:load'),
    generate: (prompt) => ipcRenderer.invoke('llm:generate', { prompt }),
    cancel: () => ipcRenderer.invoke('llm:cancel'),
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
  }
})
