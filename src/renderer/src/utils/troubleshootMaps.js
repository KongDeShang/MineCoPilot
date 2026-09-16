/**
 * 矿山智工 - 四类故障排查思路表（任务 17 Batch B3）
 *
 * 当提问命中某类系统（液压/动力/电气/行走）但知识库没有精确条目时，
 * 给一张"先看什么 → 再查什么 → 最后动什么"的分层排查思路，避免直接回"查不到"。
 *
 * 用户可维护：排查思路表存在 localStorage（ks:troubleshoot-maps），
 * 设置页可编辑某类系统的思路并保存；"恢复默认"清除用户版本。
 * 用户版本合并规则：同系统 ID 用户覆盖默认；新增系统直接追加。
 * 默认四类为矿山设备最高频故障系统，内容为通用排故经验（不编造参数数值）。
 */

export const TROUBLESHOOT_KEY = 'ks:troubleshoot-maps'

/** 默认四类排查思路表 */
export const DEFAULT_TROUBLESHOOT_MAPS = [
  {
    id: 'hydraulic',
    system: '液压系统',
    keywords: ['液压', '油压', '油缸', '泵', '阀', '马达', '无力', '憋车', '动作慢', '漏油'],
    checkOrder: [
      { step: '先看油位与油质', detail: '停机静置 10 分钟查油位、颜色、气味，缺油/发黑先补换' },
      { step: '再看滤芯与吸油管', detail: '滤芯堵、吸油管吸扁会导致吸空无力，拆下检查' },
      { step: '三测系统压力', detail: '接压力表测主泵输出，与随机手册额定值比对' },
      { step: '后查阀与泵内泄', detail: '溢流阀卡滞/标定漂移、泵配油盘磨损都造成掉压' }
    ],
    commonPitfall: '最容易误判：油位正常却忽视滤芯堵塞；压力类数值必须查手册，不猜',
    userNotes: []
  },
  {
    id: 'power',
    system: '动力系统',
    keywords: ['发动机', '水温', '过热', '高温', '开锅', '异响', '动力', '冒烟', '机油'],
    checkOrder: [
      { step: '先看水温与报警', detail: '高温立即降载停机，冷却后再开盖检查，禁止热态开盖' },
      { step: '再看散热与皮带', detail: '散热器积尘、风扇皮带打滑是矿区高温主因' },
      { step: '三查冷却液与节温器', detail: '液位/浓度、节温器卡死关闭会直接高温' },
      { step: '后查水泵与缸垫', detail: '仍高温再查水泵流量与缸垫是否窜气' }
    ],
    commonPitfall: '最容易误判：直接加水箱盖（危险）；先查散热再查机械',
    userNotes: []
  },
  {
    id: 'electric',
    system: '电气系统',
    keywords: ['电气', '电路', '电瓶', '传感器', '线束', '保险', '继电器', '控制器', '报警', '不启动'],
    checkOrder: [
      { step: '先看电源与搭铁', detail: '电瓶电压、桩头氧化、搭铁点松动是 80% 电气故障源头' },
      { step: '再看保险与继电器', detail: '逐个查保险是否熔断、继电器触点是否烧蚀' },
      { step: '三查线束与接插件', detail: '震动部位线束磨破、接插件进水锈蚀会导致偶发故障' },
      { step: '后查传感器与控制器', detail: '传感器信号异常、控制器故障灯代码定位' }
    ],
    commonPitfall: '最容易误判：直接换传感器/控制器，没先查电源和搭铁',
    userNotes: []
  },
  {
    id: 'running',
    system: '行走机构',
    keywords: ['轮胎', '履带', '行走', '跑偏', '磨损', '支重轮', '张紧', '脱轨', '制动', '刹车'],
    checkOrder: [
      { step: '先看轮胎/履带状态', detail: '胎压、偏磨规律、履带张紧度与下垂量' },
      { step: '再看轮系与制动', detail: '支重轮漏油、制动片磨损、制动液位' },
      { step: '三查结构与螺栓', detail: '轮辋变形、履带板螺栓松动、制动管路渗漏' },
      { step: '后查液压/电气关联', detail: '行走无力查马达内泄；跑偏查定位与悬挂' }
    ],
    commonPitfall: '最容易误判：只换轮胎/履带，没查气压与定位根因',
    userNotes: []
  }
]

/** 读取排查思路表（用户版本覆盖默认，新增系统追加） */
export function getTroubleshootMaps() {
  const maps = DEFAULT_TROUBLESHOOT_MAPS.map(m => ({
    ...m,
    keywords: [...(m.keywords || [])],
    checkOrder: (m.checkOrder || []).map(c => ({ ...c })),
    userNotes: [...(m.userNotes || [])]
  }))
  try {
    const raw = localStorage.getItem(TROUBLESHOOT_KEY)
    if (!raw) return maps
    const user = JSON.parse(raw)
    if (!Array.isArray(user)) return maps
    for (const um of user) {
      if (!um || !um.id) continue
      const idx = maps.findIndex(m => m.id === um.id)
      const patch = {
        id: um.id,
        system: um.system || (idx >= 0 ? maps[idx].system : '自定义'),
        keywords: Array.isArray(um.keywords) ? um.keywords : [],
        checkOrder: Array.isArray(um.checkOrder) ? um.checkOrder : [],
        commonPitfall: um.commonPitfall || '',
        userNotes: Array.isArray(um.userNotes) ? um.userNotes : []
      }
      if (idx >= 0) maps[idx] = patch
      else maps.push(patch)
    }
  } catch { /* 用户数据损坏则用默认 */ }
  return maps
}

/** 保存某个系统的排查思路（用户编辑版）；恢复默认传 null */
export function saveTroubleshootMap(id, patch) {
  try {
    const maps = getTroubleshootMaps()
    if (patch === null) {
      const next = maps.filter(m => m.id !== id)
      if (next.length) localStorage.setItem(TROUBLESHOOT_KEY, JSON.stringify(next))
      else localStorage.removeItem(TROUBLESHOOT_KEY)
      return { ok: true }
    }
    const idx = maps.findIndex(m => m.id === id)
    if (idx >= 0) maps[idx] = { ...maps[idx], ...patch, id }
    else maps.push({ ...patch, id })
    localStorage.setItem(TROUBLESHOOT_KEY, JSON.stringify(maps))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e && e.message || String(e) }
  }
}

/** 恢复默认排查思路表 */
export function resetTroubleshootMaps() {
  try {
    localStorage.removeItem(TROUBLESHOOT_KEY)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e && e.message || String(e) }
  }
}

/** 问题命中某类系统 → 返回排查思路表（未命中返回 null） */
export function matchTroubleshootMap(question) {
  const q = String(question || '').toLowerCase()
  const maps = getTroubleshootMaps()
  for (const m of maps) {
    if ((m.keywords || []).some(kw => kw && q.includes(kw))) return m
  }
  return null
}

/** 渲染排查思路表为 HTML（分层步骤 + 常见误判 + 用户备注） */
export function renderTroubleshootMap(map) {
  const order = (map.checkOrder || []).map((c, i) =>
    `<li><strong>${c.step}</strong>：${c.detail}</li>`
  ).join('')
  const notes = (map.userNotes || []).filter(Boolean).map(n => `<li>${n}</li>`).join('')
  return [
    `<strong>${map.system} · 排查思路</strong>`,
    `<div style="margin:6px 0 10px;color:var(--text-3);font-size:12px">分层排查：先看 → 再查 → 后动（现场经验表，可编辑）</div>`,
    `<ol style="margin:0;padding-left:20px">${order}</ol>`,
    map.commonPitfall
      ? `<div style="margin-top:10px;padding:6px 10px;background:var(--amber-soft);border-radius:6px;color:var(--warn-ink);font-size:12px">⚠ ${map.commonPitfall}</div>`
      : '',
    notes
      ? `<div style="margin-top:8px"><strong>现场备注：</strong></div><ul style="margin:4px 0 0;padding-left:20px">${notes}</ul>`
      : '',
    `<div style="margin-top:8px;color:var(--text-3);font-size:12px">※ 经验表帮助定方向，具体数值与步骤仍以随机手册和知识库条目为准。</div>`
  ].join('')
}
