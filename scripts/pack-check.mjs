/**
 * 矿山智工 - 打包依赖闭包检查（scripts/pack-check.mjs）
 *
 * 为什么需要这个脚本：
 *   2026-09-25 用户装上的安装包里"本地模型档位切换失败"：
 *     Cannot find package 'chalk' imported from .../app.asar/node_modules/node-llama-cpp/dist/bindings/Llama.js
 *   根因是构建配置的 files 白名单里写了 `!node_modules/**`（本意是不把 Vite 已经打进
 *   dist 的 element-plus/echarts 再塞一份），node-llama-cpp 自己靠三条显式规则被重新
 *   包含了，但它的 28 个运行时依赖**全被排除** —— 于是每一个打包版都装不起来本地模型，
 *   而 `npm run electron:dev` 一切正常（开发态有完整 node_modules，根本看不出来）。
 *   这类缺陷有个共同点：**开发态永远看不见，只有装完包才炸**，所以必须挡住。
 *
 * 判据（三条，任一不成立即失败）：
 *   1. src/main 与 src/preload 里 require/import 的裸包名，要么是内建模块/electron，
 *      要么必须落在 package.json 的 dependencies 里。落在 devDependencies 等于打包版必崩
 *      （electron-builder 从不复制 devDependencies）。
 *   2. dependencies 的完整运行时闭包（按真实 node_modules 解析）不被构建配置的 files
 *      规则排除。整片排除 `!node_modules/**` 这类写法会被直接点名，并列出会被漏掉的包。
 *   3. dependencies 里带原生二进制（*.node）的包必须整包进 asarUnpack ——
 *      原生模块从 asar 里加载会失败（这条就是 07 遗留的"装机后打不开模型"那一类）。
 *
 * 运行：npm run pack-check
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtinModules } from 'node:module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
let fail = 0
const failures = []

function check (name, condition, detail = '') {
  if (condition) {
    pass++
    console.log(`PASS  ${name}${detail ? `  [${detail}]` : ''}`)
  } else {
    fail++
    failures.push(name)
    console.log(`FAIL  ${name}${detail ? `  [${detail}]` : ''}`)
  }
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const pkg = readJson(join(root, 'package.json'))
const runtimeDeps = Object.keys(pkg.dependencies || {})
const devDeps = Object.keys(pkg.devDependencies || {})

const CONFIGS = [
  ['package.json 的 build 段', pkg.build || {}],
  ['electron-builder.offline.json', readJson(join(root, 'electron-builder.offline.json'))],
  ['electron-builder.online.json', readJson(join(root, 'electron-builder.online.json'))]
]

// ---------------------------------------------------------------------------
// 1. 主进程/preload 的裸包名必须都在 dependencies 里
// ---------------------------------------------------------------------------
const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map(m => `node:${m}`),
  'electron'
])

function walkJs (dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) walkJs(p, out)
    else if (entry.endsWith('.js')) out.push(p)
  }
  return out
}

/** 取裸包名：'chalk/source' → 'chalk'，'@scope/pkg/x' → '@scope/pkg' */
function packageNameOf (spec) {
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

{
  const specs = new Map() // 包名 → 引用位置
  for (const file of [...walkJs(join(root, 'src/main')), ...walkJs(join(root, 'src/preload'))]) {
    const src = readFileSync(file, 'utf8')
    const re = /(?:require\s*\(\s*|import\s*\(\s*|from\s+)['"]([^'"]+)['"]/g
    let m
    while ((m = re.exec(src))) {
      const spec = m[1]
      if (spec.startsWith('.') || spec.startsWith('/')) continue
      if (BUILTINS.has(spec)) continue
      const name = packageNameOf(spec)
      if (BUILTINS.has(name)) continue
      const line = src.slice(0, m.index).split('\n').length
      if (!specs.has(name)) specs.set(name, `${file.replace(root, '')}:${line}`)
    }
  }
  const undeclared = []
  const onlyDev = []
  for (const [name, where] of specs) {
    if (runtimeDeps.includes(name)) continue
    const bucket = devDeps.includes(name) ? onlyDev : undeclared
    bucket.push(`${name}（${where}）`)
  }
  check('主进程/preload 声明的运行时依赖都能进包（不落在 devDependencies）',
    onlyDev.length === 0 && undeclared.length === 0,
    [...onlyDev.map(s => `devDep: ${s}`), ...undeclared.map(s => `未声明: ${s}`)].join(' ') ||
      `${specs.size} 个裸包名全部在 dependencies 里：${[...specs.keys()].join(', ')}`)
}

// ---------------------------------------------------------------------------
// 2. dependencies 的运行时闭包不被 files 规则排除
// ---------------------------------------------------------------------------
/** 与 Node 一致：从 fromDir 逐级向上找 node_modules/<name> */
function resolveDir (name, fromDir) {
  let dir = fromDir
  for (;;) {
    const cand = join(dir, 'node_modules', name)
    if (existsSync(join(cand, 'package.json'))) return cand
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** 运行时闭包：包名 → 安装目录（含嵌套 node_modules） */
function runtimeClosure () {
  const found = new Map()
  const queue = runtimeDeps.map(name => ({ name, from: root }))
  while (queue.length) {
    const { name, from } = queue.pop()
    const dir = resolveDir(name, from)
    if (!dir || found.has(dir)) continue
    found.set(dir, name)
    const meta = existsSync(join(dir, 'package.json')) ? readJson(join(dir, 'package.json')) : {}
    for (const dep of Object.keys({ ...meta.dependencies, ...meta.optionalDependencies })) {
      queue.push({ name: dep, from: dir })
    }
  }
  return found
}

/**
 * node_modules 规则的有限文法。读不懂就抛错 —— 宁可让检查失败，也不要"看不懂就放行"。
 *   { neg, kind: 'all' }                     node_modules/**            → 整片
 *   { neg, kind: 'suffix', ext: '.node' }    node_modules/**\/*.node    → 只捞某种后缀
 *   { neg, kind: 'scope', scope: '@a' }      node_modules/@a/**         → 整个 npm scope
 *   { neg, kind: 'pkg', name: 'chalk' }      node_modules/chalk/**      → 单个包
 *   返回 null  → 这条规则不涉及 node_modules
 */
function patternInfo (pattern) {
  const neg = pattern.startsWith('!')
  const body = neg ? pattern.slice(1) : pattern
  if (!body.startsWith('node_modules/')) return null
  if (/[{}()[\]]/.test(body)) throw new Error(`看不懂的 files 写法：${pattern}`)
  const rest = body.slice('node_modules/'.length)
  if (/^\*\*(\/\*)?$/.test(rest)) return { neg, kind: 'all' }
  const suffix = rest.match(/^\*\*\/\*(\.[A-Za-z0-9]+)$/)
  if (suffix) return { neg, kind: 'suffix', ext: suffix[1] }
  const scopeWide = rest.match(/^(@[^/]+)\/\*\*(\/\*)?$/)
  if (scopeWide) return { neg, kind: 'scope', scope: scopeWide[1] }
  const pkgWide = rest.match(/^((?:@[^/]+\/)?[^/]+)\/\*\*(\/\*)?$/)
  if (pkgWide) return { neg, kind: 'pkg', name: pkgWide[1] }
  throw new Error(`看不懂的 files 写法：${pattern}`)
}

/** 这条规则是否覆盖到整个包（后缀规则只覆盖包里的某种文件，不算覆盖整包） */
function coversPackage (info, name) {
  if (info.kind === 'all') return true
  if (info.kind === 'scope') return name.startsWith(`${info.scope}/`)
  if (info.kind === 'pkg') return name === info.name
  return false
}

/**
 * 有意排除的可选原生后端（体积换功能，见 docs/完善计划.md P2-6）：
 *   win-arm64 / win-x64-cuda / win-x64-cuda-ext —— 目标平台是 Windows x64，
 *   保留 CPU（win-x64）与 Vulkan（win-x64-vulkan）即可；CUDA 两个包合计 519MB，
 *   比整个离线安装包还大。**排除它们是有意的，不算漏包**；但必需的后端绝不能被排除，
 *   所以下面单列一条断言盯着必需项（只放行、不放心的方向各有人管）。
 */
const INTENTIONAL_EXCLUDE = [
  /^@node-llama-cpp\/win-arm64$/,
  /^@node-llama-cpp\/win-x64-cuda$/,
  /^@node-llama-cpp\/win-x64-cuda-ext$/
]
/**
 * 目标平台（Windows x64）跑本地模型必需的原生后端。
 *
 * win-x64-vulkan 看着像"能省 99 MB 的明显冗余"——CPU 兜底路径确实存在
 * （getGpuTypesToUseForOption 末位永远是 false），排掉程序不会崩。但实测本机
 * 走的就是 vulkan：同一段生成，vulkan 中位数 450 ms，退回 CPU 是 14580 ms
 * （慢 32 倍），且 CPU 那条把提示词复读三遍不作答。任何"顺手排掉 vulkan"的
 * 改动都会把演示现场拖成这样，所以让它响。
 *
 * 注意：这个结论要在 **Electron 里**测才算数。裸 `node` 下 binding 自检进程
 * 起不来，会打印 "Failed to load a prebuilt binary ... falling back to using
 * no GPU" 并回退 CPU —— 那是测试环境差异，不是 vulkan 坏了（2026-09-25 亲测：
 * 同一份 node_modules，裸 node 回退、`npx electron` 起来 gpu=vulkan）。
 */
const REQUIRED_BACKENDS = ['@node-llama-cpp/win-x64', '@node-llama-cpp/win-x64-vulkan']

{
  const closure = runtimeClosure()
  const names = [...new Set(closure.values())].sort()
  console.log(`      （运行时闭包 ${closure.size} 个安装目录 / ${names.length} 个包名）`)

  for (const [label, cfg] of CONFIGS) {
    const patterns = cfg.files || []
    let unreadable = null
    const reIncluded = new Set()
    const excluded = new Set()
    let excludedAll = false
    let blanketInclude = false
    for (const p of patterns) {
      let info
      try {
        info = patternInfo(p)
      } catch (e) {
        unreadable = e.message
        continue
      }
      if (!info) continue
      if (info.kind === 'all') {
        if (info.neg) excludedAll = true
        else blanketInclude = true
      } else if (info.kind === 'suffix') {
        continue // 只排除某种后缀，不会让整个包进不了包
      } else if (info.neg) {
        for (const n of names) if (coversPackage(info, n)) excluded.add(n)
      } else {
        for (const n of names) if (coversPackage(info, n)) reIncluded.add(n)
      }
    }
    // 被整片排除（!node_modules/**）或被点名排除、又没有显式重新包含的包（有意的除外）
    const missing = names.filter(n =>
      !reIncluded.has(n) && (excludedAll || excluded.has(n)) && !INTENTIONAL_EXCLUDE.some(re => re.test(n)))
    const looseRequired = REQUIRED_BACKENDS.filter(n =>
      !names.includes(n) || (!reIncluded.has(n) && (excludedAll || excluded.has(n))))
    check(`${label}：files 规则放行运行时依赖闭包`,
      !unreadable && missing.length === 0 && !blanketInclude && looseRequired.length === 0,
      unreadable
        ? unreadable
        : missing.length
          ? `会被漏掉的包：${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ` 等 ${missing.length} 个` : ''}`
          : blanketInclude
            ? 'files 里正片包含整个 node_modules，会把 devDependencies 一起装进去'
            : looseRequired.length
              ? `目标平台必需的原生后端被排除：${looseRequired.join(', ')}`
              : `${names.length} 个包全部放行（有意排除的可选后端已扣除）`)
    check(`${label}：目标平台必需的原生后端（CPU + Vulkan）没被排除`,
      looseRequired.length === 0,
      looseRequired.length ? `缺：${looseRequired.join(', ')}` : REQUIRED_BACKENDS.join(' + '))
  }
}

// ---------------------------------------------------------------------------
// 3. 带原生二进制的依赖必须整包 asarUnpack
// ---------------------------------------------------------------------------
function findNative (dir, depth = 0, out = []) {
  if (depth > 6 || !existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) findNative(p, depth + 1, out)
    else if (entry.endsWith('.node')) out.push(p.replace(root, ''))
  }
  return out
}

{
  const closure = runtimeClosure()
  const native = []
  for (const [dir, name] of closure) {
    if (findNative(dir).length) native.push(name)
  }
  const unpack = (pkg.build && pkg.build.asarUnpack) || []
  const infos = []
  for (const p of unpack) {
    const info = patternInfo(p)
    if (info) infos.push(info)
  }
  /** 原生二进制要么整包解包，要么被 `**\/*.node` 这种后缀规则捞出来 */
  const isUnpacked = (name) => infos.some(info =>
    coversPackage(info, name) || (info.kind === 'suffix' && info.ext === '.node'))
  const missing = native.filter(n => !isUnpacked(n))
  check('带原生二进制的依赖整包进 asarUnpack',
    missing.length === 0,
    missing.length
      ? `未解包：${missing.join(', ')}`
      : native.length ? `已解包：${native.join(', ')}` : '运行时闭包里没有原生二进制')
}

// ---------------------------------------------------------------------------
console.log(`\n合计 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项`)
if (failures.length) {
  console.log(`失败项：${failures.join('；')}`)
  process.exitCode = 1
}
