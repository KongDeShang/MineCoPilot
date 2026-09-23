/**
 * 矿山智工 - 打印 / 导出 PDF 统一入口（printDoc.js）
 *
 * 为什么要单独有这个文件（两个已确认的缺陷）：
 *   1) DeviceRecords.vue 原来的 printReport() 用 window.open('', '_blank') 拼了一个只有
 *      <title> 的裸文档，把报告 HTML 写进去就打印 —— 一张样式表都没带。
 *      报告的全部观感来自 styles/healthReport.css（main.js 里全局引入的那一份），
 *      以及 tokens.css 的 --danger / --amber / --ink-4 等令牌；新窗口里两者都不存在，
 *      于是打印出来是一堆没有排版的纯 HTML。
 *   2) 桌面端根本走不到那一步：src/main/index.js 的 setWindowOpenHandler 一律返回
 *      { action: 'deny' }（外部链接交给系统浏览器），window.open 返回 null。
 *      这个按钮在 Electron 里永远打不开窗口，只弹一句"浏览器拦截了打印窗口，
 *      请允许弹窗"—— 把产品自身的缺陷写成了用户的弹窗设置问题。
 *
 * 本文件的策略（对外只有一个入口，Electron 与浏览器都能出纸）：
 *   · 首选"隐藏容器 + window.print()"：把一份**自带完整打印样式**的报告副本注入 body 末尾的
 *     隐藏容器，打印期间只显示这一个容器（其余 body 子树整体退出布局），打完拆掉。
 *     为什么选它：主框架的 window.print() 在这套 Electron 里已有两处稳定出纸的实证
 *     （Equipment.vue 的报告与设备身份证一直靠它出纸），而 window.open 被主进程拒绝；
 *     自建容器还绕开了屏幕预览层的两个坑 —— el-card / el-drawer 都带 overflow: hidden，
 *     而体检报告是多页 A4，若直接给预览层里的 .print-doc 加打印类，报告会被卡片裁掉，
 *     挂在 body 上的自建容器是唯一没有裁剪祖先的位置。
 *     代价：打印期间要临时改动活文档（注入一个容器 + 给 <html> 加一个类），所以清理必须可靠
 *     —— 见 cleanupPrintDoc()：afterprint + 兜底超时 + 下一次打印前先清。
 *   · 纯浏览器（没有 electronAPI，如用 Chrome 打开 vite 开发服务）先试 window.open：
 *     新窗口写入完整独立文档（标题 + 内置样式 + 运行时颜色），可在新窗口里另存 PDF。
 *     弹窗被拦截（返回 null）时**静默降级**到上面那条容器路径 —— 不再提示"请允许弹窗"。
 *
 * 为什么不用隐藏 iframe + contentWindow.print()：那依赖 Chromium 的子框架打印路径，
 * 本项目离线环境无法实测；而主框架 window.print() 有实证，容器路径风险最低。
 *
 * 不依赖任何 Vite 专有语法（没有 ?inline、没有 import CSS）：
 * 这份样式是下面的普通模板字符串，scripts/self-check.mjs 把 utils/*.js 镜像成 .mjs
 * 直接导入时不会因为"导入了一个 CSS 文件"而崩，Node 侧也能读到同一份实现。
 */

import { escapeHtml } from './html'

/** 打印期间注入的容器类名（也是独立文档里的纸张容器类名） */
const HOST_CLASS = 'print-doc-standalone'
/** 挂在 <html> 上的激活类：只有带它时才启用"隐藏整页、只留报告"的打印规则，
 *  这样即使容器因故残留，也不会去影响别的打印（如设备身份证的 print-passport-active） */
const ACTIVE_CLASS = 'print-doc-standalone-active'
/** 兜底清理时长：afterprint 在个别环境下不一定触发，容器留着会误伤下一次打印 */
const CLEANUP_TIMEOUT_MS = 60000

/**
 * 报告要用到的令牌 + **浅色**字面兜底值。
 *
 * 兜底值就是 styles/tokens.css 浅色主题的值：报告的语义是一张白纸，
 * 浅色主题值即"纸面值"——healthReport.css 的深色块也是把报告区拉回这同一组值。
 * 这里只写兜底，正常路径的值都在运行时从活文档里读（见 resolveToken）。
 */
const TOKENS = {
  accent: ['--accent', '#0b3a82'],
  accentContrast: ['--accent-contrast', '#ffffff'],
  text1: ['--text-1', '#0a1326'],
  text2: ['--text-2', '#3d4b63'],
  text3: ['--text-3', '#57647a'],
  textMute: ['--text-mute', '#67738a'],
  line: ['--line', '#dde4ef'],
  line2: ['--line-2', '#ebf0f7'],
  card2: ['--card-2', '#fafcff'],
  bgSunken: ['--bg-sunken', '#e6ecf5'],
  warnInk: ['--warn-ink', '#8a5d0a'],
  amberSoft: ['--amber-soft', '#fdf3dc'],
  dangerInk: ['--danger-ink', '#b33431'],
  danger: ['--danger', '#e0413e'],
  amber: ['--amber', '#e0a020'],
  ink4: ['--ink-4', '#8a95a7']
}

/** 当前打印容器（清理时优先摘掉它，再兜底扫一遍同名残留） */
let activeHost = null
let cleanupTimer = null

/** 桌面端（Electron）判定：preload 暴露的白名单入口 */
function isElectron() {
  return typeof window !== 'undefined' && !!window.electronAPI
}

/** 深色主题判定：tokens.css 用 html[data-theme="dark"]，Element Plus 另用 .dark */
function isDarkTheme() {
  try {
    const el = document.documentElement
    return el.dataset.theme === 'dark' || el.classList.contains('dark')
  } catch (error) {
    return false
  }
}

/**
 * 读根元素上的一个令牌。
 * 必须逐项兜底：属性可能为空（样式表未加载、令牌被改名、非浏览器环境），
 * 空值会直接写进 CSS 变成 `--pd-text-1: ;`，那样整块声明都作废。
 */
function readToken(name) {
  try {
    const value = window.getComputedStyle(document.documentElement).getPropertyValue(name)
    return value ? value.trim() : ''
  } catch (error) {
    return ''
  }
}

/**
 * 读"白纸作用域"上的令牌：屏幕上的报告预览（.health-report）本身已被
 * healthReport.css 在深色主题下拉回浅色令牌，能读到就直接用它的计算值 ——
 * 这样打印颜色与屏幕上看到的一致，且不必在这里抄一份令牌表。
 * 只接受字面色值：若拿到的是未解析的 var(...) 引用，说明取值环境不可信，交给兜底。
 */
function readPaperToken(name) {
  try {
    const probe = document.querySelector('.health-report')
    if (!probe) return ''
    const value = window.getComputedStyle(probe).getPropertyValue(name)
    const trimmed = value ? value.trim() : ''
    return /^(#|rgb|hsl|color\()/i.test(trimmed) ? trimmed : ''
  } catch (error) {
    return ''
  }
}

/**
 * 令牌 → 打印用字面色值。取值顺序：
 *   1) 报告预览区的计算值（白纸作用域，深色主题下已校正）
 *   2) 深色主题且没有预览区：直接用浅色字面兜底（报告永远是白纸，深色令牌压在白纸上读不出来）
 *   3) 根元素的令牌值（颜色随主题走）
 *   4) 浅色字面兜底
 */
function resolveToken(name, fallback) {
  return readPaperToken(name) || (isDarkTheme() ? '' : readToken(name)) || fallback
}

/**
 * 内置打印样式表：报告在**任何宿主**里都能独立成纸。
 * 直接把 A4 分页、板块排版、表格与"只留报告"的可见性规则一次给全，
 * 不再依赖调用方页面是否加载了 styles/healthReport.css。
 */
function buildPrintStyle() {
  const v = {}
  for (const [key, [name, fallback]] of Object.entries(TOKENS)) v[key] = resolveToken(name, fallback)
  const P = `.${HOST_CLASS}`

  return `
/* 令牌的值在 JS 里从当前主题读出来，这里只做接线 */
:root {
  --pd-accent: ${v.accent};
  --pd-accent-contrast: ${v.accentContrast};
  --pd-text-1: ${v.text1};
  --pd-text-2: ${v.text2};
  --pd-text-3: ${v.text3};
  --pd-text-mute: ${v.textMute};
  --pd-line: ${v.line};
  --pd-line-2: ${v.line2};
  --pd-card-2: ${v.card2};
  --pd-bg-sunken: ${v.bgSunken};
  --pd-warn-ink: ${v.warnInk};
  --pd-amber-soft: ${v.amberSoft};
  --pd-danger-ink: ${v.dangerInk};
  --pd-danger: ${v.danger};
  --pd-amber: ${v.amber};
  --pd-ink-4: ${v.ink4};
}

${P} *, ${P} *::before, ${P} *::after { box-sizing: border-box; }

/* 纸张容器：屏幕上永不占位，只参与打印 */
${P} { display: none; background: #fff; }
/* 独立文档（window.open 那条路）里它就是这个页面本身，要直接可见 */
body.print-doc-standalone-page ${P} { display: block; padding: 16px 20px; }
${P} .print-doc { display: block; }

/* 报告内部用的是 var(--text-1) 这类令牌，这里接到上面那份打印令牌上 */
${P} .health-report {
  --accent: var(--pd-accent);
  --accent-contrast: var(--pd-accent-contrast);
  --text-1: var(--pd-text-1);
  --text-2: var(--pd-text-2);
  --text-3: var(--pd-text-3);
  --text-mute: var(--pd-text-mute);
  --line: var(--pd-line);
  --line-2: var(--pd-line-2);
  --card-2: var(--pd-card-2);
  --bg-sunken: var(--pd-bg-sunken);
  --warn-ink: var(--pd-warn-ink);
  --amber-soft: var(--pd-amber-soft);
  --danger-ink: var(--pd-danger-ink);
  --danger: var(--pd-danger);
  --amber: var(--pd-amber);
  --ink-4: var(--pd-ink-4);
}

/* ===== 报告本体排版（styles/healthReport.css 的打印精简版） ===== */
${P} .health-report {
  font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif;
  color: var(--text-1);
  font-size: 13px;
  line-height: 1.7;
  background: #fff;
  padding: 0;
  /* 背景图形默认不打印：报告里的色条与彩底是语义的一部分，必须强制带上 */
  print-color-adjust: exact;
  -webkit-print-color-adjust: exact;
}
${P} .health-report h1 { font-size: 22px; margin: 0; letter-spacing: 2px; }
${P} .health-report h2 {
  font-size: 15px; margin: 22px 0 10px; padding-left: 8px;
  border-left: 3px solid var(--accent); color: var(--text-1); break-after: avoid;
}
${P} .hr-head {
  display: flex; justify-content: space-between; align-items: flex-start;
  border-bottom: 2px solid var(--accent); padding-bottom: 12px;
}
${P} .hr-sub { font-size: 12px; color: var(--text-3); margin-top: 4px; }
${P} .hr-badge {
  border: 3px solid; border-radius: 50%; width: 92px; height: 92px;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  flex-shrink: 0;
}
${P} .hr-badge-score { font-size: 30px; font-weight: 800; line-height: 1; }
${P} .hr-badge-level { font-size: 11px; margin-top: 2px; }
${P} .hr-meta { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px 18px; margin-top: 14px; }
${P} .hr-meta > div {
  display: flex; justify-content: space-between;
  border-bottom: 1px dashed var(--line); padding-bottom: 4px;
}
${P} .hr-meta span { color: var(--text-3); }
${P} .hr-conclusion {
  padding: 10px 14px; background: var(--card-2); border-left: 4px solid; font-size: 14px;
}
${P} .hr-history-line { margin-top: 8px; color: var(--text-2); font-size: 12px; }
${P} .hr-factors { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 20px; }
${P} .hr-factor-head { display: flex; justify-content: space-between; font-size: 13px; }
${P} .hr-factor-name { font-weight: 600; }
${P} .hr-factor-score { font-weight: 700; font-size: 13px; }
${P} .hr-bar { height: 6px; background: var(--bg-sunken); border-radius: 3px; overflow: hidden; margin: 4px 0; }
${P} .hr-bar-fill { height: 100%; background: var(--accent); border-radius: 3px; }
${P} .hr-factor-detail { font-size: 12px; color: var(--text-2); }
${P} .hr-factor-formula { font-size: 11px; color: var(--text-mute); }
${P} .hr-trend-svg { width: 100%; height: 110px; }
${P} .hr-trend-axis { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-mute); }
${P} .hr-trend-summary { margin-top: 6px; font-size: 12px; }
${P} .hr-table { width: 100%; border-collapse: collapse; font-size: 12px; }
${P} .hr-table th, ${P} .hr-table td {
  border: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top;
}
${P} .hr-table th { background: var(--line-2); font-weight: 600; }
${P} .hr-ref { color: var(--accent); }
${P} .hr-dot {
  display: inline-block; width: 7px; height: 7px; border-radius: 50%;
  margin-right: 6px; vertical-align: middle;
}
${P} .hr-note { font-size: 12px; color: var(--text-3); }
${P} .hr-estimate-tag {
  font-size: 11px; font-weight: 400; color: var(--warn-ink); background: var(--amber-soft);
  border-radius: 8px; padding: 1px 8px; margin-left: 8px;
}
${P} .hr-loss { text-align: center; padding: 14px 0 6px; }
${P} .hr-loss-value { font-size: 32px; font-weight: 800; color: var(--danger-ink); }
${P} .hr-loss-formula {
  font-size: 12px; color: var(--text-2); margin-top: 6px;
  font-family: Consolas, Monaco, monospace;
}
${P} .hr-urgent {
  font-size: 10px; color: var(--accent-contrast); background: var(--danger);
  border-radius: 6px; padding: 1px 6px; margin-left: 6px;
}
${P} .hr-mono { font-family: Consolas, Monaco, monospace; font-size: 11px; color: var(--text-2); }
${P} .hr-trace-table td { font-size: 11px; }
${P} .hr-foot { margin-top: 26px; border-top: 1px solid var(--line); padding-top: 14px; }
${P} .hr-sign { display: flex; justify-content: space-between; font-size: 12px; color: var(--text-2); }
${P} .hr-foot-note { margin-top: 12px; font-size: 11px; color: var(--text-mute); text-align: center; }

@media print {
  /* 只留报告：其余 body 子树（应用外壳、抽屉、对话框）整体退出布局。
     用 display:none 而不是 visibility:hidden —— 后者仍然占位，会把报告顶到第二页起。 */
  html.${ACTIVE_CLASS} body > *:not(.${HOST_CLASS}) { display: none !important; }
  html.${ACTIVE_CLASS}, html.${ACTIVE_CLASS} body { background: #fff !important; }

  /* healthReport.css 的打印规则会把 body 下所有元素设成 visibility:hidden，这里把纸张重新显出来 */
  html.${ACTIVE_CLASS} .${HOST_CLASS},
  html.${ACTIVE_CLASS} .${HOST_CLASS} * { visibility: visible !important; }

  html.${ACTIVE_CLASS} .${HOST_CLASS} {
    display: block !important; position: static !important; left: auto; top: auto;
    width: 100%; margin: 0; padding: 0; overflow: visible !important;
  }
  /* 容器里这一份 .print-doc 必须压掉 healthReport.css 的 position:absolute：
     多页 A4 要靠正常流才能正确分页 */
  html.${ACTIVE_CLASS} .${HOST_CLASS} .print-doc {
    display: block !important; position: static !important; width: 100%;
  }
  html.${ACTIVE_CLASS} .${HOST_CLASS} .health-report { padding: 0; }
  html.${ACTIVE_CLASS} .${HOST_CLASS} .hr-table { break-inside: auto; }
  html.${ACTIVE_CLASS} .${HOST_CLASS} .hr-table tr { break-inside: avoid; }
  html.${ACTIVE_CLASS} .${HOST_CLASS} .hr-table thead { display: table-header-group; }
  html.${ACTIVE_CLASS} .${HOST_CLASS} .hr-trace,
  html.${ACTIVE_CLASS} .${HOST_CLASS} .hr-foot { break-inside: avoid; }

  @page { size: A4; margin: 20mm 15mm; }
}
`
}

/**
 * 组装一份**完整的独立 HTML 文档**（自带样式与运行时颜色）。
 * 供 window.open 那条路使用，也可直接用于排查/导出。
 * @param {{title?: string, html?: string}} options
 * @returns {string} 完整文档字符串
 */
export function buildPrintDocument({ title, html } = {}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title || '体检报告')}</title>
<style>${buildPrintStyle()}</style>
</head>
<body class="print-doc-standalone-page">
<div class="${HOST_CLASS}">
${String(html || '')}
</div>
</body>
</html>`
}

/**
 * 浏览器路径：新窗口写入完整独立文档后打印。
 * 弹窗被拦截时返回 false，由调用方静默降级（不提示"请允许弹窗"）。
 */
function openStandaloneWindow(title, html) {
  try {
    const win = window.open('', '_blank')
    if (!win || !win.document) return false
    win.document.open()
    win.document.write(buildPrintDocument({ title, html }))
    win.document.close()
    // 等新窗口完成首帧渲染再唤起打印，否则容易打出空白页
    const fire = () => {
      try {
        win.focus()
        win.print()
      } catch (error) {
        /* 用户取消打印：无需处理 */
      }
    }
    if (typeof win.setTimeout === 'function') win.setTimeout(fire, 300)
    else setTimeout(fire, 300)
    return true
  } catch (error) {
    return false
  }
}

/**
 * Electron / 弹窗被拦截时的路径：把报告副本注入隐藏容器，用主窗口的 window.print() 出纸。
 * 不改 document.title：打印头注脚取的是文档标题，而改它必须等打印结束才能还原，
 * afterprint 并非所有环境都会触发，窗口标题就可能一直挂着别人的报告名。
 */
function printViaHiddenHost(html) {
  try {
    if (typeof document === 'undefined' || !document.body) return false

    const host = document.createElement('div')
    host.className = HOST_CLASS
    host.setAttribute('aria-hidden', 'true')
    // 样式随容器一起注入：报告不依赖调用方页面是否引入了 healthReport.css
    host.innerHTML = `<style>${buildPrintStyle()}</style>${html}`
    document.body.appendChild(host)
    activeHost = host
    document.documentElement.classList.add(ACTIVE_CLASS)

    window.addEventListener('afterprint', cleanupPrintDoc, { once: true })
    cleanupTimer = setTimeout(cleanupPrintDoc, CLEANUP_TIMEOUT_MS)

    window.print()
    return true
  } catch (error) {
    cleanupPrintDoc()
    return false
  }
}

/**
 * 清理打印期间注入的 DOM / 样式。
 * 三处调用：afterprint、兜底超时、下一次打印开始前（防止上一次的残留影响这一次）。
 */
export function cleanupPrintDoc() {
  if (cleanupTimer !== null) {
    try {
      clearTimeout(cleanupTimer)
    } catch (error) {
      /* 环境无定时器：忽略 */
    }
    cleanupTimer = null
  }

  const hosts = []
  if (activeHost) hosts.push(activeHost)
  try {
    for (const el of document.querySelectorAll(`.${HOST_CLASS}`)) {
      if (!hosts.includes(el)) hosts.push(el)
    }
  } catch (error) {
    /* 无 DOM 环境：只需要清掉自己那一个 */
  }
  for (const el of hosts) {
    try {
      el.remove()
    } catch (error) {
      if (el.parentNode) el.parentNode.removeChild(el)
    }
  }
  activeHost = null

  try {
    window.removeEventListener('afterprint', cleanupPrintDoc)
    document.documentElement.classList.remove(ACTIVE_CLASS)
  } catch (error) {
    /* 无 DOM 环境：忽略 */
  }
}

/**
 * 打印一份报告（并交给系统打印对话框，可另存为 PDF）。
 *
 * @param {{title?: string, html?: string}} options
 *        title 打印窗口/独立文档的标题；html 报告正文（healthReport.renderReportHtml 的产物）
 * @returns {boolean} 是否已成功唤起打印；false 表示没有可打印内容（调用方据此给提示）
 */
export function printHtmlReport({ title, html } = {}) {
  const body = String(html || '')
  if (!body.trim()) return false

  // 上一次打印若没等到 afterprint，容器会残留在 DOM 里（屏幕上看不见，但会误伤这一次）
  cleanupPrintDoc()

  // 纯浏览器开发态：优先开新窗口打完整独立文档；被拦截就静默降级，不再甩锅给用户的弹窗设置
  if (!isElectron() && openStandaloneWindow(title, body)) return true

  return printViaHiddenHost(body)
}
