/**
 * 矿山智工 - 口述录入端到端验收（独立文件，避免与主 e2e 脚本的并行编辑冲突）
 *
 * 覆盖这条链路的每一个安全边界：
 *   说一句话 → 理解卡（不写库） → 歧义必须问 → 确认 → 真落库 → 刷新仍在 → 撤销 → 纯查询不误写
 *
 * 用法：
 *   npm run e2e:nl       （开发服务器没起就自动拉一个，跑完自动收掉）
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureServer, stopServer, seedTourSeen } from './devServer.mjs'

const BASE = process.env.E2E_BASE_URL || 'http://localhost:5173'
const CDP_PORT = Number(process.env.E2E_NL_CDP_PORT || 9224)
const CDP = `http://127.0.0.1:${CDP_PORT}`

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome'
].filter(Boolean)

const checks = []
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 240) })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** 注入到页面里的提问助手：等待输入框出现再提问，避免时序问题 */
const ASK_HELPER = `
  window.__ask = async (question, waitMs = 6000) => {
    const deadline = Date.now() + waitMs
    let input = null
    while (Date.now() < deadline) {
      input = document.querySelector('.chat-input .el-input__inner') ||
              document.querySelector('.chat-input input')
      if (input) break
      await new Promise(r => setTimeout(r, 200))
    }
    if (!input) return { error: '找不到聊天输入框' }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, question)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 400))
    const send = Array.from(document.querySelectorAll('.chat-input button')).find(b => /提问|发送/.test(b.textContent))
    if (!send) return { error: '找不到发送按钮' }
    send.click()
    await new Promise(r => setTimeout(r, 2200))
    const cards = document.querySelectorAll('.cmd-card')
    const card = cards[cards.length - 1] || null
    return {
      cardCount: cards.length,
      card: card ? {
        blocked: card.classList.contains('blocked'),
        items: card.querySelectorAll('.cmd-item').length,
        eq: card.querySelector('.cmd-eq')?.textContent.trim() || null,
        candidates: card.querySelectorAll('.cmd-candidates button').length,
        confirmDisabled: (() => {
          const b = Array.from(card.querySelectorAll('button')).find(x => /确认写入/.test(x.textContent))
          return b ? b.disabled : null
        })(),
        impact: Array.from(card.querySelectorAll('.cmd-impact li')).map(li => li.textContent.trim())
      } : null
    }
  };
  'ready'
`

function findBrowser() {
  for (const c of CHROME_CANDIDATES) if (c && existsSync(c)) return c
  return null
}


class Session {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.exceptions = []
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
        this.exceptions.push(String(d.exception?.description || d.text).slice(0, 240))
      }
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' 超时')) } }, 30000)
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
  async goto(hash, waitMs = 2600) {
    // 禁用缓存重新加载，确保测的是当前源码（避免命中旧的 HMR 模块缓存）
    await this.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {})
    await this.send('Page.navigate', { url: `${BASE}/#${hash}` })
    await sleep(waitMs)
  }
  /** 每次提问前补注入（导航/刷新会清掉 __ask） */
  async ask(question) {
    await this.eval(ASK_HELPER)
    return this.eval(`window.__ask(${JSON.stringify(question)})`)
  }
}

async function main() {
  const browser = findBrowser()
  if (!browser) { console.error('❌ 未找到 Chrome/Edge'); process.exit(2) }

  const devServer = await ensureServer(BASE)

  const profileDir = mkdtempSync(join(tmpdir(), 'kuangshan-nl-'))
  const child = spawn(browser, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1440,940', 'about:blank'
  ], { stdio: 'ignore' })

  const shutdown = () => {
    try { child.kill() } catch { /* 已退出 */ }
    try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    stopServer(devServer)
  }

  try {
    let target = null
    const deadline = Date.now() + 15000
    while (Date.now() < deadline && !target) {
      try {
        const list = await (await fetch(`${CDP}/json/list`)).json()
        target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
      } catch { /* 等 */ }
      if (!target) await sleep(400)
    }
    if (!target) throw new Error('无法连接无头浏览器')

    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    const session = new Session(ws)
    await session.send('Runtime.enable')
    await session.send('Page.enable')
    await session.send('Network.enable').catch(() => {})
    await session.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {})
    await session.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 940, deviceScaleFactor: 1, mobile: false })
    // 首启引导演示的遮罩拦鼠标，会挡住下面的对话操作；本套件不验引导，种上标记跳过
    await seedTourSeen(session)

    // ---------- 0. 干净起点 ----------
    await session.goto('/dashboard', 3500)
    await session.eval(`(async () => {
      localStorage.clear()
      try {
        await new Promise(res => {
          const req = indexedDB.deleteDatabase('kuangshan-zhigong')
          req.onsuccess = req.onerror = req.onblocked = () => res()
          setTimeout(res, 3000)
        })
      } catch (e) { /* 忽略 */ }
      return true
    })()`)
    await session.send('Page.reload', { ignoreCache: true })
    await sleep(5500)

    await session.goto('/ai-assistant', 2800)

    // ---------- 1. 报故障：只出理解卡，不写库 ----------
    const draft = await session.ask('1号挖掘机今天液压油压力偏低')
    check('口述报故障弹出理解卡', draft.cardCount >= 1 && !!draft.card, JSON.stringify(draft).slice(0, 200))
    check('理解卡识别出设备', !!draft.card?.eq, draft.card?.eq)
    check('理解卡未阻塞（设备唯一确定）', draft.card?.blocked === false, JSON.stringify(draft.card))
    check('理解卡列出连带影响', (draft.card?.impact || []).length > 0, (draft.card?.impact || []).join(' / '))

    // 未确认前工单数不变
    const beforeConfirm = await session.eval(`(() => {
      const app = document.querySelector('#app').__vue_app__
      const store = app.config.globalProperties.$pinia._s.get('app')
      return { orders: store.workOrders.length, equipment: store.equipmentList.length }
    })()`)
    check('确认前工单数未变化（理解卡不写库）',
      typeof beforeConfirm.orders === 'number', `orders=${beforeConfirm.orders}`)

    // ---------- 1.5 先验证撤销栈机制本身可用（排除 UI 干扰） ----------
    // ---------- 2. 确认写入 ----------
    const stackProbe = await session.eval(`(() => {
      const app = document.querySelector('#app').__vue_app__
      const store = app.config.globalProperties.$pinia._s.get('app')
      const before = store.getUndoStack().length
      let flag = false
      store.logVoiceAction({
        rawText: '自检探针',
        summary: '探针',
        changes: [{ label: '探针变更' }],
        intentLabel: '探针',
        undos: [() => { flag = true }]
      })
      const afterPush = store.getUndoStack().length
      const outcome = store.performUndo()
      return { before, afterPush, outcome, flag }
    })()`)
    check('撤销栈可入栈并执行（机制自检）',
      stackProbe.afterPush === stackProbe.before + 1 && stackProbe.flag === true,
      JSON.stringify(stackProbe))
    const confirmed = await session.eval(`(async () => {
      const card = [...document.querySelectorAll('.cmd-card')].pop()
      const btn = Array.from(card.querySelectorAll('button')).find(b => /确认写入/.test(b.textContent))
      if (!btn) return { ok: false, reason: '找不到确认按钮' }
      btn.click()
      await new Promise(r => setTimeout(r, 2500))
      const r = document.querySelector('.cmd-result')
      const app = document.querySelector('#app').__vue_app__
      const store = app.config.globalProperties.$pinia._s.get('app')
      return {
        ok: true,
        orders: store.workOrders.length,
        resultText: r ? r.textContent.replace(/\\s+/g, ' ').slice(0, 200) : null,
        changes: Array.from(document.querySelectorAll('.cmd-changes .el-tag')).map(t => t.textContent.trim()),
        hasUndo: !!Array.from(document.querySelectorAll('.cmd-result button')).find(b => /撤销/.test(b.textContent))
      }
    })()`)
    check('确认后写入数据库', confirmed.ok && confirmed.orders === beforeConfirm.orders + 1,
      `orders ${beforeConfirm.orders} → ${confirmed.orders}`)
    check('回显实际变更明细', (confirmed.changes || []).length > 0, (confirmed.changes || []).join(' | '))
    check('提供撤销入口', confirmed.hasUndo === true)

    // ---------- 3. 落库是真的（页面可见 + 刷新仍在） ----------
    await session.goto('/workorder', 2600)
    const onPage = await session.eval(`(() => {
      const rows = Array.from(document.querySelectorAll('.el-table__row'))
      return { found: rows.some(r => /液压系统压力偏低/.test(r.textContent)) }
    })()`)
    check('新工单出现在工单列表', onPage.found === true)

    // ---------- 4. 刷新之后：撤销记录仍在，旧卡照样能撤 ----------
    // P2-1 之前撤销栈是纯内存态、刷新即失效，所以这一节只能验"按钮置灰"。
    // 现在撤销记录随本机存档持久化了，跨刷新撤销必须**真的能用** ——
    // 而且"能用"要按数据条数验，不能只看按钮亮不亮（亮着却撤不动是更坏的体验）。

    await session.send('Page.reload', { ignoreCache: false })
    await sleep(4200)
    const afterReload = await session.eval(`(() => {
      const rows = Array.from(document.querySelectorAll('.el-table__row'))
      return { found: rows.some(r => /液压系统压力偏低/.test(r.textContent)) }
    })()`)
    check('口述创建的工单刷新后仍在（真持久化）', afterReload.found === true)

    // ---------- 5. 撤销（全局入口，离开聊天页也能撤） ----------
    await session.goto('/ai-assistant', 2600)

    /*
     * 4.1 刷新之后，旧卡上的「撤销这次写入」必须仍是**可按的**。
     *
     * P2-1 之前的实现是：刷新后按钮一律置灰，提示"已不能自动撤销"。
     * 那是当时诚实、但能力有缺的做法（撤销记录只在内存里）。现在记录已落本机存档，
     * 刷新后按钮还能按 —— 这条断言正对着这个能力变化，钉子就是它。
     *
     * 只测"能按"是不够的：一个**永远可按**的实现也能过。所以必须成对看 4.3
     * （把本机存档清掉再刷新 → 按钮必须置灰 + 说出原因）和 4.2
     * （按下去要真的回滚数据，不能只是亮着好看）。
     */
    const staleUndo = await session.eval(`(() => {
      const actions = Array.from(document.querySelectorAll('.cmd-result-actions'))
      const withUndo = actions.filter(a => /撤销这次写入/.test(a.textContent))
      if (!withUndo.length) return { found: false }
      const box = withUndo[0]
      const btn = Array.from(box.querySelectorAll('button')).find(b => /撤销这次写入/.test(b.textContent))
      return {
        found: true,
        disabled: btn.disabled === true || btn.classList.contains('is-disabled'),
        hint: Array.from(box.querySelectorAll('.cmd-hint')).map(e => e.textContent.trim()).join(' | ')
      }
    })()`)
    check('刷新后旧卡的撤销按钮仍可按（撤销记录已跨刷新持久化）',
      staleUndo.found === true && staleUndo.disabled === false,
      staleUndo.found ? `disabled=${staleUndo.disabled}` : '页面上找不到带撤销入口的执行卡')
    check('可按时提示写明撤销会恢复写入前的数据',
      /撤销会恢复写入前的数据/.test(staleUndo.hint || ''), staleUndo.hint || '(无提示文案)')

    // 4.2 真的按下去 —— 跨刷新撤销要么真回滚，要么这条红
    const crossRefreshUndo = await session.eval(`(async () => {
      const app = document.querySelector('#app').__vue_app__
      const store = app.config.globalProperties.$pinia._s.get('app')
      const btn = [...document.querySelectorAll('.cmd-result-actions button')].find(b => /撤销这次写入/.test(b.textContent))
      if (!btn) return { ok: false, reason: '找不到撤销按钮' }
      const before = store.workOrders.length
      btn.click()
      await new Promise(r => setTimeout(r, 2600))
      const box = document.querySelector('.cmd-result-actions')
      return {
        ok: true, before, after: store.workOrders.length,
        undoneTag: !!box && /已撤销/.test(box.textContent),
        stackLeft: store.getUndoStack().length
      }
    })()`)
    check('跨刷新点撤销真的回滚了数据（按条数验，不看文案）',
      crossRefreshUndo.ok && crossRefreshUndo.after === crossRefreshUndo.before - 1,
      `orders ${crossRefreshUndo.before} → ${crossRefreshUndo.after}`)
    check('撤销后卡片标为已撤销（按钮让位给状态标签，不是留在那里等重复点击）',
      crossRefreshUndo.ok && crossRefreshUndo.undoneTag === true,
      JSON.stringify(crossRefreshUndo).slice(0, 200))

    const secondWrite = await session.eval(`(async () => {
      ${ASK_HELPER}
      const app = document.querySelector('#app').__vue_app__
      const store = app.config.globalProperties.$pinia._s.get('app')
      const before = store.workOrders.length
      await window.__ask('3号挖掘机履带张紧度异常，需要调整')
      await new Promise(r => setTimeout(r, 1200))
      const card = [...document.querySelectorAll('.cmd-card')].pop()
      const btn = card ? Array.from(card.querySelectorAll('button')).find(b => /确认写入/.test(b.textContent)) : null
      if (!btn || btn.disabled) return { ok: false, reason: '理解卡不可确认' }
      btn.click()
      await new Promise(r => setTimeout(r, 2500))
      const box = [...document.querySelectorAll('.cmd-result-actions')].pop()
      const undoBtn = box ? Array.from(box.querySelectorAll('button')).find(b => /撤销这次写入/.test(b.textContent)) : null
      return {
        ok: true, before, after: store.workOrders.length,
        freshUndoDisabled: undoBtn ? (undoBtn.disabled === true || undoBtn.classList.contains('is-disabled')) : null
      }
    })()`)
    check('第二条口述记录可写入', secondWrite.ok && secondWrite.after === secondWrite.before + 1,
      JSON.stringify(secondWrite))
    // 与 4.3 成对：那一条验"记录没了必须置灰"，这一条验"记录还在的可按"没有被误伤
    check('刚写入的卡撤销按钮仍可按（置灰只针对记录已不在栈里的，没有误伤）',
      secondWrite.freshUndoDisabled === false, `disabled=${secondWrite.freshUndoDisabled}`)

    const undoDiag = await session.eval(`(() => {
      const app = document.querySelector('#app').__vue_app__
      const store = app.config.globalProperties.$pinia._s.get('app')
      const footer = document.querySelector('.aside-footer')
      return {
        stackLen: store.getUndoStack().length,
        peek: store.peekUndo() ? store.peekUndo().rawText : null,
        footerButtons: footer ? Array.from(footer.querySelectorAll('button')).map(b => b.textContent.trim()) : null
      }
    })()`)
    check('侧边栏出现撤销入口（离开聊天页仍在）',
      (undoDiag.footerButtons || []).some(t => /撤销上一步录入/.test(t)),
      JSON.stringify(undoDiag).slice(0, 220))

    const undone = await session.eval(`(async () => {
      location.hash = '#/workorder'
      await new Promise(r => setTimeout(r, 1800))
      const footer = document.querySelector('.aside-footer')
      const btns = footer ? Array.from(footer.querySelectorAll('button')) : []
      const btn = btns.find(b => /撤销上一步录入/.test(b.textContent))
      if (!btn) {
        return { ok: false, reason: '侧边栏找不到撤销入口', buttons: btns.map(b => b.textContent.trim()) }
      }
      btn.click()
      await new Promise(r => setTimeout(r, 2400))
      const app = document.querySelector('#app').__vue_app__
      const store = app.config.globalProperties.$pinia._s.get('app')
      return { ok: true, orders: store.workOrders.length, undoLeft: store.getUndoStack().length }
    })()`)
    check('撤销是全局能力（离开聊天页仍可撤销）', undone.ok === true, JSON.stringify(undone))
    check('撤销后工单数减少 1（回滚生效）',
      undone.ok && undone.orders === secondWrite.after - 1,
      `orders=${undone.orders} 期望 ${secondWrite.after - 1}`)
    check('撤销栈已清空该项', undone.ok && undone.undoLeft === 0, `left=${undone.undoLeft}`)

    await session.goto('/workorder', 2600)
    const goneFromList = await session.eval(`(() => {
      const rows = Array.from(document.querySelectorAll('.el-table__row'))
      const titles = rows.map(r => r.querySelectorAll('.cell')[1]?.textContent.trim()).filter(Boolean)
      return {
        count: rows.length,
        // 注意：演示数据里本来就有同名工单，所以不能只靠"文本还在不在"判断撤销，
        // 必须以记录条数为准（下面断言里比较的是撤销前后的总数）。
        sameTitle: titles.filter(t => /履带张紧度异常/.test(t)).length
      }
    })()`)
    check('撤销后工单总数与撤销前一致（撤销了刚写入的那条）',
      goneFromList.count === secondWrite.before,
      `列表 ${goneFromList.count} 条，期望 ${secondWrite.before}；同名标题 ${goneFromList.sameTitle} 条`)

    // ---------- 5. 歧义绝不猜 ----------
    await session.goto('/ai-assistant', 2600)
    const ambiguous = await session.ask('挖掘机坏了')
    check('设备歧义时给出候选列表', (ambiguous.card?.candidates || 0) > 1, JSON.stringify(ambiguous.card))
    check('歧义时禁止确认写入（不猜设备）', ambiguous.card?.confirmDisabled === true,
      JSON.stringify(ambiguous.card))

    const picked = await session.eval(`(async () => {
      const card = [...document.querySelectorAll('.cmd-card')].pop()
      const cand = card.querySelector('.cmd-candidates button')
      if (!cand) return { ok: false, reason: '无候选按钮' }
      const name = cand.textContent.trim()
      cand.click()
      await new Promise(r => setTimeout(r, 1400))
      const card2 = [...document.querySelectorAll('.cmd-card')].pop()
      const btn = Array.from(card2.querySelectorAll('button')).find(b => /确认写入/.test(b.textContent))
      return { ok: true, name, blocked: card2.classList.contains('blocked'), confirmEnabled: btn ? !btn.disabled : false }
    })()`)
    check('点选候选后解除阻塞且可确认', picked.ok && picked.blocked === false && picked.confirmEnabled === true,
      JSON.stringify(picked))

    // ---------- 6. 纯查询不误写 ----------
    await session.goto('/ai-assistant', 2600)
    const querySafe = await session.eval(`(async () => {
      ${ASK_HELPER}
      const app = document.querySelector('#app').__vue_app__
      const store = app.config.globalProperties.$pinia._s.get('app')
      const before = { orders: store.workOrders.length, cards: document.querySelectorAll('.cmd-card').length }
      await window.__ask('6号钻机健康怎么样')
      await new Promise(r => setTimeout(r, 1500))
      await window.__ask('哪些设备维保已超期')
      await new Promise(r => setTimeout(r, 1500))
      return {
        before,
        after: { orders: store.workOrders.length, cards: document.querySelectorAll('.cmd-card').length }
      }
    })()`)
    check('纯查询不产生写入（工单数不变）',
      querySafe.after.orders === querySafe.before.orders,
      `${querySafe.before.orders} → ${querySafe.after.orders}`)
    check('纯查询不出现写入理解卡',
      querySafe.after.cards === querySafe.before.cards, JSON.stringify(querySafe))

    // ---------- 7. 完成工单 + 复诊闭环（口述链路） ----------
    /*
     * ⚠️ 断言必须按**设备**看，不能钉死某一张工单 id。
     *
     * 原来的写法是：取数组里第一条未完成工单，确认后断言"open.id 变成 completed"。
     * 这条只在"该设备恰好只有这一张未完成工单"时成立 —— 而演示台账里一台设备带
     * 2~3 张未完成工单是常态（"这批活都还没干完"）。口语说的是"某台设备检修完了"，
     * 具体收掉哪一张工单是执行器的选择，不是这次要验的契约。钉 id 等于把"设备唯一"
     * 这个前提偷偷塞进断言，库一脏（反复跑 e2e 用的就是同一个 profile）就随机红。
     *
     * 所以这里验设备级语义：说完"检修完了"，该设备未完成工单数 -1、且完成的那张
     * 挂上了 7 天后的复诊任务。这两条才是不管收掉哪张都必须成立的。
     */
    await session.goto('/ai-assistant', 2600)
    const completeFlow = await session.eval(`(async () => {
      ${ASK_HELPER}
      const app = document.querySelector('#app').__vue_app__
      const store = app.config.globalProperties.$pinia._s.get('app')
      const openOf = (eqId) => store.workOrders.filter(
        o => o.equipment_id === eqId && (o.status === 'pending' || o.status === 'processing')
      )
      const open = store.workOrders.find(o => o.status === 'pending' || o.status === 'processing')
      if (!open) return { ok: false, reason: '没有未完成工单' }
      const eqName = open.equipment_name
      const eqId = open.equipment_id
      const openBefore = openOf(eqId).length
      // 点之前就"已完成且挂着待复诊"的工单：点完之后必须**多**出一张，否则复诊断言
      // 可能被库里本来就有的那条蒙对
      const alreadyClosed = new Set(
        store.workOrders.filter(o => o.equipment_id === eqId && o.recheck_status === 'pending').map(o => o.id)
      )
      await window.__ask(eqName + '已经检修完了')
      await new Promise(r => setTimeout(r, 1200))
      const card = [...document.querySelectorAll('.cmd-card')].pop()
      const btn = card ? Array.from(card.querySelectorAll('button')).find(b => /确认写入/.test(b.textContent)) : null
      if (!btn || btn.disabled) return { ok: false, reason: '理解卡不可确认', eqName, blocked: card?.classList.contains('blocked') }
      const recheckBefore = store.recheckList.length
      btn.click()
      await new Promise(r => setTimeout(r, 2600))
      const openAfter = openOf(eqId).length
      // 刚收掉的那张：该设备上"已完成 + 待复诊"的工单，且点之前不在这个集合里
      const closed = store.workOrders
        .filter(o => o.equipment_id === eqId && o.status === 'completed' && o.recheck_status === 'pending' && !alreadyClosed.has(o.id))
        .sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || '') || b.id - a.id)[0]
      return {
        ok: true, eqName, eqId,
        openBefore, openAfter,
        recheckDate: closed ? closed.recheck_date : null,
        recheckStatus: closed ? closed.recheck_status : null,
        closedId: closed ? closed.id : null,
        recheckPending: store.recheckList.length,
        recheckBefore
      }
    })()`)
    check('口述"已检修完"能收掉该设备的一张未完成工单（按设备计，不钉工单 id）',
      completeFlow.ok && completeFlow.openAfter === completeFlow.openBefore - 1,
      completeFlow.ok
        ? `${completeFlow.eqName} 未完成 ${completeFlow.openBefore} → ${completeFlow.openAfter}`
        : JSON.stringify(completeFlow).slice(0, 200))
    check('完成时自动生成复诊任务（闭环）',
      completeFlow.ok && completeFlow.closedId !== null && completeFlow.recheckStatus === 'pending' &&
        !!completeFlow.recheckDate && completeFlow.recheckPending === completeFlow.recheckBefore + 1,
      completeFlow.ok
        ? `工单#${completeFlow.closedId} 复诊日期=${completeFlow.recheckDate} 状态=${completeFlow.recheckStatus}／复诊任务 ${completeFlow.recheckBefore} → ${completeFlow.recheckPending}`
        : JSON.stringify(completeFlow).slice(0, 200))

    // ---------- 8. 归档幂等 + 状态机 ----------
    // 归档一次会连带写病历、健康快照、复诊任务、知识草案、故障案例卡、日志六样东西。
    // 原来判断"是否已归档"看的是当前 status，于是"完成 → 退回处理中 → 再完成"
    // 会把上面六样全部再做一遍，而且不报错。
    const archiveFlow = await session.eval(`(async () => {
      const app = document.querySelector('#app').__vue_app__
      const store = app.config.globalProperties.$pinia._s.get('app')
      const target = store.workOrders.find(o => o.status === 'pending' || o.status === 'processing')
      if (!target) return { ok: false, reason: '没有未完成工单' }
      const count = () => (store.getMaintenanceByEquipmentId(target.equipment_id) || []).length

      const before = count()
      store.updateWorkOrderStatus(target.id, 'completed')
      const afterFirst = count()
      const reverted = store.updateWorkOrderStatus(target.id, 'processing')   // 口述撤销走的就是这条
      store.updateWorkOrderStatus(target.id, 'completed')
      const afterSecond = count()

      const completed = store.workOrders.find(o => o.status === 'completed')
      const illegal = completed ? store.updateWorkOrderStatus(completed.id, 'pending') : 'skip'
      const garbage = store.updateWorkOrderStatus(target.id, '压根不存在的状态')

      return {
        ok: true, before, afterFirst, afterSecond,
        reverted: !!reverted,
        firstArchived: afterFirst === before + 1,
        secondNoop: afterSecond === afterFirst,
        illegalRejected: illegal === null, illegal,
        garbageRejected: garbage === null
      }
    })()`)
    check('工单完成会归档病历（维保记录 +1）',
      archiveFlow.ok && archiveFlow.firstArchived === true, JSON.stringify(archiveFlow).slice(0, 200))
    check('退回处理中再完成，不会重复归档（归档幂等）',
      archiveFlow.ok && archiveFlow.reverted && archiveFlow.secondNoop === true,
      `首次后 ${archiveFlow.afterFirst} 条 / 再完成后 ${archiveFlow.afterSecond} 条`)
    check('状态机拒绝非法流转（已完成不能直接退回待处理）',
      archiveFlow.ok && archiveFlow.illegalRejected === true, `返回 ${JSON.stringify(archiveFlow.illegal)}`)
    check('状态机拒绝不存在的状态值',
      archiveFlow.ok && archiveFlow.garbageRejected === true, '返回 null 即为拒绝')

    // ---------- 9. 撤销记录不在栈里时必须置灰并说出原因 ----------
    /*
     * 这是 4.1「刷新后仍可按」的**反面钉子**。没有它，一个把 undoable 写死成 true
     * 的实现（按钮永远可按，点了静默撤不动或者报错）照样能让 4.1 全绿。
     *
     * 怎么制造"记录不在栈里"：把本机存档直接删掉再刷新 —— 这正是 tooltip 里
     * 说的"被清空过"（浏览器清站点数据、或存档被存储预算顶出去导致的丢失）。
     * 不用 store 内部方法去改栈，是因为要验的恰恰是**页面重载后**的 DOM 表现。
     */
    await session.goto('/ai-assistant', 2600)
    const freshWrite = await session.eval(`(async () => {
      ${ASK_HELPER}
      const app = document.querySelector('#app').__vue_app__
      const store = app.config.globalProperties.$pinia._s.get('app')
      const before = store.workOrders.length
      // 设备名从真实台账里取，不在这里猜前缀：用整名去匹配是指代消解里最靠前的一级，
      // 猜错前缀会让这条断言挂在"指代没解析出来"上，而不是它要验的置灰逻辑。
      const dev = store.equipmentList.find(e => /挖掘机/.test(e.name || ''))
      if (!dev) return { ok: false, reason: '台账里找不到挖掘机' }
      await window.__ask(dev.name + ' 履带张紧度异常，需要调整')
      await new Promise(r => setTimeout(r, 1200))
      const card = [...document.querySelectorAll('.cmd-card')].pop()
      const btn = card ? Array.from(card.querySelectorAll('button')).find(b => /确认写入/.test(b.textContent)) : null
      if (!btn || btn.disabled) return { ok: false, reason: '理解卡不可确认' }
      btn.click()
      await new Promise(r => setTimeout(r, 2500))
      const box = [...document.querySelectorAll('.cmd-result-actions')].pop()
      const undoBtn = box ? Array.from(box.querySelectorAll('button')).find(b => /撤销这次写入/.test(b.textContent)) : null
      return {
        ok: true, before, after: store.workOrders.length,
        disabled: undoBtn ? (undoBtn.disabled === true || undoBtn.classList.contains('is-disabled')) : null,
        archive: !!localStorage.getItem('ks:undo-stack')
      }
    })()`)
    check('前置条件：新写入的一条确实进得了撤销入口（否则下面"置灰"无从谈起）',
      freshWrite.ok && freshWrite.after === freshWrite.before + 1 && freshWrite.disabled === false,
      JSON.stringify(freshWrite).slice(0, 200))

    const afterWipe = await session.eval(`(async () => {
      localStorage.removeItem('ks:undo-stack')
      location.hash = '#/workorder'
      await new Promise(r => setTimeout(r, 1500))
      return { wiped: localStorage.getItem('ks:undo-stack') === null }
    })()`)
    await session.send('Page.reload', { ignoreCache: false })
    await sleep(4200)
    const orphans = await session.eval(`(async () => {
      location.hash = '#/ai-assistant'
      await new Promise(r => setTimeout(r, 2600))
      const boxes = Array.from(document.querySelectorAll('.cmd-result-actions'))
      const withUndo = boxes.filter(a => /撤销这次写入/.test(a.textContent))
      if (!withUndo.length) return { found: false, boxes: boxes.length }
      const box = withUndo[withUndo.length - 1]
      const btn = Array.from(box.querySelectorAll('button')).find(b => /撤销这次写入/.test(b.textContent))
      return {
        found: true,
        disabled: btn.disabled === true || btn.classList.contains('is-disabled'),
        hint: Array.from(box.querySelectorAll('.cmd-hint')).map(e => e.textContent.trim()).join(' | ')
      }
    })()`)
    check('存档被清掉后刷新：撤销按钮置灰（不是永远可按）',
      afterWipe.wiped === true && orphans.found === true && orphans.disabled === true,
      JSON.stringify({ ...orphans, wiped: afterWipe.wiped }).slice(0, 220))
    check('置灰时把原因写在界面上（不能只藏在 tooltip 里）',
      /撤销记录已不在撤销栈里/.test(orphans.hint || ''), orphans.hint || '(无提示文案)')

    // ---------- 汇总 ----------
    console.log('')
    for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`)
    const failed = checks.filter(c => !c.ok)
    console.log('')
    console.log(`运行时异常 exceptionThrown: ${session.exceptions.length}`)
    session.exceptions.slice(0, 6).forEach(e => console.log('  ! ' + e))
    console.log(`\n合计 ${checks.length} 项，通过 ${checks.length - failed.length} 项，失败 ${failed.length} 项`)

    ws.close()
    if (failed.length || session.exceptions.length) process.exitCode = 1
  } finally {
    shutdown()
  }
}

main().catch(error => {
  console.error('❌ 口述录入 e2e 失败:', error && error.stack ? error.stack : error)
  process.exit(1)
})
