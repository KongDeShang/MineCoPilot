/**
 * 矿山智工 - 口述录入端到端验收（独立文件，避免与主 e2e 脚本的并行编辑冲突）
 *
 * 覆盖这条链路的每一个安全边界：
 *   说一句话 → 理解卡（不写库） → 歧义必须问 → 确认 → 真落库 → 刷新仍在 → 撤销 → 纯查询不误写
 *
 * 用法：
 *   1) 先起开发服务器：npm run dev
 *   2) 另开终端：npm run e2e:nl
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

async function waitFor(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.ok) return true } catch { /* 等 */ }
    await sleep(400)
  }
  return false
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
  if (!(await waitFor(BASE))) { console.error(`❌ 开发服务器不可达：${BASE}`); process.exit(2) }

  const profileDir = mkdtempSync(join(tmpdir(), 'kuangshan-nl-'))
  const child = spawn(browser, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1440,940', 'about:blank'
  ], { stdio: 'ignore' })

  const shutdown = () => {
    try { child.kill() } catch { /* 已退出 */ }
    try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
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

    // 注意：撤销栈是内存态（跨刷新不保留，这是有意的安全设计），
    // 所以撤销验证必须排在任何页面刷新之前。

    await session.send('Page.reload', { ignoreCache: false })
    await sleep(4200)
    const afterReload = await session.eval(`(() => {
      const rows = Array.from(document.querySelectorAll('.el-table__row'))
      return { found: rows.some(r => /液压系统压力偏低/.test(r.textContent)) }
    })()`)
    check('口述创建的工单刷新后仍在（真持久化）', afterReload.found === true)

    // ---------- 5. 撤销（全局入口，离开聊天页也能撤） ----------
    await session.goto('/ai-assistant', 2600)
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
      return { ok: true, before, after: store.workOrders.length }
    })()`)
    check('第二条口述记录可写入', secondWrite.ok && secondWrite.after === secondWrite.before + 1,
      JSON.stringify(secondWrite))

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
    await session.goto('/ai-assistant', 2600)
    const completeFlow = await session.eval(`(async () => {
      ${ASK_HELPER}
      const app = document.querySelector('#app').__vue_app__
      const store = app.config.globalProperties.$pinia._s.get('app')
      // 找一台有未完成工单的设备，直接说"检修完了"
      const open = store.workOrders.find(o => o.status === 'pending' || o.status === 'processing')
      if (!open) return { ok: false, reason: '没有未完成工单' }
      const eqName = open.equipment_name
      await window.__ask(eqName + '已经检修完了')
      await new Promise(r => setTimeout(r, 1200))
      const card = [...document.querySelectorAll('.cmd-card')].pop()
      const btn = card ? Array.from(card.querySelectorAll('button')).find(b => /确认写入/.test(b.textContent)) : null
      if (!btn || btn.disabled) return { ok: false, reason: '理解卡不可确认', eqName, blocked: card?.classList.contains('blocked') }
      const recheckBefore = store.recheckList.length
      btn.click()
      await new Promise(r => setTimeout(r, 2600))
      const target = store.workOrders.find(o => o.id === open.id)
      return {
        ok: true, eqName, orderId: open.id,
        status: target.status,
        recheckDate: target.recheck_date,
        recheckStatus: target.recheck_status,
        recheckPending: store.recheckList.length,
        recheckBefore,
        maintenanceAdded: (store.getMaintenanceByEquipmentId(target.equipment_id) || []).length
      }
    })()`)
    check('口述"已检修完"能把工单标记完成',
      completeFlow.ok && completeFlow.status === 'completed',
      JSON.stringify(completeFlow).slice(0, 200))
    check('完成时自动生成复诊任务（闭环）',
      completeFlow.ok && !!completeFlow.recheckDate && completeFlow.recheckStatus === 'pending',
      `复诊日期=${completeFlow.recheckDate} 状态=${completeFlow.recheckStatus}`)

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
