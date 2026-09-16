/**
 * 矿山智工 - 症状→原因→处理 三元组挖掘（任务 17 Batch B2）
 *
 * 现有知识库检索靠"关键词"命中（keywords 数组）。但一线提问常是**现象描述**：
 * "机器干活没劲还抖"里没有"液压""钻杆"这类关键词，现有检索会落空。
 * 本模块补一条**症状文本匹配**通道：把问题拆成 2 字滑窗，与知识条目的
 * symptoms 文本比对，命中即返回该条目的"症状→原因→处理"三元组，并带来源。
 *
 * 铁律：三元组全部来自知识库条目原文（symptoms/causes/steps/source），
 * 本模块只做匹配与结构化，不新增任何原因、步骤或数值。
 */

import { normalize } from './knowledgeBase'

/** 2 字去重滑窗（与 knowledgeBase 内部同款，条目原文匹配用） */
function queryGrams(q) {
  const grams = []
  const seen = new Set()
  for (let i = 0; i + 2 <= q.length; i++) {
    const g = q.slice(i, i + 2)
    if (seen.has(g)) continue
    seen.add(g)
    grams.push(g)
  }
  return grams
}

/**
 * 症状文本匹配：问题滑窗与条目 symptoms 的命中度（0~1）
 * 阈值刻意保守——至少命中 2 个不同滑窗才算"现象描述对上了"，避免泛词误报。
 * @param {string} question
 * @param {Array} items 知识条目（store.knowledgeItems 或内置 KNOWLEDGE_BASE）
 * @returns {Array<{entry, symptomScore, matchedBy:'symptom'|'keyword', score}>} 按匹配度排序
 */
export function matchFaultTriplet(question, items = []) {
  const source = Array.isArray(items) && items.length ? items : []
  const q = normalize(question)
  if (!q || !source.length) return []

  const grams = queryGrams(q)
  const scored = []
  for (const entry of source) {
    const symText = normalize(entry.symptoms || '')
    let symptomHits = 0
    for (const g of grams) {
      if (symText.includes(g)) symptomHits++
    }
    if (symptomHits >= 2) {
      scored.push({
        entry,
        matchedBy: 'symptom',
        symptomScore: symptomHits / Math.min(grams.length, 6),
        score: 6 + symptomHits // 症状命中给基础分，命中越多越高
      })
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(item => ({
      ...item,
      triplet: buildTriplet(item.entry)
    }))
}

/**
 * 从知识条目提取"症状→原因→处理"三元组
 * 全部取自条目原文；条目可能缺某个字段（用户自建条目），缺则如实留空
 * @returns {{ title, symptom, causes: string[], steps: string[], source, caveat }}
 */
export function buildTriplet(entry) {
  return {
    title: entry.title || '',
    symptom: entry.symptoms || '',
    causes: Array.isArray(entry.causes) ? entry.causes : [],
    steps: Array.isArray(entry.steps) ? entry.steps : [],
    source: entry.source || '',
    caveat: entry.caveat || ''
  }
}

/**
 * 渲染"老师傅经验卡"（三元组结构化展示，带来源）
 * 顶部给一句老师傅引导语（纯语气包装，不新增事实）；中部三元组；底部来源。
 * @param {object} triplet buildTriplet 的返回
 * @param {string} [lead] 老师傅引导语（默认给一句通用引导）
 */
export function renderTripletCard(triplet, lead) {
  const causes = (triplet.causes || []).map(c => `<li>${c}</li>`).join('')
  const steps = (triplet.steps || []).map(s => `<li>${s}</li>`).join('')
  return [
    `<div style="margin-bottom:8px;padding:8px 12px;background:var(--accent-soft);border-radius:6px;font-size:13px;color:var(--accent)">`,
    `<strong>老师傅经验：</strong>${lead || '按经验，先对现象、再查原因、后动手，别上来就拆。'}`,
    `</div>`,
    `<strong>${triplet.title || '设备故障排查'}</strong>`,
    `<div style="margin:6px 0 10px;color:var(--text-3);font-size:12px">分类经验卡 · 症状 → 原因 → 处理</div>`,
    triplet.symptom
      ? `<div style="margin-bottom:6px"><strong>典型现象：</strong>${triplet.symptom}</div>`
      : '',
    causes
      ? `<div style="margin:8px 0 4px"><strong>可能原因</strong></div><ul style="margin:0;padding-left:18px">${causes}</ul>`
      : '',
    steps
      ? `<div style="margin:10px 0 4px"><strong>处理步骤</strong></div><ol style="margin:0;padding-left:18px">${steps}</ol>`
      : '',
    triplet.caveat
      ? `<div style="margin-top:10px;padding:6px 10px;background:var(--amber-soft);border-radius:6px;color:var(--warn-ink);font-size:12px">口径说明：${triplet.caveat}</div>`
      : '',
    triplet.source
      ? `<div style="margin-top:8px;color:var(--text-3);font-size:12px">※ 来源：${triplet.source}</div>`
      : ''
  ].filter(Boolean).join('')
}

/** 三元组的来源引用（供 refs 展示） */
export function tripletRefs(triplet) {
  const refs = []
  if (triplet.title) refs.push(`《${triplet.title}》`)
  if (triplet.source) refs.push(`来源：${triplet.source}`)
  return refs
}
