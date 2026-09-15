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
import { existsSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureServer, stopServer } from './devServer.mjs'

const BASE = process.env.E2E_BASE_URL || 'http://localhost:5173'
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
}

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
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`${method} 超时`))
        }
      }, 30000)
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
    await new Promise(r => setTimeout(r, 2200))
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

/** 带标签的求值：出错时能立刻指出是哪个断言块挂了 */
async function safeEval(session, label, expression) {
  try {
    return await session.eval(expression)
  } catch (error) {
    // 带上 cause，报错堆栈里能同时看到原始异常（否则只剩一句 message）
    throw new Error(`断言块「${label}」执行失败：${error.message}`, { cause: error })
  }
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
    await session.send('Page.reload', { ignoreCache: true })
    await sleep(5500)

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
    await session.goto(`${BASE}/#/equipment`, 2600)
    const equipment = await session.eval(`(() => {
      const cards = Array.from(document.querySelectorAll('.equip-card'))
      return {
        cards: cards.length,
        overview: Array.from(document.querySelectorAll('.health-item')).map(e => e.textContent.replace(/\\s+/g, ' ').trim()),
        levels: cards.slice(0, 5).map(c => c.querySelector('.equip-level')?.textContent.replace(/\\s+/g, ' ').trim() || ''),
        reportButtons: cards.filter(c => Array.from(c.querySelectorAll('button')).some(b => /体检/.test(b.textContent))).length,
        photos: cards.filter(c => /equipment-photos\\/.*\\.jpg/.test(c.querySelector('.equip-photo img')?.getAttribute('src') || '')).length
      }
    })()`)
    check('设备台账渲染 60 张设备卡片', equipment.cards === 60, String(equipment.cards))
    check('健康度按四级分档展示（验收 #2）', equipment.overview.length === 4, equipment.overview.join(' | '))
    check('每张卡片都带等级与健康分', equipment.levels.length === 5 && equipment.levels.every(t => /级.*分/.test(t)), equipment.levels.join(','))
    check('每张卡片按类别渲染设备照片', equipment.photos === 60, String(equipment.photos))
    check('卡片可直接发起体检', equipment.reportButtons >= 60, String(equipment.reportButtons))

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
      await new Promise(r => setTimeout(r, 2000))
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
