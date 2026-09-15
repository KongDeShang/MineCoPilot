/**
 * 矿山智工 - 渲染端模型分发客户端（任务 07）
 *
 * 统一封装 preload 的 models 桥：
 *   · Electron 模式：走 window.electronAPI.models（主进程 modelManager）
 *   · 浏览器模式（vite dev / e2e）：无桥可用，统一降级（列表空 / 操作失败），
 *     界面显示"离线，仅显示已装模型"，不阻塞主流程。
 */

/** 当前环境是否有模型分发能力（仅 Electron 打包/开发模式） */
export function modelsAvailable() {
  return !!(
    typeof window !== 'undefined' &&
    window.electronAPI &&
    window.electronAPI.models
  )
}

/** 云端清单 + 本地安装状态合并列表 */
export async function modelsList() {
  if (!modelsAvailable()) return { ok: false, error: '浏览器模式无分发引擎', models: [], source: 'builtin' }
  try {
    return await window.electronAPI.models.list()
  } catch (err) {
    return { ok: false, error: err && err.message || String(err), models: [], source: 'builtin' }
  }
}

/** 触发下载（主进程推送 models:progress 进度） */
export async function modelsDownload(id) {
  if (!modelsAvailable()) return { ok: false, error: '浏览器模式无分发引擎' }
  try {
    return await window.electronAPI.models.download(id)
  } catch (err) {
    return { ok: false, error: err && err.message || String(err) }
  }
}

/** 删除已下载模型（释放空间） */
export async function modelsDelete(id) {
  if (!modelsAvailable()) return { ok: false, error: '浏览器模式无分发引擎' }
  try {
    return await window.electronAPI.models.delete(id)
  } catch (err) {
    return { ok: false, error: err && err.message || String(err) }
  }
}

/** 订阅下载进度：返回取消订阅函数 */
export function onModelsProgress(cb) {
  if (!modelsAvailable()) return () => {}
  return window.electronAPI.models.onProgress(cb)
}
