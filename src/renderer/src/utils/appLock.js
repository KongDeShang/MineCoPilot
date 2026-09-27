/**
 * 矿山智工 - 应用锁（界面锁）与账户
 *
 * 为什么要有它：路演现场要把笔记本交给评委上手，需要一把锁把界面挡住；
 * 同时界面与操作日志要能显示"谁在用、什么身份"。所以这不是一把纯锁，
 * 而是"轻量身份 + 界面锁"。
 *
 * ── 三条如实声明（与 README「已知边界」同口径，不许含糊）────────────────────
 *   ① **锁的是界面，不是文件**。`userData/*.db` 仍可被任何 SQLite 工具直接打开。
 *      演示开场讲"设备参数、故障记录是商业机密"时，被追问到这一层必须这么说。
 *   ② 锁配置存在 localStorage（`ks:app-lock`）里，**清掉它就绕过了锁**；
 *      账户列表本身也是明文（姓名/角色不加密）。
 *      **这是防"旁人随手翻看/误操作"的锁，不是防技术人员的锁。**
 *   ③ 角色**只做标识**（界面显示 + 进操作日志），不做任何权限拦截。
 *
 * ── 为什么凭证不进数据库 ──────────────────────────────────────────────────
 * 锁屏必须**先于数据库打开**就生效："锁没锁、PIN 对不对"这件事发生在开库之前，
 * 把凭证放进库里等于自相矛盾（要么先开库才能判锁，要么判锁时还没有库）。
 * 浏览器与 Electron 渲染进程都有 localStorage（撤销栈 `ks:undo-stack` 已经在用同一个位置）。
 *
 * ── PIN 为什么不存明文 ────────────────────────────────────────────────────
 * PBKDF2（WebCrypto `crypto.subtle.deriveBits`，SHA-256）+ 每账户随机盐，
 * 迭代次数一并记在账户里 —— 以后把迭代数调大，老账户仍能校验。
 * 全程本机、零联网，符合三条铁律。
 */
import * as db from './database'

/** 锁配置的 localStorage 键（撤销栈的 `ks:undo-stack` 是同一个命名空间） */
const LOCK_KEY = 'ks:app-lock'

const CONFIG_VERSION = 1

/**
 * PBKDF2 迭代次数。
 * 取 10 万：在办公笔记本的浏览器里实测约 50~120 ms —— 对"解锁时算一次"足够快，
 * 对"离线爆破一个 4~6 位纯数字 PIN"则是明确的阻碍。**这不是密码学强度的承诺**：
 * 6 位纯数字只有 100 万种可能，真正的防线是"这台机器在你手上"。
 *
 * 每次派生都会把当时的迭代数**记进账户**，所以以后调大这个值，
 * 老账户仍按它自己的迭代数校验，不需要重新设 PIN。
 */
const PBKDF2_ITERATIONS = 100000

/** 4~6 位数字（用户口径） */
const PIN_RE = /^\d{4,6}$/
const MAX_NAME_LEN = 12
const MAX_ROLE_LEN = 16

/**
 * 「清空本机数据并解锁」要清掉的 localStorage 键。
 *
 * 只清**被这次清空真正作废**的键，不动用户偏好：
 *   - `ks:app-lock`      —— 必须清。否则数据清完了还是进不去（自救就失败了）
 *   - `ks:undo-stack`    —— 撤销栈指向的记录已经不存在，留着会让"撤销"去改空记录
 *   - `ai_chat_messages` —— 聊天记录算数据，与台账一起走
 * 刻意**不清**主题（`ks:theme` / `ks:color`）、导航钉住（`mining-nav-pinned`）、
 * 老师傅模式（`ks:master-mode`）这类**偏好**：用户重启后还要看到自己习惯的界面，
 * 把偏好一起抹掉是另一件事，不该夹在"自救"里顺手做掉。
 */
const RESCUE_KEYS = [LOCK_KEY, 'ks:undo-stack', 'ai_chat_messages']

// ---------- 十六进制 <-> 字节 ----------

function bytesToHex(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0')
  return out
}

function hexToBytes(hex) {
  const clean = String(hex || '')
  const bytes = new Uint8Array(Math.floor(clean.length / 2))
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16)
  return bytes
}

/** 生成随机盐（默认 16 字节 = 32 位十六进制） */
function randomSalt(byteLength = 16) {
  const buf = new Uint8Array(byteLength)
  crypto.getRandomValues(buf)
  return bytesToHex(buf)
}

// ---------- 校验 ----------

/**
 * PIN 长度与字符集校验。返回 `{ ok, error }`，不抛异常 ——
 * 调用方（锁屏、设置页）都要把这句话直接显示给用户。
 */
export function validatePin(pin) {
  const s = String(pin == null ? '' : pin)
  if (!s) return { ok: false, error: '请输入 PIN' }
  if (!/^\d+$/.test(s)) return { ok: false, error: 'PIN 只能是数字' }
  if (!PIN_RE.test(s)) return { ok: false, error: `PIN 需要 4~6 位数字（当前 ${s.length} 位）` }
  return { ok: true }
}

/** 姓名校验：非空、去首尾空格、限长（太长的名字会把侧边栏那行撑坏） */
function validateName(name) {
  const s = String(name == null ? '' : name).trim()
  if (!s) return { ok: false, error: '请填写姓名' }
  if (s.length > MAX_NAME_LEN) return { ok: false, error: `姓名不超过 ${MAX_NAME_LEN} 个字` }
  return { ok: true, value: s }
}

/** 角色校验：可以为空（空角色在界面上只显示姓名） */
function validateRole(role) {
  const s = String(role == null ? '' : role).trim()
  if (s.length > MAX_ROLE_LEN) return { ok: false, error: `角色不超过 ${MAX_ROLE_LEN} 个字` }
  return { ok: true, value: s }
}

// ---------- 哈希 ----------

/** PBKDF2-SHA256 → 32 字节十六进制。同 PIN + 同盐 + 同迭代数 ⇒ 同结果 */
async function hashPin(pin, salt, iterations = PBKDF2_ITERATIONS) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(salt), iterations, hash: 'SHA-256' },
    key,
    256
  )
  return bytesToHex(new Uint8Array(bits))
}

// ---------- 配置读写 ----------

function emptyConfig() {
  return { version: CONFIG_VERSION, accounts: [] }
}

/**
 * 读配置。**任何异常都收敛成空配置**（锁打不开比丢锁配置严重得多）：
 * 非法 JSON、旧版本、字段缺失都不该让应用起不来。
 */
function readConfig() {
  let raw
  try {
    raw = localStorage.getItem(LOCK_KEY)
  } catch {
    return emptyConfig()
  }
  if (!raw) return emptyConfig()
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return emptyConfig()
    const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : []
    // 逐条筛：字段不全的账户不算账户（否则锁屏上会出现一个永远解不开的头像）
    const usable = accounts.filter(a => a && a.id && a.name && a.salt && a.hash)
    return { version: CONFIG_VERSION, accounts: usable }
  } catch {
    return emptyConfig()
  }
}

function writeConfig(config) {
  localStorage.setItem(LOCK_KEY, JSON.stringify({ version: CONFIG_VERSION, accounts: config.accounts || [] }))
}

// ---------- 会话（只放内存） ----------

/**
 * 本次运行已解锁的账户 id。
 *
 * **故意只放内存、不落任何存储** —— 刷新或重启即回到锁定态，
 * 这正是"启动时锁"的含义。落盘的话就变成"锁一次管一辈子"了。
 */
let unlockedAccountId = null

/** 有没有账户。没有任何账户 = 锁没启用（这也是 e2e/探针默认不受影响的依据） */
export function lockEnabled() {
  return readConfig().accounts.length > 0
}

/** 当前解锁的账户（未解锁返回 null）。调用方靠它同时回答"谁在用"与"本次有没有身份" */
export function currentAccount() {
  if (!unlockedAccountId) return null
  return readConfig().accounts.find(a => a.id === unlockedAccountId) || null
}

/**
 * 账户列表（**剥掉 salt / hash**）。
 * 界面上只需要"谁在用、什么身份"，摘要不该离开这个模块 ——
 * 传出去只会让调用方有机会把它渲染出来或写进日志。
 */
export function listAccounts() {
  return readConfig().accounts.map(a => ({
    id: a.id,
    name: a.name,
    role: a.role || '',
    createdAt: a.createdAt || ''
  }))
}

// ---------- 账户管理 ----------

/**
 * 新增一个账户。
 * @returns `{ ok:true, account }` 或 `{ ok:false, error }`
 */
export async function createAccount({ name, role = '', pin }) {
  const nameCheck = validateName(name)
  if (!nameCheck.ok) return { ok: false, error: nameCheck.error }
  const roleCheck = validateRole(role)
  if (!roleCheck.ok) return { ok: false, error: roleCheck.error }
  const pinCheck = validatePin(pin)
  if (!pinCheck.ok) return { ok: false, error: pinCheck.error }
  if (readConfig().accounts.some(a => a.name === nameCheck.value)) {
    return { ok: false, error: `已存在名为「${nameCheck.value}」的账户` }
  }

  const salt = randomSalt()
  const hash = await hashPin(pin, salt, PBKDF2_ITERATIONS)
  const account = {
    id: `u${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    name: nameCheck.value,
    role: roleCheck.value,
    salt,
    hash,
    iterations: PBKDF2_ITERATIONS,
    createdAt: new Date().toISOString()
  }
  const config = readConfig()
  config.accounts.push(account)
  writeConfig(config)
  // 顺手认下"本次运行的身份"：刚设完 PIN 的人就是此刻在用这台机器的人。
  // 不认的话，设置页会停在"锁已启用、但本次运行没有身份"的状态 ——
  // 界面上显示不出谁在用，操作日志也就没了操作人。
  if (!unlockedAccountId) unlockedAccountId = account.id
  return { ok: true, account }
}

/** 校验某个账户的 PIN。账户不存在 / 盐或摘要缺失一律 false（不抛异常） */
async function verifyPin(account, pin) {
  if (!account || !account.salt || !account.hash) return false
  if (!validatePin(pin).ok) return false
  try {
    const hash = await hashPin(pin, account.salt, account.iterations || PBKDF2_ITERATIONS)
    return hash === account.hash
  } catch {
    // WebCrypto 不可用（极老的运行时）时**拒绝**，不放行 —— 锁失败要朝"更严"的方向倒
    return false
  }
}

/** 删除一个账户。删到最后一个 = 锁停用 */
export function removeAccount(id) {
  const config = readConfig()
  config.accounts = config.accounts.filter(a => a.id !== id)
  writeConfig(config)
  if (unlockedAccountId === id) unlockedAccountId = null
  return { ok: true, remaining: config.accounts.length }
}

/** 停用锁（清空全部账户），并退出解锁态 */
export function disableLock() {
  writeConfig(emptyConfig())
  unlockedAccountId = null
  return { ok: true }
}

// ---------- 解锁 / 上锁 ----------

/**
 * 用 PIN 解锁。
 * @param {string} pin
 * @param {string} [accountId] 不传时：只有一个账户就选它，多个则要求显式指定
 */
export async function unlock(pin, accountId) {
  const accounts = readConfig().accounts
  if (!accounts.length) return { ok: false, error: '本机没有配置任何账户' }
  let target = null
  if (accountId) {
    target = accounts.find(a => a.id === accountId) || null
    // 指明的账户不存在（比如刚被删掉）：要说清是"账户没了"，
    // 不能退化成下面那句"请先选择"——那句话会让用户以为是自己没选
    if (!target) return { ok: false, error: '该账户已不存在，请重新选择' }
  } else if (accounts.length === 1) {
    target = accounts[0]
  }
  if (!target) return { ok: false, error: '请先选择要用哪个账户解锁' }

  const ok = await verifyPin(target, pin)
  if (!ok) return { ok: false, error: 'PIN 不正确' }
  unlockedAccountId = target.id
  return { ok: true, account: { id: target.id, name: target.name, role: target.role || '' } }
}

// ---------- 自救：清空本机数据并解锁 ----------

/**
 * 忘记 PIN 时的自救：清空本机数据并解锁。
 *
 * 两件事都必须做，顺序不能反：
 *   ① 清 localStorage 里被这次清空作废的键（含 `ks:app-lock`，否则还是进不去）
 *   ② 销毁本机数据库字节（`clearStorage`）—— 台账/工单/手册/日志一起走，
 *      下次启动会按首启逻辑重新播种演示数据
 *
 * **如实写明后果**（调用方 LockScreen.vue 会原样告诉用户）：这一步**不可撤销**。
 * 数据库这一步在锁屏阶段是"库还没打开"的状态调用的，
 * `destroyDatabase()` 已经处理了 `db` 为空的情形（内部判空后再关）。
 */
export async function rescueAndUnlock() {
  for (const key of RESCUE_KEYS) {
    try { localStorage.removeItem(key) } catch { /* 隐私模式下删不掉也不该阻断 */ }
  }
  try {
    await db.destroyDatabase({ clearStorage: true })
  } catch (error) {
    return { ok: false, error: `本机数据清除失败：${(error && error.message) || error}` }
  }
  unlockedAccountId = null
  return { ok: true }
}
