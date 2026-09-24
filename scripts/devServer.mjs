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
