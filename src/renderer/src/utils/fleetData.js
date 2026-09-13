/**
 * 矿山智工 - 演示数据工厂
 *
 * 为什么需要工厂而不是硬编码数组：
 *   1) 规模：8 台设备撑不起"高频故障 TOP / 占比 / 健康趋势 / 闭环率"这类统计视图
 *   2) 稳定：所有日期按"相对今天"生成，任何一天演示"超期 N 天"都成立
 *   3) 可信：型号取自 equipmentCatalog 白名单，品类与吨位都与真实矿用车队自洽
 *   4) 可复现：固定种子的伪随机 → 同一份代码每次都生成同一套数据，路演可反复演练
 *
 * 数据不是"随机噪声"，而是围绕演示目标构造的分布：
 *   · 超期 8~15 台，其中至少 1 台超期 ≥ 45 天（画面上最红的那台）
 *   · 健康分覆盖 A/B/C/D 四档且都有可观数量（否则报告千篇一律）
 *   · 至少 5 台"健康分连续下降"（"恶化中"预警才有实锤）
 *   · 四类故障系统各有 ≥ 8 次命中（TOP 图才有形状）
 */
import {
  MODEL_WHITELIST, FLEET_MIX, MINE_LOCATIONS, FAULT_LIBRARY, FAULT_PARTS,
  MAINTENANCE_LIBRARY, LABOR_FEE, TECHNICIANS, brandOfModel, partsCost
} from './equipmentCatalog'
import { daysAgoDate, daysAgoDateTime, addDays, formatDate, dueDate, daysUntilDue } from './dates'
import { evaluateHealth, evaluateTrend } from './health'

export const DEFAULT_FLEET_SIZE = 60
export const DEFAULT_SEED = 20260912

/**
 * 每个稀有型号（他牌设备、80t 矿用挖机）的投放台数
 *
 * 导出是为了让自检断言引用同一个常量，而不是在断言里再写一个 2。
 */
export const RARE_PER_MODEL = 2

/** 确定性伪随机（mulberry32）：同一 seed 必然产出同一套数据 */
export function createRandom(seed = DEFAULT_SEED) {
  let state = seed >>> 0
  return function random() {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick(random, list) {
  return list[Math.floor(random() * list.length)]
}

/**
 * 故障系统加权抽取：工程机械行业共识是液压系统故障占比最高，
 * 演示数据应让"高频故障 TOP：液压系统居首"这句路演话术与数据自洽。
 * 权重同时影响工单与维保记录，保证两者统计一致。
 */
const FAULT_SYSTEM_WEIGHTS = { 液压系统: 1.7, 动力系统: 1.3, 底盘行走: 1.2, 电气系统: 1.0, 其他: 0.5 }

function pickFaultSystem(random) {
  const systems = Object.keys(FAULT_LIBRARY)
  const total = systems.reduce((sum, s) => sum + (FAULT_SYSTEM_WEIGHTS[s] ?? 1), 0)
  let r = random() * total
  for (const system of systems) {
    r -= FAULT_SYSTEM_WEIGHTS[system] ?? 1
    if (r <= 0) return system
  }
  return systems[systems.length - 1]
}

function intBetween(random, min, max) {
  return min + Math.floor(random() * (max - min + 1))
}

/** 按权重展开车队类别序列（保证总数精确等于 size） */
function buildCategoryPlan(size) {
  const totalWeight = FLEET_MIX.reduce((sum, item) => sum + item.weight, 0)
  const plan = []
  for (const item of FLEET_MIX) {
    const count = Math.round((item.weight / totalWeight) * size)
    for (let i = 0; i < count; i++) plan.push(item)
  }
  // 四舍五入会带来 ±1 的误差，按权重补齐/裁剪
  let cursor = 0
  while (plan.length < size) {
    plan.push(FLEET_MIX[cursor % FLEET_MIX.length])
    cursor++
  }
  return plan.slice(0, size)
}

/**
 * 维保节奏档案：决定这台设备的"上次维保"距今天数，
 * 也就决定了它的健康分与是否需要告警。
 *
 * 口径与 health.js 完全对齐（这是关键，写错就会出现"档案说超期、评分说正常"）：
 *   healthy     周期 20%~75%  → 不扣维保分，健康
 *   approaching 周期 80%~98%  → 扣 10 分（逼近周期）
 *   overdueLow  超期 2~20 天
 *   overdueHigh 超期 30~52 天 → 红色预警的那一批
 *   worsening   超期 25~55 天，且健康分快照呈连续下降
 *
 * 目标分布（60 台时）：超期 9~12 台、其中至少 2 台超期 ≥ 45 天、至少 4 台"恶化中"
 * ⚠️ 注意：权重是"档案人数占比"，而 assignProfiles 会对每个档案取整，
 *    历史上曾因把超期权重给到 34% 导致 60 台里 24 台超期（画面过红），调整时请以审计脚本实测为准。
 */
const SERVICE_PROFILES = [
  { name: 'healthy', weight: 54, mode: 'ratio', min: 0.20, max: 0.75 },
  { name: 'approaching', weight: 18, mode: 'ratio', min: 0.82, max: 0.98 },
  { name: 'overdueLow', weight: 15, mode: 'days', min: 2, max: 16 },
  { name: 'overdueHigh', weight: 8, mode: 'days', min: 30, max: 40 },
  { name: 'worsening', weight: 5, mode: 'days', min: 45, max: 55 }
]

function assignProfiles(random, count) {
  const profiles = []
  const totalWeight = SERVICE_PROFILES.reduce((sum, p) => sum + p.weight, 0)
  for (const profile of SERVICE_PROFILES) {
    const n = Math.round((profile.weight / totalWeight) * count)
    for (let i = 0; i < n; i++) profiles.push(profile)
  }
  let cursor = profiles.length
  while (profiles.length < count) {
    profiles.push(SERVICE_PROFILES[cursor % SERVICE_PROFILES.length])
    cursor++
  }
  // 打散，避免同类设备扎堆出现
  for (let i = profiles.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[profiles[i], profiles[j]] = [profiles[j], profiles[i]]
  }
  return profiles.slice(0, count)
}

/** 由档案与周期推出"上次维保"距今天数（口径必须与档案声明一致） */
function lastServiceOffset(random, profile, cycle) {
  if (profile.mode === 'days') {
    // 档案按"超期天数"声明：距今 = 周期 + 超期
    return cycle + intBetween(random, profile.min, profile.max)
  }
  // 档案按"周期倍率"声明
  const ratio = profile.min + random() * (profile.max - profile.min)
  return Math.max(1, Math.round(cycle * ratio))
}

/** 生成设备台账 */
export function generateFleet({ size = DEFAULT_FLEET_SIZE, seed = DEFAULT_SEED } = {}) {
  const random = createRandom(seed)
  const plan = buildCategoryPlan(size)
  const profiles = assignProfiles(random, size)

  // 打散类别顺序后再分配档案：否则档案会与"类别/周期"系统性相关，
  // 导致超期设备全部集中在某几类设备上（历史上就出现过超期率 35% 的偏差）
  const order = plan.map((slot, index) => index)
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }

  /**
   * 稀有/他牌型号的投放台数是**定数**，不靠概率。
   *
   * 原来是 `random() < 0.14` 的概率投放，于是"卡特 320D 有两台"这件事
   * 换个种子就没了——而"同型号多台时必须判歧义"的用例正需要这个场景。
   * 演示数据要呈现的**场景**（在管设备不挑品牌、同型号多台）属于产品要求，
   * 不能交给运气：每个稀有型号固定投 RARE_PER_MODEL 台，
   * 具体落在哪几台由打散后的顺序自然决定。
   */
  const rareQuota = {}
  // plan 是"每台设备一个槽位"，同一类别会有多个槽位指向同一个 FLEET_MIX 条目，
  // 所以先按类别去重，否则配额会被槽位数放大（每个槽位都配一份）
  for (const slot of new Set(plan)) {
    for (const model of slot.rareModels || []) {
      if (!rareQuota[slot.category]) rareQuota[slot.category] = []
      for (let i = 0; i < RARE_PER_MODEL; i++) rareQuota[slot.category].push(model)
    }
  }

  // 少量"两班倒/特殊工况"设备，让说明更真实
  const equipment = []
  const usedNames = new Set()
  /**
   * 按【类别】各自编号，而不是全局编号。
   *
   * 为什么必须这样：现场师傅说的是"1号挖掘机""3号装载机"，编号在各自类别里唯一。
   * 若按全局编号，挖掘机里会同时出现 -01 / -02 / -03 三台"1号"（分属不同品牌），
   * 口述"1号挖掘机"就变成必然歧义 —— 这不是解析器的问题，而是数据不符合口语模型。
   */
  const categorySeq = {}

  order.forEach((slotIndex, index) => {
    const slot = plan[slotIndex]
    const cycle = slot.cycle
    const profile = profiles[index]

    // 型号：先兑现稀有型号配额（他牌设备 / 80t 矿用挖机），配额用尽后走主型号池
    const pendingRare = rareQuota[slot.category]
    const model = pendingRare && pendingRare.length ? pendingRare.pop() : pick(random, slot.models)

    const location = pick(random, MINE_LOCATIONS)

    /**
     * 编号按【设备类别】全局连号（挖掘机 01..N、矿卡 01..M），与现场口语一致。
     * 注意：类别必须取型号白名单里的真实类别（矿物类别），而不是车队槽位名称，
     * 否则同一类别会分裂成多个编号序列，"1号挖掘机"又会变成歧义。
     */
    const category = (MODEL_WHITELIST[model] || {}).category || slot.category
    categorySeq[category] = (categorySeq[category] || 0) + 1
    const seq = categorySeq[category]
    const finalName = `${model} ${category}-${String(seq).padStart(2, '0')}`
    usedNames.add(finalName)

    // 机龄：1~12 年，偏向 2~7 年（真实车队不可能全是新车或全是老车）
    const ageYears = Math.min(12, Math.max(1, 2 + Math.round(random() * 5 + random() * 5)))
    const purchaseDate = daysAgoDate(Math.round(ageYears * 365 + random() * 120))

    const sinceOffset = lastServiceOffset(random, profile, cycle)

    equipment.push({
      id: index + 1,
      name: finalName,
      model,
      brand: brandOfModel(model),
      category: slot.category,
      location,
      purchase_date: purchaseDate,
      status: 'running',
      maintenance_cycle_days: cycle,
      last_maintenance_date: daysAgoDate(sinceOffset),
      notes: '',
      // 以下为生成期辅助字段，落库前会被剔除
      __profile: profile.name,
      __sinceOffset: sinceOffset,
      __locationHint: slot.locationHint
    })
  })

  return equipment
}

/** 依据健康分与档案决定设备状态 */
function decideStatus(random, eq) {
  const health = evaluateHealth(eq)
  if (health.overdueDays !== null && health.overdueDays > 45 && random() < 0.55) return 'fault'
  if (eq.__profile === 'worsening' && random() < 0.3) return 'fault'
  if (health.level === 'D' && random() < 0.35) return 'maintenance'
  if (health.level === 'C' && random() < 0.15) return 'maintenance'
  if (random() < 0.05) return 'idle'
  return 'running'
}

/**
 * 生成维保记录（含故障维修与定期保养）
 * 故障维修条数按健康等级分配：越不健康，近半年故障越多 —— 这样"故障频率"才与分数自洽
 */
function generateMaintenanceFor(random, eq) {
  const records = []
  const health = evaluateHealth(eq)
  const faultCount = health.level === 'D' ? intBetween(random, 4, 6)
    : health.level === 'C' ? intBetween(random, 2, 4)
      : health.level === 'B' ? intBetween(random, 1, 2)
        : intBetween(random, 0, 1)

  // 故障维修记录：从最近往前排
  for (let i = 0; i < faultCount; i++) {
    const system = pickFaultSystem(random)
    const item = pick(random, FAULT_LIBRARY[system].items)
    const offset = eq.__sinceOffset + i * intBetween(random, 25, 70) + intBetween(random, 3, 20)
    /**
     * 换件必须跟故障对得上。
     *
     * 原来这里是两次独立的 `pick(random, PARTS_CATALOG)`——一次取件名、一次取价格。
     * 两个后果：
     *   1) 件名与系统毫无关系："回转马达渗油"的记录里换的是"空气滤芯"；
     *   2) 件名与金额各随机各的："更换刹车片"这条记录的费用可能是斗齿的 1200 元。
     * 现在按条目取件（不换件的如实留空），费用 = 工时费 + 件名单价合计，
     * 件名与金额同源，点开明细能对上。
     */
    const partNames = FAULT_PARTS[item.title] || []
    records.push({
      date: daysAgoDate(offset),
      type: '故障维修',
      description: item.desc,
      technician: pick(random, TECHNICIANS),
      parts_used: partNames.join('、'),
      cost: (LABOR_FEE[system] || 0) + partsCost(partNames).cost,
      system
    })
  }

  // 定期保养记录：按周期回推
  // parts_used 落标准件名（可对账、可扣库存），display_parts 保留原描述供展示；
  // cost 由件名单价合计得出——此前恒为 0，导致"记录在册维保费用"只算了故障维修。
  const serviceCount = intBetween(random, 2, 4)
  for (let i = 0; i < serviceCount; i++) {
    const item = pick(random, MAINTENANCE_LIBRARY.filter(m => m.type === '定期保养'))
    const offset = eq.__sinceOffset + i * eq.maintenance_cycle_days
    records.push({
      date: daysAgoDate(offset),
      type: '定期保养',
      // level 是保养分级（50h/250h/1000h…），写进描述里，病历上才看得出这是哪一级保养
      description: item.level ? `${item.level} ${item.desc}` : item.desc,
      technician: pick(random, TECHNICIANS),
      parts_used: item.partNames.join('、'),
      display_parts: item.parts,
      cost: partsCost(item.partNames).cost,
      system: null
    })
  }

  // 部件更换：大件更换是成本大头，单独成记录（此前项目库里这部分从未被使用）
  //
  // ⚠️ 用独立的随机流：主随机流的每一次取数都会平移其后所有设备的数据，
  // 直接在主流程里加记录会改变整套演示数据（工单数、闭环率、分布全部漂移）。
  // 独立 seed 让新增记录不影响任何既有数值。
  const extra = createRandom(eq.id * 7919 + 13)
  if (extra() < 0.5) {
    const item = pick(extra, MAINTENANCE_LIBRARY.filter(m => m.type === '部件更换'))
    records.push({
      date: daysAgoDate(eq.__sinceOffset + intBetween(extra, 10, 60)),
      type: '部件更换',
      description: item.desc,
      technician: pick(extra, TECHNICIANS),
      parts_used: item.partNames.join('、'),
      display_parts: item.parts,
      cost: partsCost(item.partNames).cost,
      system: null
    })
  }

  // 穿插一次巡检
  if (random() < 0.6) {
    const item = pick(random, MAINTENANCE_LIBRARY.filter(m => m.type === '巡检'))
    records.push({
      date: daysAgoDate(eq.__sinceOffset + intBetween(random, 5, 25)),
      type: '巡检',
      description: item.desc,
      technician: pick(random, TECHNICIANS),
      parts_used: '',
      cost: 0,
      system: null
    })
  }

  return records.sort((a, b) => String(b.date).localeCompare(String(a.date)))
}

/**
 * 生成健康分快照序列（趋势的来源）
 * 最后一期严格等于当前评分（保证"趋势末端"与"体检报告"完全一致，不自相矛盾）
 */
function generateSnapshotsFor(random, eq) {
  const health = evaluateHealth(eq)
  const count = intBetween(random, 4, 6)
  const dates = []
  for (let i = 0; i < count; i++) {
    // 每期间隔约一个维保周期的 40%
    dates.push(daysAgoDate(Math.round((count - 1 - i) * eq.maintenance_cycle_days * 0.4)))
  }

  const scores = []
  if (eq.__profile === 'worsening') {
    // 构造连续下降：从当前分往上抬，形成"一路走低"的曲线（间隔不宜过大，否则低分设备会被顶到 0）
    const bumps = [12, 10, 8, 6, 5, 4]
    for (let i = 0; i < count; i++) {
      scores.push(Math.min(100, health.score + (bumps[i] || 4)))
    }
  } else if (health.level === 'A' || health.level === 'B') {
    for (let i = 0; i < count; i++) {
      const jitter = intBetween(random, -3, 3)
      scores.push(Math.max(0, Math.min(100, health.score + (i === count - 1 ? 0 : jitter))))
    }
  } else {
    // 中低分设备：近期略有波动，总体平稳
    for (let i = 0; i < count; i++) {
      const jitter = intBetween(random, -5, 4)
      scores.push(Math.max(0, Math.min(100, health.score + (i === count - 1 ? 0 : jitter))))
    }
  }
  scores[count - 1] = health.score

  return dates.map((date, i) => ({
    equipment_id: eq.id,
    date,
    score: scores[i],
    level: scoreToLevel(scores[i]),
    factors_json: null
  }))
}

function scoreToLevel(score) {
  if (score >= 85) return 'A'
  if (score >= 70) return 'B'
  if (score >= 55) return 'C'
  return 'D'
}

/** 生成工单（含复诊字段） */
function generateWorkOrders(random, equipment) {
  const orders = []
  let nextId = 1001
  const total = Math.round(equipment.length * 1.15) // 60 台 → 约 69 张工单

  for (let i = 0; i < total; i++) {
    const eq = pick(random, equipment)

    /**
     * 先定类型，再按类型取内容。
     *
     * 原来是反过来的：先随机抓一条故障项，再随机定 type ——
     * 于是会出现「巡检工单，标题写着液压油压力偏低」这种自相矛盾的记录，
     * 维修班组的活和巡检班组的活混成一张单子。
     */
    const typeRoll = random()
    const type = typeRoll < 0.55 ? 'repair' : (typeRoll < 0.78 ? 'maintenance' : 'inspection')

    let system = null
    let item
    if (type === 'repair') {
      system = pickFaultSystem(random)
      item = pick(random, FAULT_LIBRARY[system].items)
    } else {
      const pool = MAINTENANCE_LIBRARY.filter(m =>
        type === 'maintenance' ? m.type !== '巡检' : m.type === '巡检')
      item = pick(random, pool)
    }

    /**
     * 时间跨度铺开到约半年。
     *
     * 原来所有工单都挤在最近 24 天内：看板"近 30 天"看着热闹，
     * 但月报/季报、维保趋势一拉就露底——历史是空的。
     * 用平方偏置把样本压向近期：既留出纵深，又保证近几天有活跃单
     * （否则"今日待办"看着像停摆）。
     */
    const spanRoll = random()
    const daysAgo = Math.round(spanRoll * spanRoll * 165)

    // 状态分布按工单流转顺序铺开：待派单（刚建单）→ 已派单（派了班组）→ 处理中 → 已完成。
    // 五种状态都必须真实存在，否则对应筛选页在演示里永远是空的。
    let status
    if (daysAgo <= 2) status = random() < 0.6 ? 'pending' : 'assigned'
    else if (daysAgo <= 7) {
      const r = random()
      status = r < 0.18 ? 'assigned' : (r < 0.58 ? 'processing' : 'completed')
    } else {
      // 已取消：字典里有这一档、工单页也有这个筛选按钮，但演示数据从来不发它，
      // 点进去永远空。少量、且只出现在有年头的单子上——刚建 3 天的单子
      // 就被取消，现场不常见。
      const r = random()
      if (daysAgo > 20 && r < 0.07) status = 'cancelled'
      else if (r < 0.62) status = 'completed'
      else if (r < 0.88) status = 'processing'
      else status = 'assigned'
    }

    const priority = system === '动力系统' && random() < 0.3 ? 'urgent'
      : random() < 0.35 ? 'high'
        : random() < 0.8 ? 'normal' : 'low'

    const source = pick(random, ['manual', 'manual', 'voice', 'ocr', 'excel'])
    const createdAt = daysAgoDateTime(daysAgo)
    const completedAt = status === 'completed' ? daysAgoDateTime(Math.max(0, daysAgo - intBetween(random, 0, 2))) : null

    const order = {
      id: nextId++,
      equipment_id: eq.id,
      equipment_name: eq.name,
      title: item.title,
      description: item.desc,
      type,
      priority,
      status,
      source,
      /**
       * 待派单 = 还没派给班组，就不该有负责人。
       *
       * 原来无差别随机塞一个技师，于是"待派单"的工单在列表里明晃晃挂着负责人，
       * 逻辑上说不通，也让人以为系统在替人做决定。空串表示尚未指派，
       * 界面按"—"展示；dispatchWorkOrder 派单时才会写上人。
       */
      assigned_to: status === 'pending' || status === 'cancelled' ? '' : pick(random, TECHNICIANS),
      created_at: createdAt,
      completed_at: completedAt,
      updated_at: completedAt || createdAt,
      recheck_date: null,
      recheck_status: 'not_needed',
      // 归档标记：演示数据里已完成的工单，其病历/快照/案例卡早就生成了，
      // 属于"已归档"。留空会让它们被当成没归档过——删除入口会照常出现，
      // 而删掉一张已完成的工单，它留下的病历就成了指向空单号的孤儿。
      archived_at: status === 'completed' ? completedAt : null,
      __system: system
    }

    // 已完成的维修类工单：约 65% 已复诊，其余待复诊 —— 让"复诊闭环率"是个真实数字而不是 0 或 100%
    if (status === 'completed' && type === 'repair') {
      order.recheck_date = addDays(completedAt, 7)
      order.recheck_status = random() < 0.65 ? 'done' : 'pending'
    } else if (status === 'completed' && type === 'maintenance') {
      order.recheck_date = addDays(completedAt, 30)
      order.recheck_status = random() < 0.5 ? 'done' : 'pending'
    }

    orders.push(order)
  }

  return orders.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
}

/**
 * 总入口：生成一整套演示数据
 * @returns {{ equipment, maintenanceRecords, workOrders, healthSnapshots, catalog }}
 */
export function buildDemoDataset({ size = DEFAULT_FLEET_SIZE, seed = DEFAULT_SEED } = {}) {
  const random = createRandom(seed + 7)
  const rawFleet = generateFleet({ size, seed })

  // 先定状态（状态影响健康分），再据此生成维保记录与快照，保证三者自洽
  const equipment = rawFleet.map(eq => ({ ...eq, status: decideStatus(random, eq) }))

  const maintenanceRecords = {}
  const healthSnapshots = []

  for (const eq of equipment) {
    const records = generateMaintenanceFor(random, eq)
    maintenanceRecords[String(eq.id)] = records.map(r => ({ ...r }))
    healthSnapshots.push(...generateSnapshotsFor(random, eq))
  }

  const workOrders = generateWorkOrders(random, equipment)

  // 剔除生成期辅助字段，落库的必须是干净数据
  const cleanEquipment = equipment.map(eq => {
    const { __profile, __sinceOffset, __locationHint, ...rest } = eq
    return rest
  })
  const cleanOrders = workOrders.map(order => {
    const { __system, ...rest } = order
    return rest
  })

  return {
    equipment: cleanEquipment,
    maintenanceRecords,
    workOrders: cleanOrders,
    healthSnapshots,
    catalog: MODEL_WHITELIST
  }
}

/**
 * 演示数据体检（自检脚本与"重置演示数据"后都用它校验分布）
 * 用于回答"这份演示数据能不能撑起画面"这个问题。
 */
export function auditDataset(dataset) {
  const { equipment, workOrders, healthSnapshots, maintenanceRecords } = dataset

  const levels = { A: 0, B: 0, C: 0, D: 0 }
  let overdue = 0
  let severeOverdue = 0
  const brands = {}

  for (const eq of equipment) {
    const health = evaluateHealth(eq)
    levels[health.level]++
    if (health.overdueDays !== null && health.overdueDays > 0) {
      overdue++
      if (health.overdueDays >= 45) severeOverdue++
    }
    brands[eq.brand] = (brands[eq.brand] || 0) + 1
  }

  // 趋势：找出"恶化中"的设备数与"数据不足"的设备数
  const byEquipment = {}
  for (const snap of healthSnapshots) {
    if (!byEquipment[snap.equipment_id]) byEquipment[snap.equipment_id] = []
    byEquipment[snap.equipment_id].push(snap)
  }
  let worsening = 0
  let trendInsufficient = 0
  for (const eq of equipment) {
    const trend = evaluateTrend(byEquipment[eq.id] || [])
    if (trend.kind === 'worsening') worsening++
    if (trend.kind === 'insufficient') trendInsufficient++
  }

  // 复诊闭环
  const recheckDue = workOrders.filter(o => o.recheck_date && o.recheck_status === 'pending').length
  const recheckDone = workOrders.filter(o => o.recheck_status === 'done').length

  const maintenanceCount = Object.values(maintenanceRecords)
    .reduce((sum, list) => sum + list.length, 0)

  return {
    equipmentCount: equipment.length,
    overdueCount: overdue,
    severeOverdueCount: severeOverdue,
    levels,
    brands,
    worseningCount: worsening,
    trendInsufficientCount: trendInsufficient,
    workOrderCount: workOrders.length,
    maintenanceCount,
    snapshotCount: healthSnapshots.length,
    recheckDue,
    recheckDone,
    recheckRate: recheckDone + recheckDue > 0
      ? Math.round((recheckDone / (recheckDone + recheckDue)) * 100)
      : null
  }
}

export { dueDate, daysUntilDue, formatDate }
