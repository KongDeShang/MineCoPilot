/**
 * 开发服务器自启（e2e / e2e-nl 共用）
 *
 * 为什么需要：
 *   验收脚本原本要求"先开一个终端跑 npm run dev"，于是 `npm run verify` 永远跑不到底
 *   ——前面的 self-check/build 都过了，最后两步因为没服务器直接 exit 2。
 *   一个"一键验收"命令却在最后一步要求人工开终端，等于没有验收。
 *
 * 行为：
 *   · 外部已经起着开发服务器 → 直接复用，不动它（跑完也不会去杀别人的进程）
 *   · 没起 → 自己拉一个，返回句柄；调用方在 shutdown 里 kill 掉
 *   · 起着但**被 HMR 污染** → 不在它上面跑，另找一个空端口自起干净的（resolveCleanBase）
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 轮询直到服务器响应（或超时） */
async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' })
      if (res.ok) return true
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 400))
  }
  return false
}

/**
 * 确保 BASE 可达。
 * @returns {Promise<import('node:child_process').ChildProcess|null>}
 *          自启的进程句柄；复用了外部服务器时返回 null。
 */
export async function ensureServer(base) {
  if (await waitForServer(base, 3000)) return null

  // 端口从 BASE 推导，这样 E2E_BASE_URL 指到别的端口时自启的服务器也在同一个端口上
  const port = String(new URL(base).port || '5173')
  console.info(`[验收] ${base} 不可达，自动启动开发服务器（端口 ${port}）…`)
  const dev = spawn(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', port], {
    cwd: ROOT,
    stdio: 'ignore',
    detached: false
  })

  if (!(await waitForServer(base, 60000))) {
    try { dev.kill() } catch { /* 已退出 */ }
    console.error(`❌ 自动启动开发服务器失败：${base}`)
    console.error('   可手动执行 npm run dev 后重试，或用 E2E_BASE_URL 指向已有服务。')
    process.exit(2)
  }
  return dev
}

/**
 * 体检：这个服务器会不会让"页面里的模块"与"脚本 import 的模块"变成各一份？
 *
 * 背景（P4-3 排查了两轮才定位到）：
 *   Vite 在被改过的模块**被谁引用**这件事上会留下痕迹 —— 引用方的转换结果里，
 *   说明符变成 `utils/database.js?t=1790496244236`。于是同一个页面里同时活着两份实例：
 *     · 带 `?t=` 的那份：应用真正在跑的（initDatabase 也 init 在这份上）
 *     · 裸路径那份：验收脚本 `import('/src/utils/database.js')` 拿到的
 *   裸路径那份的模块级 `db` 永远是 null。两种后果，后一种才是真正要防的：
 *     · 读台账直接抛「数据库未初始化」——很吵，但至少当场看得见（P4-3 就死在这里）；
 *     · 「锁屏时 isReady 必须是 false」这类断言成了**空断言** —— 一份从没 init 过的
 *       副本必然给 false，用例照样绿。"断言到底测的是哪一份"不确认，绿就不算数。
 *
 * 判据取 appStore.js 的转换结果：应用启动必经它，且它引用 database.js。
 * 只看 `?t=` —— 那是"模块被 HMR 换过"唯一留下的痕迹。
 */
async function hmrPolluted(base) {
  try {
    const res = await fetch(new URL('/src/stores/appStore.js', base))
    if (!res.ok) return false
    return /utils\/database\.js\?t=\d+/.test(await res.text())
  } catch {
    // 体检本身失败不拦路：宁可照旧跑，也不要因为体检把验收卡死。
    return false
  }
}

/**
 * 定下这一轮验收要用的地址：干净就原样用它，被 HMR 污染就换一个端口自起一份干净的。
 *
 * 换端口而不是"报错让人重启"，是因为 devServer.mjs 存在的理由就是**一键验收** ——
 * 一个能被别人开着的旧服务器拖红的验收，等于又把锅甩回给了人。
 * 也不去动人家的服务器：外部起着就复用、绝不代杀，这条是原来就定下的。
 *
 * ⚠️ 注意：换了端口就是换了 origin，localStorage / IndexedDB 都是另一套。
 * 对本套用例反而是好事（每轮都是干净库）；但反过来，排查问题时要记得看的是新地址的日志。
 *
 * 顶层 await 调用（见三个调用脚本），所以 BASE 从这一行起就是最终地址。
 */
export async function resolveCleanBase(base) {
  if (!(await hmrPolluted(base))) return base

  const from = Number(new URL(base).port || 5173) + 1
  for (let port = from; port < from + 10; port++) {
    const candidate = new URL(base)
    candidate.port = String(port)
    // 探测不到 = 端口空着，可以起（能探到说明被别人占了，换下一个）
    if (await waitForServer(candidate.origin, 300)) continue
    console.info(`[验收] ${base} 的开发服务器已被 HMR 污染（页面里存在同名模块的两份实例），`)
    console.info(`[验收] 改在 ${candidate.origin} 自起一份干净的；结论不受影响，但排查问题要看这个地址。`)
    return candidate.origin
  }
  console.warn(`[验收] ${base} 已被 HMR 污染，附近又找不到空端口，仍按原地址继续。`)
  console.warn('[验收] 这一轮涉及模块内部状态的断言（数据库、应用锁）可能失真，别直接当结论。')
  return base
}

/**
 * 在页面脚本跑起来之前把「首启引导演示已看过」的标记种进 localStorage。
 *
 * 为什么每个套件都要种：引导演示现在会在**全新 profile 第一次打开时自动播放**，
 * 而 driver.js 的遮罩是**拦鼠标**的 —— e2e 的点击、对比度审计的取色、e2e:nl 的
 * 对话操作都会被它挡在外面。这些套件要验的是应用本体，不是那层引导。
 *
 * 注意方向：不是"引导演示打扰了测试"要藏起来，而是这几套用例的语义里
 * 「首启那一次」已经被播放过了。引导本身由 e2e.mjs 结尾的一组专门用例守着 ——
 * 它会先 `unseedTourSeen` 撤回这里的注入，再 removeItem + 刷新，所以两条互不干扰。
 *
 * `addScriptToEvaluateOnNewDocument` 对此后**每个**新文档都生效，
 * 所以要在第一次导航之前调用。
 *
 * @returns {Promise<string|undefined>} 注入句柄，交给 unseedTourSeen 撤回
 */
export async function seedTourSeen(session) {
  const r = await session.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try { localStorage.setItem('ks:tour-seen', '1') } catch { /* 隐私模式 */ }"
  })
  return r && r.identifier
}

/**
 * 撤回 seedTourSeen 注入的脚本。
 *
 * 为什么必须有这一个：注入是**对每个新文档**生效的，所以"removeItem 之后再刷新"
 * 根本回不到首启路径 —— 刷新时那段脚本又把标记种回去了，用例会永远看不到自动播放。
 * 想验首启的用例必须先把注入撤掉。
 */
export async function unseedTourSeen(session, identifier) {
  if (!identifier) return
  await session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier })
}

/** 收掉自启的服务器（复用了外部服务器时是 no-op） */
export function stopServer(dev) {
  try { dev?.kill() } catch { /* 已退出 */ }
}
