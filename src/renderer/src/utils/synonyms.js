/**
 * 矿山智工 - 维保术语同义词映射表
 *
 * 解决"用户口语说法命中不了知识库"的问题。
 * 例如用户说"漏油"，知识库里写的是"渗油"或"油封漏"——同义词展开后都能命中。
 *
 * 设计原则：
 *   - 只加高频现场口语，不做穷举
 *   - 每组有一个"主词"（知识库关键词里最常出现的那个），其他词映射到主词
 *   - 双向展开：搜"漏油"能匹配"渗油"，搜"渗油"也能匹配"漏油"
 */

/**
 * 同义词组：每组第一个为主词，其余为同义扩展
 * 搜索时，只要命中组内任意一个词，就自动扩展为整个组做匹配
 */
const SYNONYM_GROUPS = [
  // 液压系统
  ['漏油', '渗油', '跑冒滴漏', '油封漏', '密封漏', '漏液', '渗液'],
  ['压力偏低', '压力低', '压力不足', '油压低', '无力', '没劲', '动作慢'],
  ['油温高', '液压过热', '液压油温', '油温过高', '液压发热'],
  ['液压', '液压系统', '液压泵', '主泵', '先导', '溢流阀'],

  // 动力系统
  ['过热', '高温', '温度高', '水温高', '开锅', '热', '烫'],
  ['异响', '响声', '噪音', '噪声', '声异常', '杂音', '响', '声音大'],
  ['敲缸', '敲击', '金属声', '嗒嗒声', '哒哒'],
  ['发动机', '引擎', '柴油机', '内燃机'],

  // 制动系统
  ['刹车', '制动', '刹车片', '制动片', '制动器'],
  ['刹车失灵', '刹车不行', '刹不住', '制动失效', '刹车软'],
  ['刹车油', '制动液', '制动油'],

  // 行走机构
  ['轮胎', '胎', '胶轮', '轮子'],
  ['履带', '链条', '链轨', '四轮一带'],
  ['磨损', '磨耗', '磨', '损耗', '拉伤', '磨秃'],
  ['跑偏', '偏', '走偏', '偏磨'],

  // 钻机系统
  ['钻杆', '钻具', '钻管'],
  ['振动', '抖动', '震动', '晃动', '颤'],
  ['钻头', '牙轮', '截齿'],

  // 破碎设备
  ['破碎机', '圆锥破', '破碎', '碎石机'],
  ['衬板', '护板', '耐磨板'],

  // 保养维护
  ['保养', '维护', '维保', '检修', '检查', '维修'],
  ['换油', '更换机油', '换机油', '机油更换'],
  ['滤芯', '三滤', '滤网', '过滤器', '空滤', '机滤', '柴滤'],

  // 状态描述
  ['故障', '坏了', '趴窝', '不能用', '报错', '报警', '不工作', '停机'],
  ['漏气', '气漏', '漏风', '窜气'],
  ['堵塞', '堵了', '不通', '阻塞'],
  ['松动', '松了', '松旷', '间隙大'],

  // 设备类别口语
  ['挖掘机', '挖机', '挖土机', '反铲'],
  ['装载机', '铲车', '铲运机'],
  ['矿卡', '矿车', '自卸车', '卡车', '翻斗车'],
  ['钻机', '凿岩机', '潜孔钻'],
  ['压路机', '碾压机', '震动碾'],
  ['推土机', '推机'],
  ['平地机', '刮平机'],
]

/**
 * 构建反向索引：词 → 所在组的主词
 * 查询时先 normalize，再用这个 map 做同义词展开
 */
const _synonymIndex = new Map()

function normalizeWord(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, '')
}

for (const group of SYNONYM_GROUPS) {
  const primary = normalizeWord(group[0])
  for (const word of group) {
    const nw = normalizeWord(word)
    if (nw) _synonymIndex.set(nw, primary)
  }
}

/**
 * 获取一个词的所有同义词（含自身）
 * @param {string} word
 * @returns {string[]} 去重后的同义词数组
 */
export function getSynonyms(word) {
  const nw = normalizeWord(word)
  const primary = _synonymIndex.get(nw)
  if (!primary) return [word]

  // 找到该主词所在的组
  for (const group of SYNONYM_GROUPS) {
    if (normalizeWord(group[0]) === primary) {
      return group
    }
  }
  return [word]
}

/**
 * 对一段查询文本做同义词展开
 * 逐个提取文本中出现的同义词，返回扩展后的匹配词集合
 *
 * @param {string} queryText 用户原始输入
 * @returns {Set<string>} 展开后的同义词集合（已 normalize）
 */
export function expandQuery(queryText) {
  const q = normalizeWord(queryText)
  const expanded = new Set()

  // 1) 精确匹配：遍历索引，看文本中是否包含某个同义词
  for (const [word, primary] of _synonymIndex) {
    if (q.includes(word)) {
      // 找到这个词所在的组，把整组都加进去
      for (const group of SYNONYM_GROUPS) {
        if (normalizeWord(group[0]) === primary) {
          for (const w of group) expanded.add(normalizeWord(w))
          break
        }
      }
    }
  }

  return expanded
}

/**
 * 判断两段文本是否"语义相关"（同义词有交集）
 * @param {string} text1
 * @param {string} text2
 * @returns {boolean}
 */
export function isRelated(text1, text2) {
  const expanded1 = expandQuery(text1)
  const expanded2 = expandQuery(text2)
  if (expanded1.size === 0 && expanded2.size === 0) return false
  const norm2 = normalizeWord(text2)
  for (const word of expanded1) {
    if (norm2.includes(word)) return true
  }
  const norm1 = normalizeWord(text1)
  for (const word of expanded2) {
    if (norm1.includes(word)) return true
  }
  return false
}
