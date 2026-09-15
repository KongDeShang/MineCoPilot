/**
 * modelManager.js —— 模型云端分发管理
 *
 * 职责（任务 07）：
 * 1. 云端清单（models.json）：内置兜底清单 + 可选的远端拉取（失败静默降级，不阻塞）；
 * 2. 下载器：GitHub Releases 302 重定向跟随（保留 Range）、断点续传（.part）、
 *    SHA-256 校验（不符删残档可重试）、超时/失败自动重试（指数退避）；
 * 3. 删除模型释放空间；4. 双源扫描合并（resources/models + userData/models）。
 *
 * 铁律：下载只发生在用户明确点击时；运行期无任何自动联网下载。
 * 注意：模型上传仓库 https://github.com/KongDeShang/MineCoPilot（Release tag: models-v1.0.0）。
 *       sha256 占位 null —— 上传后用 `Get-FileHash <file> -Algorithm SHA256` 实测填写，
 *       不得编造。sha256 为空时下载完成跳过校验并返回实际哈希（便于登记）。
 */

const path = require('path')
const fs = require('fs')
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const { app } = require('electron')
const { scanTiers } = require('./ModelRegistry')

const { TIERS } = require('./ModelRegistry')

// ---------------------------------------------------------------------------
// 目录
// ---------------------------------------------------------------------------

function userModelsDir() {
  // userData/models —— 用户可写，云端下载落点
  return path.join(app.getPath('userData'), 'models')
}

function modelRoots() {
  // 双源：resources/models（随包只读，离线包）+ userData/models（用户下载）
  return [path.join(process.resourcesPath || '', 'models'), userModelsDir()]
}

// ---------------------------------------------------------------------------
// 云端清单（manifest）
// ---------------------------------------------------------------------------

/** 远端清单（可选）：提交到仓库根目录，客户端启动时静默拉取，失败用内置/缓存 */
const MANIFEST_URL =
  'https://raw.githubusercontent.com/KongDeShang/MineCoPilot/main/models.json'

/** 内置兜底清单：URL 已确定（GitHub Releases 直链），SHA 上传后填实际值 */
const FALLBACK_MANIFEST = {
  version: '1.0.0',
  updatedAt: '2026-09-15',
  models: [
    {
      id: 'light',
      name: 'Qwen2.5-0.5B-Instruct',
      tier: 'light',
      file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
      sizeBytes: 491318888,
      minMemoryGB: 4,
      capabilities: ['narrate'],
      sha256: null, // 待填：模型上传后 Get-FileHash 实测
      version: '1.0.0',
      license: 'Apache-2.0',
      urls: [
        'https://github.com/KongDeShang/MineCoPilot/releases/download/models-v1.0.0/qwen2.5-0.5b-instruct-q4_k_m.gguf'
      ]
    },
    {
      id: 'standard',
      name: 'Qwen2.5-1.7B-Instruct',
      tier: 'standard',
      file: 'qwen2.5-1.7b-instruct-q4_k_m.gguf',
      sizeBytes: 1144000000,
      minMemoryGB: 8,
      capabilities: ['narrate', 'diagnose', 'summarize'],
      sha256: null, // 待填
      version: '1.0.0',
      license: 'Apache-2.0',
      urls: [
        'https://github.com/KongDeShang/MineCoPilot/releases/download/models-v1.0.0/qwen2.5-1.7b-instruct-q4_k_m.gguf'
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

async function downloadAttempt(sourceUrl, destFile, { onProgress, expectedSha }) {
  const partFile = destFile + '.part'
  const start = fs.existsSync(partFile) ? fs.statSync(partFile).size : 0

  // 首次/续传统一带 Range 跟随重定向（GitHub Releases → objects.githubusercontent.com，保留 Range）
  const res = await resolveWithRedirects(sourceUrl, { Range: `bytes=${start}-` }, 5)

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
    const hash = crypto.createHash('sha256')
    const out = fs.createWriteStream(partFile, { flags: 'a' })
    let received = start
    let failed = false

    res.on('data', (chunk) => {
      received += chunk.length
      hash.update(chunk)
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
      out.end(() => {
        if (failed) return
        const actualSha = hash.digest('hex')
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
      installedSize: (local && local.installedSize) || 0
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
      installedSize: (local && local.installedSize) || 0
    })
  }

  return { ok: true, models: out, source: manifestSource, version: manifest.version, updatedAt: manifest.updatedAt }
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
    const result = await downloadOne(m.urls[0], destFile, { onProgress, expectedSha: m.sha256 || null })
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

/** 删除已下载模型（释放空间） */
function deleteModel(id) {
  const dir = path.join(userModelsDir(), id)
  if (!fs.existsSync(dir)) return { ok: true, deleted: false }
  fs.rmSync(dir, { recursive: true, force: true })
  return { ok: true, deleted: true }
}

/** 注册 IPC（models:*），来源校验复用 index.js 的 assertTrusted */
function registerModelsIpc({ ipcMain, assertTrusted }) {
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
      return deleteModel(id)
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
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
