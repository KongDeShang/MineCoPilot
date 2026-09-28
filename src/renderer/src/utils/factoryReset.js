/**
 * 矿山智工 - 恢复到出厂设置
 *
 * ── 为什么要有它 ──────────────────────────────────────────────────────────
 * 「卸载重装」**不等于**从零：数据与锁设置都落在 userData 目录里，而卸载器刻意
 * 不删它（`src/main/index.js:48`：本地数据库放在 userData 目录，卸载应用不误删用户数据）。
 * 于是"把这台机器交出去之前清干净"这件事，只能由应用内这个入口来做。
 *
 * ── 与锁屏的「清空本机数据并解锁」是两件事，别合并 ────────────────────────
 * 那个是**自救**（`appLock.js` 的 RESCUE_KEYS）：只清"被这次清空真正作废"的键，
 * 刻意保留主题、导航钉住这类偏好 —— 目的是"让我进去"，不是"假装我是新用户"。
 * 这个**是出厂**：连偏好与首启标记一起清，目标是回到"刚装好、还没用过"的样子。
 *
 * 两者最大的那一处差别就是 `ks:lock-setup-seen`：自救保留它，出厂必须清掉它。
 * 少了它，重启后不会出现「首次使用 · 为本机设一把界面锁」那一屏 ——
 * 那正是用户报的「卸载重装并不是从零」的直接原因。**改这里之前先想清楚这句话。**
 */

import * as db from './database'
// 复用 storage.js 的判据，不各写一份：那两份（本文件 vs backup.js）一旦分家，
// 就会出现"提示说会清、实际没清"这类不对称。backup.js:66 已写明这条教训。
import { isElectron } from './storage'
// `lockNow()` 的语义正好是"只清本次会话、不动任何存储"，与这里第 ① 步同步要做的事一致
import { lockNow } from './appLock'

/**
 * 出厂重置的清空范围。**唯一真相源**。
 *
 * `label` 不只是给人看的：设置页确认框里那句枚举就是拿它拼出来的。
 * 于是"清单里有什么"与"确认框里承诺清什么"是同一份数据 ——
 * 从结构上不可能出现"文案少写一项、实际多清一项"这种事。
 *
 * 注意有**三个命名空间**：`ks:` 前缀的、无前缀的（`ai_chat_messages` /
 * `mining-nav-pinned`）、以及整个库字节的 `kuangshan-zhigong:database`。
 * 只按 `ks:` 前缀扫会漏掉后面两类，所以这里逐条列全，
 * 另外在 factoryReset() 里还有一道 `ks:` 前缀兜底扫（防将来新增的键忘了登记）。
 */
export const FACTORY_RESET_SCOPE = [
  { label: '应用锁与账户（含 PIN）', keys: ['ks:app-lock', 'ks:lock-setup-seen'] },
  { label: '口述录入的撤销栈', keys: ['ks:undo-stack'] },
  { label: 'AI 对话记录', keys: ['ai_chat_messages'] },
  {
    label: '界面偏好（主题、配色、老师傅模式、润色开关、排查思路表、侧栏钉住）',
    keys: ['ks:theme', 'ks:color', 'ks:master-mode', 'ks:narration-enabled', 'ks:troubleshoot-maps', 'mining-nav-pinned']
  },
  { label: '首启引导与模型向导标记', keys: ['ks:tour-seen', 'ks:wizard-dismissed'] },
  { label: '浏览器模式下的整库字节', keys: ['kuangshan-zhigong:database'] }
]

/** 上面那张表摊平出来的全部键（self-check 拿它跟源码里扫到的键对账） */
export const FACTORY_RESET_KEYS = FACTORY_RESET_SCOPE.flatMap(s => s.keys)

/** 浏览器模式（含 IndexedDB 降级路径）的三个库。Electron 下只有第三个真的存在 */
const IDB_NAMES = ['kuangshan-zhigong', 'kuangshan-docs', 'kuangshan-doc-cache']

/** 键名前缀：兜底扫用它，把"将来新增但忘了登记的键"也一并清掉 */
const KEY_PREFIX = 'ks:'

/**
 * 确认框里那句枚举文案。与 FACTORY_RESET_SCOPE 同源 ——
 * 调用方（设置页）不要自己再写一遍清单，那就成了第二个会漂的真相源。
 */
export function factoryResetSummary() {
  return FACTORY_RESET_SCOPE.map(s => s.label).join('、')
}

/**
 * 清掉一个 IndexedDB 库。
 *
 * `onblocked` 是必须处理的：还有连接没关（解析缓存随时可能在用）时，
 * `deleteDatabase` 会**一直挂着不回调** —— 这里不能死等，如实记一条就走。
 * 重载之后那个连接就没了，用户再点一次即可清掉，不必为它卡住整个重置流程。
 */
function deleteIndexedDb(name) {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      return resolve({ name, ok: true, skipped: '本环境没有 IndexedDB' })
    }
    let req
    try {
      req = indexedDB.deleteDatabase(name)
    } catch (error) {
      return resolve({ name, ok: false, error: (error && error.message) || '打开删除请求失败' })
    }
    req.onsuccess = () => resolve({ name, ok: true })
    req.onerror = () => resolve({ name, ok: false, error: (req.error && req.error.message) || '删除失败' })
    req.onblocked = () => resolve({ name, ok: false, error: '有连接正在使用，重载后可再清一次' })
  })
}

/**
 * 兜底：把带 `ks:` 前缀的键全扫一遍，清掉。
 *
 * ── 为什么必须特性探测 ────────────────────────────────────────────────────
 * `localStorage.key()` / `.length` 是 Storage 接口的成员，但测试桩与隐私模式下的
 * 实现不一定有（self-check 的桩就是个只有三个方法的 Map 包装）。直接调会抛
 * TypeError 而不是给出诊断 —— 所以先看有没有，没有就安静跳过：
 * 上面 FACTORY_RESET_KEYS 那张显式清单才是主路径，前缀扫只是防止将来漏登记。
 */
function sweepPrefixedKeys() {
  try {
    if (typeof localStorage.key !== 'function' || typeof localStorage.length !== 'number') return []
  } catch {
    return [] // 隐私模式下连读属性都可能抛
  }
  const victims = []
  try {
    // 倒着遍历：删除会让 length 缩短，正着走会跳项
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key && key.startsWith(KEY_PREFIX)) victims.push(key)
    }
    for (const key of victims) localStorage.removeItem(key)
  } catch {
    // 半路失败就算了：显式清单那一步已经执行过，能清的都清了
  }
  return victims
}

/**
 * 执行恢复出厂设置。
 *
 * 四步都要做，顺序不能反：
 *   ① 清 localStorage（显式清单 + `ks:` 前缀兜底）
 *   ② 清三个 IndexedDB 库（浏览器模式才有真库，Electron 下只有解析缓存）
 *   ③ 抹 userData 下的应用文件（**仅 Electron**；`models/` 主进程按设计保留）
 *   ④ 销毁本机数据库字节 —— 下次启动走首启分支，重新播种演示数据
 *
 * 第 ④ 步之所以放最后：前三步里任何一步失败都还能如实报出来，
 * 而库一销毁就没法回退了 —— 它是"不可撤销"这个性质真正落地的地方。
 *
 * @returns `{ ok, error?, removed?, failed?, kept? }`；失败一律带回原文，不静默
 */
export async function factoryReset() {
  // ① localStorage
  for (const key of FACTORY_RESET_KEYS) {
    try { localStorage.removeItem(key) } catch { /* 隐私模式下删不掉也不该阻断 */ }
  }
  sweepPrefixedKeys()
  /**
   * 会话（`unlockedAccountId`）只活在 appLock 模块的内存里，**清 localStorage 清不掉它**。
   * 不显式清的话，它会变成一个指向"已经不存在的账户"的悬空 id ——
   * 而 `createAccount` 里那句 `if (!unlockedAccountId)` 于是不再认下后来建的账户，
   * 界面会停在"本次运行没有身份"（日志里的操作人一栏全空）。`rescueAndUnlock` 就是
   * 为此显式置空的，这里同理。
   *
   * 借用 `lockNow()` 而不是往 appLock.js 里再加一个导出：它的语义恰好就是
   * "只清本次会话、不动任何存储"—— 存储这一步本函数自己已经在做了。
   * （这个缺陷最早是 self-check R 段的 lockNow 用例照出来的：那一条红得有道理。）
   */
  lockNow()

  // ② IndexedDB
  const idbResults = await Promise.all(IDB_NAMES.map(deleteIndexedDb))
  const idbFailed = idbResults.filter(r => !r.ok && !r.skipped)

  // ③ userData（只有 Electron 有这一层）
  let removed = []
  let failed = []
  let kept = []
  if (isElectron() && window.electronAPI.app && typeof window.electronAPI.app.factoryReset === 'function') {
    try {
      const r = await window.electronAPI.app.factoryReset()
      if (r && r.ok === false) {
        return { ok: false, error: `本机文件清除失败：${r.error || '主进程未说明原因'}` }
      }
      removed = (r && r.removed) || []
      failed = (r && r.failed) || []
      kept = (r && r.kept) || []
    } catch (error) {
      return { ok: false, error: `本机文件清除失败：${(error && error.message) || error}` }
    }
  }

  // ④ 库
  try {
    await db.destroyDatabase({ clearStorage: true })
  } catch (error) {
    return { ok: false, error: `本机数据库清除失败：${(error && error.message) || error}` }
  }

  return {
    ok: true,
    removed,
    failed,
    kept,
    idbFailed: idbFailed.map(r => `${r.name}:${r.error}`)
  }
}
