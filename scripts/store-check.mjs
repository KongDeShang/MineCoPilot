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
 *     日志窗口、撤销栈清理、工单持久化往返、手册检索池上限、手册 chunk_total 往返、
 *     错误边界处理器行为（挂载 / 落日志 / 去重 / 自身不抛错）、
 *     撤销的持久化与跨刷新可撤（六个意图成对给出闭包与描述、两条路撤出同一状态、
 *     CAS 拒绝静默覆盖、重启后仍能撤且 id 不复用、超预算从最早淘汰并留日志）。
 *   · 不覆盖：手册入库（依赖浏览器 origin，Node 里取不到 `/manuals/*.json`，
 *     `resetToSeedData` 会因此打三行警告；真实浏览器下的手册库由 e2e 覆盖）、
 *     以及任何需要 DOM 的路径 —— **错误提示条能不能渲染**就属于这一类，
 *     由 e2e 第 13 节覆盖（那里还顺带验了 main.js 真的装了处理器）。
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
    undos: [() => {}],
    // 带一份可序列化的描述：撤销栈现在会整栈落本机存储，只有带描述的条目才落盘。
    // 不带的话"重置后存档里也该没有它"是**恒真**的（它压根没进过存档），
    // 那条断言就等于没写。
    inverse: [{ op: 'remove', table: 'knowledge_items', id: 'ks-selfcheck-probe' }]
  })
  check('前置条件：撤销栈里确实有了一条', store.getUndoStack().length > 0,
    `${store.getUndoStack().length} 条`)
  check('前置条件：这条真的落进本机存储了（否则下面的"清干净"恒真）',
    ((JSON.parse(globalThis.localStorage.getItem('ks:undo-stack') || '{}').entries) || []).length > 0,
    globalThis.localStorage.getItem('ks:undo-stack') ? '已落盘' : '没有存档')

  await store.resetToSeedData()
  check('重置演示数据后撤销栈必须清空（否则旧闭包会改到重置后的记录）',
    store.getUndoStack().length === 0, `${store.getUndoStack().length} 条`)
  check('清栈必须连本机存储里的副本一起清（只清内存，下次启动会把旧条目又摆回来）',
    ((JSON.parse(globalThis.localStorage.getItem('ks:undo-stack') || '{}').entries) || []).length === 0,
    String(globalThis.localStorage.getItem('ks:undo-stack')))
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

// 10) 手册检索池：不得有第二个上限（docs/完善计划.md P1-2 的回归守卫）
//
// 缺陷原貌：入库上限是 documentDomain.CHUNK_LIMIT = 300，而 appStore 的检索池
// 另写了 `doc.chunks.slice(0, 120)`。两个常量各写各的，超过 120 页的手册，
// 第 121 页起的正文永远进不了检索池，界面却按 PDF 总页数显示"可问答（N 页）"。
// 随包 3 本手册是 36/32/18 页，正好演示不出来。
//
// 这条断言必须能失败：把 slice(0, 120) 放回去，下面第一条就会报"进池 120 片"。
{
  const makeProbeDoc = (id, chunkCount, chunkTotal) => ({
    id,
    title: `探针手册-${chunkCount}`,
    docType: '使用手册',
    model: '徐工 XCA60E',
    category: '起重机',
    fileName: `${id}.pdf`,
    filePath: '',
    fileSize: 1,
    // pages 用"截断前总数"更贴近真实：被截断时 pages > 可检索页数
    pages: chunkTotal,
    status: 'ready',
    chunkTotal,
    chunks: Array.from({ length: chunkCount }, (_, i) => ({ page: i + 1, text: `探针正文第 ${i + 1} 页` })),
    note: '',
    addedAt: '2026-09-25'
  })

  // 200 片 > 旧版检索侧的硬编码 120，且 < 入库上限 300 —— 本该整本可检索
  store.documents = [makeProbeDoc('doc-probe-200', 200, 200), ...store.documents]
  const pool = store.answerItems.filter(x => String(x.id).startsWith('doc-probe-200-'))
  check('手册检索池取全量切片（200 片整本进池，不被旧版 120 的硬编码截断）',
    pool.length === 200, `进池 ${pool.length} 片`)
  check('第 200 页确实可被检索（旧版会丢在 120 之后）',
    pool.some(x => x.id === 'doc-probe-200-p200'),
    pool.some(x => x.id === 'doc-probe-200-p200') ? '在池中' : '丢失')

  // 截断标注：入库被 CHUNK_LIMIT 截到 300 时，chunkTotal 仍记 420，
  // 界面才能算出"仅前 300 页可问答"而不是拿 pages 冒充。
  store.documents = [makeProbeDoc('doc-probe-trunc', 300, 420), ...store.documents]
  const truncPool = store.answerItems.filter(x => String(x.id).startsWith('doc-probe-trunc-'))
  const truncDoc = store.documents.find(d => d.id === 'doc-probe-trunc')
  check('被截断的手册：检索池等于已存切片数（300），且 chunkTotal 记下真实总数（420）',
    truncPool.length === 300 && truncDoc.chunkTotal === 420,
    `进池 ${truncPool.length} 片 / 总数 ${truncDoc.chunkTotal}`)
  check('被截断时 pages(420) != 可检索页数(300) —— 界面据此标黄，不能拿 pages 冒充',
    truncDoc.pages > truncPool.length,
    `pages=${truncDoc.pages} 可检索=${truncPool.length}`)

  /*
   * chunk_total 必须真的落盘并读回：这一列是本次迁移新加的，
   * 只写不读（或列没建成）都会让重启后截断标注凭空消失。
   *
   * 这里为什么要借 addLog 推一把：
   *   persistAll() 是唯一把内存列表映射成数据库行的入口，而它没有对外暴露
   *   （store 只导出 saveNow）。上面是直接给 store.documents 赋值的，
   *   如果不经 persistAll，这些手册压根没进过 SQLite —— saveNow() 会因
   *   `dirty === false` 直接返回 false（db.persist 的既定行为），
   *   于是"重启后找不到该手册"，看起来像是持久化坏了，实际是这条断言自己没落盘。
   *   addLog 是一条真实的用户路径（记操作日志 → persistAll 整表回写），
   *   用它触发既不改数据语义，也顺带覆盖了"日志写入会带上本次手册变更"。
   */
  store.addLog({ content: '自检：把探针手册推入持久化', source: '自检' })
  await store.saveNow()
  const afterDocs = (await restartStore()).store.documents
  const persisted = afterDocs.find(d => d.id === 'doc-probe-trunc')
  check('chunk_total 落盘并读回（重启后截断标注不丢）',
    !!persisted && persisted.chunkTotal === 420,
    persisted ? `chunkTotal=${persisted.chunkTotal}` : '重启后找不到该手册')
  check('chunks 落盘并读回（检索池重启后仍是全量 300 片）',
    !!persisted && persisted.chunks.length === 300,
    persisted ? `${persisted.chunks.length} 片` : '重启后找不到该手册')
}

// 11) 错误边界：运行期异常必须变成"一条提示 + 一行日志"，而不是一块白屏
//     （docs/完善计划.md P1-3 的回归守卫）
//
// 为什么这条断言值得写：README 自己承认"模板里调一个没导入的函数会整页白屏"，
// 而防线只有 vue/no-undef-properties 一条**静态**规则 —— 它管不住运行期异常。
// 现场用户看到白屏只能关掉重开，事后也没有任何日志能回答"刚才怎么了"。
//
// 这里用桩 log 计数（要断去重），同时**转发给真实的 store.addLog** ——
// 后者才是 main.js 实际接的线，不转发就只测了"边界会调回调"，
// 测不到"操作日志真的收得下这种 entry"。
{
  const { installErrorBoundaries, clearError, appError } =
    await import(mirror('utils/errorBoundary.mjs'))

  const logs = []
  const app = { config: {} }
  let routeErrorHandler = null
  installErrorBoundaries(app, {
    router: { onError: (fn) => { routeErrorHandler = fn } },
    log: (entry, options) => {
      logs.push({ entry, options })
      store.addLog(entry, options) // 与 main.js 的接线一致
    }
  })

  check('错误边界：app.config.errorHandler 已挂上（否则组件内异常仍会白屏）',
    typeof app.config.errorHandler === 'function', typeof app.config.errorHandler)
  check('错误边界：router.onError 已挂上（懒加载 chunk 失败不经过 errorHandler）',
    typeof routeErrorHandler === 'function', typeof routeErrorHandler)

  app.config.errorHandler(new Error('自检探针：渲染炸了'), {}, 'render function')
  check('错误边界：组件异常会写进操作日志（现场唯一的事后凭据）',
    logs.length === 1 && logs[0].entry.content.includes('自检探针：渲染炸了'),
    logs.length ? logs[0].entry.content : '没有写入日志')
  check('错误边界：日志里带上出错位置（同一个 message 在不同钩子里含义不同）',
    logs.length === 1 && logs[0].entry.content.includes('render function'),
    logs.length ? logs[0].entry.content : '(无)')
  check('错误边界：真的接到 store.addLog 上（不是只调了个回调）',
    String(store.recentLogs[0] && store.recentLogs[0].content || '').includes('自检探针：渲染炸了'),
    String(store.recentLogs[0] && store.recentLogs[0].content || '(日志首条为空)'))
  check('错误边界：写日志用 silent，避免与持久化层互相触发',
    logs.length === 1 && !!logs[0].options && logs[0].options.silent === true,
    JSON.stringify(logs[0] && logs[0].options))
  check('错误边界：提示条状态已置位（界面据此渲染"返回看板"）',
    !!appError.value && appError.value.message === '自检探针：渲染炸了',
    appError.value ? appError.value.message : '(空)')

  /*
   * 去重：渲染期异常是**按组件实例**触发的，一个 v-for 里的取值错误一帧能抛几十次。
   * 不去重的话日志窗口（LOG_WINDOW=500）会被同一句话瞬间冲干净 ——
   * 恰好把"出错前发生了什么"这段最该留的证据挤掉。
   */
  for (let i = 0; i < 20; i++) {
    app.config.errorHandler(new Error('自检探针：渲染炸了'), {}, 'render function')
  }
  check('错误边界：同一条错误重复 20 次只记 1 条日志（不刷掉出错前的上下文）',
    logs.length === 1, `${logs.length} 条`)
  check('错误边界：重复时提示条累加计数（用户能看到"已出现 N 次"）',
    !!appError.value && appError.value.count === 21,
    appError.value ? String(appError.value.count) : '(空)')

  /*
   * 处理器自身不得抛错 —— 它在异常路径上被调用，自己再抛就是死循环
   * （handler 抛错 → 又触发 handler），比原来的白屏更难查。
   * 这几种输入都是真实会出现的：throw null、被 throw 出来的字符串、
   * 循环引用对象（JSON.stringify 会抛）、message 是 getter 且抛错。
   */
  const weird = { self: null }
  weird.self = weird
  Object.defineProperty(weird, 'message', { get() { throw new Error('message getter 抛错') } })
  const thrown = []
  const silent = []
  for (const bad of [null, undefined, '纯字符串错误', weird, { message: 123 }]) {
    clearError()
    try {
      app.config.errorHandler(bad, {}, 'setup function')
    } catch (error) {
      thrown.push(String(error))
    }
    // 不抛只是及格线：还得**留下可见痕迹**。若某种畸形输入让提示条拿不到文案，
    // 界面就等于什么都没发生 —— 那又回到"点了没反应"，与白屏只差一个程度。
    if (!appError.value) silent.push(JSON.stringify(bad) || String(bad))
  }
  check('错误边界：遇到 null / 循环引用 / getter 抛错都不抛（否则死循环）',
    thrown.length === 0, thrown.join('；') || '5 种畸形输入全部安全')
  check('错误边界：5 种畸形输入都必须留下提示（拿不到 message 也要给兜底文案）',
    silent.length === 0, silent.join('、') || '全部有提示')

  // 写日志本身失败（落盘层出问题）不得反向触发上报
  const app2 = { config: {} }
  installErrorBoundaries(app2, {
    router: { onError: () => {} },
    log: () => { throw new Error('日志层也炸了') }
  })
  let leaked = null
  try {
    app2.config.errorHandler(new Error('自检探针：日志层故障'), {}, 'render function')
  } catch (error) {
    leaked = String(error)
  }
  check('错误边界：写日志失败时处理器仍然不抛（不递归）',
    leaked === null, leaked || '安全')

  // 路由级异常不经过 errorHandler，漏了这一段就等于漏了懒加载失败
  const beforeRoute = logs.length
  routeErrorHandler(new Error('自检探针：chunk 加载失败'), { fullPath: '/equipment' })
  check('错误边界：路由异常单独上报（懒加载失败不走组件错误处理器）',
    logs.length === beforeRoute + 1 && logs[beforeRoute].entry.content.includes('/equipment'),
    logs.length > beforeRoute ? logs[beforeRoute].entry.content : '没有写入日志')

  clearError()
  check('错误边界：clearError 能清空提示条（点"知道了"之后不该一直挂着）',
    appError.value === null, String(appError.value))
}

// 12) 撤销的持久化与跨刷新可撤（docs/完善计划.md P2-1 的回归守卫）
//
// 改造前：撤销条目里存的是**闭包**（`() => store.removeWorkOrder(id)`），JSON 存不下，
// 所以整条栈只在内存里 —— 刷新即失效，结果卡上的「撤销这次写入」只能置灰。
// 现在每个写入意图**同时**给出两份等价的东西：
//   · `undo`    闭包，本次页面加载内执行（老路径，保留）
//   · `inverse` 可序列化的逆操作描述，整栈落本机 localStorage，刷新/重启后靠它撤
//
// 本节守三件事：
//   · 出口不变量：六个写入意图必须两份都给 —— 只给闭包 = 刷新后撤不了（改回原样），
//     只给描述 = 当次页面内撤不了
//   · **两条路同结果**：同一场景分别走闭包与描述，必须撤出**完全相同的状态**。
//     这是本次改造最危险的失效模式：描述写错一个字段，当次撤销看着好好的，
//     刷新后再撤才会把数据撤成另一个样子 —— 那正是"静默改错数据"。
//   · 持久化的代价与边界：CAS 拒绝静默覆盖、超预算从最早淘汰且留日志、清栈连存档一起清
{
  const nl = await import(mirror('utils/nlCommand.mjs'))

  /**
   * 状态探针：把"与撤销有关的那部分状态"投影成可比字符串。
   *
   * id 一律剔掉：同一个动作前后执行两次必然落在不同的行 id 上，留着 id 会让
   * "两条路撤出同一状态"永远不成立 —— 等于这条断言自带恒假，永远绿。
   * 剔掉 id 之后仍能发现实质差异：集合的**条数**、每条的内容、设备字段、库存数量都在。
   */
  const probeParts = (s, eqId) => {
    const eq = s.equipmentList.find(e => String(e.id) === String(eqId))
    /**
     * 工单的四个"归档时才出现"的字段统一按 null 归一。
     * 撤销把"当时没有这个键"写成 null（见 nlCommand 里 orderBefore 的说明：不补 null
     * 就清不掉写入时置上的值，而"当时没有"与"当时是 null"在撤销语义上是同一件事）。
     * 探针要是把"键不存在"和"值是 null"当成两回事，就会把这条**故意的归一**报成
     * 撤销不干净 —— 那是在挑被测对象的表达方式，不是在挑它的行为。
     * 真的没清干净（该字段留着写入时的值）照样会被抓出来。
     */
    const OPTIONAL_ORDER_KEYS = ['archived_at', 'completed_at', 'recheck_date', 'recheck_status']
    const normalizeOrder = (o) => {
      const out = { ...o }
      for (const k of OPTIONAL_ORDER_KEYS) out[k] = o[k] ?? null
      return out
    }
    return {
      eq: eq ? { ...eq } : null,
      records: s.getMaintenanceByEquipmentId(eqId) || [],
      snapshots: s.getSnapshots(eqId) || [],
      orders: s.workOrders.filter(o => eq && o.equipment_name === eq.name).map(normalizeOrder),
      knowledge: s.knowledgeItems.map(k => ({ title: k.title, category: k.category })),
      cases: (s.faultCases || []).map(c => ({ title: c.title, system: c.system })),
      parts: (s.partsInventory || []).map(p => ({ name: p.name, stock: p.stock })),
      txs: (s.partTransactions || []).map(t => ({ type: t.type, qty: t.qty, partId: t.part_id }))
    }
  }
  /**
   * 探针不一致时报出**是哪一块、差在哪一条**。
   *
   * 只报 true/false 的话，一条红断言能让人查一下午 —— 而这一刻最需要的信息
   * 恰恰是"病历多了两条"还是"设备状态没回去"。
   * 数组必须逐条定位：把整段 JSON 截断显示时，两边的前 150 字符往往一模一样
   * （前面若干条本来就相同），真正的差异被截在看不见的地方 —— 那等于没报。
   */
  const clip = (s) => (s.length > 220 ? s.slice(0, 220) + '…' : s)
  /** 逐字段说出差异（行对象字段多，整条 dump 出来看不出是哪一格不对） */
  const fieldDiff = (x, y) => {
    const keys = Object.keys({ ...(x || {}), ...(y || {}) })
    return keys
      .filter(k => JSON.stringify(x && x[k]) !== JSON.stringify(y && y[k]))
      .map(k => `${k}: ${JSON.stringify(x && x[k])} → ${JSON.stringify(y && y[k])}`)
      .join('，')
  }
  const probeDiff = (expected, actual) => {
    const out = []
    for (const key of Object.keys(expected)) {
      const a = expected[key]
      const b = actual[key]
      if (JSON.stringify(a) === JSON.stringify(b)) continue
      if (Array.isArray(a) && Array.isArray(b)) {
        const hits = []
        for (let i = 0; i < Math.max(a.length, b.length) && hits.length < 3; i++) {
          if (JSON.stringify(a[i]) === JSON.stringify(b[i])) continue
          const fields = fieldDiff(a[i], b[i])
          hits.push(fields
            ? `第 ${i + 1} 条〔${fields}〕`
            : `第 ${i + 1} 条 期望 ${clip(JSON.stringify(a[i]))} / 实际 ${clip(JSON.stringify(b[i]))}`)
        }
        out.push(`${key}（${a.length} 条 vs ${b.length} 条）：${hits.join(' ； ') || '条数相同但内容有差'}`)
      } else {
        out.push(`${key}: 期望 ${clip(JSON.stringify(a))} / 实际 ${clip(JSON.stringify(b))}`)
      }
    }
    return out.join(' | ')
  }
  /**
   * 取样归一：剔掉 id（每次执行都换）+ 递归按键名排序。
   *
   * 排序不是洁癖：对象里"这个键当初存不存在"会影响它的插入位置（补 null 的键会被
   * 追加到末尾），于是内容完全相同的两份数据可以序列化成不同的字符串 —— 不排序就会
   * 把这种无关差异报成"撤销没回到写入前"（本节真的踩了这个坑：报出来的 diff 里
   * 期望与实际逐字段一模一样，差异只在键序）。
   */
  const stripIds = (value) => JSON.parse(JSON.stringify(value, (k, v) => {
    if (k === 'id') return undefined
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort().map(kk => [kk, v[kk]]))
    }
    return v
  }))
  const probe = (s, eqId) => JSON.stringify(stripIds(probeParts(s, eqId)))

  /**
   * 跑一个写入意图，走 UI 的那条路：
   * 解析 → 执行 → logVoiceAction 同时收下闭包与描述（少收哪一份，本节第一条就会红）。
   */
  const runIntent = (s, text) => {
    const plan = nl.parseCommand(s, text)
    const item = (plan.items || [])[0]
    if (!item) return { ok: false, error: `解析不出计划项：${text}` }
    if (item.preflightError) return { ok: false, error: item.preflightError }
    const outcome = nl.executePlanItem(s, item)
    if (!outcome.ok) return { ok: false, error: outcome.error }
    const entry = s.logVoiceAction({
      rawText: text,
      summary: outcome.summary,
      changes: outcome.changes || [],
      intentLabel: item.intentLabel,
      undos: outcome.undo ? [outcome.undo] : [],
      inverse: outcome.inverse || []
    })
    return { ok: true, outcome, entry, item }
  }

  /**
   * 设备实体靠**解析器自己**找回来，别按名字猜。
   * 现场口语说的是"1号挖掘机"，而台账里的名字是"型号 + 类别 + 编号"（XE210C 挖掘机-01），
   * 中间这层映射正是 resolveEquipment 的职责 —— 在这里用正则去猜等于绕过被测对象。
   */
  const devLabel = '1号挖掘机'
  const refOne = nl.resolveEquipment(devLabel, store.equipmentList)
  const dev = refOne.status === 'resolved' ? refOne.equipment : null
  check('前置条件：口述「1号挖掘机」能唯一定位到一台设备（本节所有断言都靠它）',
    !!dev, dev ? `${devLabel} → ${dev.name}（id ${dev.id}）` : `解析结果 ${refOne.status}（下面的断言全部失去意义）`)

  if (dev) {
    // 完成 / 复诊两个意图要求"先有工单"，先造一张待处理的维修工单
    store.addWorkOrder({
      equipment_id: dev.id,
      equipment_name: dev.name,
      title: 'P2-1 探针：待检修工单',
      type: 'repair',
      priority: 'high'
    })

    // ---------- A. 六个写入意图：闭包与描述必须成对给 ----------
    // 顺序有讲究：COMPLETE_ORDER 要排在 DO_RECHECK 前面（后者要求存在待复诊工单，
    // 而"待复诊"正是完成工单时生成的）。
    const intentTexts = [
      [nl.INTENTS.REPORT_FAULT, `${devLabel}液压系统压力偏低`],
      [nl.INTENTS.ADD_MAINTENANCE, `${devLabel}换了机油和机滤`],
      [nl.INTENTS.SET_STATUS, `${devLabel}先停机别排产`],
      [nl.INTENTS.COMPLETE_ORDER, `${devLabel}已经检修完了`],
      [nl.INTENTS.DO_RECHECK, `${devLabel}复诊完成`],
      [nl.INTENTS.ADD_KNOWLEDGE, `记一条经验：${devLabel}压力偏低先查先导泵`]
    ]
    const bothPaths = []
    const onlyClosure = []
    const onlyInverse = []
    const notParsed = []
    const missingCas = []
    for (const [intent, text] of intentTexts) {
      const parsed = nl.parseCommand(store, text)
      const item = (parsed.items || [])[0]
      if (!item || item.intent !== intent) {
        notParsed.push(`${intent}（原话「${text}」解析成 ${item ? item.intent : '无计划项'}）`)
        continue
      }
      if (item.preflightError) {
        notParsed.push(`${intent}（前置检查：${item.preflightError}）`)
        continue
      }
      const outcome = nl.executePlanItem(store, item)
      if (!outcome.ok) {
        notParsed.push(`${intent}（执行失败：${outcome.error}）`)
        continue
      }
      const hasClosure = typeof outcome.undo === 'function'
      const hasInverse = Array.isArray(outcome.inverse) && outcome.inverse.length > 0
      if (hasClosure && hasInverse) bothPaths.push(intent)
      else if (hasClosure) onlyClosure.push(intent)
      else if (hasInverse) onlyInverse.push(intent)
      else notParsed.push(`${intent}（两份都没有：撤不了）`)

      /*
       * 会覆盖已有记录的逆操作必须带 CAS 凭据（`after`）。
       *
       * 为什么单独查这一条：`after` 是空的照样能跑 —— 撤销前找不到可比的字段，
       * 一律放行，于是"这条记录之后被别人改过"根本发现不了，撤销照旧把旧值盖回去。
       * 更要紧的是：拿掉 after，**本节其他断言都还能绿**（撤销确实回到了写入前，
       * 只是顺手把别人后来的修改擦了）。这里是唯一能守住它的地方。
       */
      for (const inv of outcome.inverse || []) {
        if (inv.op !== 'update' && inv.op !== 'restore_equipment') continue
        if (!Object.keys(inv.after || {}).length) missingCas.push(`${intent}/${inv.op}`)
      }
    }
    check('前置条件：六个写入意图都能解析并执行（否则下面的"成对"断言是空集恒真）',
      bothPaths.length + onlyClosure.length + onlyInverse.length === 6,
      `成对 ${bothPaths.length} / 只有闭包 ${onlyClosure.length} / 只有描述 ${onlyInverse.length}；${notParsed.join('；') || '全部可执行'}`)
    check('六个写入意图都**同时**给出闭包与可序列化描述（缺一份就是"刷新后撤不了"或"当次撤不了"）',
      onlyClosure.length === 0 && onlyInverse.length === 0,
      onlyClosure.length || onlyInverse.length
        ? `只有闭包：${onlyClosure.join('、')}；只有描述：${onlyInverse.join('、')}`
        : '6/6 成对')
    check('会覆盖已有记录的逆操作都带 CAS 凭据（after 为空 = 并发检查形同虚设）',
      missingCas.length === 0,
      missingCas.length ? `缺 after：${missingCas.join('、')}` : '全部带 after')
    // 这里不清栈：六条都执行了但都没撤，栈里留着 6 条活记录 —— 下面的断言全部
    // 按 id 定位（performUndo(id)），不受栈里还有别的条目影响。

    // ---------- B. 两条路同结果（反漂移） ----------
    /**
     * 同一场景走两遍：第一遍用闭包撤，第二遍用描述撤，两边都必须回到"写入前"。
     *
     * 这条断言必须能失败：把任一 inverse 的 after/before 改错一个字段，
     * 描述路径就会因为 CAS 比对失败而拒绝撤销（reverted 变少）或者撤成别的状态 ——
     * 两种都会让下面变红。
     */
    const twoPathsAgree = (text, eqId) => {
      // ⚠️ 每次取样都要**立刻深拷贝**（stripIds 里就是 JSON.parse(JSON.stringify)）。
      // 探针里的数组是活引用，写入会就地改它 —— 不留快照的话，后面拿来比对时
      // "期望"那一侧已经跟着变了，等于拿改后的状态和改后的状态比：diff 全空、
      // 断言假绿（这个坑在写这一节时真踩到了，第一次报出来的 diff 是空的）。
      const s0parts = stripIds(probeParts(store, eqId))
      const s0 = JSON.stringify(s0parts)
      const first = runIntent(store, text)
      if (!first.ok) return { ok: false, why: `第一次执行失败：${first.error}` }
      if (JSON.stringify(stripIds(probeParts(store, eqId))) === s0) {
        return { ok: false, why: '写入后状态与写入前完全一样 —— 这条断言没有意义（什么都没写进去）' }
      }
      // ① 闭包路径：直接调执行时给的那个闭包（与改造前完全一样的走法）
      first.outcome.undo()
      const closureParts = stripIds(probeParts(store, eqId))
      // 闭包跑过之后，①那条栈里的记录成了废条目。这里**故意不清理**：②要证明的是
      // "按 id 撤销只影响这一条"，栈里躺着一个废条目正好是它的反例背景。
      // ② 描述路径：再写一次，然后走 performUndo（撤销时优先用 inverse）
      const second = runIntent(store, text)
      if (!second.ok) return { ok: false, why: `第二次执行失败：${second.error}` }
      const outcome = store.performUndo(second.entry.id)
      const inverseParts = stripIds(probeParts(store, eqId))
      const closureSame = JSON.stringify(closureParts) === s0
      const inverseSame = JSON.stringify(inverseParts) === s0
      // 两条路各自与"写入前"比完之后，还要直接互相比：两边都偏离 s0 时，
      // "都偏离"不等于"偏得一样"，而用户最终看到的是描述那条路留下的状态。
      const sameAsEachOther = JSON.stringify(closureParts) === JSON.stringify(inverseParts)
      return {
        ok: closureSame && inverseSame && sameAsEachOther && outcome.ok === true,
        closureSame,
        inverseSame,
        sameAsEachOther,
        undoOk: outcome.ok === true,
        failed: outcome.failed,
        why: [
          closureSame ? '' : `闭包路径没回到写入前 → ${probeDiff(s0parts, closureParts)}`,
          inverseSame ? '' : `描述路径没回到写入前 → ${probeDiff(s0parts, inverseParts)}`,
          sameAsEachOther ? '' : `两条路结果不同 → ${probeDiff(closureParts, inverseParts)}`
        ].filter(Boolean).join(' ／ ')
      }
    }

    // 挑最复杂的一条（完成工单）：一次写入牵连工单字段 + 病历 + 健康快照 + 复诊任务
    // + 故障案例卡 + 知识草案，六个 inverse 分支里它一个就覆盖了四种。
    const completePlan = nl.parseCommand(store, `${devLabel}已经检修完了`)
    const completeItem = (completePlan.items || [])[0]
    if (completeItem && !completeItem.preflightError) {
      const r = twoPathsAgree(`${devLabel}已经检修完了`, dev.id)
      check('完成工单：闭包与描述两条路撤出同一个状态（描述写错字段这条必红）',
        r.ok, r.why || `闭包回到写入前=${r.closureSame} / 描述回到写入前=${r.inverseSame} / 撤销整体成功=${r.undoOk}${r.failed && r.failed.length ? ` / 未退回：${r.failed.join('；')}` : ''}`)
    } else {
      check('完成工单：闭包与描述两条路撤出同一个状态（描述写错字段这条必红）',
        false, `前置不成立，无法验证：${completeItem ? completeItem.preflightError : '解析不出计划项'}`)
    }

    // 再挑一条"带备件扣减"的（ADD_MAINTENANCE）：它的 inverse 里有 revert_consumption，
    // 库存与出库流水一起回滚 —— 只回滚一半（账回了、货没回）在这条上会显形。
    const r2 = twoPathsAgree(`${devLabel}换了机油和机滤`, dev.id)
    check('记维保（含备件扣减）：闭包与描述两条路撤出同一个状态（库存与流水都要回滚）',
      r2.ok, r2.why || `闭包=${r2.closureSame} / 描述=${r2.inverseSame} / 撤销成功=${r2.undoOk}${r2.failed && r2.failed.length ? ` / 未退回：${r2.failed.join('；')}` : ''}`)

    // ---------- C. CAS：写入后又被改过，必须拒绝回退而不是把旧值盖回去 ----------
    {
      const r = runIntent(store, `${devLabel}先停机别排产`)
      if (r.ok) {
        // 模拟"另一处（人在台账页 / 别的卡片）动了同一条记录"
        store.updateEquipment(dev.id, { status: 'running' })
        const guarded = probe(store, dev.id)
        const outcome = store.performUndo(r.entry.id)
        const statusNow = (store.equipmentList.find(e => e.id === dev.id) || {}).status
        check('撤销前比对写入后状态：记录被改过就拒绝回退（不拿旧值盖掉后来的修改）',
          outcome.ok === false && outcome.reverted === 0 &&
          (outcome.failed || []).some(w => /被改过/.test(w)),
          `ok=${outcome.ok} reverted=${outcome.reverted} failed=${JSON.stringify(outcome.failed || [])}`)
        check('拒绝之后数据保持"被改过"的样子（拒绝了却已经写了一半，是最坏的结果）',
          probe(store, dev.id) === guarded && statusNow === 'running',
          `status=${statusNow}`)
      } else {
        check('撤销前比对写入后状态：记录被改过就拒绝回退（不拿旧值盖掉后来的修改）',
          false, `前置不成立：${r.error}`)
        check('拒绝之后数据保持"被改过"的样子（拒绝了却已经写了一半，是最坏的结果）', false, '前置不成立')
      }
    }

    // ---------- D. 落本机存储 → 重启 → 仍能撤 ----------
    {
      const before = store.workOrders.length
      const r = runIntent(store, `${devLabel}液压系统压力偏低`)
      const id = r.ok && r.entry ? r.entry.id : null
      await store.saveNow()

      const restarted = await restartStore()
      const ns = restarted.store
      check('重启后撤销栈从本机存储恢复（不再是"刷新即失效"）',
        !!id && ns.getUndoStack().some(e => e.id === id),
        id ? `栈里 ${ns.getUndoStack().length} 条，找 ${id}：${ns.getUndoStack().some(e => e.id === id)}` : '第一次写入就没成功')
      check('hasUndo 认得恢复出来的条目（结果卡据此仍可按）',
        !!id && ns.hasUndo(id) === true, String(id))
      check('恢复出来的条目带得动逆操作描述（闭包存不进 JSON，靠的就是它）',
        !!id && ns.getUndoStack().some(e => e.id === id && Array.isArray(e.inverse) && e.inverse.length > 0))

      // id 不得复用：重启后新条目要是又拿到那个 id，卡片上的"撤销这次写入"就会撤错一条
      const fresh = ns.logVoiceAction({
        rawText: '重启后新写入（探针）',
        summary: '探针',
        changes: [],
        intentLabel: '探针',
        inverse: [{ op: 'remove', table: 'knowledge_items', id: 'ks-probe-not-exist' }]
      })
      check('重启后新条目的 id 不与恢复出来的撞（撞了就是撤错一条）',
        !!fresh && fresh.id !== id && ns.hasUndo(fresh.id) === true && ns.hasUndo(id) === true,
        fresh ? `新条目 ${fresh.id}，恢复出来的 ${id}` : '没有入栈')

      const countAfterRestart = ns.workOrders.length
      const outcome = ns.performUndo(id)
      check('跨"重启"撤销真的撤回去了（不是"按钮亮着但撤不动"）',
        outcome.ok === true && ns.workOrders.length === countAfterRestart - 1,
        `ok=${outcome.ok} 工单 ${countAfterRestart} → ${ns.workOrders.length}（原写入前 ${before}）`)
      const archived = JSON.parse(globalThis.localStorage.getItem('ks:undo-stack') || '{}')
      check('撤完必须同时从存档里删掉（否则下次启动又把撤过的摆出来，点一次撤第二次）',
        !(archived.entries || []).some(e => e.id === id),
        JSON.stringify((archived.entries || []).map(e => e.id)))
      check('按 id 撤销不影响栈里其它条目（撤一条不代表清栈）',
        ns.hasUndo(fresh.id) === true, `新条目 ${fresh.id} 还在不在：${ns.hasUndo(fresh.id)}`)
    }

    // ---------- E. 超预算：从最早的开始淘汰，且必须留一条日志 ----------
    // 断言的写法刻意与"栈里已有多少条"无关：一条 400 KB 的大条目本身在预算内，
    // 两条加起来就超 —— 于是无论前面留了多少条小记录，最后只能是"最新那条留在盘上"。
    {
      const big = (tag) => [{
        op: 'remove',
        table: 'knowledge_items',
        id: tag + 'x'.repeat(400 * 1024)
      }]
      const memBefore = store.getUndoStack().length
      store.logVoiceAction({ rawText: '大条目 A', summary: '探针', changes: [], intentLabel: '探针', inverse: big('A-') })
      const afterFirst = JSON.parse(globalThis.localStorage.getItem('ks:undo-stack') || '{}')
      store.logVoiceAction({ rawText: '大条目 B', summary: '探针', changes: [], intentLabel: '探针', inverse: big('B-') })
      const afterSecond = JSON.parse(globalThis.localStorage.getItem('ks:undo-stack') || '{}')

      check('前置条件：大条目 A 确实落到本机存储里了（否则后面"淘汰"无从谈起）',
        (afterFirst.entries || []).some(e => e.rawText === '大条目 A'),
        JSON.stringify((afterFirst.entries || []).map(e => e.rawText)))
      check('超预算时从**最早**的条目开始淘汰（留下最新的，撤的总是最近做的那些）',
        (afterSecond.entries || []).length === 1 && afterSecond.entries[0].rawText === '大条目 B',
        JSON.stringify((afterSecond.entries || []).map(e => e.rawText)))
      check('被挤出的条目在内存里仍在（"跨刷新不可用"不等于"当次也不可用"）',
        store.getUndoStack().length === memBefore + 2,
        `${memBefore} + 2 = ${memBefore + 2}，实际 ${store.getUndoStack().length}`)
      check('淘汰会写一条操作日志（能力缩水不能静默）',
        store.recentLogs.some(l => /撤销栈超出本机存储预算/.test(String(l.content || ''))),
        (store.recentLogs.find(l => /预算/.test(String(l.content || ''))) || {}).content || '没有找到日志')
    }
  }
}

// ---------------------------------------------------------------------------
rmSync(mirrorDir, { recursive: true, force: true })
console.log(`\n合计 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项`)
if (failures.length) {
  console.log(`失败项：${failures.join('；')}`)
  process.exitCode = 1
}
