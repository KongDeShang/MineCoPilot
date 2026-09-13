/**
 * 矿山智工 - 口述指代消解覆盖率自检
 *
 * 用途：回答一个具体问题——**在实际口吻里，哪些说法能被唯一确定，哪些会需要回问用户？**
 *
 * 为什么单独成脚本而不是塞进 self-check：
 *   self-check 断言的是"给定输入必须得到给定结果"（行为正确性）；
 *   这里断言的是"覆盖率的底线"（能力广度）。改动解析器或词表后，这里能立刻看出
 *   是否有一类说法整体失守——上一轮就是靠它发现"类别俗称（挖机/铲车/卡车）全军覆没"。
 *
 * 退出码：0 全部达标；1 有底线未达标（可用于 CI / npm run coverage）
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const srcDir = join(root, 'src', 'renderer', 'src', 'utils')
const md = join(root, '.tmp-measure')
rmSync(md, { recursive: true, force: true })
mkdirSync(md, { recursive: true })
for (const n of ['dates', 'health', 'equipmentCatalog', 'fleetData', 'nlCommand']) {
  writeFileSync(join(md, `${n}.mjs`),
    readFileSync(join(srcDir, `${n}.js`), 'utf8')
      .replace(/(from\s+['"]\.\/[a-zA-Z0-9_-]+)(['"])/g, '$1.mjs$2'), 'utf8')
}
const fleet = await import(pathToFileURL(join(md, 'fleetData.mjs')).href)
const nl = await import(pathToFileURL(join(md, 'nlCommand.mjs')).href)

const dataset = fleet.buildDemoDataset({ size: 60 })
const list = dataset.equipment
const store = { equipmentList: list, workOrders: dataset.workOrders, getMaintenanceByEquipmentId: () => [], getSnapshots: () => [] }

// 台账构成
const byCategory = {}
const byModel = {}
for (const eq of list) {
  byCategory[eq.category] = (byCategory[eq.category] || 0) + 1
  byModel[eq.model] = (byModel[eq.model] || 0) + 1
}
console.log('=== 台账构成 ===')
console.log('按类别：', Object.entries(byCategory).map(([k, v]) => `${k} ${v}`).join(' / '))
console.log('按型号：', Object.entries(byModel).map(([k, v]) => `${k} ${v}`).join(' / '))

// 构造"现场真实口吻"的句子集合
const phrases = []
const samples = list.slice(0, 60)
// 1. 类别 + 序号（最常见的说法）
for (const eq of samples.slice(0, 12)) {
  const seq = eq.name.match(/-(\d+)$/)?.[1]
  phrases.push({ text: `${Number(seq)}号${eq.category}液压油压力偏低`, kind: '类别+序号', expect: eq.name })
}
// 2. 只报型号（师傅常省略序号）
for (const model of Object.keys(byModel)) {
  phrases.push({ text: `${model.replace(/^徐工\s*/, '')}水温高了`, kind: '仅型号', model })
}
// 3. 只报类别
for (const cat of Object.keys(byCategory)) {
  phrases.push({ text: `${cat}坏了`, kind: '仅类别', category: cat })
}
// 4. 全名（从台账复制粘贴/复述）
for (const eq of samples.slice(0, 5)) {
  phrases.push({ text: `${eq.name}履带脱轨了`, kind: '全名', expect: eq.name })
}

const stats = {}
const detail = []
for (const p of phrases) {
  const plan = nl.parseCommand(store, p.text, { now: new Date('2026-09-12') })
  const status = plan.items[0]?.equipmentRef?.status || (plan.ok ? 'no-ref' : 'no-intent')
  const resolved = status === 'resolved'
  stats[p.kind] ||= { total: 0, resolved: 0, ambiguous: 0, notFound: 0 }
  stats[p.kind].total++
  if (resolved) stats[p.kind].resolved++
  else if (status === 'ambiguous') stats[p.kind].ambiguous++
  else stats[p.kind].notFound++
  detail.push({ ...p, status, picked: plan.items[0]?.equipment?.name || '-', candidates: plan.ambiguous[0]?.candidates.length || 0 })
}

console.log('\n=== 各类说法的指代命中率 ===')
for (const [kind, s] of Object.entries(stats)) {
  const rate = Math.round((s.resolved / s.total) * 100)
  console.log(`  ${kind.padEnd(10)} 共 ${String(s.total).padStart(2)} 句：唯一命中 ${s.resolved}，需回问 ${s.ambiguous}，未找到 ${s.notFound} → 命中率 ${rate}%`)
}

console.log('\n=== 需要回问的具体句子（这些才是别名功能要解决的）===')
for (const d of detail.filter(x => x.status === 'ambiguous')) {
  console.log(`  「${d.text}」→ ${d.candidates} 台候选（${d.kind}）`)
}

console.log('\n=== 完全找不到的句子 ===')
for (const d of detail.filter(x => x.status === 'notFound' || x.status === 'no-intent')) {
  console.log(`  「${d.text}」→ ${d.status}（${d.kind}）`)
}

const overall = detail.filter(d => d.status === 'resolved').length
const overallRate = Math.round((overall / detail.length) * 100)
console.log(`\n总命中率：${overall}/${detail.length} = ${overallRate}%`)

// ============================================================
// 覆盖率底线断言（回归保护）
// ============================================================
const failures = []

// 底线 1：类别 + 序号 必须 100%（这是现场最常说、也最该稳的说法）
const seqKind = stats['类别+序号']
if (!seqKind || seqKind.resolved !== seqKind.total) {
  failures.push(`「类别+序号」命中率跌破 100%（${seqKind ? seqKind.resolved + '/' + seqKind.total : '无样本'}）`)
}

// 底线 2：全名必须 100%（复述台账名是最可靠的指代方式）
const nameKind = stats['全名']
if (!nameKind || nameKind.resolved !== nameKind.total) {
  failures.push(`「全名」命中率跌破 100%（${nameKind ? nameKind.resolved + '/' + nameKind.total : '无样本'}）`)
}

// 底线 3：仅型号/仅类别允许需回问，但**不允许出现"未找到"**——
// 那是解析器的失败；回问是正确行为，找不到设备则是能力缺口。
for (const kind of ['仅型号', '仅类别']) {
  const s = stats[kind]
  if (s && s.notFound > 0) failures.push(`「${kind}」出现 ${s.notFound} 句"未找到"（应至少能给出候选）`)
}

// 底线 4：总命中率不低于当前基线（低于即说明某类说法整体退化）
const BASELINE = 41
if (overallRate < BASELINE) {
  failures.push(`总命中率 ${overallRate}% 低于基线 ${BASELINE}%`)
}

console.log('\n=== 覆盖率底线检查 ===')
if (failures.length) {
  for (const f of failures) console.log(`FAIL  ${f}`)
  console.log(`\n覆盖率自检未通过：${failures.length} 项底线被突破`)
  process.exitCode = 1
} else {
  console.log(`PASS  类别+序号 ${seqKind.resolved}/${seqKind.total}、全名 ${nameKind.resolved}/${nameKind.total} 保持 100%`)
  console.log(`PASS  仅型号/仅类别未出现"未找到"（回问是预期行为，不是缺陷）`)
  console.log(`PASS  总命中率 ${overallRate}% ≥ 基线 ${BASELINE}%`)
  console.log('\n覆盖率自检通过')
}

rmSync(md, { recursive: true, force: true })
