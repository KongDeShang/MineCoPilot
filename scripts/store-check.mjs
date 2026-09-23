/**
 * 矿山智工 - store 层行为自检（scripts/store-check.mjs）
 *
 * 为什么需要这个脚本：
 *   self-check 只镜像 `utils/` 下的纯函数，而 `stores/appStore.js`（1200+ 行）与
 *   `stores/persistence.js`（550+ 行）**从来没有被任何测试真正执行过** —— 对它们的
 *   "校验"是把源码读成字符串，看某个函数体里有没有出现某个列名。后果是实测出来的：
 *
 *     · `addEquipment` 的字段白名单漏了 `aliases` → 新建设备永远没有别名。
 *       当时四条**源码字符串**断言全绿（落库接了、回读接了、表单有输入框、导入器有切分），
 *       漏的正是中间那一环 —— 字符串检查对"漏一个字段"这类缺陷天生无感。
 *     · "台账为空被当成全新安装" → 下一次启动播种 60 台演示设备并整库覆盖用户数据。
 *       这段判据藏在 initStore 里，store 跑不起来就没人能驱动它。
 *
 * 做法：
 *   把 `utils/` 与 `stores/` **整棵目录**镜像成 `.mjs`（镜像目录放在**项目内**，
 *   这样 `vue` / `pinia` / `sql.js` 这些裸导入能沿目录树解析到项目 node_modules），
 *   在 Node 里真正装配 store（pinia + 桩掉的 localStorage/window），跑行为断言。
 *   跑的是项目真实代码，不是复制品。
 *
 * 运行：npm run store-check
 *
 * 覆盖范围与**不覆盖**的：
 *   · 覆盖：首启播种判据、addEquipment 字段白名单、别名端到端落盘、落盘失败可见性、
 *     日志窗口、撤销栈清理、工单持久化往返。
 *   · 不覆盖：手册入库（依赖浏览器 origin，Node 里取不到 `/manuals/*.json`，
 *     `resetToSeedData` 会因此打三行警告；真实浏览器下的手册库由 e2e 覆盖）、
 *     以及任何需要 DOM 的路径。
 */
import initSqlJsImport from 'sql.js'
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const rendererSrc = join(root, 'src', 'renderer', 'src')
const mirrorDir = join(root, '.tmp-storecheck')

let pass = 0
let fail = 0
const failures = []

function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`PASS  ${name}${detail ? `  [${detail}]` : ''}`)
  } else {
    fail++
    failures.push(name)
    console.log(`FAIL  ${name}${detail ? `  [${detail}]` : ''}`)
  }
}

// ---------------------------------------------------------------------------
// 一、生成 ESM 镜像（保留 utils/ 与 stores/ 的相对目录结构，相对导入才成立）
// ---------------------------------------------------------------------------
/**
 * 把源码里的相对导入补上 .mjs。
 * 项目里没有目录式导入（唯一的 `import('../utils/docService')` 指向目录），
 * 统一补 `.mjs` 之后把它单独映射到 `docService/index.mjs`。
 */
function rewrite(code) {
  const addExt = (spec) => {
    if (spec.startsWith('.') && !/\.[a-z0-9]+$/i.test(spec)) return `${spec}.mjs`
    return spec
  }
  return code
    // 静态导入 / 导出
    .replace(/(from\s+['"])(\.[^'"]+)(['"])/g, (_m, a, spec, c) => a + addExt(spec) + c)
    // 动态导入
    .replace(/(import\(\s*['"])(\.[^'"]+)(['"]\s*\))/g, (_m, a, spec, c) => a + addExt(spec) + c)
    // 目录式导入：Vite 能解析，Node 不能
    .replace(/docService\.mjs/g, 'docService/index.mjs')
}

function mirrorTree(relDir) {
  const from = join(rendererSrc, relDir)
  const to = join(mirrorDir, relDir)
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from)) {
    const src = join(from, entry)
    const dst = join(to, entry)
    if (statSync(src).isDirectory()) {
      mirrorTree(join(relDir, entry))
      continue
    }
    if (!entry.endsWith('.js')) continue // 只镜像 JS（没有别的东西被 import）
    writeFileSync(dst.replace(/\.js$/, '.mjs'), rewrite(readFileSync(src, 'utf8')), 'utf8')
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
// 二、浏览器环境桩（与 utils/database.js 的取用方式对齐）
// ---------------------------------------------------------------------------
const fakeStorage = new Map()
globalThis.localStorage = {
  getItem: (k) => (fakeStorage.has(k) ? fakeStorage.get(k) : null),
  setItem: (k, v) => fakeStorage.set(k, String(v)),
  removeItem: (k) => fakeStorage.delete(k)
}
globalThis.window = {}
globalThis.indexedDB = undefined

// sql.js 在 Node 下需要显式 wasm 路径
const wasmPath = decodeURIComponent(
  join(root, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm').replace(/\\/g, '/')
)
globalThis.__DSH_INIT_SQL_JS__ = (options = {}) =>
  initSqlJsImport({ ...options, locateFile: () => wasmPath })

// ---------------------------------------------------------------------------
// 三、装配真实的 store
// ---------------------------------------------------------------------------
let pinia
let useAppStore
let db
try {
  const piniaMod = await import('pinia')
  pinia = piniaMod
  const appMod = await import(mirror('stores/appStore.mjs'))
  useAppStore = appMod.useAppStore
  db = await import(mirror('utils/database.mjs'))
} catch (error) {
  console.error('❌ 无法在 Node 下装配 store：', error)
  console.error('   （这条本身就是重要信号：store 层不可测，任何"白名单漏字段"都抓不住）')
  process.exit(1)
}

/** 新建一个"应用实例"（新的 pinia + 新的 store），用于模拟重启 */
async function bootStore() {
  pinia.setActivePinia(pinia.createPinia())
  const store = useAppStore()
  const ok = await store.initStore()
  return { store, ok }
}

/** 模拟"关掉应用再打开"：断内存库 → 重开 → 新 store */
async function restartStore() {
  await db.destroyDatabase() // 不清存储，保留磁盘上的字节
  await db.initDatabase()
  return bootStore()
}

/**
 * 先把"随包手册已入库"的标记写上，让 initStore → ensureBundledDocuments() 直接跳过。
 *
 * 为什么：随包手册是「按 URL 取 src/renderer/public/manuals/*.json + PDF」再抽文字层的，
 * 那一步依赖浏览器的 origin（Node 里 fetch('/manuals/…') 直接是 Invalid URL）。
 * 本脚本要验的是 store 的数据/持久化行为，不是文档入库 —— 让它跳过可以少三行
 * 与断言无关的警告，也避免把"环境限制"误读成"功能坏了"。
 * 文档入库本身由 e2e 在真实浏览器里覆盖（那里断言了 3 份手册可问答、86 页）。
 */
await db.initDatabase()
db.setMeta('bundled_docs_seeded', 'store-check: 手册入库依赖浏览器 origin，交给 e2e 覆盖')
await db.persist(true)

const first = await bootStore()
check('store 能在 Node 下装配并完成首启', first.ok === true, `initStore() → ${first.ok}`)
const store = first.store

// ---------------------------------------------------------------------------
// 四、断言
// ---------------------------------------------------------------------------

// 1) 首启播种
check('首启播种 60 台设备', store.equipmentList.length === 60, `${store.equipmentList.length} 台`)
check('首启写入 seed_version（"装过没有"的唯一判据）',
  db.getMeta('seed_version') !== null, String(db.getMeta('seed_version')))
check('首启不处于"空台账"状态', store.ledgerEmpty === false)

// 2) 表结构版本标记确实落库（database.js 里说明它只写不读，自检负责确认它真的写了）
check('schema_version 已写入 meta', db.getMeta('schema_version') === '1', String(db.getMeta('schema_version')))

// 3) addEquipment 的字段白名单：**逐字段**验证能回读
//    这一条就是冲着"漏一个字段"去的：白名单少写一个键，这里必然红。
{
  const input = {
    name: '白名单探针-01',
    model: 'TEST-100',
    category: '挖掘机',
    location: 'C矿区',
    purchase_date: '2024-05-06',
    status: 'maintenance',
    maintenance_cycle_days: 45,
    last_maintenance_date: '2026-08-01',
    aliases: ['小白', '一号探针机'],
    notes: '白名单断言用'
  }
  const created = store.addEquipment({ ...input })
  const back = store.equipmentList.find(e => e.id === created.id)
  const missing = []
  for (const [key, value] of Object.entries(input)) {
    const got = back[key]
    const same = Array.isArray(value)
      ? Array.isArray(got) && got.length === value.length && got.every((v, i) => v === value[i])
      : got === value
    if (!same) missing.push(`${key}: 期望 ${JSON.stringify(value)}，实际 ${JSON.stringify(got)}`)
  }
  check('addEquipment：传入的每个字段都能回读（白名单漏字段会被这条抓住）',
    missing.length === 0, missing.join('；') || `${Object.keys(input).length} 个字段全部一致`)

  // 4) aliases 端到端往返：写入 → 落盘 → 重启 → 回读
  //    原来自检对别名的"验证"是查源码里有没有 formatAliases/parseAliases 字符串，
  //    所以"新建时被丢掉"这件事四条断言全绿。这里真的走一遍落盘与重建。
  await store.saveNow()
}
{
  const restarted = await restartStore()
  const back = restarted.store.equipmentList.find(e => e.name === '白名单探针-01')
  check('别名真的落盘了：重启后仍能读回（不是只活在内存里）',
    !!back && Array.isArray(back.aliases) && back.aliases.length === 2,
    back ? JSON.stringify(back.aliases) : '重启后找不到该设备')
  check('重启后设备总数 = 61（60 台播种 + 1 台探针，且没有被重新播种覆盖）',
    restarted.store.equipmentList.length === 61, `${restarted.store.equipmentList.length} 台`)
}

// 5) 台账为空 ≠ 全新安装（行为级验证 seedGate）
//    先制造"用户把台账删空、但工单/日志还在"的真实状态，再模拟重启。
{
  const beforeOrders = store.workOrders.length
  const beforeLogs = store.recentLogs.length
  check('前置条件：工单与日志都有数据（否则这条断言本身没有意义）',
    beforeOrders > 0 && beforeLogs > 0, `工单 ${beforeOrders} / 日志 ${beforeLogs}`)

  db.replaceAll({ equipment: [] }) // 用户删空了台账
  await db.persist(true)

  const restarted = await restartStore()
  check('台账为空 + 装过 ⇒ 不得重新播种演示设备（否则整库覆盖用户数据）',
    restarted.store.equipmentList.length === 0,
    `${restarted.store.equipmentList.length} 台`)
  check('台账为空时 UI 能拿到"空台账"标记', restarted.store.ledgerEmpty === true)
  check('台账为空时其它数据必须原样保留',
    restarted.store.workOrders.length === beforeOrders,
    `工单 ${restarted.store.workOrders.length} / 期望 ${beforeOrders}`)
}

// 6) 落盘失败必须可见（不是静默当成功）
{
  const failing = { ok: false, error: '磁盘已满（自检注入）' }
  globalThis.window = { electronAPI: { db: { write: async () => failing, read: async () => null, clear: async () => ({ ok: true }) } } }
  store.addEquipment({ name: '落盘失败探针' }) // 触发一次变更，进入脏状态
  await store.saveNow()
  check('落盘失败时 dbError 必须非空（界面才能显示"保存失败"）',
    String(store.dbError || '').includes('磁盘已满'), String(store.dbError || '(空)'))
  check('落盘失败后必须仍是脏状态（否则关窗时不会再重试）',
    (await db.isDirty()) === true, `isDirty=${await db.isDirty()}`)
  globalThis.window = {}
}

// 7) 日志滑动窗口只有一个定义
{
  const target = store.recentLogs.length + 600
  const before = store.recentLogs.length
  for (let i = 0; i < 600; i++) store.addLog({ content: `窗口探针 ${i}`, source: '自检', type: 'info', tagType: 'info' }, { silent: true })
  check('日志窗口为 LOG_WINDOW=500（内存里不会无限增长）',
    store.recentLogs.length === 500, `写入前 ${before} 条，写入 600 条后 ${store.recentLogs.length} 条（期望 500）`)
  check('日志确实有写入（否则上一条是空集恒真）', target > 500 && store.recentLogs.length === 500)
}

// 8) 重置演示数据必须清空撤销栈
//    这是本轮修掉的一个真实缺陷：整库重建后 id 全部重排，而旧撤销条目里存的是
//    指向重置前对象的闭包 —— 留着不清，点「撤销这次写入」会拿旧 id 去改重置后的记录。
{
  store.logVoiceAction({
    rawText: '自检探针：随手记一笔',
    summary: '自检',
    changes: [{ label: '探针' }],
    intentLabel: '自检',
    undos: [() => {}]
  })
  check('前置条件：撤销栈里确实有了一条', store.getUndoStack().length > 0,
    `${store.getUndoStack().length} 条`)

  await store.resetToSeedData()
  check('重置演示数据后撤销栈必须清空（否则旧闭包会改到重置后的记录）',
    store.getUndoStack().length === 0, `${store.getUndoStack().length} 条`)
  check('重置后设备回到 60 台', store.equipmentList.length === 60, `${store.equipmentList.length} 台`)
}

// 9) 工单写入 → 落盘 → 重启 → 仍在（顺带覆盖 persistence 的行映射）
{
  const created = store.addWorkOrder({
    equipment_id: 1,
    equipment_name: store.equipmentList[0]?.name || '1号设备',
    title: '自检探针工单',
    type: 'repair',
    priority: 'high'
  })
  await store.saveNow()
  const restarted = await restartStore()
  const found = restarted.store.workOrders.find(o => o.id === created.id)
  check('工单写入后重启仍在（persistence 行映射没丢字段）',
    !!found && found.title === '自检探针工单', found ? `#${found.id} ${found.title}` : '重启后找不到')
}

// ---------------------------------------------------------------------------
rmSync(mirrorDir, { recursive: true, force: true })
console.log(`\n合计 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项`)
if (failures.length) {
  console.log(`失败项：${failures.join('；')}`)
  process.exitCode = 1
}
