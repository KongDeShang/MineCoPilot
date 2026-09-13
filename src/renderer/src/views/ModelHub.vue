<template>
  <div class="model-hub">
    <!-- ============ 顶部状态横幅 ============ -->
    <div class="hero" :class="'hero-' + status.state">
      <div class="hero-left">
        <div class="hero-title">
          <el-icon :size="22"><Cpu /></el-icon>
          本地模型引擎
          <el-tag :type="statusTagType" effect="dark" size="small" class="hero-tag">{{ statusLabel }}</el-tag>
        </div>
        <div class="hero-sub">{{ statusDesc }}</div>
        <div class="hero-badges">
          <span class="hb"><el-icon><Connection /></el-icon> 断网可用</span>
          <span class="hb"><el-icon><Lock /></el-icon> 数据不出本机</span>
          <span class="hb"><el-icon><MagicStick /></el-icon> 数字可审计</span>
        </div>
      </div>
      <div class="hero-actions">
        <el-switch
          v-model="enabled"
          active-text="启用"
          inactive-text="停用"
          inline-prompt
          @change="onToggle"
        />
        <el-button
          v-if="status.state === 'failed' || status.state === 'idle'"
          type="primary"
          size="small"
          :loading="status.state === 'loading'"
          @click="loadNow"
        >重新加载</el-button>
      </div>
    </div>

    <!-- ============ 离线链路架构图 ============ -->
    <el-card shadow="never" class="pipe-card">
      <template #header>
        <div class="card-header">
          <span><el-icon><Share /></el-icon> 可审计 AI 链路（数据全在本机）</span>
        </div>
      </template>
      <div class="pipeline">
        <div class="pipe-step">
          <div class="pipe-icon pipe-icon-1"><el-icon :size="18"><DataAnalysis /></el-icon></div>
          <div class="pipe-title">规则引擎</div>
          <div class="pipe-desc">算数字：健康分 · 四因子 · 停机损失 · 排期</div>
          <div class="pipe-badge">确定性 · 可复现</div>
        </div>
        <div class="pipe-arrow"><span>→</span></div>
        <div class="pipe-step">
          <div class="pipe-icon pipe-icon-2"><el-icon :size="18"><Reading /></el-icon></div>
          <div class="pipe-title">规程库检索</div>
          <div class="pipe-desc">命中可溯源规程 + 手册原文，带出处页码</div>
          <div class="pipe-badge">依据可见 · 未命中明说查不到</div>
        </div>
        <div class="pipe-arrow"><span>→</span></div>
        <div class="pipe-step pipe-step-hot">
          <div class="pipe-icon pipe-icon-3"><el-icon :size="18"><Cpu /></el-icon></div>
          <div class="pipe-title">本地模型叙述</div>
          <div class="pipe-desc">把已核实的结论说成人话（逐字校验数字）</div>
          <div class="pipe-badge">只润色 · 不新增事实</div>
        </div>
      </div>
      <div class="pipe-note">
        <el-icon><InfoFilled /></el-icon>
        模型只做叙述层：它看到的每个数字都来自左边两步，输出后做数字不变量校验，新增数字即回退——想编都编不出来。
      </div>
    </el-card>

    <div class="hub-grid">
      <!-- ============ 试玩区 ============ -->
      <el-card shadow="never" class="trial-card">
        <template #header>
          <div class="card-header">
            <span><el-icon><ChatDotRound /></el-icon> 现场试玩：让本地模型说人话</span>
            <el-button link size="small" @click="fillSample">填入示例结论</el-button>
          </div>
        </template>
        <div class="trial-body">
          <el-input
            v-model="trialText"
            type="textarea"
            :rows="3"
            placeholder="粘贴一段规则引擎结论，例如：健康分、超期天数、故障次数……"
          />
          <div class="trial-actions">
            <el-button
              type="primary"
              :loading="trialRunning"
              :disabled="status.state !== 'ready'"
              @click="runTrial"
            ><el-icon style="margin-right:4px"><MagicStick /></el-icon>让本地模型改写</el-button>
            <span v-if="status.state !== 'ready'" class="trial-hint">模型就绪后可试玩（当前：{{ statusLabel }}）</span>
          </div>
          <div v-if="trialOutput" class="trial-output">
            <div class="trial-output-label"><el-icon><Cpu /></el-icon> 本地模型输出</div>
            <div class="trial-output-text">{{ trialOutput }}</div>
            <div v-if="trialCheck" class="trial-check" :class="trialCheck.ok ? 'ok' : 'fail'">
              <el-icon><CircleCheck v-if="trialCheck.ok" /><WarningFilled v-else /></el-icon>
              数字不变量校验：{{ trialCheck.ok ? 'PASS —— 输出中的每个数字都来自原结论' : `FAIL —— 发现未授权数字：${trialCheck.violated.join('、')}` }}
            </div>
          </div>
        </div>
      </el-card>

      <!-- ============ 能力指标卡 ============ -->
      <el-card shadow="never" class="spec-card">
        <template #header>
          <div class="card-header">
            <span><el-icon><Odometer /></el-icon> 模型规格与能力</span>
          </div>
        </template>
        <div class="spec-grid">
          <div class="spec-item">
            <div class="spec-label">模型</div>
            <div class="spec-value">{{ status.info ? status.info.name : 'Qwen2.5-0.5B-Instruct' }}</div>
          </div>
          <div class="spec-item">
            <div class="spec-label">量化格式</div>
            <div class="spec-value">Q4_K_M</div>
          </div>
          <div class="spec-item">
            <div class="spec-label">上下文</div>
            <div class="spec-value">1024 tokens</div>
          </div>
          <div class="spec-item">
            <div class="spec-label">加载耗时</div>
            <div class="spec-value">{{ status.info && status.info.loadMs ? (status.info.loadMs / 1000).toFixed(1) + ' s' : '—' }}</div>
          </div>
          <div class="spec-item">
            <div class="spec-label">模型体积</div>
            <div class="spec-value">{{ status.info ? formatSize(status.info.size) : '—' }}</div>
          </div>
          <div class="spec-item">
            <div class="spec-label">运行环境</div>
            <div class="spec-value">纯本机 CPU / 无 GPU 需求</div>
          </div>
        </div>
        <div v-if="status.info && status.info.path" class="spec-path">
          模型位置：{{ status.info.path }}
        </div>
      </el-card>
    </div>

    <!-- ============ 部署日志 ============ -->
    <el-card shadow="never" class="log-card">
      <template #header>
        <div class="card-header">
          <span><el-icon><List /></el-icon> 部署日志</span>
        </div>
      </template>
      <el-table :data="llmLogs" size="small" empty-text="暂无部署日志">
        <el-table-column prop="time" label="时间" width="180" />
        <el-table-column prop="content" label="事件" />
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import {
  Cpu, Connection, Lock, MagicStick, Share, DataAnalysis, Reading,
  ChatDotRound, Odometer, InfoFilled, CircleCheck, WarningFilled, List
} from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useAppStore } from '../stores/appStore'
import { llmAvailable, llmStatus, llmLoad, llmGenerate, buildNarratePrompt, extractNumbers, normalizeNarrated } from '../utils/llmClient'

const store = useAppStore()

const status = ref({ state: 'idle', error: '', info: null })
const enabled = ref(true)

const statusLabel = computed(() => ({
  ready: '已就绪',
  loading: '加载中',
  generating: '生成中',
  failed: '加载失败',
  unavailable: '浏览器模式',
  idle: '待加载'
}[status.value.state] || status.value.state))

const statusTagType = computed(() => ({
  ready: 'success',
  loading: 'primary',
  generating: 'primary',
  failed: 'danger',
  unavailable: 'warning',
  idle: 'info'
}[status.value.state] || 'info'))

const statusDesc = computed(() => {
  const s = status.value.state
  if (s === 'ready') return '模型已就绪：AI 结论由本地模型生成"人话"，全程离线，数据不出本机。'
  if (s === 'loading') return '正在加载内置 Qwen2.5-0.5B 模型，首次约 4-5 秒，请稍候……'
  if (s === 'generating') return '模型正在生成回答中……'
  if (s === 'failed') return `模型加载失败：${status.value.error || '未知原因'}`
  if (s === 'unavailable') return '当前为浏览器模式，无本地模型引擎；桌面版打开即自动加载。'
  return '模型待加载：打开应用后自动加载；也可点击「启用」手动触发。'
})

const llmLogs = computed(() => store.recentLogs
  .filter(l => l.type === 'llm')
  .slice(0, 10))

// ---------- 试玩区 ----------
const trialText = ref('【1号挖掘机】健康分 78.5 分（B级），维保超期 5 天，液压油压力偏低，建议 3 天内完成保养。')
const trialOutput = ref('')
const trialRunning = ref(false)
const trialCheck = ref(null)

function fillSample() {
  trialText.value = '【2号矿卡 XDA45】健康分 62 分（C级），制动系统维保超期 12 天，近 30 天故障 3 次，建议 7 天内进站检修。'
  trialOutput.value = ''
  trialCheck.value = null
}

async function runTrial() {
  const text = trialText.value.trim()
  if (!text) { ElMessage.warning('请先输入一段结论'); return }
  if (status.value.state !== 'ready') { ElMessage.warning('模型未就绪，请等待加载完成后再试'); return }
  trialRunning.value = true
  trialOutput.value = ''
  trialCheck.value = null
  try {
    const prompt = buildNarratePrompt(text)
    const r = await llmGenerate(prompt, {
      onChunk: (t) => { trialOutput.value += t }
    })
    if (!r.ok || !r.text || !r.text.trim()) {
      trialOutput.value = ''
      ElMessage.error('生成失败：' + (r.error || '模型无输出'))
      return
    }
    trialOutput.value = normalizeNarrated(r.text) || r.text.trim()
    const src = extractNumbers(text)
    const gen = extractNumbers(trialOutput.value)
    const violated = gen.filter(n => !src.includes(n))
    trialCheck.value = { ok: violated.length === 0, violated, src }
  } catch (err) {
    trialOutput.value = ''
    ElMessage.error('生成异常：' + (err && err.message || err))
  } finally {
    trialRunning.value = false
  }
}

// ---------- 模型加载 ----------
function formatSize(bytes) {
  if (!bytes) return '—'
  const mb = bytes / 1024 / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(0)} MB`
}

async function refresh() {
  status.value = await llmStatus()
  enabled.value = store.settings ? store.settings.llmEnabled !== false : true
}

async function loadNow() {
  const r = await llmLoad()
  await refresh()
  if (r && r.ok) {
    store.addLog({ content: '本地模型引擎加载成功（内置 Qwen2.5-0.5B）', source: 'AI', type: 'llm', tagType: 'success' })
  } else {
    store.addLog({ content: `本地模型加载失败：${(r && r.error) || '未知原因'}`, source: 'AI', type: 'llm', tagType: 'danger' })
  }
}

async function onToggle(val) {
  store.updateSettings({ llmEnabled: val })
  if (val) {
    await loadNow()
    store.addLog({ content: '已启用本地模型叙述层', source: 'AI', type: 'llm', tagType: 'success' })
  } else {
    store.addLog({ content: '已停用本地模型，回退内置规则叙述', source: 'AI', type: 'llm', tagType: 'info' })
  }
}

onMounted(async () => {
  enabled.value = store.settings ? store.settings.llmEnabled !== false : true
  await refresh()
  // 默认启用：自动加载
  if (enabled.value && llmAvailable() && (status.value.state === 'idle')) {
    await loadNow()
  }
})
</script>

<style scoped>
.model-hub {
  padding: 16px;
  max-width: 1080px;
}

/* ---------- 顶部横幅 ---------- */
.hero {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  padding: 18px 20px;
  border-radius: 12px;
  margin-bottom: 16px;
  color: #fff;
  background: var(--grad-strip);
}
.hero-ready { background: linear-gradient(120deg, #0b3a82 0%, #1457b3 60%, #1c6bd4 100%); }
.hero-loading, .hero-generating { background: linear-gradient(120deg, #1457b3 0%, #1c6bd4 70%, #2b7de0 100%); }
.hero-failed { background: linear-gradient(120deg, #7a1f1f 0%, #a83232 60%, #c04545 100%); }
.hero-idle { background: linear-gradient(120deg, #334155 0%, #475569 60%, #64748b 100%); }
.hero-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 17px;
  font-weight: 700;
}
.hero-tag { margin-left: 4px; }
.hero-sub {
  margin-top: 6px;
  font-size: 12.5px;
  opacity: 0.92;
}
.hero-badges {
  display: flex;
  gap: 14px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.hb {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  background: rgba(255, 255, 255, 0.14);
  padding: 3px 10px;
  border-radius: 999px;
}
.hero-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  background: rgba(255, 255, 255, 0.1);
  padding: 10px 12px;
  border-radius: 10px;
}

/* ---------- 架构图 ---------- */
.pipe-card { margin-bottom: 16px; }
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 14px;
  font-weight: 600;
}
.pipeline {
  display: flex;
  align-items: stretch;
  gap: 6px;
  flex-wrap: wrap;
}
.pipe-step {
  flex: 1 1 180px;
  min-width: 0;
  background: rgba(11, 58, 130, 0.04);
  border: 1px solid rgba(11, 58, 130, 0.14);
  border-radius: 10px;
  padding: 14px 14px 12px;
  text-align: center;
}
.pipe-step-hot {
  background: rgba(11, 58, 130, 0.09);
  border-color: rgba(11, 58, 130, 0.35);
}
.pipe-icon {
  width: 38px;
  height: 38px;
  margin: 0 auto 8px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
}
.pipe-icon-1 { background: var(--accent); }
.pipe-icon-2 { background: var(--accent-mid); }
.pipe-icon-3 { background: var(--accent); }
.pipe-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--accent);
}
.pipe-desc {
  font-size: 12px;
  color: var(--text-2);
  margin-top: 5px;
  line-height: 1.5;
}
.pipe-badge {
  display: inline-block;
  margin-top: 8px;
  font-size: 11px;
  color: var(--accent);
  background: rgba(28, 107, 212, 0.1);
  padding: 2px 8px;
  border-radius: 999px;
}
.pipe-arrow {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent);
  font-size: 20px;
  font-weight: 700;
}
.pipe-note {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-3);
  background: rgba(11, 58, 130, 0.04);
  border-radius: 8px;
  padding: 8px 12px;
}

/* ---------- 双栏 ---------- */
.hub-grid {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.trial-card, .spec-card {
  flex: 1 1 340px;
  min-width: 0;
}
.trial-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.trial-hint {
  font-size: 12px;
  color: var(--text-3);
}
.trial-output {
  margin-top: 14px;
  background: rgba(11, 58, 130, 0.05);
  border: 1px solid rgba(11, 58, 130, 0.16);
  border-radius: 10px;
  padding: 12px 14px;
}
.trial-output-label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 700;
  color: var(--accent);
}
.trial-output-text {
  margin-top: 6px;
  font-size: 13.5px;
  color: var(--text-1);
  line-height: 1.7;
  white-space: pre-wrap;
}
.trial-check {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  border-radius: 6px;
  padding: 6px 10px;
}
.trial-check.ok {
  color: var(--success-ink);
  background: rgba(22, 163, 74, 0.08);
}
.trial-check.fail {
  color: var(--danger-ink);
  background: rgba(185, 28, 28, 0.08);
}

/* ---------- 规格卡 ---------- */
.spec-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 20px;
}
.spec-item {
  flex: 1 1 140px;
  min-width: 0;
}
.spec-label {
  font-size: 11px;
  color: var(--text-3);
}
.spec-value {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  margin-top: 3px;
}
.spec-path {
  margin-top: 12px;
  font-size: 11px;
  color: var(--text-3);
  word-break: break-all;
  background: rgba(11, 58, 130, 0.04);
  border-radius: 6px;
  padding: 6px 10px;
}

/* ---------- 日志 ---------- */
.log-card { margin-top: 0; }
</style>
