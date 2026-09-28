/**
 * 矿山智工 - 恢复出厂设置：抹掉 userData 下**除模型之外**的全部应用数据
 *
 * ── 为什么单独成一个模块 ────────────────────────────────────────────────
 * "删什么"是这个功能里唯一做错了就不可挽回的部分，必须能被**行为**验证，
 * 而不是靠扫 index.js 的源码猜。main-check 的头注释写过这条教训：src/main 长期
 * 只有一条正则检查，于是「切换到该档」能 100% 失败而所有验收全绿。
 * 所以逻辑落在这里（可 require、可直接调用），index.js 只留一行接线。
 *
 * ── 为什么不收任何路径参数 ──────────────────────────────────────────────
 * 入参只有 userData 一个，删除范围在函数体里**硬编码**。多一个"要删哪些"的入参
 * 就等于开了"调用方让我删什么我就删什么"的口子 —— index.js 那条 handler 也只把
 * `app.getPath('userData')` 递进来，一个字节都不多传。两边都有断言盯着。
 *
 * ── 为什么必须保住 models/ ──────────────────────────────────────────────
 * 离线包的价值就是那 468 MB 本地模型。把 models/ 一起删掉，用户下次启动就没有本地 AI 了
 * （离线包不含云端下载能力，等于把装好的软件弄坏）。所以它**明确不在**删除清单里；
 * self-check 还有一条静态断言盯着这件事，别顺手加进来。
 *
 * ── 数据库文件与随包手册 ────────────────────────────────────────────────
 * 数据库文件（kuangshan-zhigong.db）**不在这里删**：渲染层的
 * `destroyDatabase({ clearStorage: true })` 会走 `db:clear` 清掉它 ——
 * 一个文件只有一个所有者，免得两处逻辑各自演进后打架。
 * `documents/` 下的随包手册不必手工补回：它们是固定名 `bundled-<slug>.pdf`，
 * 库被清空后下次启动会把 `bundled_docs_seeded` 判为未播种、重新导入一遍，
 * 落的正是"刚装好"的那个状态。
 */
const path = require('path')
const fs = require('fs')

/**
 * 抹掉 userData 下除模型以外的应用数据。
 *
 * @param {string} userData 主进程 `app.getPath('userData')` 给出的目录
 * @returns {Promise<{ok: boolean, removed: string[], failed: string[], kept: string[]}>}
 */
async function wipeUserData(userData) {
  const removed = []
  const failed = []

  // 目录型：清空内容，目录本身留着（下次启动照常往里写，省一次 mkdir 的判断）
  for (const name of ['documents', 'backups']) {
    const dir = path.join(userData, name)
    try {
      if (!fs.existsSync(dir)) continue
      for (const entry of await fs.promises.readdir(dir)) {
        await fs.promises.rm(path.join(dir, entry), { recursive: true, force: true })
      }
      removed.push(`${name}/`)
    } catch (error) {
      // 单个条目删不掉（被占用等）不该让整件事半途而废：如实记下来，其余的继续
      failed.push(`${name}/：${error.message}`)
    }
  }

  // 文件型
  for (const name of ['model-pref.json', 'llm-verify.json']) {
    const file = path.join(userData, name)
    try {
      if (!fs.existsSync(file)) continue
      await fs.promises.unlink(file)
      removed.push(name)
    } catch (error) {
      failed.push(`${name}：${error.message}`)
    }
  }

  // 如实告诉渲染层"有一处刻意没删、以及为什么"，而不是让它以为全清光了
  const kept = ['models/（按设计保留：删了离线包就没有本地模型了）']
  return { ok: failed.length === 0, removed, failed, kept }
}

module.exports = { wipeUserData }
