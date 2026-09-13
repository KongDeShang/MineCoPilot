/**
 * 矿山智工 - 在管设备机型目录
 *
 * 用途：
 *   1) 演示数据工厂的机型来源（保证演示台账里的型号公开可查、品类正确）
 *   2) 自检断言的白名单（防止后续手改数据时写错品类）
 *
 * 两条硬约束（对应改造文档 §风险清单）：
 *   · 品类必须对——挖掘机型号不能出现在破碎机行上（v1 曾把压路机写成破碎机）
 *   · 吨位与业务场景自洽——中小矿不配 240t 电传动矿卡
 *
 * 品牌口径：徐工为主（约 87%），保留少量他牌设备以体现"在管设备不挑品牌"，
 * 真实矿山车队本来就是混编的。
 */

/** 型号白名单：model → { brand, category } */
export const MODEL_WHITELIST = {
  // —— 徐工 挖掘机（XE 系列）——
  '徐工 XE215C': { brand: '徐工', category: '挖掘机' },
  '徐工 XE370C': { brand: '徐工', category: '挖掘机' },
  '徐工 XE490': { brand: '徐工', category: '挖掘机' },
  // —— 徐工 装载机（LW 系列）——
  '徐工 LW300FN': { brand: '徐工', category: '装载机' },
  '徐工 LW500KN': { brand: '徐工', category: '装载机' },
  // —— 徐工 矿用自卸车（XDA 铰接 / XDE 刚性）——
  '徐工 XDA45': { brand: '徐工', category: '矿卡' },
  '徐工 XDE130': { brand: '徐工', category: '矿卡' },
  // —— 徐工 露天钻机（XKY 牙轮 / 潜孔）——
  '徐工 XKY120': { brand: '徐工', category: '钻机' },
  '徐工 XQZ120': { brand: '徐工', category: '钻机' },
  // —— 徐工 破碎设备（XGY 圆锥破 / XPY 移动破碎站）——
  '徐工 XGY1500': { brand: '徐工', category: '破碎机' },
  '徐工 XPY1100': { brand: '徐工', category: '破碎机' },
  // —— 徐工 辅助设备（XS 压路机 / 平地机 / 推土机）——
  '徐工 XS223J': { brand: '徐工', category: '压路机' },
  '徐工 GR180': { brand: '徐工', category: '平地机' },
  '徐工 SD16': { brand: '徐工', category: '推土机' },
  // —— 他牌设备：证明系统不挑品牌 ——
  '小松 PC200-8': { brand: '小松', category: '挖掘机' },
  '卡特彼勒 320D': { brand: '卡特彼勒', category: '挖掘机' }
}

/** 型号 → 类别（未登记型号返回 null，供断言捕获） */
export function categoryOfModel(model) {
  const hit = MODEL_WHITELIST[model]
  return hit ? hit.category : null
}

export function brandOfModel(model) {
  const hit = MODEL_WHITELIST[model]
  return hit ? hit.brand : null
}

/**
 * 车队构成（按真实矿山保有量的粗略比例，总权重 100）
 * serviceMonths 用于推算"上次维保"的合理区间
 */
export const FLEET_MIX = [
  {
    category: '挖掘机',
    weight: 24,
    cycle: 90,
    models: ['徐工 XE215C', '徐工 XE370C', '徐工 XE490', '小松 PC200-8', '卡特彼勒 320D'],
    // 他牌设备出现概率较低
    rareModels: ['小松 PC200-8', '卡特彼勒 320D'],
    serviceMonths: [4, 9],
    locationHint: '采剥区'
  },
  {
    category: '矿卡',
    weight: 20,
    cycle: 30,
    models: ['徐工 XDA45', '徐工 XDE130'],
    serviceMonths: [2, 7],
    locationHint: '运输干线'
  },
  {
    category: '装载机',
    weight: 14,
    cycle: 60,
    models: ['徐工 LW500KN', '徐工 LW300FN'],
    serviceMonths: [3, 8],
    locationHint: '装载区'
  },
  {
    category: '钻机',
    weight: 10,
    cycle: 60,
    models: ['徐工 XKY120', '徐工 XQZ120'],
    serviceMonths: [4, 10],
    locationHint: '爆破区'
  },
  {
    category: '破碎机',
    weight: 8,
    cycle: 90,
    models: ['徐工 XGY1500', '徐工 XPY1100'],
    serviceMonths: [5, 12],
    locationHint: '破碎站'
  },
  {
    category: '压路机',
    weight: 8,
    cycle: 120,
    models: ['徐工 XS223J'],
    serviceMonths: [6, 14],
    locationHint: '道路维护'
  },
  {
    category: '平地机',
    weight: 8,
    cycle: 120,
    models: ['徐工 GR180'],
    serviceMonths: [6, 14],
    locationHint: '道路维护'
  },
  {
    category: '推土机',
    weight: 8,
    cycle: 90,
    models: ['徐工 SD16'],
    serviceMonths: [5, 12],
    locationHint: '排土场'
  }
]

/** 矿区（避免编造真实客户名） */
export const MINE_LOCATIONS = ['云南××矿区', '内蒙古××矿区', '山西××矿区']

/**
 * 故障现象库：按系统分类，用于生成工单与维保记录
 * system 字段与 Dashboard「高频故障 TOP」的分类口径一致
 */
export const FAULT_LIBRARY = {
  液压系统: {
    weight: 26,
    items: [
      { title: '液压油压力偏低，动作无力', desc: '巡检发现液压系统压力低于额定值，工作装置动作缓慢' },
      { title: '液压油温过高', desc: '连续作业 2 小时后油温报警，怀疑散热器堵塞' },
      { title: '液压油管渗漏', desc: '动臂油缸油管接头处渗油，地面有油迹' },
      { title: '主泵异响', desc: '主液压泵工作时发出异常噪音，压力波动' },
      { title: '回转马达渗油', desc: '回转马达下方有油污，动作时有顿挫感' }
    ]
  },
  动力系统: {
    weight: 22,
    items: [
      { title: '发动机水温偏高', desc: '水温表超过正常值，散热器外部积尘严重' },
      { title: '发动机异响', desc: '怠速时有轻微敲击声，需检查气门间隙' },
      { title: '排气管冒黑烟', desc: '加速时排气管冒黑烟，怀疑喷油器雾化不良' },
      { title: '机油压力报警', desc: '机油压力低于正常范围，需检查油位与机油泵' },
      { title: '风扇皮带打滑', desc: '风扇皮带出现异响并伴有打滑现象' }
    ]
  },
  电气系统: {
    weight: 16,
    items: [
      { title: '启动困难', desc: '冷车启动困难，怀疑电瓶电量不足' },
      { title: '仪表报警', desc: '仪表盘出现间歇性报警提示，线路接触不良' },
      { title: '空调不制冷', desc: '驾驶室空调制冷效果差，需检查压缩机与冷媒' },
      { title: '传感器信号异常', desc: '水温传感器信号跳变，导致误报警' }
    ]
  },
  底盘行走: {
    weight: 22,
    items: [
      { title: '履带张紧度异常', desc: '履带下垂量超过标准值，行走时有跳齿现象' },
      { title: '轮胎异常磨损', desc: '右前轮胎面偏磨严重，需检查气压与定位' },
      { title: '刹车片磨损', desc: '制动片厚度接近极限，制动距离变长' },
      { title: '变速箱油温偏高', desc: '连续作业后变速箱油温报警，需检查油位与散热' },
      { title: '支重轮漏油', desc: '左侧支重轮漏油，行走时有异响' }
    ]
  },
  其他: {
    weight: 14,
    items: [
      { title: '驾驶室玻璃破损', desc: '驾驶室前挡风玻璃出现裂纹，需更换' },
      { title: '结构件焊缝开裂', desc: '动臂根部焊缝出现细微裂纹，需补焊处理' },
      { title: '照明灯具失效', desc: '作业照明灯不亮，夜间作业受限' },
      { title: '保养超期处理', desc: '定期保养已超期，需尽快安排保养' }
    ]
  }
}

/**
 * 维保记录（非故障类）内容库
 *
 * `parts` 是给人看的项目描述（可带规格、数量）；`partNames` 是**可对账的标准件名**，
 * 必须命中 PARTS_CATALOG。两者必须分开：
 * 备件库存靠件名匹配才能扣减，而"机油+三滤套装""防冻液 -35°C"这类描述
 * 与库存标准名对不上，会让"记录里写了换件、库存却分文未动"的链路静默失效。
 */
export const MAINTENANCE_LIBRARY = [
  { type: '定期保养', desc: '更换发动机机油、机滤、空滤', parts: '机油+三滤套装', partNames: ['机油滤芯', '空气滤芯'] },
  { type: '定期保养', desc: '更换液压油及液压油滤芯', parts: '液压油46号 200L', partNames: ['液压油46号', '液压油滤芯'] },
  { type: '定期保养', desc: '更换变速箱油，检查传动系统', parts: '变速箱油', partNames: [] },
  { type: '定期保养', desc: '全车集中润滑，各铰点加注润滑脂', parts: '耐水极压锂基脂', partNames: ['耐水极压锂基脂'] },
  { type: '定期保养', desc: '2000 小时大保养，全车油液与滤芯更换', parts: '全车油液+滤芯', partNames: ['液压油46号', '机油滤芯', '空气滤芯'] },
  { type: '定期保养', desc: '冷却系统保养，更换防冻液', parts: '防冻液 -35°C', partNames: [] },
  { type: '部件更换', desc: '更换高锰钢衬板，检查破碎腔', parts: '高锰钢衬板 1套', partNames: ['高锰钢衬板'] },
  { type: '部件更换', desc: '更换工程轮胎，四轮定位检查', parts: '工程轮胎 2条', partNames: ['工程轮胎'] },
  { type: '部件更换', desc: '更换斗齿与销轴，检查工作装置间隙', parts: '斗齿+销轴', partNames: ['斗齿'] },
  { type: '部件更换', desc: '更换刹车片，检查制动系统', parts: '刹车片 1 副', partNames: ['刹车片'] },
  { type: '巡检', desc: '日常班检：液位、渗漏、异响、仪表报警', parts: '', partNames: [] },
  { type: '巡检', desc: '专项巡检：制动系统与转向系统', parts: '', partNames: [] }
]

/**
 * 配件目录（单一来源）
 *
 * 既是维保记录里可领用的件名清单，也是备件库存的种子与成本估算依据。
 * 两处共用一份数据，才能保证"记录填的件名 = 库存里的件名"。
 */
export const PARTS_CATALOG = [
  { name: '液压油46号', spec: '200L/桶', price: 1850, minStock: 5 },
  { name: '机油滤芯', spec: '通用', price: 280, minStock: 10 },
  { name: '工程轮胎', spec: '23.5R25', price: 12000, minStock: 4 },
  { name: '刹车片', spec: '通用', price: 4500, minStock: 4 },
  { name: '高锰钢衬板', spec: '圆锥破专用', price: 28000, minStock: 2 },
  { name: '斗齿', spec: '通用', price: 1200, minStock: 12 },
  { name: '液压油管密封圈', spec: '通用', price: 320, minStock: 20 },
  { name: '耐水极压锂基脂', spec: '15kg/桶', price: 460, minStock: 8 },
  { name: '液压油滤芯', spec: '通用', price: 85, minStock: 8 },
  { name: '空气滤芯', spec: '通用', price: 60, minStock: 8 },
  { name: '液压油缸密封件', spec: '通用', price: 95, minStock: 5 },
  { name: '发电机皮带', spec: '通用', price: 68, minStock: 4 },
  { name: '轮胎螺栓', spec: '通用', price: 8, minStock: 20 }
]

/** 按件名查目录条目（未收录返回 null，调用方需如实标注"无单价"） */
export function findPartSpec(name) {
  const clean = String(name || '').trim()
  return PARTS_CATALOG.find(p => p.name === clean) || null
}

/** 一组件名的合计成本（未收录的件名按 0 计，并由 hasUnknown 标出） */
export function partsCost(names = []) {
  let cost = 0
  let hasUnknown = false
  for (const name of names) {
    const spec = findPartSpec(name)
    if (spec) cost += Number(spec.price) || 0
    else hasUnknown = true
  }
  return { cost, hasUnknown }
}

/** 维保人员 */
export const TECHNICIANS = ['张工', '李工', '王工', '赵工', '钱工', '孙工']
