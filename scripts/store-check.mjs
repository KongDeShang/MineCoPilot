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
 *     错误边界处理器行为（挂载 / 落日志 / 去重 / 自身不抛错）。
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

// ---------------------------------------------------------------------------
rmSync(mirrorDir, { recursive: true, force: true })
console.log(`\n合计 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项`)
if (failures.length) {
  console.log(`失败项：${failures.join('；')}`)
  process.exitCode = 1
}
