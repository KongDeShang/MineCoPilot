/**
 * 矿山智工 - 高频故障 TOP 统计（Dashboard G-1）
 *
 * 把本地真实维修记录（工单 + 维保记录）按"系统"自动归类，
 * 输出高频故障排行。这是"数据沉淀 → 反哺"的直接证据：
 *   · 数据全部来自本地真实工单/维保记录，不是写死的
 *   · 每条计数都可点开原文（可审计）
 *   · 自动沉淀，随数据增长更新
 *
 * 分类规则（与 §G-1 一致）：
 *   1. 文本归一化（去标点、小写）
 *   2. 关键词按"长度优先、同长取位置靠前"匹配 —— 先匹配长词再匹配短词，
 *      避免「散热器」被拆成「散热」、「变速箱油温」被误判成液压系统
 *   3. 一条记录只归入一个系统，最多计 1 次
 */

export const FAULT_SYSTEMS = [
  {
    name: '液压系统',
    keywords: ['液压', '油压', '油温', '油管', '渗油', '漏油', '油缸', '油污', '主泵', '马达', '压力']
  },
  {
    name: '动力系统',
    keywords: ['发动机', '水温', '散热', '机油', '喷油', '皮带', '敲击', '排气管', '气门', '冷却']
  },
  {
    name: '电气系统',
    keywords: ['电瓶', '仪表', '线路', '空调', '压缩机', '传感器', '启动', '照明', '报警', '灯']
  },
  {
    name: '底盘行走',
    keywords: ['履带', '轮胎', '制动', '刹车', '变速箱', '支重轮', '行走', '转向', '张紧']
  }
]

export const OTHER_SYSTEM = '其他'

/** 归一化：去空白与常见标点，统一小写 */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s，。？！,.?!、；;：:"'（）()【】[\]]/g, '')
}

/**
 * 把一条故障文本归入某个系统
 * @param {string} text 工单标题+描述 / 维保记录描述
 * @returns {{ system: string, keyword: string|null }}
 */
export function classifyFaultText(text) {
  const t = normalize(text)
  if (!t) return { system: OTHER_SYSTEM, keyword: null }

  let best = null
  for (const sys of FAULT_SYSTEMS) {
    for (const kw of sys.keywords) {
      const idx = t.indexOf(kw)
      if (idx < 0) continue
      const len = kw.length
      if (!best || len > best.len || (len === best.len && idx < best.idx)) {
        best = { system: sys.name, keyword: kw, len, idx }
      }
    }
  }

  return best
    ? { system: best.system, keyword: best.keyword }
    : { system: OTHER_SYSTEM, keyword: null }
}

/**
 * 汇总高频故障 TOP
 * @param {object} input
 * @param {Array}  input.workOrders         工单数组（取 type='repair' 的 title+description）
 * @param {object} input.maintenanceRecords 按设备 id 分组的维保记录（取 type='故障维修' 的 description）
 * @returns {{ total: number, top: Array<{system, count, percent, samples}>, entries: Array }}
 */
export function buildFaultStats({ workOrders = [], maintenanceRecords = {} } = {}) {
  const entries = []

  for (const order of workOrders || []) {
    if (!order || order.type !== 'repair') continue
    const text = `${order.title || ''}${order.description || ''}`
    entries.push({
      text,
      title: order.title || order.description || '',
      source: '工单',
      id: order.id,
      equipmentName: order.equipment_name || '',
      date: order.created_at || ''
    })
  }

  for (const list of Object.values(maintenanceRecords || {})) {
    for (const record of list || []) {
      if (!record || record.type !== '故障维修') continue
      entries.push({
        text: record.description || '',
        title: record.description || '',
        source: '维保记录',
        id: record.id || '',
        equipmentName: '',
        date: record.date || ''
      })
    }
  }

  const classified = entries.map(entry => ({
    ...entry,
    ...classifyFaultText(entry.text)
  }))

  const map = {}
  for (const item of classified) {
    if (!map[item.system]) {
      map[item.system] = { system: item.system, count: 0, samples: [] }
    }
    map[item.system].count++
    map[item.system].samples.push({
      title: item.title,
      source: item.source,
      id: item.id,
      equipmentName: item.equipmentName,
      date: item.date
    })
  }

  const total = classified.length
  const top = Object.values(map)
    .map(stat => ({
      ...stat,
      percent: total ? Math.round((stat.count / total) * 1000) / 10 : 0
    }))
    .sort((a, b) => b.count - a.count)

  return { total, top, entries: classified }
}

/**
 * 已知样本分类断言（self-check 用）：10 条故意构造的、含关键词碰撞的样本
 * 准确率必须 100% —— 若这里失败，说明"先长词后短词"或关键词表被改坏
 */
export const FAULT_SAMPLES = [
  ['发动机水温偏高，散热器外部积尘严重', '动力系统'],
  ['主液压泵工作时发出异常噪音，压力波动', '液压系统'],
  ['冷车启动困难，怀疑电瓶电量不足', '电气系统'],
  ['履带下垂量超过标准值，行走时有跳齿现象', '底盘行走'],
  ['变速箱油温偏高，需检查油位与散热', '底盘行走'],
  ['机油压力低于正常范围，需检查油位与机油泵', '动力系统'],
  ['风扇皮带打滑，出现异响', '动力系统'],
  ['仪表盘间歇性报警提示，线路接触不良', '电气系统'],
  ['支重轮漏油，行走时有异响', '底盘行走'],
  ['动臂油缸油管接头处渗油，地面有油迹', '液压系统']
]

/** 批量断言：返回 { ok, failures: [{sample, expected, actual}] } */
export function verifyFaultSamples(samples = FAULT_SAMPLES) {
  const failures = []
  for (const [text, expected] of samples) {
    const { system } = classifyFaultText(text)
    if (system !== expected) failures.push({ text, expected, actual: system })
  }
  return { ok: failures.length === 0, failures }
}
