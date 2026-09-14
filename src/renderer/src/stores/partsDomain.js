/**
 * 矿山智工 - 备件台账领域逻辑（种子 / 匹配 / 出入库 / 联动扣减 / 缺料预警）
 *
 * 为什么单独成模块：
 *   appStore 之前把这些和工单、设备、健康、知识库全堆在一起，1300 多行。
 *   备件这一块边界其实很清楚：只碰 partsInventory / partTransactions 两个 ref，
 *   对外就是"按名字找件、加减库存、从一段文字里扣件"三件事。
 *
 * 依赖注入而不是第二份状态：ref 由 appStore 传进来，ref 还是那些 ref。
 *   persistAll 也由 appStore 传（它属于持久化层），这里只管改完内存后叫一声。
 */
import { computed } from 'vue'
import { now } from '../utils/dates'
import { PARTS_CATALOG } from '../utils/equipmentCatalog'

/**
 * 备件分类：只影响台账上的分组显示
 *
 * 库存水位刻意留出 3 项低于安全库存，让"缺料预警"有真实内容。
 */
const PART_CATEGORY = {
  '液压油46号': '润滑系统',
  机油滤芯: '动力系统',
  工程轮胎: '行走系统',
  刹车片: '行走系统',
  高锰钢衬板: '工作装置',
  斗齿: '工作装置',
  液压油管密封圈: '液压系统',
  耐水极压锂基脂: '润滑系统',
  液压油滤芯: '液压系统',
  空气滤芯: '动力系统',
  液压油缸密封件: '液压系统',
  发电机皮带: '动力系统',
  轮胎螺栓: '行走系统'
}

/** 计量单位：只有不是"件"的才要列出来 */
const PART_UNIT = {
  '液压油46号': '桶',
  耐水极压锂基脂: '桶',
  刹车片: '副',
  液压油缸密封件: '套'
}

/**
 * 现场常见叫法 → 台账标准名
 *
 * 只收"同一种东西的不同写法"。不把"机油"映射成"机油滤芯"、
 * 不把"液压油缸密封件"映射成"液压油管密封圈"——那是两种不同零件，
 * 硬凑匹配会让库存账目错得看不出错。对不上的配件一律如实上报"台账无此件"。
 */
const PART_ALIASES = {
  刹车摩擦片: '刹车片',
  闸片: '刹车片',
  制动片: '刹车片',
  液压油密封圈: '液压油管密封圈',
  液压油: '液压油46号',
  液压油46: '液压油46号',
  锂基脂: '耐水极压锂基脂',
  润滑脂: '耐水极压锂基脂'
}

/**
 * 相对安全库存的水位偏移
 *
 * 期初水位按"近 30 天演示维保记录的领用量"留足余量：回冲之后既要有几项
 * 落到安全库存以下（缺料预警页才有内容），又不能有哪一项被扣到 0——
 * 库存为 0 会让演示中的后续领用全部走"超领"分支，页面看着像坏了。
 */
const STOCK_OFFSET = {
  '液压油46号': 9,
  机油滤芯: 6,
  工程轮胎: 6,
  刹车片: 2,
  高锰钢衬板: -1,
  斗齿: 5,
  液压油管密封圈: -8,
  耐水极压锂基脂: 3,
  液压油滤芯: 5,
  空气滤芯: 4
}

export function createPartsDomain(ctx) {
  const { partsInventory, partTransactions, persistAll } = ctx

  /**
   * 备件台账种子：直接由 PARTS_CATALOG 派生
   *
   * ⚠️ 以前这里是另写一份清单（"制动片/轮胎螺栓/液压油缸密封件"），
   * 与维保记录用的 PARTS_CATALOG（"刹车片/工程轮胎/液压油管密封圈"）各写各的，
   * 记录里的配件只有 2 种能在库存里找到，演示时"填了配件却不扣库存"，
   * 备件联动链路看着就是坏的。现在单一来源，件名天然对齐。
   */
  function partsSeed() {
    const stamp = now()
    return PARTS_CATALOG.map((p, i) => ({
      id: i + 1,
      name: p.name,
      category: PART_CATEGORY[p.name] || '其他',
      stock: Math.max(1, Number(p.minStock) + (STOCK_OFFSET[p.name] ?? 3)),
      safety_stock: Number(p.minStock) || 0,
      unit_price: Number(p.price) || 0,
      unit: PART_UNIT[p.name] || '件',
      updatedAt: stamp
    }))
  }

  const nextPartId = computed(() => {
    const maxId = partsInventory.value.reduce((max, p) => Math.max(max, Number(p.id) || 0), 0)
    return maxId + 1
  })

  const nextPartTxId = computed(() => {
    const maxId = partTransactions.value.reduce((max, t) => Math.max(max, Number(t.id) || 0), 0)
    return maxId + 1
  })

  /**
   * 按名字找备件：精确 → 别名 → 唯一包含匹配
   *
   * 三级都命不中时返回 null（调用方必须把"对不上"如实报出来，
   * 而不是当作"这件没用到"悄悄跳过）。包含匹配只在唯一命中时采信，
   * 命中多件（如"滤芯"同时匹配到机油/空气/液压油滤芯）一律不猜。
   */
  function getPartByName(name) {
    const clean = String(name || '').trim()
    if (!clean) return null
    const exact = partsInventory.value.find(p => p.name === clean)
    if (exact) return exact
    const alias = PART_ALIASES[clean]
    if (alias) {
      const hit = partsInventory.value.find(p => p.name === alias)
      if (hit) return hit
    }
    const loose = partsInventory.value.filter(p => p.name.includes(clean) || clean.includes(p.name))
    return loose.length === 1 ? loose[0] : null
  }

  /**
   * 调整库存（delta 可为正入库 / 负出库），并记流水
   *
   * `silent: true` 只改内存、不落盘，供批量场景用。
   * 为什么要这个开关：`consumePartsFromText` 对每个配件调用一次本函数，
   * 而首启的 `replayRecentPartUsage` 会把近 30 天的记录全部回冲一遍 ——
   * 实测 34 个配件名 = 34 次 persistAll（每次都是「DELETE 10 张表 + 全量
   * re-INSERT」），约 0.4 s 的纯冗余工作，全部发生在首屏挂载之前。
   * 批量调用方负责在循环结束后统一落盘一次。
   */
  function adjustPartStock(partId, delta, { type = 'in', refType = '', refId = null, note = '', silent = false } = {}) {
    const part = partsInventory.value.find(p => p.id === partId)
    if (!part) return null
    part.stock = Math.max(0, Number(part.stock) + Number(delta))
    part.updatedAt = now()
    if (Number(delta) !== 0) {
      partTransactions.value.unshift({
        id: nextPartTxId.value,
        part_id: part.id,
        type: Number(delta) > 0 ? 'in' : 'out',
        quantity: Math.abs(Number(delta)),
        ref_type: type === 'in' ? (refType || 'manual') : refType,
        ref_id: refId,
        note,
        createdAt: now()
      })
    }
    if (!silent) persistAll()
    return part
  }

  /** 入库 */
  function restockPart(partId, quantity, note = '手动入库') {
    return adjustPartStock(partId, Number(quantity), { type: 'in', note })
  }

  /** 出库 */
  function issuePart(partId, quantity, note = '手动出库') {
    return adjustPartStock(partId, -Number(quantity), { type: 'out', note })
  }

  function addPart(item) {
    const record = {
      id: nextPartId.value,
      name: String(item.name || '').trim(),
      category: item.category || '其他',
      stock: Number(item.stock) || 0,
      safety_stock: Number(item.safety_stock) || 0,
      unit_price: Number(item.unit_price) || 0,
      unit: item.unit || '件',
      updatedAt: now()
    }
    if (!record.name) return null
    partsInventory.value.push(record)
    persistAll()
    return record
  }

  /**
   * 备件联动：从一段文本（如维保记录的"配件"字段，逗号/顿号分隔）逐个匹配备件名并扣减库存
   * 用于"维保/维修记录填配件 → 台账自动扣减 → 缺料预警"
   *
   * 返回值是明细而不是一个数字：对不上台账的配件、库存为 0 的配件都必须能被上层看见。
   * 之前这里对这两种情况都是静默 `continue`——记录里明明白白写着换了件，
   * 库存却分文未动，界面上也没有任何提示，账实不符却查不出原因。
   *
   * @param {object} [opts]
   * @param {boolean} [opts.silent] 只改内存不落盘（批量调用方需自行在末尾落盘一次）
   * @returns {{ consumed: number, matched: string[], unmatched: string[], short: string[] }}
   */
  function consumePartsFromText(text, refType, refId, { silent = false } = {}) {
    const result = { consumed: 0, matched: [], unmatched: [], short: [] }
    if (!text) return result
    const names = String(text)
      .split(/[,，、;；/]/)
      .map(s => s.trim())
      .filter(Boolean)
    for (const name of names) {
      const part = getPartByName(name)
      if (!part) { result.unmatched.push(name); continue }
      if (Number(part.stock) <= 0) { result.short.push(part.name); continue }
      // silent 透传给 adjustPartStock：批量回冲时由调用方统一落盘一次
      adjustPartStock(part.id, -1, { type: 'out', refType, refId, note: `维保/维修领用（${refType} #${refId}）`, silent })
      result.consumed++
      result.matched.push(part.name)
    }
    return result
  }

  /** 缺料预警：库存 ≤ 安全库存 */
  const lowStockParts = computed(() =>
    partsInventory.value
      .filter(p => Number(p.stock) <= Number(p.safety_stock))
      .sort((a, b) => a.stock - b.stock)
  )

  return {
    partsSeed,
    getPartByName,
    adjustPartStock,
    restockPart,
    issuePart,
    addPart,
    consumePartsFromText,
    lowStockParts
  }
}
