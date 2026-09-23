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
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
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
  shell: { openExternal: (url) => { openedExternal.push(url); return Promise.resolve() } },
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

// ---------------------------------------------------------------------------
Module._load = originalLoad
rmSync(userDataDir, { recursive: true, force: true })

console.log(`\n合计 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项`)
if (failures.length) {
  console.log(`失败项：${failures.join('；')}`)
  process.exitCode = 1
}
