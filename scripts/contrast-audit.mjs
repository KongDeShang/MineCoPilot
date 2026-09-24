/**
 * 矿山智工 - 全站文字对比度审计（WCAG 2.1 AA · 1.4.3）
 *
 * 为什么需要它：
 *   `npm run e2e` 断言的是"数据和交互对不对"，对比度这类缺陷在 DOM 层是
 *   "存在、可见、文案正确"，结构上抓不到。而本项目大量文字压在 Element Plus
 *   的语义色上，EP 又把 `--el-color-*` 同时当"面色"和"字色"用 ——
 *   2.28:1、3.03:1 这类不达标是静默的，肉眼看"还行"，量化才看得见。
 *   接进 verify 是为了让它变成回归门禁：以后谁把某个字色调回浅色，这一步会红。
 *
 * 判定口径（刻意写死在这里，避免"这次放宽一点"）：
 *   · 正文 4.5:1；大号文本（≥24px，或 ≥18.66px 且 bold）3:1   —— WCAG AA
 *   · 跳过 disabled / aria-disabled 祖先内的文字          —— 1.4.3 对 inactive
 *     组件有明确豁免，把禁用态算成"不达标"会让门禁永远红着，等于没有门禁
 *   · 底色按**真实绘制**解析，而不是按 DOM 祖先链：
 *       祖先链会把"定位在色块上方 1px"的文字判成压在色块上，
 *       基于祖先链的判定会把这个误报固化进门禁（见下方 effectiveBg 注释）
 *
 * 用法：
 *   npm run audit:contrast      （开发服务器没起就自动拉一个，跑完自动收掉）
 * 可选环境变量：E2E_BASE_URL、E2E_CDP_PORT
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureServer, stopServer, seedTourSeen } from './devServer.mjs'

const BASE = process.env.E2E_BASE_URL || 'http://localhost:5173'
const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9223)
const CDP = `http://127.0.0.1:${CDP_PORT}`

/** 审计主题：light | dark（--dark 或 CONTRAST_THEME=dark 跑深色令牌下的 16 路由） */
const THEME = (process.argv.includes('--dark') || process.env.CONTRAST_THEME === 'dark') ? 'dark' : 'light'
const isDark = THEME === 'dark'

/** 深色注入脚本：文档创建早期就设好，避免深色偏好用户闪白干扰采样 */
const DARK_INJECT = `document.documentElement.setAttribute('data-theme','dark');document.documentElement.classList.add('dark');'ok'`

const ROUTES = [
  // '/' 原先是落地页，该页已删除（2026-09-24）：现在 '/' 只是 redirect 到 /dashboard，
  // 留在表里等于把看板审两遍，也掩盖不了少审一页这件事，所以去掉。
  '/dashboard', '/equipment', '/medical-records', '/alert-center',
  '/maintenance-calendar', '/workorder', '/recheck', '/ai-assistant',
  '/model-hub', '/knowledge-base', '/documents', '/fault-cases',
  '/parts-inventory', '/logs', '/settings'
]

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

const sleep = ms => new Promise(r => setTimeout(r, ms))

function findBrowser() {
  for (const c of CHROME_CANDIDATES) {
    if (c && existsSync(c)) return c
  }
  return null
}

/**
 * 注入页面的探针。
 *
 * 写成函数再用 toString() 注入，是为了让它仍然是一段**能被 lint 和编辑器解析的真 JS**；
 * 若写成模板字符串，里面所有的 `${}` 和反引号都要转义，改一次错一次。
 * 因此：函数体内不能引用任何模块作用域的东西。
 */
function probe() {
  // ---------- 颜色 ----------
  const parse = s => {
    const m = String(s).match(/rgba?\(([^)]+)\)/)
    if (!m) return null
    const p = m[1].split(',').map(Number)
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
  }
  const lum = c => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
  }
  const ratio = (a, b) => {
    const x = lum(a), y = lum(b)
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
  }
  const hex = c => '#' + [c.r, c.g, c.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')

  // ---------- 渐变 ----------
  /** 按顶层逗号切分（rgb(...) 内部的逗号不能当分隔符） */
  function splitTop(s) {
    const out = []
    let depth = 0, cur = ''
    for (const ch of s) {
      if (ch === '(') depth++
      else if (ch === ')') depth--
      if (ch === ',' && depth === 0) { out.push(cur); cur = '' } else cur += ch
    }
    out.push(cur)
    return out
  }
  function angleOf(spec) {
    const s = spec.trim().toLowerCase()
    if (/^-?[\d.]+deg$/.test(s)) return parseFloat(s)
    if (s === 'to top') return 0
    if (s === 'to right') return 90
    if (s === 'to bottom') return 180
    if (s === 'to left') return 270
    if (/^to (top right|right top)$/.test(s)) return 45
    if (/^to (bottom right|right bottom)$/.test(s)) return 135
    if (/^to (bottom left|left bottom)$/.test(s)) return 225
    if (/^to (top left|left top)$/.test(s)) return 315
    return null
  }
  /** 只认 linear-gradient；解析不出返回 null（调用方按"跳过"处理并计数） */
  function parseGradient(bgImage) {
    const m = /^linear-gradient\((.*)\)$/is.exec(String(bgImage).trim())
    if (!m) return null
    const parts = splitTop(m[1]).map(p => p.trim()).filter(Boolean)
    let angle = 180
    if (parts.length && !/^rgba?\(/.test(parts[0])) {
      const a = angleOf(parts[0])
      if (a == null) return null
      angle = a
      parts.shift()
    }
    if (!parts.length) return null
    const stops = []
    for (const p of parts) {
      const cm = /(rgba?\([^)]+\))/.exec(p)
      if (!cm) return null
      const color = parse(cm[1])
      if (!color) return null
      const pm = /([\d.]+)%/.exec(p)
      stops.push({ color, pos: pm ? parseFloat(pm[1]) / 100 : null, raw: p })
    }
    if (!stops.length) return null
    // 未标位置的按均匀分布补
    if (stops[0].pos == null) stops[0].pos = 0
    if (stops[stops.length - 1].pos == null) stops[stops.length - 1].pos = 1
    const holes = stops.filter(s => s.pos == null)
    if (holes.length) {
      let i = 0
      while (i < stops.length) {
        if (stops[i].pos == null) {
          let j = i
          while (j < stops.length && stops[j].pos == null) j++
          const lo = stops[i - 1].pos, hi = stops[j].pos, n = j - i + 1
          for (let k = i; k < j; k++) stops[k].pos = lo + (hi - lo) * (k - i + 1) / n
          i = j
        } else i++
      }
    }
    const sorted = stops.filter(s => s.pos != null).sort((x, y) => x.pos - y.pos)
    if (!sorted.length) return null
    return {
      angle,
      stops: sorted.map(s => ({ r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a, pos: s.pos }))
    }
  }
  /**
   * 渐变在 (x,y) 处的颜色：把点投影到渐变轴上插值。
   * **alpha 也要插值** —— 本项目大量渐变是 `linear-gradient(135deg, rgba(232,111,109,.15), …)`
   * 这种半透明叠加层，当成不透明来算会把底色算成 stop 的原色（实测把
   * 白字/#e8eefb 判成压在 #e87a69 上，2.44:1；真实合成后是深底，8:1 以上）。
   */
  function gradientAt(grad, rect, x, y) {
    const th = grad.angle * Math.PI / 180
    const sin = Math.sin(th), cos = Math.cos(th)
    const L = Math.abs(rect.width * sin) + Math.abs(rect.height * cos)
    if (!L) return grad.stops[0]
    const proj = (x - (rect.left + rect.width / 2)) * sin - (y - (rect.top + rect.height / 2)) * cos
    const t = Math.min(1, Math.max(0, 0.5 + proj / L))
    const st = grad.stops
    if (t <= st[0].pos) return st[0]
    if (t >= st[st.length - 1].pos) return st[st.length - 1]
    for (let i = 0; i < st.length - 1; i++) {
      const a = st[i], b = st[i + 1]
      if (t >= a.pos && t <= b.pos) {
        const k = b.pos === a.pos ? 0 : (t - a.pos) / (b.pos - a.pos)
        return {
          r: a.r + (b.r - a.r) * k,
          g: a.g + (b.g - a.g) * k,
          b: a.b + (b.b - a.b) * k,
          a: a.a + (b.a - a.a) * k
        }
      }
    }
    return st[st.length - 1]
  }

  // ---------- 底色 ----------
  let skippedGradient = 0

  /**
   * 沿祖先链合成底色（半透明按 alpha 叠加，不"遇到第一个就当不透明"——
   * 本项目大量用的是 rgba(255,255,255,0.03) 这类极淡底色，必须真叠）。
   * 遇到渐变就按 (x,y) 求值。返回 null 表示渐变解析不了（计数器会记一笔）。
   *
   * **关键：只有当采样点真的落在某个祖先的盒子内，它的背景才画在文字下面。**
   * 不判断这一点会得到一批误报，典型是 `.bar-value` —— 它绝对定位、底边比柱顶还高
   * 1.5px，祖先链会走到绿色的 `.trend-bar` 算出 2.63:1，而文字实际画在卡片上（8.8:1）。
   * 曾经用 elementFromPoint 复核，但命中测试看不到视口外的元素，折线图在首屏之下时
   * 复核直接返回 null，误报照样进门禁；几何包含判断在任何滚动位置都成立。
   */
  function bgByTree(el, x, y) {
    const layers = []
    let n = el
    while (n && n.nodeType === 1) {
      const box = n.getBoundingClientRect()
      const covers = x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
      if (!covers) { n = n.parentElement; continue }
      const cs = getComputedStyle(n)
      if (cs.backgroundImage && cs.backgroundImage !== 'none') {
        /**
         * background-image 可以叠**多层**（本项目里最常见的写法就是
         * 「压暗层 + 色层」：linear-gradient(rgba(0,0,0,.3), …), linear-gradient(120deg,…)）。
         * Chrome 的 computed 值把各层按 CSS 顺序拼成一串，必须按顶层逗号拆开逐层解析：
         * 整串丢给 parseGradient 会被 `^linear-gradient\((.*)\)$` 贪婪吞掉，
         * 只剩第一层 —— 于是 0.3 的黑色压在**页面底色**上被算成一块灰，
         * 报出「白字压 #a2a5a9，2.47:1」这种查无实据的不达标。
         * 按 CSS 顺序 push（第一层在最上），flatten 从后往前合成，顺序正好接得上。
         */
        const imgs = splitTop(cs.backgroundImage).map(s => s.trim()).filter(Boolean)
        let opaque = false
        for (const img of imgs) {
          const grad = parseGradient(img)
          if (!grad) return null
          layers.push({ grad, rect: box })
          // 任意一层全不透明，它下面的层就看不见了，可以停止上溯（见 gradientAt 的注释）
          if (grad.stops.every(s => s.a >= 0.999)) opaque = true
        }
        if (opaque) break
        n = n.parentElement
        continue
      }
      const c = parse(cs.backgroundColor)
      if (c && c.a > 0) layers.push({ color: c })
      if (c && c.a >= 0.999) break
      n = n.parentElement
    }
    return flatten(layers, x, y)
  }

  function flatten(layers, x, y) {
    let base = { r: 255, g: 255, b: 255 }
    for (let i = layers.length - 1; i >= 0; i--) {
      const L = layers[i]
      const c = L.grad ? gradientAt(L.grad, L.rect, x, y) : L.color
      const a = c.a
      if (a <= 0) continue
      base = { r: c.r * a + base.r * (1 - a), g: c.g * a + base.g * (1 - a), b: c.b * a + base.b * (1 - a) }
    }
    return { ...base, a: 1 }
  }

  // ---------- 扫描 ----------
  const violations = []
  let checked = 0, checkedText = 0, checkedClip = 0

  for (const el of document.querySelectorAll('*')) {
    const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    if (!own) continue
    const rect = el.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.15) continue
    const fg = parse(cs.color)
    if (!fg || fg.a < 0.9) continue

    // disabled / aria-disabled 祖先内的文字：WCAG 1.4.3 明确豁免，不参与判定
    let disabled = false
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (n.matches && n.matches('.is-disabled, [disabled], [aria-disabled="true"]')) { disabled = true; break }
    }
    checked++

    const size = parseFloat(cs.fontSize)
    const weight = Number(cs.fontWeight) || 400
    const large = size >= 24 || (size >= 18.66 && weight >= 700)
    const need = large ? 3 : 4.5

    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2

    /**
     * 文字被自己的背景"涂"出来（`background-clip: text` + 透明的 text-fill-color）：
     * 这时 cs.color 根本不参与绘制，拿它算出来的比值毫无意义。
     *
     * 这段是为落地页那行「矿山智工」大标题写的（--grad-hero 裁进文字），会被误报成
     * #e8eefb 压在 #15b9c8 的 2.06:1 —— 而 #e8eefb 压根没画上去。**该页已于
     * 2026-09-24 删除，当前全站没有任何元素走 background-clip: text**，所以这条分支
     * 现在是**故意留着的未触发路径**：它只有几十行、不触发时零成本，而一旦以后再做
     * 带渐变标题的页面（用户已明确打算再补 UI 设计），缺了它就会得到一个假报警，
     * 而假报警会让人开始不信这套审计 —— 那比少一条检查更糟。
     *
     * 这种元素真正该判的是**渐变自己**：把每个色标当作前景、把元素**外面**那层
     * 背景当作底色，取最差的一个。所以底色要从父元素开始往上找 —— 元素自己那层
     * 渐变就是文字本身，当成底色会把比值恒算成 1:1。
     */
    const fillTransparent = cs.webkitTextFillColor === 'rgba(0, 0, 0, 0)'
    const clipText = `${cs.backgroundClip} ${cs.webkitBackgroundClip || ''}`.includes('text')
    if (fillTransparent && clipText) {
      const grad = parseGradient(cs.backgroundImage)
      const backdrop = bgByTree(el.parentElement || el, x, y)
      if (grad && grad.stops.length && backdrop) {
        checkedText++
        checkedClip++
        let worst = null
        for (const s of grad.stops) {
          const rr = ratio({ r: s.r, g: s.g, b: s.b, a: 1 }, backdrop)
          if (!worst || rr < worst.ratio) worst = { ratio: rr, r: s.r, g: s.g, b: s.b, a: 1 }
        }
        if (worst && worst.ratio < need && !disabled) {
          violations.push({
            text: own.slice(0, 20),
            ratio: Math.round(worst.ratio * 100) / 100,
            fg: hex(worst),
            bg: hex(backdrop),
            size,
            weight,
            need,
            tag: el.tagName.toLowerCase(),
            cls: String(el.className || '').slice(0, 44)
          })
        }
      } else {
        skippedGradient++
      }
      continue
    }

    let bg = bgByTree(el, x, y)
    if (!bg) { skippedGradient++; continue }

    checkedText++
    const r = ratio(fg, bg)
    if (r < need) {
      if (disabled) continue
      violations.push({
        text: own.slice(0, 20),
        ratio: Math.round(r * 100) / 100,
        fg: hex(fg),
        bg: hex(bg),
        size,
        weight,
        need,
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || '').slice(0, 44)
      })
    }
  }

  return { violations, checked, checkedText, checkedClip, skippedGradient }
}

async function waitForCDP(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`${CDP}/json/list`)).json()
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch { /* 还没起来 */ }
    await sleep(400)
  }
  return null
}

async function main() {
  const browser = findBrowser()
  if (!browser) {
    console.error('❌ 找不到 Chrome / Edge，可用 CHROME_PATH 指定')
    process.exit(2)
  }

  const devServer = await ensureServer(BASE)
  const profileDir = mkdtempSync(join(tmpdir(), 'ks-contrast-'))
  const child = spawn(browser, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
    '--window-size=1440,900', 'about:blank'
  ], { stdio: 'ignore' })

  const shutdown = () => {
    try { child.kill() } catch { /* 已退出 */ }
    try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    stopServer(devServer)
  }

  const perRoute = []
  const global = new Map()

  try {
    const target = await waitForCDP()
    if (!target) throw new Error('CDP 未就绪')
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

    let id = 0
    const pending = new Map()
    ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id)
        pending.delete(m.id)
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
      }
    }
    const send = (method, params = {}) => {
      const mid = ++id
      return new Promise((resolve, reject) => {
        pending.set(mid, { resolve, reject })
        ws.send(JSON.stringify({ id: mid, method, params }))
        setTimeout(() => {
          if (pending.has(mid)) { pending.delete(mid); reject(new Error(`${method} 超时`)) }
        }, 30000)
      })
    }

    await send('Runtime.enable')
    await send('Page.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    // 首启引导演示的遮罩会盖住要取色的内容（取到的是遮罩而不是页面底色）；本套件不验引导，种上标记跳过
    await seedTourSeen({ send })
    // 深色模式：文档创建早期注入（覆盖首次导航；SPA 内 hash 导航不重建文档，无影响）
    if (isDark) {
      await send('Page.addScriptToEvaluateOnNewDocument', { source: DARK_INJECT })
    }
    // 首启要播种演示数据 + 导入随包手册
    await send('Page.navigate', { url: `${BASE}/#/dashboard` })
    await sleep(9000)

    const expression = `(${probe.toString()})()`
    for (const route of ROUTES) {
      await send('Page.navigate', { url: `${BASE}/#${route}` })
      await sleep(2600)
      // 深色兜底：bootstrap 的 applyPref 可能把主题改回浅色（新库 meta 无偏好），
      // 采样前再设一次，保证所有路由都在深色令牌下判定
      if (isDark) {
        await send('Runtime.evaluate', { expression: DARK_INJECT })
        /**
         * 翻完主题必须**等它稳定**再采样，不能紧接着就量。
         *
         * 本项目有十几处 0.15~0.3s 的 `transition: background/color`
         * （tokens.css 的统一时长段 + EP 组件自带的过渡），翻主题会把这些元素
         * 从浅色**动画**到深色。翻完立刻采样等于拍动画帧：实测第一屏报出 109 处
         * "不达标"，全是「#e8eefb 压 #ffffff」「#0a1326 压 #121b30」这种半途颜色，
         * 而同一批元素稳定下来是 6.58:1，达标。
         *
         * 为什么只有第一条路由中招：hash 导航不重建文档，深色属性会留在 html 上，
         * 之后每条路由的"兜底注入"都是空操作（已经是深的），也就没有过渡；
         * 只有第一条路由是真正从浅翻到深。所以这是个**只在 /dashboard 上出现**的
         * 假门禁 —— 最容易被人当成"深色主题问题很多"而放宽阈值，把真问题一起放过。
         */
        await sleep(600)
      }
      const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (res.exceptionDetails) {
        console.error(`  ${route}  探针抛错: ${res.exceptionDetails.exception?.description?.slice(0, 160)}`)
        perRoute.push({ route, error: true, n: 0 })
        continue
      }
      const { violations, checkedText, checkedClip, skippedGradient } = res.result.value
      perRoute.push({ route, n: violations.length, checkedText, checkedClip, skippedGradient })
      for (const v of violations) {
        const key = `${v.fg}|${v.bg}|${v.size}|${v.need}`
        if (!global.has(key)) global.set(key, { ...v, count: 0, routes: new Set() })
        const g = global.get(key)
        g.count++
        g.routes.add(route)
      }
    }
    ws.close()
  } finally {
    shutdown()
  }

  console.log('')
  console.log(`对比度审计（${THEME === 'dark' ? '深色' : '浅色'}主题）`)
  for (const r of perRoute) {
    if (r.error) { console.log(`  ${r.route.padEnd(22)} 探针失败`); continue }
    const worst = r.n ? `  ← ${r.n} 处` : ''
    console.log(`  ${r.route.padEnd(22)} 检查 ${String(r.checkedText).padStart(4)} 处文字${worst}`)
  }

  const list = [...global.values()].sort((a, b) => a.ratio - b.ratio)
  /**
   * 把"没查成的"也报出来。门禁只报违规、不报跳过，是拿绿色当橡皮图章 ——
   * 探针看不见的元素和真正达标的元素在输出里长得一模一样。
   * 所以只要有一处没算成，就在结论旁边写清楚有多少处、为什么。
   */
  const clipTotal = perRoute.reduce((s, r) => s + (r.checkedClip || 0), 0)
  const skipTotal = perRoute.reduce((s, r) => s + (r.skippedGradient || 0), 0)
  console.log('')
  if (clipTotal) console.log(`  （另有 ${clipTotal} 处是渐变裁字，已按渐变各色标对底判定）`)
  if (skipTotal) {
    /**
     * 跳过项计入失败，而不是只打一行警告。
     *
     * 原来的注释已经点名了风险（"门禁只报违规、不报跳过，是拿绿色当橡皮图章"），
     * 但代码只 `console.log` 一行警告、退出码照样是 0 —— 也就是说：哪天样式改动
     * 把大批文字推进"算不出底色"这条分支，审计会**变绿**，而真正被判定过的文字
     * 其实是 0 处。这与 #27（报告预览被 display:none 藏起来却全绿）是同一类：
     * 判不了 ≠ 达标。当前实跑 skipTotal = 0，所以这条收紧不影响现有基线。
     */
    console.log(`  ❌ 有 ${skipTotal} 处文字没能算出底色（背景链里有无法解析的渐变），未参与判定 —— 按失败处理`)
    process.exitCode = 1
  }
  console.log('')
  if (!list.length) {
    console.log('✅ 全部达标：未发现低于 WCAG AA 的文字配色')
  } else {
    console.log('❌ 以下配色未达 WCAG AA（1.4.3）：')
    for (const v of list) {
      console.log(`  ${String(v.ratio).padStart(5)}:1 (需 ${v.need}:1)  字 ${v.fg} / 底 ${v.bg}  ${v.size}px w${v.weight}  ×${v.count}  「${v.text}」 ${v.cls}`)
      console.log(`        出现于 ${[...v.routes].join(' ')}`)
    }
    console.log(`\n合计 ${list.length} 类配色不达标`)
  }
  if (list.length) process.exitCode = 1
}

main().catch(error => {
  console.error('❌ 对比度审计执行失败:', error && error.message ? error.message : error)
  if (error && error.stack) console.error('堆栈：\n' + error.stack)
  process.exit(1)
})

process.on('uncaughtException', error => {
  console.error('❌ 未捕获异常:', error && error.stack ? error.stack : error)
  process.exit(1)
})
process.on('unhandledRejection', reason => {
  console.error('❌ 未处理的 Promise 拒绝:', reason && reason.stack ? reason.stack : reason)
  process.exit(1)
})
