/**
 * 矿山智工 - 模型注册表
 *
 * 管理可用模型档位的元数据、安装状态检测、自动选档逻辑。
 *
 * 档位设计（Q4_K_M 量化，2026-09-16 修正：Qwen2.5 无 1.7B 型号，标准档实为 1.5B）：
 *   light     — Qwen2.5-0.5B  468MB  任意内存   narrate（叙述润色）
 *   standard  — Qwen2.5-1.5B  ~1.04GB ≥8GB     narrate + diagnose + summarize
 *   enhanced  — Qwen3-4B      ~2.5GB  ≥16GB    + 复杂推演
 *
 * 铁律：注册表只做元数据和选档，不加载模型。
 */
const path = require('path')
const fs = require('fs')
const os = require('os')

/** 档位定义 */
const TIERS = [
  {
    id: 'light',
    name: '轻量档',
    displayName: 'Qwen2.5-0.5B-Instruct（本地内置）',
    file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
    sizeBytes: 468 * 1024 * 1024,
    minMemoryGB: 0,
    capabilities: ['narrate'],
    description: '叙述润色：把规则引擎结论改写成人话',
    contextSize: 1024,
    temperature: 0.2,
    maxTokens: 128
  },
  {
    id: 'standard',
    name: '标准档',
    displayName: 'Qwen2.5-1.5B-Instruct',
    file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    sizeBytes: 1117320736,
    minMemoryGB: 8,
    capabilities: ['narrate', 'diagnose', 'summarize'],
    description: '叙述 + 诊断 + 摘要：可分析故障模式并给出初步诊断',
    contextSize: 2048,
    temperature: 0.3,
    maxTokens: 256
  },
  {
    id: 'enhanced',
    name: '增强档',
    displayName: 'Qwen3-4B-Instruct',
    file: 'qwen3-4b-instruct-q4_k_m.gguf',
    sizeBytes: 2.5 * 1024 * 1024 * 1024,
    minMemoryGB: 16,
    capabilities: ['narrate', 'diagnose', 'summarize', 'reason'],
    description: '全能力：复杂推演、多步推理、长文本摘要',
    contextSize: 4096,
    temperature: 0.3,
    maxTokens: 512
  }
]

/**
 * 扫描模型目录，检测哪些档位已安装。
 * 预留双源：resources/models + userData/models（Task 07 落地）。
 * 目录约定：<root>/<tier.id>/<file>；旧版 light 档按模型名目录（qwen2.5-0.5b/）自动兼容。
 *
 * @param {string[]} searchDirs 模型搜索目录列表
 * @returns {Object[]} 每个档位附加 installed / installedPath / installedSize
 */
const LEGACY_DIRS = { light: ['qwen2.5-0.5b'] } // 旧版模型目录（按模型名），向后兼容

function scanTiers(searchDirs) {
  return TIERS.map(tier => {
    let installed = false
    let installedPath = null
    let installedSize = 0

    const candidateSubs = [tier.id, ...(LEGACY_DIRS[tier.id] || [])]
    for (const dir of searchDirs) {
      for (const sub of candidateSubs) {
        const filePath = path.join(dir, sub, tier.file)
        try {
          if (fs.existsSync(filePath)) {
            const stat = fs.statSync(filePath)
            installed = true
            installedPath = filePath
            installedSize = stat.size
            break
          }
        } catch { /* 文件系统错误静默跳过 */ }
      }
      if (installed) break
    }

    return { ...tier, installed, installedPath, installedSize }
  })
}

/**
 * 自动选档：根据系统内存选择最高可用档位。
 *
 * @param {Object[]} scannedTiers scanTiers 的返回结果
 * @returns {string} 推荐档位 id
 */
function autoSelectTier(scannedTiers) {
  const totalGB = os.totalmem() / (1024 * 1024 * 1024)
  // 从高到低尝试：内存足够且已安装的最高档位
  for (const tier of [...scannedTiers].reverse()) {
    if (totalGB >= tier.minMemoryGB && tier.installed) {
      return tier.id
    }
  }
  // 内存不足或没有任何模型已安装，回退到 light（如果已安装）
  const light = scannedTiers.find(t => t.id === 'light')
  if (light && light.installed) return 'light'
  // 什么都没有，返回 light 作为默认（加载时会报文件不存在）
  return 'light'
}

/**
 * 获取档位元数据（不含安装状态）
 * @param {string} id
 * @returns {Object|null}
 */
function getTierMeta(id) {
  return TIERS.find(t => t.id === id) || null
}

// 这里曾有一个 getAllTiers()（返回 TIERS 的浅拷贝）。它没有任何调用方——
// 需要全量档位的 modelManager 直接 `for (const t of TIERS)`，渲染层的档位列表
// 走 models:list → modelManager，也不经过它。留着只会让人以为档位有两条出口。
module.exports = { TIERS, scanTiers, autoSelectTier, getTierMeta }