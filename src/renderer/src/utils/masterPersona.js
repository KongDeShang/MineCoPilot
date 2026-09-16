/**
 * 矿山智工 - AI 老师傅人设（任务 17 Batch B1）
 *
 * 把 AI 助手从"设备健康顾问"升级成"矿山老机修"语气，但只动语气、不动事实：
 *   · 所有数字仍由规则引擎实时计算（超期台数、健康分等），人设层绝不新增；
 *   · 所有规程仍来自知识库可溯源条目，人设层只做"经验式引导"的包装；
 *   · 开关默认关闭，用户在系统设置开启后生效（localStorage，随备份迁移）。
 *
 * 人设基调（矿山一线老机修的说话方式）：
 *   - 直接、动作导向："先查 X，再动 Y，最后再看 Z"；
 *   - 常带安全叮嘱（停机/挂牌/泄压）；
 *   - 不说大词，不编造经验年限与人名，不新增任何知识库之外的事实。
 */

export const MASTER_MODE_KEY = 'ks:master-mode'

/** 开关状态（默认关，用户主动开） */
export function masterEnabled() {
  try {
    return localStorage.getItem(MASTER_MODE_KEY) === '1'
  } catch {
    return false
  }
}

export function setMasterEnabled(on) {
  try {
    if (on) localStorage.setItem(MASTER_MODE_KEY, '1')
    else localStorage.removeItem(MASTER_MODE_KEY)
  } catch { /* 忽略 */ }
}

/** 本地模型叙述层的人设前缀（开关开启时拼到叙述 prompt 前） */
export const MASTER_NARRATE_PERSONA = [
  '现在你是一位在矿山干了多年的设备维修老师傅，说话直接、接地气，像给徒弟讲活儿一样。',
  '仍然只润色表达、逐条复述要点，禁止新增、删减或改写任何数字、型号、日期、状态、设备名称等事实。',
  '可以加"先查、再换、最后试"这类经验式引导，但具体做法只能来自原结论，不能自己编。'
].join('\n')

/**
 * 老师傅开场白（数字全部实时取自 store，与欢迎语同一口径）
 * @param {object} store appStore
 */
export function masterGreeting(store) {
  const stats = store.stats
  const overdue = store.overdueList
  const critical = store.criticalList
  const lines = [
    `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><strong style="font-size:16px">老师傅</strong><span style="color:var(--text-3);font-size:13px">· 设备维修老手</span></div>`,
    `<div style="margin:6px 0">我在这儿盯了 <strong>${stats.equipmentCount}</strong> 台设备。今天的情况：</div>`
  ]
  const alerts = []
  if (critical.length) alerts.push(`<span style="color:var(--danger-ink)"><strong>${critical.length}</strong> 台 D 级设备，得抓紧看，别拖成趴窝</span>`)
  if (overdue.length) alerts.push(`<span style="color:var(--warn-ink)"><strong>${overdue.length}</strong> 台维保超期了，先安排保养</span>`)
  lines.push(alerts.length
    ? `<div style="margin:8px 0;padding:10px 12px;background:var(--amber-soft);border:1px solid var(--amber-line);border-radius:8px;line-height:2">${alerts.join('<br>')}</div>`
    : `<div style="margin:8px 0;padding:10px 12px;background:var(--emerald-soft);border:1px solid var(--emerald-line);border-radius:8px;color:var(--success-ink)">设备都挺稳，没有紧急事。</div>`)
  lines.push(`<div style="margin-top:8px;color:var(--text-3);font-size:12px">有啥毛病直接说，报个现象我帮你捋思路。数字都是本地台账实时算的，不联网。</div>`)
  return lines.join('')
}

/**
 * 老师傅风格的行动提示（替换 buildTip，开关开启时用）
 * @param {string} question
 * @param {{source:string}} result answerQuestion 的结果
 * @param {object} store
 */
export function masterTip(question, result, store) {
  const q = String(question || '').toLowerCase()
  if (/超期|到期/.test(q) && store.overdueList.length > 0) {
    return `<div style="margin-top:10px;padding:8px 12px;background:var(--amber-soft);border:1px solid var(--amber-line);border-radius:6px;font-size:12px;color:var(--warn-ink)"><strong>老师傅提醒：</strong>超期的设备别等，先安排保养。维保日历里能一键建工单，建完当天就派活。</div>`
  }
  if (/健康|体检|怎么样/.test(q) && result.source === 'ledger') {
    const worst = store.criticalList[0]
    if (worst) {
      return `<div style="margin-top:10px;padding:8px 12px;background:var(--danger-soft);border:1px solid var(--danger-line);border-radius:6px;font-size:12px;color:var(--danger-ink)"><strong>老师傅提醒：</strong>${worst.name} 这台得盯紧。设备台账里能一键出体检报告，先看完整溯源再动手。</div>`
    }
  }
  if (/故障|异响|漏|振动|高温|无力/.test(q) && result.source === 'knowledge') {
    return `<div style="margin-top:10px;padding:8px 12px;background:var(--accent-soft);border-radius:6px;font-size:12px;color:var(--accent)"><strong>老师傅提醒：</strong>排查记住三步：先看现象、再查最可能的两个原因、最后动手。动液压/电气前先停机泄压挂牌，安全第一条。</div>`
  }
  return ''
}

/**
 * 追问候选（B4）：基于回答命中内容生成 2~3 个"可能还想问"的问题
 * @param {string} question
 * @param {object} result answerQuestion 的结果
 * @returns {string[]}
 */
export function masterFollowups(question, result) {
  const q = String(question || '')
  const followups = []
  if (result && result.source === 'knowledge') {
    const first = result.hits && result.hits[0]
    if (first && first.entry) {
      const e = first.entry
      if (e.keywords && e.keywords.length) {
        const kw = e.keywords[0]
        if (kw && !q.includes(kw)) followups.push(`${kw}多久检查一次？`)
      }
      if (e.steps && e.steps.length > 1) {
        const step = e.steps[1].replace(/[（(].*?[)）]/g, '').slice(0, 12)
        followups.push(`这一步${step}具体怎么操作？`)
      }
      if (e.causes && e.causes.length > 1) {
        followups.push(`怎么判断是${e.causes[1].replace(/[（(].*?[)）]/g, '').slice(0, 8)}引起的？`)
      }
    }
  }
  if (result && result.source === 'ledger') {
    if (/超期|到期/.test(q)) followups.push('哪些设备健康分最低？')
    if (/健康|体检|怎么样/.test(q)) followups.push('这台设备最近有什么工单记录？')
  }
  if (!followups.length) {
    followups.push('帮我看看还有哪些设备维保快到期了', '哪些设备最近有故障记录？')
  }
  return followups.slice(0, 3)
}
