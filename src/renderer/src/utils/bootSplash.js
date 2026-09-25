/**
 * 矿山智工 - 启动闪屏进度提示
 *
 * index.html 里有一份纯静态的启动闪屏（#boot-splash），
 * 在 Vue 挂载之前由它占位 —— 首启要播种演示数据 + 导入随包手册，
 * 这段时间此前界面一片空白，用户分不清是"在加载"还是"白屏卡死"。
 *
 * 本模块只做一件事：更新闪屏上的那行进度文字。
 * 挂载后 #app 内容被 Vue 整体替换，闪屏自然消失，无需手动清理。
 *
 * 注意：此文件会被 store-check 镜像到 Node 下执行，
 * 所以所有 DOM 访问都必须带 typeof 守卫。
 */
export function bootStep(text) {
  if (typeof document === 'undefined') return
  const el = document.getElementById('boot-splash-text')
  if (el) el.textContent = String(text || '')
}
