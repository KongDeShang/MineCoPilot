/**
 * 矿山智工 - 确认框的收尾统一封装
 *
 * 为什么需要它：
 *   `ElMessageBox.confirm(...).then(业务体).catch(() => {})` 这个写法全仓出现过四五次。
 *   空 catch 的本意是"用户点了取消，什么都不做" —— Element Plus 确实用
 *   reject('cancel'/'close') 表达取消，所以它看起来无害。问题在于它**同时**
 *   吞掉了 `.then()` 业务体里抛出的异常。
 *
 *   而 store 层对这件事的立场是明确的：落盘失败必须抛错、界面必须说"保存失败"
 *   （见 utils/database.js 里 persist 的长注释、App.vue 里 dbError 的提示）。
 *   但异常走到这几处就被一个空 catch 接走了 —— 用户看到的是
 *   "点了删除，什么也没发生"：既没有失败提示，也没有成功提示。
 *   这正是 store 层极力避免的那类静默，只是漏在了 UI 层。
 *
 * 于是把两类彻底分开，且只在这一处分开：
 *   · 取消（'cancel' / 'close'）—— 是用户意图，静默返回 false，不报错。
 *   · 其它 —— 真异常：ElMessage.error 报出来 + console.error 留下堆栈。
 *
 * 顺带把手写的回调链换成 async/await：业务体里再有人写 `.then()`，
 * 它的异常也只会落到下面第二个 try 里，不会被当成"用户取消"。
 */
import { ElMessage } from 'element-plus'

/** Element Plus 用这两个字符串表达"用户自己关掉了对话框"（取消 / ESC / 右上角 X） */
function isCancel(reason) {
  return reason === 'cancel' || reason === 'close'
}

/** 取一句能给人看的错误文案。error 可能是任何东西，读取本身也可能抛错 */
function errText(error) {
  if (error == null) return '未知错误'
  if (typeof error === 'string') return error
  try {
    return error.message || String(error)
  } catch {
    return '未知错误'
  }
}

/**
 * 等用户确认 → 执行动作 → 失败必报
 *
 * @param {Promise<unknown>} confirmPromise `ElMessageBox.confirm(...)` 的返回值
 *   （在调用本函数前就构造好，弹框即出现；本函数只负责收尾）
 * @param {() => unknown|Promise<unknown>} body 确认后要执行的动作
 * @param {{label?: string}} [opts] label 用于错误文案前缀，如"删除条目"
 * @returns {Promise<boolean>} 动作是否真的执行成功（取消 = false）
 */
export async function confirmAction(confirmPromise, body, { label = '操作' } = {}) {
  try {
    await confirmPromise
  } catch (reason) {
    if (!isCancel(reason)) {
      // 确认框本身的异常（极少见）：同样不能吞
      ElMessage.error(`${label}失败：${errText(reason)}`)
      console.error(`[确认框] ${label} 流程异常`, reason)
    }
    return false
  }

  try {
    await body()
    return true
  } catch (error) {
    ElMessage.error(`${label}失败：${errText(error)}`)
    console.error(`[确认框] ${label} 执行失败`, error)
    return false
  }
}
