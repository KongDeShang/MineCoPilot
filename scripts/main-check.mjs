/**
 * 矿山智工 - 主进程契约检查（scripts/main-check.mjs）
 *
 * 为什么需要这个脚本：
 *   e2e（scripts/e2e.mjs）跑在无头浏览器里、对着 Vite 开发服务器，**够不着主进程**；
 *   self-check 只镜像 utils/ 下的纯函数。于是 src/main/** 与 src/preload/** 长期
 *   只有一条"扫源码里有没有 toISOString().slice(0,10)"的正则检查 —— 结果就是
 *   「切换到该档」这个按钮能 100% 失败而所有验收全绿：
 *     preload 传的是裸字符串 id，主进程按 payload.id 取值 → 恒返回"缺少档位 id"。
 *
 * 做法：用 Module._load 把 electron 桩掉，把真实的 llmEngine 加载进来，
 * 调用它**真正注册到 ipcMain 上的 handler**，直接验证调用契约与安全边界。
 * 不加载真实模型（只用"未安装的档位"来验证参数解析，见下面 useNotInstalledTier 的说明）。
 *
 * 运行：npm run main-check
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import Module from 'node:module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
let fail = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    pass++
    console.log(`PASS  ${name}${detail ? `  [${detail}]` : ''}`)
  } else {
    fail++
    failures.push(name)
    console.log(`FAIL  ${name}${detail ? `  [${detail}]` : ''}`)
  }
}

// ---------------------------------------------------------------------------
// electron 桩：只提供主进程代码在**加载与注册阶段**真正用到的东西
// ---------------------------------------------------------------------------
const userDataDir = mkdtempSync(join(tmpdir(), 'ks-main-check-'))
const handlers = new Map()
const openedExternal = []
const openedPaths = []

const fakeElectron = {
  app: {
    isPackaged: false, // 开发模式：可信来源是 http://localhost:5173
    getPath: (name) => (name === 'userData' ? userDataDir : userDataDir),
    on: () => {},
    whenReady: () => Promise.resolve(),
    quit: () => {},
    getVersion: () => '0.0.0-test'
  },
  ipcMain: {
    handle: (channel, fn) => { handlers.set(channel, fn) },
    on: () => {}
  },
  BrowserWindow: function () {},
  shell: {
    openExternal: (url) => { openedExternal.push(url); return Promise.resolve() },
    // openPath 返回空串表示成功（与 electron 一致）
    openPath: (p) => { openedPaths.push(p); return Promise.resolve('') }
  },
  dialog: {}
}

// 只桩掉 'electron' 这一个请求，其余走原加载逻辑
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron
  return originalLoad.call(this, request, parent, isMain)
}

const require = Module.createRequire(import.meta.url)

let llmEngine
try {
  llmEngine = require(join(root, 'src', 'main', 'llmEngine.js'))
  llmEngine.registerLlmIpc({ ipcMain: fakeElectron.ipcMain })
} catch (error) {
  console.error('❌ 无法加载主进程模型引擎：', error)
  process.exit(1)
}

// 可信 / 不可信来源的假事件（assertTrusted 读的是 senderFrame.url）
const trustedEvent = { senderFrame: { url: 'http://localhost:5173/index.html' }, sender: { getURL: () => 'http://localhost:5173/index.html' } }
const untrustedEvent = { senderFrame: { url: 'https://evil.example/attack.html' }, sender: { getURL: () => 'https://evil.example/attack.html' } }

// ============ 1. IPC 来源校验真的会拦 ============
{
  const status = handlers.get('llm:status')
  check('llm:status 已注册', typeof status === 'function')

  let threw = null
  try { await status(untrustedEvent) } catch (e) { threw = e }
  check('不可信来源调用 IPC 必须抛错（注释声称的边界要真的拦得住）',
    !!threw && /不可信/.test(threw.message), threw ? threw.message : '没有抛错')

  let okResult
  try { okResult = await status(trustedEvent) } catch (e) { okResult = e }
  check('可信来源可正常调用 IPC', okResult && !(okResult instanceof Error), JSON.stringify(okResult))
}

// ============ 2. 档位切换的参数契约（这次缺陷的正主） ============
{
  const switchH = handlers.get('llm:switchModel')
  check('llm:switchModel 已注册', typeof switchH === 'function')

  const before = await handlers.get('llm:status')(trustedEvent)

  /**
   * 为什么用 'standard' 而不是 'light'：
   *   light 档的模型文件就在仓库里（resources/models/qwen2.5-0.5b），切过去会真的加载
   *   468MB 模型 —— 本脚本只验证**调用契约**，不需要也不应该加载模型。
   *   'standard' 在开发环境下必然未安装，于是流程会停在新加的"前置校验"那一步并如实返回
   *   "尚未安装"。这恰好能证明参数被正确解析了：
   *   若还像以前那样读 payload.id，裸字符串/对象都不会走到这一步，只会返回"缺少档位 id"。
   */
  const viaObject = await switchH(trustedEvent, { id: 'standard' })
  check('传 { id } 时能解析出档位（不再恒返回"缺少档位 id"）',
    viaObject && viaObject.error !== '缺少档位 id',
    JSON.stringify(viaObject))

  const viaBare = await switchH(trustedEvent, 'standard')
  check('传裸字符串同样能解析（兼容旧调用方，避免两侧契约再漂移）',
    viaBare && viaBare.error !== '缺少档位 id',
    JSON.stringify(viaBare))

  check('切到未安装的档位时如实报"尚未安装"并给出档位名',
    viaObject && /尚未安装/.test(viaObject.error || ''), String(viaObject && viaObject.error))

  check('切档失败不得改变当前档位（原实现会先把旧会话释放掉）',
    viaObject && viaObject.switched === false && viaObject.current === before.currentTierId,
    `current ${before.currentTierId} → ${viaObject && viaObject.current}`)

  const viaEmpty = await switchH(trustedEvent, {})
  const viaEmptyString = await switchH(trustedEvent, '')
  const viaMissing = await switchH(trustedEvent, undefined)
  check('缺参数时仍如实报"缺少档位 id"（不能把空值当成合法档位）',
    viaEmpty.error === '缺少档位 id' && viaEmptyString.error === '缺少档位 id' && viaMissing.error === '缺少档位 id',
    JSON.stringify([viaEmpty.error, viaEmptyString.error, viaMissing.error]))

  const viaUnknown = await switchH(trustedEvent, 'no-such-tier')
  check('未知档位报"未知档位"而不是静默成功',
    viaUnknown && /未知档位/.test(viaUnknown.error || ''), String(viaUnknown && viaUnknown.error))

  /**
   * 失败绝不能写偏好：model-pref.json 是"下次启动加载哪个档"的依据，
   * 写在一个跑不起来的档位上会让下次启动直接失败。
   * 原实现是先 writePref() 再去加载 —— 加载失败也照样留下了一个坏偏好。
   */
  check('切档失败不写 model-pref.json（原实现是先写偏好再加载）',
    !existsSync(join(userDataDir, 'model-pref.json')),
    join(userDataDir, 'model-pref.json'))
}

// ============ 3. 退出钩子依赖的导出确实存在 ============
{
  check('disposeSession 已导出（main/index.js 的 before-quit 依赖它释放会话）',
    typeof llmEngine.disposeSession === 'function')

  const r = await llmEngine.disposeSession()
  check('未加载任何会话时 disposeSession 返回"成功且无错误"（不抛错）',
    r && r.ok === true && Array.isArray(r.errors), JSON.stringify(r))
}

// ============ 4. 模型清单的三级兜底不依赖网络也能返回可用清单 ============
{
  const modelManager = require(join(root, 'src', 'main', 'modelManager.js'))
  check('modelManager 导出 listModels / getManifest',
    typeof modelManager.listModels === 'function' && typeof modelManager.getManifest === 'function')

  const manifest = await modelManager.getManifest()
  check('拉不到远端清单时回退到内置清单（离线可用，不阻塞主流程）',
    !!manifest && Array.isArray(manifest.models) && manifest.models.length > 0,
    `${manifest && manifest.models ? manifest.models.length : 0} 个档位`)
  check('内置清单里的每个档位都带 SHA-256 与体积（下载校验的依据）',
    manifest.models.every(m => m.sha256 && m.sizeBytes && m.file),
    manifest.models.map(m => `${m.id}:${m.sha256 ? m.sha256.slice(0, 8) : '缺'}`).join(' '))
}

// ============ 5. 打包配置与主进程常量保持一致 ============
{
  // 这条是防"改了主进程、忘了打包白名单"：装机后表现为"装上打不开模型"。
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const files = pkg.build.files || []
  check('package.json 的 files 白名单仍放行 src/main 与 src/preload',
    files.includes('src/main/**/*') && files.includes('src/preload/**/*'), files.join(','))
}

// ============ 6. 删除下载模型的行为契约（这一节对应用户实测的"删除失败 EPERM"） ============
//
// 为什么必须在主进程这一层验：e2e 跑在无头浏览器里，浏览器模式根本没有 models 桥
// （modelsClient 直接返回"浏览器模式无分发引擎"），"删除按钮点了会怎样"它在结构上够不着。
{
  const modelManager = require(join(root, 'src', 'main', 'modelManager.js'))
  const modelsDir = join(userDataDir, 'models')
  mkdirSync(modelsDir, { recursive: true })

  /**
   * 与 index.js registerIpc 里那一个同语义的来源校验。
   * 注意它是**桩**：真正的 assertTrusted 定义在 index.js 的 registerIpc 内部、不导出
   * （它读 app.isPackaged 决定可信前缀）。这里能验的是"每个 models:* handler 确实调用了
   * 传进来的校验函数"，校验函数本身的行为已由第 1 节对 llm:* 验过。
   */
  const assertTrustedStub = (event) => {
    const url = event.senderFrame?.url || event.sender.getURL()
    const ok = url.startsWith('http://localhost:5173')
    if (!ok) throw new Error('拒绝来自不可信来源的 IPC 调用')
  }

  // 记录"释放钩子"与"删文件"的调用顺序 —— 顺序反了就是用户那个 EPERM
  const order = []
  const releaseArgs = []
  const makeRelease = () => async (id, opts) => {
    order.push('release')
    releaseArgs.push({ id, opts })
    return llmEngine.releaseTierForRemoval(id, opts) // 真实实现，不是替身
  }
  const makeRm = (inner) => (dir, opts) => { order.push('rm'); return inner(dir, opts) }

  const liveRelease = makeRelease()
  modelManager.registerModelsIpc({ ipcMain: fakeElectron.ipcMain, assertTrusted: assertTrustedStub, release: liveRelease })

  const listH = handlers.get('models:list')
  const deleteH = handlers.get('models:delete')
  const openDirH = handlers.get('models:openDir')
  check('models:list / models:delete / models:openDir 均已注册',
    typeof listH === 'function' && typeof deleteH === 'function' && typeof openDirH === 'function')

  for (const [name, fn] of [['models:delete', deleteH], ['models:openDir', openDirH]]) {
    let threw = null
    try { await fn(untrustedEvent, { id: 'light' }) } catch (e) { threw = e }
    check(`${name} 不放过不可信来源（首行确实调用了来源校验）`,
      !!threw && /不可信/.test(threw.message), threw ? threw.message : '没有抛错')
  }

  // ---------- 清单：说清"哪几份、能不能删" ----------
  const list = await listH(trustedEvent)
  check('models:list 带出下载目录与随包目录（用户下过 1GB 模型后要能找到它）',
    !!list.dirs && !!list.dirs.userData && !!list.dirs.bundled, JSON.stringify(list.dirs))
  /**
   * dev 模式（isPackaged=false）随包目录必须是**项目根下的 resources/models**。
   * 这条是专门钉住那个已修缺陷的：modelManager 原写成 `process.resourcesPath || ''`，
   * 裸 node 下 process.resourcesPath 是 undefined → path.join('', 'models') = 相对路径 'models'，
   * 于是"模型在哪"在开发/测试环境下退化成相对当前工作目录，与 llmEngine 的答案不一致。
   */
  check('随包目录解析为项目 resources/models（不能再退化成相对路径）',
    list.dirs.bundled === join(root, 'resources', 'models'), list.dirs.bundled)
  check('removable 只由"下载副本在不在"决定，且两份副本的路径各自落在自己的目录内',
    list.models.every(m => m.removable === m.downloaded
      && (!m.downloaded || String(m.downloadedPath).startsWith(list.dirs.userData + sep))
      && (!m.bundled || String(m.bundledPath).startsWith(list.dirs.bundled + sep))),
    list.models.map(m => `${m.id}:${m.bundled ? 'B' : '-'}${m.downloaded ? 'D' : '-'}`).join(' '))

  const bundledOf = (id) => !!(list.models.find(x => x.id === id) || {}).bundled

  // ---------- 打开模型目录 ----------
  rmSync(join(modelsDir), { recursive: true, force: true })
  openedPaths.length = 0
  const opened = await openDirH(trustedEvent)
  check('models:openDir 打开的是 userData 下的 models 目录，并在目录不存在时先建出来',
    opened.ok === true && openedPaths.length === 1 && openedPaths[0] === modelsDir && existsSync(modelsDir),
    JSON.stringify({ opened, openedPaths }))
  /**
   * 刻意不接受前端传路径：目录由主进程自己算，没有路径穿越的入口。
   * 传一个越界路径过去，被打开的仍必须是模型目录（而不像 app:openPath 那样去解析入参）。
   */
  openedPaths.length = 0
  await openDirH(trustedEvent, { path: 'C:\\Windows\\System32' })
  check('models:openDir 忽略前端传来的路径（不接受入参，杜绝路径穿越）',
    openedPaths.length === 1 && openedPaths[0] === modelsDir, openedPaths.join(' | '))

  // ---------- 造一份"下载来的"标准档 ----------
  const lightFile = llmEngine.listModels().tiers.find(t => t.id === 'light').file
  const stdFile = 'qwen2.5-1.5b-instruct-q4_k_m.gguf'
  const mkTierDir = (dirName, file, bytes = 2048) => {
    const d = join(modelsDir, dirName)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, file), Buffer.alloc(bytes, 7))
    return d
  }

  const stdDir = mkTierDir('standard', stdFile)
  const list2 = await listH(trustedEvent)
  const std = list2.models.find(m => m.id === 'standard')
  check('下载副本装好后：standard 报 downloaded / removable 且路径指向 userData 下那份',
    std.downloaded === true && std.removable === true && std.downloadedPath === join(stdDir, stdFile),
    JSON.stringify({ downloaded: std.downloaded, removable: std.removable, path: std.downloadedPath }))
  check('随包只读的档位（light）不可删，且此时 removable 与 downloaded 一致（没有下载副本就没有删除入口）',
    list2.models.find(m => m.id === 'light').removable === false
      && list2.models.find(m => m.id === 'light').downloaded === false,
    `light bundled=${bundledOf('light')} downloaded=false → removable=${list2.models.find(m => m.id === 'light').removable}`)

  // ---------- 删除成功路径：先释放会话、再删文件 ----------
  //
  // 顺序只能在直调 deleteModel 时验（handler 不暴露 rm 注入）；handler 那条路径
  // 由下面"走 IPC 时确实把 release 传下去了"补上。两段合起来才覆盖完整链路。
  order.length = 0
  releaseArgs.length = 0
  const delOk = await modelManager.deleteModel('standard', { release: makeRelease(), rm: makeRm(rmSync) })
  check('删除前先调用释放钩子、之后才删文件（顺序反了就是 EPERM 那个缺陷）',
    order[0] === 'release' && order[1] === 'rm', order.join(' → '))
  check('释放钩子拿到的是被删档位 id（不能传错档位）',
    releaseArgs.length === 1 && releaseArgs[0].id === 'standard', JSON.stringify(releaseArgs))
  check('删除成功：deleted=true、目录真的消失、释放体积大于 0',
    delOk.ok === true && delOk.deleted === true && !existsSync(stdDir) && delOk.freedBytes > 0,
    JSON.stringify({ ok: delOk.ok, deleted: delOk.deleted, gone: !existsSync(stdDir), freed: delOk.freedBytes }))
  check('只删 userData 下的下载副本（removedPaths 全部落在下载目录内）',
    Array.isArray(delOk.removedPaths) && delOk.removedPaths.length === 1
      && delOk.removedPaths[0] === stdDir,
    JSON.stringify(delOk.removedPaths))
  /**
   * willRemain 必须与清单里的 bundled 一致：它决定"删掉这份之后档位还活着吗"，
   * 传错会让当前档位指针被错误地挪走（或反过来留在已消失的档位上）。
   */
  // 注意这里全部走可选链：钩子没被调用时这一条必须**如实变红**，
  // 而不是让脚本在 TypeError 上崩掉（崩掉会把后面的断言一起吞掉，诊断只剩半截）。
  const ra0 = releaseArgs[0]
  check('传给释放钩子的 willRemain 与清单报的"随包副本在不在"一致',
    !!(ra0 && ra0.opts) && ra0.opts.willRemain === bundledOf('standard'),
    `willRemain=${ra0 && ra0.opts ? ra0.opts.willRemain : '（释放钩子根本没被调用）'} bundled=${bundledOf('standard')}`)

  // 走 IPC 的那条路径：注册时给的释放钩子必须被真的传下去，否则界面上删除依旧 EPERM
  const stdDir3 = mkTierDir('standard', stdFile)
  releaseArgs.length = 0
  const delViaIpc = await deleteH(trustedEvent, { id: 'standard' })
  check('经由 models:delete 调用时同样把注册时的释放钩子传给了 deleteModel',
    delViaIpc.ok === true && delViaIpc.deleted === true && !existsSync(stdDir3)
      && releaseArgs.length === 1 && releaseArgs[0].id === 'standard',
    JSON.stringify({ ok: delViaIpc.ok, deleted: delViaIpc.deleted, releaseArgs }))

  // ---------- 没有可删的东西时不许假成功 ----------
  const delAgain = await deleteH(trustedEvent, { id: 'standard' })
  check('没有下载副本时如实返回 ok:false + deleted:false（原实现返回 ok:true，界面据此弹"已删除"）',
    delAgain.ok === false && delAgain.deleted === false && /没有已下载的副本/.test(delAgain.error || ''),
    JSON.stringify(delAgain))
  const delEnhanced = await deleteH(trustedEvent, { id: 'enhanced' })
  check('对从未安装、也没有下载源的档位同样如实报"没有已下载的副本"',
    delEnhanced.ok === false && delEnhanced.deleted === false, JSON.stringify(delEnhanced.error))
  const delUnknown = await deleteH(trustedEvent, { id: 'no-such-tier' })
  check('未知档位报"未知档位"而不是静默成功',
    delUnknown.ok === false && /未知档位/.test(delUnknown.error || ''), String(delUnknown.error))

  // ---------- 删不掉时（文件被占用）要给出可照做的提示 ----------
  const stdDir2 = mkTierDir('standard', stdFile)
  order.length = 0
  const eperm = Object.assign(new Error('EPERM, Permission denied: \\\\?\\' + stdDir2), { code: 'EPERM' })
  const delEperm = await modelManager.deleteModel('standard', {
    release: makeRelease(),
    rm: makeRm(() => { throw eperm })
  })
  check('文件被占用（EPERM）时如实失败，并给出可照做的处理办法',
    delEperm.ok === false && delEperm.deleted === false
      && /EPERM/.test(delEperm.error || '') && /占用/.test(delEperm.error || '')
      && /手动删除/.test(delEperm.error || ''),
    String(delEperm.error))
  check('占用类错误会重试（卸载后句柄不是立刻关掉的，删一次就放弃等于白卸载）',
    order.filter(x => x === 'rm').length >= 2, order.join(' → '))
  check('删失败时释放钩子**仍然**先被调用过（先卸载再尝试删，不是跳过卸载）',
    order[0] === 'release', order.join(' → '))
  check('删失败不谎报：文件仍在磁盘上，且不在 removedPaths 里',
    existsSync(join(stdDir2, stdFile)) && !(delEperm.removedPaths || []).includes(stdDir2),
    JSON.stringify(delEperm.removedPaths))

  // ---------- 旧版按模型名命名的目录也要清掉 ----------
  const legacyDir = mkTierDir('qwen2.5-0.5b', lightFile, 1024)
  releaseArgs.length = 0
  const delLegacy = await deleteH(trustedEvent, { id: 'light' })
  check('删除 light 时连同旧版目录 qwen2.5-0.5b/ 一并清理（只删 <id> 会留下"已删除但还装着"的假象）',
    delLegacy.ok === true && delLegacy.deleted === true && !existsSync(legacyDir),
    JSON.stringify({ ok: delLegacy.ok, gone: !existsSync(legacyDir) }))
  check('light 的 willRemain 同样与清单一致',
    releaseArgs.length === 1 && releaseArgs[0].id === 'light'
      && releaseArgs[0].opts.willRemain === bundledOf('light'),
    JSON.stringify(releaseArgs))

  // ---------- 删除档位后的档位指针 ----------
  const before = llmEngine.listModels().current
  // light 此刻既有随包只读副本、下载副本刚被删 —— 正是 willRemain=true 的真实场景
  const relKeep = await llmEngine.releaseTierForRemoval('light', { willRemain: true })
  check('档位在随包副本上还活着（willRemain）时，释放钩子不动当前档位指针',
    relKeep.current === before, `current ${before} → ${relKeep.current}（删除的档位是 light，willRemain=true）`)

  /**
   * 把下载副本清空，让"已安装"只剩随包那一份 —— 这样下一步删除当前档位时
   * remaining 恰好为空集。这不是为了好看：空集分支既是要验的行为本身，
   * 也是"重选时忘了把被删档位过滤掉"这类变异唯一会暴露出来的状态
   * （只要还有别的档位可选，被删的低档位本来就不会被 autoSelectTier 选中）。
   */
  await modelManager.deleteModel('standard', { release: makeRelease() })
  const currentNow = llmEngine.listModels().current
  const remaining = llmEngine.listModels().tiers.filter(t => t.installed && t.id !== currentNow).map(t => t.id)
  const relGone = await llmEngine.releaseTierForRemoval(currentNow, { willRemain: false })
  check('档位彻底消失时，当前档位指针不会再指向它',
    relGone.current !== currentNow, `删除的是当前档位 ${currentNow} → 指针变成 ${relGone.current}`)
  check('重选后的当前档位必须是真实已安装的档位；一个都不剩时为 null（不能直接采信 autoSelectTier）',
    relGone.current === null ? remaining.length === 0 : remaining.includes(relGone.current),
    JSON.stringify({ current: relGone.current, remaining }))
  /**
   * 上面那条断言里 `remaining.length ? ... : null` 的空集分支在本机**走不到**
   * （随包 light 恒在，删掉下载副本后 remaining 总非空）。所以这里改为把那个守卫
   * 赖以存在的**前提**钉死：autoSelectTier 在"一个都没装"时照样返回 'light'。
   * 前提为真 + 守卫写成三目，就是"删完最后一个档位后指针不会指回已删除档位"的完整依据。
   */
  const ModelRegistry = require(join(root, 'src', 'main', 'ModelRegistry.js'))
  check('autoSelectTier 在一个档位都没装时仍返回 light（这正是重选档位必须加空集守卫的原因）',
    ModelRegistry.autoSelectTier(ModelRegistry.TIERS.map(t => ({ ...t, installed: false }))) === 'light')
}

// ============ 7. 恢复出厂设置：删除范围与"不接参数"契约 ============
{
  /**
   * 这条 IPC 管的是"把这台机器交出去之前清干净"，做错了不可挽回，所以两条性质都要真验：
   *   ① 删除范围对不对（该清的清、models/ 绝不碰）—— **行为**验证，不扫源码；
   *   ② 一个入参都不认（删除范围硬编码）—— 收路径就等于开了
   *      "渲染层让我删什么我就删什么"的口子。
   *
   * 为什么删除逻辑单独放在 userDataReset.js：就是为了这里能 require 进来直接调用。
   * 扫 index.js 源码猜"它应该没读第二个参数"，正是 main-check 头注释里反省过的那种
   * 检查方式（src/main 长期只有正则，于是「切换到该档」能 100% 失败而验收全绿）。
   */
  const { wipeUserData } = require(join(root, 'src', 'main', 'userDataReset.js'))

  // 夹具：该在的都在（含 models/ 里那个"绝不能被删"的模型），目录外再放一个诱饵
  const outsideDir = mkdtempSync(join(tmpdir(), 'ks-main-check-outside-'))
  const decoy = join(outsideDir, '重要文件.txt')
  writeFileSync(decoy, '在 userData 之外，任何情况下都不该被碰')
  mkdirSync(join(userDataDir, 'documents'), { recursive: true })
  mkdirSync(join(userDataDir, 'backups'), { recursive: true })
  mkdirSync(join(userDataDir, 'models'), { recursive: true })
  writeFileSync(join(userDataDir, 'documents', 'bundled-a.pdf'), 'x')
  writeFileSync(join(userDataDir, 'backups', 'old.mbak'), 'x')
  writeFileSync(join(userDataDir, 'model-pref.json'), '{"tierId":"standard"}')
  writeFileSync(join(userDataDir, 'llm-verify.json'), '{}')
  writeFileSync(join(userDataDir, 'models', 'qwen2.5-0.5b.bin'), 'x')

  // 多喂一个参数：函数签名若真的收"要删哪些"，这个诱饵就会被带走
  const r = await wipeUserData(userDataDir, decoy, [decoy], { paths: [decoy] })

  check('wipeUserData 形参只有一个（"删除范围硬编码"在签名上就成立，不靠自觉）',
    wipeUserData.length === 1, `arity=${wipeUserData.length}`)
  check('目录外的文件一根汗毛都没动（多喂的参数一概不认，删除只发生在本目录内）',
    existsSync(decoy), `诱饵还在=${existsSync(decoy)}`)
  check('documents/ 与 backups/ 的内容被清空、目录本身留着（下次启动照常往里写）',
    readdirSync(join(userDataDir, 'documents')).length === 0 &&
      readdirSync(join(userDataDir, 'backups')).length === 0,
    `documents=${readdirSync(join(userDataDir, 'documents')).length} 项、backups=${readdirSync(join(userDataDir, 'backups')).length} 项`)
  check('model-pref.json / llm-verify.json 被删掉（否则下次启动会拿着旧偏好去找已删的档位）',
    !existsSync(join(userDataDir, 'model-pref.json')) && !existsSync(join(userDataDir, 'llm-verify.json')))
  check('models/ 原封不动（离线包的全部价值就在这儿，删了等于把装好的软件弄坏）',
    existsSync(join(userDataDir, 'models', 'qwen2.5-0.5b.bin')))
  check('返回值如实说明"保留了 models 以及为什么"（不让渲染层以为全清光了）',
    r && r.ok === true && Array.isArray(r.kept) && r.kept.some(s => /models/.test(s)),
    r ? JSON.stringify({ ok: r.ok, removed: r.removed, kept: r.kept }) : '没拿到返回值')

  /**
   * 上面验的是"模块删得对"，这里验"应用真的把它接上了"，且接线只有一行：
   * `assertTrusted(event)` 打头（删数据的口子必须先拦来源），紧接着
   * `wipeUserData(app.getPath('userData'))` —— 实参里**只有** userData，
   * 没有第二个字节能被渲染层左右。这行必须只能是源码断言（加载 index.js 要连
   * BrowserWindow/protocol 一起桩，得不偿失），但它盯的是一个一行的调用，
   * 比盯一段三十五行的函数体靠得住得多。
   */
  const idx = readFileSync(join(root, 'src', 'main', 'index.js'), 'utf8')
  const at = idx.indexOf("ipcMain.handle('app:factoryReset'")
  const call = at >= 0 ? idx.slice(at, at + 400) : ''
  check('index.js 注册了 app:factoryReset', at >= 0)
  check('handler 第一句就是 assertTrusted(event)（不可信来源先拦掉，再谈删什么）',
    /ipcMain\.handle\('app:factoryReset',\s*async \(event\) => \{\s*assertTrusted\(event\)/.test(call),
    call.split('\n').slice(0, 3).join(' / '))
  check('接线的实参只有 app.getPath(\'userData\')，不多传一个参数（渲染层无从指定删什么）',
    /wipeUserData\(\s*app\.getPath\('userData'\)\s*\)/.test(call),
    (call.match(/wipeUserData\([^)]*\)[^)]*\)/) || ['未找到调用'])[0])
  rmSync(outsideDir, { recursive: true, force: true })
}

// ============ 8. 接线：上面那套能力必须真的被挂到应用上 ============
{
  /**
   * 第 6 节验的是"modelManager 支持这么做"，这一节验"应用真的这么接了"。
   * 两条都只能是源码断言（index.js 的 registerIpc 在 app.whenReady 里跑，桩掉整个
   * BrowserWindow 去加载它得不偿失）；因此断言有意写成"必须出现这个接线"，
   * 改错/漏接会立刻变红。
   */
  const idx = readFileSync(join(root, 'src', 'main', 'index.js'), 'utf8')
  check('index.js 把 llmEngine.releaseTierForRemoval 接进了 registerModelsIpc（漏接则删除必然 EPERM）',
    /registerModelsIpc\(\{[\s\S]{0,200}?release\s*:\s*releaseTierForRemoval/.test(idx),
    (idx.match(/registerModelsIpc\(\{[^}]*\}/) || ['未找到调用'])[0])
  check('index.js 从 llmEngine 解构出了 releaseTierForRemoval（否则上面那行会拿到 undefined）',
    /require\('\.\/llmEngine'\)[\s\S]{0,200}?releaseTierForRemoval|releaseTierForRemoval[\s\S]{0,200}?require\('\.\/llmEngine'\)/.test(idx),
    (idx.match(/const \{[^}]*\} = require\('\.\/llmEngine'\)/) || ['未找到解构'])[0])

  const hub = readFileSync(join(root, 'src', 'renderer', 'src', 'views', 'ModelHub.vue'), 'utf8')
  check('ModelHub 的删除按钮受 t.removable 约束（否则对随包只读档位也会给出"删除"并谎报成功）',
    /v-if="t\.removable"/.test(hub) && /modelsDelete\(t\.id\)/.test(hub))
  check('ModelHub 删除结果看 deleted 而不是只看 ok（ok:true + deleted:false 曾是"假成功"）',
    /r\.ok\s*&&\s*r\.deleted/.test(hub), (hub.match(/if \(r && r\.ok && r\.deleted\)/) || ['未找到判断'])[0])
}

// ---------------------------------------------------------------------------
Module._load = originalLoad
rmSync(userDataDir, { recursive: true, force: true })

console.log(`\n合计 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项`)
if (failures.length) {
  console.log(`失败项：${failures.join('；')}`)
  process.exitCode = 1
}
