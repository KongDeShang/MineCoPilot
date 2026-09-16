/**
 * 矿山智工 - 口述录入解析器（自然语言 → 结构化操作）
 *
 * 设计立场（这一层是"能不能给 AI 写库权限"的分界线）：
 *   1) **不猜**。歧义时返回 candidates 让用户选，绝不替用户决定是哪台设备。
 *   2) **不静默**。解析结果是一份"操作计划"，必须经确认卡确认后才落库。
 *   3) **可审计**。计划里保留原话、命中的关键词、设备是如何匹配上的。
 *
 * 为什么用规则引擎而不是大模型：
 *   中文维保口述的句式高度有限，规则覆盖率很高；而且写库决策必须是**确定、可复现、可解释**的。
 *   大模型更适合"把结论说成人话"（叙述层），不适合决定"把哪个字段改成什么"。
 *
 * 本模块是纯函数、无 DOM 依赖，全部可选参数显式传入 —— 便于自检与端到端复用同一套逻辑。
 */

// ============================================================
// 一、意图定义
// ============================================================

export const INTENTS = {
  REPORT_FAULT: 'report_fault',       // 报故障 → 新建维修工单
  COMPLETE_ORDER: 'complete_order',   // 检修完成 → 工单完成（连带归档病历 + 复诊任务）
  ADD_MAINTENANCE: 'add_maintenance', // 记录保养 → 维保记录 + 更新上次维保日期 + 健康快照
  SET_STATUS: 'set_status',           // 改设备状态 → 停机/恢复
  DO_RECHECK: 'do_recheck',           // 复诊完成 → 闭环
  ADD_KNOWLEDGE: 'add_knowledge',     // 记经验 → 知识库
  QUERY: 'query'                      // 查询 → 不写库
}

export const INTENT_LABELS = {
  report_fault: '新建维修工单',
  complete_order: '标记工单完成',
  add_maintenance: '记录维保',
  set_status: '修改设备状态',
  do_recheck: '标记复诊完成',
  add_knowledge: '写入知识库',
  query: '查询（不写入）'
}

/** 意图优先级：越靠前越先判定 */
const INTENT_PRIORITY = [
  INTENTS.DO_RECHECK,
  INTENTS.COMPLETE_ORDER,
  INTENTS.ADD_KNOWLEDGE,
  INTENTS.ADD_MAINTENANCE,
  INTENTS.SET_STATUS,
  INTENTS.REPORT_FAULT
]

// ============================================================
// 二、文本归一化
// ============================================================

/** 归一化：统一空白/标点、全角转半角、去掉口语噪音词 */
export function normalize(text) {
  return String(text || '')
    .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[，。！？、；：""''（）【】《》,.!?;:'"()[\]<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * 语气词与助词（只用于匹配，不影响原话记录）
 *
 * ⚠️ 两个坑（都实际踩过）：
 *   1) **不要把数字放进来**——去掉"1"会让「1号挖掘机」变成「号挖掘机」，序号消解直接失效；
 *   2) **不要去掉裸的「的」**——设备型号「小松」里就含「的」字，去了就再也匹配不上。
 *   只去掉真正的口水词。**不要试图在这里做"动作词标准化"**：
 *   曾试过用负向断言处理"坏了/漏了"，结果把"停机"削成了"机"——
 *   语气词归语气词，动作词的形态问题交给匹配形式（见 matchFormForIntent / matchForm）。
 */
const NOISE = /(麻烦|帮我|请帮我|请|呗|一下子|一下|那个|这台|那台|这辆|那辆|我的|咱们的|的话|以后|然后|顺便|另外|吧|啊|呀|呢|嗯|哦)/g

/**
 * 用于识别意图的匹配形式：**保留**「了」「坏」「停」这些字。
 * 口语里的动作几乎都带"了"（坏了 / 漏了 / 停机了 / 换机油了），去掉就再也匹配不上。
 */
function matchFormForIntent(text) {
  return normalize(text)
    .replace(/[-_]+/g, ' ')
    .replace(NOISE, '')
    .replace(/\s+/g, '')
}

/**
 * 用于设备指代与实体抽取的匹配形式：**去掉**句末的「了」。
 * 台账设备名里没有"了"，留着会干扰结尾匹配（如序号 -01）。
 */
function matchForm(text) {
  return matchFormForIntent(text).replace(/了/g, '')
}

// ============================================================
// 三、意图识别
// ============================================================

const INTENT_RULES = [
  {
    intent: INTENTS.ADD_KNOWLEDGE,
    // "记一条/记一下/存个经验/以后遇到…就这么办" —— 经验录入
    patterns: [/记一条/, /记一下经验/, /记个经验/, /存个经验/, /建个知识/, /加到知识库/, /以后遇到/, /经验记/],
    verb: '写入知识库'
  },
  {
    intent: INTENTS.DO_RECHECK,
    patterns: [/复诊(完成|做完|好了|过了)/, /复查(完成|做完|好了|过了)/, /复检(完成|做完|好了|过了)/],
    verb: '标记复诊完成'
  },
  {
    intent: INTENTS.COMPLETE_ORDER,
    // "已检修/修好了/处理完了/完工" —— 完成既有工单
    patterns: [
      /已(经)?(检修|维修|修|处理|整改|排除)(完|好|完毕|结束)/,
      /(检修|维修|修|处理|整改|排除)(完|好|好了|完了|完毕|结束)/,
      /完工/, /搞定了/, /弄好了/, /已修复/, /已恢复/,
      /检修完成了/, /处理完毕/
    ],
    verb: '标记工单完成'
  },
  {
    intent: INTENTS.ADD_MAINTENANCE,
    patterns: [
      /(做|做完|干完|完成|进行)(了)?(保养|例保|点检|一级保养|二级保养|月度保养|定期保养|大保养)/,
      /(保养|例保)(完|好|完毕|了)/,
      /**
       * 只报"换了什么件"也算保养记录（现场最常见的说法）。
       * ⚠️ 动作词必须同时列出"换"与"换了"：NOISE 会去掉"了"，
       * 归一化后 "换了机油" 变成 "换机油"，只写"换了"会匹配不到。
       */
      /(换|更换|加|补|打)[^。]{0,20}(机油|液压油|滤芯|三滤|空滤|柴滤|机滤|黄油|润滑脂|防冻液|冷却液|变速箱油|齿轮油|轮胎|刹车片|衬板|斗齿|油管|密封|溢流阀|皮带|电瓶)/,
      // 只报"换了 X"（后面无空格）——覆盖"换机油和机滤"
      /(换|更换|加|补|打)[^。]{0,20}/,
      /(保养记录|维保记录)/,
      /保养做了/
    ],
    verb: '记录维保'
  },
  {
    intent: INTENTS.SET_STATUS,
    /**
     * ⚠️ 这里的措辞必须"指向明确意图"，不能只描述现象：
     *   · "先停机/别排产" → 明确的管理动作 → 改状态
     *   · "趴窝了/停机了" → 故障现象，应走报修（否则用户说故障，系统却只改了个状态，工单没建）
     */
    patterns: [
      /(先|马上|立刻|马上给我)?(停机|停车|停用|停掉)(别|不要|不)?(排产|安排|派活)/,
      /先(停机|停用|别用|不要用)/,
      /(先别|别|不要)(排产|用这|安排这)/,
      /(闲置|封存|停用|退出运行)(起来|了)?$/,
      /现在(是)?(维保中|检修中|维修中)/,
      /修好了可以(用|开|上线|干活)/,
      /(恢复|重新)(运行|生产|使用|上线|干活)/,
      /(已经)?(封存|停用)了$/
    ],
    verb: '修改设备状态'
  },
  {
    intent: INTENTS.REPORT_FAULT,
    // 任何"出现问题"的描述都归到这里（兜底意图，放在最后）
    patterns: [
      /(出|有|发现)(了)?(问题|故障|异常|毛病)/,
      /(报|报个|登记)(一下)?(故障|问题|异常|维修)/,
      /(坏了|坏了台|不行了|报警|报警了|异常|故障)/,
      /(需要|得|要)(检修|维修|处理|检查|排查|换|更换)/
    ],
    verb: '新建维修工单'
  }
]

/**
 * 查询句式：命中即为查询，**绝不写库**
 *
 * ⚠️ 这一层必须放在"故障关键词兜底"之前，否则
 * 「哪些设备维保已超期」「发动机过热怎么排查」这种纯提问会被当成"报故障"而误建工单——
 * 这是本功能最危险的失效模式：用户只想问一句，系统却改了库。
 */
const QUERY_PATTERNS = [
  /哪些/, /哪几/, /哪台/, /哪一个/,
  /多少台/, /几台/, /有几个/, /有多少/,
  /怎么(排查|处理|解决|办|修)/, /如何(排查|处理|解决)/, /为什么/,
  /是什么(原因|问题)/, /什么原因/,
  /(怎么样|如何)$/, /状态如何/,
  /^查(一下|询)/, /^看(一下|看)/, /^统计/, /^列出/, /^列一下/,
  /(谁|哪台)负责/
]

/** 疑问句但按报修处理是安全的场景：明确带"报/记录/登记"等动作词时不算查询 */
const EXPLICIT_WRITE_VERBS = /(报|记录一下|登记|帮我记|建单|安排|创建)/

export function detectQuery(text) {
  const form = matchFormForIntent(text)
  if (EXPLICIT_WRITE_VERBS.test(form)) return false
  return QUERY_PATTERNS.some(p => p.test(form)) || /[?？]$/.test(String(text).trim())
}

/**
 * 识别意图
 * @returns {{ intent: string|null, confidence: number, matched: string|null }}
 */
export function detectIntent(text) {
  // 意图识别用"保留语气字"的形式：口语动作词几乎都带"了"
  const form = matchFormForIntent(text)

  // 查询优先：问题不能被当成故障报修
  if (detectQuery(text)) {
    return { intent: INTENTS.QUERY, confidence: 0.95, matched: '查询句式', verb: '查询' }
  }

  for (const intent of INTENT_PRIORITY) {
    const rule = INTENT_RULES.find(r => r.intent === intent)
    if (!rule) continue
    for (const pattern of rule.patterns) {
      const hit = form.match(pattern)
      if (hit) {
        return { intent: rule.intent, confidence: 0.9, matched: hit[0], verb: rule.verb }
      }
    }
  }

  // 没有任何动作词，但提到了故障关键词 → 仍按报故障处理（口语里"3号挖掘机液压油漏了"就属于这类）
  const fault = extractFault(form)
  const hasSignal = fault.matched.length || FAULT_SIGNAL_WORDS.some(w => form.includes(w))
  if (hasSignal) {
    return {
      intent: INTENTS.REPORT_FAULT,
      confidence: fault.matched.length ? 0.7 : 0.5,
      matched: fault.matched[0] || FAULT_SIGNAL_WORDS.find(w => form.includes(w)),
      verb: '新建维修工单',
      inferred: true,
      // 只凭"信号词"（没命中具体故障现象）判定时，标记为待确认，UI 会提示补充现象
      weak: !fault.matched.length
    }
  }

  return { intent: null, confidence: 0, matched: null }
}

// ============================================================
// 四、实体抽取
// ============================================================

/** 故障现象库：关键词 → 标准描述 + 工单标题（标题沿用真实工单措辞） */
const FAULT_KEYWORDS = [
  // 液压系统
  { keys: ['液压油压力低', '压力偏低', '压力低', '压力不足', '压力异常'], system: '液压系统', title: '液压系统压力偏低，需检修', priority: 'high' },
  { keys: ['液压油温高', '油温高', '油温过高', '油温报警'], system: '液压系统', title: '液压油温过高，需检查散热', priority: 'high' },
  { keys: ['液压漏油', '液压油漏', '漏油', '渗油', '油管漏', '漏油了'], system: '液压系统', title: '液压系统渗漏，需检查密封', priority: 'high' },
  { keys: ['液压异响', '主泵异响', '泵响'], system: '液压系统', title: '液压泵异响，需检查', priority: 'normal' },
  { keys: ['动作慢', '动作无力', '无力', '慢'], system: '液压系统', title: '工作装置动作无力，需检查液压系统', priority: 'normal' },
  // 动力系统
  { keys: ['水温高', '水温偏高', '水温报警', '过热', '高温'], system: '动力系统', title: '发动机水温偏高，需检查冷却系统', priority: 'high' },
  { keys: ['发动机异响', '敲缸', '嗒嗒响'], system: '动力系统', title: '发动机异响，需检查', priority: 'high' },
  { keys: ['冒黑烟', '黑烟', '冒烟'], system: '动力系统', title: '排气管冒黑烟，需检查燃油系统', priority: 'high' },
  { keys: ['机油压力', '机油报警'], system: '动力系统', title: '机油压力异常，需检查润滑系统', priority: 'high' },
  { keys: ['启动困难', '打不着', '启动不了', '打不燃'], system: '动力系统', title: '启动困难，需检查启动系统', priority: 'high' },
  { keys: ['皮带打滑', '皮带响'], system: '动力系统', title: '风扇皮带打滑，需调整或更换', priority: 'normal' },
  // 电气系统
  { keys: ['空调不制冷', '空调不凉', '空调坏'], system: '电气系统', title: '空调制冷异常，需检修', priority: 'low' },
  { keys: ['仪表报警', '仪表盘', '传感器'], system: '电气系统', title: '仪表或传感器信号异常，需检查线路', priority: 'normal' },
  { keys: ['电瓶', '亏电', '没电'], system: '电气系统', title: '电瓶亏电，需检查充电系统', priority: 'normal' },
  { keys: ['线路', '接触不良'], system: '电气系统', title: '线路接触不良，需检查', priority: 'normal' },
  // 底盘行走
  { keys: ['履带松', '履带张紧', '履带脱', '脱轨', '跳齿'], system: '底盘行走', title: '履带张紧度异常，需调整', priority: 'high' },
  { keys: ['轮胎漏气', '胎压低', '轮胎气压', '爆胎', '轮胎磨损', '吃胎'], system: '底盘行走', title: '轮胎异常，需检查气压与磨损', priority: 'high' },
  { keys: ['刹车', '制动', '刹车片'], system: '底盘行走', title: '制动系统异常，需检查', priority: 'urgent' },
  { keys: ['变速箱', '变矩器', '传动'], system: '底盘行走', title: '传动系统异常，需检查', priority: 'high' },
  { keys: ['支重轮', '行走异响', '行走无力', '跑偏'], system: '底盘行走', title: '行走机构异常，需检查', priority: 'normal' },
  // 振动类：钻机与破碎机最常见，知识库里也有对应条目，不能落到兜底分支
  { keys: ['钻杆振动', '钻杆异响', '钻进异常', '进尺慢'], system: '钻机系统', title: '钻杆振动异常，需检查回转与推进机构', priority: 'high' },
  { keys: ['破碎机振动', '破碎振动', '振动大', '振动异常', '振动'], system: '破碎设备', title: '设备振动异常，需检查减振与紧固', priority: 'high' },
  // 其他
  { keys: ['玻璃', '驾驶室'], system: '其他', title: '驾驶室部件损坏，需维修', priority: 'low' },
  { keys: ['焊缝', '开裂', '裂纹', '结构件'], system: '其他', title: '结构件开裂，需补焊处理', priority: 'urgent' },
  { keys: ['灯', '照明'], system: '其他', title: '照明灯具失效，需更换', priority: 'low' },
  { keys: ['保养超期', '超期', '该保养'], system: '其他', title: '维保超期，需安排保养', priority: 'high' }
]

/** 紧急词：命中即升级优先级 */
const URGENT_WORDS = ['停机', '趴窝', '起火', '刹车失灵', '无法行走', '开不动', '脱轨', '冒黑烟']

/** 故障关键词（兜底意图"没命中任何关键词但确实在故障报修"的判据） */
const FAULT_SIGNAL_WORDS = ['漏了', '漏油', '渗油', '报警', '异响', '冒烟', '异常', '坏了', '坏', '不行了',
  '不来车', '发抖', '高温', '偏低', '过高', '趴窝', '停机了', '停了', '脱轨', '失灵', '开不动']

/** 维修/更换的配件（用于维保记录与工单描述） */
const PART_WORDS = ['液压油', '机油', '滤芯', '三滤', '空滤', '柴滤', '机滤', '黄油', '润滑脂', '防冻液', '冷却液',
  '变速箱油', '齿轮油', '轮胎', '刹车片', '衬板', '斗齿', '油管', '密封圈', '溢流阀', '压缩机', '水泵', '皮带', '电瓶']

/** 保养级别 */
const SERVICE_LEVELS = [
  { keys: ['月度保养', '月保'], label: '月度保养' },
  { keys: ['二级保养'], label: '二级保养' },
  { keys: ['一级保养'], label: '一级保养' },
  { keys: ['大保养', '2000小时', '全车保养'], label: '大保养' },
  { keys: ['定期保养', '例保', '保养'], label: '定期保养' }
]

/**
 * 抽取故障现象
 * @returns {{ title, system, priority, matched: string[], parts: string[] }}
 */
export function extractFault(form) {
  const matched = []
  let best = null
  let bestLen = 0

  for (const entry of FAULT_KEYWORDS) {
    for (const key of entry.keys) {
      if (form.includes(key) && key.length > bestLen) {
        bestLen = key.length
        best = entry
        matched.push(key)
      } else if (form.includes(key)) {
        matched.push(key)
      }
    }
  }

  const priority = URGENT_WORDS.some(w => form.includes(w))
    ? 'urgent'
    : (best ? best.priority : 'normal')

  const parts = PART_WORDS.filter(p => form.includes(p))

  return {
    title: best ? best.title : null,
    system: best ? best.system : null,
    priority,
    matched: [...new Set(matched)],
    parts
  }
}

/** 抽取维保级别 */
export function extractServiceLevel(form) {
  for (const level of SERVICE_LEVELS) {
    if (level.keys.some(k => form.includes(k))) return level.label
  }
  return null
}

/**
 * 抽取日期：默认今天；支持 今天/昨天/前天/具体日期
 *
 * ⚠️ 必须传**原文（或 normalize 后的文本）**，不能传 matchForm 的结果：
 * matchForm 会把 "-" 归一化成空格再删掉，`2026-09-08` 会变成 `20260908`，
 * 年份/月份/日期的分隔符随之丢失，具体日期就再也抽不出来。
 */
export function extractDate(text, now = new Date()) {
  const base = new Date(now)
  const fmt = (d) => {
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${d.getFullYear()}-${m}-${day}`
  }

  const raw = normalize(text)
  // 原文：normalize 会把 "-" 与 "/" 换成空格，具体日期只可能完整出现在原文里
  const source = `${String(text || '')} ${raw}`

  if (/前天/.test(raw)) { base.setDate(base.getDate() - 2); return { date: fmt(base), phrase: '前天' } }
  if (/昨天|昨日/.test(raw)) { base.setDate(base.getDate() - 1); return { date: fmt(base), phrase: '昨天' } }

  // 完整日期：2026年9月8日 / 2026-09-08 / 2026/9/8（从原文匹配）
  // 分隔符里的「-」写在字符组末尾，避免被解析成区间
  const explicit = source.match(/(\d{4})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})/)
  if (explicit) {
    return {
      date: `${explicit[1]}-${String(explicit[2]).padStart(2, '0')}-${String(explicit[3]).padStart(2, '0')}`,
      phrase: explicit[0].trim()
    }
  }

  // 月日：9月8日 / 9月8号
  const monthDay = raw.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/)
  if (monthDay) {
    const d = new Date(base.getFullYear(), Number(monthDay[1]) - 1, Number(monthDay[2]))
    return { date: fmt(d), phrase: monthDay[0].trim() }
  }

  return { date: fmt(base), phrase: '今天' }
}

/** 抽取设备状态变更目标 */
export function extractTargetStatus(form) {
  if (/(停机|停了|趴窝|先别排产|别排产|不排产|停用|退出运行|封存)/.test(form)) return { status: 'fault', label: '故障（停机）' }
  if (/(闲置|没活干|放着)/.test(form)) return { status: 'idle', label: '闲置' }
  if (/(恢复|可以用了|重新上线|继续干)/.test(form)) return { status: 'running', label: '运行中' }
  if (/(维保中|检修中|维修中)/.test(form)) return { status: 'maintenance', label: '维保中' }
  return null
}

/** 抽取工单类型 */
export function extractOrderType(form) {
  if (/(巡检|点检|检查一下)/.test(form)) return 'inspection'
  if (/(保养|例保)/.test(form)) return 'maintenance'
  return 'repair'
}

// ============================================================
// 五、设备指代消解（本方案最关键的一环）
// ============================================================

/** 中文数字 → 阿拉伯数字 */
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

/**
 * 编号的等价写法（用于"结尾匹配"）
 *
 * ⚠️ 三个坑（全部实际踩过）：
 *   1) 不能包含裸的阿拉伯数字（如 '1'）——`name.endsWith('1')` 会让 "-11" 被误判成 1 号；
 *   2) 不能包含带连字符的写法（如 '-1'）——matchForm 会吃掉 '-'，
 *      两侧都归一化后 '-1' 变成 '1'，又退化成第 1 个坑；
 *   3) 阿拉伯数字一律走带数字边界的正则（见 resolveEquipment 里的 seqRe），这里只放中文写法。
 */
function numberVariants(n) {
  const cn = Object.entries(CN_NUM).find(([, v]) => v === n)
  if (!cn) return []
  return [`${cn[0]}号`, `${cn[0]}`]
}

/**
 * 解析设备指代（多级匹配，歧义即返回候选）
 *
 * 匹配层级（逐级降级，任一层唯一命中即确定）：
 *   1. 全名精确匹配
 *   2. 口语别名（用户可为设备维护别名）
 *   3. 型号 + 序号
 *   4. 类别 + 序号（"3号挖掘机"）
 *   5. 纯型号（唯一时确定，多台时为歧义）
 *   6. token 模糊打分（唯一高分才确定）
 *
 * ⚠️ 任何一层出现 ≥2 个候选，都**不猜**，交给用户点选。
 *
 * @returns {{ status: 'resolved'|'ambiguous'|'not_found', equipment, candidates, method, phrase }}
 */
export function resolveEquipment(text, equipmentList = [], options = {}) {
  const form = matchForm(text)
  const list = equipmentList.filter(Boolean)
  if (!list.length) return { status: 'not_found', reason: '台账为空', candidates: [] }

  // 1. 全名精确匹配（含去空格后的包含判断，覆盖"台账名被念了一半"的情况）
  for (const eq of list) {
    const name = matchForm(eq.name)
    if (name && form.includes(name)) {
      return { status: 'resolved', equipment: eq, method: 'name-exact', phrase: eq.name }
    }
  }

  // 2. 口语别名
  const aliasHit = list.filter(eq => Array.isArray(eq.aliases) &&
    eq.aliases.some(a => a && form.includes(matchForm(a))))
  if (aliasHit.length === 1) {
    return { status: 'resolved', equipment: aliasHit[0], method: 'alias', phrase: aliasHit[0].aliases.find(a => form.includes(matchForm(a))) }
  }
  if (aliasHit.length > 1) {
    return { status: 'ambiguous', candidates: aliasHit, method: 'alias', reason: '别名命中多台设备' }
  }

  // 3/4/5. 型号 / 类别 / 序号 组合匹配
  const tokens = tokenizeEquipment(list)
  const modelHits = tokens.models.filter(m => form.includes(matchForm(m)))
  const categoryHits = tokens.categories.filter(c => form.includes(matchForm(c)))
  const seqHit = extractSequence(form)

  let pool = list

  if (modelHits.length) {
    // 取最长命中的型号（"XE215C" 优先于 "XE"）
    const model = modelHits.sort((a, b) => b.length - a.length)[0]
    pool = pool.filter(eq => matchForm(eq.model || '').includes(matchForm(model)) ||
      matchForm(eq.name).includes(matchForm(model)))
  }
  if (categoryHits.length) {
    pool = pool.filter(eq => categoryHits.some(c => (eq.category || '').includes(c)))
  }
  if (seqHit !== null) {
    const num = seqHit
    /**
     * 编号匹配必须卡"数字边界"：
     *   正确：-01 / -1 / 01 / 1
     *   不能匹配：-11 / -21 / -31（它们不是 1 号，0* 会贪婪地把 1 吃掉造成误判）
     */
    const seqRe = new RegExp(`(?:^|[^0-9])0*${num}$`)
    const withNum = pool.filter(eq => {
      const name = matchForm(eq.name)
      if (seqRe.test(name)) return true
      return numberVariants(num).some(v => name.endsWith(matchForm(v)))
    })
    if (typeof globalThis.__NL_DEBUG__ === 'function') {
      globalThis.__NL_DEBUG__({ seqHit, poolSize: pool.length, withNumSize: withNum.length, categoryHits, modelHits, form, sample: pool.slice(0, 3).map(e => matchForm(e.name)) })
    }
    if (withNum.length) {
      pool = withNum
    } else {
      // 用户明确说了编号，但候选里没有这一台 —— 不猜，直接报告未找到
      return {
        status: 'not_found',
        reason: `没有编号为「${seqHit}」的${categoryHits[0] || ''}设备`,
        candidates: []
      }
    }
  }

  if (pool.length === 1) {
    const method = modelHits.length ? 'model+seq' : categoryHits.length ? 'category+seq' : 'partial'
    return { status: 'resolved', equipment: pool[0], method, phrase: pool[0].name }
  }
  if (pool.length > 1 && (modelHits.length || categoryHits.length || seqHit !== null)) {
    return {
      status: 'ambiguous',
      candidates: pool,
      method: 'pool-multi',
      reason: `匹配到 ${pool.length} 台设备，需要确认是哪一台`
    }
  }

  // 6. 模糊打分兜底：按 token 重合度排序，唯一最高分才确定
  const scored = list.map(eq => {
    const hay = matchForm(`${eq.name} ${eq.model || ''} ${eq.category || ''} ${eq.location || ''}`)
    let score = 0
    for (const token of extractQueryTokens(form)) {
      if (token.length >= 2 && hay.includes(token)) score += token.length
    }
    return { eq, score }
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score)

  if (scored.length === 1) {
    return { status: 'resolved', equipment: scored[0].eq, method: 'fuzzy', phrase: scored[0].eq.name }
  }
  if (scored.length > 1) {
    // 只有"领先幅度足够大"才敢替用户决定；差距很小一律回问
    const margin = scored[0].score - scored[1].score
    if (margin >= 3) {
      return { status: 'resolved', equipment: scored[0].eq, method: 'fuzzy-best', phrase: scored[0].eq.name }
    }
    return {
      status: 'ambiguous',
      candidates: scored.slice(0, 5).map(s => s.eq),
      method: 'fuzzy-tie',
      reason: '多台设备得分接近，需要确认'
    }
  }

  return { status: 'not_found', reason: '台账中未找到对应设备', candidates: [] }
}

/** 收集台账里出现过的型号与类别（用于匹配） */
function tokenizeEquipment(list) {
  const models = new Set()
  const categories = new Set()
  for (const eq of list) {
    if (eq.model) models.add(String(eq.model).trim())
    if (eq.category) categories.add(String(eq.category).trim())
  }
  return {
    models: [...models].filter(Boolean),
    categories: [...categories].filter(Boolean)
  }
}

/** 抽取序号："3号" / "3 号" / "第三台" / "第3台" */
export function extractSequence(form) {
  const arabic = form.match(/(\d{1,3})\s*号/)
  if (arabic) return Number(arabic[1])
  // 「第3台挖掘机」这类写法
  const ordinal = form.match(/第\s*(\d{1,3})\s*(台|辆|个)/)
  if (ordinal) return Number(ordinal[1])
  const cn = form.match(/([一二三四五六七八九十])\s*号/)
  if (cn) return CN_NUM[cn[1]] || null
  const cnOrdinal = form.match(/第\s*([一二三四五六七八九十])\s*(台|辆|个)/)
  if (cnOrdinal) return CN_NUM[cnOrdinal[1]] || null
  // ⚠️ 注意：不把型号里的数字当序号。
  // 「卡特320D」的 320 不是编号，误判会把用户指向不存在的"320号"设备。
  return null
}

/** 从语句里切出用于模糊匹配的 token（去掉设备描述以外的高频词） */
function extractQueryTokens(form) {
  const stop = new Set(['号', '台', '机', '车', '设备', '今天', '昨天', '前天', '已经', '完成', '保养', '检修',
    '维修', '记录', '工单', '故障', '问题', '需要', '安排', '处理', '检查'])
  const tokens = form.split(/[\s\-_]+/).filter(t => t && !stop.has(t))
  // 中文没有空格，补一层 n-gram 兜底
  const clean = form.replace(/[\d\s\-_]/g, '')
  for (let len = 4; len >= 2; len--) {
    for (let i = 0; i + len <= clean.length; i++) tokens.push(clean.slice(i, i + len))
  }
  return [...new Set(tokens)].filter(t => t.length >= 2)
}

// ============================================================
// 六、操作计划组装
// ============================================================

/** 把一句话切成多个操作子句（支持"…，另外…""…顺便…"） */
export function splitClauses(text) {
  return String(text || '')
    .split(/(?:另外|顺便|还有|；|;|。|，(?:然后|再)?(?=.*(?:号|台|设备)))/)
    .map(s => s.trim())
    .filter(s => s.length >= 4)
}

function buildPlanItems(store, clause, now) {
  const form = matchForm(clause)
  const detection = detectIntent(clause)
  if (!detection.intent) return { items: [], detection }

  const equipmentRef = resolveEquipment(clause, store.equipmentList)
  // 日期从原文抽取（matchForm 会吃掉日期分隔符）
  const dateInfo = extractDate(clause, now)
  const fault = extractFault(form)

  const base = {
    intent: detection.intent,
    intentLabel: INTENT_LABELS[detection.intent],
    verb: detection.verb,
    rawText: clause,
    matchedKeyword: detection.matched,
    equipmentRef,
    equipment: equipmentRef.status === 'resolved' ? equipmentRef.equipment : null,
    date: dateInfo.date,
    datePhrase: dateInfo.phrase
  }

  switch (detection.intent) {
    case INTENTS.REPORT_FAULT:
      return {
        items: [{
          ...base,
          title: fault.title || `${equipmentRef.phrase || '设备'}故障报修`,
          system: fault.system,
          priority: fault.priority,
          description: clause
        }],
        detection
      }

    case INTENTS.COMPLETE_ORDER: {
      const target = findLatestOpenOrder(store, equipmentRef)
      return {
        items: [{
          ...base,
          preflightError: target ? null : '该设备没有待处理或处理中的工单，无法标记完成',
          order: target
        }],
        detection
      }
    }

    case INTENTS.ADD_MAINTENANCE: {
      const level = extractServiceLevel(form) || '定期保养'
      const parts = fault.parts
      return {
        items: [{
          ...base,
          serviceLevel: level,
          parts,
          partsText: parts.join('+'),
          description: parts.length ? `${level}：更换/补充 ${parts.join('、')}` : level
        }],
        detection
      }
    }

    case INTENTS.SET_STATUS: {
      const target = extractTargetStatus(form)
      return {
        items: [{
          ...base,
          preflightError: target ? null : '未能识别要改成的状态（停机 / 闲置 / 维保中 / 恢复运行）',
          targetStatus: target ? target.status : null,
          targetStatusLabel: target ? target.label : null
        }],
        detection
      }
    }

    case INTENTS.DO_RECHECK: {
      const order = (store.workOrders || []).find(o =>
        o.recheck_status === 'pending' &&
        (!equipmentRef.equipment || o.equipment_name === equipmentRef.equipment.name))
      return {
        items: [{
          ...base,
          preflightError: order ? null : '没有找到待复诊的工单',
          order
        }],
        detection
      }
    }

    case INTENTS.ADD_KNOWLEDGE:
      return {
        items: [{
          ...base,
          title: fault.title || '现场案例',
          system: fault.system,
          description: clause
        }],
        detection
      }

    default:
      return { items: [], detection }
  }
}

/** 找该设备最近一张未完成工单（待处理优先，其次处理中） */
function findLatestOpenOrder(store, equipmentRef) {
  const eq = equipmentRef.equipment
  if (!eq) return null
  const orders = (store.workOrders || []).filter(o => o.equipment_name === eq.name && (o.status === 'pending' || o.status === 'processing'))
  if (!orders.length) return null
  return orders.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]
}

/**
 * 总入口：把一句话解析成"操作计划"
 *
 * @param {object} store Pinia store（只读，不写库）
 * @param {string} text  用户原话
 * @param {{ now?: Date }} options
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   intent?: string,
 *   items: Array<object>,
 *   ambiguous: Array<object>,
 *   notFound: Array<object>,
 *   rawText: string
 * }}
 */
export function parseCommand(store, text, options = {}) {
  const now = options.now || new Date()
  const rawText = String(text || '').trim()
  if (!rawText) return { ok: false, reason: 'empty', items: [], ambiguous: [], notFound: [], rawText }

  const clauses = splitClauses(rawText)
  const allItems = []
  const ambiguous = []
  const notFound = []
  const noIntent = []
  // 歧义组自增 id：界面一次只展示一组，用户选完一组后才能确认下一组。
  // 必须带 id 而不是靠 clause 文本关联——同一句话里出现两次相同子句时，
  // 靠文本会一次把两组都"解掉"，第二组就会永远停在没有候选的悬空状态。
  let ambSeq = 0

  for (const clause of clauses) {
    const { items, detection } = buildPlanItems(store, clause, now)
    if (!detection.intent) { noIntent.push(clause); continue }

    for (const item of items) {
      if (item.equipmentRef.status === 'ambiguous') {
        const group = {
          id: `amb-${++ambSeq}`,
          clause,
          candidates: item.equipmentRef.candidates,
          intent: item.intent
        }
        ambiguous.push(group)
        item.ambiguousId = group.id
      } else if (item.equipmentRef.status === 'not_found') {
        notFound.push({ clause, reason: item.equipmentRef.reason })
      }
      allItems.push(item)
    }
  }

  // 全部子句都没有意图 → 交给既有问答链路（查询 / 知识库）
  if (!allItems.length) {
    return {
      ok: false,
      reason: noIntent.length ? 'no_intent' : 'no_match',
      intent: INTENTS.QUERY,
      items: [],
      ambiguous,
      notFound,
      clauses: noIntent,
      rawText
    }
  }

  return {
    ok: true,
    intent: allItems[0].intent,
    items: allItems,
    ambiguous,
    notFound,
    rawText,
    requiresConfirm: true,
    // 只要有歧义或找不到设备，就不允许一键确认
    blocked: ambiguous.length > 0 || notFound.length > 0
  }
}

// ============================================================
// 七、执行（把计划落到 store）
// ============================================================

/**
 * 执行一条操作计划项
 * @returns {{ ok: boolean, summary: string, changes: Array<object>, error?: string, undo?: Function }}
 */
export function executePlanItem(store, item, options = {}) {
  const nowStr = options.now ? formatStamp(options.now) : undefined
  const changes = []

  const eq = item.equipment
  if (!eq && item.intent !== INTENTS.ADD_KNOWLEDGE) {
    return { ok: false, error: '未确定设备，不能写入' }
  }

  switch (item.intent) {
    case INTENTS.REPORT_FAULT: {
      const order = store.addWorkOrder({
        equipment_id: eq.id,
        equipment_name: eq.name,
        title: item.title,
        description: item.description,
        type: extractOrderType(matchForm(item.rawText)),
        priority: item.priority,
        status: 'pending',
        source: 'voice',
        created_at: nowStr
      })
      changes.push({ label: '新建工单', detail: `#${order.id} ${order.title}`, kind: 'work_order', id: order.id })
      return {
        ok: true,
        summary: `已为「${eq.name}」新建${priorityLabel(item.priority)}维修工单 #${order.id}`,
        changes,
        undo: () => store.removeWorkOrder(order.id)
      }
    }

    case INTENTS.COMPLETE_ORDER: {
      if (!item.order) return { ok: false, error: item.preflightError || '找不到可完成的工单' }
      const snapshot = snapshotEquipment(store, eq)
      // 完成工单是一次"多点开花"的写入（工单字段 + 病历 + 快照 + 复诊任务 + 日志 +
      // 知识草案 + 故障案例卡），撤销必须把每一路都收回去，所以先把工单字段和
      // 两类会新增的集合各拍一张"写入前"的快照。
      // ⚠️ 这几个字段在"完成"之前可能**整个键都不存在**（待处理工单身上没有 archived_at），
      // 那样展开出来的快照里就没有它们，Object.assign 自然也就清不掉。
      // 必须显式补 null，把"当时没有"这件事也写进快照。
      const orderBefore = {
        ...item.order,
        archived_at: item.order.archived_at ?? null,
        completed_at: item.order.completed_at ?? null,
        recheck_date: item.order.recheck_date ?? null,
        recheck_status: item.order.recheck_status ?? null
      }
      const faultCaseIdsBefore = new Set((store.faultCases || []).map(c => String(c.id)))
      const knowledgeIdsBefore = new Set((store.knowledgeItems || []).map(k => String(k.id)))

      store.updateWorkOrderStatus(item.order.id, 'completed')

      const newFaultCaseIds = (store.faultCases || [])
        .filter(c => !faultCaseIdsBefore.has(String(c.id))).map(c => c.id)
      const newKnowledgeIds = (store.knowledgeItems || [])
        .filter(k => !knowledgeIdsBefore.has(String(k.id))).map(k => k.id)

      const updated = (store.workOrders || []).find(o => o.id === item.order.id)
      changes.push({ label: '工单完成', detail: `#${item.order.id} ${item.order.title}`, kind: 'work_order', id: item.order.id })
      if (updated && updated.recheck_date) {
        changes.push({ label: '生成复诊任务', detail: `${updated.recheck_date} 复诊`, kind: 'recheck', id: updated.id })
      }
      changes.push({ label: '归档病历', detail: `写入「${eq.name}」维保记录并更新健康快照`, kind: 'maintenance' })
      return {
        ok: true,
        summary: `工单 #${item.order.id} 已完成，病历已归档${updated && updated.recheck_date ? `，${updated.recheck_date} 复诊` : ''}`,
        changes,
        undo: () => {
          // 工单字段**整体**还原，不能只把 status 改回 processing：
          // 归档时置的 archived_at 会留下，而 appStore 的归档守卫正是以
          // `!order.archived_at` 为准 —— 残留会让"撤销后再次完成"整段跳过归档，
          // 病历、健康快照、复诊任务再也补不回来，且全程不报错。
          // recheck_date / recheck_status 同理，否则复诊管理页会挂着一条幽灵任务。
          store.updateWorkOrder(item.order.id, orderBefore)
          // 本次归档连带沉淀出来的案例卡与知识草案一并收回
          if (store.removeFaultCasesByIds) store.removeFaultCasesByIds(newFaultCaseIds)
          if (store.removeKnowledgeItemsByIds) store.removeKnowledgeItemsByIds(newKnowledgeIds)
          restoreEquipment(store, snapshot)
        }
      }
    }

    case INTENTS.ADD_MAINTENANCE: {
      const snapshot = snapshotEquipment(store, eq)
      // 快照改由 addMaintenanceRecord 内部落（snapshot: true）—— 原先这里
      // 在外面自己补一次，台账页那条门漏了，同一操作两个门的数据不一样。
      // 现在只有一个地方决定"要不要落快照"，不会再漏。
      const added = store.addMaintenanceRecord(eq.id, {
        date: item.date,
        type: maintenanceRecordType(item),
        description: item.description,
        parts_used: item.partsText,
        technician: ''
      }, { snapshot: true })
      changes.push({ label: '新增维保记录', detail: `${item.date} ${item.description}`, kind: 'maintenance' })
      changes.push({ label: '更新设备', detail: `上次维保日期 → ${item.date}`, kind: 'equipment', id: eq.id })
      changes.push({ label: '健康快照', detail: `${item.date} 记录一次健康分`, kind: 'snapshot' })
      if (added && added.partsResult && added.partsResult.consumed > 0) {
        changes.push({ label: '备件扣减', detail: `自动出库 ${added.partsResult.consumed} 项：${added.partsResult.matched.join('、')}`, kind: 'parts' })
      }
      return {
        ok: true,
        summary: `已为「${eq.name}」记录${item.serviceLevel}（${item.date}）`,
        changes,
        undo: () => {
          // 备件库存和出库流水必须一起回滚：设备病历撤了、账却已经扣了，
          // 是典型的"账实不符且查不出原因"。
          if (added && added.partsResult && store.revertConsumption) {
            store.revertConsumption(added.partsResult.applied)
          }
          restoreEquipment(store, snapshot)
        }
      }
    }

    case INTENTS.SET_STATUS: {
      if (!item.targetStatus) return { ok: false, error: item.preflightError || '未识别目标状态' }
      const before = eq.status
      store.updateEquipment(eq.id, { status: item.targetStatus })
      changes.push({ label: '设备状态', detail: `${statusLabel(before)} → ${statusLabel(item.targetStatus)}`, kind: 'equipment', id: eq.id })
      return {
        ok: true,
        summary: `「${eq.name}」状态已改为 ${item.targetStatusLabel}`,
        changes,
        undo: () => store.updateEquipment(eq.id, { status: before })
      }
    }

    case INTENTS.DO_RECHECK: {
      if (!item.order) return { ok: false, error: item.preflightError || '没有待复诊工单' }
      store.markRecheckDone(item.order.id)
      changes.push({ label: '复诊完成', detail: `#${item.order.id} ${item.order.title}`, kind: 'recheck', id: item.order.id })
      return {
        ok: true,
        summary: `「${item.order.equipment_name}」复诊完成，闭环率已更新`,
        changes,
        undo: () => store.updateWorkOrder(item.order.id, { recheck_status: 'pending' })
      }
    }

    case INTENTS.ADD_KNOWLEDGE: {
      const created = store.addKnowledgeItem({
        title: item.title,
        category: item.system || '现场案例',
        keywords: [eq ? eq.category : '', item.system || ''].filter(Boolean),
        symptoms: item.rawText,
        causes: [],
        steps: [],
        source: '现场录入（口述）'
      })
      if (!created) return { ok: false, error: '知识条目创建失败（标题为空）' }
      changes.push({ label: '知识库新增', detail: `《${created.title}》`, kind: 'knowledge', id: created.id })
      return {
        ok: true,
        summary: `已写入知识库：《${created.title}》，来源标注为现场录入`,
        changes,
        undo: () => store.removeKnowledgeItem(created.id)
      }
    }

    default:
      return { ok: false, error: `暂不支持的操作类型：${item.intent}` }
  }
}

function priorityLabel(priority) {
  return { urgent: '紧急', high: '高优先级', normal: '', low: '低优先级' }[priority] || ''
}

function statusLabel(status) {
  return { running: '运行中', idle: '闲置', maintenance: '维保中', fault: '故障' }[status] || status
}

/**
 * 口述"记维保"落到维保记录的 type 字段
 *
 * 维保记录只认字典里的四种类型（定期保养 / 故障维修 / 部件更换 / 巡检），
 * 而口述抽出来的是**保养级别**（月度保养 / 一级保养 / 二级保养 / 大保养 / 定期保养）——
 * 级别比类型细一档，四种保养级别本质上都是"定期保养"。
 * 级别本身不会丢：它写在 description 里（无配件时 description 就是级别原文）。
 *
 * 这里原先写的是 `item.serviceLevel === '月度保养' ? '定期保养' : '定期保养'`——
 * 两个分支同一个值，看着像在做映射、其实什么也没判。改成显式函数，
 * 并补上"带配件即部件更换"这一档，与台账页手动选类型时的口径对齐。
 */
function maintenanceRecordType(item) {
  const hasParts = !!(item.partsText && String(item.partsText).trim())
  return hasParts ? '部件更换' : '定期保养'
}

function formatStamp(date) {
  const d = date instanceof Date ? date : new Date(date)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ============================================================
// 八、撤销用的设备快照
// ============================================================

function snapshotEquipment(store, eq) {
  return {
    equipmentId: eq.id,
    equipment: { ...eq },
    records: JSON.parse(JSON.stringify(store.getMaintenanceByEquipmentId(eq.id) || [])),
    snapshots: JSON.parse(JSON.stringify(store.getSnapshots ? store.getSnapshots(eq.id) : []))
  }
}

function restoreEquipment(store, snapshot) {
  if (!snapshot) return
  const target = (store.equipmentList || []).find(e => String(e.id) === String(snapshot.equipmentId))
  if (target) Object.assign(target, snapshot.equipment)
  if (store.replaceMaintenanceRecords) {
    store.replaceMaintenanceRecords(snapshot.equipmentId, snapshot.records)
  }
  if (store.replaceHealthSnapshots) {
    store.replaceHealthSnapshots(snapshot.equipmentId, snapshot.snapshots)
  }
}

/** 供 UI 校验：计划里是否有会产生写入的项 */
export function hasWriteActions(plan) {
  return !!plan && plan.items.some(item => item.intent !== INTENTS.QUERY)
}

/**
 * 仅供自检/调试使用：暴露内部匹配函数。
 * 生产代码不要依赖这些下划线导出。
 */
export { matchForm as _matchForm, matchFormForIntent as _matchFormForIntent, buildPlanItems as _buildPlanItems }
