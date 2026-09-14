/**
 * 矿山智工 - 本地核心逻辑自检
 *
 * 覆盖：
 *   A 日期工具（相对日期、超期计算、非法日期不产生 NaN）
 *   B sql.js 持久化（建库 → 写入 → 落盘 → 重新载入 → 数据还在）
 *   C Excel 解析与多源合并（真实构造 xlsx 读回来）
 *   D 台账导入逻辑（upsert + 维保记录 + 日期序列号）
 *   E 知识库检索（可溯源命中 + 未命中不编造）与台账实时问答
 *
 * 运行：node scripts/self-check.mjs   （在项目根目录执行）
 *
 * 说明：项目是 CommonJS（Electron 主进程需要），而渲染层源码是 ESM，
 * 因此脚本会先把 utils 源码镜像成 .mjs 再导入，跑的是项目真实代码，不是复制品。
 */
import initSqlJsImport from 'sql.js'
import * as XLSX from 'xlsx'
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const srcDir = join(root, 'src', 'renderer', 'src', 'utils')
const mirrorDir = join(root, '.tmp-selfcheck')

// ---- 生成 ESM 镜像，让 Node 能直接导入项目真实模块 ----
rmSync(mirrorDir, { recursive: true, force: true })
mkdirSync(mirrorDir, { recursive: true })
// 这份清单是**显式**的，不做目录扫描：镜像进来的模块会在 Node 里被真实导入，
// 而 utils 下将来可能出现依赖浏览器/组件库的文件，扫进来会直接崩在这里。
// 代价是新增 util 时必须手动登记 —— htmlIcons 就是这么被漏掉的：
// knowledgeBase / reportGenerator 开始 import 它之后，镜像里没有对应文件，
// self-check 抛 ERR_MODULE_NOT_FOUND 整个中断（verify 的前置步骤，全链路失败）。
// 以后再往 utils 加纯函数模块，记得同步加到这里。
for (const name of ['dates', 'html', 'htmlIcons', 'appIcons', 'storage', 'database', 'excelParser', 'synonyms', 'knowledgeBase', 'health', 'equipmentCatalog', 'fleetData', 'healthReport', 'faultStats', 'nlCommand', 'llmClient', 'narrate', 'reportGenerator', 'dictionaries', 'bundledDocs', 'faultCaseDraft', 'demoTour']) {
  const code = readFileSync(join(srcDir, `${name}.js`), 'utf8')
    .replace(/(from\s+['"]\.\/[a-zA-Z0-9_-]+)(['"])/g, '$1.mjs$2')
  writeFileSync(join(mirrorDir, `${name}.mjs`), code, 'utf8')
}

// sql.js 在 Node 下需要显式 wasm 路径（浏览器/Electron 打包时由打包器处理）
const wasmPath = decodeURIComponent(
  join(root, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm').replace(/\\/g, '/')
)
const initSqlJs = (options = {}) => initSqlJsImport({ ...options, locateFile: () => wasmPath })
globalThis.__DSH_INIT_SQL_JS__ = initSqlJs

// ---- 浏览器环境桩：让渲染层代码在 Node 下可跑 ----
const fakeStorage = new Map()
globalThis.localStorage = {
  getItem: (k) => (fakeStorage.has(k) ? fakeStorage.get(k) : null),
  setItem: (k, v) => fakeStorage.set(k, String(v)),
  removeItem: (k) => fakeStorage.delete(k)
}
globalThis.window = globalThis.window || {}
globalThis.indexedDB = undefined

// FileReader 桩：Node 没有浏览器 API，用文件对象的 arrayBuffer() 模拟读取
globalThis.FileReader = class {
  readAsArrayBuffer(file) {
    Promise.resolve(file.arrayBuffer()).then(
      (buffer) => setTimeout(() => this.onload && this.onload({ target: { result: buffer } }), 0),
      (error) => setTimeout(() => this.onerror && this.onerror(error), 0)
    )
  }
}

const mirror = (name) => pathToFileURL(join(mirrorDir, `${name}.mjs`)).href

const dates = await import(mirror('dates'))
const database = await import(mirror('database'))
const excelParser = await import(mirror('excelParser'))
const kb = await import(mirror('knowledgeBase'))
const health = await import(mirror('health'))
const catalog = await import(mirror('equipmentCatalog'))
const fleet = await import(mirror('fleetData'))
const healthReport = await import(mirror('healthReport'))
const faultStats = await import(mirror('faultStats'))
const nl = await import(mirror('nlCommand'))
const llmC = await import(mirror('llmClient'))
const narrate = await import(mirror('narrate'))
const reportGen = await import(mirror('reportGenerator'))
const caseDraft = await import(mirror('faultCaseDraft'))

const results = []
function check(name, condition, detail = '') {
  results.push({ name, ok: !!condition, detail: String(detail).slice(0, 200) })
}

// ============ A 日期工具 ============
{
  check('daysAgoDate(0) 等于今天', dates.daysAgoDate(0) === dates.formatDate(new Date()), dates.daysAgoDate(0))
  check('parseDate 非法输入返回 null', dates.parseDate('') === null && dates.parseDate('不是日期') === null)
  check('daysSince 空值返回 null（不产生 NaN）', dates.daysSince('') === null && dates.daysSince(null) === null)
  check('equipmentAgeYears 空值返回 null', dates.equipmentAgeYears('') === null)
  check('equipmentAgeYears 正常值可用', dates.equipmentAgeYears(dates.daysAgoDate(365)) > 0.9)

  const shifted = dates.shiftDate('2026-09-12 09:30', dates.seedShiftDays())
  check('shiftDate 保留时间部分', /^\d{4}-\d{2}-\d{2} 09:30$/.test(shifted), shifted)

  // 超期计算：上次维保 100 天前、周期 90 天 → 超期 10 天
  const until = dates.daysUntilDue(dates.daysAgoDate(100), 90)
  check('daysUntilDue 超期计算正确', until === -10, `until=${until}`)
  const soon = dates.daysUntilDue(dates.daysAgoDate(86), 90)
  check('daysUntilDue 即将到期计算正确', soon === 4, `soon=${soon}`)
}

// ============ A2 日期范围必须按本地时区（UTC 差一回归） ============
{
  // 这类 bug 白天跑测试永远发现不了：toISOString() 会先转 UTC，
  // 东八区下「今天」在 00:00–07:59 之间会被算成昨天；
  // 月初更隐蔽 —— new Date(y, m, 1) 是本地零点，转 UTC 落在上个月最后一天，
  // 于是 9 月月报的范围变成 8-31 ~ 9-13，凭空多出一天上个月的数据。
  const week = reportGen.getPeriodRange('week')
  const month = reportGen.getPeriodRange('month')
  const todayStr = dates.formatDate(new Date())

  check('周报范围结束于今天（本地时区，非 UTC）', week.end === todayStr, `${week.end} vs ${todayStr}`)
  check('月报范围结束于今天（本地时区，非 UTC）', month.end === todayStr, `${month.end} vs ${todayStr}`)
  check('月报范围从本月 1 号开始（不是上个月最后一天）',
    month.start.slice(0, 7) === todayStr.slice(0, 7) && month.start.endsWith('-01'),
    `start=${month.start}，期望 ${todayStr.slice(0, 7)}-01`)

  const weekStartDay = new Date(`${week.start}T00:00:00`).getDay()
  check('周报范围从周一开始', weekStartDay === 1, `start=${week.start}，星期${weekStartDay}`)
  check('周报起始日不晚于今天', week.start <= todayStr, `${week.start} <= ${todayStr}`)
  check('周报标签含年月与周次', /^\d{4}年\d{1,2}月第\d+周$/.test(week.label), week.label)
  check('月报标签含年月', /^\d{4}年\d{1,2}月$/.test(month.label), month.label)

  // 源码级防回归：全仓不允许再出现 toISOString().slice(0,10) 这种"假装是本地日期"的写法。
  // 生成完整时间戳（不带 slice）是合法的，只有截成日期串才是 bug。
  const offenders = []
  for (const dir of ['src/renderer/src', 'src/main', 'src/preload']) {
    const walk = (d) => {
      for (const entry of readdirSync(join(root, dir, d), { withFileTypes: true })) {
        const rel = d ? `${d}/${entry.name}` : entry.name
        if (entry.isDirectory()) { walk(rel); continue }
        if (!/\.(js|mjs|vue)$/.test(entry.name)) continue
        const code = readFileSync(join(root, dir, rel), 'utf8')
        if (/toISOString\(\)\.slice\(\s*0\s*,\s*10\s*\)/.test(code)) offenders.push(`${dir}/${rel}`)
      }
    }
    walk('')
  }
  check('全仓不再用 toISOString().slice(0,10) 冒充本地日期',
    offenders.length === 0, offenders.join('、') || '无')
}

// ============ A3 报告内所有数字必须是同一口径 ============
{
  // 回归：复诊闭环率曾经取的是 store.recheckStats（全车队**累计**），
  // 而同一段"车队概况"里的新增/已完成都是**本周期**过滤过的。
  // 于是周报会写出「本周新增 3 单、已完成 2 单、闭环率 70%」——
  // 三个数字摆在一起，只有第三个不是本周的，且没有任何标注。
  const { start } = reportGen.getPeriodRange('week')
  const beforeRange = '2000-01-01T09:00:00'

  const mk = (id, created, completed, recheck) => ({
    id, equipment_id: id, equipment_name: `设备${id}`, title: '测试工单', type: 'repair',
    status: completed ? 'completed' : 'pending', created_at: created,
    completed_at: completed, recheck_status: recheck
  })

  const workOrders = [
    // 本周期内完成：1 单已复诊 / 1 单待复诊
    mk(1, `${start}T09:00:00`, `${start}T18:00:00`, 'done'),
    mk(2, `${start}T09:00:00`, `${start}T18:00:00`, 'pending'),
    // 历史遗留：区外完成但已复诊 —— 只有累计口径才该数到它
    mk(3, beforeRange, beforeRange, 'done')
  ]

  const stub = {
    equipmentList: [], equipmentWithHealth: [], healthLevelStats: { A: 0, B: 0, C: 0, D: 0 },
    criticalList: [], worseningList: [], upcomingList: [], recheckList: [], overdueList: [],
    faultTopStats: [], getSnapshots: () => [],
    workOrders,
    recheckStats: {
      due: 3, done: 2, pending: 1, rate: 67
    }
  }

  const data = reportGen.generateReportData(stub, 'week')
  const ov = data.overview

  check('本周期复诊口径只统计本周期完成的工单',
    ov.periodRecheckTotal === 2 && ov.periodRecheckDone === 1,
    `periodRecheck ${ov.periodRecheckDone}/${ov.periodRecheckTotal}，期望 1/2（区外那单不该计入）`)
  check('本周期复诊率按本周期分母算',
    ov.periodRecheckRate === 50, `${ov.periodRecheckRate}%，期望 50%`)
  check('累计复诊口径保持原样，未被周期过滤污染',
    ov.recheckTotal === 3 && ov.recheckDone === 2 && ov.recheckRate === 67,
    `${ov.recheckDone}/${ov.recheckTotal} = ${ov.recheckRate}%`)

  const html = reportGen.renderReportHTML(data)
  check('报告里复诊一行同时标出两个口径',
    html.includes('本周期完成单中复诊') && html.includes('全车队累计'),
    html.match(/复诊闭环：[^<]*/)?.[0] || '未渲染复诊行')

  // 无本周期完成单时，不该冒出"本周期 0/0（NaN%）"这种空口径
  const emptyHtml = reportGen.renderReportHTML(reportGen.generateReportData(
    { ...stub, workOrders: [mk(3, beforeRange, beforeRange, 'done')] }, 'week'))
  check('本周期无完成单时不渲染本周期复诊口径',
    !emptyHtml.includes('本周期完成单中复诊') && emptyHtml.includes('全车队累计'),
    emptyHtml.match(/复诊闭环：[^<]*/)?.[0] || '未渲染复诊行')
}

// ============ B sql.js 持久化 ============
{
  await database.initDatabase()
  check('数据库初始化成功', database.isReady())
  check('核心表已创建', ['equipment', 'maintenance_records', 'work_orders', 'meta']
    .every(t => database.query('SELECT name FROM sqlite_master WHERE name = ?', [t]).length === 1))
  check('空库行数为 0', database.count('equipment') === 0)

  database.replaceAll({
    equipment: [{
      id: 1, name: '1号挖掘机', model: 'CAT 320D', category: '挖掘机', location: 'A矿区',
      purchase_date: '2021-03-15', status: 'running', maintenance_cycle_days: 90,
      last_maintenance_date: dates.daysAgoDate(100), notes: null,
      created_at: dates.now(), updated_at: dates.now()
    }],
    maintenance_records: [],
    work_orders: []
  })
  check('写入后台账行数为 1', database.count('equipment') === 1)

  const written = await database.persist()
  check('persist 真的写盘了', written === true)
  check('写盘后不再是脏状态', database.isDirty() === false)
  check('再次 persist 无变更时跳过写入', (await database.persist()) === false)

  const bytes = database.exportBytes()
  check('导出字节流长度合理', bytes.length > 1000, `len=${bytes.length}`)
  check('存储层已真正持久化', fakeStorage.size > 0, `keys=${[...fakeStorage.keys()].join(',')}`)

  // 模拟重启：销毁内存实例 → 从持久化存储重新载入
  await database.destroyDatabase()
  await database.initDatabase()
  const rows = database.all('equipment')
  check('重启后数据仍在（关键）', rows.length === 1, `count=${rows.length}`)
  check('重启后字段完整', rows[0]?.name === '1号挖掘机' && rows[0]?.model === 'CAT 320D', JSON.stringify(rows[0] || {}))

  // 归档标记必须真的落库：它决定「完成 → 退回处理中 → 再完成」会不会重做一遍副作用，
  // 只活在内存里的话，重启一次这道闸门就失效了。
  database.replaceAll({
    work_orders: [{
      id: 9001, equipment_id: 1, equipment_name: '1号挖掘机', title: '归档回归单',
      status: 'completed', type: 'repair', created_at: '2026-09-01 09:00:00',
      completed_at: '2026-09-02 18:00:00', archived_at: '2026-09-02 18:00:00',
      recheck_status: 'pending'
    }]
  })
  await database.persist(true)
  await database.destroyDatabase()
  await database.initDatabase()
  const archived = database.all('work_orders')[0]
  check('归档标记重启后仍在（否则归档幂等会被绕过）',
    archived?.archived_at === '2026-09-02 18:00:00', JSON.stringify(archived || {}))

  // 老库回填：completed_at 有值但 archived_at 为 NULL 的已完成单，启动时自动补上
  database.execute("UPDATE work_orders SET archived_at = NULL WHERE id = 9001")
  await database.persist(true) // 必须写盘，否则 NULL 只留在内存里，回填根本没被触发
  await database.destroyDatabase()
  await database.initDatabase()
  const backfilled = database.all('work_orders')[0]
  check('老库启动时回填已归档标记（迁移补数据）',
    backfilled?.archived_at === '2026-09-02 18:00:00', JSON.stringify(backfilled || {}))
}

// ============ B2 建表列必须全部接进写库映射 ============
{
  // 回归：archived_at 加进了建表语句、也加进了迁移，却漏在 workOrdersToRows 里。
  // 列建好了却永远写不进去，重启后归档标记全丢 —— 「完成 → 退回处理中 → 再完成」
  // 于是又把病历/快照/复诊/案例卡重做一遍。同一会话内一切正常，所以行为测试抓不到，
  // 只能对源码做结构校验。
  // 行映射集中在 stores/persistence.js；appStore 也一起扫，
  // 免得哪天有人图省事又在 store 里就地拼一份映射，从这道检查底下溜过去。
  const SOURCES = ['src/renderer/src/stores/persistence.js', 'src/renderer/src/stores/appStore.js']
    .map(rel => ({ rel, code: readFileSync(join(root, rel), 'utf8') }))

  const bodyOf = (name) => {
    for (const { code } of SOURCES) {
      const m = code.match(new RegExp(`function ${name}\\(\\)\\s*\\{([\\s\\S]*?)\\n  \\}`))
      if (m) return { body: m[1] }
    }
    return null
  }

  // 只校验**写库**这一侧。读库那侧有正当的省略（created_at / updated_at 只是审计字段，
  // 读回来也没人用；设备台账的 created_at 同理），一刀切地要求"列列都读"会误报。
  // 而写库没有正当省略：表里有这一列，却不给值，那这列就是死的。
  const mappers = [
    ['work_orders', 'workOrdersToRows'],
    ['equipment', 'equipmentToRows'],
    ['maintenance_records', 'maintenanceToRows'],
    ['parts_inventory', 'partsToRows'],
    ['operation_logs', 'logsToRows'],
    ['parts_transactions', 'partTxToRows'],
    ['health_snapshots', 'healthSnapshotsToRows'],
    ['fault_cases', 'faultCasesToRows']
  ]

  for (const [table, writeFn] of mappers) {
    const found = bodyOf(writeFn)
    if (!found) {
      check(`${table} 的写库映射 ${writeFn} 可被定位`, false,
        `在 ${SOURCES.map(s => s.rel).join('、')} 里都没找到函数体`)
      continue
    }
    const columns = database.query(`PRAGMA table_info(${table})`).map(r => r.name)
    const missWrite = columns.filter(c => !found.body.includes(`${c}:`))
    check(`${table} 的每一列都接进了写库映射（${writeFn}）`,
      missWrite.length === 0, missWrite.join('、') || `${columns.length} 列齐全`)
  }
}

// ============ C0 示例 Excel 必须与机型/配件目录自洽 ============
{
  // 示例数据是演示的第一步："加载演示数据 → 一键导入台账"。
  // 机型要是写了目录外的，导入进来的台账当场就是"品类校验认不出"的脏数据，
  // 演示第一步就卡住；配件规格要是和目录对不上，同名件会分裂成两条库存记录。
  const samples = excelParser.generateSampleData()
  const allRows = samples.flatMap(f => f.sheets.flatMap(s => s.rows))
  const equipmentRows = allRows.filter(r => r['设备名称'] && r['设备型号'] && r['设备类别'])
  const partRows = allRows.filter(r => r['配件名称'] && r['数量'] !== undefined)

  check('示例数据含 5 个部门的表格', samples.length === 5, String(samples.length))
  check('示例数据含设备清单', equipmentRows.length >= 8, `${equipmentRows.length} 行`)

  const unknownModel = equipmentRows.filter(r => !catalog.categoryOfModel(r['设备型号']))
  check('示例设备的机型都在机型白名单里（导入不会被品类校验拦下）',
    unknownModel.length === 0,
    unknownModel.map(r => r['设备型号']).join('、') || `${equipmentRows.length} 个机型全部登记在册`)

  const wrongCategory = equipmentRows.filter(r => catalog.categoryOfModel(r['设备型号']) !== r['设备类别'])
  check('示例设备的品类与机型对得上（不出现"压路机写成破碎机"）',
    wrongCategory.length === 0,
    wrongCategory.map(r => `${r['设备型号']}→${r['设备类别']}`).join('、') || '全部一致')

  const xu = equipmentRows.filter(r => catalog.brandOfModel(r['设备型号']) === '徐工').length
  check('示例车队以徐工为主（不是一排竞品机型）',
    xu / equipmentRows.length >= 0.6,
    `徐工 ${xu}/${equipmentRows.length}`)

  // 同名件必须与 PARTS_CATALOG 的规格一致，否则库存里会出现两条"液压油46号"
  const specOf = new Map(catalog.PARTS_CATALOG.map(p => [p.name, p.spec]))
  const specMismatch = partRows
    .filter(r => specOf.has(r['配件名称']) && specOf.get(r['配件名称']) !== r['设备型号'])
    .map(r => `${r['配件名称']}：示例「${r['设备型号']}」/ 目录「${specOf.get(r['配件名称'])}」`)
  check('示例配件的规格与配件目录一致（同名件不会被归并成两行）',
    specMismatch.length === 0, specMismatch.join('、') || `${partRows.length} 行规格一致`)
}

// ============ C Excel 解析与合并 ============
{
  // 构造两个"不同部门"的表格：字段名不同、表头前有空行
  const sheetA = [
    ['生产部设备清单'],
    ['设备名称', '型号', '类别', '所在矿区', '购置时间', '运行状态'],
    ['1号挖掘机', 'CAT 320D', '挖掘机', 'A矿区', '2021-03-15', '运行中'],
    ['2号挖掘机', '小松PC200', '挖掘机', 'A矿区', '2020-08-20', '运行中']
  ]
  const sheetB = [
    ['设备名', '保养日期', '保养内容', '维修人', '配件名称'],
    ['1号挖掘机', '2026-08-15', '更换液压油', '张工', '液压油46号'],
    ['9号装载机', '2026-09-01', '首保', '李工', '机油滤芯']
  ]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheetA), '设备清单')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheetB), '维保记录')
  const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })

  const parsed = await excelParser.parseExcelFile({
    name: '多部门合并表.xlsx',
    arrayBuffer: async () => buffer
  })
  check('解析出多个工作表', parsed.sheets.length === 2, `sheets=${parsed.sheets.length}`)
  check('能跳过标题行找到表头', parsed.sheets[0].headers.includes('设备名称'), JSON.stringify(parsed.sheets[0].headers))
  check('表头别名映射生效（设备名→设备名称）', parsed.sheets[1].headerMapping['设备名'] === '设备名称',
    JSON.stringify(parsed.sheets[1].headerMapping))
  check('配件名称不被误映射为设备名称（回归）',
    parsed.sheets[1].headerMapping['配件名称'] === '配件名称',
    JSON.stringify(parsed.sheets[1].headerMapping))
  check('同一标准字段不会被两个表头重复占用',
    new Set(Object.values(parsed.sheets[0].headerMapping)).size === Object.keys(parsed.sheets[0].headerMapping).length,
    JSON.stringify(parsed.sheets[0].headerMapping))
  check('所在矿区映射到统一字段', parsed.sheets[0].headerMapping['所在矿区'] === '所在位置',
    JSON.stringify(parsed.sheets[0].headerMapping))

  const merged = excelParser.mergeExcelResults([parsed])
  check('合并后标准字段对齐', merged.rows[0]['设备名称'] === '1号挖掘机', JSON.stringify(merged.rows[0]))
  check('合并后行数正确', merged.rows.length === 4, `rows=${merged.rows.length}`)
}

// ============ D 台账导入逻辑（复刻 store.importFromExcel 的核心路径） ============
{
  function normalizeDateCell(value) {
    if (value === undefined || value === null || value === '') return ''
    if (value instanceof Date) return dates.formatDate(value)
    if (typeof value === 'number') {
      const ms = Math.round((value - 25569) * 86400 * 1000)
      const date = new Date(ms)
      return Number.isNaN(date.getTime()) ? '' : dates.formatDate(date)
    }
    const parsed = dates.parseDate(value)
    return parsed ? dates.formatDate(parsed) : String(value).trim()
  }

  check('Excel 日期序列号可转换',
    normalizeDateCell(45000) === dates.formatDate(new Date(Math.round((45000 - 25569) * 86400 * 1000))),
    normalizeDateCell(45000))
  check('斜杠日期补零规范化', normalizeDateCell('2026/8/15') === '2026-08-15', normalizeDateCell('2026/8/15'))
  check('空日期返回空串', normalizeDateCell('') === '')
  check('无法识别的日期原样保留', normalizeDateCell('不詳') === '不詳', normalizeDateCell('不詳'))

  // upsert：同名设备只更新、不同名设备新增
  const ledger = new Map([['1号挖掘机', { id: 1, name: '1号挖掘机', model: 'CAT 320D', location: 'A矿区' }]])
  const rows = [
    { 设备名称: '1号挖掘机', 设备型号: 'CAT 320D', 所在位置: 'A矿区', 维保日期: '2026-08-15', 维保内容: '更换液压油', 维保人员: '张工' },
    { 设备名称: '9号装载机', 设备型号: '柳工ZL50CN', 所在位置: 'D矿区', 维保日期: '2026-09-01', 维保内容: '首保', 维保人员: '李工' },
    { 设备型号: '无名字段', 维保日期: '2026-09-01' }
  ]
  let created = 0, updated = 0, records = 0, skipped = 0
  const fake = { addEquipment: (eq) => { ledger.set(eq.name, { id: ledger.size + 1, ...eq }); created++; return ledger.get(eq.name) } }
  for (const row of rows) {
    const name = String(row['设备名称'] ?? '').trim()
    if (!name) { skipped++; continue }
    if (ledger.get(name)) updated++
    else fake.addEquipment({ name, model: row['设备型号'] || '' })
    if (row['维保日期'] && row['维保内容']) records++
  }
  check('导入：同名设备更新而非重复新增', updated === 1 && created === 1, `created=${created} updated=${updated}`)
  check('导入：无设备名的行被跳过', skipped === 1, `skipped=${skipped}`)
  check('导入：维保记录可生成', records === 2 && ledger.size === 2, `records=${records} size=${ledger.size}`)
}

// ============ E 知识库与台账问答 ============
{
  check('知识库条目数 ≥ 30（含徐工系列条目）', kb.KNOWLEDGE_BASE.length >= 30, String(kb.KNOWLEDGE_BASE.length))
  check('每条知识都有来源（可溯源前提）',
    kb.KNOWLEDGE_BASE.every(e => e.id && e.title && e.category && e.source),
    kb.KNOWLEDGE_BASE.filter(e => !e.source).map(e => e.title).join(','))
  check('每条知识都有原因与步骤（不是空壳）',
    kb.KNOWLEDGE_BASE.every(e => e.causes?.length && e.steps?.length))
  check('含徐工系列条目',
    kb.KNOWLEDGE_BASE.filter(e => e.id.startsWith('xugong-')).length >= 8,
    String(kb.KNOWLEDGE_BASE.filter(e => e.id.startsWith('xugong-')).length))
  // 红线：不得出现"具体型号 + 具体规格值"。给出通用参考数值时必须带 caveat 声明以手册为准。
  const SPEC_UNIT_RE = /\d+(\.\d+)?\s*(MPa|kN|N·m|kW|rpm|℃|°C)/
  const numeralsWithoutCaveat = kb.KNOWLEDGE_BASE.filter(e => {
    const text = [...(e.causes || []), ...(e.steps || []), e.symptoms || ''].join(' ')
    return SPEC_UNIT_RE.test(text) && !e.caveat
  })
  check('出现具体规格数值的条目都带 caveat（不会把参考值当结论）',
    numeralsWithoutCaveat.length === 0,
    numeralsWithoutCaveat.map(e => e.id).join(',') || '无')

  // 具体型号（如 XE215C）+ 具体规格值 的组合一律禁止（编造参数的最典型形态）
  const modelWithSpec = kb.KNOWLEDGE_BASE.filter(e => {
    const text = [e.title, ...(e.causes || []), ...(e.steps || [])].join(' ')
    const hasConcreteModel = /(XE|XDE|XDA|LW|XKY|XGY|XPY|XS|GR|SD)\d{2,}[A-Z]*/.test(text)
    return hasConcreteModel && SPEC_UNIT_RE.test(text)
  })
  check('不存在"具体型号 + 具体规格值"的编造式断言',
    modelWithSpec.length === 0, modelWithSpec.map(e => e.id).join(',') || '无')

  // 徐工系列条目若标题未点名具体系列，必须给出口径说明
  const genericXugong = kb.KNOWLEDGE_BASE.filter(e =>
    e.id.startsWith('xugong-') &&
    !/(XE|XDE|XDA|LW|XKY|XGY|XPY|XS|GR|SD)/.test(e.title) &&
    !e.caveat)
  check('通用系列条目带口径说明', genericXugong.length === 0, genericXugong.map(e => e.id).join(',') || '无')

  check('知识库覆盖类别数 ≥ 8',
    new Set(kb.KNOWLEDGE_BASE.map(e => e.category)).size >= 8,
    [...new Set(kb.KNOWLEDGE_BASE.map(e => e.category))].join('、'))

  const xugongEntries = kb.KNOWLEDGE_BASE.filter(e => e.id.startsWith('xugong-'))
  const xugongWithoutSeries = xugongEntries.filter(e => !/(XE|XDE|XDA|LW|XKY|XGY|XPY|XS|GR|SD)/.test(e.title))
  check('徐工系列条目使用系列名而非编造型号',
    xugongEntries.length >= 8 && xugongWithoutSeries.length === 0,
    `共 ${xugongEntries.length} 条，未含系列名：${xugongWithoutSeries.map(e => e.title).join('、') || '无'}`)

  const hits = kb.searchKnowledge('液压油压力偏低可能是什么原因？')
  check('知识库能命中液压压力条目', hits[0]?.entry.id === 'hydraulic-low-pressure', hits[0]?.entry.id)
  check('命中条目带可溯源出处', !!hits[0]?.entry.source, hits[0]?.entry.source)

  const brake = kb.searchKnowledge('矿卡刹车多久检查')
  check('知识库能命中制动条目', brake.some(h => h.entry.id === 'mining-truck-brake'),
    brake.map(h => h.entry.id).join(','))

  const none = kb.searchKnowledge('今天天气怎么样')
  check('无关问题不命中任何条目', none.length === 0, `hits=${none.length}`)

  // 台账实时问答：数字必须来自数据，而不是写死
  const overdueEquipment = {
    id: 6, name: '6号钻机', model: '阿特拉斯D65', category: '钻机', location: 'C矿区',
    purchase_date: dates.daysAgoDate(365 * 6), status: 'fault',
    last_maintenance_date: dates.daysAgoDate(150), maintenance_cycle_days: 60
  }
  const mockStore = {
    equipmentList: [overdueEquipment, {
      id: 1, name: '1号挖掘机', model: 'CAT 320D', category: '挖掘机', location: 'A矿区',
      purchase_date: dates.daysAgoDate(365 * 5), status: 'running',
      last_maintenance_date: dates.daysAgoDate(10), maintenance_cycle_days: 90
    }],
    workOrders: [{ id: 1003, title: '钻杆振动异常排查', equipment_name: '6号钻机', priority: 'urgent', status: 'pending' }],
    stats: { equipmentCount: 2, runningCount: 1, maintenanceCount: 0, faultCount: 1, idleCount: 0 },
    overdueList: [{ name: '6号钻机', model: '阿特拉斯D65', overdueDays: 90, last_maintenance_date: dates.daysAgoDate(150) }],
    upcomingList: [],
    getMaintenanceByEquipmentId: () => [{
      date: dates.daysAgoDate(150), type: '部件更换', description: '钻头磨损更换', technician: '张工'
    }],
    getTrend: () => health.evaluateTrend([
      { date: dates.daysAgoDate(60), score: 55 },
      { date: dates.daysAgoDate(30), score: 45 },
      { date: dates.daysAgoDate(0), score: 30 }
    ]),
    getEquipmentByName: (n) => (n === '6号钻机' ? overdueEquipment : null)
  }

  const answer = kb.answerQuestion(mockStore, '6号钻机上次保养是什么时候？')
  check('问具体设备走台账通道', answer.source === 'ledger', answer.source)
  check('答案包含真实超期天数 90', answer.html.includes('90'), answer.html.slice(0, 120))
  check('答案引用了本地台账作为依据', answer.refs[0]?.includes('本地台账'), answer.refs.join('|'))

  const overdueAnswer = kb.answerQuestion(mockStore, '哪些设备维保已超期？')
  check('超期问答包含设备名与天数', overdueAnswer.html.includes('6号钻机') && overdueAnswer.html.includes('90'))

  const kbAnswer = kb.answerQuestion(mockStore, '发动机过热怎么排查？')
  check('规程问题走知识库通道', kbAnswer.source === 'knowledge', kbAnswer.source)
  check('规程答案带出处', kbAnswer.refs.length > 0)

  // 健康体检问答分支
  const healthAnswer = kb.answerQuestion(mockStore, '6号钻机健康怎么样？')
  check('问设备健康走台账通道', healthAnswer.source === 'ledger', healthAnswer.source)
  check('健康问答含健康分与等级', /健康分/.test(healthAnswer.html) && /\d+/.test(healthAnswer.html),
    healthAnswer.html.slice(0, 80))
  check('健康问答含四因子名称',
    ['维保及时性', '设备机龄', '故障状态', '数据完整度'].every(n => healthAnswer.html.includes(n)))
  check('健康问答给出处置建议', healthAnswer.html.includes('处置建议'))
  check('健康问答说明数字来源（可审计）', healthAnswer.html.includes('实时计算'))

  const detailAnswer = kb.answerQuestion(mockStore, '6号钻机上次保养是什么时候？')
  check('问维保时间走明细分支（不含四因子）',
    detailAnswer.source === 'ledger' && !detailAnswer.html.includes('数据完整度'))

  const missAnswer = kb.answerQuestion(mockStore, '帮我写一首诗')
  check('未命中时不编造答案', missAnswer.source === 'none' && missAnswer.html.includes('查不到'), missAnswer.source)
}

// ============ E2 知识库管理（M 项：新增/编辑/删除即时生效） ============
{
  // 深拷贝：改默认数组的返回值绝不能污染 KNOWLEDGE_BASE 常量
  const copy = kb.buildDefaultKnowledge()
  copy[0].title = '被改坏的标题'
  copy[0].keywords.push('污染词')
  check('buildDefaultKnowledge 返回深拷贝（不污染常量）',
    kb.KNOWLEDGE_BASE[0].title !== '被改坏的标题' &&
    !kb.KNOWLEDGE_BASE[0].keywords.includes('污染词') &&
    copy.length === kb.KNOWLEDGE_BASE.length,
    `${copy.length} / ${kb.KNOWLEDGE_BASE.length}`)

  // 模拟"现场录一条新案例"：add → 检索即时命中（这就是演示爆点的逻辑基础）
  const customItems = kb.buildDefaultKnowledge()
  customItems.unshift({
    id: 'custom-demo-1',
    title: 'XE215C 回转马达异响排查',
    category: '液压系统',
    keywords: ['XE215C', '回转马达', '异响', '顿挫'],
    symptoms: '回转时异响，伴有顿挫感',
    causes: ['回转马达轴承磨损', '行星减速机构润滑不足'],
    steps: ['停机检查回转马达油位与油质', '转动回转检查异响部位', '必要时拆检回转马达轴承'],
    source: '现场案例 - 2026-09'
  })

  const hit = kb.searchKnowledge('徐工 XE215C 回转马达异响', customItems)
  check('新增条目后检索立即命中（经验传承的实锤）',
    hit.some(h => h.entry.id === 'custom-demo-1'), hit.map(h => h.entry.id).join(','))

  // 编辑后：标题改了，新关键词仍能命中
  const edited = customItems.map(item =>
    item.id === 'custom-demo-1'
      ? { ...item, title: 'XE215C 回转马达顿挫排查', keywords: [...item.keywords, '顿挫感'] }
      : item)
  check('编辑条目后按新关键词仍可命中',
    kb.searchKnowledge('顿挫感', edited).some(h => h.entry.id === 'custom-demo-1'))

  // 删除后：不再命中
  const removed = edited.filter(item => item.id !== 'custom-demo-1')
  check('删除条目后不再命中',
    !kb.searchKnowledge('回转马达异响', removed).some(h => h.entry.id === 'custom-demo-1'))

  // answerQuestion 走自定义 items：问新案例带出处
  const customAnswer = kb.answerQuestion(
    { equipmentList: [], workOrders: [], stats: { equipmentCount: 0 }, overdueList: [], upcomingList: [] },
    'XE215C 回转马达异响怎么处理？',
    customItems
  )
  check('自定义条目参与 AI 助手问答并带出处',
    customAnswer.source === 'knowledge' &&
    customAnswer.refs.some(r => r.includes('现场案例')), customAnswer.refs.join(' | '))
}

// ============ F 健康评分（含历史缺陷回归） ============
{
  const daysAgo = (n) => dates.daysAgoDate(n)
  const base = (over = {}) => ({
    id: 1, name: '测试设备', model: '徐工 XE215C', category: '挖掘机', location: '测试矿区',
    purchase_date: daysAgo(365 * 2), status: 'running',
    last_maintenance_date: daysAgo(10), maintenance_cycle_days: 90, ...over
  })

  // 正常设备：无扣分
  const okEq = base()
  const okHealth = health.evaluateHealth(okEq)
  check('健康设备得满分', okHealth.score === 100 && okHealth.level === 'A',
    `${okHealth.score}/${okHealth.level}`)

  // 超期扣分：超期 10 天 → 扣 20
  const overdue10 = health.evaluateHealth(base({ last_maintenance_date: daysAgo(100) }))
  const timeliness10 = overdue10.factors.find(f => f.key === 'timeliness')
  check('超期 10 天扣 20 分', timeliness10.penalty === 20 && overdue10.score === 80,
    `penalty=${timeliness10.penalty} score=${overdue10.score}`)

  // 缺陷 1 回归：超期时不叠加"逼近周期扣 10"
  check('超期时不再叠加逼近周期扣分（缺陷1回归）',
    timeliness10.formula.includes('超期') && !timeliness10.formula.includes('80%'),
    timeliness10.formula)

  // 逼近周期（未超期）：扣 10
  const near = health.evaluateHealth(base({ last_maintenance_date: daysAgo(80) }))
  const timelinessNear = near.factors.find(f => f.key === 'timeliness')
  check('逼近周期（80/90 天）扣 10 分', timelinessNear.penalty === 10, `penalty=${timelinessNear.penalty}`)

  // 单因子扣分上限
  const extreme = health.evaluateHealth(base({ last_maintenance_date: daysAgo(400) }))
  const timelinessExtreme = extreme.factors.find(f => f.key === 'timeliness')
  check('维保扣分有上限，不会把分数压成 0（区分度）',
    timelinessExtreme.penalty === health.MAINTENANCE_PENALTY_CAP && extreme.score > 0,
    `penalty=${timelinessExtreme.penalty} score=${extreme.score}`)
  check('扣分公式说明了上限', timelinessExtreme.formula.includes('上限'), timelinessExtreme.formula)

  // 超期天数单调：超期越久分越低（未被上限压平时）
  const s1 = health.evaluateHealth(base({ last_maintenance_date: daysAgo(95) })).score
  const s2 = health.evaluateHealth(base({ last_maintenance_date: daysAgo(110) })).score
  check('超期越久健康分越低（单调）', s1 > s2, `${s1} > ${s2}`)

  // 故障状态扣 30
  const fault = health.evaluateHealth(base({ status: 'fault' }))
  check('故障状态扣 30 分', fault.factors.find(f => f.key === 'status').penalty === 30, fault.score)

  // 机龄：8 年 → 扣 15
  const old = health.evaluateHealth(base({ purchase_date: daysAgo(Math.round(8 * 365.25)) }))
  check('机龄 8 年扣 15 分', old.factors.find(f => f.key === 'age').penalty === 15,
    old.factors.find(f => f.key === 'age').formula)

  // 缺陷 2 回归：购置日期缺失不能变成"零惩罚 + NaN"
  const noDate = health.evaluateHealth(base({ purchase_date: '' }))
  const ageFactor = noDate.factors.find(f => f.key === 'age')
  const dataFactor = noDate.factors.find(f => f.key === 'data')
  check('购置日期缺失不产生 NaN（缺陷2回归）', Number.isFinite(noDate.score), `score=${noDate.score}`)
  check('购置日期缺失不奖励：机龄不扣分但数据完整度扣分',
    ageFactor.penalty === 0 && dataFactor.penalty >= 5 && noDate.score < 100,
    `age=${ageFactor.penalty} data=${dataFactor.penalty} score=${noDate.score}`)
  check('数据缺失时明确标记', ageFactor.missing === true && dataFactor.missing === true)

  // 缺陷 4 回归：四档都存在且强制升级生效
  const forced = health.evaluateHealth(base({ last_maintenance_date: daysAgo(200) }))
  check('超期 > 45 天强制为 D 级（缺陷4回归）', forced.level === 'D', `${forced.level} score=${forced.score}`)
  check('强制升级给出可解释原因', forced.escalateReasons.length > 0, forced.escalateReasons.join('；'))
  const faultForced = health.evaluateHealth(base({ status: 'fault' }))
  check('故障状态强制为 D 级', faultForced.level === 'D', faultForced.level)

  // 每个因子都必须带算式与来源（可审计的前提）
  check('所有因子都带算式与来源', okHealth.factors.every(f => f.formula && f.source),
    okHealth.factors.map(f => f.formula ? 'ok' : 'MISSING').join(','))
  check('四个因子齐全', okHealth.factors.length === 4, okHealth.factors.map(f => f.name).join('/'))
  check('总分等于 100 减扣分和', (() => {
    const h = health.evaluateHealth(base({ last_maintenance_date: daysAgo(100), status: 'fault' }))
    const sum = h.factors.reduce((n, f) => n + f.penalty, 0)
    return h.score === Math.max(0, Math.min(100, 100 - sum))
  })())

  // 风险系数
  check('A 级未超期风险系数 0.1', health.getRiskFactor('A', null) === 0.1)
  check('超期 > 30 天风险系数加成', health.getRiskFactor('A', 40) === 0.3, String(health.getRiskFactor('A', 40)))
  check('风险系数上限 0.9', health.getRiskFactor('D', 90) === 0.9, String(health.getRiskFactor('D', 90)))
}

// ============ G 停机损失估算（缺陷 3 回归） ============
{
  const daysAgo = (n) => dates.daysAgoDate(n)
  const mk = (over) => ({
    category: '挖掘机', status: 'running', last_maintenance_date: daysAgo(100),
    maintenance_cycle_days: 90, purchase_date: daysAgo(730), ...over
  })

  const runningLoss = health.estimateLoss(mk({}))
  const faultLoss = health.estimateLoss(mk({ status: 'fault' }))

  check('停机估算含完整公式', runningLoss.formula.includes('风险系数') && runningLoss.formula.includes('日产出假设'),
    runningLoss.formula)
  check('停机估算标注演示口径', runningLoss.note.includes('演示参数'))
  // 缺陷 3 回归：已趴窝设备不能算出更低损失
  check('故障设备预估停时高于运行设备（缺陷3回归）',
    faultLoss.downtimeDays > runningLoss.downtimeDays,
    `fault=${faultLoss.downtimeDays} running=${runningLoss.downtimeDays}`)
  check('故障设备估算损失不低于运行设备', faultLoss.estimatedLoss >= runningLoss.estimatedLoss)
  check('停时有上限，不出现夸张数字', faultLoss.downtimeDays <= health.DOWNTIME_CAP_DAYS,
    String(faultLoss.downtimeDays))
  check('按类别取日产出', health.dailyOutputLossOf('矿卡') === 120000 && health.dailyOutputLossOf('未知类别') === 30000)
}

// ============ H 趋势判定 ============
{
  const mkSnaps = (scores, startDaysAgo = 90) => scores.map((score, i) => ({
    date: dates.daysAgoDate(startDaysAgo - i * 15), score
  }))

  check('快照不足 3 期 → 数据积累中（不画假平线）',
    health.evaluateTrend(mkSnaps([80, 70])).kind === 'insufficient')
  check('空快照 → 数据积累中', health.evaluateTrend([]).kind === 'insufficient')

  const worsening = health.evaluateTrend(mkSnaps([90, 84, 78, 70, 62]))
  check('连续下降 → 恶化中', worsening.kind === 'worsening' && worsening.worsening === true,
    `${worsening.kind} consecutiveDown=${worsening.consecutiveDown}`)
  check('恶化中给出可读说明', worsening.summary.includes('下降'), worsening.summary)

  const steepDrop = health.evaluateTrend(mkSnaps([88, 88, 72]))
  check('单期降幅超阈值 → 恶化中', steepDrop.kind === 'worsening', `${steepDrop.kind} delta=${steepDrop.delta}`)

  check('明显上升 → 改善中', health.evaluateTrend(mkSnaps([60, 70, 80])).kind === 'improving')
  check('小幅波动 → 稳定', health.evaluateTrend(mkSnaps([80, 79, 81, 80])).kind === 'stable')
  check('趋势按日期排序（乱序输入也正确）', (() => {
    const shuffled = [{ date: dates.daysAgoDate(30), score: 70 }, { date: dates.daysAgoDate(90), score: 90 }, { date: dates.daysAgoDate(60), score: 80 }]
    const t = health.evaluateTrend(shuffled)
    return t.points[0].score === 90 && t.points[2].score === 70
  })())
}

// ============ I 机型白名单（防止品类写错） ============
{
  check('型号白名单非空', Object.keys(catalog.MODEL_WHITELIST).length >= 10,
    String(Object.keys(catalog.MODEL_WHITELIST).length))
  check('白名单每项都有品牌与类别',
    Object.values(catalog.MODEL_WHITELIST).every(v => v.brand && v.category))
  // v1 文档曾把压路机 XS223J 当成破碎机、把旋挖钻 XR150D 当成露天钻机，这里做机器校验
  check('压路机型号归入压路机类别（历史错误回归）',
    catalog.categoryOfModel('徐工 XS223J') === '压路机', String(catalog.categoryOfModel('徐工 XS223J')))
  const crushers = Object.entries(catalog.MODEL_WHITELIST)
    .filter(([, v]) => v.category === '破碎机').map(([k]) => k)
  check('破碎机使用徐工破碎设备型号（不是压路机）',
    crushers.length > 0 && crushers.every(m => /XGY|XPY/.test(m)), crushers.join(','))
  const drills = Object.entries(catalog.MODEL_WHITELIST)
    .filter(([, v]) => v.category === '钻机').map(([k]) => k)
  check('钻机使用徐工露天钻机型号（不是旋挖钻）',
    drills.length > 0 && drills.every(m => !/XR/.test(m)), drills.join(','))
  check('未登记型号返回 null 便于断言捕获', catalog.categoryOfModel('某不存在型号') === null)
  check('车队构成覆盖主要设备类别', catalog.FLEET_MIX.length >= 6, String(catalog.FLEET_MIX.length))
  check('故障现象库覆盖四个系统分类',
    ['液压系统', '动力系统', '电气系统', '底盘行走'].every(k => catalog.FAULT_LIBRARY[k]),
    Object.keys(catalog.FAULT_LIBRARY).join(','))

  // ---- 故障 → 换件 → 工时费（单一来源，防止"维修记录里换了个不相干的件"复发） ----
  const faultItems = Object.values(catalog.FAULT_LIBRARY).flatMap(g => g.items)
  const unmapped = faultItems.filter(it => !(it.title in catalog.FAULT_PARTS))
  check('每个故障条目都配了换件映射（新增条目忘配会在这里报出来）',
    unmapped.length === 0,
    unmapped.map(it => it.title).join('、') || `${faultItems.length} 条全部登记`)
  const strayTitles = Object.keys(catalog.FAULT_PARTS)
    .filter(t => !faultItems.some(it => it.title === t))
  check('换件映射里没有已删除的故障条目（映射不留孤儿）',
    strayTitles.length === 0, strayTitles.join('、') || '无孤儿')
  const badParts = [...new Set(Object.values(catalog.FAULT_PARTS).flat())]
    .filter(n => !catalog.PARTS_CATALOG.some(p => p.name === n))
  check('换件映射里的件名都在配件目录内（扣库存不会静默失效）',
    badParts.length === 0, badParts.join('、') || '全部命中')
  const noLabor = Object.keys(catalog.FAULT_LIBRARY).filter(k => !(k in catalog.LABOR_FEE))
  check('工时费覆盖全部故障系统（不换件的故障也要有成本口径）',
    noLabor.length === 0, noLabor.join('、') || Object.keys(catalog.LABOR_FEE).join('/'))
  check('工时费按系统区分（电气小活不与发动机大修同价）',
    new Set(Object.values(catalog.LABOR_FEE)).size === Object.keys(catalog.LABOR_FEE).length)
  check('确有不换件的故障条目（调整/清洗类不产生备件流水，不是漏配）',
    Object.values(catalog.FAULT_PARTS).some(list => list.length === 0))
}

// ============ I2 随包示例手册（"装完就能看到"的那几份必须真的发出去） ============
{
  const publicDir = join(root, 'src', 'renderer', 'public', 'manuals')
  const bundled = await import(mirror('bundledDocs'))
  const docs = bundled.BUNDLED_DOCS

  check('随包手册清单非空（手册库首屏不能是空的）', docs.length >= 2, String(docs.length))
  check('随包手册 id / slug 唯一（重复会让幂等导入互相覆盖）',
    new Set(docs.map(d => d.id)).size === docs.length &&
    new Set(docs.map(d => d.slug)).size === docs.length,
    docs.map(d => d.slug).join(','))

  /**
   * slug 会被主进程拼进文件路径，docs:importBundled 用这个正则挡路径穿越。
   * 这里用同一套规则再挡一次：清单里写个带中文/斜杠的 slug 主进程会静默拒绝，
   * 表现成"这份示例手册莫名其妙没进来"，而问题其实在这一行清单上。
   */
  const badSlug = docs.filter(d => !/^[a-z0-9-]{1,64}$/.test(d.slug))
  check('随包 slug 符合主进程的路径安全规则（否则会被拒绝导入）',
    badSlug.length === 0, badSlug.map(d => d.slug).join('、') || '全部合规')

  // 挑选口径里的"是车队在管机型"要能被机器验证，否则这条口径会随时间失真
  const notInFleet = docs.filter(d => !catalog.MODEL_WHITELIST[d.model])
  check('每份随包手册的机型都在机型白名单内（口径：车队在管机型）',
    notInFleet.length === 0,
    notInFleet.map(d => d.model).join('、') || docs.map(d => d.model).join(','))

  const catMismatch = docs.filter(d => (catalog.MODEL_WHITELIST[d.model] || {}).category !== d.category)
  check('随包手册的类别与机型目录一致（品类写错会让检索关键词挂错）',
    catMismatch.length === 0,
    catMismatch.map(d => `${d.model}:${d.category}`).join('、') || '一致')

  // 手册要能挂到演示车队里的设备档案上：型号得真的出现在车队构成里
  const fleetModels = new Set(catalog.FLEET_MIX.flatMap(s => [...(s.models || []), ...(s.rareModels || [])]))
  const notDeployed = docs.filter(d => !fleetModels.has(d.model))
  check('随包手册对应机型都在车队构成里（能挂到在管设备上）',
    notDeployed.length === 0,
    notDeployed.map(d => d.model).join('、') || '全部在编')

  // 资源必须真的在仓库里：只写清单不生成产物，装完依旧空空如也
  const missing = []
  const thin = []
  const textOf = {}
  for (const d of docs) {
    const pdfPath = join(publicDir, `${d.slug}.pdf`)
    const jsonPath = join(publicDir, `${d.slug}.json`)
    if (!existsSync(pdfPath) || !existsSync(jsonPath)) { missing.push(d.slug); continue }
    // 100KB 以下基本是"抽取失败写了个空壳"，不是真手册
    const pdfBytes = statSync(pdfPath).size
    if (pdfBytes < 100 * 1024) thin.push(`${d.slug}=${Math.round(pdfBytes / 1024)}KB`)
    try { textOf[d.slug] = JSON.parse(readFileSync(jsonPath, 'utf8')) } catch { textOf[d.slug] = null }
  }
  check('随包手册的 PDF 与文字层都已在仓库里（跑过 build-manual-assets 才能过）',
    missing.length === 0, missing.join('、') || docs.map(d => d.slug).join(','))
  check('随包手册不是空壳（原件 ≥ 100KB，排除生成失败写出的 0 字节文件）',
    thin.length === 0, thin.join('、') || '体积正常')

  const noText = docs.filter(d => {
    const p = textOf[d.slug]
    return !p || !(p.pages > 0) || !Array.isArray(p.chunks) || p.chunks.length === 0
  })
  check('随包手册带逐页文字层（否则降级成"仅查看"，问答不到内容）',
    noText.length === 0,
    noText.map(d => d.slug).join('、') ||
      docs.map(d => `${d.slug}:${textOf[d.slug].chunks.length} 页有文字`).join(' '))

  const badPage = docs.filter(d => {
    const p = textOf[d.slug]
    return p && p.chunks.some(c => !(Number.isInteger(c.page) && c.page >= 1 && c.page <= p.pages))
  })
  check('文字层页码都在 1..总页数 内（越界页码会生成假出处）',
    badPage.length === 0, badPage.map(d => d.slug).join('、') || '页码自洽')

  // 产物与清单是两次独立的输入（清单手改、产物重生成），对不上说明该重跑生成脚本
  const titleMismatch = docs.filter(d => textOf[d.slug] && textOf[d.slug].title !== d.title)
  check('文字层里的标题与清单标题一致（不一致说明产物过期，需重跑生成脚本）',
    titleMismatch.length === 0, titleMismatch.map(d => d.slug).join('、') || '一致')
}

// ============ J 演示数据工厂（规模与分布验收） ============
{
  const dataset = fleet.buildDemoDataset({ size: 60 })
  const audit = fleet.auditDataset(dataset)

  check('演示数据规模为 60 台', audit.equipmentCount === 60, String(audit.equipmentCount))
  check('同种子可复现（两次生成一致）',
    JSON.stringify(fleet.buildDemoDataset({ size: 60 })) === JSON.stringify(fleet.buildDemoDataset({ size: 60 })))
  check('不同种子产生不同数据',
    JSON.stringify(fleet.buildDemoDataset({ size: 60, seed: 1 })) !== JSON.stringify(fleet.buildDemoDataset({ size: 60, seed: 2 })))

  check('所有型号都在白名单内且类别一致',
    dataset.equipment.every(eq => catalog.MODEL_WHITELIST[eq.model] &&
      catalog.MODEL_WHITELIST[eq.model].category === eq.category),
    dataset.equipment.filter(eq => !catalog.MODEL_WHITELIST[eq.model]).map(e => e.model).join(','))
  check('徐工占比 ≥ 80%（主场语境）',
    audit.brands['徐工'] / audit.equipmentCount >= 0.8,
    JSON.stringify(audit.brands))
  check('保留他牌设备以体现不挑品牌',
    audit.equipmentCount - audit.brands['徐工'] >= 2, JSON.stringify(audit.brands))
  /**
   * 稀有型号是**定数**投放，不是概率投放。
   *
   * 这条断言是 2026-09-13 补的：概率投放曾让"卡特 320D 有两台"变成 0 台，
   * 于是「同型号多台时必须判歧义」的用例在演示数据里没了素材（换个种子就红）。
   * 现在每个稀有型号固定 RARE_PER_MODEL 台，这条断言守住它。
   */
  const rareModels = catalog.FLEET_MIX.flatMap(s => s.rareModels || [])
  const shortRare = rareModels
    .map(m => ({ m, n: dataset.equipment.filter(e => e.model === m).length }))
    .filter(x => x.n !== fleet.RARE_PER_MODEL)
  check(`每个稀有型号都按定数投放（${fleet.RARE_PER_MODEL} 台）`,
    shortRare.length === 0,
    shortRare.map(x => `${x.m}:${x.n}`).join('、') || `${rareModels.length} 个稀有型号全部足额`)

  check('超期设备在合理区间（10~20 台）',
    audit.overdueCount >= 10 && audit.overdueCount <= 20, String(audit.overdueCount))
  check('至少 1 台重度超期（≥45 天，画面上最红的那台）',
    audit.severeOverdueCount >= 1, String(audit.severeOverdueCount))
  check('健康分四档都有可观数量（报告不会千篇一律）',
    ['A', 'B', 'C', 'D'].every(k => audit.levels[k] >= 3), JSON.stringify(audit.levels))
  check('存在"恶化中"设备（趋势预警有实锤）', audit.worseningCount >= 3, String(audit.worseningCount))
  check('无"数据积累中"设备（每台都有 ≥3 期快照）', audit.trendInsufficientCount === 0,
    String(audit.trendInsufficientCount))
  check('工单量足以支撑统计视图', audit.workOrderCount >= 40, String(audit.workOrderCount))
  check('维保记录量足以支撑病历与费用', audit.maintenanceCount >= 150, String(audit.maintenanceCount))
  check('复诊闭环率是真实值（非 0 非 100）',
    audit.recheckRate !== null && audit.recheckRate > 20 && audit.recheckRate < 95, String(audit.recheckRate))

  check('设备名称保留类别关键词（问答匹配依赖）',
    dataset.equipment.every(eq => eq.name.includes(eq.category)),
    dataset.equipment.filter(eq => !eq.name.includes(eq.category)).map(e => e.name).slice(0, 3).join(','))
  check('演示数据不含生成期辅助字段',
    dataset.equipment.every(eq => !Object.keys(eq).some(k => k.startsWith('__'))) &&
    dataset.workOrders.every(o => !Object.keys(o).some(k => k.startsWith('__'))))
  check('所有日期都不是未来（相对今天生成）', (() => {
    const today = dates.formatDate(new Date())
    return dataset.equipment.every(eq => !eq.purchase_date || eq.purchase_date <= today) &&
      dataset.workOrders.every(o => String(o.created_at).slice(0, 10) <= today)
  })())
  check('工单关联的设备名都存在于台账', (() => {
    const names = new Set(dataset.equipment.map(e => e.name))
    return dataset.workOrders.every(o => names.has(o.equipment_name))
  })())

  // ---- 备件账实一致（备件台账种子直接由 PARTS_CATALOG 派生，件名必须能对上） ----
  const partNames = new Set(catalog.PARTS_CATALOG.map(p => p.name))
  const libraryNames = catalog.MAINTENANCE_LIBRARY.flatMap(m => m.partNames || [])
  check('维保项目库里的件名都在配件目录内',
    libraryNames.every(n => partNames.has(n)),
    libraryNames.filter(n => !partNames.has(n)).join(',') || '全部命中')
  check('配件目录无重名（避免同名两行各扣各的）',
    partNames.size === catalog.PARTS_CATALOG.length,
    `${partNames.size}/${catalog.PARTS_CATALOG.length}`)
  const usedTokens = new Set()
  let partRecordCount = 0
  let zeroCostCount = 0
  for (const list of Object.values(dataset.maintenanceRecords)) {
    for (const r of list) {
      if (!Number(r.cost)) zeroCostCount++
      if (!r.parts_used) continue
      partRecordCount++
      for (const t of String(r.parts_used).split(/[,，、;；/]/).map(s => s.trim()).filter(Boolean)) usedTokens.add(t)
    }
  }
  check('演示维保记录里的配件名 100% 可在备件台账中查到（备件联动不会静默失效）',
    [...usedTokens].every(t => partNames.has(t)),
    [...usedTokens].filter(t => !partNames.has(t)).join(',') || `全部命中（${usedTokens.size} 种）`)
  check('演示维保记录确实带配件（联动链路有真实输入）',
    partRecordCount >= 40, String(partRecordCount))
  check('带配件的记录费用不为 0（成本 = 工时费 + 配件费）', (() => {
    for (const list of Object.values(dataset.maintenanceRecords)) {
      for (const r of list) if (r.parts_used && !Number(r.cost)) return false
    }
    return true
  })())
  check('费用为 0 的记录只可能是无配件的巡检', zeroCostCount >= 0 && (() => {
    for (const list of Object.values(dataset.maintenanceRecords)) {
      for (const r of list) if (!Number(r.cost) && r.parts_used) return false
    }
    return true
  })())

  /**
   * 故障维修的换件必须与该故障条目对得上。
   *
   * 这是"维修记录里换个不相干的件"的回归守卫：原先件名是
   * `pick(random, PARTS_CATALOG).name` —— 于是"回转马达渗油"这条记录里
   * 换的是"空气滤芯"，费用还是另一次随机抓来的单价。
   */
  const partsByDesc = new Map()
  for (const group of Object.values(catalog.FAULT_LIBRARY)) {
    for (const it of group.items) partsByDesc.set(it.desc, (catalog.FAULT_PARTS[it.title] || []).join('、'))
  }
  const partMismatch = []
  let faultRepairCount = 0
  let laborOnlyCount = 0
  for (const list of Object.values(dataset.maintenanceRecords)) {
    for (const r of list) {
      if (r.type !== '故障维修') continue
      faultRepairCount++
      const want = partsByDesc.get(r.description)
      if (want === undefined) { partMismatch.push(`未登记的故障描述：${r.description}`); continue }
      if (String(r.parts_used || '') !== want) {
        partMismatch.push(`${r.description} → 记录「${r.parts_used}」/ 应为「${want}」`)
      }
      if (!r.parts_used && Number(r.cost) >= (catalog.LABOR_FEE[r.system] || 0)) laborOnlyCount++
    }
  }
  check('故障维修记录的换件与故障现象自洽（不是随机抓一件）',
    partMismatch.length === 0,
    partMismatch.slice(0, 3).join('；') || `${faultRepairCount} 条全部对得上`)
  check('不换件的故障也收了工时费（调整/清洗类不是零成本）',
    laborOnlyCount > 0, `${laborOnlyCount} 条纯工时记录`)
  check('健康快照末值与当前评分一致（趋势与报告不自相矛盾）', (() => {
    const byEq = {}
    for (const s of dataset.healthSnapshots) (byEq[s.equipment_id] ||= []).push(s)
    return dataset.equipment.every(eq => {
      const list = (byEq[eq.id] || []).sort((a, b) => String(a.date).localeCompare(String(b.date)))
      if (!list.length) return true
      return list[list.length - 1].score === health.evaluateHealth(eq).score
    })
  })())

  /**
   * 故障案例卡：先前 faultCases 完全没有种子 —— 首启时"最新自动沉淀案例"整块卡片不显示，
   * 而工单上却写着 archived_at（已归档）。这里守住"承诺兑现"：
   * 每张已完成的维修工单都要有一张卡，且卡片能如实指回它那张单子。
   */
  const seedCases = caseDraft.buildFaultCasesFromOrders(
    dataset.workOrders, dataset.equipment, kb.buildDefaultKnowledge())
  const completedRepair = dataset.workOrders.filter(o => o.status === 'completed' && o.type === 'repair' && o.title)
  check('每张已完成的维修工单都有一张故障案例卡（archived_at 的承诺要兑现）',
    seedCases.length === completedRepair.length,
    `案例 ${seedCases.length} / 已完成维修工单 ${completedRepair.length}`)
  const orderById = new Map(dataset.workOrders.map(o => [String(o.id), o]))
  const orphan = seedCases.filter(c => !orderById.has(String(c.source_order_id)))
  check('案例卡的来源工单都真实存在（不编造单号）',
    orphan.length === 0, orphan.map(c => c.source_order_id).join('、') || '全部命中')
  const symptomMismatch = seedCases.filter(c => {
    const o = orderById.get(String(c.source_order_id))
    return !o || o.title !== c.symptom
  })
  check('案例卡症状与来源工单标题逐字一致（症状永远是工单原文）',
    symptomMismatch.length === 0, symptomMismatch.slice(0, 3).map(c => c.symptom).join('；') || '全部一致')
  const badSource = seedCases.filter(c => {
    const o = orderById.get(String(c.source_order_id))
    return o && (o.type !== 'repair' || o.status !== 'completed')
  })
  check('案例卡只来自已完成维修工单（在建/取消的单子不算经验）',
    badSource.length === 0, badSource.map(c => c.source_order_id).join('、') || '全部合规')
  check('案例卡 id 唯一且为正整数',
    new Set(seedCases.map(c => c.id)).size === seedCases.length &&
    seedCases.every(c => Number.isInteger(c.id) && c.id > 0),
    `id ${seedCases.map(c => c.id).join(',')}`)
  check('案例列表按最新在前（首屏"最新沉淀"名副其实）',
    seedCases.every((c, i) => i === 0 || String(seedCases[i - 1].createdAt) >= String(c.createdAt)),
    `${seedCases[0] && seedCases[0].createdAt} → ${seedCases.length ? seedCases[seedCases.length - 1].createdAt : ''}`)
  check('案例的产生时间取自工单完成时间（不是全部堆在启动那天）',
    new Set(seedCases.map(c => String(c.createdAt).slice(0, 10))).size >= 5,
    `${new Set(seedCases.map(c => String(c.createdAt).slice(0, 10))).size} 个不同日期`)
  const withCause = seedCases.filter(c => c.cause)
  check('多数案例能从知识库命中原因为（命中不到如实留空，但不应全都空）',
    withCause.length >= Math.ceil(seedCases.length / 2),
    `${withCause.length}/${seedCases.length} 条有原因`)
  // 留空必须是"知识库真没命中"，不是映射没接上 —— 反向验一次
  const shouldHit = seedCases.filter(c => caseDraft.matchKnowledge(c.symptom, kb.buildDefaultKnowledge()))
  check('有原因可命中的案例确实都填上了原因（留空只留给没命中的）',
    shouldHit.every(c => c.cause),
    shouldHit.filter(c => !c.cause).map(c => c.symptom).join('、') || '一致')
}

// ============ K 体检报告（结构与可溯源） ============
{
  const dataset = fleet.buildDemoDataset({ size: 60 })
  const ranked = dataset.equipment.map(e => ({ eq: e, h: health.evaluateHealth(e) }))
    .sort((a, b) => b.h.score - a.h.score)
  const eq = ranked[ranked.length - 1].eq   // 取最差的一台：风险清单必须有内容

  // 极简 store 桩
  const store = {
    getMaintenanceByEquipmentId: (id) => dataset.maintenanceRecords[String(id)] || [],
    getOrdersByEquipmentName: (name) => dataset.workOrders.filter(o => o.equipment_name === name),
    getSnapshots: (id) => dataset.healthSnapshots.filter(s => s.equipment_id === id)
  }

  const report = healthReport.generateHealthReport(eq, store)

  check('报告含设备信息与生成时间', !!report.equipment.name && !!report.generatedAt)
  /**
   * 这里原先是 `score > 0`。
   *
   * 最差的一台可能被如实扣到 0 分（超期扣 45 + 机龄扣 25 + 当前故障扣 30 = 100），
   * 那是评分模型算出来的结果，不是"报告没内容"。把断言写成 `score > 0`，
   * 等于要求演示数据里不许出现报废级设备——那是拿数据去迁就断言。
   *
   * 所以改成守两件真事：分数是 0~100 的有限数（NaN 会在这里现形）、
   * 小结字段与结论有实质内容；另外单独守住"0 分设备不能成片"。
   */
  check('报告小结含分数/等级/结论（分数为 0~100 的有限数）',
    Number.isFinite(report.summary.score) && report.summary.score >= 0 && report.summary.score <= 100 &&
    !!report.summary.levelLabel && report.summary.conclusion.length > 10,
    `${report.summary.score} ${report.summary.level} ${report.summary.conclusion.slice(0, 20)}`)
  check('0 分设备最多 1 台（极端分不成片，成片说明评分或数据坏了）',
    ranked.filter(r => r.h.score === 0).length <= 1,
    ranked.filter(r => r.h.score === 0).map(r => r.e.name).join('、') || '无 0 分设备')
  check('报告含四因子与算式', report.factors.length === 4 && report.factors.every(f => f.formula),
    report.factors.map(f => f.name).join('/'))
  check('报告含风险清单且每条有出处', report.riskItems.length > 0 && report.riskItems.every(r => r.ref),
    report.riskItems.map(r => r.ref).join(' | '))
  check('报告含停机估算与公式与口径标注',
    report.lossEstimate.estimatedLoss >= 0 && report.lossEstimate.formula.includes('×') &&
    report.lossEstimate.note.includes('演示'),
    report.lossEstimate.formula)
  check('报告含保养计划 3 条', report.maintenancePlan.length === 3,
    report.maintenancePlan.map(p => p.dueDate).join(','))
  check('报告含趋势段', !!report.trend.kind, report.trend.kind)
  check('最差设备的报告被判定为高风险', report.summary.level === 'D', report.summary.level)
  check('高风险报告的保养计划首项标注"立即"', report.maintenancePlan[0].urgent === true,
    JSON.stringify(report.maintenancePlan[0]))
  check('报告历史统计来自真实记录',
    report.history.maintenanceCount === (dataset.maintenanceRecords[String(eq.id)] || []).length,
    `${report.history.maintenanceCount}`)

  // 可审计：每个数字都能追到算式与来源
  check('溯源表覆盖全部因子与关键数值', report.traceability.length >= report.factors.length + 4,
    String(report.traceability.length))
  check('溯源表每行都有算式与来源',
    report.traceability.every(r => r.label && r.formula && r.source))
  check('溯源自查：健康分可复算', (() => {
    const row = report.traceability.find(r => r.label === '健康分')
    return row && row.value.includes(String(report.summary.score))
  })())
  check('溯源自查：损失可复算', (() => {
    const row = report.traceability.find(r => r.label === '预计停机损失')
    return row && row.value.includes(report.lossEstimate.estimatedLoss.toLocaleString('zh-CN'))
  })())

  // HTML
  check('报告 HTML 非空且含关键区块',
    report.html.includes('设备体检报告') && report.html.includes('健康度四因子') &&
    report.html.includes('数字溯源') && report.html.includes('停机损失估算'))
  check('报告 HTML 含打印容器与签名区',
    report.html.includes('print-doc') && report.html.includes('签字'))
  check('报告 HTML 不残留未替换占位符', !report.html.includes('undefined') && !report.html.includes('NaN'))
  // 报告样式已抽到全局单一样式源（src/styles/healthReport.css，main.js 引入）
  // 这里校验：报告 HTML 用到的类名必须都能在该样式表里找到，避免样式漂移
  const reportCss = readFileSync(join(root, 'src', 'renderer', 'src', 'styles', 'healthReport.css'), 'utf8')
  check('报告样式表存在且含关键类',
    reportCss.includes('.health-report') && reportCss.includes('@media print') &&
    reportCss.includes('.hr-trace-table') && reportCss.includes('.hr-loss-value'))
  const usedClasses = [...new Set((report.html.match(/class="([^"]+)"/g) || [])
    .flatMap(m => m.replace(/class="|"/g, '').split(/\s+/))
    .filter(Boolean))]
  const missingStyles = usedClasses.filter(cls => !reportCss.includes('.' + cls))
  check('报告用到的每个类名都有对应样式（防止样式漂移）',
    missingStyles.length === 0, missingStyles.join(',') || '无')

  // 数据缺失设备也要能出报告（不能抛异常）
  const bare = { id: 999, name: '裸设备 挖掘机', model: '', category: '', location: '', purchase_date: '', status: 'running', maintenance_cycle_days: 90, last_maintenance_date: null }
  const bareReport = healthReport.generateHealthReport(bare, { getMaintenanceByEquipmentId: () => [], getOrdersByEquipmentName: () => [], getSnapshots: () => [] })
  check('台账字段缺失时仍能生成报告并如实标注',
    bareReport.html.includes('未录入') && bareReport.trend.kind === 'insufficient',
    `trend=${bareReport.trend.kind}`)
  check('字段缺失时报告不出现 NaN', !bareReport.html.includes('NaN'))

  // 报告里"没有维保记录"必须说成缺记录，不能说成"临近保养周期"（曾因判断顺序写反而误报）
  check('无维保记录时风险项是"缺少维保记录"而不是"临近保养周期"',
    bareReport.riskItems.some(r => r.title === '缺少维保记录') &&
    !bareReport.riskItems.some(r => r.title === '临近保养周期'),
    bareReport.riskItems.map(r => r.title).join(' | '))

  // 溯源表：预估停时的来源不得声称用了维修记录（停时只由超期天数推算）
  const downtimeRow = report.traceability.find(r => r.label === '预估停时')
  check('预估停时的来源说明与实际算法一致（不谎称用了维修记录）',
    !!downtimeRow && !downtimeRow.source.includes('维修记录 +') && downtimeRow.source.includes('超期'),
    downtimeRow ? downtimeRow.source : '缺失')

  // 趋势图：报告与屏幕共用 buildTrendPath，纵轴按实际分数自动缩放（不再是写死的 0-100）
  const trendChart = health.buildTrendPath(report.trend.points, { width: 520, height: 90 })
  check('趋势折线坐标由公共 buildTrendPath 生成',
    !!trendChart && typeof trendChart.d === 'string' && trendChart.d.startsWith('M') &&
    trendChart.points.length === report.trend.points.length,
    trendChart ? trendChart.d.slice(0, 40) : 'null')
  check('趋势纵轴按实际分数缩放（不再固定 0-100）',
    (() => {
      const scores = report.trend.points.map(p => p.score)
      const span = Math.max(...scores) - Math.min(...scores)
      return span < 100 && trendChart.max - trendChart.min <= span + 11
    })(),
    `min=${trendChart.min} max=${trendChart.max}`)
  check('趋势点不足 2 个时返回 null（调用方走空态）',
    health.buildTrendPath([{ date: '2026-09-01', score: 90 }]) === null &&
    health.buildTrendPath([]) === null)
}

// ============ L 高频故障 TOP（自动分类，G-1） ============
{
  // 1) 10 条已知样本（含关键词碰撞）分类准确率必须 100%
  const sampleResult = faultStats.verifyFaultSamples()
  check('高频故障分类：10 条已知样本准确率 100%（先长词后短词）',
    sampleResult.ok, JSON.stringify(sampleResult.failures.slice(0, 3)))

  // 2) 演示数据实测：统计来自真实工单 + 维保记录，样本量正确
  const dataset = fleet.buildDemoDataset({ size: 60 })
  const stats = faultStats.buildFaultStats({
    workOrders: dataset.workOrders,
    maintenanceRecords: dataset.maintenanceRecords
  })
  const repairOrders = dataset.workOrders.filter(o => o.type === 'repair').length
  const faultMaintenance = Object.values(dataset.maintenanceRecords)
    .reduce((sum, list) => sum + list.filter(r => r.type === '故障维修').length, 0)
  check('故障统计样本量 = 维修工单 + 故障维保记录',
    stats.total === repairOrders + faultMaintenance, `${stats.total} = ${repairOrders} + ${faultMaintenance}`)

  // 3) 一条记录只计一次（每个系统合计 = 总样本量）
  check('每条记录只归入一个系统（无重复计数）',
    stats.top.reduce((sum, s) => sum + s.count, 0) === stats.total,
    `${stats.top.reduce((sum, s) => sum + s.count, 0)} / ${stats.total}`)

  // 4) 排行按次数降序、占比在合理区间
  const counts = stats.top.map(s => s.count)
  check('故障排行按次数降序',
    counts.every((c, i) => i === 0 || c <= counts[i - 1]), counts.join(','))
  check('占比总和约等于 100%',
    Math.abs(stats.top.reduce((sum, s) => sum + s.percent, 0) - 100) < 1,
    String(Math.round(stats.top.reduce((sum, s) => sum + s.percent, 0))))

  // 5) 演示数据的故障 TOP 有形状（液压/动力等系统都有可观命中，不是全挤在"其他"）
  const hyd = stats.top.find(s => s.system === '液压系统')
  const pow = stats.top.find(s => s.system === '动力系统')
  check('演示数据故障 TOP 有形状（液压与动力系统均有命中）',
    hyd && pow && hyd.count >= 5 && pow.count >= 5,
    JSON.stringify(stats.top.map(s => `${s.system}:${s.count}`)))

  // 6) 每条计数可追溯到原文（可审计）
  check('故障统计每条计数都带原文样本',
    stats.top.every(s => s.samples.length === s.count), stats.top.map(s => `${s.system}:${s.samples.length}/${s.count}`).join(' | '))

  // 7) 边界：空输入不崩溃
  const empty = faultStats.buildFaultStats({})
  check('空输入不崩溃且返回零', empty.total === 0 && empty.top.length === 0, String(empty.total))
}

// ============ M 口述录入解析（自然语言 → 结构化操作） ============
{
  // 用演示数据工厂的真实台账作为解析对象：设备名形如「徐工 XE215C 挖掘机-03」
  const dataset = fleet.buildDemoDataset({ size: 60 })
  const store = {
    equipmentList: dataset.equipment,
    workOrders: dataset.workOrders,
    getMaintenanceByEquipmentId: (id) => dataset.maintenanceRecords[String(id)] || [],
    getSnapshots: (id) => dataset.healthSnapshots.filter(s => s.equipment_id === id)
  }

  const excavator1 = dataset.equipment.find(e => e.category === '挖掘机' && /-01$/.test(e.name))
  const excavator3 = dataset.equipment.find(e => e.category === '挖掘机' && /-03$/.test(e.name))
  // 装载机有两种型号（LW300FN / LW500KN），"装载机"这个名字本身是歧义的 ——
  // 这里取装载机里唯一的那台做精确指代测试；纯类别测试见「纯类别多台时返回歧义」
  const loader = dataset.equipment.find(e => e.category === '装载机' && /-01$/.test(e.name))

  // ---- 语料：真实口吻，覆盖各类意图与指代方式 ----
  // 注意：语料要包含"故障关键词"才是完整的一单报修（"液压油"本身不是故障词，"液压油漏了"才是）
  const CORPUS = [
    { text: '1号挖掘机今天液压油压力偏低', intent: 'report_fault', eq: excavator1?.name },
    { text: '3号挖掘机履带松了，需要调整', intent: 'report_fault', eq: excavator3?.name },
    { text: '1号装载机轮胎漏气了', intent: 'report_fault', eq: loader?.name },
    { text: '6号钻机钻杆振动异常，安排检修', intent: 'report_fault' },
    { text: '卡特320D今天水温偏高报警了', intent: 'report_fault', ambiguous: true },
    { text: '报个故障：XE215C液压油温过高', intent: 'report_fault' },
    { text: '1号挖掘机先停机，别排产了', intent: 'set_status', eq: excavator1?.name },
    { text: '3号挖掘机已经检修完了', intent: 'complete_order', eq: excavator3?.name },
    { text: '1号挖掘机故障处理完毕', intent: 'complete_order', eq: excavator1?.name },
    { text: '挖掘机坏了', intent: 'report_fault', ambiguous: true },
    { text: '2号挖掘机今天做了保养，换了液压油', intent: 'add_maintenance' },
    { text: '1号装载机做完月度保养了', intent: 'add_maintenance', eq: loader?.name },
    { text: '卡特320D换了机油和机滤', intent: 'add_maintenance', ambiguous: true },
    { text: '记一条：XE215C回转马达异响，先查油位再考虑拆泵', intent: 'add_knowledge' },
    { text: '帮我写一首关于春天的诗', intent: null },
    { text: '今天天气怎么样', intent: null }
  ]

  let intentHits = 0
  let intentTotal = 0
  let ambiguityHits = 0
  let ambiguityTotal = 0
  const failures = []
  for (const sample of CORPUS) {
    const plan = nl.parseCommand(store, sample.text, { now: new Date('2026-09-12T10:00:00') })
    intentTotal++
    const gotIntent = plan.ok ? plan.items[0].intent : null
    if (gotIntent === sample.intent) intentHits++
    else failures.push(`「${sample.text}」期望意图 ${sample.intent} 实际 ${gotIntent}`)
    if (sample.eq && plan.ok) {
      const gotEq = plan.items[0].equipment?.name
      if (gotEq !== sample.eq) failures.push(`「${sample.text}」设备期望 ${sample.eq} 实际 ${gotEq}`)
    }
    // 期望歧义的样本：必须真的走候选确认，不能替用户猜一台
    if (sample.ambiguous) {
      ambiguityTotal++
      const isAmbiguous = plan.ambiguous.length > 0 || plan.blocked === true
      if (isAmbiguous) ambiguityHits++
      else failures.push(`「${sample.text}」应判为歧义，实际直接选中了 ${plan.items[0]?.equipment?.name || '未知'}`)
    }
  }
  check(`口述语料意图识别准确率 100%（${CORPUS.length} 条）`,
    intentHits === intentTotal, failures.filter(f => f.includes('意图')).slice(0, 3).join('；') || '全部命中')
  check(`多台同名时一律判歧义（${ambiguityTotal} 条）`,
    ambiguityHits === ambiguityTotal, failures.filter(f => f.includes('歧义')).slice(0, 3).join('；') || '全部正确')
  check('语料设备指代全部命中', failures.filter(f => f.includes('设备期望')).length === 0,
    failures.filter(f => f.includes('设备期望')).slice(0, 3).join('；') || '全部命中')

  // ---- 关键行为：歧义绝不猜 ----
  check('纯型号多台时返回歧义而不是猜',
    (() => {
      const plan = nl.parseCommand(store, '卡特320D水温高了', { now: new Date('2026-09-12') })
      return plan.ambiguous.length > 0 || plan.items[0]?.equipmentRef?.status === 'ambiguous'
    })(),
    '卡特 320D 有多台，必须要求确认')

  check('纯类别多台时返回歧义', (() => {
    const plan = nl.parseCommand(store, '挖掘机坏了', { now: new Date('2026-09-12') })
    return plan.ambiguous.length > 0 && plan.blocked === true
  })())
  check('纯类别 + 故障词仍识别为报故障（不静默）', (() => {
    const plan = nl.parseCommand(store, '挖掘机坏了', { now: new Date('2026-09-12') })
    return plan.ok && plan.items[0].intent === 'report_fault'
  })())
  check('歧义时整单被标记为需人工选择（blocked）', (() => {
    const plan = nl.parseCommand(store, '卡特320D水温高了', { now: new Date('2026-09-12') })
    return plan.blocked === true
  })())

  check('序号 + 类别能唯一确定设备（1号挖掘机）', (() => {
    const plan = nl.parseCommand(store, '1号挖掘机液压油压力偏低', { now: new Date('2026-09-12') })
    return plan.ok && plan.items[0].equipment?.name === excavator1?.name
  })(), `${excavator1?.name}`)

  check('两位数编号不会被当成 1 号（-11 ≠ 1号）', (() => {
    const plan = nl.parseCommand(store, '1号挖掘机液压油压力偏低', { now: new Date('2026-09-12') })
    const picked = plan.items[0]?.equipment?.name || ''
    return picked === excavator1?.name && !/-1\d$/.test(picked)
  })(), `实际选中 ${excavator1?.name}`)

  check('全名精确匹配优先级最高', (() => {
    const plan = nl.parseCommand(store, `${excavator3?.name} 履带脱轨了`, { now: new Date('2026-09-12') })
    return plan.items[0]?.equipmentRef?.method === 'name-exact'
  })())

  // ---- 台账里没有的设备：不静默失败 ----
  const ghost = nl.parseCommand(store, '99号挖掘机液压油压力偏低', { now: new Date('2026-09-12') })
  check('台账没有的设备 → 明确报"未找到"而不是胡乱匹配',
    ghost.notFound.length > 0 || (ghost.ok && ghost.items[0].equipmentRef.status === 'not_found'),
    JSON.stringify({ notFound: ghost.notFound.length, status: ghost.items[0]?.equipmentRef?.status }))

  // ---- 纯查询不得触发写入 ----
  const queryTexts = [
    '6号钻机健康怎么样',
    '哪些设备维保已超期',
    '台账里现在有多少台设备',
    '发动机过热怎么排查'
  ]
  const writesFromQuery = queryTexts.filter(t => {
    const plan = nl.parseCommand(store, t, { now: new Date('2026-09-12') })
    return plan.ok && plan.items.some(i => i.intent !== 'query')
  })
  check('纯查询语句不产生任何写入动作（防误写）',
    writesFromQuery.length === 0, writesFromQuery.join('、') || '无')

  // ---- 日期抽取 ----
  check('日期默认今天', (() => {
    const plan = nl.parseCommand(store, '1号挖掘机今天液压油压力偏低', { now: new Date('2026-09-12T10:00:00') })
    return plan.items[0]?.date === '2026-09-12'
  })())
  check('支持"昨天"', (() => {
    const plan = nl.parseCommand(store, '1号挖掘机昨天做了保养', { now: new Date('2026-09-12T10:00:00') })
    return plan.items[0]?.date === '2026-09-11'
  })())
  check('支持"前天"', (() => {
    const plan = nl.parseCommand(store, '1号挖掘机前天做了保养', { now: new Date('2026-09-12T10:00:00') })
    return plan.items[0]?.date === '2026-09-10'
  })())
  check('支持"9月8日"', (() => {
    const plan = nl.parseCommand(store, '1号挖掘机9月8日做了保养', { now: new Date('2026-09-12T10:00:00') })
    return plan.items[0]?.date === '2026-09-08'
  })())
  // 回归：matchForm 会把 "-" 归一化掉，日期必须从原文抽取，否则 2026-09-08 会变成今天的日期
  check('支持"2026-09-08"这类带连字符的日期（回归）', (() => {
    const plan = nl.parseCommand(store, '1号挖掘机2026-09-08更换了液压油', { now: new Date('2026-09-12T10:00:00') })
    return plan.items[0]?.date === '2026-09-08'
  })(), (() => {
    const plan = nl.parseCommand(store, '1号挖掘机2026-09-08更换了液压油', { now: new Date('2026-09-12T10:00:00') })
    return `实际 ${plan.items[0]?.date}`
  })())
  check('支持"2026/9/8"', (() => {
    const plan = nl.parseCommand(store, '1号挖掘机2026/9/8做了保养', { now: new Date('2026-09-12T10:00:00') })
    return plan.items[0]?.date === '2026-09-08'
  })())

  // ---- 振动类故障不能落到兜底分支（回归：曾因关键词缺失被判为普通优先级、无故障现象）----
  check('钻杆振动识别为钻机系统故障', (() => {
    const plan = nl.parseCommand(store, '1号钻机钻杆振动异常', { now: new Date('2026-09-12') })
    const item = plan.items[0]
    return item?.system === '钻机系统' && item.priority !== 'normal' && !!item.title
  })(), (() => {
    const plan = nl.parseCommand(store, '1号钻机钻杆振动异常', { now: new Date('2026-09-12') })
    return `${plan.items[0]?.system} / ${plan.items[0]?.priority}`
  })())
  check('破碎机振动识别为破碎设备故障', (() => {
    const plan = nl.parseCommand(store, '1号破碎机振动异常', { now: new Date('2026-09-12') })
    const item = plan.items[0]
    return item?.system === '破碎设备' && item.priority !== 'normal'
  })())

  // ---- 优先级判定 ----
  check('"停机/趴窝"判为紧急', (() => {
    const p1 = nl.parseCommand(store, '1号挖掘机趴窝了', { now: new Date('2026-09-12') })
    const p2 = nl.parseCommand(store, '1号挖掘机液压油压力偏低', { now: new Date('2026-09-12') })
    return p1.items[0]?.priority === 'urgent' && p2.items[0]?.priority !== 'urgent'
  })())
  check('刹车类问题判为紧急', (() => {
    const plan = nl.parseCommand(store, '1号装载机刹车失灵了', { now: new Date('2026-09-12') })
    return plan.items[0]?.priority === 'urgent'
  })())

  // ---- 多操作一句话 ----
  const multi = nl.parseCommand(store, '1号挖掘机液压油压力偏低，另外3号挖掘机已经检修完了', { now: new Date('2026-09-12') })
  check('一句话多个操作能被拆成多条计划',
    multi.ok && multi.items.length >= 2, `items=${multi.items.length}`)
  check('多操作各自识别到不同意图',
    multi.ok && new Set(multi.items.map(i => i.intent)).size >= 2,
    multi.ok ? multi.items.map(i => i.intent).join(',') : '')

  // ---- 多处歧义：必须逐组确认，不能一次把两组都套用同一台设备 ----
  const twoAmb = nl.parseCommand(store, '挖掘机坏了。装载机也坏了', { now: new Date('2026-09-12') })
  check('一句话两处歧义生成两组待确认',
    twoAmb.ambiguous.length === 2, `ambiguous=${twoAmb.ambiguous.length}`)
  check('两组歧义各有独立 id（不靠子句文本关联）',
    new Set(twoAmb.ambiguous.map(g => g.id)).size === twoAmb.ambiguous.length)
  check('每条歧义计划项都指回自己的歧义组',
    twoAmb.items.filter(i => i.ambiguousId).length === 2 &&
    twoAmb.items.every(i => !i.ambiguousId || twoAmb.ambiguous.some(g => g.id === i.ambiguousId)))
  check('存在未确认歧义时禁止一键写入', twoAmb.blocked === true)

  // ---- 计划必须经确认：解析阶段绝不改数据 ----
  const beforeWorkOrders = store.workOrders.length
  const beforeEquipment = JSON.stringify(store.equipmentList.map(e => e.status))
  nl.parseCommand(store, '1号挖掘机液压油压力偏低', { now: new Date('2026-09-12') })
  nl.parseCommand(store, '1号挖掘机已经检修完了', { now: new Date('2026-09-12') })
  check('解析阶段不产生任何写入（必须确认后才落库）',
    store.workOrders.length === beforeWorkOrders &&
    JSON.stringify(store.equipmentList.map(e => e.status)) === beforeEquipment)

  // ---- 完成工单的预检：没有未完成工单时要给出明确原因 ----
  check('无未完成工单时给出 preflightError',
    (() => {
      const lonely = {
        equipmentList: [dataset.equipment[0]],
        workOrders: [],
        getMaintenanceByEquipmentId: () => [],
        getSnapshots: () => []
      }
      const plan = nl.parseCommand(lonely, '1号挖掘机已经检修完了', { now: new Date('2026-09-12') })
      return !!plan.items[0]?.preflightError
    })())

  // ---- 文本归一化：全角标点/空格/语气词不影响识别 ----
  check('全角标点与语气词不影响识别', (() => {
    const a = nl.parseCommand(store, '１号挖掘机液压油压力偏低！！！', { now: new Date('2026-09-12') })
    const b = nl.parseCommand(store, '麻烦帮我记一下，1号挖掘机液压油压力偏低呗', { now: new Date('2026-09-12') })
    return a.ok && b.ok && a.items[0].intent === 'report_fault' && b.items[0].intent === 'report_fault'
  })())
}

// ============ M 本地模型叙述层（纯函数，引擎不在 Node 环境故只测逻辑） ============
{
  const prompt = llmC.buildNarratePrompt('1号挖掘机健康分78分，维保超期5天。')
  check('buildNarratePrompt 包含原结论', prompt.includes('1号挖掘机健康分78分，维保超期5天'))
  check('buildNarratePrompt 含润色硬约束', prompt.includes('口语化') && prompt.includes('原样保留'))
  check('buildNarratePrompt 空输入返回空串', llmC.buildNarratePrompt('   ') === '')

  check('extractNumbers 提取整数与小数', JSON.stringify(llmC.extractNumbers('超期5天，健康分78.5')) === JSON.stringify(['5', '78.5']))
  check('verifyNumbersSubset 数字全部来自原结论', llmC.verifyNumbersSubset('超期5天，分数78', '超期5天，分数78，请尽快处理').ok)
  check('verifyNumbersSubset 模型新造数字被拦截', !llmC.verifyNumbersSubset('超期5天', '超期5天，损失9000元').ok)

  check('htmlToText 去标签压缩空白',
    narrate.htmlToText('<div>1号挖掘机</div><p>健康分 <b>78</b> 分</p>') === '1号挖掘机 健康分 78 分')

  const fb = await narrate.narrateConclusion('<p>结论</p>')
  check('narrateConclusion Node 环境回退 fallback', fb.mode === 'fallback' && fb.reason === 'browser', fb.reason)
}

// ============ N 界面文案字典必须是单一来源 ============
{
  // 回归：工单状态的中文名一度在四个地方各写一份 —— Store、全局搜索、
  // 设备台账、工单页。结果同一个 pending 在工单页叫「待派单」，
  // 在搜索面板和设备病历里叫「待处理」，用户会以为是两个状态；
  // 副本还各缺一块（设备台账的工单状态配色表没有 assigned 分支）。
  // 光靠自觉统一，下次加状态时还会冒出新的副本，所以这里做源码级扫描。
  const dict = await import(pathToFileURL(join(mirrorDir, 'dictionaries.mjs')).href)

  check('字典：已知工单状态给出中文名', dict.statusLabel('pending') === '待派单' && dict.statusLabel('completed') === '已完成')
  check('字典：未知工单状态回退为原值（不显示 undefined）', dict.statusLabel('weird') === 'weird')
  check('字典：每个工单状态都配了中文名与配色',
    ['pending', 'assigned', 'processing', 'completed', 'cancelled'].every(k =>
      dict.WORK_ORDER_STATUS[k] && dict.WORK_ORDER_STATUS[k].label && dict.WORK_ORDER_STATUS[k].tagType))
  check('字典：设备状态齐全', ['running', 'idle', 'maintenance', 'fault'].every(k => dict.EQUIPMENT_STATUS[k].label))
  check('字典：优先级文案与配色齐全', dict.priorityLabel('urgent') === '紧急' && dict.priorityTagType('urgent') === 'danger')
  check('字典：维保类型样式有兜底（未知类型不炸）', dict.maintenanceStyle('不存在的类型').tagType === 'info')

  // 源码扫描：除字典本身外，任何页面/组件都不得自建"状态 key → 文案"的表。
  // 只认「枚举 key 冒号后紧跟字符串字面量」这一种形态，所以状态机
  // （pending: ['processing']）之类的合法对象不会被误伤。
  const ENUM_KEYS = ['pending', 'processing', 'assigned', 'completed', 'cancelled', 'urgent', 'running', 'idle', 'fault']
  const labelMapRe = new RegExp(`(^|[^\\w$])(${ENUM_KEYS.join('|')})\\s*:\\s*['"\`]`)

  // 同名不同义的白名单：只放行列出的 key，多出现一个就算违规。
  // 不整份文件豁免 —— 否则这些文件以后真的抄一份设备状态表也查不出来。
  const KEYSPACE_EXEMPTIONS = {
    // 模型加载状态 idle → loading → ready，跟设备闲置的 idle 只是同名
    'views/ModelHub.vue': ['idle']
  }

  // 探测器本身先验一遍。这不是多余的：这段正则最初把 \\s 写成了 \s，
  // 在模板字符串里退化成字母 s，于是永远扫不出东西——断言照样全绿，
  // 用"没有违规"的假象骗过了自己。凡是靠扫描实现的守卫，都得先证明它会响。
  check('自建状态表探测器：能命中真实违规写法',
    labelMapRe.test("const m = { pending: '待处理', urgent: '紧急' }"))
  check('自建状态表探测器：不误伤状态机与取值表达式',
    !labelMapRe.test("const t = { pending: ['processing'], completed: [] } status: row.status"))

  const offenders = []
  for (const dir of ['views', 'components']) {
    for (const entry of readdirSync(join(root, 'src/renderer/src', dir), { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(js|vue)$/.test(entry.name)) continue
      const rel = `${dir}/${entry.name}`
      const code = readFileSync(join(root, 'src/renderer/src', rel), 'utf8')
      const allowed = KEYSPACE_EXEMPTIONS[rel] || []
      const hit = ENUM_KEYS.filter(k =>
        new RegExp(`(^|[^\\w$])${k}\\s*:\\s*['"\`]`).test(code) && !allowed.includes(k))
      if (hit.length) offenders.push(`${rel}(${hit.join('/')})`)
    }
  }
  check('除 utils/dictionaries.js 外，没有页面再自建状态文案表',
    offenders.length === 0, offenders.join('、') || '无')

  // 删掉本地表还不够，还得真的接上共享的那份
  const wired = ['views/WorkOrder.vue', 'views/Equipment.vue', 'components/GlobalSearch.vue']
  const notWired = wired.filter(rel =>
    !readFileSync(join(root, 'src/renderer/src', rel), 'utf8').includes("utils/dictionaries"))
  check('状态文案已改用共享字典（工单页/设备台账/全局搜索）',
    notWired.length === 0, notWired.join('、') || '全部已接入')
}

// ============ K 图标白名单一致性 ============
//
// 背景：图标原先由 main.js 里 `Object.entries(ElementPlusIconsVue)` 全量注册，
// 293 个图标全被打进主 chunk（实测 dist 主 chunk 里 293 个图标名全部存在），
// 而项目实际只用 69 个。改成白名单（utils/appIcons.js）能砍掉约 76%，代价是：
// **漏登记一个图标，界面上那个图标会静默变成空白** —— 不报错、不白屏，
// 自检和端到端都抓不到。所以这条守卫是这次优化的必要配套，不是可选项。
{
  const { APP_ICON_NAMES } = await import(mirror('appIcons'))
  const iconPkg = await import('@element-plus/icons-vue')
  const EXPORTED = new Set(Object.keys(iconPkg))
  const whitelist = new Set(APP_ICON_NAMES)

  // ⚠️ 必须跳过 utils/appIcons.js 自己 —— 那里把 69 个图标名各写了两遍
  //    （import 标识符 + 对象键），扫进来会让"没有遗漏"和"没有多余"
  //    两条断言同时恒真，整个守卫就废了。
  const WHITELIST_FILE = 'utils/appIcons.js'

  // 收集"被引用的图标名"。三种形态都要覆盖：
  //   标签 <Search />、字符串属性 icon="ArrowLeft"、
  //   以及 NAV_GROUPS 那种注册表里的字面量 'DataBoard'
  function collectIconRefs(dir, refs = new Map()) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) { collectIconRefs(p, refs); continue }
      if (!/\.(js|vue)$/.test(entry.name)) continue
      const rel = p.slice(join(root, 'src/renderer/src').length + 1).replace(/\\/g, '/')
      if (rel === WHITELIST_FILE) continue
      const code = readFileSync(p, 'utf8')
      const hit = (name) => { if (EXPORTED.has(name)) refs.set(name, rel) }
      for (const m of code.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)) hit(m[1])
      for (const m of code.matchAll(/[:-]?icon\s*[:=]\s*["']{1,2}([A-Z][A-Za-z0-9]*)["']/g)) hit(m[1])
      for (const m of code.matchAll(/["'`]([A-Z][A-Za-z0-9]*)["'`]/g)) hit(m[1])
    }
    return refs
  }

  // 探测器自证：先证明它认得出一段已知的图标引用，再相信"没有遗漏"
  // （同 §J 的教训 —— 靠扫描实现的守卫必须先证明它会响）
  const probeRefs = collectIconRefs(join(root, 'src/renderer/src/components'))
  check('图标探测器：能识别出真实引用（组件/属性/字面量三种形态）',
    probeRefs.size > 0 && probeRefs.has('Search'),
    `扫到 ${probeRefs.size} 个，含 Search=${probeRefs.has('Search')}`)

  const refs = collectIconRefs(join(root, 'src/renderer/src'))

  const missing = [...refs.keys()].filter(n => !whitelist.has(n))
  check('没有引用了白名单之外的图标（漏登记会让图标静默变空白）',
    missing.length === 0,
    missing.length ? missing.map(n => `${n}@${refs.get(n)}`).join('、') : `已登记 ${whitelist.size} 个`)

  const unused = [...whitelist].filter(n => !refs.has(n))
  check('白名单里没有已经没人用的图标（清掉可以继续减小包体）',
    unused.length === 0, unused.join('、') || '无')

  check('白名单只含真实存在的图标名（拼错会静默注册失败）',
    [...whitelist].every(n => EXPORTED.has(n)),
    [...whitelist].filter(n => !EXPORTED.has(n)).join('、') || '全部存在')
}

// ============ 汇总 ============
const failed = results.filter(r => !r.ok)
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`)
}
console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`)
if (failed.length) process.exitCode = 1

// 清理镜像目录
rmSync(mirrorDir, { recursive: true, force: true })
