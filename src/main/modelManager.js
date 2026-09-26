/**
 * modelManager.js —— 模型云端分发管理
 *
 * 职责（任务 07）：
 * 1. 云端清单（models.json）：内置兜底清单 + 可选的远端拉取（失败静默降级，不阻塞）；
 * 2. 下载器：多源自动切换（HF 官方 → hf-mirror 镜像 → ModelScope 魔搭 → GitHub Release 兜底）、
 *    GitHub Releases 302 重定向跟随（保留 Range）、断点续传（.part）、
 *    SHA-256 校验（不符删残档可重试）、超时/失败自动重试（指数退避）；
 * 3. 删除模型释放空间；4. 双源扫描合并（resources/models + userData/models）。
 *
 * 铁律：下载只发生在用户明确点击时；运行期无任何自动联网下载。
 * 注意：SHA-256 已于 2026-09-16 实测登记（0.5B 本地实测 + HF/魔搭交叉一致；1.5B HF X-Linked-Etag 与魔搭 API 一致），
 *       非占位。GitHub Release 兜底源待模型上传后生效（当前 404 不影响：前面的源成功即不走到该源）。
 */

const path = require('path')
const fs = require('fs')
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const { app, shell } = require('electron')
const { scanTiers, locateTier, tierDirNames } = require('./ModelRegistry')

const { TIERS } = require('./ModelRegistry')

// ---------------------------------------------------------------------------
// 目录
// ---------------------------------------------------------------------------

function userModelsDir() {
  // userData/models —— 用户可写，云端下载落点。
  // ⚠️ 这个位置**与程序安装目录无关**：装机版在 D:\xxx、下载的模型仍在
  // %APPDATA%\<app>\models 下。卸载程序不会删除它（用户下载的 1GB 模型不该被静默丢掉），
  // 界面必须把这条路径显示出来，否则用户找不到自己下过的模型。
  return path.join(app.getPath('userData'), 'models')
}

/** 随包只读模型根：dev 用项目根 resources，打包后用安装目录 resources */
function bundledModelsDir() {
  const base = app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '../../resources')
  return path.join(base, 'models')
}

function modelRoots() {
  // 双源：resources/models（随包只读，离线包）+ userData/models（用户下载）。
  // 这是全仓"模型在哪"的唯一定义，llmEngine 也委托到这里（此前两处各写一份且开发模式不一致）。
  return [bundledModelsDir(), userModelsDir()]
}

/**
 * 一个档位"在哪几份、能不能删"的完整回答。
 *
 * installed / installedPath（scanTiers）沿用短路语义 = "实际会被加载的那一份"；
 * 这里额外区分随包副本与下载副本，因为它们是两件事的依据：
 *   · 删除按钮该不该出现 —— 只有**下载副本**可删，随包的是只读资源；
 *   · 删掉之后档位还能不能用 —— 随包副本还在就依然可用，只是回到只读那份。
 */
function installDetailFor(tier) {
  const loc = locateTier(tier, modelRoots())
  const bundled = loc.roots.find(r => r.dir === bundledModelsDir()) || { path: null }
  const downloaded = loc.roots.find(r => r.dir === userModelsDir()) || { path: null }
  return {
    bundled: !!bundled.path,
    bundledPath: bundled.path,
    downloaded: !!downloaded.path,
    downloadedPath: downloaded.path,
    removable: !!downloaded.path,
    effectivePath: loc.effective
  }
}

// ---------------------------------------------------------------------------
// 云端清单（manifest）
// ---------------------------------------------------------------------------

/** 远端清单（可选）：提交到仓库根目录，客户端启动时静默拉取，失败用内置/缓存 */
const MANIFEST_URL =
  'https://raw.githubusercontent.com/KongDeShang/MineCoPilot/main/models.json'

/** 内置兜底清单：多源直链（HF 官方 / hf-mirror / ModelScope / GitHub Release 兜底），SHA 已实测登记 */
const FALLBACK_MANIFEST = {
  version: '1.1.0',
  updatedAt: '2026-09-16',
  models: [
    {
      id: 'light',
      name: 'Qwen2.5-0.5B-Instruct',
      tier: 'light',
      file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
      sizeBytes: 491400032,
      minMemoryGB: 4,
      capabilities: ['narrate'],
      sha256: '74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db', // 本地实测 = HF 官方 = 魔搭
      version: '1.0.0',
      license: 'Apache-2.0',
      urls: [
        'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf',
        'https://hf-mirror.com/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf',
        'https://modelscope.cn/models/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/master/qwen2.5-0.5b-instruct-q4_k_m.gguf',
        'https://github.com/KongDeShang/MineCoPilot/releases/download/models-v1.0.0/qwen2.5-0.5b-instruct-q4_k_m.gguf'
      ]
    },
    {
      id: 'standard',
      name: 'Qwen2.5-1.5B-Instruct',
      tier: 'standard',
      file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
      sizeBytes: 1117320736,
      minMemoryGB: 8,
      capabilities: ['narrate', 'diagnose', 'summarize'],
      sha256: '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e', // HF X-Linked-Etag = 魔搭 API
      version: '1.0.0',
      license: 'Apache-2.0',
      urls: [
        'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf',
        'https://hf-mirror.com/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf',
        'https://modelscope.cn/models/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/master/qwen2.5-1.5b-instruct-q4_k_m.gguf',
        'https://github.com/KongDeShang/MineCoPilot/releases/download/models-v1.0.0/qwen2.5-1.5b-instruct-q4_k_m.gguf'
      ]
    }
  ]
}

let manifestCache = null
let manifestSource = 'builtin'

function manifestCachePath() {
  return path.join(userModelsDir(), 'manifest-cache.json')
}

/** 拉取远端清单（限时 5s、限大小 1MB、跟随 302），失败 throw */
function fetchRemoteManifest() {
  return new Promise((resolve, reject) => {
    const doGet = (url, redirectsLeft) => {
      const mod = url.startsWith('https:') ? https : http
      const req = mod.get(url, { timeout: 5000 }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          res.resume()
          doGet(new URL(res.headers.location, url).toString(), redirectsLeft - 1)
          return
        }
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`清单拉取失败（HTTP ${res.statusCode}）`))
          return
        }
        const chunks = []
        let size = 0
        res.on('data', (c) => {
          size += c.length
          if (size > 1024 * 1024) {
            req.destroy(new Error('清单过大，已中止'))
            return
          }
          chunks.push(c)
        })
        res.on('end', () => {
          try {
            const m = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (!m || !Array.isArray(m.models)) throw new Error('清单结构不合法')
            resolve(m)
          } catch (e) { reject(e) }
        })
        res.on('error', reject)
      })
      req.setTimeout(5000, () => req.destroy(new Error('清单拉取超时')))
      req.on('error', reject)
    }
    doGet(MANIFEST_URL, 5)
  })
}

/** 获取当前清单：远端 → 本地缓存 → 内置兜底（不阻塞主流程） */
async function getManifest() {
  if (manifestCache) return manifestCache
  try {
    const m = await fetchRemoteManifest()
    manifestCache = m
    manifestSource = 'remote'
    try {
      fs.mkdirSync(userModelsDir(), { recursive: true })
      fs.writeFileSync(manifestCachePath(), JSON.stringify(m), 'utf8')
    } catch { /* 缓存写失败不影响 */ }
  } catch {
    try {
      manifestCache = JSON.parse(fs.readFileSync(manifestCachePath(), 'utf8'))
      manifestSource = 'cache'
    } catch {
      manifestCache = FALLBACK_MANIFEST
      manifestSource = 'builtin'
    }
  }
  return manifestCache
}

// ---------------------------------------------------------------------------
// 下载器（断点续传 + 302 跟随 + SHA 校验）
// ---------------------------------------------------------------------------

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

/**
 * 默认请求头：魔搭（modelscope）的 resolve 直链对无 UA/Referer 的裸请求返回 403，
 * 对 HF / hf-mirror / GitHub 无副作用；统一带上保证多源全部可达。
 */
const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 MineCoPilot/1.0.0',
  Referer: 'https://modelscope.cn/'
}

function httpRequest(url, { method = 'GET', headers = {}, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http
    const req = mod.request(url, { method, headers }, (res) => resolve(res))
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
    req.end()
  })
}

/** 跟随重定向（保留 Range），返回最终 2xx/4xx 响应 */
async function resolveWithRedirects(url, headers, redirectsLeft) {
  const res = await httpRequest(url, { headers })
  if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
    res.resume() // 丢弃中间跳转的 body
    return resolveWithRedirects(new URL(res.headers.location, url).toString(), headers, redirectsLeft - 1)
  }
  return res
}

/**
 * 下载单个文件到 destFile（.part 续传）。
 * @returns {{ok:true, sha256:string, bytes:number, total:number}}
 */
async function downloadOne(sourceUrl, destFile, { onProgress, expectedSha, retries = 3 } = {}) {
  let lastErr = null
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await downloadAttempt(sourceUrl, destFile, { onProgress, expectedSha })
    } catch (err) {
      lastErr = err
      if (attempt < retries) await sleep(1000 * attempt) // 退避：1s / 2s
    }
  }
  throw lastErr
}

/**
 * 计算**整个文件**的 SHA-256（分块流式读取，不在主进程里同步阻塞）。
 *
 * 续传场景必须用它，不能用"边收边 hash"：那样只覆盖本次新到的字节（见 downloadAttempt）。
 * 468MB 约 1-2 秒，相对几分钟的下载可忽略。
 */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}

async function downloadAttempt(sourceUrl, destFile, { onProgress, expectedSha }) {
  const partFile = destFile + '.part'
  const start = fs.existsSync(partFile) ? fs.statSync(partFile).size : 0

  // 首次/续传统一带 Range 跟随重定向（GitHub Releases / HF / 魔搭 → CDN，保留 Range）
  const res = await resolveWithRedirects(sourceUrl, { ...DEFAULT_HEADERS, Range: `bytes=${start}-` }, 5)

  if (res.statusCode === 403 || res.statusCode === 429) {
    res.resume()
    throw new Error(`下载被拒（HTTP ${res.statusCode}），下载链接可能已过期，请重试`)
  }
  if (res.statusCode >= 400) {
    res.resume()
    throw new Error(`下载失败（HTTP ${res.statusCode}）`)
  }

  const isRange = res.statusCode === 206
  const total =
    start +
    (isRange
      ? parseInt(String(res.headers['content-range'] || '').split('/')[1] || res.headers['content-length'] || 0, 10)
      : parseInt(res.headers['content-length'] || 0, 10))

  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(partFile, { flags: 'a' })
    let received = start
    let failed = false

    res.on('data', (chunk) => {
      received += chunk.length
      if (typeof onProgress === 'function') {
        onProgress({
          received,
          total: total || received,
          pct: total ? Math.min(100, Math.round((received / total) * 100)) : 0
        })
      }
    })
    res.on('error', (err) => {
      failed = true
      out.destroy()
      reject(err)
    })
    out.on('error', (err) => {
      failed = true
      res.destroy()
      reject(err)
    })
    res.on('end', () => {
      if (failed) return
      out.end(async () => {
        if (failed) return
        /**
         * ⚠️ 必须对**整个 .part 文件**重新计算摘要，不能用"边收边 hash"。
         *
         * 原先这里是流式 hash（res.on('data') 里 hash.update(chunk)），只喂了
         * **本次新收到**的字节。首下（start=0）时它恰好正确；但一旦续传（start>0，
         * 走 Range 拿 206），hash 里只有后半段，而磁盘上的 .part 因为是追加写
         * （flags:'a'）其实是完整的 —— 于是摘要必然与清单里的整文件 SHA 不符
         * → 残档被删 → 从 0 重下。
         *
         * 净效果：下载承受不了任何一次网络中断，断一次就丢光进度。在线轨不带
         * resources/models、下载是唯一途径，因此在弱网下基本拿不到模型。
         * （进度上报那行一直用 received = start，是认得 start 的；摘要这条路径漏了同一件事。）
         *
         * 改为整体计算后，续传与"多源共享 .part"（见 downloadModel）天然正确，
         * 也不再有 start 的边界可错。代价是多读一遍文件（468MB ≈ 1-2 秒）。
         */
        let actualSha
        try {
          actualSha = await sha256File(partFile)
        } catch (err) {
          reject(new Error(`读取已下载文件以校验摘要失败：${err && err.message ? err.message : err}`))
          return
        }
        if (expectedSha && actualSha !== String(expectedSha).toLowerCase()) {
          fs.rmSync(partFile, { force: true }) // 不符删残档可重试
          reject(new Error(`SHA-256 校验失败（期望 ${expectedSha}，实际 ${actualSha}），已删除残档，可重新下载`))
          return
        }
        fs.renameSync(partFile, destFile)
        resolve({ ok: true, sha256: actualSha, bytes: received, total })
      })
    })
    res.pipe(out)
  })
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

/** 云端清单 + 本地安装状态合并（含 registry 中"待扩展"档位） */
async function listModels() {
  const manifest = await getManifest()
  const scanned = scanTiers(modelRoots())
  const out = []
  const seen = new Set()

  for (const m of manifest.models || []) {
    const local = scanned.find((s) => s.id === m.tier)
    // 清单里可能有 TIERS 尚未定义的档位，此时没有档位元数据可定位，只能报"未安装"
    const tier = TIERS.find((t) => t.id === m.tier)
    out.push({
      id: m.tier,
      name: m.name,
      file: m.file,
      sizeBytes: m.sizeBytes,
      minMemoryGB: m.minMemoryGB,
      capabilities: m.capabilities || [],
      sha256: m.sha256 || null,
      version: m.version,
      license: m.license || 'Apache-2.0',
      urls: m.urls || [],
      available: true,
      installed: !!(local && local.installed),
      installedPath: (local && local.installedPath) || null,
      installedSize: (local && local.installedSize) || 0,
      ...(tier ? installDetailFor(tier) : {})
    })
    seen.add(m.tier)
  }

  // registry 里有定义但清单未覆盖的档位（如 enhanced 4B 待扩展）：显示本地状态，不可下载
  for (const t of TIERS) {
    if (seen.has(t.id)) continue
    const local = scanned.find((s) => s.id === t.id)
    out.push({
      id: t.id,
      name: t.displayName,
      file: t.file,
      sizeBytes: t.sizeBytes,
      minMemoryGB: t.minMemoryGB,
      capabilities: t.capabilities || [],
      sha256: null,
      version: null,
      license: 'Apache-2.0',
      urls: [],
      available: false,
      installed: !!(local && local.installed),
      installedPath: (local && local.installedPath) || null,
      installedSize: (local && local.installedSize) || 0,
      ...installDetailFor(t)
    })
  }

  return {
    ok: true,
    models: out,
    // 界面要把"下载的模型放哪"如实显示出来（否则用户在下过 1GB 模型后找不到它）。
    // 路径由主进程给出，不由渲染层猜。
    dirs: { userData: userModelsDir(), bundled: bundledModelsDir() },
    source: manifestSource,
    version: manifest.version,
    updatedAt: manifest.updatedAt
  }
}

/** 下载模型档位到 userData/models/<tier>/；同一时间只允许一个下载 */
let currentDownload = null

async function downloadModel(id, { onProgress } = {}) {
  const manifest = await getManifest()
  const m = (manifest.models || []).find((x) => x.tier === id || x.id === id)
  if (!m) throw new Error(`未知或不可下载的模型：${id}`)
  if (!m.urls || !m.urls.length) throw new Error(`模型 ${id} 暂无可用下载地址（待扩展）`)
  if (currentDownload) throw new Error('已有模型正在下载，请稍候')

  const destDir = path.join(userModelsDir(), m.tier)
  fs.mkdirSync(destDir, { recursive: true })
  const destFile = path.join(destDir, m.file)
  const record = { id: m.tier, startedAt: Date.now() }
  currentDownload = record
  try {
    // 多源自动切换：按清单 urls 顺序逐个尝试（HF 官方 → 镜像 → 魔搭 → GitHub 兜底）。
    // 断点续传的 .part 跨源共享（源内容不一致时最终 SHA 校验会删残档换源重试，不产生坏文件）。
    const sources = m.urls && m.urls.length ? m.urls : []
    if (!sources.length) throw new Error(`模型 ${id} 暂无可用下载地址（待扩展）`)
    let lastErr = null
    let result = null
    for (const url of sources) {
      try {
        result = await downloadOne(url, destFile, { onProgress, expectedSha: m.sha256 || null })
        break
      } catch (err) {
        lastErr = err
      }
    }
    if (!result) throw lastErr || new Error(`模型 ${id} 所有下载源均失败`)
    // 登记安装信息（版本/哈希/时间）
    fs.writeFileSync(
      path.join(destDir, 'model-meta.json'),
      JSON.stringify({ id: m.tier, file: m.file, version: m.version, sha256: result.sha256, installedAt: new Date().toISOString() }, null, 2),
      'utf8'
    )
    return { ok: true, ...result }
  } finally {
    currentDownload = null
  }
}

/** 递归统计目录体积（只为如实报出"释放了多少空间"） */
function dirSize(dir) {
  let total = 0
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch { return 0 }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    try {
      if (e.isDirectory()) total += dirSize(p)
      else total += fs.statSync(p).size
    } catch { /* 单个条目读不到就跳过 */ }
  }
  return total
}

/**
 * 删目录 + 退避重试。
 *
 * 卸载会话之后，文件句柄并不是立刻关掉的（Windows 上尤其如此），紧接着删仍可能
 * EBUSY / EPERM —— 那就等于白卸载了。这里对"占用类"错误重试几次，把"刚释放就删"
 * 的竞态吃掉；真删不掉时把最后一次错误原样返回，由调用方如实转述。
 * 非占用类错误（如 ENOENT 之外的路径问题）不重试，直接返回。
 */
async function removeDirWithRetry(dir, rm, { attempts = 4, delayMs = 250 } = {}) {
  let last = null
  for (let i = 0; i < attempts; i++) {
    try {
      rm(dir, { recursive: true, force: true })
      return null
    } catch (err) {
      last = err
      const code = (err && err.code) || ''
      if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(code)) return err
      if (i < attempts - 1) await sleep(delayMs * (i + 1))
    }
  }
  return last
}

/** 把删除失败翻译成用户能照做的说法（原始报错保留在后面） */
function rmFailureMessage(err, tier) {
  const code = (err && err.code) || ''
  const detail = (err && err.message) || String(err)
  if (code === 'EPERM' || code === 'EACCES') {
    return `${detail}。模型文件仍被占用（通常是本地模型正在使用中）：请先停用本地模型或关闭 AI 助手后重试；若仍失败，可手动删除 ${userModelsDir()} 下的「${tier.id}」目录`
  }
  if (code === 'EBUSY' || code === 'ENOTEMPTY') {
    return `${detail}。文件仍被占用，请稍后重试`
  }
  return detail
}

/**
 * 删除档位的**下载副本**（随包只读副本不动），释放空间。
 *
 * 修复前这个函数做三件事而只对了一件：
 *   1. 不释放会话就 rmSync —— llama.cpp 把 GGUF 映射在进程里，Windows 上必然 EPERM。
 *      用户实测报错：`删除失败：EPERM, Permission denied: ...\models\standard`，删除永远失败；
 *   2. 目录不存在时返回 `{ ok:true, deleted:false }`，而界面只判断 `r.ok` ——
 *      对随包内置、根本没有下载副本的档位照样弹"已删除"。一次彻底的假成功：
 *      用户以为删了，磁盘上一个字节都没少；
 *   3. 只删 `<userData>/models/<id>`，旧版按模型名命名的目录（qwen2.5-0.5b/）留在磁盘上，
 *      界面显示"已删除"而档位依然 installed。
 *
 * @param {string} id 档位 id
 * @param {{release?: Function, rm?: Function}} opts release 必须是**删除前**调用的释放钩子
 *        （llmEngine.releaseTierForRemoval）；rm 仅供测试注入，默认 fs.rmSync
 * @returns {Promise<{ok:boolean, deleted:boolean, freedBytes?:number, removedPaths?:string[],
 *          released?:boolean, current?:string|null, bundled?:boolean, error?:string}>}
 */
async function deleteModel(id, { release, rm = fs.rmSync } = {}) {
  const tier = TIERS.find((t) => t.id === id)
  if (!tier) return { ok: false, deleted: false, error: `未知档位：${id}` }

  // 旧版目录名一并算上：只删 <id> 会留下 qwen2.5-0.5b/ 这种历史目录，
  // 表现为"删了但档位还在、空间也没释放"。
  const dirs = tierDirNames(id).map((name) => path.join(userModelsDir(), name))
  const present = dirs.filter((d) => fs.existsSync(d))
  const bundled = !!locateTier(tier, [bundledModelsDir()]).effective

  if (!present.length) {
    // 没有可删的东西**不是成功**。以前这里返回 ok:true，界面就照着弹了"已删除"。
    return {
      ok: false,
      deleted: false,
      bundled,
      error: bundled
        ? `「${tier.name}」随程序安装提供只读副本，没有可删除的下载副本`
        : `「${tier.name}」没有已下载的副本，无需删除`
    }
  }

  const freedBytes = present.reduce((sum, d) => sum + dirSize(d), 0)

  // ① 先卸载会话，再删文件 —— 顺序反了就是用户那个 EPERM。
  let released = false
  let current = null
  if (typeof release === 'function') {
    try {
      const r = await release(id, { willRemain: bundled })
      if (r && typeof r === 'object') {
        released = !!r.released
        current = 'current' in r ? r.current : null
      }
    } catch (err) {
      // 钩子异常不能让删除半途而废：文件还在，继续往下走，
      // 真删不掉会由 ② 如实报错（也可能钩子失败但文件没被占用，那就照样删掉）。
      console.warn('[模型] 删除前释放会话异常：', (err && err.message) || err)
    }
  }

  // ② 删文件
  const removedPaths = []
  for (const dir of present) {
    const err = await removeDirWithRetry(dir, rm)
    if (err) {
      return { ok: false, deleted: false, freedBytes: 0, removedPaths, released, current, bundled, error: rmFailureMessage(err, tier) }
    }
    removedPaths.push(dir)
  }

  return { ok: true, deleted: true, freedBytes, removedPaths, released, current, bundled }
}

/**
 * 注册 IPC（models:*），来源校验复用 index.js 的 assertTrusted
 *
 * @param {Function} release 删除前的会话释放钩子（index.js 传 llmEngine.releaseTierForRemoval）。
 *        不传也能跑，但删除正在使用的档位会因文件被映射而失败 —— 缺了它这个功能就是坏的。
 */
function registerModelsIpc({ ipcMain, assertTrusted, release }) {
  ipcMain.handle('models:list', async (event) => {
    assertTrusted(event)
    try {
      return await listModels()
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })

  ipcMain.handle('models:download', async (event, payload) => {
    assertTrusted(event)
    const id = payload && payload.id
    if (!id || typeof id !== 'string') return { ok: false, error: '缺少模型 id' }
    const sender = event.sender
    try {
      return await downloadModel(id, {
        onProgress: (p) => {
          if (!sender.isDestroyed()) sender.send('models:progress', { id, ...p })
        }
      })
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })

  ipcMain.handle('models:delete', async (event, payload) => {
    assertTrusted(event)
    const id = payload && payload.id
    if (!id || typeof id !== 'string') return { ok: false, error: '缺少模型 id' }
    try {
      return await deleteModel(id, { release })
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })

  /**
   * 打开"下载模型"的存放目录，供界面上的「打开目录」按钮使用。
   *
   * 刻意**不接受前端传路径**：目录由主进程自己算，没有路径穿越的入口。
   * 也不复用 app:openPath —— 那个 handler 按设计只放行 documents/ 之内（见 index.js
   * 的 resolveInDocs），模型目录在 userData/models，走它会被自己的边界挡下来。
   */
  ipcMain.handle('models:openDir', async (event) => {
    assertTrusted(event)
    const dir = userModelsDir()
    try {
      await fs.promises.mkdir(dir, { recursive: true }) // 还没下过任何模型时目录可能不存在
      const err = await shell.openPath(dir)
      return err ? { ok: false, error: err } : { ok: true, path: dir }
    } catch (error) {
      return { ok: false, error: (error && error.message) || String(error) }
    }
  })
}

module.exports = {
  modelRoots,
  userModelsDir,
  getManifest,
  listModels,
  downloadModel,
  deleteModel,
  registerModelsIpc,
  // 供测试注入
  _downloadOne: downloadOne,
  _FALLBACK_MANIFEST: FALLBACK_MANIFEST
}
