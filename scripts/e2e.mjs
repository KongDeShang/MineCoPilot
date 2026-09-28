/**
 * 矿山智工 - 端到端验收（无头浏览器 + CDP）
 *
 * 为什么需要它：16 条验收里有 7 条是 UI 交互，纯逻辑断言覆盖不到。
 * 历史战绩：这套方法在实际开发中抓出过 3 个真实缺陷，其中一个会让整个看板白屏
 * （Pinia 把 setup store 的 computed 解包，误用 .value 导致 undefined）。
 *
 * 用法：
 *   npm run e2e          （开发服务器没起就自动拉一个，跑完自动收掉）
 * 可选环境变量：E2E_BASE_URL（默认 http://localhost:5173）、E2E_CDP_PORT（默认 9222）
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureServer, resolveCleanBase, stopServer, seedFirstRun, unseedFirstRun } from './devServer.mjs'

// 顶层 await 定地址：外部那个开发服务器若已被 HMR 污染（页面里会出现同名模块的两份实例，
// 脚本按裸路径 import 拿到的是没 init 过的那份），就换端口自起一份干净的。详见 devServer.mjs。
const BASE = await resolveCleanBase(process.env.E2E_BASE_URL || 'http://localhost:5173')
const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9222)
const CDP = `http://127.0.0.1:${CDP_PORT}`

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter(Boolean)

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 240) })
  // 边跑边报（E2E_TRACE=1）：断言结果平时在末尾统一打印，
  // 中途一旦卡在传输超时上，整轮结果就全丢了、连"卡在哪一条"都不知道。
  // 跟踪模式只多打一行，不改任何判定。
  if (process.env.E2E_TRACE) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
}

/**
 * CDP 单条请求的传输层时限（毫秒）。
 *
 * 只约束"浏览器是否回话"，不参与任何断言的判定。实测有过一次
 * `Runtime.evaluate 超时` 让整条 verify 在此失败、原样重跑即全过 ——
 * 机器繁忙（冷启动播种 + 导入手册 + 同时开着浏览器）时 30s 偏紧。
 * 见 Session.send() 里的说明：只放宽时限，不做自动重试。
 */
const CDP_TIMEOUT_MS = 90000

function findBrowser() {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

async function waitForCDP(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`${CDP}/json/list`)).json()
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 400))
  }
  return null
}

/** 极简 CDP 客户端 */
class Session {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.exceptions = []
    this.consoleErrors = []
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
        return
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails
        this.exceptions.push(String(d.exception?.description || d.text).slice(0, 300))
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(
          msg.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300)
        )
      }
    }
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      /**
       * 传输层超时（CDP 没在时限内回话），**不是**断言失败。
       *
       * 为什么从 30s 放宽到 90s：实测遇到过一次 `Runtime.evaluate 超时` 让整条
       * `npm run verify` 在这一步失败，紧接着原样重跑就 102/102 全过 —— 机器忙
       * （同时开着浏览器、开发服务器、冷启动播种 60 台设备 + 导入 3 本手册）时，
       * 30s 对 `awaitPromise: true` 的求值偏紧。
       *
       * 一个会偶发失败的验收门禁比没有门禁更糟：它教人"重跑一次就好了"，
       * 于是真的失败也会被当成抖动忽略。所以这里只放宽**传输层**时限，
       * 不动任何断言的判定标准；而且**不做自动重试** —— 大量 `eval` 里带着
       * 点击、确认框操作等副作用，重试等于把副作用执行两遍。
       */
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`[传输超时 ${CDP_TIMEOUT_MS / 1000}s] ${method} 未响应（不是断言失败，多半是浏览器/机器繁忙）`))
        }
      }, CDP_TIMEOUT_MS)
    })
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    }
    return result.result.value
  }

  /** 绑定 this 的求值（避免把方法当回调传递时丢失 this） */
  evaluate(expression) {
    return this.eval(expression)
  }

  /** 求值取对象句柄（不取 value）。CDP 的 DOM 域命令要的是 objectId，`eval()` 拿不到 */
  async handle(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: false })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    }
    if (!result.result || !result.result.objectId) {
      throw new Error(`句柄求值没拿到对象：${expression}（多半是选择器没匹配到元素）`)
    }
    return result.result.objectId
  }

  /**
   * 把磁盘上的真实文件塞进 `<input type="file">`。
   *
   * 这是整套 e2e 里唯一能测"用户真的选了一个文件"的办法：`DOM.setFileInputFiles`
   * 走浏览器自己的文件选择通道，会照常派发 change，页面里 `file.text()` 读到的
   * 确实是磁盘上那份字节。手工 `new File()` + 派发 change 做不到这一点 ——
   * 那是合成事件，测不到"input 到底有没有被插进 DOM、accept 写对没有、
   * 取到内容之后走的是哪条分支"。
   */
  async setFileInputFiles(selector, files) {
    const objectId = await this.handle(`document.querySelector(${JSON.stringify(selector)})`)
    await this.send('DOM.setFileInputFiles', { files, objectId })
  }

  async goto(url, waitMs = 2600) {
    await this.send('Page.navigate', { url })
    await new Promise(r => setTimeout(r, waitMs))
  }
}

/** 在页面内注入一个提问助手：等待输入框出现后再输入并提交（避免时序问题） */
const ASK_HELPER = `
  window.__ask = async (question, waitMs = 6000) => {
    const deadline = Date.now() + waitMs
    let input = null
    while (Date.now() < deadline) {
      input = document.querySelector('.chat-input .el-input__inner') ||
              document.querySelector('.chat-input input') ||
              document.querySelector('.chat-input textarea')
      if (input) break
      await new Promise(r => setTimeout(r, 200))
    }
    if (!input) {
      return { error: '找不到聊天输入框', chatInputHtml: (document.querySelector('.chat-input') || {}).outerHTML || '(无 .chat-input)' }
    }
    const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(input, question)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 400))
    const send = Array.from(document.querySelectorAll('.chat-input button')).find(b => /提问|发送/.test(b.textContent))
    if (!send) return { error: '找不到发送按钮' }
    send.click()
    // 主答案走本地规则引擎即时给出，但上方还有逐字打字动画（约 200 字 × 18ms ≈ 3.6s）
    // 加思考步骤逐帧展示，等 9s 足够内容打完，避免断言读到未完成的半句
    await new Promise(r => setTimeout(r, 9000))
    const messages = Array.from(document.querySelectorAll('.message'))
    const last = messages[messages.length - 1]
    return {
      count: messages.length,
      text: last ? last.textContent.replace(/\\s+/g, ' ').slice(0, 400) : '',
      // 不截断的同一份文本。text 截到 400 字是为了断言失败时报得干净，
      // 但手册切片原文动辄两千字，要"回答里引的正文到底讲没讲这个词"
      // 就得看全文 —— 关键词可能落在 400 字之后。单独给一份，不动 text，
      // 免得影响已有断言的输出长度。
      full: last ? last.textContent.replace(/\\s+/g, ' ') : '',
      // refs 必须**只取最后一条消息的**。
      // 原先这里查的是整个 document：同一个会话里问过几个问题后，refs 会把
      // 前面每条消息的出处都累积进来，于是"这条回答引用第 N 页"的断言实际上
      // 读到的是**之前某个问题**引用过的页码 —— 断言比它的名字验证得少，
      // 而且看起来永远是绿的。text 取了 last，refs 没有，两处不一致。
      refs: last
        ? Array.from(last.querySelectorAll('.message-refs .ref-item')).map(e => e.textContent.trim())
        : []
    }
  };
  'helper-ready'
`

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * 应用锁那一段要往 Vue 受控输入框里塞值、按文字点按钮。
 *
 * 两类操作都走"原生 setter + 派发 input"与真实 click：
 * 直接改 `el.value` 不会触发 Vue 的 v-model（它监听的是 input 事件），
 * 而真实点击才会走到我们自己的 @click 处理里。
 * 页面每刷新一次就得重新注入一次 —— 注入的挂在 window 上，刷新就没了。
 */
const LOCK_HELPER = `
  window.__setInput = async (sel, value) => {
    const el = document.querySelector(sel)
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 150))
    return true
  };
  window.__clickText = (text) => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === text)
    if (!btn) return false
    btn.click()
    return true
  };
  // 解锁动作必须**不抛异常**：锁屏不在时返回一句原因，交给断言去报红。
  // 一开始这里写的是 document.querySelector('.lock-btn').click()，后果是
  // 变异验证时（把 PIN 校验改成永远通过 ⇒ 错 PIN 也进了主界面 ⇒ 后面再找锁屏就没了）
  // 整轮 e2e 被这一句中断、连已经收到的断言都打不出来 —— 只留一句 TypeError。
  window.__unlock = async (pin) => {
    if (!document.querySelector('input[placeholder^="PIN"]') || !document.querySelector('.lock-btn')) {
      // why 里带上现场：光说"锁屏不在"分不清是"页面还没换新（求值落在旧文档，
      // 那里本来就没有锁屏）"还是"换新了但没回锁定态（真缺陷）"。
      // 前者内容区会在、就绪态是 complete —— 2026-09-27 那次 14 条级联红就卡在这个分辨上。
      return {
        ok: false,
        why: '锁屏不在（没有 PIN 输入框或解锁按钮；内容区=' + !!document.querySelector('.app-main') +
          ' 就绪=' + document.readyState +
          ' 标题=' + ((document.querySelector('.lock-title') || {}).textContent || '(无)') + '）'
      }
    }
    await window.__setInput('input[placeholder^="PIN"]', pin)
    document.querySelector('.lock-btn').click()
    return { ok: true }
  };
  // 在设置页的「空闲自动锁」下拉里选一档（P4-2）。
  // 同样不抛异常：缺哪一环就返回哪一环的 why，交给断言去报红 ——
  // 这里要是写成裸 querySelector().click()，设置页还没渲染完就会
  // 把整轮 e2e 打断（和 __unlock 那次踩的是同一个坑）。
  window.__pickIdle = async (label) => {
    const sel = document.querySelector('.lock-idle .el-select')
    if (!sel) return { ok: false, why: '设置页没有「空闲自动锁」那一行' }
    ;(sel.querySelector('.el-select__wrapper') || sel).click()
    let item = null
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      item = Array.from(document.querySelectorAll('.el-select-dropdown__item'))
        .find(o => o.textContent.trim() === label)
      if (item) break
      await new Promise(r => setTimeout(r, 100))
    }
    if (!item) return { ok: false, why: '下拉里没有这一档：' + label }
    item.click()
    await new Promise(r => setTimeout(r, 600))
    return { ok: true, picked: label }
  };
  'lock-helper-ready'
`

/** 带标签的求值：出错时能立刻指出是哪个断言块挂了 */
async function safeEval(session, label, expression) {
  try {
    return await session.eval(expression)
  } catch (error) {
    // 带上 cause，报错堆栈里能同时看到原始异常（否则只剩一句 message）
    throw new Error(`断言块「${label}」执行失败：${error.message}`, { cause: error })
  }
}

/**
 * 重载页面，并且**等它真的落回到锁屏上**再返回（而不是睡够几秒就当它好了）。
 *
 * 为什么不能只 `sleep(3400)`：应用锁那几段后面的断言全都建立在"此刻页面已经换新、
 * 并且停在锁屏上"这个前提上，固定 sleep 只是赌一把。2026-09-27 升 1.2.0 后的首跑
 * 就赌输了 —— 冷着的开发服务器下，重载 3.4 秒后页面**还没换新**，求值落进旧文档
 * （旧文档本来就停在已解锁的设置页、没有锁屏），`__unlock` 拿到"锁屏不在"，
 * 其后 13 条断言连锁变红。而账户其实建好了、`ks:app-lock` 也在 localStorage 里
 * （`readConfig()` 是同步读 localStorage 的）—— 产品没毛病，是脚本自己没等。
 *
 * 判"已经是新文档"用的是重载前埋的 window 标记：旧文档里标记还在，新文档里必然没有。
 * 求值本身要 try 住 —— 换文档时执行上下文会被销毁、求值会抛，那是导航的正常现象，
 * 重试即可；而这一种时刻恰恰就是固定 sleep 挡不住的那种时刻。
 *
 * 等不到就返回 false，**不抛异常**：抛了会把整轮 e2e 打断、已收集的断言全丢
 * （这个坑本文件踩过三次），何况返回 false 之后下面那条断言会带着现场自己报红。
 */
async function waitForFreshDoc(session, selector, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const settled = await session.eval(
        `(!window.__e2eOldDoc) && !!document.querySelector(${JSON.stringify(selector)})`
      )
      if (settled) return true
    } catch { /* 换文档中：上下文销毁会让求值抛，继续等 */ }
    await sleep(250)
  }
  return false
}

/** 重载 + 等落定。拆成两个函数是为了能单独把"等"这一步拿去做负向对照（见 14c 那段）。 */
async function reloadUntil(session, selector, timeoutMs = 25000) {
  try {
    await session.eval('window.__e2eOldDoc = 1')
  } catch { /* 旧文档半死也不碍事：下面只要还看得见标记，就说明它还不是新文档 */ }
  await session.send('Page.reload', { ignoreCache: true })
  return waitForFreshDoc(session, selector, timeoutMs)
}

async function main() {
  const browser = findBrowser()
  if (!browser) {
    console.error('❌ 未找到 Chrome/Edge，可用环境变量 CHROME_PATH 指定路径')
    process.exit(2)
  }

  const devServer = await ensureServer(BASE)

  const profileDir = mkdtempSync(join(tmpdir(), 'kuangshan-e2e-'))
  console.info(`[e2e] 浏览器：${browser}`)
  const child = spawn(browser, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--window-size=1440,940',
    'about:blank'
  ], { stdio: 'ignore', detached: false })

  const shutdown = () => {
    try { child.kill() } catch { /* 已退出 */ }
    try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    stopServer(devServer)
  }

  try {
    const target = await waitForCDP()
    if (!target) throw new Error('无法连接无头浏览器（CDP 未就绪）')

    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
    const session = new Session(ws)
    await session.send('Runtime.enable')
    await session.send('Page.enable')
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 940, deviceScaleFactor: 1, mobile: false
    })
    // 首启那两屏都会挡在前面：引导演示自己弹出来、遮罩拦鼠标；「设置 PIN」那一屏
    // 更是整屏占住、主应用压根挂不上来。本套件里的合成点击倒是照样能过遮罩，
    // 但 12e（首启真的会自动播）和 16（首启设锁屏）要的正是**未播种**的状态，
    // 所以先种上，到那两处再撤回（见 unseedFirstRun）。
    const firstRunSeed = await seedFirstRun(session)

    // ---------- 0. 干净起点：清空本地库并重新加载（验证首启播种） ----------
    await session.goto(`${BASE}/#/dashboard`, 3500)

    // 逐项探测浏览器 API 可用性（不同 Chrome 版本/上下文下行为不同，先探再清）
    const apiProbe = await session.eval(`(() => {
      const out = {}
      try { out.hasLocalStorage = typeof localStorage !== 'undefined'; localStorage.setItem('__probe', '1'); localStorage.removeItem('__probe'); out.localStorageOk = true } catch (e) { out.localStorageOk = String(e && e.message || e) }
      try { out.hasIndexedDB = typeof indexedDB !== 'undefined' } catch (e) { out.hasIndexedDB = String(e && e.message || e) }
      try { out.hasDatabasesFn = !!(indexedDB && indexedDB.databases) } catch (e) { out.hasDatabasesFn = String(e && e.message || e) }
      try { out.hasIDBKeyRange = typeof IDBKeyRange !== 'undefined' } catch (e) { out.hasIDBKeyRange = String(e && e.message || e) }
      try { out.hasCaches = typeof caches !== 'undefined' } catch (e) { out.hasCaches = 'n/a' }
      return out
    })()`)
    console.info('[e2e] 浏览器 API 探测:', JSON.stringify(apiProbe))

    if (apiProbe.localStorageOk !== true) throw new Error(`localStorage 不可用：${apiProbe.localStorageOk}`)
    if (apiProbe.hasIndexedDB !== true) throw new Error(`IndexedDB 不可用：${apiProbe.hasIndexedDB}`)

    const cleared = await session.eval(`(async () => {
      localStorage.clear()
      const result = await new Promise((resolve) => {
        let done = false
        const finish = (v) => { if (!done) { done = true; resolve(v) } }
        try {
          const req = indexedDB.deleteDatabase('kuangshan-zhigong')
          req.onsuccess = () => finish('success')
          req.onerror = () => finish('error')
          req.onblocked = () => finish('blocked')
        } catch (e) { finish('throw:' + (e && e.message)) }
        setTimeout(() => finish('timeout'), 3000)
      })
      return result
    })()`)
    console.info(`[e2e] 清空本机数据：${cleared}`)
    // 特意在这里说一句：**从这里到结束都不会再有输出**（逐条打印要 `E2E_TRACE=1`，
    // 默认只在末尾统一汇总）。2026-09-27 做 P4-3 时就是照着"日志一直不动"把两轮
    // **正在正常运行**的 e2e 判成了卡死、中途杀掉，白丢两轮。要看它在不在跑，看
    // 浏览器那侧（`curl -s http://127.0.0.1:9222/json/list` 里页面 URL 在不在变），
    // 不是看这个日志。
    console.info('[e2e] 断言结果在结束时统一汇总，中途无输出属正常（要看逐条进度设 E2E_TRACE=1）')
    await session.send('Page.reload', { ignoreCache: true })
    await sleep(5500)

    // ---------- 0b. 首屏：裸地址（无 hash）必须落到工作台，不能是空白 ----------
    // 主进程就是无 hash 加载 dist/index.html，所以评委双击图标后走的正是这条路；
    // 而本文件其余断言全都是显式跳 `#/xxx` 的，**没有一条**走过裸地址。
    //
    // `/` 原先是落地页，该页已删除，现在由路由表末的 FALLBACK_ROUTE
    // （`/:pathMatch(.*)*` → /dashboard）接住。所以这里断言的是"首屏是看板"这个
    // **端到端结果**，而不是某一条具体路由：兜底指向哪儿、或者以后又加回一个 `/`
    // 的着陆页，都会在这里体现出来。
    // （我一度以为"少了 `/` 条目就会白屏"，实测是错的 —— 兜底会静默接住。）
    await session.goto(`${BASE}/`, 3500)
    const firstScreen = await session.eval(`(() => ({
      hash: location.hash,
      textLen: document.body.innerText.trim().length,
      hasStrip: !!document.querySelector('.status-strip'),
      blank: /No match found/i.test(document.body.innerText)
    }))()`)
    check('裸地址首屏被重定向到工作台（/ 在落地页删除后仍有归宿）',
      firstScreen.hash === '#/dashboard', firstScreen.hash || '(无 hash)')
    check('裸地址首屏不是空白页 / 无匹配页',
      firstScreen.textLen > 200 && firstScreen.hasStrip && !firstScreen.blank,
      `可见文本 ${firstScreen.textLen} 字 · 状态条 ${firstScreen.hasStrip} · 无匹配提示 ${firstScreen.blank}`)

    await session.goto(`${BASE}/#/dashboard`, 3000)

    // ---------- 1. 首启：数据库可用 + 60 台演示数据 ----------
    const boot = await safeEval(session, '首启看板', `(() => {
      const text = (sel) => {
        const el = document.querySelector(sel)
        return el ? el.textContent.trim() : null
      }
      return {
        storage: text('.storage-line'),
        statValues: Array.from(document.querySelectorAll('.stat-value')).map(e => e.textContent.trim()),
        stripValues: Array.from(document.querySelectorAll('.strip-txt')).map(e => e.textContent.replace(/\\s+/g, ' ').trim()),
        legend: Array.from(document.querySelectorAll('.legend-item')).map(e => e.textContent.replace(/\\s+/g, ' ').trim()),
        overdueItems: document.querySelectorAll('.overdue-item').length
      }
    })()`)
    check('页面渲染出本机存储状态', !!boot.storage, boot.storage)
    check('sql.js 真的跑起来了（不是内存模式降级）',
      boot.storage && !boot.storage.includes('内存模式'), boot.storage)
    check('台账规模为 60 台（验收 #2）',
      boot.statValues[0] === '60', boot.statValues.join(','))
    check('看板展示真实超期设备', boot.overdueItems > 0, `overdue=${boot.overdueItems}`)
    check('首屏信息条反映真实台账（处置台数/超期台数/停机损失）',
      boot.stripValues.some(v => /台需立即处置/.test(v)) && boot.stripValues.some(v => /台维保超期/.test(v)),
      boot.stripValues.join(' | '))

    // ---------- 1a. 界面上的版本号必须等于 package.json 里的版本号 ----------
    /**
     * 背景：左下角曾写死 `v1.0.0`，而 package.json 与安装包名是 1.1.0 ——
     * 评委装完 `矿山智工-1.1.0-setup.exe`，界面写着 v1.0.0。
     *
     * 为什么这条必须放在 e2e（而不是只靠 self-check）：self-check 查的是
     * "define 来自 pkg.version + 模板里没有字面量"（静态，读源码字符串），
     * 它**看不见浏览器里最终渲染出的那串字符**；`appVersion` 绑定写错名字、
     * define 没生效、注入值被别处覆盖，这三种都只有真渲染一次才知道。
     */
    const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
    const shownVersion = await session.eval(
      `(() => { const el = document.querySelector('.version'); return el ? el.textContent.trim() : null })()`)
    check('界面左下角的版本号与 package.json 一致（不是手写的旧版本）',
      shownVersion === `v${pkgVersion}`,
      `界面=${shownVersion || '(没找到 .version)'} · package.json=v${pkgVersion}`)

    // ---------- 1a2. 生产产物（dist/assets）里三处"只在打包版才成立"的写法 ----------
    /**
     * 这一条盯的是**构建产物**，既不是源码，也不是浏览器模式下的运行结果。
     * 三处都是 2026-09-26 修过的、且都属于"开发态/正常路径永远看不见"的类型：
     *   · 照片路径写成 `/equipment-photos/…`（根绝对）在打包版 `file://` 下解析到**盘符根**，
     *     照片全碎；而浏览器模式跑在 http://localhost:5173 下完全正常（P2-17）；
     *   · wasm 兜底写 `./assets/sql-wasm.wasm` 以 `dist/assets/` 为基准会解析成**双 assets**，
     *     而正常路径走主进程 IPC，兜底错了也没症状；
     *   · 版本号：`__APP_VERSION__` 必须在构建期被替换成 package.json 的值（define 写错了会漏出占位符）。
     *
     * 为什么放在 e2e 而不是新起一个脚本：链上 `build` 就在 `e2e` 前面，产物一定是最新的。
     * 而单独跑 `npm run e2e` 时 dist 可能是旧的或不存在 —— 那种情况只提示、不判失败
     * （判失败会把"只改了源码还没构建"误报成缺陷），全量 verify 里不会走到这个分支。
     */
    const distDir = new URL('../dist/assets/', import.meta.url)
    const distJs = existsSync(distDir)
      ? readdirSync(distDir).filter(f => f.endsWith('.js'))
      : []
    if (distJs.length === 0) {
      console.log('  （跳过产物断言：dist/assets 里没有产物 JS —— 单独跑 e2e 时正常，全量 verify 里不会发生）')
    } else {
      // 扫**全部**产物 chunk，不是只看入口：照片路径在 equipmentPhoto 那个 chunk、
      // 版本号在入口 chunk，谁被分到哪儿是打包器的自由，断言不该假设
      const js = distJs.map(f => readFileSync(new URL(f, distDir), 'utf8')).join('\n')
      const absPhoto = (js.match(/["'`]\/equipment-photos\//g) || []).length
      const relPhoto = (js.match(/["'`]\.\/equipment-photos\//g) || []).length
      check('产物里照片是相对路径（根绝对路径在 file:// 下会碎图，P2-17）',
        absPhoto === 0 && relPhoto > 0, `相对 ${relPhoto} 处 / 根绝对 ${absPhoto} 处`)
      const badWasm = (js.match(/["'`]\.\/assets\/sql-wasm\.wasm/g) || []).length
      const goodWasm = (js.match(/["'`]\.\/sql-wasm\.wasm/g) || []).length
      check('产物里 wasm 兜底不是双 assets（基准是 dist/assets/）',
        badWasm === 0 && goodWasm > 0, `对 ${goodWasm} 处 / 错 ${badWasm} 处`)
      // 压缩器会把字符串统一成反引号，三种引号都要认（只找双引号会假红）
      const verHit = new RegExp(`[\`"']${pkgVersion.replace(/\./g, '\\.')}[\`"']`).test(js)
      const placeholder = (js.match(/__APP_VERSION__|__SQLJS_WASM_URL__/g) || []).length
      check('产物里版本号已注入、define 占位符没有漏出来',
        verHit && placeholder === 0,
        `版本号 ${verHit ? '命中' : '没找到'} · 占位符 ${placeholder} 处`)
    }

    // ---------- 1b. 洞察卡的大数字必须停在真值上 ----------
    // 这里刻意不看"数字长什么样"，而是拿它跟**同一张卡自己带的算式**对账：
    // 可用率卡的 detail 是 "N / M 台运行中"，大数字就必须等于 N/M；
    // 维保执行率卡的 detail 是 "N / M 台维保未超期"，大数字就必须等于 N/M；
    // 故障集中度卡的 detail 是 "TOP3 占 A/B 次"，大数字就必须等于 A/B。
    //
    // 为什么必须自己算一遍：这三张卡的大数字走 tweenNumber 从 0 滚到真值，
    // 断言只读 textContent 的话，"停在中途的某个数字"和"停在真值"读起来都像
    // 一个合法的百分比 —— 曾经 tweenNumber 的时长被写成 800（单位是**秒**，
    // 见 utils/motion.js），动画要滚 13 分钟才到头，截图里三张卡停在 "3.0%"
    // 而真值是 88.3%，整条 verify 依旧全绿。
    const insight = await session.eval(`(() => ({
      values: Array.from(document.querySelectorAll('.insight-value')).map(e => e.textContent.trim()),
      details: Array.from(document.querySelectorAll('.insight-detail')).map(e => e.textContent.trim())
    }))()`)
    check('洞察卡渲染出百分比大数字',
      insight.values.length > 0 && insight.values.every(v => /^\d+(\.\d+)?%$/.test(v)),
      insight.values.join(' / '))

    const selfConsistent = []
    for (let i = 0; i < insight.values.length; i++) {
      const detail = insight.details[i] || ''
      // "53 / 60 台运行中" → 88.3%
      const run = detail.match(/(\d+)\s*\/\s*(\d+)\s*台运行中/)
      if (run) selfConsistent.push({
        label: '可用率', expect: (Number(run[1]) / Number(run[2]) * 100).toFixed(1) + '%',
        actual: insight.values[i], detail
      })
      // "TOP3 占 109/143 次" → 76.2%
      const conc = detail.match(/占\s*(\d+)\s*\/\s*(\d+)\s*次/)
      if (conc) selfConsistent.push({
        label: '故障集中度', expect: (Number(conc[1]) / Number(conc[2]) * 100).toFixed(1) + '%',
        actual: insight.values[i], detail
      })
      // "43 / 60 台维保未超期" → 71.7%
      const mnt = detail.match(/(\d+)\s*\/\s*(\d+)\s*台维保未超期/)
      if (mnt) selfConsistent.push({
        label: '维保执行率', expect: (Number(mnt[1]) / Number(mnt[2]) * 100).toFixed(1) + '%',
        actual: insight.values[i], detail
      })
    }
    // 要求**每张卡**都被验算到（=== 而不是 >=）：将来新加一张洞察卡，
    // 若它的大数字没有可对账的 detail 算式，这里就会失败，逼着人补上口径。
    check('洞察卡的大数字与它自己给出的算式一致（动画已停在真值，不是爬到一半）',
      selfConsistent.length === insight.values.length && selfConsistent.every(x => x.actual === x.expect),
      selfConsistent.map(x => `${x.label} 期望 ${x.expect} 实际 ${x.actual}（${x.detail}）`).join(' ｜ '))

    // 上面的对账只看数字，名字那半句漏掉了：故障集中度卡的 detail 形如
    // "TOP3 占 109/143 次 · 液压系统、动力系统、电气系统"。曾用 `f.name || f.equipmentName
    // || f.equipmentId` 去取名字，而这几个字段在 buildFaultStats 的 top 条目上都不存在，
    // 三处都取到 undefined，join('、') 拼出 "、、" —— 一个非空字符串，所以连 `|| '—'`
    // 兜底都不触发，卡面上就挂着两个孤零零的顿号。
    // 断言口径刻意不写死字段名，只要求"分隔符两侧必须有内容"：占位符空了就报错。
    const dangling = insight.details.filter(d => /^[、·]|[、·]\s*[、·]|[、·]\s*$/.test(d))
    check('洞察卡细节行没有空占位留下的孤立分隔符',
      insight.details.length > 0 && dangling.length === 0,
      dangling.length ? `孤立分隔符：${dangling.join(' ｜ ')}` : insight.details.join(' ｜ '))

    // ---------- 2. 持久化：刷新后数据不丢 ----------
    const persisted = await session.eval(`(async () => {
      const len = await new Promise((resolve, reject) => {
        const req = indexedDB.open('kuangshan-zhigong', 1)
        req.onsuccess = () => {
          const db = req.result
          if (!db.objectStoreNames.contains('kv')) return resolve(0)
          const get = db.transaction('kv', 'readonly').objectStore('kv').get('database')
          get.onsuccess = () => resolve(get.result ? get.result.length : 0)
          get.onerror = () => reject(get.error)
        }
        req.onerror = () => reject(req.error)
      })
      return { found: len > 0, bytes: len }
    })()`)
    check('数据落盘到本机 IndexedDB', persisted.found && persisted.bytes > 5000, JSON.stringify(persisted))

    await session.send('Page.reload', { ignoreCache: false })
    await sleep(4500)
    const afterReload = await session.eval(`Array.from(document.querySelectorAll('.stat-value')).map(e => e.textContent.trim()).join(',')`)
    check('刷新后台账规模不变（数据没丢）', afterReload === boot.statValues.join(','),
      `before=${boot.statValues.join(',')} after=${afterReload}`)

    // ---------- 3. 进化层卡片：复诊闭环 / 健康恶化 / 品牌分布 ----------
    const evolution = await session.eval(`(() => {
      const closing = document.querySelector('.closing-ring')
      return {
        closingRate: closing?.textContent.trim() || null,
        closingLine: document.querySelector('.closing-line')?.textContent.replace(/\\s+/g, ' ').trim() || null,
        recheckItems: document.querySelectorAll('.recheck-item').length,
        worsenItems: document.querySelectorAll('.worsen-item').length,
        worsenMeta: document.querySelector('.worsen-meta')?.textContent.trim() || null,
        brandRows: document.querySelectorAll('.brand-item').length,
        brandText: Array.from(document.querySelectorAll('.brand-item')).map(e => e.textContent.replace(/\\s+/g, ' ').trim())
      }
    })()`)
    check('看板出现复诊闭环率（验收 #10）', !!evolution.closingRate && /%/.test(evolution.closingRate),
      `${evolution.closingRate} | ${evolution.closingLine}`)
    check('存在待复诊工单并可操作', evolution.recheckItems > 0, `items=${evolution.recheckItems}`)
    check('看板出现健康恶化预警（验收 #6）',
      evolution.worsenItems > 0 && /下降/.test(evolution.worsenMeta || ''), evolution.worsenMeta)
    check('看板出现在管品牌分布（不挑品牌）',
      evolution.brandRows >= 2 && evolution.brandText.some(t => /徐工/.test(t)),
      evolution.brandText.join(' | '))

    // 复诊操作：点一次"标记复诊"，闭环率应变化
    const recheckFlow = await session.eval(`(async () => {
      const rateBefore = document.querySelector('.closing-ring')?.textContent.trim()
      const btn = Array.from(document.querySelectorAll('.recheck-item button')).find(b => /标记复诊/.test(b.textContent))
      if (!btn) return { ok: false, reason: '找不到标记复诊按钮' }
      btn.click()
      await new Promise(r => setTimeout(r, 1600))
      return {
        ok: true,
        rateBefore,
        rateAfter: document.querySelector('.closing-ring')?.textContent.trim(),
        pending: document.querySelectorAll('.recheck-item').length
      }
    })()`)
    check('复诊可标记且闭环率随之更新',
      recheckFlow.ok && recheckFlow.rateBefore !== recheckFlow.rateAfter,
      JSON.stringify(recheckFlow))

    // ---------- 4. 设备台账：健康分档 + 报告 ----------
    // 设备量 >50 时页面启用虚拟滚动：DOM 里只放可见的卡片，但**滚到底必须能看到最后一台**。
    // 这条断言不能写成 `cards >= 1 && cards <= 60` —— 12 张也能过，等于把"往下滚全是空白"
    // 当成预期（2026-09-25 修：占位用 padding 加在带 max-height 的滚动容器上，全局
    // box-sizing: border-box 让容器被 padding 撑成 4736px、max-height 形同虚设；同时
    // ResizeObserver 的 contentRect 不含 padding，量到的"可视高"是 0 ⇒ 只渲染 overscan 那 4 行）。
    await session.goto(`${BASE}/#/equipment`, 2600)
    const equipment = await session.eval(`(() => {
      const cards = Array.from(document.querySelectorAll('.equip-card'))
      const parseCount = (s) => parseInt(String(s || '').match(/\\d+/)?.[0] || '0', 10)
      const overview = Array.from(document.querySelectorAll('.health-item')).map(e => e.textContent.replace(/\\s+/g, ' ').trim())
      const overviewTotal = overview.reduce((sum, t) => sum + parseCount(t), 0)
      return {
        cards: cards.length,
        overview,
        overviewTotal,
        levels: cards.slice(0, 5).map(c => c.querySelector('.equip-level')?.textContent.replace(/\\s+/g, ' ').trim() || ''),
        reportButtons: cards.filter(c => Array.from(c.querySelectorAll('button')).some(b => /体检/.test(b.textContent))).length,
        // 照片要**真的解码出来**（naturalWidth > 0），不是"有个 <img> 就算"：
        // src 写错、文件不在、加载失败时 <img> 同样在 DOM 里，complete 也会是 true
        // —— 只有 naturalWidth 会把碎图暴露出来（见 utils/equipmentPhoto.js 的路径说明）。
        photos: cards.filter(c => {
          const img = c.querySelector('.equip-photo img')
          return !!img && /equipment-photos\\/.*\\.jpg/.test(img.getAttribute('src') || '') && img.naturalWidth > 0
        }).length,
        photoPaths: cards.map(c => c.querySelector('.equip-photo img')?.getAttribute('src') || '')
      }
    })()`)
    // 滚到底：虚拟滚动只该减少**同时存在**的卡片数，不该减少**够得着**的设备数。
    // 设备名形如「PC200 挖掘机-01」，按类别连号唯一，所以用名字去重即等于设备数。
    const vgridReach = await session.eval(`(async () => {
      const grid = document.querySelector('.equip-grid')
      if (!grid) return { ok: false, reason: '没有 .equip-grid' }
      const seen = new Set()
      const collect = () => {
        for (const n of grid.querySelectorAll('.equip-card .equip-name')) seen.add(n.textContent.trim())
      }
      const frame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 80)))
      collect()
      const firstScreen = grid.querySelectorAll('.equip-card').length
      // 一屏一屏往下翻（不能直接设 scrollTop = scrollHeight：那样只会看到首屏和末屏两段，
      // 中间的设备数不到，断言会以"可达不足"的形式误报）
      const step = Math.max(1, grid.clientHeight)
      for (let i = 0; i < 40; i++) {
        if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 2) break
        grid.scrollTop = Math.min(grid.scrollTop + step, grid.scrollHeight)
        await frame()
        collect()
      }
      // 滚到底后最后一张卡必须真的落在可视窗口里（占位与实际行高若错位，尾部会留下够不着的空白）
      const cards = grid.querySelectorAll('.equip-card')
      const last = cards.length ? cards[cards.length - 1].getBoundingClientRect() : null
      const box = grid.getBoundingClientRect()
      return {
        ok: true,
        首屏卡片: firstScreen,
        可达设备数: seen.size,
        可视高: Math.round(grid.clientHeight),
        滚动高: Math.round(grid.scrollHeight),
        视口高: window.innerHeight,
        末卡超出视口: last ? Math.round(last.bottom - box.bottom) : null,
        末端渲染: cards.length
      }
    })()`)
    check('设备台账渲染设备卡片（虚拟滚动首屏）', equipment.cards >= 1 && equipment.cards <= 60, `首屏=${equipment.cards}`)
    check('设备台账：滚到底能看到全部 60 台设备（虚拟滚动只减渲染量，不减可达性）',
      vgridReach.ok === true && vgridReach.可达设备数 === 60,
      `可达 ${vgridReach.可达设备数}/60 台 · 首屏 ${vgridReach.首屏卡片} 张 · 末端渲染 ${vgridReach.末端渲染} 张`)
    check('设备台账：滚动容器被 max-height 收住（占位不能把容器撑高）',
      vgridReach.ok === true && vgridReach.可视高 > 200 && vgridReach.可视高 < vgridReach.视口高,
      `容器可视高 ${vgridReach.可视高}px / 视口 ${vgridReach.视口高}px · 滚动高 ${vgridReach.滚动高}px`)
    check('设备台账：滚到底后最后一张卡片还在视口内（占位与真实行高对齐）',
      vgridReach.ok === true && vgridReach.末卡超出视口 !== null && vgridReach.末卡超出视口 <= 4,
      `末卡超出容器下沿 ${vgridReach.末卡超出视口}px`)

    // 滚到深处 → 搜索（列表变短，虚拟滚动关掉）→ 清空搜索（虚拟滚动重开）→ 网格是不是白的。
    // 这条对应的是用户报的「设备台账界面还是会出现白屏」（此前八轮探针没复现，因为都没做这个序列）。
    //
    // 复现是什么样（探针 node_modules/.probe/stale-scroll2.mjs 带插桩实测）：清空搜索之后
    // 浏览器把容器 DOM 的滚动位置恢复成 5659px，但**清空之后一条 scroll 事件都没有**
    // （事件流水里只有我们自己滚下去时那两条）—— 组件里的 scrollTop 还停在 reset() 写的 0，
    // 于是只渲染最前 6 行、占位 padding 全在下方，18 张卡全在视口**上方** 5393px 处。
    //
    // 断言的落点选"回到顶部"（dom滚动位置 === 0）而不是只看"视口内有卡片"：
    // 探针环境里清空后是**空白**（视口内 0 张），而本机 e2e 环境里浏览器把偏移恢复之后
    // 补了一次 scroll 事件，卡片看得见 —— 只查"不空白"的话这条在本机 e2e 里修前就是绿的（假过）。
    // "搜索条件变了就回到顶部"是 reset() 写明的意图（Equipment.vue 的 searchText watcher），
    // 两处修前都停在 5659px 上，这条在哪个环境里都能判红。
    const gridBlank = await session.eval(`(async () => {
      const grid = document.querySelector('.equip-grid')
      const input = document.querySelector('.card-header input')
      if (!grid || !input) return { ok: false, reason: '没有 .equip-grid 或搜索框' }
      const setSearch = (v) => {
        input.value = v
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const wait = (ms) => new Promise(r => setTimeout(r, ms))
      // 先滚到深处
      grid.scrollTop = grid.scrollHeight
      grid.dispatchEvent(new Event('scroll'))
      await wait(900)
      const deep = { scrollTop: Math.round(grid.scrollTop), 卡片: document.querySelectorAll('.equip-card').length }
      // 搜索到 ≤50 台（虚拟滚动关闭）再清空（重开）
      setSearch('钻机'); await wait(1200)
      const filtered = { virtual: grid.className.includes('virtual-scroll'), 卡片: document.querySelectorAll('.equip-card').length }
      setSearch(''); await wait(1600)
      const box = grid.getBoundingClientRect()
      const cards = [...document.querySelectorAll('.equip-card')]
      const inView = cards.filter(el => {
        const b = el.getBoundingClientRect()
        return b.bottom > box.top && b.top < box.bottom
      })
      // 先量后还原：这个对象必须在把容器写回 0 之前算出来（上一版把读取写在还原之后，
      // 读到的永远是刚写进去的那个 0 —— 断言因此看不到真实位置）
      const after = {
        virtual: grid.className.includes('virtual-scroll'),
        dom滚动位置: Math.round(grid.scrollTop),
        容器内卡片: cards.length,
        视口内可见卡片: inView.length,
        占位: getComputedStyle(document.querySelector('.equip-grid-inner')).paddingTop
      }
      grid.scrollTop = 0 // 量完把页面还原，不给后面的断言留一个滚在深处的列表
      grid.dispatchEvent(new Event('scroll'))
      return { ok: true, 深处: deep, 筛选后: filtered, 重开后: after }
    })()`)
    check('设备台账：深处搜索再清空后，列表回到顶部（不留在深处、不空白）',
      gridBlank.ok === true && gridBlank.重开后?.virtual === true &&
        gridBlank.重开后?.dom滚动位置 === 0 && gridBlank.重开后?.视口内可见卡片 > 0,
      gridBlank.ok
        ? `DOM 滚动位置 ${gridBlank.重开后.dom滚动位置}px · 占位 ${gridBlank.重开后.占位} · 视口内 ${gridBlank.重开后.视口内可见卡片} 张 / DOM 里 ${gridBlank.重开后.容器内卡片} 张（深处原为 ${gridBlank.深处.scrollTop}px / 筛选后虚拟=${gridBlank.筛选后.virtual}）`
        : gridBlank.reason)
    check('健康度按四级分档展示（验收 #2）', equipment.overview.length === 4, equipment.overview.join(' | '))
    check('设备台账共 60 台（四档合计）', equipment.overviewTotal === 60, `合计=${equipment.overviewTotal}`)
    check('每张卡片都带等级与健康分', equipment.levels.length === 5 && equipment.levels.every(t => /级.*分/.test(t)), equipment.levels.join(','))
    check('每张卡片按类别渲染设备照片，且图片真的解码出来了',
      equipment.photos === equipment.cards && equipment.cards > 0,
      `照片=${equipment.photos}/${equipment.cards}`)
    // 只查"有没有 <img>"是不够的：打包版是 `loadFile(dist/index.html)`，页面 URL 是 file://，
    // 根绝对路径 `/equipment-photos/x.jpg` 会解析到**盘符根**（file:///D:/equipment-photos/x.jpg）
    // —— 安装包里五处界面（台账卡/设备档案/告警中心/看板/设备记录）的照片全碎，而开发态与 e2e
    // 走的都是 http://localhost:5173，一条断言都看不见。这里盯住路径写法本身。
    check('设备照片的 src 是相对路径（打包版 file:// 下根绝对路径取不到文件）',
      equipment.photoPaths.length > 0 && equipment.photoPaths.every(p => p && !p.startsWith('/')),
      `src=${[...new Set(equipment.photoPaths)].slice(0, 3).join(' , ') || '（没有 src）'}`)
    check('卡片可直接发起体检', equipment.reportButtons >= equipment.cards && equipment.cards > 0,
      `按钮=${equipment.reportButtons}/${equipment.cards}`)

    // 生成体检报告：挑健康分最低的一台（体检内容最丰富）
    const reportFlow = await session.eval(`(async () => {
      const cards = Array.from(document.querySelectorAll('.equip-card'))
      const scored = cards.map(card => {
        const m = (card.querySelector('.equip-level')?.textContent || '').match(/(\\d+)\\s*分/)
        return { card, score: m ? Number(m[1]) : 999 }
      }).sort((a, b) => a.score - b.score)
      if (!scored.length) return { ok: false, reason: '无设备卡片' }
      const target = scored[0]
      const btn = Array.from(target.card.querySelectorAll('button')).find(b => /体检/.test(b.textContent))
      if (!btn) return { ok: false, reason: '找不到体检按钮' }
      btn.click()
      await new Promise(r => setTimeout(r, 1800))
      const drawer = document.querySelector('.el-drawer')
      const doc = document.querySelector('.health-report')
      return {
        ok: true,
        drawerOpen: !!drawer,
        hasReport: !!doc,
        score: doc?.querySelector('.hr-badge-score')?.textContent.trim(),
        level: doc?.querySelector('.hr-badge-level')?.textContent.trim(),
        sections: Array.from(doc?.querySelectorAll('h2') || []).map(h => h.textContent.trim()),
        factorCount: doc?.querySelectorAll('.hr-factor').length || 0,
        factorFormula: doc?.querySelector('.hr-factor-formula')?.textContent.trim() || null,
        riskRows: doc?.querySelectorAll('.hr-table tbody tr').length || 0,
        lossValue: doc?.querySelector('.hr-loss-value')?.textContent.trim() || null,
        lossFormula: doc?.querySelector('.hr-loss-formula')?.textContent.trim() || null,
        traceRows: doc?.querySelectorAll('.hr-trace-table tbody tr').length || 0,
        planRows: Array.from(doc?.querySelectorAll('.hr-table') || [])[1]?.querySelectorAll('tbody tr').length || 0,
        targetScore: target.score
      }
    })()`)
    check('可一键生成体检报告并打开抽屉（验收 #3）',
      reportFlow.ok && reportFlow.drawerOpen && reportFlow.hasReport, JSON.stringify(reportFlow).slice(0, 200))
    check('报告含健康分与等级', !!reportFlow.score && !!reportFlow.level,
      `${reportFlow.score} ${reportFlow.level}`)
    check('报告七个章节齐全（结论/因子/趋势/风险/损失/计划/溯源）',
      reportFlow.sections?.length >= 6, (reportFlow.sections || []).join(' / '))
    check('报告四因子各带计算式（可审计）',
      reportFlow.factorCount === 4 && /算式/.test(reportFlow.factorFormula || ''),
      reportFlow.factorFormula)
    check('报告含停机损失与公式与口径标注', !!reportFlow.lossValue && /×/.test(reportFlow.lossFormula || ''),
      `${reportFlow.lossValue} | ${reportFlow.lossFormula}`)
    check('报告含数字溯源表（验收 #3 可溯源）', reportFlow.traceRows >= 8, `${reportFlow.traceRows} 行`)
    check('高风险报告含风险清单', reportFlow.riskRows > 0, `${reportFlow.riskRows} 行`)

    // 报告 → 一键生成维保工单（验收 #4）
    const orderFlow = await session.eval(`(async () => {
      const btn = Array.from(document.querySelectorAll('.report-toolbar button')).find(b => /生成维保工单/.test(b.textContent))
      if (!btn) return { ok: false, reason: '找不到一键生成工单按钮' }
      btn.click()
      await new Promise(r => setTimeout(r, 2200))
      return { ok: true, hash: location.hash, rows: document.querySelectorAll('.el-table__row').length,
        firstTitle: document.querySelector('.el-table__row .cell')?.textContent.trim() || null }
    })()`)
    check('报告可一键生成工单并跳转（验收 #4）',
      orderFlow.ok && orderFlow.hash.includes('/workorder') && orderFlow.rows > 0,
      JSON.stringify(orderFlow))

    // ---------- 5. 工单：完成 → 归档 + 生成复诊任务（验收 #9） ----------
    const archiveFlow = await session.eval(`(async () => {
      // 找一张"待处理"的工单，点开始处理再点完成
      const rows = Array.from(document.querySelectorAll('.el-table__row'))
      let target = null
      for (const row of rows) {
        const btns = Array.from(row.querySelectorAll('button'))
        if (btns.some(b => /开始处理/.test(b.textContent))) { target = row; break }
      }
      if (!target) return { ok: false, reason: '没有待处理工单' }
      const orderId = target.querySelector('.cell')?.textContent.trim()
      const start = Array.from(target.querySelectorAll('button')).find(b => /开始处理/.test(b.textContent))
      start.click()
      await new Promise(r => setTimeout(r, 1500))
      // 重新定位该行（表格已重渲染）
      const row2 = Array.from(document.querySelectorAll('.el-table__row')).find(r => r.querySelector('.cell')?.textContent.trim() === orderId)
      const finish = Array.from(row2.querySelectorAll('button')).find(b => /完成/.test(b.textContent))
      if (!finish) return { ok: false, reason: '找不到完成按钮', orderId }
      finish.click()
      await new Promise(r => setTimeout(r, 2000))
      const row3 = Array.from(document.querySelectorAll('.el-table__row')).find(r => r.querySelector('.cell')?.textContent.trim() === orderId)
      const cells = Array.from(row3.querySelectorAll('.cell')).map(c => c.textContent.trim())
      return { ok: true, orderId, cells }
    })()`)
    check('工单可完成流转（验收 #9 前置）', archiveFlow.ok, JSON.stringify(archiveFlow).slice(0, 160))
    check('完成后该工单显示"待复诊"（自动生成复诊任务）',
      (archiveFlow.cells || []).some(c => /待复诊/.test(c)),
      (archiveFlow.cells || []).join(' | '))

    // ---------- 5b. 工单删除：能删误建单，不能删已归档单 ----------
    const deleteFlow = await session.eval(`(async () => {
      const $pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
      const store = $pinia._s.get('app')
      const rowsOf = () => Array.from(document.querySelectorAll('.el-table__row'))
      // 复诊标记只在工单完成时写入，所以带复诊列的必然是已归档的单
      const isArchivedRow = (r) => /待复诊|已复诊/.test(r.textContent)
      const deleteBtn = (r) => Array.from(r.querySelectorAll('button')).find(b => /删除/.test(b.textContent))

      const archivedRows = rowsOf().filter(isArchivedRow)
      const archivedHasDelete = archivedRows.some(r => !!deleteBtn(r))

      // store 层也要挡：不能只靠按钮不显示
      const archivedOrder = store.workOrders.find(o => o.archived_at)
      const storeRefused = archivedOrder ? store.removeWorkOrder(archivedOrder.id) : 'skip'
      const stillThere = archivedOrder ? !!store.workOrders.find(o => o.id === archivedOrder.id) : 'skip'

      const target = rowsOf().find(r => deleteBtn(r) && /待派单|已派单|处理中/.test(r.textContent))
      if (!target) return { ok: false, reason: '没有可删除的单', archivedRows: archivedRows.length,
        archivedHasDelete, storeRefused, stillThere }

      const id = target.querySelector('.cell').textContent.trim()
      const before = store.workOrders.length
      deleteBtn(target).click()
      await new Promise(r => setTimeout(r, 900))
      const confirmBtn = document.querySelector('.el-message-box__btns .el-button--danger')
      if (!confirmBtn) return { ok: false, reason: '没有弹出二次确认', id }
      confirmBtn.click()
      await new Promise(r => setTimeout(r, 1600))
      const after = store.workOrders.length
      return {
        ok: true, id, before, after,
        removed: after === before - 1,
        goneFromStore: !store.workOrders.some(o => String(o.id) === String(id)),
        goneFromTable: !rowsOf().some(r => r.querySelector('.cell').textContent.trim() === id),
        archivedRows: archivedRows.length, archivedHasDelete, storeRefused, stillThere
      }
    })()`)

    check('已归档工单不提供删除入口（病历不可删）',
      deleteFlow.archivedRows > 0 && deleteFlow.archivedHasDelete === false,
      `归档行 ${deleteFlow.archivedRows} 条，其中带删除按钮：${deleteFlow.archivedHasDelete}`)
    check('store 层同样拒绝删除已归档工单（不只是按钮藏起来）',
      deleteFlow.storeRefused === false && deleteFlow.stillThere === true,
      `removeWorkOrder 返回 ${deleteFlow.storeRefused}，工单仍在：${deleteFlow.stillThere}`)
    check('未完成工单可删除，且删除前有二次确认',
      deleteFlow.ok && deleteFlow.removed && deleteFlow.goneFromStore && deleteFlow.goneFromTable,
      deleteFlow.ok
        ? `#${deleteFlow.id}：${deleteFlow.before} → ${deleteFlow.after}`
        : `失败：${deleteFlow.reason}`)

    // 回看板确认闭环率与日志更新
    await session.goto(`${BASE}/#/dashboard`, 2600)
    const afterArchive = await session.eval(`(() => ({
      logs: Array.from(document.querySelectorAll('.log-content')).slice(0, 3).map(e => e.textContent.replace(/\\s+/g, ' ').trim()),
      closing: document.querySelector('.closing-ring')?.textContent.trim(),
      closingLine: document.querySelector('.closing-line')?.textContent.replace(/\\s+/g, ' ').trim()
    }))()`)
    check('工单完成后写入最近操作日志（病历归档留痕）',
      afterArchive.logs.some(l => /归档|病历|完成/.test(l)), afterArchive.logs.join(' || '))

    // Dashboard 高频故障 TOP（验收 #5：E2E 部分）
    const faultTop = await session.eval(`(() => ({
      rows: Array.from(document.querySelectorAll('.fault-row')).map(r => r.textContent.replace(/\\s+/g, ' ').trim()),
      note: document.querySelector('.fault-note')?.textContent.replace(/\\s+/g, ' ').trim(),
      sampleTag: document.querySelector('.fault-card .el-tag')?.textContent.replace(/\\s+/g, ' ').trim()
    }))()`)
    check('Dashboard 出现高频故障 TOP（验收 #5）',
      faultTop.rows.length >= 3 && /样本/.test(faultTop.sampleTag || ''),
      JSON.stringify(faultTop).slice(0, 200))
    check('故障 TOP 每行显示次数与占比',
      faultTop.rows.every(r => /次/.test(r) && /%/.test(r)), faultTop.rows.join(' || '))

    const faultExpand = await session.eval(`(async () => {
      const row = document.querySelector('.fault-row')
      if (!row) return { ok: false, reason: '无故障行' }
      row.click()
      await new Promise(r => setTimeout(r, 500))
      const samples = document.querySelectorAll('.fault-sample').length
      const head = document.querySelector('.fault-sample-head')?.textContent.replace(/\\s+/g, ' ').trim()
      return { ok: samples > 0, samples, head }
    })()`)
    check('故障 TOP 可点开原始记录（可审计）', faultExpand.ok, JSON.stringify(faultExpand))

    // ---------- 6. AI 助手：健康体检问答（验收 #7） ----------
    await session.goto(`${BASE}/#/ai-assistant`, 2800)
    const aiFlow = await session.eval(`(async () => {
      const tags = Array.from(document.querySelectorAll('.quick-tag'))
      const healthTag = tags.find(t => /健康怎么样/.test(t.textContent))
      if (!healthTag) return { ok: false, reason: '找不到健康类快捷提问', tagCount: tags.length }
      const question = healthTag.textContent.trim()
      healthTag.click()
      // 等打字动画 + 思考步骤播完（约 4-5s），留足余量
      await new Promise(r => setTimeout(r, 9000))
      const messages = Array.from(document.querySelectorAll('.message'))
      const last = messages[messages.length - 1]
      return {
        ok: true,
        question,
        text: last ? last.textContent.replace(/\\s+/g, ' ').slice(0, 400) : '',
        refs: Array.from(document.querySelectorAll('.message-refs .ref-item')).map(e => e.textContent.trim())
      }
    })()`)
    check('AI 助手提供健康体检类提问', aiFlow.ok, JSON.stringify(aiFlow).slice(0, 140))
    check('健康问答返回健康分与四因子（验收 #7）',
      /健康分/.test(aiFlow.text || '') && /维保及时性/.test(aiFlow.text || ''),
      (aiFlow.text || '').slice(0, 140))
    check('健康问答给出处置建议', /处置建议/.test(aiFlow.text || ''))
    check('健康问答带依据（可溯源）', (aiFlow.refs || []).length > 0, (aiFlow.refs || []).join(' | '))

    // 知识库检索仍可用 + 未命中不编造
    const helperReady = await session.eval(ASK_HELPER)
    check('页面注入提问助手', helperReady === 'helper-ready', String(helperReady))

    const kbAnswer = await session.eval(`window.__ask('发动机过热怎么排查？')`)
    check('知识库检索返回带出处的规程（验收 #8）',
      !kbAnswer.error && /来源/.test(kbAnswer.text || '') && (kbAnswer.refs || []).length > 0,
      kbAnswer.error || (kbAnswer.refs || []).join(' | '))

    const missAnswer = await session.eval(`window.__ask('帮我写一首关于春天的诗')`)
    check('未命中时不编造答案（明确说查不到）',
      !missAnswer.error && /查不到|没有检索到/.test(missAnswer.text || ''),
      missAnswer.error || (missAnswer.text || '').slice(0, 120))

    // ---------- 7. 其余路由仍可渲染（回归） ----------
    for (const [route, selector, label] of [
      ['/equipment', '.equip-card', '设备台账'],
      ['/alert-center', '.alert-center', '告警中心'],
      ['/parts-inventory', '.parts-page', '备件库存'],
      ['/model-hub', '.model-hub', '本地模型'],
      ['/maintenance-calendar', '.calendar-cell', '维保日历'],
      ['/workorder', '.el-table__row', '工单管理'],
      ['/medical-records', '.records-page', '设备病历'],
      ['/recheck', '.recheck-page', '复诊管理'],
      ['/fault-cases', '.fault-page', '故障案例库'],
      ['/logs', '.logs-page', '操作日志'],
      ['/documents', '.documents-page', '手册资料库'],
      ['/settings', '.settings-page', '系统设置']
    ]) {
      await session.goto(`${BASE}/#${route}`, 2400)
      const count = await session.eval(`document.querySelectorAll('${selector}').length`)
      check(`路由 ${route}（${label}）正常渲染`, count > 0, `${selector}=${count}`)
    }

    // ---------- 7c. 数据备份与迁移（一键换机） ----------
    // 浏览器模式：导出走 buildBackup、导入走 importBackup(内容)；Electron 弹框路径无法 headless 自动化。
    // 关键验收：往返数据一致、篡改被 SHA 拦截、v1 旧备份兼容导入。
    await session.goto(`${BASE}/#/settings`, 2400)
    const backupUI = await session.eval(`(() => ({
      hasCard: !!document.querySelector('.backup-row'),
      hasExport: !!Array.from(document.querySelectorAll('.backup-row button')).find(b => /一键导出备份/.test(b.textContent)),
      hasImport: !!Array.from(document.querySelectorAll('.backup-row button')).find(b => /一键导入备份/.test(b.textContent))
    }))()`)
    check('设置页出现备份与迁移卡（一键导出/导入）', backupUI.hasCard && backupUI.hasExport && backupUI.hasImport,
      JSON.stringify(backupUI))

    const backupFlow = await session.eval(`(async () => {
      const { buildBackup, importBackup } = await import('/src/utils/backup.js')
      const json = await buildBackup()
      const parsed = JSON.parse(json)
      const r = await importBackup(json)
      const after = {
        equip: document.querySelectorAll('.equip-card').length,
        ok: !!(r && r.ok)
      }
      return { after, exportedAt: parsed.exportedAt || null, version: parsed.version || null,
        hasSha: !!(parsed.sha256), hasSettings: typeof parsed.settings === 'object' }
    })()`)
    check('备份导出→导入往返成功且版本/SHA/设置齐全',
      backupFlow.after.ok && backupFlow.hasSha && backupFlow.hasSettings && backupFlow.version === '2.0.0',
      JSON.stringify(backupFlow).slice(0, 200))

    const backupTamper = await session.eval(`(async () => {
      const { buildBackup, importBackup } = await import('/src/utils/backup.js')
      const json = await buildBackup()
      const obj = JSON.parse(json)
      obj.dbBase64 = obj.dbBase64.slice(0, -10) + 'AAAAAAAAAA='
      const r = await importBackup(JSON.stringify(obj))
      return { ok: !!(r && r.ok), error: (r && r.error) || '' }
    })()`)
    check('篡改备份内容被 SHA-256 完整性校验拦截',
      !backupTamper.ok && /完整性/.test(backupTamper.error), backupTamper.error)

    const backupV1 = await session.eval(`(async () => {
      const { buildBackup, importBackup } = await import('/src/utils/backup.js')
      // 构造 v1 旧备份（无 sha256/settings/docFiles），应兼容导入
      const json = await buildBackup()
      const cur = JSON.parse(json)
      const v1 = { app: cur.app, version: '1.0.0', exportedAt: cur.exportedAt, dbBase64: cur.dbBase64, chatHistory: [] }
      const r = await importBackup(JSON.stringify(v1))
      return { ok: !!(r && r.ok), version: (r && r.version) || '' }
    })()`)
    check('v1 旧备份兼容导入', backupV1.ok && backupV1.version === '1.0.0', JSON.stringify(backupV1))

    /**
     * ---------- 7c-2. 浏览器模式：真实文件选择路径（P3-3） ----------
     *
     * 上面三条走的都是 `importBackup(内容)`，把"文件从哪来"这一步整个跳过了；
     * 而 P3-3 的缺陷恰好就在这一步。浏览器模式没有原生打开框，调用点
     * `Settings.vue` 也不传内容，于是 `importBackup()` 必然落到
     * "未读取到备份内容" —— 在用户还没有机会选任何文件的时候就报"没读到内容"。
     * 而演示脚本 §零 推荐的正是浏览器模式，等于这个按钮在演示路径上
     * 从来没成功过，只是失败得很费解（一个红条 + 一句与操作对不上的话）。
     *
     * 所以这里不能再用"传内容"的调用形态验证，必须走真路径：
     * 点按钮 → 确认 → 用 CDP 往隐藏 input 里喂**磁盘上的真文件** → 看界面说什么。
     * 文件是真数据导出来的（不是手搓 JSON），读回来才有意义。
     */
    const bakDir = mkdtempSync(join(tmpdir(), 'kuangshan-e2e-bak-'))
    try {
      const bakJson = await session.eval(`(async () => {
        const { buildBackup } = await import('/src/utils/backup.js')
        return await buildBackup()
      })()`)
      const goodPath = join(bakDir, '往返.mbak')
      const badPath = join(bakDir, '不是备份.mbak')
      writeFileSync(goodPath, bakJson, 'utf8')
      writeFileSync(badPath, JSON.stringify({ app: 'some-other-app', dbBase64: 'AAAA' }), 'utf8')

      const equipBefore = await session.eval(
        `(async () => {
          const d = await import('/src/utils/database.js')
          return d.count('equipment')
        })()`
      )

      // ① 点「一键导入备份」→ 确认 → 应拉起一个隐藏的文件选择框
      const picker = await session.eval(`(async () => {
        const btn = Array.from(document.querySelectorAll('.backup-row button')).find(b => /一键导入备份/.test(b.textContent))
        if (!btn) return { ok: false, reason: '找不到一键导入备份按钮' }
        btn.click()
        await new Promise(r => setTimeout(r, 800))
        const box = document.querySelector('.el-message-box')
        const confirm = box && Array.from(box.querySelectorAll('button')).find(b => /继续导入/.test(b.textContent))
        if (!confirm) return { ok: false, reason: '确认框没出现' }
        const confirmText = ((box.querySelector('.el-message-box__message') || {}).textContent || '').replace(/\\s+/g, ' ').trim()
        confirm.click()
        const deadline = Date.now() + 5000
        let input = null
        while (Date.now() < deadline) {
          input = document.querySelector('input[data-backup-picker]')
          if (input) break
          await new Promise(r => setTimeout(r, 100))
        }
        return {
          ok: !!input,
          reason: input ? '' : '点了导入但没出现文件选择框（浏览器模式仍然取不到文件）',
          accept: input ? input.accept : '',
          hidden: input ? getComputedStyle(input).display === 'none' : false,
          confirmText
        }
      })()`)
      check('浏览器模式点「一键导入备份」会拉起文件选择框（P3-3）',
        picker.ok && /\.mbak/.test(picker.accept) && picker.hidden,
        JSON.stringify(picker).slice(0, 220))
      check('浏览器模式下确认框不再承诺做不到的自动备份',
        /无法自动备份/.test(picker.confirmText) && !/备份当前数据到本机 backups/.test(picker.confirmText),
        picker.confirmText.slice(0, 180))

      /**
       * 往文件选择框里喂文件。选择框不在时**不抛异常**：那是"上一条断言已经红了"
       * 的连锁反应，抛出去会让整轮 e2e 中断、已经收集的断言全部丢失 ——
       * 而真出问题时最需要看到的恰恰是"哪几条红了、分别为什么红"。
       * 返回空串表示喂进去了，否则返回原因，由后续断言带着它变红。
       */
      const feedFile = async (path) => {
        try {
          await session.setFileInputFiles('input[data-backup-picker]', [path])
          return ''
        } catch (error) {
          return `文件没能送进选择框：${error.message}`
        }
      }

      // ② 往那个 input 里喂真文件 → 必须一路走到"导入完成"，且台账还在
      const feedErr = await feedFile(goodPath)
      let imported = { title: '(未发生)', text: '', boxGone: false, pickerRemoved: false }
      if (!feedErr) {
        imported = await session.eval(`(async () => {
          const deadline = Date.now() + 40000
          let title = '', text = ''
          while (Date.now() < deadline) {
            const box = document.querySelector('.el-message-box')
            if (box && /导入完成/.test(box.textContent)) {
              title = ((box.querySelector('.el-message-box__title') || {}).textContent || '').trim()
              text = ((box.querySelector('.el-message-box__message') || {}).textContent || '').replace(/\\s+/g, ' ').trim()
              const ok = Array.from(box.querySelectorAll('button')).find(b => /知道了/.test(b.textContent))
              if (ok) ok.click()
              // 关掉弹窗要等淡出动画走完，否则读到的仍是尚未移除的节点
              await new Promise(r => setTimeout(r, 700))
              break
            }
            await new Promise(r => setTimeout(r, 250))
          }
          return {
            title, text: text.slice(0, 160),
            boxGone: !document.querySelector('.el-message-box'),
            pickerRemoved: !document.querySelector('input[data-backup-picker]')
          }
        })()`)
      }
      const equipAfter = await session.eval(
        `(async () => {
          const d = await import('/src/utils/database.js')
          return d.count('equipment')
        })()`
      )
      check('浏览器模式真选文件能把备份导进来（不再静默失败）',
        !feedErr && imported.title === '导入完成' && imported.boxGone && imported.pickerRemoved,
        feedErr || `${imported.title} / ${imported.text}`)
      /**
       * ⚠️ 这一条必须带上 `!feedErr`：不然文件根本没送进去时，台账数量当然也没变，
       * 断言照样绿 —— 那测的就不是"导入后台账还在"，而是"什么都没发生"。
       */
      check('浏览器模式文件导入后台账数量不变（真读到了文件内容）',
        !feedErr && imported.title === '导入完成' && equipAfter === equipBefore && equipBefore > 0,
        feedErr || `导入前 ${equipBefore} 台 → 导入后 ${equipAfter} 台`)

      // ③ 喂一个不是备份的文件 → 必须明确报错 + 留日志（原来是弹个条就没了，库里零痕迹）
      const reopen = await session.eval(`(async () => {
        const btn = Array.from(document.querySelectorAll('.backup-row button')).find(b => /一键导入备份/.test(b.textContent))
        if (!btn) return false
        btn.click()
        await new Promise(r => setTimeout(r, 800))
        const confirm = Array.from(document.querySelectorAll('.el-message-box__btns button')).find(b => /继续导入/.test(b.textContent))
        if (!confirm) return false
        confirm.click()
        const deadline = Date.now() + 5000
        while (Date.now() < deadline) {
          if (document.querySelector('input[data-backup-picker]')) return true
          await new Promise(r => setTimeout(r, 100))
        }
        return false
      })()`)
      check('再次点「一键导入备份」仍能拉起文件选择框', reopen === true, String(reopen))

      const feedErr2 = await feedFile(badPath)
      let rejected = { err: '(未发生)', successBox: false, logged: false, pickerRemoved: false }
      if (!feedErr2) {
        rejected = await session.eval(`(async () => {
          const deadline = Date.now() + 15000
          let err = ''
          while (Date.now() < deadline) {
            const m = Array.from(document.querySelectorAll('.el-message--error .el-message__content')).map(e => e.textContent.trim())
            if (m.length) { err = m.join(' | '); break }
            await new Promise(r => setTimeout(r, 200))
          }
          await new Promise(r => setTimeout(r, 900))
          const box = document.querySelector('.el-message-box')
          const d = await import('/src/utils/database.js')
          const rows = d.query('SELECT content FROM operation_logs ORDER BY id DESC LIMIT 8')
          return {
            err,
            successBox: !!(box && /导入完成/.test(box.textContent)),
            logged: rows.map(r => String(r.content)).some(t => /导入备份失败/.test(t)),
            pickerRemoved: !document.querySelector('input[data-backup-picker]')
          }
        })()`)
      }
      check('浏览器模式导入非备份文件会明确报错并指出原因',
        !feedErr2 && /不是矿山智工的备份文件/.test(rejected.err) && !rejected.successBox && rejected.pickerRemoved,
        feedErr2 || JSON.stringify(rejected).slice(0, 220))
      check('导入失败会写进操作日志（离线现场唯一的事后凭据）',
        !feedErr2 && rejected.logged === true,
        feedErr2 || `err=${rejected.err} logged=${rejected.logged}`)

      /**
       * ④ 取消选择文件不能算失败。
       *
       * 用户自己关掉了系统选择框，界面不该再弹一个红条说他"导入失败" ——
       * 所以 `canceled` 和 `error` 必须是两个分得开的字段。
       *
       * ⚠️ 本条的局限要说清楚：headless 里没有真的文件选择框可点，`cancel`
       * 是**合成事件**，所以它测的是"我们监听了 cancel、并且把它收敛成 canceled"，
       * 不是"Chromium 真的会在用户关掉对话框时补发 cancel"。后者只能装机实测。
       */
      const cancelFlow = await session.eval(`(async () => {
        const { importBackup } = await import('/src/utils/backup.js')
        const pending = importBackup()
        const deadline = Date.now() + 5000
        let input = null
        while (Date.now() < deadline) {
          input = document.querySelector('input[data-backup-picker]')
          if (input) break
          await new Promise(r => setTimeout(r, 50))
        }
        if (!input) return { reason: '没拉起文件选择框，取消路径无从验证' }
        input.dispatchEvent(new Event('cancel'))
        const r = await pending
        return {
          ok: !!(r && r.ok),
          canceled: !!(r && r.canceled),
          error: (r && r.error) || '',
          pickerRemoved: !document.querySelector('input[data-backup-picker]')
        }
      })()`)
      check('取消选择文件不算失败（canceled 与 error 分得开）',
        cancelFlow.canceled === true && cancelFlow.ok === false && !cancelFlow.error && cancelFlow.pickerRemoved,
        JSON.stringify(cancelFlow).slice(0, 200))
    } finally {
      try { rmSync(bakDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    }

    // ---------- 7d. AI 老师傅人设 + 对话式 AI（任务 17 Batch B） ----------
    // 纯函数直调（不依赖 store）：B2 症状通道 / B3 排查思路 / B4 追问与摘要 / 人设开关。
    await session.goto(`${BASE}/#/settings`, 2400)
    const masterUI = await session.eval(`(() => ({
      hasSwitch: !!document.querySelector('.settings-page .el-switch'),
      hasLabel: document.body.innerText.includes('AI 老师傅模式')
    }))()`)
    check('设置页出现 AI 老师傅开关', masterUI.hasSwitch && masterUI.hasLabel, JSON.stringify(masterUI))

    const personaFn = await session.eval(`(async () => {
      const { masterEnabled, setMasterEnabled, masterGreeting, MASTER_NARRATE_PERSONA } = await import('/src/utils/masterPersona.js')
      setMasterEnabled(true)
      const on = masterEnabled()
      setMasterEnabled(false)
      const off = masterEnabled()
      return { on, off, persona: !!MASTER_NARRATE_PERSONA }
    })()`)
    check('老师傅模式开关读写生效（localStorage）',
      personaFn.on && !personaFn.off && personaFn.persona, JSON.stringify(personaFn))

    const tripletFn = await session.eval(`(async () => {
      const { KNOWLEDGE_BASE } = await import('/src/utils/knowledgeBase.js')
      const { matchFaultTriplet, renderTripletCard, tripletRefs } = await import('/src/utils/faultTriplet.js')
      const hits = matchFaultTriplet('钻杆摆动大怎么处理', KNOWLEDGE_BASE)
      const hit = hits[0]
      const html = hit ? renderTripletCard(hit.triplet, '经验引导') : ''
      return {
        hit: !!hit,
        matchedBy: hit && hit.matchedBy,
        symptom: hit && hit.triplet && hit.triplet.symptom || '',
        hasCauses: !!(hit && hit.triplet && hit.triplet.causes && hit.triplet.causes.length),
        hasSteps: !!(hit && hit.triplet && hit.triplet.steps && hit.triplet.steps.length),
        hasSource: !!(hit && hit.triplet && hit.triplet.source),
        refs: hit ? tripletRefs(hit.triplet) : [],
        htmlHasSteps: html.includes('处理步骤')
      }
    })()`)
    check('B2 症状通道：现象描述命中三元组（症状/原因/步骤/来源齐全）',
      tripletFn.hit && tripletFn.matchedBy === 'symptom' && tripletFn.hasCauses && tripletFn.hasSteps && tripletFn.hasSource && tripletFn.refs.length > 0,
      JSON.stringify(tripletFn).slice(0, 220))

    const tmapFn = await session.eval(`(async () => {
      const { matchTroubleshootMap, renderTroubleshootMap } = await import('/src/utils/troubleshootMaps.js')
      const m = matchTroubleshootMap('液压系统压力低怎么办')
      const html = m ? renderTroubleshootMap(m) : ''
      return { hit: !!m, id: m && m.id, htmlHasSteps: html.includes('先看'), orderLen: m ? m.checkOrder.length : 0 }
    })()`)
    check('B3 排查思路：系统关键词命中分层思路表',
      tmapFn.hit && tmapFn.id === 'hydraulic' && tmapFn.orderLen >= 3 && tmapFn.htmlHasSteps,
      JSON.stringify(tmapFn))

    const followupsFn = await session.eval(`(async () => {
      const { KNOWLEDGE_BASE } = await import('/src/utils/knowledgeBase.js')
      const { matchFaultTriplet } = await import('/src/utils/faultTriplet.js')
      const { masterFollowups } = await import('/src/utils/masterPersona.js')
      const hits = matchFaultTriplet('钻杆摆动大怎么处理', KNOWLEDGE_BASE)
      const f = masterFollowups('钻杆摆动大怎么处理', { source: 'knowledge', hits })
      return { list: f, ok: Array.isArray(f) && f.length > 0 && f.length <= 3 }
    })()`)
    check('B4 追问候选：知识回答后生成 1~3 个追问',
      followupsFn.ok, JSON.stringify(followupsFn.list))

    const summaryFn = await session.eval(`(async () => {
      const { buildConversationSummary } = await import('/src/utils/conversationSummary.js')
      const s = buildConversationSummary([
        { role: 'user', text: '1号挖掘机液压油压力低', equipmentName: '1号挖掘机', timestamp: 't1' },
        { role: 'assistant', text: '已按液压系统条目回答', equipmentName: '1号挖掘机', timestamp: 't2' }
      ], { overdueCount: 3 })
      return {
        ok: !!s,
        hasRounds: s.includes('问答轮数：1'),
        hasDevice: s.includes('1号挖掘机'),
        hasSystem: s.includes('液压系统'),
        hasOverdue: s.includes('3 台')
      }
    })()`)
    check('B4 会话摘要：轮数/设备/系统/待办齐全',
      summaryFn.ok && summaryFn.hasRounds && summaryFn.hasDevice && summaryFn.hasSystem && summaryFn.hasOverdue,
      JSON.stringify(summaryFn))

    // ---------- 7b. UI 升级：分组侧边栏 + 导航搜索 + 钉住常用 ----------
    await session.goto(`${BASE}/#/dashboard`, 2400)
    const nav = await session.eval(`(() => ({
      groups: Array.from(document.querySelectorAll('.nav-group-title')).map(e => e.textContent.trim()),
      items: Array.from(document.querySelectorAll('.nav-item .nav-label')).map(e => e.textContent.trim()),
      search: !!document.querySelector('.nav-search-input')
    }))()`)
    check('侧边栏按叙事分组（设备健康/运维执行/AI智能/数据资产）',
      ['设备健康', '运维执行', 'AI 智能', '数据资产', '系统'].every(g => nav.groups.includes(g)),
      nav.groups.join(' | '))
    check('侧边栏含全部 15 个功能入口',
      ['数据看板', '设备台账', '设备病历', '告警中心', '维保日历', '工单管理', '复诊管理', 'AI 助手', '本地模型', '维修规程库', '手册资料库', '故障案例库', '备件库存', '操作日志', '系统设置'].every(l => nav.items.includes(l)),
      nav.items.join('、'))
    check('侧边栏有导航搜索框', nav.search)

    const navSearch = await session.eval(`(async () => {
      const input = document.querySelector('.nav-search-input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '病历')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 300))
      const visible = Array.from(document.querySelectorAll('.nav-item .nav-label')).filter(e => e.offsetParent !== null).map(e => e.textContent.trim())
      setter.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return visible
    })()`)
    check('导航搜索可过滤（搜"病历"只剩设备病历）',
      navSearch.length === 1 && navSearch[0] === '设备病历', navSearch.join('、'))

    const navPin = await session.eval(`(async () => {
      const item = Array.from(document.querySelectorAll('.nav-item')).find(e => /设备台账/.test(e.textContent))
      if (!item) return { ok: false, reason: '找不到设备台账' }
      const pin = item.querySelector('.nav-pin')
      pin.click()
      await new Promise(r => setTimeout(r, 300))
      const pinnedCount = document.querySelectorAll('.nav-pinned .nav-item').length
      const item2 = Array.from(document.querySelectorAll('.nav-item')).find(e => /设备台账/.test(e.textContent))
      item2.querySelector('.nav-pin').click()
      return { ok: pinnedCount === 1, pinnedCount }
    })()`)
    check('钉住常用：可钉入"常用"区并还原', navPin.ok, JSON.stringify(navPin))

    // ---------- 7c. 顶栏全局搜索：正则元字符不能把页面炸掉 ----------
    // 搜索词直接拼进 new RegExp，输入 "(" 这类字符会抛 Invalid regular expression；
    // 而高亮是在模板渲染里调的，一抛就是整页白屏 —— 当时验收全绿也没发现。
    await session.goto(`${BASE}/#/dashboard`, 2400)
    const regexSearch = await session.eval(`(async () => {
      const input = document.querySelector('.global-search .el-input__inner')
      if (!input) return { ok: false, reason: '找不到顶栏搜索框' }
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      const type = async (text) => {
        setter.call(input, text)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise(r => setTimeout(r, 350))
      }
      const results = {}
      for (const bad of ['(', '[', '*', '\\\\', '?', 'a(b']) {
        await type(bad)
        results[bad] = {
          panelAlive: !!document.querySelector('.search-panel'),
          // 页面还在渲染 = 没白屏
          pageAlive: !!document.querySelector('.global-search')
        }
      }
      // 正常词仍要能搜到东西，别为了不崩就干脆不工作
      await type('挖掘机')
      const items = document.querySelectorAll('.search-item').length
      // 高亮不能把 HTML 注入进去
      await type('<img src=x onerror=alert(1)>')
      const injected = document.querySelectorAll('.search-panel img').length
      await type('')
      return { ok: true, results, items, injected }
    })()`)
    const regexBad = Object.entries(regexSearch.results || {})
    check('顶栏搜索输入正则元字符不白屏（( [ * \\\\ ? 等）',
      regexSearch.ok && regexBad.length > 0 && regexBad.every(([, r]) => r.pageAlive),
      JSON.stringify(regexSearch.results))
    check('顶栏搜索正常词仍能搜到结果', regexSearch.items > 0, `命中 ${regexSearch.items} 条`)
    check('顶栏搜索不会把输入当 HTML 注入', regexSearch.injected === 0, `注入 img=${regexSearch.injected}`)

    // ---------- 8. 知识库管理页：新增条目即时生效（验收 #14） ----------
    await session.goto(`${BASE}/#/knowledge-base`, 2400)
    const kbFlow = await session.eval(`(async () => {
      const addBtn = Array.from(document.querySelectorAll('button')).find(b => /新增条目/.test(b.textContent))
      if (!addBtn) return { ok: false, reason: '找不到新增按钮' }
      addBtn.click()
      await new Promise(r => setTimeout(r, 500))
      const byPh = (ph) => Array.from(document.querySelectorAll('.el-dialog input, .el-dialog textarea'))
        .find(e => e.placeholder && e.placeholder.includes(ph))
      const setVal = (el, val) => {
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
        setter.call(el, val)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const title = byPh('例：徐工')
      if (!title) return { ok: false, reason: '找不到标题输入框' }
      setVal(title, 'XE215C 回转马达异响排查')
      const kw = byPh('逗号分隔')
      setVal(kw, 'XE215C, 回转马达, 异响')
      const sym = byPh('例：回转时异响')
      setVal(sym, '回转时异响、顿挫')
      const causes = byPh('每行一条原因')
      setVal(causes, '回转马达轴承磨损\\n行星减速机构润滑不足')
      const steps = byPh('每行一条步骤')
      setVal(steps, '停机检查回转马达油位与油质\\n转动回转检查异响部位')
      const source = byPh('现场案例')
      setVal(source, '现场案例 - 2026-09')
      await new Promise(r => setTimeout(r, 300))
      const saveBtn = Array.from(document.querySelectorAll('.el-dialog__footer button')).find(b => /新增并立即生效/.test(b.textContent))
      if (!saveBtn) return { ok: false, reason: '找不到保存按钮' }
      saveBtn.click()
      await new Promise(r => setTimeout(r, 1200))
      const rows = Array.from(document.querySelectorAll('.el-table__row')).map(r => r.textContent.replace(/\\s+/g, ' ').trim())
      return { ok: rows.some(r => r.includes('回转马达异响')), rows: rows.length }
    })()`)
    check('知识库管理页：新增条目成功（验收 #14）', kbFlow.ok, JSON.stringify(kbFlow).slice(0, 160))

    // 回 AI 助手：同样问题立即命中（"现场录一条 → 马上能答"）
    await session.goto(`${BASE}/#/ai-assistant`, 2800)
    await session.eval(ASK_HELPER)
    const kbLive = await session.eval(`window.__ask('XE215C 回转马达异响怎么处理？')`)
    check('新增条目后 AI 助手立即命中（经验传承实锤）',
      !kbLive.error && (kbLive.refs || []).some(r => r.includes('现场案例')),
      kbLive.error || (kbLive.refs || []).join(' | '))

    // ---------- 8.2 四条用户报障的复现与回归（2026-09-26） ----------
    // 报障原文：维修规章库无法点击打开 / 故障案例库无法点击查看详情 /
    //           老师傅模式开启后没有启动以及无法交互对话 / 聊天记录总是回滚到最前面。
    // 每条都按**用户真实路径**走（真的点行、真点卡片、真的切页离开再回来），
    // 不抄近路调内部 API —— 否则"用户点不动"这种缺陷照样能全绿。
    // 注意：此时知识库里已经有上一段刚新增的「XE215C 回转马达异响排查」，
    // 所以下面问"回转马达异响"必须有实质回答，不能用"查不到"糊过去。

    // —— 报障 2：维修规程库无法点击打开 ——
    // 规程的症状/原因/步骤此前**只存在于编辑对话框里**，AI 草稿行更是连看都看不到。
    // 断言三条：行内有只读的「查看」入口、点开有详情面板、面板真的不提供输入框。
    await session.goto(`${BASE}/#/knowledge-base`, 2600)
    const kbRowDetail = await session.eval(`(async () => {
      const row = document.querySelector('.kb-table-card .el-table__row')
      if (!row) return { ok: false, reason: '没有规程行' }
      const title = (row.querySelector('.kb-item-title') || {}).textContent || ''
      const viewBtn = Array.from(row.querySelectorAll('button')).find(b => /查看/.test(b.textContent))
      if (viewBtn) viewBtn.click()
      else row.click()
      await new Promise(r => setTimeout(r, 800))
      const panel = document.querySelector('.kb-detail')
      return {
        ok: true,
        title: title.trim(),
        hasViewBtn: !!viewBtn,
        opened: !!panel,
        inputs: panel ? panel.querySelectorAll('input, textarea').length : -1,
        lis: panel ? panel.querySelectorAll('.kb-detail-list li').length : -1,
        body: panel ? panel.textContent.replace(/\\s+/g, ' ').trim().slice(0, 600) : ''
      }
    })()`)
    check('维修规程库：每一行都有「查看」入口（不必先点编辑才能看内容）',
      kbRowDetail.hasViewBtn === true, JSON.stringify(kbRowDetail).slice(0, 200))
    check('维修规程库：点一条规程能打开详情面板',
      kbRowDetail.opened === true,
      kbRowDetail.reason || JSON.stringify(kbRowDetail).slice(0, 200))
    check('规程详情：分类/来源/典型现象/可能原因/处置步骤都在，且是只读的',
      ['典型现象', '可能原因', '处置步骤', '来源'].every(k => (kbRowDetail.body || '').includes(k)) &&
      kbRowDetail.inputs === 0,
      `inputs=${kbRowDetail.inputs} body=${(kbRowDetail.body || '').slice(0, 160)}`)
    // 光有标签不算"看得见内容"：原因/步骤要真的有条目摆出来，否则空标签也全绿。
    check('规程详情：原因与处置步骤真的列了出来（不只是几个空标题）',
      (kbRowDetail.lis || 0) >= 2, `列表条目=${kbRowDetail.lis}`)

    // 整行可点：上面那条优先点按钮，`else row.click()` 的兜底从来没被执行过 ——
    // 于是"@row-click 压根没绑上"这种缺陷能一路全绿。这里单独把点行验一遍。
    const kbRowClick = await session.eval(`(async () => {
      const close = Array.from(document.querySelectorAll('.el-drawer__footer button')).find(b => /关闭/.test(b.textContent))
      if (close) close.click()
      await new Promise(r => setTimeout(r, 700))
      const closed = !document.querySelector('.kb-detail')
      const row = document.querySelector('.kb-table-card .el-table__row')
      if (!row) return { closed, reason: '没有规程行' }
      row.click()
      await new Promise(r => setTimeout(r, 900))
      return { closed, reopened: !!document.querySelector('.kb-detail') }
    })()`)
    check('维修规程库：点整行也能打开详情（一线是习惯性点行的）',
      kbRowClick.closed === true && kbRowClick.reopened === true,
      kbRowClick.reason || JSON.stringify(kbRowClick))
    // 但点行内按钮不能连带开详情（两层的 .stop 保险得真的生效）
    const kbBtnNotHijack = await session.eval(`(async () => {
      const close = Array.from(document.querySelectorAll('.el-drawer__footer button')).find(b => /关闭/.test(b.textContent))
      if (close) close.click()
      await new Promise(r => setTimeout(r, 700))
      const edit = Array.from(document.querySelectorAll('.kb-table-card .el-table__row button')).find(b => /编辑/.test(b.textContent))
      if (!edit) return { reason: '没有编辑按钮' }
      edit.click()
      await new Promise(r => setTimeout(r, 800))
      const r = { dialog: !!document.querySelector('.el-dialog__body .el-form'), drawer: !!document.querySelector('.kb-detail') }
      const cancel = Array.from(document.querySelectorAll('.el-dialog__footer button')).find(b => /取消/.test(b.textContent))
      if (cancel) cancel.click()
      await new Promise(r => setTimeout(r, 600))
      return r
    })()`)
    check('维修规程库：点「编辑」只开编辑框，不会连带弹出详情',
      kbBtnNotHijack.dialog === true && kbBtnNotHijack.drawer === false,
      kbBtnNotHijack.reason || JSON.stringify(kbBtnNotHijack))

    // —— 报障 3：故障案例库无法点击查看详情 ——
    // 案例卡此前只有 hover 抬升，整张卡没有 click；展开的原文行也只是表格行。
    await session.goto(`${BASE}/#/fault-cases`, 2600)
    const caseDetail = await session.eval(`(async () => {
      const card = document.querySelector('.case-card')
      if (!card) return { ok: false, reason: '没有案例卡' }
      card.click()
      await new Promise(r => setTimeout(r, 800))
      const dlg = document.querySelector('.case-detail')
      return { ok: true, opened: !!dlg,
        body: dlg ? dlg.textContent.replace(/\\s+/g, ' ').trim().slice(0, 600) : '' }
    })()`)
    check('故障案例库：点案例卡能打开详情',
      caseDetail.opened === true, caseDetail.reason || JSON.stringify(caseDetail).slice(0, 200))
    check('案例详情：设备/症状/原因/处理/来源工单都能看到（不只卡上那三个字段）',
      ['症状', '原因', '处理', '来源工单'].every(k => (caseDetail.body || '').includes(k)),
      (caseDetail.body || '').slice(0, 200))

    const sampleDetail = await session.eval(`(async () => {
      const bar = document.querySelector('.fault-row')
      if (!bar) return { ok: false, reason: '没有故障排行条' }
      bar.click()
      await new Promise(r => setTimeout(r, 700))
      const row = document.querySelector('.fault-samples .el-table__row')
      if (!row) return { ok: false, reason: '展开后没有原文行' }
      const label = row.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80)
      // 「故障描述（原文）」那一列在表格里是 show-overflow-tooltip，即**被截断**的。
      // 点开就是为了看全 —— 所以拿行里那段原话去详情里比对，比"看得见标签"严得多：
      // 曾经这里只断言标签名存在，详情里一个字的正文都没有也照样全绿。
      const cell = row.querySelectorAll('.cell')[2]
      const rowText = cell ? cell.textContent.replace(/\\s+/g, ' ').trim() : ''
      row.click()
      await new Promise(r => setTimeout(r, 800))
      const dlg = document.querySelector('.case-detail')
      const body = dlg ? dlg.textContent.replace(/\\s+/g, ' ').trim() : ''
      return { ok: true, label, rowText, opened: !!dlg,
        shown: rowText.length > 0 && body.includes(rowText), body: body.slice(0, 500) }
    })()`)
    check('故障案例库：展开的原文行也能点开看全文（不再只有 hover 提示）',
      sampleDetail.opened === true, sampleDetail.reason || JSON.stringify(sampleDetail).slice(0, 200))
    check('原文详情带设备与日期（可追溯到哪台设备哪一天）',
      /设备/.test(sampleDetail.body || '') && /日期/.test(sampleDetail.body || ''),
      (sampleDetail.body || '').slice(0, 200))
    check('原文详情给出完整的故障描述正文（表格里被截断的那段）',
      sampleDetail.shown === true,
      `行内原文「${(sampleDetail.rowText || '').slice(0, 60)}」→ 详情里${sampleDetail.shown ? '有' : '没有'}`)

    // —— 报障 5：聊天记录总是回滚到最前面 ——
    // 先自己造一段存档再"离开再回来"。不自己造的话，前面某段用例（比如 v1 旧备份
    // 兼容导入那条会重置 chatHistory）清过聊天记录，下面两条断言就会在"只显示欢迎语"
    // 的短列表上空过 —— 空过的断言比没有断言更糟，它会假装这层被验证过了。
    await session.goto(`${BASE}/#/ai-assistant`, 3000)
    await session.eval(ASK_HELPER)
    const seedChat = await session.eval(`window.__ask('哪些设备维保超期了')`)
    check('（前置）对话页留下了一段可恢复的存档', !seedChat.error && (seedChat.count || 0) >= 3,
      seedChat.error || `消息数=${seedChat.count}`)

    // 切走再切回来：这就是用户"去别的页面看一眼又回来"的真实路径
    await session.goto(`${BASE}/#/dashboard`, 1600)
    await session.goto(`${BASE}/#/ai-assistant`, 3200)
    const chatRestore = await session.eval(`(async () => {
      const el = document.querySelector('.chat-messages')
      if (!el) return { err: '没有 .chat-messages' }
      let last = null
      for (let i = 0; i < 20; i++) {
        last = { 消息数: document.querySelectorAll('.message').length,
          scrollTop: Math.round(el.scrollTop),
          gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) }
        if (last.gap < 40) break
        await new Promise(r => setTimeout(r, 150))
      }
      return last
    })()`)
    check('返回 AI 助手时确实沿用了存档（否则下面那条会空过）',
      (chatRestore.消息数 || 0) >= 3, JSON.stringify(chatRestore))
    check('返回 AI 助手时聊天记录停在最新一条（不再回滚到最前面）',
      (chatRestore.gap ?? 9999) < 40, JSON.stringify(chatRestore))

    // —— 报障 4：老师傅模式"开了没有启动、无法交互对话" ——
    // 用户路径：系统设置里打开 → 回到 AI 助手。此前页面上没有任何标识，
    // 开场白又被历史记录盖着，看起来就是"没启动"。下面两条断言钉住"看得见 + 真的换了口吻"。
    await session.goto(`${BASE}/#/settings`, 2400)
    const masterOn = await session.eval(`(async () => {
      const { setMasterEnabled, masterEnabled } = await import('/src/utils/masterPersona.js')
      setMasterEnabled(true)
      return masterEnabled()
    })()`)
    await session.goto(`${BASE}/#/ai-assistant`, 3200)
    const masterBadgeOn = await session.eval(`(() => {
      const header = document.querySelector('.chat-card .card-header')
      const badge = header
        ? Array.from(header.querySelectorAll('.el-tag')).map(t => t.textContent.replace(/\\s+/g, '').trim()).find(t => /老师傅/.test(t))
        : null
      const first = document.querySelector('.message')
      return {
        mode: localStorage.getItem('ks:master-mode'),
        badge: badge || null,
        hasArchive: document.querySelectorAll('.message').length >= 3,
        firstText: first ? first.textContent.replace(/\\s+/g, ' ').trim().slice(0, 120) : ''
      }
    })()`)
    check('老师傅模式开关确实写进了本地（前置条件）',
      masterOn === true && masterBadgeOn.mode === '1', JSON.stringify({ masterOn, mode: masterBadgeOn.mode }))
    check('老师傅模式开启后 AI 页面有可见标识（不再是"开了看不出来"）',
      !!masterBadgeOn.badge, JSON.stringify(masterBadgeOn).slice(0, 200))
    check('老师傅模式开启后开场白立即换成老机修口吻（历史记录不能把它盖住）',
      masterBadgeOn.hasArchive === true && /我在这儿盯了|设备维修老手/.test(masterBadgeOn.firstText),
      `hasArchive=${masterBadgeOn.hasArchive} ${masterBadgeOn.firstText}`)

    await session.eval(ASK_HELPER)
    const masterAsk = await session.eval(`window.__ask('回转马达异响怎么回事')`)
    check('老师傅模式下问故障现象是在"对话"：得到解答，而不是一张写库确认卡',
      !masterAsk.error && !/我识别到你要/.test(masterAsk.full || '') && (masterAsk.full || '').length > 30,
      masterAsk.error || (masterAsk.text || '').slice(0, 200))
    check('老师傅模式下问故障现象能命中本地规程/排查思路（不是一句"查不到"）',
      !masterAsk.error && (masterAsk.refs || []).length > 0 && !/查不到|没有检索到/.test(masterAsk.full || ''),
      masterAsk.error || `refs=${(masterAsk.refs || []).join(' | ')} text=${(masterAsk.text || '').slice(0, 120)}`)
    // 上面那条只要求"有出处"，而实测有出处仍然答非所问：
    // 问「回转马达异响怎么回事」，依据是《QY25K5D 汽车起重机 技术规格书》第 4 页、
    // 《XCA60E 全地面起重机 技术规格书》第 4 页、「发动机异响」—— 非空、也都是本地出处，
    // 但上一段刚录入的那条《XE215C 回转马达异响排查》被两页手册原文挤到第 4 名、
    // 被 limit=3 截掉了。演示的关键动作（现场录一条规程 → 立刻问同一个现象）到这里是断的，
    // 而"只要 refs 非空"永远绿。这里就断言**那一条**必须在出处里。
    check('命中出处里有刚在上一段录入的那条本地规程（不能被手册原文挤出前三）',
      !masterAsk.error && (masterAsk.refs || []).some(r => r.includes('回转马达异响排查')),
      masterAsk.error || `refs=${(masterAsk.refs || []).join(' | ')}`)

    // 关掉也要立刻可见（防止"只能开不能关"），顺带把状态还原给后面的用例
    await session.goto(`${BASE}/#/settings`, 2400)
    await session.eval(`(async () => {
      const { setMasterEnabled } = await import('/src/utils/masterPersona.js')
      setMasterEnabled(false)
      return true
    })()`)
    await session.goto(`${BASE}/#/ai-assistant`, 3200)
    const masterOff = await session.eval(`(() => {
      const header = document.querySelector('.chat-card .card-header')
      const badge = header
        ? Array.from(header.querySelectorAll('.el-tag')).map(t => t.textContent.replace(/\\s+/g, '').trim()).find(t => /老师傅/.test(t))
        : null
      const first = document.querySelector('.message')
      const el = document.querySelector('.chat-messages')
      return {
        badge: badge || null,
        firstText: first ? first.textContent.replace(/\\s+/g, ' ').trim().slice(0, 120) : '',
        gap: el ? Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) : null
      }
    })()`)
    check('老师傅模式关闭后标识消失、开场白换回常规口吻（开关两个方向都可见）',
      !masterOff.badge && /我帮你盯了/.test(masterOff.firstText),
      JSON.stringify({ badge: masterOff.badge, firstText: masterOff.firstText }).slice(0, 200))
    check('再回来一次仍然停在最新一条（回滚缺陷不是偶发）',
      (masterOff.gap ?? 9999) < 40, `gap=${masterOff.gap}`)


    // ---------- 8.5 随包示例手册：装完就有真手册可看、可问答 ----------
    // 断言重点不是"数据库里有三行"，而是**资源真的随包发出来了**：
    // 只断言行数的话，拿一份空 JSON 也能过——所以这里直接去取静态文件。
    const BUNDLED = [
      { slug: 'sq10sk3q-manual', title: 'SQ10SK3Q 随车起重机 操作维护手册', pages: 36 },
      { slug: 'xca60e-spec', title: 'XCA60E 全地面起重机 技术规格书', pages: 32 },
      { slug: 'qy25k5d-spec', title: 'QY25K5D 汽车起重机 技术规格书', pages: 18 }
    ]
    const assetProbe = await session.eval(`(async () => {
      const slugs = ${JSON.stringify(BUNDLED.map(b => b.slug))}
      const out = {}
      for (const slug of slugs) {
        const rec = {}
        try {
          const j = await fetch(new URL('manuals/' + slug + '.json', document.baseURI))
          rec.jsonOk = j.ok
          if (j.ok) {
            const parsed = await j.json()
            rec.pages = parsed.pages
            rec.chunks = (parsed.chunks || []).length
            rec.chars = (parsed.chunks || []).reduce((n, c) => n + (c.text || '').length, 0)
          }
        } catch (e) { rec.jsonOk = false; rec.jsonError = String(e) }
        try {
          const p = await fetch(new URL('manuals/' + slug + '.pdf', document.baseURI))
          rec.pdfOk = p.ok
          rec.pdfBytes = p.ok ? (await p.blob()).size : 0
        } catch (e) { rec.pdfOk = false; rec.pdfError = String(e) }
        out[slug] = rec
      }
      return out
    })()`)
    for (const b of BUNDLED) {
      const r = assetProbe[b.slug] || {}
      check(`随包手册资源可取：${b.slug}（文字层 ${r.chunks || 0} 页 / 原件 ${Math.round((r.pdfBytes || 0) / 1024)}KB）`,
        r.jsonOk && r.pdfOk && r.chunks > 0 && r.pages === b.pages && r.pdfBytes > 100 * 1024,
        JSON.stringify(r).slice(0, 180))
    }

    await session.goto(`${BASE}/#/documents`, 2800)
    const docsPage = await session.eval(`(() => {
      const rows = Array.from(document.querySelectorAll('.el-table__row')).map(r => r.textContent.replace(/\\s+/g, ' ').trim())
      const cards = Array.from(document.querySelectorAll('.stat-card, .stat-item, .el-card')).map(e => e.textContent.replace(/\\s+/g, ' ').trim()).join(' ')
      return { rows, count: rows.length, cards: cards.slice(0, 220) }
    })()`)
    for (const b of BUNDLED) {
      const row = docsPage.rows.find(r => r.includes(b.title))
      check(`手册库首屏就有随包示例「${b.title.slice(0, 18)}…」`, !!row, row || docsPage.rows.join(' / ').slice(0, 180))
      // "可问答"而不是"仅查看"：说明随包的是带文字层的真手册，不是扫描件占位
      check(`随包示例「${b.slug}」状态为可问答（${b.pages} 页）`,
        !!row && row.includes('可问答') && !row.includes('仅查看'), row || '')
    }
    // 断言取的是卡片上的**数字**，不是"文本里有'手册资料'四个字"：
    // 卡片 label 与 value 是两个节点，textContent 拼出来是"手册资料3 份"（中间没有空格）。
    // 注意这里不在模板字符串里，正则就是普通正则——写成 \\s 会变成"反斜杠 + s"，
    // 永远匹配不上（第一版就是这么写的，报出来的 detail 里明明写着 3 份却没通过）。
    const statDocs = docsPage.cards.match(/手册资料\D{0,6}?(\d+)\s*份/)
    const statPages = docsPage.cards.match(/累计页数\D{0,6}?(\d+)\s*页/)
    check(`手册库统计把随包示例算进去（${statDocs ? statDocs[1] : '?'} 份 / ${statPages ? statPages[1] : '?'} 页）`,
      !!statDocs && Number(statDocs[1]) >= BUNDLED.length && !!statPages && Number(statPages[1]) >= 80,
      docsPage.cards)

    // 真去问一句手册上的内容：回答必须带《手册名》第 N 页的出处（可审计）
    await session.goto(`${BASE}/#/ai-assistant`, 2800)
    await session.eval(ASK_HELPER)
    const manualAsk = await session.eval(`window.__ask('SQ10SK3Q 随车起重机操作维护手册里，液压系统怎么保养？')`)
    check('AI 能回答随包手册里的内容，并给出页码出处',
      !manualAsk.error && (manualAsk.refs || []).some(r => r.includes('第') && r.includes('页')),
      manualAsk.error || (manualAsk.refs || []).join(' | ') || manualAsk.text)

    // ⚠️ 上面这条断言**验证的比它的名字少**：它只要求"出现了第 N 页"，不要求
    // 那一页真的讲你问的东西。所以它一直是绿的 —— 而检索其实按**文档元数据**
    // 打分，同一本手册的每个切片元数据完全相同 → 全部同分 → 稳定排序恒返回
    // 第 1/2/3 页。换句话说：问液压得到的是封面和目录，断言照样通过。
    //
    // 下面这条才是真正能抓到它的：**两个内容毫不相干的问题，必须引用不同的页**。
    // 检索只要还是"元数据同分"，两个问题就会返回同一组页码（1/2/3），立刻报警。
    const pageOf = (r) => { const m = String(r).match(/第\s*(\d+)\s*页/); return m ? Number(m[1]) : null }
    const hydAsk = await session.eval(`window.__ask('SQ10SK3Q 随车起重机操作维护手册里，液压系统怎么保养？')`)
    const wireAsk = await session.eval(`window.__ask('SQ10SK3Q 随车起重机操作维护手册里，钢丝绳多久检查一次？')`)
    const hydPages = (hydAsk.refs || []).map(pageOf).filter(p => p !== null)
    const wirePages = (wireAsk.refs || []).map(pageOf).filter(p => p !== null)
    check('手册检索按正文相关度选页（两个不同问题不能引用同一组页）',
      hydPages.length > 0 && wirePages.length > 0 &&
        hydPages.join(',') !== wirePages.join(','),
      `液压 → 第 ${hydPages.join('/')} 页 ｜ 钢丝绳 → 第 ${wirePages.join('/')} 页`)

    // 上面那条只证明"两次引用不一样"，**证明不了"引对了"**。随包手册正文是
    // 英文原版，中文提问跟页面文字本来没有公共子串：修好之前检索稳定地引用
    // 第 1/2/3 页（封面、目录），而"两条不一样"当时照样能成立（1/2/3 vs 1/4/5）。
    // 所以这里直接查引用的正文本身讲没讲所问的东西。
    // 答文里本来就嵌着切片原文（appStore.answerItems 的 steps），不必另开接口。
    const hydFull = hydAsk.full || ''
    const wireFull = wireAsk.full || ''
    const hydHasTerm = /hydraulic/i.test(hydFull)
    const wireHasTerm = /\brope\b/i.test(wireFull)
    check('引用的页确实在讲所问的内容（液压页出现 hydraulic、钢丝绳页出现 rope）',
      hydHasTerm && wireHasTerm,
      `答文含 hydraulic=${hydHasTerm}、含 rope=${wireHasTerm}`)

    // 说明：口述录入（自然语言→结构化写入）的端到端验收已拆分到独立文件，
    // 由 scripts/e2e-nl.mjs 承载（npm run e2e:nl），覆盖率更全且避免单文件过长。

    // ---------- 9. 备件扣减链：记录里写了换件 → 库存必须真的减 ----------
    // 这条链曾经静默失效：维保记录里的件名（"机油+三滤套装"）与备件台账的标准件名
    // （"机油滤芯"）对不上，consumePartsFromText 匹配不到就 continue，
    // 结果是"记录里明明换了件，库存分文未动"，而且不报错、界面上看不出来。
    const PART_NAME = '液压油46号'

    /** 读某备件的当前库存（从台账行文本里取"库存"那一格） */
    const readStockExpr = `(() => {
      const row = Array.from(document.querySelectorAll('.el-table__row'))
        .find(r => r.textContent.includes(${JSON.stringify(PART_NAME)}))
      if (!row) return null
      const cell = row.querySelector('.stock-ok, .stock-low')
      return cell ? Number(cell.textContent.trim()) : null
    })()`

    await session.goto(`${BASE}/#/parts-inventory`, 2600)
    const stockBefore = await session.eval(readStockExpr)

    // 去设备台账，给第一台设备记一条"带配件"的维保
    await session.goto(`${BASE}/#/equipment`, 2600)
    const recorded = await session.eval(`(async () => {
      const btn = Array.from(document.querySelectorAll('.equip-actions button')).find(b => /记录维保/.test(b.textContent))
      if (!btn) return { ok: false, reason: '找不到记录维保按钮' }
      btn.click()
      await new Promise(r => setTimeout(r, 600))
      const dlg = document.querySelector('.el-dialog')
      if (!dlg) return { ok: false, reason: '维保对话框未打开' }
      const setVal = (el, val) => {
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const byPh = (ph) => Array.from(dlg.querySelectorAll('input, textarea')).find(e => e.placeholder && e.placeholder.includes(ph))
      const desc = byPh('更换液压油')
      const parts = byPh('液压油46号 200L')
      if (!desc || !parts) return { ok: false, reason: '找不到维保内容或领用备件输入框' }
      setVal(desc, '更换液压油及液压油滤芯，检查液压系统压力')
      setVal(parts, ${JSON.stringify(PART_NAME)})
      await new Promise(r => setTimeout(r, 300))
      const save = Array.from(dlg.querySelectorAll('button')).find(b => /保存|确定|提交/.test(b.textContent))
      if (!save) return { ok: false, reason: '找不到保存按钮' }
      save.click()
      await new Promise(r => setTimeout(r, 1600))
      // 以"弹出的是成功提示"为准：只点了按钮不算数
      const toasts = Array.from(document.querySelectorAll('.el-message')).map(e => e.textContent.trim())
      return { ok: true, saved: toasts.some(t => /已为.*记录维保/.test(t)), toasts }
    })()`)
    check('设备台账可记录一条带配件的维保', recorded.ok && recorded.saved === true, JSON.stringify(recorded).slice(0, 200))

    await session.goto(`${BASE}/#/parts-inventory`, 2600)
    const stockAfter = await session.eval(readStockExpr)
    check('记录维保后对应备件库存真的扣减了 1 件',
      typeof stockBefore === 'number' && typeof stockAfter === 'number' && stockAfter === stockBefore - 1,
      `${PART_NAME}：${stockBefore} → ${stockAfter}`)

    // 流水里能查到这次领用（不是只改了数字，而是留了痕）
    const flow = await session.eval(`(async () => {
      const row = Array.from(document.querySelectorAll('.el-table__row'))
        .find(r => r.textContent.includes(${JSON.stringify(PART_NAME)}))
      if (!row) return { ok: false, reason: '找不到备件行' }
      const btn = Array.from(row.querySelectorAll('button')).find(b => /流水/.test(b.textContent))
      if (!btn) return { ok: false, reason: '找不到流水按钮' }
      btn.click()
      await new Promise(r => setTimeout(r, 900))
      const dlg = document.querySelector('.el-dialog')
      const rows = Array.from((dlg || document).querySelectorAll('.el-table__row')).map(r => r.textContent.replace(/\\s+/g, ' ').trim())
      const texts = (dlg || document).textContent
      return { ok: /领用|出库/.test(texts), rows: rows.length }
    })()`)
    check('备件流水留下领用记录（扣减可追溯）', flow.ok === true, JSON.stringify(flow).slice(0, 160))

    // ---------- 10. 操作日志：写入留痕 + 刷新仍在 ----------
    // 日志此前只活在内存里，刷新即清空，"全量留痕"名不副实。
    await session.goto(`${BASE}/#/logs`, 2600)
    const logsBefore = await session.eval(`(() => {
      const items = Array.from(document.querySelectorAll('.log-content')).map(e => e.textContent.trim())
      return { count: items.length, hasMaintenance: items.some(t => /记录维保/.test(t)) }
    })()`)
    check('操作日志页能看到刚才那次维保记录', logsBefore.hasMaintenance === true, JSON.stringify(logsBefore))

    await session.goto(`${BASE}/#/logs`, 2600)
    const logsReloaded = await session.eval(`(() => {
      const items = Array.from(document.querySelectorAll('.log-content')).map(e => e.textContent.trim())
      return { count: items.length, hasMaintenance: items.some(t => /记录维保/.test(t)) }
    })()`)
    check('刷新后操作日志仍在（日志已真正落库，不只在内存）',
      logsReloaded.hasMaintenance === true && logsReloaded.count === logsBefore.count,
      `刷新前 ${logsBefore.count} 条 / 刷新后 ${logsReloaded.count} 条`)

    // ---------- 10b. 告警处置：标记后刷新仍在 ----------
    // 处置状态此前存在 localStorage，导入/重置后与库里的数据对不上。
    await session.goto(`${BASE}/#/alert-center`, 2800)
    const alertMarked = await session.eval(`(async () => {
      const before = document.querySelectorAll('.alert-row').length
      const btn = Array.from(document.querySelectorAll('.alert-actions button')).find(b => /标记已处理/.test(b.textContent))
      if (!btn) return { ok: false, reason: '找不到标记已处理按钮', before }
      btn.click()
      await new Promise(r => setTimeout(r, 1200))
      return {
        ok: true,
        before,
        after: document.querySelectorAll('.alert-row').length,
        dashText: (document.querySelector('.alert-dash') || {}).textContent || ''
      }
    })()`)
    check('告警中心：标记已处理后该条从列表移除',
      alertMarked.ok && alertMarked.after === alertMarked.before - 1,
      JSON.stringify(alertMarked).slice(0, 200))

    await session.goto(`${BASE}/#/alert-center`, 2800)
    const alertReloaded = await session.eval(`(() => ({
      rows: document.querySelectorAll('.alert-row').length,
      dashText: (document.querySelector('.alert-dash') || {}).textContent || ''
    }))()`)
    check('刷新后处置状态仍在（告警处置已随库持久化）',
      alertReloaded.rows === alertMarked.after,
      `刷新前 ${alertMarked.after} 行 / 刷新后 ${alertReloaded.rows} 行`)

    // ---------- 10c. Excel 智能解析：加载示例 → 导入台账 ----------
    // 放在最后（重置之前）：导入会真的往台账里加设备、动备件库存，
    // 前面的断言都建立在"60 台原始演示数据"上，不能让它搅进来。
    await session.goto(`${BASE}/#/ai-assistant`, 2800)
    const excelDemo = await session.eval(`(async () => {
      // 切到 Excel 页签
      const tab = Array.from(document.querySelectorAll('.el-tabs__item')).find(t => /Excel/.test(t.textContent))
      if (!tab) return { ok: false, reason: '找不到 Excel 页签' }
      tab.click()
      await new Promise(r => setTimeout(r, 800))

      const demoBtn = Array.from(document.querySelectorAll('button')).find(b => /加载演示数据/.test(b.textContent))
      if (!demoBtn) return { ok: false, reason: '找不到加载演示数据按钮' }
      demoBtn.click()
      await new Promise(r => setTimeout(r, 1500))

      const files = Array.from(document.querySelectorAll('.file-name')).map(e => e.textContent.trim())
      const stats = Array.from(document.querySelectorAll('.parse-stats .el-descriptions__label, .parse-stats .el-descriptions__content'))
        .map(e => e.textContent.trim())
      // 解析结果表里的机型列
      const headers = Array.from(document.querySelectorAll('.el-table__header th .cell')).map(e => e.textContent.trim())
      const modelCol = headers.indexOf('设备型号')
      const models = modelCol < 0 ? [] : Array.from(document.querySelectorAll('.el-table__body .el-table__row'))
        .map(r => r.querySelectorAll('.cell')[modelCol]?.textContent.trim()).filter(Boolean)

      const importBtn = Array.from(document.querySelectorAll('button')).find(b => /导入设备台账/.test(b.textContent))
      if (!importBtn) return { ok: false, reason: '找不到导入台账按钮', files, models }
      importBtn.click()
      await new Promise(r => setTimeout(r, 3000))

      const report = (document.querySelector('.import-report') || {}).textContent || ''
      return { ok: true, files, stats, models, report: report.replace(/\\s+/g, ' ').trim().slice(0, 200) }
    })()`)

    check('示例 Excel 可一键加载（5 个部门的表格）',
      excelDemo.ok && (excelDemo.files || []).length === 5,
      (excelDemo.files || []).join('、') || excelDemo.reason)
    check('示例设备的机型是徐工为主（不是一排竞品机型）',
      (excelDemo.models || []).length >= 8 && excelDemo.models.filter(m => /徐工/.test(m)).length >= 5,
      (excelDemo.models || []).join('、'))
    check('示例 Excel 可一键导入台账并给出结果',
      /新增 \d+ 台/.test(excelDemo.report || ''), excelDemo.report)

    // ---------- 11. 重置演示数据仍可用 ----------
    await session.goto(`${BASE}/#/dashboard`, 2400)
    const reset = await session.eval(`(async () => {
      const btn = Array.from(document.querySelectorAll('.aside-footer button')).find(b => /重置演示数据/.test(b.textContent))
      if (!btn) return { ok: false, reason: '找不到重置按钮' }
      btn.click()
      await new Promise(r => setTimeout(r, 900))
      const confirm = Array.from(document.querySelectorAll('.el-message-box__btns button')).find(b => /确认重置/.test(b.textContent))
      if (!confirm) return { ok: false, reason: '找不到确认按钮' }
      confirm.click()
      await new Promise(r => setTimeout(r, 3000))
      return {
        ok: true,
        statValues: Array.from(document.querySelectorAll('.stat-value')).map(e => e.textContent.trim()),
        closing: document.querySelector('.closing-ring')?.textContent.trim(),
        storeLen: document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app').equipmentList.length,
        toasts: Array.from(document.querySelectorAll('.el-message')).map(e => e.textContent.replace(/\\s+/g, ' ').trim())
      }
    })()`)
    check('重置演示数据可用（store 回到 60 台）',
      reset.ok && reset.storeLen === 60, JSON.stringify(reset))

    // 必须真的 reload（Page.navigate 到同一个含 hash 的 URL 属于同文档导航，不会重新加载），
    // 这样才既验证了卡片会跟着重置刷新，又证明重置是真落了盘而不只是改了内存。
    await session.send('Page.reload', { ignoreCache: false })
    await sleep(4500)
    const resetAfterReload = await session.eval(`(() => ({
      statValues: Array.from(document.querySelectorAll('.stat-value')).map(e => e.textContent.trim()),
      closing: document.querySelector('.closing-ring')?.textContent.trim()
    }))()`)
    check('重置后刷新仍然是 60 台（重置已落盘）',
      resetAfterReload.statValues?.[0] === '60',
      `${resetAfterReload.statValues?.join(',')} | 闭环率 ${resetAfterReload.closing}`)

    // ---------- 12. 引导演示：入口下拉（真鼠标）+ 手动推进 + 首启只播一次 ----------
    /**
     * 用**真实**鼠标事件（CDP Input.dispatchMouseEvent）点一个元素，并回报命中检测结果。
     *
     * 本节为什么不能用别处到处在用的 `element.click()`：合成点击**绕过命中检测** ——
     * 元素被别的层盖住、尺寸为 0×0、乃至根本不可交互，`click()` 一样返回"成功"。
     * 引导演示的下拉就这样在自动化里长期全绿：触发器里套了个 el-tooltip，
     * el-dropdown 拿到的是**组件**而不是元素触发器，popper 于是从不定位，
     * 菜单在 DOM 里存在、rect 恒为 0×0 —— 人眼看到的是"按钮在，下拉空/点不动"。
     * 本节存在的首要理由是守住这个缺陷，所以点击必须走真鼠标。
     */
    async function realClickEl(sess, expr, label) {
      const probe = await sess.eval(`(() => {
        const el = ${expr}
        if (!el) return { err: '找不到元素' }
        const b = el.getBoundingClientRect()
        if (!b.width || !b.height) return { err: '元素尺寸为 0×0' }
        const x = Math.round(b.left + b.width / 2)
        const y = Math.round(b.top + b.height / 2)
        const hit = document.elementFromPoint(x, y)
        return { x, y, hitSelf: !!hit && (hit === el || el.contains(hit)), hitTag: (hit && (hit.className || hit.tagName)) || null }
      })()`)
      if (probe.err) return { ok: false, err: `${label}：${probe.err}` }
      await sess.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: probe.x, y: probe.y, button: 'none', buttons: 0 })
      await sleep(120)
      await sess.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: probe.x, y: probe.y, button: 'left', buttons: 1, clickCount: 1 })
      await sleep(60)
      await sess.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: probe.x, y: probe.y, button: 'left', buttons: 0, clickCount: 1 })
      return { ok: true, hitSelf: probe.hitSelf, hitTag: probe.hitTag, at: `${probe.x},${probe.y}` }
    }

    /** 引导演示的当场状态（弹层 / 工具条模式 / 首启标记） */
    const TOUR_STATE = `(() => {
      const pop = document.querySelector('.driver-popover')
      const bar = document.querySelector('.demo-bar')
      const modeEl = bar && (bar.querySelector('.demo-bar-manual') || bar.querySelector('.demo-bar-auto'))
      return {
        hasPopover: !!pop,
        title: pop ? (pop.querySelector('.driver-popover-title') || {}).textContent : null,
        progress: pop ? (pop.querySelector('.driver-popover-progress-text') || {}).textContent : null,
        barMode: modeEl ? modeEl.textContent : null,
        seen: (() => { try { return localStorage.getItem('ks:tour-seen') } catch { return '‹不可读›' } })()
      }
    })()`

    await session.goto(`${BASE}/#/dashboard`, 2600)

    // 12a) 右上角入口：真鼠标点得开、菜单有真实尺寸
    const trigger = await realClickEl(session,
      `[...document.querySelectorAll('.header-right button')].find(b => /引导演示/.test(b.textContent))`, '引导演示按钮')
    await sleep(700)
    const menuBox = await session.eval(`(() => {
      const m = document.querySelector('.el-dropdown-menu')
      if (!m) return null
      const b = m.getBoundingClientRect()
      const item = m.querySelector('.el-dropdown-menu__item')
      const ib = item && item.getBoundingClientRect()
      return { w: Math.round(b.width), h: Math.round(b.height), itemW: ib ? Math.round(ib.width) : 0 }
    })()`)
    const pick = await realClickEl(session, `document.querySelector('.el-dropdown-menu__item')`, '主线菜单项')
    await sleep(2500)
    let t = await session.eval(TOUR_STATE)
    check('引导演示：真鼠标点得开下拉（菜单有真实尺寸，不是 0×0）',
      !!menuBox && menuBox.w > 100 && menuBox.h > 60 && menuBox.itemW > 100,
      `触发器 ${trigger.err || trigger.at} | 菜单 ${JSON.stringify(menuBox)}`)
    check('引导演示：真鼠标点菜单项能启动并停在第一步',
      t.hasPopover && /欢迎/.test(t.title || '') && (t.progress || '').trim() === '1 / 12',
      `${pick.err || pick.at} | ${t.title || '(无卡片)'} | ${t.progress}`)
    check('引导演示：默认手动推进（工具条不喊"自动演示中"）',
      t.barMode === '手动推进', String(t.barMode))

    // 12b) 手动推进：真点卡片上的「下一步」
    const nextBtn = await realClickEl(session, `document.querySelector('.driver-popover-next-btn')`, '下一步按钮')
    await sleep(2200)
    t = await session.eval(TOUR_STATE)
    check('引导演示：真点「下一步」前进到第二步',
      (t.progress || '').trim() === '2 / 12',
      `${nextBtn.err || nextBtn.at} | ${t.title || '(无卡片)'} | ${t.progress}`)

    // 12c) 工具条上那颗双角色按钮：手动模式下按它应切到自动，而不是按下去没反应
    //      （改版前 togglePause 只翻 paused、不把 playing 置真，这颗按钮在手动模式下是死的）
    const playBtn = await realClickEl(session, `document.querySelector('.demo-bar button[aria-label="开始自动演示"]')`, '开始自动演示按钮')
    await sleep(900)
    const autoMode = await session.eval(`(() => { const b = document.querySelector('.demo-bar-auto'); return b ? b.textContent : null })()`)
    check('引导演示：手动模式下按播放键能切到自动演示（不是死按钮）',
      playBtn.ok === true && autoMode === '自动演示中',
      `${playBtn.err || playBtn.at} | ${autoMode}`)

    // 12d) 退出：卡片与工具条都收干净。
    //      这颗按钮带字（「跳过引导」）而不是一颗 ✕ —— 首启这条路是应用自己弹出来的，
    //      出口得让人一眼看懂，所以连 aria-label 也一起跟着改了口径。
    const exitBtn = await realClickEl(session, `document.querySelector('.demo-bar button[aria-label="跳过引导"]')`, '跳过引导按钮')
    await sleep(900)
    const closed = await session.eval(`({
      popoverGone: !document.querySelector('.driver-popover'),
      barGone: !document.querySelector('.demo-bar')
    })`)
    check('引导演示：点「跳过引导」后卡片与工具条都消失',
      closed.popoverGone === true && closed.barGone === true,
      `${exitBtn.err || exitBtn.at} | ${JSON.stringify(closed)}`)

    // 12e) 首启只播一次：撤回播种 → 清标记 → **整页重载**，这时才走得到真正的首启路径
    //      两处顺序都有讲究：
    //        · 注入按文档生效，不先撤回的话重载会把标记又种回来，首启永远测不到；
    //        · 首启判定挂在 onMounted 上，所以必须让文档**真的重建**。同一个 URL
    //          （只有 hash 不同）的 navigate 是片段导航，应用不重新挂载 ——
    //          写成 goto(`${BASE}/#/dashboard`) 的话这几条会齐刷刷地"没有弹层"。
    //        · 撤回之后要**单独把「设置 PIN」那一屏的标记种回去**（tour:false）：
    //          这几条验的是引导，而设锁那一屏紧接着的重载就会先弹出来、把主应用挡在
    //          外面 —— 那样下面这一串会以"没有弹层"的形式整片红，看着像引导坏了。
    //          那一屏本身由第 16 段验，这里让它保持"已经过去"的状态。
    await unseedFirstRun(session, firstRunSeed)
    const lockSetupSeed = await seedFirstRun(session, { tour: false })
    await session.eval(`localStorage.removeItem('ks:tour-seen')`)
    await session.goto(`${BASE}/#/dashboard`, 1200)
    await session.send('Page.reload')
    await sleep(9000)
    t = await session.eval(TOUR_STATE)
    check('首启：全新状态打开会自动弹出引导演示（停在第 1 步）',
      t.hasPopover && (t.progress || '').trim() === '1 / 12',
      `${t.title || '(无卡片)'} | ${t.progress}`)
    check('首启：默认手动 —— 等人点，不自己走', t.barMode === '手动推进', String(t.barMode))

    await sleep(4500)
    const waited = await session.eval(TOUR_STATE)
    check('首启：干等 4.5 秒仍停在 1 / 12（默认手动，不自动前进）',
      (waited.progress || '').trim() === '1 / 12' && waited.progress === t.progress,
      `${t.progress} → ${waited.progress}`)

    const firstNext = await realClickEl(session, `document.querySelector('.driver-popover-next-btn')`, '下一步按钮')
    await sleep(2200)
    t = await session.eval(TOUR_STATE)
    check('首启：点一下「下一步」就前进到 2 / 12',
      (t.progress || '').trim() === '2 / 12', `${firstNext.err || firstNext.at} | ${t.progress}`)
    check('首启：播放过的标记已落盘（ks:tour-seen=1）', t.seen === '1', String(t.seen))

    // 12f) 看过之后不再自动打扰（但入口仍可重播，12a 已经验过）
    await session.send('Page.reload')
    await sleep(6000)
    t = await session.eval(TOUR_STATE)
    check('首启只播一次：刷新后不再自动弹（不打扰老用户）',
      !t.hasPopover, t.hasPopover ? '又自动弹了' : '无弹层')

    // ---------- 13. 错误边界：运行期异常要变成可见提示，而不是白屏 ----------
    /**
     * 为什么这一段必须在**真实浏览器**里跑，store-check 不够：
     *   store-check 只能证明"处理器本身行为正确"，证明不了另外两件事 ——
     *   (1) main.js 真的把处理器装到了应用实例上（少写那一行，那边的断言照样全绿）；
     *   (2) App.vue 真的把 appError 渲染成了提示条（拿掉模板，也是全绿）。
     *   一段"三层中只测了中间层"的守卫生效范围，正是这次要修的那类问题。
     *
     * 触发方式用 `window.dispatchEvent(new ErrorEvent(...))`：这是四条入口之一
     * （组件外同步异常）的**真实**路径，走的是 installErrorBoundaries 里挂上的监听器。
     * 它不产生 uncaught exception，所以不会被本脚本顶部的 exceptionThrown 统计误伤。
     *
     * 诚实的边界：这一段没有让某个组件**真的渲染失败**（那需要在页面上下文里
     * 注坏一份数据，跨重构极易失效）。所以它证明的是"处理器在位 + 提示条会渲染 +
     * 日志会落"，Vue 把组件内异常路由到 errorHandler 这一点由 store-check 覆盖，
     * 两者合起来才是完整的一条链。
     */
    const ERR_MSG = 'e2e 探针：这一页渲染炸了'
    const errWired = await session.eval(`(() => {
      const app = document.querySelector('#app').__vue_app__
      return { hasHandler: typeof app.config.errorHandler === 'function' }
    })()`)
    check('错误边界：main.js 真的把处理器装到了应用实例上（不是只写了个模块）',
      errWired.hasHandler === true, String(errWired.hasHandler))

    const errReported = await session.eval(`(async () => {
      window.dispatchEvent(new ErrorEvent('error', {
        message: '${ERR_MSG}',
        error: new Error('${ERR_MSG}')
      }))
      // 必须等一拍再读 DOM：错误处理是同步的，但 Vue 的 DOM 更新是**异步**的
      // （nextTick 批量 flush）。同步读会读到"提示条还没渲染"的中间态，
      // 把一次正常的异步更新误判成白屏 —— 这条断言第一次写就是这么红的。
      await new Promise(r => setTimeout(r, 400))
      const bar = document.querySelector('.error-bar')
      return {
        appeared: !!bar,
        text: bar ? bar.textContent.replace(/\\s+/g, ' ').trim() : '',
        hasRecover: !!document.querySelector('.error-bar-actions button'),
        // 出错后界面必须还活着：main 区还有内容，没变成一块白屏
        mainAlive: !!document.querySelector('.app-main') && document.querySelector('.app-main').textContent.trim().length > 0
      }
    })()`)
    check('错误边界：真实异常后界面出现提示条（不是白屏）',
      errReported.appeared === true, errReported.appeared ? '提示条在' : '没有提示条（就是白屏）')
    check('错误边界：提示条写明原因与出错位置',
      errReported.text.includes(ERR_MSG) && /窗口运行时/.test(errReported.text),
      errReported.text.slice(0, 120) || '(空)')
    check('错误边界：提示条交代"其它功能不受影响"的恢复口径',
      /其它功能不受影响/.test(errReported.text) && /重启应用/.test(errReported.text),
      errReported.text.slice(0, 120) || '(空)')
    check('错误边界：给出可点的恢复入口（返回看板 / 重新加载界面）',
      errReported.hasRecover === true, String(errReported.hasRecover))
    check('错误边界：出错后主内容区仍然有内容（提示条与被提示对象不在同一棵子树）',
      errReported.mainAlive === true, String(errReported.mainAlive))

    // 日志：现场没有开发控制台，操作日志是唯一能回答"刚才怎么了"的地方
    const errLogged = await session.eval(`(() => {
      const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app')
      const first = store.recentLogs[0]
      return { content: String(first && first.content || ''), source: String(first && first.source || '') }
    })()`)
    check('错误边界：异常写进了本机操作日志（离线现场唯一的事后凭据）',
      errLogged.content.includes(ERR_MSG) && errLogged.source === '错误边界',
      errLogged.content.slice(0, 120) || '(日志为空)')

    // 「知道了」必须真的收掉提示条 —— 一条永远消不掉的红色横幅会把正常界面也弄得像坏了
    const dismissed = await session.eval(`(async () => {
      const btn = Array.from(document.querySelectorAll('.error-bar-actions button'))
        .find(b => b.textContent.trim() === '知道了')
      if (!btn) return { ok: false, why: '找不到「知道了」按钮' }
      btn.click()
      await new Promise(r => setTimeout(r, 400))
      return { ok: !document.querySelector('.error-bar') }
    })()`)
    check('错误边界：点「知道了」后提示条消失（否则正常界面也像坏的）',
      dismissed.ok === true, dismissed.why || '已收掉')

    // 恢复之后应用要还能用：换一个页面走一遍，证明出错没把路由/渲染拖坏
    // 用 .equip-card 而不是 .el-table__row：设备台账是**卡片**列表不是表格，
    // 拿表格行数当"渲染成功"的判据会恒为 0，把一次正常换页判成失败。
    const afterErrNav = await session.eval(`(async () => {
      location.hash = '#/equipment'
      await new Promise(r => setTimeout(r, 1500))
      return {
        cards: document.querySelectorAll('.equip-card').length,
        stillClean: !document.querySelector('.error-bar')
      }
    })()`)
    check('错误边界：出错后换页仍然正常渲染（错误没有拖坏整棵应用）',
      afterErrNav.cards > 0 && afterErrNav.stillClean === true,
      `设备卡片 ${afterErrNav.cards} 张 / 提示条残留 ${!afterErrNav.stillClean}`)

    // ---------- 13b. 窄屏响应式：关键列让位，而不是挤出横向滚动条（P3-1） ----------
    /**
     * 为什么要在真浏览器里断这一条：`v-if="!isNarrow"` 对不对，只有把视口真的改窄
     * 才知道 —— self-check 只能证明"这个视图调了 useNarrowMode()"，证明不了断点
     * 生效、更证明不了"摘完之后表就不滚了"。而这一项**历史上正是靠人眼漏过去的**：
     * 1440px（就是本套件用的视口）下病历表本来溢出 180px，门禁一路全绿。
     *
     * 量法：改视口宽（不刷新，走的是 resize 监听那条路）→ 读每张表**可见表头**与
     * `body-wrapper` 里 scrollWidth - clientWidth。判据三条：
     *   ① 该在的关键列在（摘错了列 = 把功能摘没了）；
     *   ② 不该在的次要列不在（断点没生效 = 白摘）；
     *   ③ 表格不横向溢出（摘完还滚 = 摘得不够，本项要修的正是这个）。
     * 再加一条 1440 的对照：同一列在宽视口下**必须回来** —— 否则测的是"永久删列"。
     */
    const TABLE_REPORT = `(() => {
      const out = []
      document.querySelectorAll('.el-table').forEach((t, i) => {
        const wrap = t.querySelector('.el-table__body-wrapper .el-scrollbar__wrap') ||
                     t.querySelector('.el-table__body-wrapper')
        out.push({
          i,
          headers: Array.from(t.querySelectorAll('.el-table__header-wrapper th'))
            .map(th => (th.innerText || '').trim()).filter(Boolean),
          overflow: wrap ? Math.max(0, wrap.scrollWidth - wrap.clientWidth) : -1
        })
      })
      return out
    })()`

    /** 走一条路由 → 等表格渲染 → 报每张表的表头与溢出差 */
    const probeTables = async (hash) => {
      await session.eval(`location.hash = '${hash}'`)
      await sleep(2600)
      return session.eval(TABLE_REPORT)
    }

    /** 在若干张表里找出"含有该表头集合"的那一张 */
    const findTable = (tables, mustHave) =>
      tables.find(t => mustHave.every(h => t.headers.includes(h)))

    const setWidth = async (w) => {
      await session.send('Emulation.setDeviceMetricsOverride', { width: w, height: 940, deviceScaleFactor: 1, mobile: false })
      await sleep(600)
    }

    /**
     * 设备病历的两栏布局：是并排还是折成了上下两行，病历卡实际拿到多宽。
     * 1440 与 1100 两档都要用（前者验"并排放得下"、后者验"折成两行"），所以提出来一份 ——
     * 两处各写一遍的话，改了一处另一处就成了摆设。
     */
    const probeMrLayout = () => session.eval(`(() => {
      const report = document.querySelector('.report-card')
      const history = document.querySelector('.history-card')
      if (!report || !history) return { ok: false, why: '找不到两栏容器（设备病历可能没选中设备）' }
      return {
        ok: true,
        stacked: history.getBoundingClientRect().top >= report.getBoundingClientRect().bottom - 1,
        historyW: Math.round(history.getBoundingClientRect().width)
      }
    })()`)

    // 先宽（1440）：作为对照，次要列此时必须都在
    await setWidth(1440)
    const wideKb = await probeTables('#/knowledge-base')
    const wideKbTable = findTable(wideKb, ['条目标题', '来源'])
    check('窄屏对照：1440px 下规程库的「来源」列在（改窄才摘列，不是永久删列）',
      !!wideKbTable && wideKbTable.headers.includes('来源') && wideKbTable.overflow === 0,
      wideKbTable ? `表头 ${wideKbTable.headers.join('/')} · 溢出 ${wideKbTable.overflow}px` : `没找到带「来源」的规程表（现有 ${wideKb.length} 张表）`)

    // 1440 这一档对**设备病历**格外重要，而它原先正是漏在这里：这一档是 e2e 与对比度
    // 门禁用的视口，并排时病历卡只分到 267px、表自然宽 540px ⇒ 溢出 180px。门禁不查溢出，
    // 人工评审看的截图恰好也是这一档 —— 于是它一路全绿地存在着。
    // （这条是后补的：上表 Mn3 把病历卡基准宽打回 300px 时，1100 那两条如实见红，而 1440
    //  这一档**一条断言都没有**、纹丝不动 —— 也就是"缺陷放回去仍然全绿"，那就等于没验。）
    const wideMr = await probeTables('#/medical-records')
    const wideMrTable = findTable(wideMr, ['体检日期'])
    const wideMrLayout = await probeMrLayout()
    check('窄屏对照：1440px 下设备病历两栏是并排的，且病历表分到的宽度放得下它、不溢出（这一档正是门禁视口）',
      wideMrLayout.ok === true && wideMrLayout.stacked === false && wideMrLayout.historyW >= 540 &&
      !!wideMrTable && wideMrTable.overflow === 0,
      wideMrLayout.ok
        ? `折行=${wideMrLayout.stacked} / 病历卡宽 ${wideMrLayout.historyW}px / 溢出 ${wideMrTable ? wideMrTable.overflow : '?'}px（表自然宽 540px）`
        : wideMrLayout.why)

    // 改窄到 1100（不刷新 —— 走的是 useNarrowMode 的 resize 监听）
    await setWidth(1100)

    // ① 维修规程库：摘「分类」「来源」，留标题 / 关键词 / 频次 / 操作
    const kb = await probeTables('#/knowledge-base')
    const kbTable = findTable(kb, ['条目标题'])
    check('窄屏：规程库摘掉「分类」「来源」，保留标题/关键词/频次/操作',
      !!kbTable &&
      ['分类', '来源'].every(h => !kbTable.headers.includes(h)) &&
      ['条目标题', '关键词', '频次', '操作'].every(h => kbTable.headers.includes(h)),
      kbTable ? `表头 ${kbTable.headers.join('/')}` : '没找到规程表')
    check('窄屏：规程库不再横向溢出（摘完之后宽度真的够了）',
      !!kbTable && kbTable.overflow === 0,
      kbTable ? `溢出 ${kbTable.overflow}px` : '没找到规程表')

    // ② 复诊管理：摘「复诊日期」，留「是否到期」——这一页的重点列原先正好被固定列盖住
    const rc = await probeTables('#/recheck')
    const rcTable = findTable(rc, ['复诊内容'])
    check('窄屏：复诊管理摘掉「复诊日期」，但「是否到期」必须还在（它是这页的重点）',
      !!rcTable &&
      !rcTable.headers.includes('复诊日期') &&
      ['设备', '复诊内容', '是否到期', '操作'].every(h => rcTable.headers.includes(h)),
      rcTable ? `表头 ${rcTable.headers.join('/')}` : '没找到复诊表')
    check('窄屏：复诊管理不再横向溢出（原先「是否到期」被右侧固定列盖住）',
      !!rcTable && rcTable.overflow === 0,
      rcTable ? `溢出 ${rcTable.overflow}px` : '没找到复诊表')

    // ③ 手册资料库：摘「大小」「添加时间」，留标题 / 机型 / 可问答 / 操作
    const docs = await probeTables('#/documents')
    const docsTable = findTable(docs, ['可问答'])
    check('窄屏：手册资料库摘掉「大小」「添加时间」，保留标题/机型/可问答/操作',
      !!docsTable &&
      ['大小', '添加时间'].every(h => !docsTable.headers.includes(h)) &&
      ['标题', '机型', '可问答', '操作'].every(h => docsTable.headers.includes(h)),
      docsTable ? `表头 ${docsTable.headers.join('/')}` : '没找到手册表')
    check('窄屏：手册资料库不再横向溢出',
      !!docsTable && docsTable.overflow === 0,
      docsTable ? `溢出 ${docsTable.overflow}px` : '没找到手册表')

    // ④ 设备病历：这一页的问题不在列，在**两栏布局**（并排时病历表只分到 267px，
    //    而表自然宽 540px）—— 所以断言的是"折成上下两行 + 五列都在 + 拿到整行宽度 + 不溢出"，
    //    不是"摘了几列"。判据落在**结果**（病历卡的实际宽度）上，不落在机制上：
    //    折行是靠 flex 基准宽之和超过行宽触发的（无媒体查询、无 JS），
    //    只盯"某个类在不在"会漏掉"类在、但布局没变"这种假绿（变异 Mn3 实测踩到过）。
    const mr = await probeTables('#/medical-records')
    const mrTable = findTable(mr, ['体检日期'])
    const mrLayout = await probeMrLayout()
    check('窄屏：设备病历两栏折成上下两行，病历卡拿回整行宽度（并排时它只有 ~267px）',
      mrLayout.ok === true && mrLayout.stacked === true && mrLayout.historyW >= 700,
      mrLayout.ok ? `折行=${mrLayout.stacked} / 病历卡宽 ${mrLayout.historyW}px（并排时实测 267px）` : mrLayout.why)
    check('窄屏：设备病历折行后五列全在且不溢出（这一页不摘列，靠布局解决）',
      !!mrTable && mrTable.headers.length === 5 && mrTable.overflow === 0,
      mrTable ? `表头 ${mrTable.headers.join('/')} · 溢出 ${mrTable.overflow}px` : '没找到病历表')

    // ⑤ 工单 / 备件：这两张表更早就接了 isNarrow，但**此前一条断言都没有** ——
    //    "写好了没人验"与"没写"在验收上是同一件事（本项顺带补上）
    const wo = await probeTables('#/workorder')
    const woTable = findTable(wo, ['标题'])
    check('窄屏：工单表不溢出（早先接入的 isNarrow 第一次有了断言）',
      !!woTable && woTable.overflow === 0,
      woTable ? `表头 ${woTable.headers.join('/')} · 溢出 ${woTable.overflow}px` : '没找到工单表')
    const pi = await probeTables('#/parts-inventory')
    const piOver = pi.filter(t => t.overflow > 0)
    check('窄屏：备件库存主表不溢出（同上）',
      pi.length > 0 && piOver.length === 0,
      pi.length ? `共 ${pi.length} 张表，溢出 ${piOver.length} 张${piOver.length ? '：' + piOver.map(t => '#' + t.i + '=' + t.overflow + 'px').join(',') : ''}` : '没找到备件表')

    // 收回宽视口：后面几段（应用锁那一段要按文字点按钮）在 1440 下跑
    await setWidth(1440)
    const restored = await session.eval('window.innerWidth')
    check('窄屏：收尾把视口改回 1440（后面几段按 1440 布局写的）',
      restored === 1440, `innerWidth=${restored}`)

    // ---------- 14. 应用锁：启用 ⇒ 刷新 ⇒ 只出锁屏、业务数据不装载（P4-1） ----------
    /**
     * 这一段只能在真实浏览器里断言。store-check / self-check 能证明 appLock.js
     * 的判定是对的，证明不了 main.js 在**装载业务数据之前**问过它一句 ——
     * 而"锁屏出现了"是容易的（App.vue 里加个 v-if 也能做到）。
     * 所以真正的判据是"数据库还没开、store 都没建"：
     * 把判锁挪到 initStore() 之后（或无条件调用 bootAppData），锁屏照样会出现，
     * 只有 isReady 与 $pinia 这两条抓得住。
     *
     * 收尾必须把 ks:app-lock 清干净：本段造的"有账户"状态是临时的，
     * 留着它，之后任何按 hash 跳页的探针都会停在锁屏上。
     */
    await session.goto(`${BASE}/#/settings`, 2400)
    await session.eval(LOCK_HELPER)

    const lockSetup = await session.eval(`(async () => {
      const filled = {}
      filled.name = await window.__setInput('input[placeholder^="姓名"]', '王建国')
      filled.role = await window.__setInput('input[placeholder^="角色"]', '维修工程师')
      filled.pin = await window.__setInput('input[placeholder^="PIN"]', '2468')
      filled.pin2 = await window.__setInput('input[placeholder^="再输一次"]', '2468')
      const clicked = window.__clickText('启用应用锁')
      await new Promise(r => setTimeout(r, 1800))
      const raw = localStorage.getItem('ks:app-lock') || ''
      let acct = {}
      try { acct = (JSON.parse(raw).accounts || [])[0] || {} } catch { /* 没写进去 */ }
      const card = document.querySelector('.settings-page')
      const text = card ? card.innerText.replace(/\\s+/g, ' ') : ''
      return {
        filled, clicked,
        hasConfig: !!raw,
        plainPinInConfig: raw.includes('2468'),
        saltLen: String(acct.salt || '').length,
        hashLen: String(acct.hash || '').length,
        tagOn: /已启用/.test(text),
        actorShown: /本次运行已以/.test(text) && /王建国/.test(text) && /维修工程师/.test(text),
        formCollapsed: !document.querySelector('input[placeholder^="姓名"]')
      }
    })()`)
    check('应用锁：设置页能建账户并启用（四个输入框都真的送进去了）',
      lockSetup.filled.name && lockSetup.filled.role && lockSetup.filled.pin && lockSetup.filled.pin2 && lockSetup.clicked === true,
      JSON.stringify(lockSetup.filled))
    check('应用锁：启用后卡片转为已启用、并写明本次以谁的身份进入',
      lockSetup.tagOn === true && lockSetup.actorShown === true,
      `已启用=${lockSetup.tagOn} 身份行=${lockSetup.actorShown}`)
    check('应用锁：浏览器里落盘的是盐 + 摘要，不是明文 PIN',
      lockSetup.hasConfig && lockSetup.plainPinInConfig === false &&
        lockSetup.saltLen >= 16 && lockSetup.hashLen === 64,
      `有配置=${lockSetup.hasConfig} 含明文=${lockSetup.plainPinInConfig} 盐 ${lockSetup.saltLen} 字符 / 摘要 ${lockSetup.hashLen} 字符`)

    // 刷新 = 重启。锁状态只活在内存里，刷新必然回到锁定态 —— 这正是"启动时锁"
    await reloadUntil(session, '.lock-screen .lock-btn')

    const lockedView = await session.eval(`(async () => {
      const app = document.querySelector('#app').__vue_app__
      const d = await import('/src/utils/database.js')
      return {
        lockScreen: !!document.querySelector('.lock-screen'),
        title: (document.querySelector('.lock-title') || {}).textContent || '',
        who: (document.querySelector('.lock-who-name') || {}).textContent || '',
        whoRole: (document.querySelector('.lock-who-role') || {}).textContent || '',
        statValues: document.querySelectorAll('.stat-value').length,
        appMain: !!document.querySelector('.app-main'),
        aside: !!document.querySelector('.app-aside'),
        cards: document.querySelectorAll('.equip-card').length,
        hasPinia: !!(app && app.config.globalProperties.$pinia),
        dbReady: d.isReady() === true
      }
    })()`)
    check('应用锁：启用后刷新 ⇒ 出现锁屏（"启动时锁"靠的就是刷新即回锁定态）',
      lockedView.lockScreen === true && lockedView.title.includes('矿山智工'),
      `锁屏=${lockedView.lockScreen} 标题「${lockedView.title}」`)
    check('应用锁：锁屏上写明是谁在用、什么身份',
      lockedView.who === '王建国' && lockedView.whoRole === '维修工程师',
      `${lockedView.who || '(空)'} / ${lockedView.whoRole || '(空)'}`)
    check('应用锁：未解锁时业务界面一概没渲染（侧栏与内容区都不在 DOM 里）',
      lockedView.appMain === false && lockedView.aside === false &&
        lockedView.statValues === 0 && lockedView.cards === 0,
      `内容区=${lockedView.appMain} 侧栏=${lockedView.aside} 看板数字 ${lockedView.statValues} 个 / 设备卡片 ${lockedView.cards} 张`)
    check('应用锁：未解锁时业务数据**根本没装载**（数据库没开、store 都没建）',
      lockedView.dbReady === false && lockedView.hasPinia === false,
      `isReady=${lockedView.dbReady} 有 pinia=${lockedView.hasPinia}`)

    await session.eval(LOCK_HELPER)
    const wrongPin = await session.eval(`(async () => {
      const tried = await window.__unlock('9999')
      await new Promise(r => setTimeout(r, 1500))
      const d = await import('/src/utils/database.js')
      const input = document.querySelector('input[placeholder^="PIN"]')
      return {
        tried: tried.ok, why: tried.why || '',
        err: (document.querySelector('.lock-err') || {}).textContent || '',
        stillLocked: !!document.querySelector('.lock-screen'),
        leftover: input ? input.value : '(没有输入框)',
        dbReady: d.isReady() === true
      }
    })()`)
    check('应用锁：错 PIN 明确报错、仍是锁定态、库依然没开',
      wrongPin.tried === true && /PIN 不正确/.test(wrongPin.err) &&
        wrongPin.stillLocked === true && wrongPin.dbReady === false,
      wrongPin.why || `提示「${wrongPin.err.slice(0, 40)}」/ 仍锁=${wrongPin.stillLocked} / isReady=${wrongPin.dbReady}`)
    check('应用锁：错一次就把输入框清空（不让用户自己删了再重输）',
      wrongPin.leftover === '', `输入框残留「${wrongPin.leftover}」`)

    const unlockedView = await session.eval(`(async () => {
      const tried = await window.__unlock('2468')
      // 解锁后要先装载数据库、再换挂主应用，这里轮询而不是死等一个拍脑袋的时长
      const deadline = Date.now() + 12000
      while (Date.now() < deadline && !document.querySelector('.app-main')) {
        await new Promise(r => setTimeout(r, 300))
      }
      const d = await import('/src/utils/database.js')
      const app = document.querySelector('#app').__vue_app__
      return {
        tried: tried.ok, why: tried.why || '',
        lockGone: !document.querySelector('.lock-screen'),
        appMain: !!document.querySelector('.app-main'),
        aside: !!document.querySelector('.app-aside'),
        dbReady: d.isReady() === true,
        hasPinia: !!(app && app.config.globalProperties.$pinia)
      }
    })()`)
    check('应用锁：PIN 正确 ⇒ 锁屏卸掉、主应用挂上，数据库到这一刻才装载',
      unlockedView.tried === true && unlockedView.lockGone && unlockedView.appMain &&
        unlockedView.aside && unlockedView.dbReady && unlockedView.hasPinia,
      unlockedView.why || `锁屏已卸=${unlockedView.lockGone} 内容区=${unlockedView.appMain} 侧栏=${unlockedView.aside} isReady=${unlockedView.dbReady} pinia=${unlockedView.hasPinia}`)

    const afterUnlock = await session.eval(`(async () => {
      location.hash = '#/equipment'
      await new Promise(r => setTimeout(r, 1800))
      return { cards: document.querySelectorAll('.equip-card').length }
    })()`)
    check('应用锁：解锁后业务功能恢复正常（设备台账能正常渲染）',
      afterUnlock.cards > 0, `${afterUnlock.cards} 张设备卡片`)

    // ---------- 14b) 身份进审计 + 界面显示（P4-3）----------
    /**
     * 这一段只证"真实浏览器里看得见的那两层"：
     *   ① 侧边栏底部那行身份真的渲染出来了，文案与解锁的身份一致；
     *   ② 日志页把**这一趟**（解锁之后）产生的日志标上了操作人，而且**每一行**都有
     *      操作人这一栏（不是有的有有的没有）。
     *
     * 「同一页上『带身份的』与『未署名』两种都渲染得出来」这一条放在 14c：
     * 那里对照的两条都是**本趟自己造的**（一条解锁后写、一条没身份时写）。
     * 第一版是在这里翻第 10 节那条老日志来当"未署名"的样本，实测红了 ——
     * 它会被中间那段「清空自救」连数据一起清掉（自救要清库，日志当然也清）。
     * 拿几节之前写下的东西当基准，本来就不是这一节能担保的事。
     *
     * "账户 A ⇒ actor 是 A、切到 B ⇒ actor 是 B、重启后仍读得回"由 store-check 覆盖
     * （那边能把 store 真的重启一遍），这里不重复造。
     */
    const sideIdentity = await session.eval(`(() => {
      const line = document.querySelector('.aside-footer .actor-line')
      return {
        shown: !!line,
        text: line ? line.textContent.trim() : '(没有身份行)',
        tip: line ? (line.getAttribute('title') || '') : ''
      }
    })()`)
    check('身份显示：解锁后侧边栏底部显示当前身份（谁在操作、以谁的名义留痕）',
      sideIdentity.shown === true && sideIdentity.text === '王建国 · 维修工程师' &&
        /记入操作日志/.test(sideIdentity.tip),
      sideIdentity.shown ? `「${sideIdentity.text}」/ ${sideIdentity.tip}` : sideIdentity.text)

    /**
     * 造一条本趟的日志：看板的「AI 一键周报」。挑它是因为**同步、一次点击**，
     * 比备件入库那类要走弹窗表单的路径省得多，留痕文案也固定（好断言）。
     *
     * 抽成函数，是因为这一段与 14c 要各造一条**身份不同**的日志（解锁后写的 / 没身份时写的）。
     * 两处必须走完全同一条真实路径：各写一份的话，"没身份那条"很容易因为少点了一步
     * 而压根没产生，对照断言却照样绿 —— 那就成了拿空集证明空集。
     */
    const weeklyLogOnce = async () => session.eval(`(async () => {
      location.hash = '#/dashboard'
      await new Promise(r => setTimeout(r, 1800))
      const btn = Array.from(document.querySelectorAll('button')).find(b => /AI 一键周报/.test(b.textContent))
      if (!btn) return { clicked: false }
      btn.click()
      await new Promise(r => setTimeout(r, 900))
      const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app')
      const first = store.recentLogs[0] || {}
      // 关掉周报弹窗，别让它盖住后面几次跳转
      const close = Array.from(document.querySelectorAll('.el-message-box button'))
        .find(b => b.textContent.trim() === '关闭')
      if (close) close.click()
      await new Promise(r => setTimeout(r, 500))
      return { clicked: true, content: first.content || '', actor: first.actor }
    })()`)

    const madeLog = await weeklyLogOnce()
    check('前置条件：本趟真的产生了一条日志（否则下面"日志页标了操作人"是在空集上做）',
      madeLog.clicked === true && /周报/.test(madeLog.content),
      madeLog.clicked ? `最新一条「${madeLog.content}」` : '看板上没找到「AI 一键周报」按钮')
    check('身份进审计：解锁之后产生的日志带上了操作人',
      madeLog.actor === '王建国 · 维修工程师', JSON.stringify(madeLog.actor))

    const logRows = await session.eval(`(async () => {
      location.hash = '#/logs'
      await new Promise(r => setTimeout(r, 2000))
      const contents = Array.from(document.querySelectorAll('.log-content')).map(e => e.textContent.trim())
      const actors = Array.from(document.querySelectorAll('.log-actor')).map(e => e.textContent.trim())
      return { rows: contents.length, actorCells: actors.length, firstActor: actors[0] || '' }
    })()`)
    check('前置条件：日志页每行都有操作人一栏（行数与身份栏数相等，不是有的有有的没有）',
      logRows.rows > 0 && logRows.actorCells === logRows.rows,
      `${logRows.rows} 行 / ${logRows.actorCells} 个身份栏（最新一条「${logRows.firstActor}」）`)

    // 停用这条路径只验"确认框接上了"：点取消、状态不变。
    // 真正的停用在 self-check 里对 disableLock() 断言过（清空账户 + 退出解锁态）。
    const disableWiring = await session.eval(`(async () => {
      location.hash = '#/settings'
      await new Promise(r => setTimeout(r, 1600))
      const cardText = (document.querySelector('.settings-page') || {}).innerText || ''
      const clicked = window.__clickText('停用应用锁')
      await new Promise(r => setTimeout(r, 900))
      const box = document.querySelector('.el-message-box')
      const title = box ? (box.querySelector('.el-message-box__title') || {}).textContent.trim() : ''
      const body = box ? (box.querySelector('.el-message-box__message') || {}).textContent.replace(/\\s+/g, ' ') : ''
      const cancel = box && Array.from(box.querySelectorAll('button')).find(b => b.textContent.trim() === '取消')
      if (cancel) cancel.click()
      await new Promise(r => setTimeout(r, 900))
      return {
        cardShowsOn: /已启用/.test(cardText) && /王建国/.test(cardText),
        clicked, title, body,
        boxGone: !document.querySelector('.el-message-box'),
        stillOn: !!localStorage.getItem('ks:app-lock')
      }
    })()`)
    check('应用锁：解锁后设置页能看到已启用的账户',
      disableWiring.cardShowsOn === true, `卡片显示已启用+账户=${disableWiring.cardShowsOn}`)
    check('应用锁：停用走二次确认，点取消不动任何状态',
      disableWiring.clicked === true && disableWiring.title.includes('停用应用锁') &&
        /不再要求输入 PIN/.test(disableWiring.body) &&
        disableWiring.boxGone === true && disableWiring.stillOn === true,
      `标题「${disableWiring.title}」/ 取消后仍启用=${disableWiring.stillOn}`)

    // 忘记 PIN 的自救：清空本机数据并解锁。这一段会把库清掉重新播种，
    // 所以放在最后，也顺带把本段造的锁配置收干净。
    await reloadUntil(session, '.lock-screen .lock-btn')
    await session.eval(LOCK_HELPER)
    const rescueAsk = await session.eval(`(async () => {
      const locked = !!document.querySelector('.lock-screen')
      const clicked = window.__clickText('忘记 PIN？清空本机数据并解锁')
      await new Promise(r => setTimeout(r, 900))
      const box = document.querySelector('.el-message-box')
      return {
        locked, clicked,
        title: box ? (box.querySelector('.el-message-box__title') || {}).textContent.trim() : '',
        body: box ? (box.querySelector('.el-message-box__message') || {}).textContent.replace(/\\s+/g, ' ') : ''
      }
    })()`)
    check('应用锁：刷新后回到锁定态（上面那次解锁只活在内存里）',
      rescueAsk.locked === true, `锁屏在=${rescueAsk.locked}`)
    check('应用锁：锁屏给「忘记 PIN」自救入口，二次确认如实写明后果',
      rescueAsk.clicked === true && rescueAsk.title.includes('清空本机数据并解锁') &&
        /不可撤销/.test(rescueAsk.body) && /账户与 PIN 也会一并清除/.test(rescueAsk.body),
      `标题「${rescueAsk.title}」/ 正文 ${rescueAsk.body.slice(0, 50)}…`)

    const rescued = await session.eval(`(async () => {
      const btn = Array.from(document.querySelectorAll('.el-message-box button'))
        .find(b => b.textContent.trim() === '确认清空并解锁')
      if (!btn) return { error: '确认框里找不到「确认清空并解锁」按钮' }
      btn.click()
      // 清库 ⇒ 重新播种 60 台设备：这一段是整轮里最慢的一步，轮询到内容区出现为止
      const deadline = Date.now() + 30000
      while (Date.now() < deadline && !document.querySelector('.app-main')) {
        await new Promise(r => setTimeout(r, 400))
      }
      location.hash = '#/dashboard'
      await new Promise(r => setTimeout(r, 2200))
      const d = await import('/src/utils/database.js')
      const first = document.querySelector('.stat-value')
      return {
        lockGone: !document.querySelector('.lock-screen'),
        lockKeyGone: localStorage.getItem('ks:app-lock') === null,
        dbReady: d.isReady() === true,
        equipCount: d.count('equipment'),
        firstStat: first ? first.textContent.trim() : ''
      }
    })()`)
    check('应用锁：清空自救后能直接进界面（锁配置连同数据一起清掉）',
      rescued.error === undefined && rescued.lockGone === true &&
        rescued.lockKeyGone === true && rescued.dbReady === true,
      rescued.error || `锁屏已卸=${rescued.lockGone} 锁配置已清=${rescued.lockKeyGone} isReady=${rescued.dbReady}`)
    check('应用锁：清空自救后演示数据重新播种（不是留下一台空库）',
      rescued.equipCount > 0 && rescued.firstStat === String(rescued.equipCount),
      `台账 ${rescued.equipCount} 台 / 看板显示「${rescued.firstStat}」`)

    // 顺手一条（P4-3）：没有账户 = 没有身份 ⇒ 侧边栏那行整行不渲染。
    // 「编不出身份就不要占位」是这一行的设计口径，v-if 那条分支得有消费方验它。
    const noAccountSide = await session.eval(`(() => {
      const line = document.querySelector('.aside-footer .actor-line')
      return {
        aside: !!document.querySelector('.app-aside'),
        shown: !!line,
        text: line ? line.textContent.trim() : ''
      }
    })()`)
    check('身份显示：本机没配账户时侧边栏不出现身份行（没有身份就不占位，而不是显示「未知用户」）',
      noAccountSide.aside === true && noAccountSide.shown === false,
      `侧栏在=${noAccountSide.aside} 身份行=${noAccountSide.shown ? `在（「${noAccountSide.text}」）` : '没有'}`)

    /**
     * 先造一条**没有身份**的日志（此刻本机确实一个账户都没配），
     * 一会儿和赵工那条同页对照 —— 两种状态摆在一页上，"这行字是当前身份"才立得住。
     *
     * 为什么不用小节 10 那条老日志当样本：它在上面的「清空自救」里连库一起被清了
     * （自救要清数据，日志当然也在其中）。第一版正是这么红的，报的是"没找到那条老日志" ——
     * 一条断言若依赖几小节之前某次写下的东西还在，它红的概率就与"那段多久没动过"成正比。
     */
    const anonLog = await weeklyLogOnce()
    check('前置条件：没身份的时候写日志，actor 落的是空串（下面"界面标未署名"才有东西可对）',
      anonLog.clicked === true && anonLog.actor === '',
      anonLog.clicked ? `actor=${JSON.stringify(anonLog.actor)}` : '看板上没找到「AI 一键周报」按钮')

    // ---------- 14c) 停用应用锁：确认之后必须整页重算身份（P4-3）----------
    /**
     * 为什么补这一段：上面那条只验了确认框接上了（点取消、状态不变），
     * **"确认停用"这条路一次都没跑过** —— 而它正是会把身份弄脏的那条路。
     *
     * 要防的具体缺陷：侧边栏那行身份是**启动时读一次**的（App.vue），
     * 停用之后账户清空、此后每条日志的 actor 都变成空串，而侧边栏会继续显示
     * 一个已经不存在的身份 —— 界面上的操作人与日志里的操作人对不上。
     * 修法是"身份真的变了就整页重载"（Settings.vue 的 reloadIfIdentityChanged）。
     *
     * 判据分三下，缺一不可：① 点击前身份行**在**（否则"点完没了"恒真）；
     * ② 页面真的重载了（靠重载前埋的 window 标记消失来判，不靠 sleep 猜）；
     * ③ 重载后身份行不在、账户已清空、锁已关掉、不再要求 PIN。
     *
     * 这一段顺带把「同一页上两种身份状态都渲染得出来」证掉（本趟造的两条日志：
     * 没账户时写的一条标「未署名」、解锁成赵工后写的一条标「赵工」）—— 见下面 bothStates。
     */
    await session.goto(`${BASE}/#/settings`, 2400)
    await session.eval(LOCK_HELPER)
    const disableSetup = await session.eval(`(async () => {
      const filled = {}
      filled.name = await window.__setInput('input[placeholder^="姓名"]', '赵工')
      filled.pin = await window.__setInput('input[placeholder^="PIN"]', '8642')
      filled.pin2 = await window.__setInput('input[placeholder^="再输一次"]', '8642')
      const clicked = window.__clickText('启用应用锁')
      await new Promise(r => setTimeout(r, 1600))
      return { filled, clicked, enabled: !!localStorage.getItem('ks:app-lock') }
    })()`)
    check('前置条件：为停用这条路径重新建了一个账户（否则下面没有可停用的东西）',
      disableSetup.filled.name && disableSetup.filled.pin && disableSetup.filled.pin2 &&
        disableSetup.clicked === true && disableSetup.enabled === true,
      // detail 里必须把 clicked / enabled 一并打出来：2026-09-27 那次 14 条级联红，
      // 首条就卡在这组前置上，而当时只打了 filled —— 三个 true 摆在那儿，
      // "按钮到底点到没有、账户到底落盘没有"全被藏住了，白查了一轮。
      JSON.stringify(disableSetup))

    // 新建账户是在**本次运行**里生效的，可侧边栏那行是启动时读的 ⇒ 必须刷新一次才会出现。
    // 这一步同时把"刷新 ⇒ 回锁屏 ⇒ 解锁 ⇒ 身份行出现"整条路再走一遍（用的是新账户）。
    const lockSettled = await reloadUntil(session, '.lock-screen .lock-btn')
    await session.eval(LOCK_HELPER)
    const disableUnlocked = await session.eval(`(async () => {
      const tried = await window.__unlock('8642')
      const deadline = Date.now() + 15000
      while (Date.now() < deadline && !document.querySelector('.app-main')) {
        await new Promise(r => setTimeout(r, 300))
      }
      const line = document.querySelector('.aside-footer .actor-line')
      return {
        tried: tried.ok === true, why: tried.why || '',
        text: line ? line.textContent.trim() : '(没有身份行)'
      }
    })()`)
    check('前置条件：刷新后回锁屏、用新账户的 PIN 能进，侧边栏显示新身份（点击停用前身份行必须在）',
      disableUnlocked.tried === true && disableUnlocked.text === '赵工',
      (lockSettled ? '' : '重载后 25 秒内没等到锁屏；') +
        (disableUnlocked.why || `身份行「${disableUnlocked.text}」`))

    /**
     * 负向对照：等一个**不可能出现**的选择器，必须超时返回 false。
     *
     * 为什么非要有这一条：刚加的等待函数（waitForFreshDoc）如果写错了、恒返回 true，
     * 它就会变成一个"什么都不等"的装饰品 —— 那种假绿正是本轮要修掉的东西
     * （上一版是固定 sleep(3400)，赌输了 13 条连锁红）。"等到了"和"恒真"
     * 光看绿条分不开，所以在这里正面证一次它能返回 false。
     *
     * 不重载、不注入 helper、不碰任何状态，只是拿 1.5 秒空等一次。
     */
    const noSuchSettle = await waitForFreshDoc(session, '.lock-screen .no-such-btn', 1500)
    // 顺带钉一句：此刻的文档**必须**是"新文档"（重载前埋的标记不在）。
    // 否则上面那次 false 可能是被标记挡下来的，而不是被选择器挡下来的 ——
    // 那样这条对照就退化成了恒真，正是它自己要防的东西。
    const markerGone = await session.eval('!window.__e2eOldDoc')
    check('负向对照：等一个不存在的选择器会超时返回 false（证明这个等待不是恒真的）',
      noSuchSettle === false && markerGone === true,
      `返回 ${noSuchSettle}（恒真就是它坏了）；新文档标记已清=${markerGone}`)

    // 再用赵工写一条：与上面那条"没身份"的日志同页对照。
    // 换个人再证一次，是为了堵住"这行字是第一次解锁那一刻写死的"这种可能。
    const zhaoLog = await weeklyLogOnce()
    check('身份进审计：换了个账户解锁后，新日志标的是**当前**这个身份（不是留着上一个）',
      zhaoLog.actor === '赵工', JSON.stringify(zhaoLog.actor))

    const bothStates = await session.eval(`(async () => {
      location.hash = '#/logs'
      await new Promise(r => setTimeout(r, 2000))
      const contents = Array.from(document.querySelectorAll('.log-content')).map(e => e.textContent.trim())
      const actors = Array.from(document.querySelectorAll('.log-actor')).map(e => e.textContent.trim())
      return {
        rows: contents.length,
        actorCells: actors.length,
        firstActor: actors[0] || '',
        anonCount: actors.filter(a => a === '未署名').length
      }
    })()`)
    check('身份进审计：日志页上「解锁后那条标着操作人」与「没身份那条标着未署名」同页可见',
      bothStates.actorCells === bothStates.rows && bothStates.firstActor === '赵工' &&
        bothStates.anonCount > 0,
      `${bothStates.rows} 行（各一行身份栏）：最新「${bothStates.firstActor}」/ 未署名 ${bothStates.anonCount} 条`)

    const disableClicked = await session.eval(`(async () => {
      location.hash = '#/settings'
      await new Promise(r => setTimeout(r, 1800))
      // 埋一个只活在这份文档里的标记：重载之后它必须消失。
      // 用"睡够几秒就当它重载了"来判是不行的 —— 慢机器上会误判，
      // "根本没重载"时又会因为页面看着正常而假绿。
      window.__p43ReloadMark = 1
      const clicked = window.__clickText('停用应用锁')
      await new Promise(r => setTimeout(r, 800))
      const box = document.querySelector('.el-message-box')
      const confirm = box && Array.from(box.querySelectorAll('button'))
        .find(b => b.textContent.trim() === '确认停用')
      if (!confirm) return { clicked, confirmFound: false }
      confirm.click()
      // 点完就返回，**不要在这里等**：重载会把整个 JS 上下文换掉，
      // 页面里的 await 活不过重载（换目录重来一次这个坑，见第 15 节那段说明）。
      return { clicked, confirmFound: true }
    })()`)
    check('前置条件：确认框里有「确认停用」按钮（上面那条只验过点取消）',
      disableClicked.clicked === true && disableClicked.confirmFound === true,
      `点到停用按钮=${disableClicked.clicked} 确认框里有确认键=${disableClicked.confirmFound}`)

    // 停用是页面自己重载的（Settings.vue 的 reloadIfIdentityChanged 里 800ms 后 location.reload()），
    // 所以只能从 Node 侧轮询 —— 每次 eval 都可能撞上"上下文刚被销毁"，撞了就下一轮再来。
    let disableConfirmed = null
    const disableDeadline = Date.now() + 25000
    while (Date.now() < disableDeadline) {
      await sleep(600)
      try {
        disableConfirmed = await session.eval(`({
          reloaded: !window.__p43ReloadMark,
          lockScreen: !!document.querySelector('.lock-screen'),
          appMain: !!document.querySelector('.app-main'),
          lineShown: !!document.querySelector('.aside-footer .actor-line'),
          lineText: (document.querySelector('.aside-footer .actor-line') || {}).textContent || ''
        })`)
      } catch {
        continue // 正好卡在重载那一刻：这一轮的上下文已经没了，下一轮读新的
      }
      if (disableConfirmed.reloaded && disableConfirmed.appMain) break
    }
    disableConfirmed = disableConfirmed || {}
    check('停用应用锁：确认后整页重算 ⇒ 侧边栏不再留一个已经不作数的身份行',
      disableConfirmed.reloaded === true &&
        disableConfirmed.appMain === true && disableConfirmed.lockScreen === false &&
        disableConfirmed.lineShown === false,
      `已重载=${disableConfirmed.reloaded} 内容区=${disableConfirmed.appMain} 锁屏=${disableConfirmed.lockScreen} ` +
      `身份行=${disableConfirmed.lineShown ? `还在（「${String(disableConfirmed.lineText).trim()}」）` : '已消失'}`)
    /**
     * 停用之后要断的是**语义**（账户清空、锁关掉、不再要 PIN），不是"键还在不在"。
     *
     * disableLock() 是刻意保留空闲档位的：writeConfig(emptyConfig) 里带上 idleMinutes，
     * 下次启用不用重挑。所以 ks:app-lock 这个键**本来就还在** —— 第一版把它写成
     * `localStorage.getItem(...) === null`，红的是断言，不是产品。断言挑错了观测点，
     * 就会把"按设计保留"报成"没清干净"。
     *
     * "还保不保留档位"这一条**故意不在这里断言**：本趟此刻压根没设过档位（默认就是 10，
     * 没写进配置），`undefined` 是正常的；而真去设一档再验它保住，会把下一节 15a
     * 要的"默认 10 分钟"前提改掉。这条交给 self-check 对着 disableLock() 直接测。
     *
     * 判"还在不在锁屏"也不能只看 PIN 输入框：设置页的**新增账户表单**里同样有
     * `input[placeholder^="PIN"]` —— 第一版就是这么红的（要求 PIN=true，其实锁早关了）。
     * 锁屏自己的东西才算数：.lock-screen 与它里面的解锁键。
     */
    const disabledState = await session.eval(`(async () => {
      const m = await import('/src/utils/appLock.js')
      return {
        lockOn: m.lockEnabled(),
        accounts: m.listAccounts().length,
        lockUi: !!document.querySelector('.lock-screen .lock-btn')
      }
    })()`)
    check('停用应用锁：确认后账户清空、锁关掉、不再要 PIN',
      disabledState.lockOn === false && disabledState.accounts === 0 &&
        disabledState.lockUi === false && disableConfirmed.lockScreen === false,
      `锁开着=${disabledState.lockOn} 账户 ${disabledState.accounts} 个 ` +
      `锁屏解锁键=${disabledState.lockUi}`)

    // ---------- 15) 空闲自动锁（P4-2）----------
    /**
     * 这一段要证的是**接上了没有**，不是算术。
     *
     * 「多久才算闲置」的边界（恰好到阈值 / 差 1 毫秒 / 阈值 0 / 时钟回拨 / 脏值回落）
     * 在 self-check 里喂时间戳测过 —— 那边快、准，而且每条都做过"能失败"验证。
     * 这里只留真正非得"等"的三件事：
     *   ① 计时器在跑，而且读的是设置里那个阈值 ⇒ 到点真的回锁屏
     *   ② 中途有活动就重新计时 ⇒ 到点那一刻不该锁
     *   ③ 界面上关掉之后 ⇒ 真的不再锁（演示前最需要的那一下）
     *
     * 阈值为什么用 1 分钟：它是设置页能选的**最小档**。想要更快就得绕开界面直接
     * 写 localStorage，那测的就不是用户走得通的那条路了。代价是这一段要跑近三分钟 ——
     * 时间行为没法在时间上偷懒。
     *
     * 为什么必须先 reload：main.js 的 installIdleLock 只在**启动装载**时装一次，
     * 本次运行里刚启用的锁这一趟根本没有计时器。不刷新就会"等半天也不锁"，
     * 而那是用法问题，不是缺陷 —— 这段前面那句提示文案说的就是这件事。
     */
    const waitTo = async (t0, ms) => {
      const left = ms - (Date.now() - t0)
      if (left > 0) await sleep(left)
    }

    /**
     * 制造一次"真的活动"。走 CDP 的原生按键（渲染进程的输入管线，页面收到的是
     * trusted 事件），**不用** `new KeyboardEvent('keydown')` 合成一个：
     * 合成事件能过"有没有监听器"这种断言，却证明不了真按键也会被算作活动。
     * 发 Shift：不产生文本、不触发任何快捷键，副作用最小。
     */
    const nudgeActivity = async () => {
      const key = { windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16, code: 'ShiftLeft', key: 'Shift', location: 1 }
      await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key, modifiers: 8 })
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key, modifiers: 0 })
    }

    /**
     * 注入 helper 再求值。**这一段里每一步都必须重新注入一次。**
     *
     * 理由：空闲上锁走的是 `location.reload()`，注入到 window 上的 `__unlock` /
     * `__pickIdle` 会随页面一起消失。第一次写这段时没重注入，结果变异 M7
     * （把活动监听全去掉 ⇒ 60 秒就该锁 ⇒ 到 82 秒页面早已刷新过）当场得到
     * `TypeError: window.__pickIdle is not a function`，**整轮 e2e 又是只留一句话、
     * 已收集的断言全部丢失** —— 和当初 `__unlock` 那次是同一个坑，只不过这次
     * 不是"元素不在"而是"函数不在"。
     *
     * 重注入是幂等的（只是重新定义几个 window 函数），而且**不会掩盖缺陷**：
     * 页面若已回到锁屏，`__pickIdle` 自己会返回「设置页没有「空闲自动锁」那一行」，
     * 这比一句 TypeError 有用得多。
     */
    const withLockHelper = async (expression) => {
      await session.eval(LOCK_HELPER)
      return session.eval(expression)
    }

    // 15a) 起点：块 14 的自救把锁配置连同数据一起清了，此刻是"没账户、不设防"的状态。
    //      先建一个账户（默认档位不动），看设置页写的是不是那回事。
    const idleArm = await session.eval(`(async () => {
      const m = await import('/src/utils/appLock.js')
      const created = await m.createAccount({ name: '李巡检', role: '巡检工', pin: '1357' })
      /**
       * 绕一下看板再回设置页 —— 这一绕是**必须的**，不是保险。
       *
       * 账户是在模块层建的（没走界面上那个表单），而设置页的 lockOn / accounts 是
       * onMounted 里读一次的快照，配置变了它不会自己知道。靠"设一下 hash"来触发重挂，
       * 前提是那一跳**真的是个路由变化**。
       *
       * 上一段（14c）的收尾是"停用后整页重载"，重载落回来的正是 #/settings，
       * 于是原来那句「设 hash 成 #/settings」成了原地不动：设置页还是重载时
       * 那份"没启用"的样子，.lock-idle 整块不渲染 ⇒ 下面三条一起红（实测）。
       *
       * （这段注释在模板字符串里，不能出现反引号 —— 会把模板提前收掉，eslint 报的
       *  "Unexpected token location" 就是这个，调一次就知道。）
       */
      location.hash = '#/dashboard'
      await new Promise(r => setTimeout(r, 900))
      location.hash = '#/settings'
      await new Promise(r => setTimeout(r, 1800))
      const sel = document.querySelector('.lock-idle .el-select')
      const note = document.querySelector('.lock-idle-note')
      return {
        created: created.ok === true, createErr: created.error || '',
        defMinutes: m.getIdleMinutes(),
        selText: sel ? sel.textContent.trim() : '(没有下拉)',
        note: note ? note.textContent.trim() : '(没有说明)'
      }
    })()`)
    check('空闲自动锁：默认 10 分钟，设置页把当前档位与后果都写在明面上',
      idleArm.created === true && idleArm.defMinutes === 10 &&
        /10 分钟/.test(idleArm.selText) && /闲置 10 分钟/.test(idleArm.note),
      idleArm.createErr || `下拉「${idleArm.selText}」/ 说明「${idleArm.note}」/ 落盘 ${idleArm.defMinutes}`)

    const idlePick = await withLockHelper(`window.__pickIdle('1 分钟')`)
    check('空闲自动锁：能在这个下拉里改档位（演示前调长/关掉走的就是这条路）',
      idlePick.ok === true && idlePick.picked === '1 分钟',
      idlePick.why || `选中「${idlePick.picked || '(空)'}」`)

    const idlePicked = await session.eval(`(async () => {
      const m = await import('/src/utils/appLock.js')
      const sel = document.querySelector('.lock-idle .el-select')
      const note = document.querySelector('.lock-idle-note')
      return {
        minutes: m.getIdleMinutes(),
        selText: sel ? sel.textContent.trim() : '(没有下拉)',
        note: note ? note.textContent.trim() : '(没有说明)'
      }
    })()`)
    check('空闲自动锁：改完界面回读的是真正落盘的值（不是只改了显示）',
      idlePicked.minutes === 1 && /1 分钟/.test(idlePicked.selText) && /闲置 1 分钟/.test(idlePicked.note),
      `下拉「${idlePicked.selText}」/ 说明「${idlePicked.note}」/ 落盘 ${idlePicked.minutes}`)

    // 15b) 刷新 ⇒ 必须落在锁屏上（这一步同时把计时器装上：installIdleLock 在 boot 里）
    await reloadUntil(session, '.lock-screen .lock-btn')
    const idleBoot = await withLockHelper(`(async () => {
      const tried = await window.__unlock('1357')
      const deadline = Date.now() + 15000
      while (Date.now() < deadline && !document.querySelector('.app-main')) {
        await new Promise(r => setTimeout(r, 300))
      }
      // 点了解锁却进不去，多半是"锁屏上选中的账户不是这个 PIN 的主人"
      // （多账户时锁屏默认选第一个）。把锁屏自己那句提示和它列的账户一起带出来，
      // 否则这条红条只说"内容区=false"，看不出到底是 PIN 不对还是别的。
      const err = document.querySelector('.lock-err')
      return {
        tried: tried.ok === true, why: tried.why || '',
        appMain: !!document.querySelector('.app-main'),
        err: err ? err.textContent.trim() : '',
        who: (document.querySelector('.lock-who-name') || {}).textContent || ''
      }
    })()`)
    check('空闲自动锁：配了锁之后刷新，照常先落在锁屏，用新账户的 PIN 能进',
      idleBoot.tried === true && idleBoot.appMain === true,
      idleBoot.why ||
        `解锁按钮点到了=${idleBoot.tried} 内容区=${idleBoot.appMain}` +
          ` 锁屏提示「${idleBoot.err}」当前账户「${idleBoot.who}」`)
    // 计时器就是在刚刚这次装载里启动的（installIdleLock 在 bootAppData 末尾），
    // 所以把"现在"当作时间轴的原点：后面的等待都按目标时刻倒推，不吃 sleep 的漂移。
    const bootAt = Date.now()

    // 15c) 到点前敲一下键 ⇒ 计时必须重置。
    //      判据取在 82 秒：没有这次重置的话，最后一个 tick 在 75 秒就该锁了。
    await waitTo(bootAt, 40000)
    await nudgeActivity()
    await waitTo(bootAt, 82000)
    const idleAlive = await withLockHelper(`(async () => {
      const locked = !!document.querySelector('.lock-screen')
      const picked = await window.__pickIdle('关闭')
      const m = await import('/src/utils/appLock.js')
      const sel = document.querySelector('.lock-idle .el-select')
      const note = document.querySelector('.lock-idle-note')
      return {
        locked, pickedOk: picked.ok === true, pickedWhy: picked.why || '',
        minutes: m.getIdleMinutes(),
        selText: sel ? sel.textContent.trim() : '(没有下拉)',
        note: note ? note.textContent.trim() : '(没有说明)'
      }
    })()`)
    check('空闲自动锁：中途有活动就重新计时（没重置的话这个点早就锁了）',
      idleAlive.locked === false, `此刻锁屏在=${idleAlive.locked}`)
    check('空闲自动锁：界面上能关掉，界面文案与落盘同步变成「不自动锁」',
      idleAlive.pickedOk === true && idleAlive.minutes === 0 &&
        /关闭/.test(idleAlive.selText) && /不自动锁/.test(idleAlive.note),
      idleAlive.pickedWhy || `下拉「${idleAlive.selText}」/ 说明「${idleAlive.note}」/ 落盘 ${idleAlive.minutes}`)

    // 15d) 关掉之后撑过原本该锁的那一刻（开着的档位在 105 秒就该锁了）
    await waitTo(bootAt, 142000)
    const idleStillOff = await session.eval(`(async () => {
      const m = await import('/src/utils/appLock.js')
      return { locked: !!document.querySelector('.lock-screen'), minutes: m.getIdleMinutes() }
    })()`)
    check('空闲自动锁：关掉之后真的不再锁（撑过了 1 分钟档本该到点的那一刻）',
      idleStillOff.locked === false && idleStillOff.minutes === 0,
      `此刻锁屏在=${idleStillOff.locked} / 落盘 ${idleStillOff.minutes}`)

    // 15e) 再开回 1 分钟。此刻已经闲置了两分多钟（远超阈值）⇒ 下一次检查就该回锁屏。
    //      这条同时覆盖"开着锁、但已经闲置超时"的即时性：不必再等一个完整周期。
    const idleRearm = await withLockHelper(`(async () => {
      const before = !!document.querySelector('.lock-screen')
      const picked = await window.__pickIdle('1 分钟')
      return { wasLocked: before, pickedOk: picked.ok === true, why: picked.why || '' }
    })()`)
    await waitTo(bootAt, 165000)
    const idleFired = await session.eval(`({
      locked: !!document.querySelector('.lock-screen'),
      hasPin: !!document.querySelector('input[placeholder^="PIN"]')
    })`)
    check('空闲自动锁：重新开成 1 分钟且已闲置超时 ⇒ 到点自动回到锁屏（要重新输 PIN）',
      idleRearm.wasLocked === false && idleRearm.pickedOk === true &&
        idleFired.locked === true && idleFired.hasPin === true,
      idleRearm.why || `重开前已锁=${idleRearm.wasLocked} / 此刻锁屏在=${idleFired.locked} / PIN 框=${idleFired.hasPin}`)

    // 收尾：自动锁那次是 location.reload()，注入的 helper 已经随页面没了，要重新注入。
    // 把这一段造的锁停掉，别把"一起来就锁屏"留给后面（也免得再跑一次时读到脏配置）。
    const idleClean = await withLockHelper(`(async () => {
      // 锁屏在就解锁，不在就直接收 —— 这一步的职责是"别留一个锁在后面"，
      // 不是"再验一遍上一条断言"。写成无条件 __unlock 的话，上一条一旦红，
      // 这条会跟着红成"锁屏不在"，看着像两处坏了、其实只有一处。
      // （变异 M8 就是这么暴露出来的。）
      const locked = !!document.querySelector('.lock-screen')
      let tried = true
      let why = ''
      if (locked) {
        const r = await window.__unlock('1357')
        tried = r.ok === true
        why = r.why || ''
        const deadline = Date.now() + 20000
        while (Date.now() < deadline && !document.querySelector('.app-main')) {
          await new Promise(r => setTimeout(r, 300))
        }
      }
      const m = await import('/src/utils/appLock.js')
      m.disableLock()
      return {
        lockedAtStart: locked, tried, why,
        stillEnabled: m.lockEnabled(), accounts: m.listAccounts().length
      }
    })()`)
    check('空闲自动锁：收尾（有锁屏就先解锁，然后停用，不留一个锁着的会话给后面）',
      idleClean.tried === true && idleClean.stillEnabled === false && idleClean.accounts === 0,
      idleClean.why || `起手锁屏在=${idleClean.lockedAtStart} / 解锁=${idleClean.tried} / 仍启用=${idleClean.stillEnabled} / 账户 ${idleClean.accounts} 个`)

    // ---------- 16) 首启设锁屏：先出「设置 PIN」、可跳过（2026-09-28）----------
    /**
     * 这一段取代了一条**旧决定**：「首启不锁（无账户 ⇒ 不锁），装完双击直接进主界面」。
     * 现在装完第一次双击先出这一屏。要守住的是三件事，缺一条这段就白跑：
     *   ① 它**真的**出现在首启位置上（而不是只有代码里有这个分支）；
     *   ② 它没跨过结构保证 —— 主应用 / 数据库在没走完这一屏之前**根本没起来**；
     *   ③ 「跳过」是一颗真能点、点得到的按钮（不是 0×0、不是被挤出视口），
     *      点完主界面出得来、且**下次启动不再问**。演示现场最怕的就是这一屏赖着不走。
     *
     * 起点是第 15 段的收尾：账户 0 个、锁已停用。而 ks:lock-setup-seen 还在
     * （createAccount 顺手写过、12e 又重新种过），所以要先撤回注入 + 删标记，
     * 才回得到真正的首启路径。
     */
    await unseedFirstRun(session, lockSetupSeed)
    await session.eval(`localStorage.removeItem('ks:lock-setup-seen')`)
    await session.send('Page.reload')
    await sleep(7000)

    const setupView = await session.eval(`(async () => {
      const d = await import('/src/utils/database.js')
      const app = document.querySelector('#app').__vue_app__
      const ghost = document.querySelector('.lock-btn-ghost')
      const gb = ghost ? ghost.getBoundingClientRect() : null
      const root = document.querySelector('.lock-screen')
      return {
        lockScreen: !!root,
        view: root ? (root.getAttribute('data-lock-view') || '') : '',
        title: (document.querySelector('.lock-title') || {}).textContent || '',
        sub: (document.querySelector('.lock-sub') || {}).textContent || '',
        跳过文案: ghost ? ghost.textContent.trim() : '(没有这颗按钮)',
        跳过尺寸: gb ? [Math.round(gb.width), Math.round(gb.height)] : null,
        跳过在视口内: gb ? (gb.top >= 0 && gb.bottom <= innerHeight && gb.left >= 0 && gb.right <= innerWidth) : false,
        按钮数: document.querySelectorAll('.lock-screen button').length,
        有姓名框: !!document.querySelector('input#setup-name'),
        appMain: !!document.querySelector('.app-main'),
        aside: !!document.querySelector('.app-aside'),
        statValues: document.querySelectorAll('.stat-value').length,
        hasPinia: !!(app && app.config.globalProperties.$pinia),
        dbReady: d.isReady() === true
      }
    })()`)
    check('首启设锁：全新机器打开先出这一屏（不是直接进主界面）',
      setupView.lockScreen === true && setupView.view === 'setup' &&
        setupView.title.includes('矿山智工') && setupView.sub.includes('首次使用'),
      `锁屏=${setupView.lockScreen} 视图=${setupView.view || '(无标记)'} 副标题「${setupView.sub}」`)
    check('首启设锁：跳过是一颗点得到的真按钮（有尺寸、在视口内、文案直白）',
      setupView.跳过尺寸 !== null && setupView.跳过尺寸[0] > 200 && setupView.跳过尺寸[1] >= 32 &&
        setupView.跳过在视口内 === true && /跳过/.test(setupView.跳过文案),
      `「${setupView.跳过文案}」尺寸 ${JSON.stringify(setupView.跳过尺寸)} 在视口内=${setupView.跳过在视口内}`)
    check('首启设锁：走完这一屏之前，业务界面与数据库一概没起来（结构保证，不靠 v-if）',
      setupView.appMain === false && setupView.aside === false &&
        setupView.statValues === 0 && setupView.hasPinia === false && setupView.dbReady === false,
      `内容区=${setupView.appMain} 侧栏=${setupView.aside} 看板数字 ${setupView.statValues} 个 / pinia=${setupView.hasPinia} / isReady=${setupView.dbReady}`)

    // 16a) 先验一条能失败的：两次 PIN 不一致必须当场报错，且不建账户
    await session.eval(LOCK_HELPER)
    const mismatch = await withLockHelper(`(async () => {
      await window.__setInput('#setup-name', '赵班长')
      await window.__setInput('#setup-pin', '2468')
      await window.__setInput('#setup-pin2', '1357')
      document.querySelector('.lock-btn').click()
      await new Promise(r => setTimeout(r, 800))
      const m = await import('/src/utils/appLock.js')
      const root = document.querySelector('.lock-screen')
      return {
        err: (document.querySelector('.lock-err') || {}).textContent || '',
        pin2: (document.querySelector('#setup-pin2') || {}).value,
        accounts: m.listAccounts().length,
        stillSetup: !!root && root.getAttribute('data-lock-view') === 'setup'
      }
    })()`)
    check('首启设锁：两次 PIN 不一致 ⇒ 当场报错、不建账户、仍停在设置屏',
      /两次输入的 PIN 不一致/.test(mismatch.err) && mismatch.accounts === 0 &&
        mismatch.pin2 === '' && mismatch.stillSetup === true,
      `提示「${mismatch.err.slice(0, 40)}」/ 账户 ${mismatch.accounts} 个 / 重输框残留「${mismatch.pin2}」`)

    // 16b) 走通「启用并进入」：锁真的启用、身份认下、标记落盘、主界面出来
    const doSetup = await withLockHelper(`(async () => {
      await window.__setInput('#setup-pin2', '2468')
      document.querySelector('.lock-btn').click()
      const deadline = Date.now() + 25000
      while (Date.now() < deadline && !document.querySelector('.app-main')) {
        await new Promise(r => setTimeout(r, 300))
      }
      const raw = localStorage.getItem('ks:app-lock') || ''
      let cfg = null
      try { cfg = JSON.parse(raw) } catch { /* 落盘坏了下面断言会红 */ }
      const acc = cfg && cfg.accounts && cfg.accounts[0] ? cfg.accounts[0] : null
      return {
        appMain: !!document.querySelector('.app-main'),
        lockGone: !document.querySelector('.lock-screen'),
        setupSeen: (() => { try { return localStorage.getItem('ks:lock-setup-seen') } catch { return '不可读' } })(),
        accounts: cfg && cfg.accounts ? cfg.accounts.length : 0,
        saltLen: acc ? String(acc.salt || '').length : 0,
        hashLen: acc ? String(acc.hash || '').length : 0,
        含明文PIN: raw.includes('2468'),
        // 侧栏身份行 = App.vue 的 .actor-line（v-if="actorLabel"）。
        // 两件事分开报：行在不在、行上写的是谁 —— 混成一句的话，
        // "选择器写错导致行根本没取到"会和"显示成了别人"长得一模一样。
        侧栏身份行在: !!document.querySelector('.actor-line'),
        侧栏身份: (document.querySelector('.actor-line') || {}).textContent || ''
      }
    })()`)
    check('首启设锁：点「启用并进入」⇒ 账户建好、主界面挂上',
      doSetup.appMain === true && doSetup.lockGone === true && doSetup.accounts === 1,
      `内容区=${doSetup.appMain} 锁屏已卸=${doSetup.lockGone} 账户 ${doSetup.accounts} 个`)
    check('首启设锁：落盘的是盐 + 摘要，不是明文 PIN（与设置页同一条链）',
      doSetup.含明文PIN === false && doSetup.saltLen >= 16 && doSetup.hashLen === 64,
      `含明文=${doSetup.含明文PIN} 盐 ${doSetup.saltLen} 字符 / 摘要 ${doSetup.hashLen} 字符`)
    check('首启设锁：身份当场认下（侧栏那行显示的是刚设的这个人）',
      doSetup.侧栏身份行在 === true && /赵班长/.test(doSetup.侧栏身份),
      `侧栏身份行在=${doSetup.侧栏身份行在} 显示「${doSetup.侧栏身份.trim() || '(空)'}」`)

    // 16c) 关键的一条：**下次启动不再问**。刷新之后该出的是锁屏，不是设置屏
    await reloadUntil(session, '.lock-screen .lock-btn')
    const secondBoot = await session.eval(`(() => {
      const root = document.querySelector('.lock-screen')
      return {
        view: root ? (root.getAttribute('data-lock-view') || '') : '',
        seen: (() => { try { return localStorage.getItem('ks:lock-setup-seen') } catch { return '不可读' } })(),
        hasPin: !!document.querySelector('input[placeholder^="PIN"]')
      }
    })()`)
    check('首启设锁：设过之后再启动**不再问**，直接是锁屏（ks:lock-setup-seen 已落盘）',
      secondBoot.view === 'unlock' && secondBoot.seen === '1' && secondBoot.hasPin === true,
      `视图=${secondBoot.view || '(无标记)'} 标记=${secondBoot.seen} PIN 框=${secondBoot.hasPin}`)

    // 16d) 收尾：解锁 → 停用锁。**之后不能再刷新**（标记已清，刷新会再弹设置屏）
    const setupClean = await withLockHelper(`(async () => {
      const r = await window.__unlock('2468')
      const deadline = Date.now() + 20000
      while (Date.now() < deadline && !document.querySelector('.app-main')) {
        await new Promise(r2 => setTimeout(r2, 300))
      }
      const m = await import('/src/utils/appLock.js')
      m.disableLock()
      try { localStorage.removeItem('ks:lock-setup-seen') } catch { /* 隐私模式 */ }
      return {
        tried: r.ok, why: r.why || '',
        stillEnabled: m.lockEnabled(),
        accounts: m.listAccounts().length
      }
    })()`)
    check('首启设锁：收尾（解锁 → 停用，不留一个锁着的会话给后面）',
      setupClean.tried === true && setupClean.stillEnabled === false && setupClean.accounts === 0,
      setupClean.why || `解锁=${setupClean.tried} / 仍启用=${setupClean.stillEnabled} / 账户 ${setupClean.accounts} 个`)

    // 16e) 「跳过」这条路：不建账户、不留锁、下次启动不再问
    /**
     * 为什么这一段在 e2e 而不在 self-check：「跳过偷偷建了一把锁」这种缺陷，
     * 最真实的样子是 LockSetup.vue 的 skip() 被改成去调 createAccount —— 那是
     * **界面接线**的错，纯逻辑层的 self-check 从外面看不见（它只能验"标记写了没"）。
     * 所以这条必须在这里、点真按钮来验。
     *
     * 起点正好是 16d 的收尾：账户 0 个、锁停用、标记已清 = 货真价实的首启状态，
     * 不用再伪造。上面 12e 已经把 ks:tour-seen 写成 1 了，所以这次进来引导不会自动弹，
     * 不会有人来挡鼠标。
     */
    await session.send('Page.reload')
    await sleep(7000)
    await session.eval(LOCK_HELPER)
    const skipped = await withLockHelper(`(async () => {
      const ghost = document.querySelector('.lock-btn-ghost')
      if (!ghost) return { ok: false, why: '设置屏上没有「跳过，先不设锁」这颗按钮' }
      const 文案 = ghost.textContent.trim()
      ghost.click()
      const deadline = Date.now() + 25000
      while (Date.now() < deadline && !document.querySelector('.app-main')) {
        await new Promise(r => setTimeout(r, 300))
      }
      const m = await import('/src/utils/appLock.js')
      return {
        ok: true, 文案,
        appMain: !!document.querySelector('.app-main'),
        lockGone: !document.querySelector('.lock-screen'),
        accounts: m.listAccounts().length,
        lockEnabled: m.lockEnabled(),
        seen: (() => { try { return localStorage.getItem('ks:lock-setup-seen') } catch { return '不可读' } })()
      }
    })()`)
    check('首启设锁：点「跳过」⇒ 进得去主界面，且一个账户都没建、锁没被启用（跳过 ≠ 偷偷替他设一把锁）',
      skipped.ok === true && skipped.appMain === true && skipped.lockGone === true &&
        skipped.accounts === 0 && skipped.lockEnabled === false && skipped.seen === '1',
      skipped.ok
        ? `「${skipped.文案}」内容区=${skipped.appMain} 账户 ${skipped.accounts} 个 锁启用=${skipped.lockEnabled} 标记=${skipped.seen}`
        : skipped.why)

    // 等的是「进了应用的某个面」而不是「一定是主界面」：这条要验的承诺是**设置屏不再出现**。
    // 写成非 .app-main 不可，会把"跳过之后停在锁屏"也判红 —— 那是另一件事（16c 管），
    // 而且会让"跳过偷偷建了账户"这种缺陷同时污染两条断言，红在哪就说不清了。
    const 落定 = await reloadUntil(session, '.app-main, .lock-screen')
    const afterSkip = await session.eval(`(() => {
      const r = document.querySelector('.lock-screen')
      return {
        视图: r ? (r.getAttribute('data-lock-view') || '') : '',
        设置屏: !!r && r.getAttribute('data-lock-view') === 'setup',
        进了应用: !!document.querySelector('.app-main, .lock-screen')
      }
    })()`)
    check('首启设锁：跳过一次之后再启动不再问（标记落盘了，不是每次都得点一遍）',
      落定 === true && afterSkip.设置屏 === false && afterSkip.进了应用 === true,
      `落定=${落定} 视图=${afterSkip.视图 || '(无)'} 设置屏=${afterSkip.设置屏}`)


    // ---------- 17. 恢复到出厂设置：点一下回到"刚装好"（用户报障的端到端守卫） ----------
    /**
     * 用户原话：「卸载后重新安装，但是密码锁仍然在、设置仍然在，并不是从零开始」。
     * 根因是锁配置与偏好落在 userData 里的 localStorage，而卸载器**刻意不删** userData
     * （src/main/index.js 顶部那条注释就是它的挡箭牌）。于是"从零"只能由应用内这个入口负责。
     *
     * 起点：第 16 段收尾时机器上是「没账户、不设防、标记=1、库已播种」。先造出一台"用过的"
     * 机器（一把锁 + 一堆改过的偏好 + 一条对话），再**从界面上**点恢复出厂。
     *
     * 为什么必须走界面而不是直接 import utils/factoryReset.js 调一下：直接调只能证明
     * "函数删得对"（那归 self-check 管），证明不了"设置页那张卡真的接上了它、确认框真的弹得
     * 出来、点完真的重载、重载后真的回到首启那一屏"。这一段要的是后者。
     */
    const factorySeed = await session.eval(`(async () => {
      const m = await import('/src/utils/appLock.js')
      const created = await m.createAccount({ name: '出厂前账户', role: '维修工', pin: '8642' })
      localStorage.setItem('ks:master-mode', '1')
      localStorage.setItem('ks:tour-seen', '1')
      localStorage.setItem('ks:theme', 'dark')
      localStorage.setItem('ai_chat_messages', '[{"role":"user","content":"出厂前的话"}]')
      localStorage.setItem('mining-nav-pinned', '["equipment"]')
      return { created: created.ok === true, lockOn: m.lockEnabled() === true }
    })()`)

    // 账户是模块层建的，而设置页的 lockOn / accounts 是 onMounted 读一次的快照：
    // 靠"设一下 hash"触发重挂的前提是那一跳**真的是个路由变化**（这一段注释在模板串里，
    // 不能出现反引号），所以先绕看板再回来。
    await session.eval(`(async () => {
      location.hash = '#/dashboard'
      await new Promise(r => setTimeout(r, 800))
      location.hash = '#/settings'
      await new Promise(r => setTimeout(r, 1800))
    })()`)
    /**
     * 用 `withLockHelper` 而不是裸 `session.eval`：上一段的收尾是 `reloadUntil`（16 段最后那条
     * 「跳过一次之后再启动不再问」），它会把页面换一茬，而 `__clickText` 是挂在 `window` 上的
     * ——`LOCK_HELPER` 自己的注释就写着"页面每刷新一次就得重新注入一次"。
     *
     * 第一版这里漏了重注入，实测的失败形态值得记一笔：**不是红，是崩**。前 228 条全绿、0 失败，
     * 然后 `TypeError: window.__clickText is not a function` 把整轮打断，我自己这 7 条一条都没跑。
     * 「228 条全过」看着像验收通过，其实这一段是空白 —— 崩溃冒充绿，比红更难看出来。
     */
    const factoryAsk = await withLockHelper(`(async () => {
      const clicked = window.__clickText('恢复到出厂设置')
      await new Promise(r => setTimeout(r, 900))
      const box = document.querySelector('.el-message-box')
      return {
        clicked,
        title: box ? (box.querySelector('.el-message-box__title') || {}).textContent.trim() : '',
        body: box ? (box.querySelector('.el-message-box__message') || {}).textContent.replace(/\\s+/g, ' ') : ''
      }
    })()`)
    check('恢复出厂：设置页那张卡点得动，二次确认如实写明清什么、且不可撤销',
      factorySeed.created === true && factoryAsk.clicked === true &&
        factoryAsk.title === '恢复到出厂设置' &&
        /本机数据库里的全部业务数据/.test(factoryAsk.body) && /不可撤销/.test(factoryAsk.body),
      `账户已建=${factorySeed.created} 点了=${factoryAsk.clicked} 标题「${factoryAsk.title}」正文 ${factoryAsk.body.slice(0, 60)}…`)
    /**
     * 确认框里那句枚举是**清单渲染出来的**，所以这条顺带钉住了"文案 ≠ 实际清的东西"这种漂移：
     * 三处细节（应用锁与账户 / AI 对话记录 / 界面偏好）分别来自清单里三个不同的分组。
     */
    check('恢复出厂：确认框里的枚举来自清理清单本身（应用锁、对话记录、界面偏好都在）',
      /应用锁与账户/.test(factoryAsk.body) && /AI 对话记录/.test(factoryAsk.body) &&
        /界面偏好/.test(factoryAsk.body),
      `正文 ${factoryAsk.body.slice(0, 120)}…`)

    /**
     * 点确认之后：清库 + 清 IndexedDB + 抹 userData，然后**应用自己**在 800ms 后重载。
     * 这里不能紧跟一句 Page.reload —— 那会和上面那步抢跑（重置还没做完就把文档换掉）。
     * 改成埋标记 + 轮询等它落定：标记是旧文档里的，新文档必然没有。
     */
    const confirmClick = await session.eval(`(() => {
      window.__e2eOldDoc = 1
      const btn = Array.from(document.querySelectorAll('.el-message-box button'))
        .find(b => b.textContent.trim() === '确认恢复到出厂设置')
      if (!btn) return { error: '确认框里找不到「确认恢复到出厂设置」按钮' }
      btn.click()
      return { clicked: true }
    })()`)
    /**
     * 抢一眼那颗提示。为什么要在 Node 侧轮询、而不是在页面里 await：提示消失的那一刻
     * 正是应用自己 `location.reload()` 的那一刻，页面里的 await 会随上下文一起被销毁
     * （求值抛异常 ⇒ 整轮 e2e 被打断，只剩一句 TypeError）。这里改成"每 120ms 问一次，
     * 问不到或文档已换新就停" —— 换新时求值会抛，那是导航的正常现象，break 即可。
     *
     * 这条要抓的是"假警报"：重置明明成功了，却因为 IndexedDB 那边有连接在用而报一句
     * "未能清除"。抢不到提示不算失败（可能它一转眼就被重载盖掉了），所以文案里写明。
     */
    let 出厂提示 = '(没抢到，可能一转眼就被重载盖掉)'
    const 提示期限 = Date.now() + 4000
    while (Date.now() < 提示期限) {
      try {
        const t = await session.eval(
          `(() => { const m = document.querySelector('.el-message'); return m ? m.textContent.replace(/\\s+/g, ' ').trim() : null })()`
        )
        if (t) { 出厂提示 = t; break }
      } catch { break }
      await sleep(120)
    }
    check('恢复出厂：成功之后不冒"未能清除"这类假警报（真失败与"等重启清完"分开说）',
      !/未能清除|失败/.test(出厂提示), `提示「${出厂提示}」`)

    const factorySettled = await waitForFreshDoc(session, '.lock-screen .lock-btn-ghost', 40000)
    const factoryState = await session.eval(`(async () => {
      const d = await import('/src/utils/database.js')
      const root = document.querySelector('.lock-screen')
      const get = (k) => { try { return localStorage.getItem(k) } catch { return '不可读' } }
      return {
        view: root ? (root.getAttribute('data-lock-view') || '') : '',
        sub: (document.querySelector('.lock-sub') || {}).textContent || '',
        锁配置: get('ks:app-lock'), 首启标记: get('ks:lock-setup-seen'),
        老师傅: get('ks:master-mode'), 引导: get('ks:tour-seen'), 主题: get('ks:theme'),
        对话: get('ai_chat_messages'), 钉住: get('mining-nav-pinned'),
        dbReady: d.isReady() === true
      }
    })()`)
    check('恢复出厂：点完真的重载并回到首启那一屏（锁配置与首启标记一起被清 —— 本缺陷的正主）',
      confirmClick.clicked === true && factorySettled === true &&
        factoryState.view === 'setup' && /首次使用/.test(factoryState.sub) &&
        factoryState.锁配置 === null && factoryState.首启标记 === null,
      confirmClick.error ||
        `落定=${factorySettled} 视图=${factoryState.view || '(无)'} 锁配置=${factoryState.锁配置} 标记=${factoryState.首启标记}`)
    check('恢复出厂：偏好与对话记录一并回默认（这正是与锁屏「清空自救」最大的区别 —— 自救留着偏好）',
      factoryState.老师傅 === null && factoryState.引导 === null && factoryState.主题 === null &&
        factoryState.对话 === null && factoryState.钉住 === null,
      `老师傅=${factoryState.老师傅} 引导=${factoryState.引导} 主题=${factoryState.主题} 对话=${factoryState.对话} 钉住=${factoryState.钉住}`)
    check('恢复出厂：这一屏上数据库还没起来（结构保证 —— 走完设锁才装载，不是"先播种再挡一层"）',
      factoryState.dbReady === false, `isReady=${factoryState.dbReady}`)

    // 走完首启那一屏 ⇒ 库重新播种。不点跳过的话后面没有可断言的"主界面"。
    await session.eval(LOCK_HELPER)
    const afterWipe = await withLockHelper(`(async () => {
      const ghost = document.querySelector('.lock-btn-ghost')
      if (!ghost) return { ok: false, why: '出厂后那一屏上没有「跳过」按钮' }
      ghost.click()
      const deadline = Date.now() + 30000
      while (Date.now() < deadline && !document.querySelector('.app-main')) {
        await new Promise(r => setTimeout(r, 300))
      }
      const d = await import('/src/utils/database.js')
      location.hash = '#/dashboard'
      await new Promise(r => setTimeout(r, 2200))
      const first = document.querySelector('.stat-value')
      const ready = d.isReady() === true
      return {
        ok: true,
        dbReady: ready,
        // 库没起来就别去 count（会抛，把整轮打断只剩一句 TypeError）—— 交给断言报红
        equipCount: ready ? d.count('equipment') : -1,
        firstStat: first ? first.textContent.trim() : ''
      }
    })()`)
    check('恢复出厂：走完首启那一屏后演示数据重新播种（不是留下一台空库）',
      afterWipe.ok === true && afterWipe.dbReady === true && afterWipe.equipCount > 0 &&
        afterWipe.firstStat === String(afterWipe.equipCount),
      afterWipe.why ||
        `台账 ${afterWipe.equipCount} 台 / 看板显示「${afterWipe.firstStat}」 isReady=${afterWipe.dbReady}`)

    // ---------- 汇总 ----------
    console.log('')
    for (const c of checks) {
      console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`)
    }
    const failed = checks.filter(c => !c.ok)
    console.log('')
    console.log(`运行时异常 exceptionThrown: ${session.exceptions.length}`)
    session.exceptions.slice(0, 6).forEach(e => console.log('  ! ' + e))
    console.log(`console.error: ${session.consoleErrors.length}`)
    session.consoleErrors.slice(0, 6).forEach(e => console.log('  ! ' + e))
    console.log(`\n合计 ${checks.length} 项，通过 ${checks.length - failed.length} 项，失败 ${failed.length} 项`)

    ws.close()
    if (failed.length || session.exceptions.length) process.exitCode = 1
  } finally {
    shutdown()
  }
}

main().catch(error => {
  console.error('❌ e2e 执行失败:', error && error.message ? error.message : error)
  if (error && error.stack) console.error('堆栈：\n' + error.stack)
  /**
   * 崩在半路时，也要把**已经收集到的**断言打出来。
   *
   * 原先这里只报异常，于是"一条断言失败 → 后续求值跟着炸掉"这种连锁会把
   * 前面那些 FAIL 的诊断**一起吞掉**（detail 里才有现场数值），日志上只剩一个
   * TypeError，哪里坏了全靠猜。checks 是模块级的，兜住它不花什么代价；
   * 后面若干段跑不到，如实说明"跑到第几条崩的"就够了。
   */
  if (checks.length) {
    const 失败 = checks.filter(c => !c.ok)
    console.error(`\n崩前已跑 ${checks.length} 条，失败 ${失败.length} 条：`)
    for (const c of 失败) console.error(`  FAIL  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`)
  }
  process.exit(1)
})

// 兜底：任何未捕获的异常都要打出完整堆栈，避免只看到一句 "Illegal invocation"
process.on('uncaughtException', (error) => {
  console.error('❌ 未捕获异常:', error && error.stack ? error.stack : error)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  console.error('❌ 未处理的 Promise 拒绝:', reason && reason.stack ? reason.stack : reason)
  process.exit(1)
})
