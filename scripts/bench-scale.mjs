/**
 * 矿山智工 - 单机规模压测（scripts/bench-scale.mjs）
 *
 * 为什么要有这个脚本（docs/完善计划.md P2-5）：
 *   `scripts/` 下此前**没有任何性能基座** —— 十套验收脚本全是"对/不对"的断言，
 *   没有一条回答"5000 台设备、5 万条维保记录时它还转得动吗"。
 *   后果是 P2-3（检索性能）只能凭读代码猜：`answerItems` 每次提问重建整个检索池，
 *   但重建一池子到底花 3 毫秒还是 300 毫秒，没人量过。
 *
 * 为什么**不进** `npm run verify` 门禁：
 *   它是耗时测量，不是断言。机器繁忙、后台在跑别的脚本都会让数字抖动，
 *   偶发的性能抖动不该让整条验收链变红（#28 那条教训的另一面：会偶发失败的门禁
 *   比没有门禁更糟，它教人"重跑一次就好了"）。单独一个 npm 目标：
 *
 *     npm run bench:scale
 *     npm run bench:scale -- --devices=20000 --records=200000 --repeat=3
 *
 * 做法与 `scripts/store-check.mjs` 同源：把 `utils/` 与 `stores/` 整棵目录镜像成
 * `.mjs`，用桩掉的 localStorage / sql.js 在 Node 里**真正装配 store**，
 * 然后走**真实写入路径**灌数据 —— 不是造一个假的 benchmark 数据模型。
 *
 * 量的是哪四件事（对应 P2-5 的要求：首启 / 落盘 / 看板 / 检索）：
 *   1. 首启      空库首次装配（含播种 60 台）
 *   2. 批量灌数   `addEquipment(silent)` + `addMaintenanceRecord(silent)` 的逐条成本
 *   3. 落盘       内存整库重写（persistAll）+ 真实写盘（saveNow）
 *   4. 满库首启   关掉再打开：5000 台 + 5 万条从 SQLite 回到 JS
 *   5. 看板       健康分/分档/超期/预警这一串 computed 的重算
 *   6. 检索       检索池重建 + 一次提问（P2-3 的取值依据）
 *
 * ⚠️ 一条压测特有的假绿陷阱：Pinia/Vue 的 computed **有缓存**，
 *    `store.equipmentWithHealth` 连读两次，第二次是 0 毫秒 —— 什么都不测，
 *    但打印出来是"很快"。所以下面每个场景都**先碰一下数据**让缓存失效，
 *    再读那一串 computed。碰的是与判据无关的字段（见 touch* 函数），
 *    免得把"测量动作"混进"被测成本"。
 */
import initSqlJsImport from 'sql.js'
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const rendererSrc = join(root, 'src', 'renderer', 'src')
const mirrorDir = join(root, '.tmp-benchscale')

// ---------------------------------------------------------------------------
// 规模参数（默认值 = docs/完善计划.md P2-5 定的 5000 台 / 5 万条）
// ---------------------------------------------------------------------------
function argOf(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  if (!hit) return dflt
  const v = Number(hit.split('=')[1])
  return Number.isFinite(v) && v > 0 ? v : dflt
}
const DEVICES = argOf('devices', 5000)
const RECORDS = argOf('records', 50000)
/**
 * 手册语料与设备台数**无关**：检索池的第二半是"每本手册的全部切片"，
 * 它随导入的手册增长（随包 3 本 86 页；《资料/》里 XGT7528A、XE230_XE250C 都 200 页以上，
 * 入库上限 CHUNK_LIMIT = 300）。所以这里按 8 本 × 300 片构造语料，
 * **这是构造值，不是现场实测值** —— 现场手册多少本只有用户知道，写进文档时要注明。
 */
const MANUALS = argOf('manuals', 8)
const CHUNKS = argOf('chunks', 300)
const REPEAT = argOf('repeat', 5)

// ---------------------------------------------------------------------------
// 一、生成 ESM 镜像（与 store-check.mjs 同一套做法，见那边的注释）
// ---------------------------------------------------------------------------
function rewrite(code) {
  const addExt = (spec) => {
    if (spec.startsWith('.') && !/\.[a-z0-9]+$/i.test(spec)) return `${spec}.mjs`
    return spec
  }
  return code
    .replace(/(from\s+['"])(\.[^'"]+)(['"])/g, (_m, a, spec, c) => a + addExt(spec) + c)
    .replace(/(import\(\s*['"])(\.[^'"]+)(['"]\s*\))/g, (_m, a, spec, c) => a + addExt(spec) + c)
    .replace(/docService\.mjs/g, 'docService/index.mjs')
}
function mirrorTree(relDir) {
  const from = join(rendererSrc, relDir)
  const to = join(mirrorDir, relDir)
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from)) {
    const src = join(from, entry)
    if (statSync(src).isDirectory()) {
      mirrorTree(join(relDir, entry))
      continue
    }
    if (!entry.endsWith('.js')) continue
    writeFileSync(join(to, entry.replace(/\.js$/, '.mjs')), rewrite(readFileSync(src, 'utf8')), 'utf8')
  }
}
rmSync(mirrorDir, { recursive: true, force: true })
mkdirSync(mirrorDir, { recursive: true })
try {
  mirrorTree('utils')
  mirrorTree('stores')
} catch (error) {
  console.error('❌ 生成镜像失败：', error)
  process.exit(1)
}
const mirror = (rel) => pathToFileURL(join(mirrorDir, rel)).href

// ---------------------------------------------------------------------------
// 二、浏览器环境桩
// ---------------------------------------------------------------------------
const fakeStorage = new Map()
globalThis.localStorage = {
  getItem: (k) => (fakeStorage.has(k) ? fakeStorage.get(k) : null),
  setItem: (k, v) => fakeStorage.set(k, String(v)),
  removeItem: (k) => fakeStorage.delete(k)
}
globalThis.window = {}
globalThis.indexedDB = undefined
const wasmPath = decodeURIComponent(
  join(root, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm').replace(/\\/g, '/')
)
globalThis.__DSH_INIT_SQL_JS__ = (options = {}) =>
  initSqlJsImport({ ...options, locateFile: () => wasmPath })

// ---------------------------------------------------------------------------
// 三、装配 store
// ---------------------------------------------------------------------------
let pinia
let useAppStore
let db
let answerQuestion
try {
  pinia = await import('pinia')
  useAppStore = (await import(mirror('stores/appStore.mjs'))).useAppStore
  db = await import(mirror('utils/database.mjs'))
  answerQuestion = (await import(mirror('utils/knowledgeBase.mjs'))).answerQuestion
} catch (error) {
  console.error('❌ 无法在 Node 下装配 store：', error)
  process.exit(1)
}

async function bootStore() {
  pinia.setActivePinia(pinia.createPinia())
  const store = useAppStore()
  const ok = await store.initStore()
  return { store, ok }
}
async function restartStore() {
  await db.destroyDatabase()
  await db.initDatabase()
  return bootStore()
}

// 手册入库依赖浏览器 origin（Node 里 fetch('/manuals/…') 直接 Invalid URL），
// 这里同 store-check：先把标记写上让它跳过，手册语料由下面手工灌（见「检索」一节）。
await db.initDatabase()
db.setMeta('bundled_docs_seeded', 'bench-scale: 手册入库依赖浏览器 origin，改由本脚本构造语料')
await db.persist(true)

// ---------------------------------------------------------------------------
// 四、计时工具
// ---------------------------------------------------------------------------
const results = []
/**
 * 跑 repeat 次取**中位**，第一次当预热丢掉（JIT 与首次触碰内存页不代表稳态）。
 * 报告里给中位而不是平均：平均值会被偶发的一次 GC 或后台抢占拉偏，
 * 而这一节要回答的是"稳态下多慢"，不是"最坏一次多慢"（最坏值另有 max 一列）。
 */
function bench(label, fn, note = '') {
  try {
    fn() // 预热
    const samples = []
    for (let i = 0; i < REPEAT; i++) {
      const t0 = performance.now()
      fn()
      samples.push(performance.now() - t0)
    }
    samples.sort((a, b) => a - b)
    results.push({
      label,
      median: samples[Math.floor(samples.length / 2)],
      min: samples[0],
      max: samples[samples.length - 1],
      note
    })
  } catch (error) {
    results.push({ label, median: NaN, min: NaN, max: NaN, note: `跑不起来：${error.message}` })
  }
}
/** 异步版本（initStore / saveNow 这类） */
async function benchAsync(label, fn, note = '') {
  try {
    await fn()
    const samples = []
    for (let i = 0; i < REPEAT; i++) {
      const t0 = performance.now()
      await fn()
      samples.push(performance.now() - t0)
    }
    samples.sort((a, b) => a - b)
    results.push({
      label,
      median: samples[Math.floor(samples.length / 2)],
      min: samples[0],
      max: samples[samples.length - 1],
      note
    })
  } catch (error) {
    results.push({ label, median: NaN, min: NaN, max: NaN, note: `跑不起来：${error.message}` })
  }
}

const fmt = (ms) => (Number.isFinite(ms) ? `${ms.toFixed(1)} ms` : '—')

// ---------------------------------------------------------------------------
// 场景 1：首启（空库 → 播种）
// ---------------------------------------------------------------------------
const boot = await bootStore()
if (!boot.ok) {
  console.error('❌ store 没能完成首启，后面的场景都无从谈起')
  process.exit(1)
}
console.log(`\n规模：设备 ${DEVICES} 台 / 维保记录 ${RECORDS} 条 / 手册语料 ${MANUALS} 本 × ${CHUNKS} 片 / 每项重复 ${REPEAT} 次（取中位）`)

await benchAsync('首启（空库 → 播种 60 台）', async () => {
  await restartStore()
}, '含建库、判据、播种、一次落盘；手册入库不在内（浏览器路径）')
// 上面把库重启过，重新拿一个干净的（播种后的）store 继续灌数
let current = await restartStore()
const S = current.store

// ---------------------------------------------------------------------------
// 场景 2：批量灌数（走真实写入路径）
// ---------------------------------------------------------------------------
const CATEGORIES = ['挖掘机', '装载机', '起重机', '矿卡', '压路机', '泵车']
const MODELS = ['XE215C', 'ZL50GN', 'QY25K5D', 'XCA60E', 'XGT7528A', 'SQ10SK3Q', 'XE370D', 'LW500KV']
const LOCATIONS = ['一号矿区', '二号矿区', '三号矿区', '东采区', '西采区']
const STATUSES = ['running', 'running', 'running', 'maintenance', 'fault', 'idle']

const t0Devices = performance.now()
for (let i = 0; i < DEVICES; i++) {
  S.addEquipment({
    name: `压测设备-${i + 1}`,
    model: MODELS[i % MODELS.length],
    category: CATEGORIES[i % CATEGORIES.length],
    location: LOCATIONS[i % LOCATIONS.length],
    status: STATUSES[i % STATUSES.length],
    purchase_date: `20${10 + (i % 15)}-0${1 + (i % 9)}-1${i % 9}`,
    maintenance_cycle_days: [30, 60, 90, 180][i % 4],
    // 让超期分布有梯度：一部分设备的"上次维保"推到很久以前（看板才有东西可算）
    last_maintenance_date: `2026-0${1 + (i % 9)}-1${i % 9}`,
    aliases: i % 7 === 0 ? [`压测别名${i}`] : [],
    notes: ''
  }, { silent: true })
}
const devicesMs = performance.now() - t0Devices

// 维保记录：均匀撒到各台设备上（每台 RECORDS / DEVICES 条）
const t0Rec = performance.now()
for (let i = 0; i < RECORDS; i++) {
  const eqId = (i % DEVICES) + 1
  S.addMaintenanceRecord(eqId, {
    date: `2026-0${1 + (i % 9)}-0${1 + (i % 9)}`,
    type: '定期保养',
    content: `压测维保记录 ${i + 1}：检查液压油位、紧固螺栓、清洁散热器`,
    cost: 1000 + (i % 9000)
  }, { silent: true })
}
const recordsMs = performance.now() - t0Rec

results.push({
  label: `批量灌数（${DEVICES} 台 + ${RECORDS} 条）`,
  median: devicesMs + recordsMs,
  min: NaN,
  max: NaN,
  note: `新建设备合计 ${devicesMs.toFixed(0)} ms（${(devicesMs / DEVICES).toFixed(2)} ms/台）· 维保记录合计 ${recordsMs.toFixed(0)} ms（${(recordsMs / Math.max(1, RECORDS)).toFixed(3)} ms/条）`
})

/**
 * 把上面那批 silent 写入真正推到 SQLite。
 *
 * `persistAll` **不在 store 的公开 api 上**（它只在内部被各写入入口调用），
 * 所以这里不直接调它 —— 而是走一次**真实用户写入**（非 silent 新建设备），
 * 由它内部完成"记一条日志 → persistAll 整库重写 → 排一次防抖存盘"。
 * 顺带这也正是场景 3 要量的那条路径。
 */
function userWriteOnce() {
  S.addEquipment({ name: `压测落盘触发-${++tick}`, model: MODELS[0], category: CATEGORIES[0] }, {})
}
let tick = 0
userWriteOnce()
await S.saveNow()

// ---------------------------------------------------------------------------
// 场景 3：落盘（内存整库重写 + 真实写盘）
// ---------------------------------------------------------------------------
bench('落盘·一次真实用户写入（含整库重写）', () => {
  userWriteOnce()
}, `${DEVICES} 台 + ${RECORDS} 条：新建设备 → 记日志 → persistAll（十张表 DELETE + 全量 INSERT + 行映射）；减去上面量到的 silent 单台成本即整库重写本身`)

/**
 * ⚠️ 这一条量的是**整库序列化**，不是"写文件"。
 *
 * 用 `db.persist(true)` 而不是 `store.saveNow()`：saveNow 走的是
 * `if (!dirty && !force) return false` —— 没脏就直接返回，量出来是 0.0 ms，
 * 一个"很快"的假象（第一次跑本脚本就踩到了，如实记在这里）。
 * force 强制走完整条路：`dbHandle.export()` 把整库导出成 Uint8Array（**这才是真成本**）
 * → `saveDatabaseBytes()` 交给后端。
 * 后端在本 Node harness 里是桩（没有 indexedDB、localStorage 是个 Map），
 * 所以**写盘那一段没被量到** —— 真机上还要加上 Electron IPC + 写 userData/*.db 的时间。
 */
await benchAsync('落盘·整库序列化（db.persist(force)）', async () => {
  await db.persist(true)
}, 'db.export() 导出整库字节；本 harness 里后端是桩，真机写盘时间另计（见本行注释）')

// ---------------------------------------------------------------------------
// 场景 4：满库首启（关掉再打开）
// ---------------------------------------------------------------------------
await benchAsync('满库首启（关掉再打开）', async () => {
  const again = await restartStore()
  current = again
}, `从 SQLite 读回 ${DEVICES} 台 + ${RECORDS} 条并重建内存态`)
// 后面的看板与检索都在这个刚装好的 store 上量
const R = current.store

// ---------------------------------------------------------------------------
// 场景 5：看板
// ---------------------------------------------------------------------------
/** 让 computed 失效：碰一个与看板判据无关的字段（notes），不改变任何统计口径 */
function touchEquipment() {
  tick++
  const first = R.equipmentList[0]
  if (first) first.notes = `bench-${tick}`
}
bench('看板（健康分 + 分档 + 超期 + 预警）', () => {
  touchEquipment()
  void R.equipmentWithHealth
  void R.healthLevelStats
  void R.overdueList
  void R.upcomingList
  void R.criticalList
}, '一串 computed 的重算：健康分逐台评估 + 超期排序 + 预警汇总')

// ---------------------------------------------------------------------------
// 场景 6：检索（P2-3 的取值依据）
// ---------------------------------------------------------------------------
// 灌手册语料：answerItems 的第二半是"每本 ready 手册的全部切片"。
// Node 里取不到 /manuals/*.json，这里直接给出与 documentDomain 同形的文档对象。
const BODY = '本手册适用于该型号工程机械的日常维护与故障排查。液压系统应定期检查油位、油温与滤芯；'
  + '回转马达异响常见原因包括轴承磨损、齿轮啮合间隙过大、润滑不足。检查时先停机泄压，'
  + '再逐项排查回油背压与溢流阀设定值。电气部分注意线束绝缘与接插件松动。'
for (let m = 0; m < MANUALS; m++) {
  const chunks = []
  for (let p = 1; p <= CHUNKS; p++) chunks.push({ page: p, text: `${BODY}（第 ${p} 页 · ${MODELS[m % MODELS.length]}）` })
  R.documents.push({
    id: `bench-manual-${m}`,
    title: `压测手册 ${m + 1} · ${MODELS[m % MODELS.length]}`,
    model: MODELS[m % MODELS.length],
    status: 'ready',
    chunks
  })
}
const poolSize = R.answerItems.length
/**
 * 拆成两半量，因为 P2-3 的改法（"切片池按内容分缓存 + 逐条打分增量计算"）省的正是**前半段**：
 *   前半 = `answerItems` 重建整个池（知识条目 + 每本手册的全部切片，每次提问都重建）
 *   后半 = `answerQuestion` 在已有池上打分检索
 * 只报一个合计数会看不出缓存能省多少 —— 20 ms 里到底几毫是白花的，得拆开才知道。
 *
 * ⚠️ **踩过的坑（本脚本第一版就是这么假绿的，如实记在这里）**：
 * 让池失效最初写的是"改一下 `knowledgeItems[0].title`" —— 量出来 **0.0 ms**，
 * 看着像"池重建不要钱、20 ms 全在打分"，结论正好反了。原因是 Vue 的 computed
 * 只追踪**它读过的东西**：`answerItems` 里那句 `const base = [...knowledgeItems.value]`
 * 只迭代了数组（读 length 与下标），**从没读过条目的任何属性**，所以改 `title`
 * 不会让它失效，量到的是缓存命中。
 * 真正能失效它的是**文档**那一侧（它逐片读了 `doc.status` / `doc.chunks` / `chunk.page` / `chunk.text`）。
 * 下面改成碰 `documents[0].chunks[0].text`，并且加一条**测量前提检查**（见 invalidatesPool）。
 */
const REF_BODY = R.documents[0].chunks[0].text
function invalidatePool() {
  tick++
  // 覆盖写而不是追加，免得正文越长打分越慢、把测量本身变成变量
  R.documents[0].chunks[0].text = `${REF_BODY}（压测抖动 ${tick}）`
}
{
  const before = R.answerItems
  invalidatePool()
  const after = R.answerItems
  if (before === after) {
    console.log('\n⚠️  测量前提不成立：碰了 documents 之后 answerItems 仍然是同一个数组 —— 下面"池重建"一列量到的是缓存，不是重建成本。先修 invalidatePool。')
  }
}
bench('检索·池重建（answerItems）', () => {
  invalidatePool()
  void R.answerItems
}, `池 ${poolSize} 条（知识条目 ${R.knowledgeItems.length} + 手册切片 ${MANUALS * CHUNKS}）`)
// 池准备好一份给后半段用 —— 这正是 P2-3 想缓存下来的那件东西
const cachedPool = R.answerItems
bench('检索·一次提问（打分，池已缓存）', () => {
  answerQuestion(R, '回转马达异响怎么回事', cachedPool)
}, '后半段；加上面那行才是现在"每问一次"的真实成本')

// ---------------------------------------------------------------------------
// 五、报告
// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(78))
console.log('规模压测结果（中位 / 最小 / 最大）')
console.log('='.repeat(78))
for (const r of results) {
  console.log(`\n${r.label}`)
  console.log(`  中位 ${fmt(r.median)}   最小 ${fmt(r.min)}   最大 ${fmt(r.max)}`)
  if (r.note) console.log(`  ${r.note}`)
}
console.log('\n' + '='.repeat(78))
console.log('本脚本是耗时测量，不是断言：数字随机器与后台负载抖动，不进 npm run verify 门禁。')
console.log('数字要写进文档时，注明机器、日期与规模参数（默认 5000 / 50000，可用 --devices= / --records= 覆盖）。')

const broken = results.filter((r) => !Number.isFinite(r.median))
rmSync(mirrorDir, { recursive: true, force: true })
process.exit(broken.length ? 1 : 0)
