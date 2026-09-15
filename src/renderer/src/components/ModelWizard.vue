<template>
  <el-dialog
    :model-value="modelValue"
    :title="step === 'done' ? '模型已就绪' : '欢迎使用矿山智工'"
    width="680px"
    :close-on-click-modal="false"
    :close-on-press-escape="true"
    @update:model-value="onClose"
  >
    <!-- ── 步骤一：选择档位 ─────────────────────────────────────── -->
    <div v-if="step === 'choose'">
      <div class="wiz-tip">
        本地模型用于把诊断结论"说成人话"、生成报告摘要。模型一次性下载后
        <b>完全离线使用</b>，运行期零联网、数据不出本机。
      </div>

      <div v-if="!list.length && loading" class="wiz-empty">正在读取云端模型清单…</div>
      <div v-else-if="!list.length" class="wiz-empty">
        当前为浏览器模式或网络不可用，无法拉取模型清单。请稍后在「模型中心」重试。
      </div>

      <div v-else class="wiz-models">
        <div
          v-for="m in list"
          :key="m.id"
          class="wiz-model"
          :class="{ 'wiz-model-rec': m.id === recommendedId, 'wiz-model-disabled': !m.available }"
        >
          <div class="wiz-model-top">
            <span class="wiz-model-name">{{ m.name }}</span>
            <el-tag v-if="m.id === recommendedId" type="success" effect="dark" size="small">推荐</el-tag>
            <el-tag v-else-if="!m.available" type="info" size="small">待扩展</el-tag>
          </div>
          <div class="wiz-model-meta">
            <span class="wm">{{ formatSize(m.sizeBytes) }}</span>
            <span class="wm">内存 ≥ {{ m.minMemoryGB || 0 }}GB</span>
            <span v-for="c in m.capabilities" :key="c" class="wm cap">{{ capLabel(c) }}</span>
          </div>
          <div class="wiz-model-desc">{{ capDesc(m) }}</div>
          <el-button
            v-if="m.available"
            type="primary"
            size="small"
            @click="startDownload(m)"
          >下载并安装</el-button>
          <span v-else class="wiz-pending">云端暂未提供，后续版本开放</span>
        </div>
      </div>

      <div class="wiz-foot">
        <el-button link @click="skip">稍后再说（可去模型中心安装）</el-button>
      </div>
    </div>

    <!-- ── 步骤二：下载中 ───────────────────────────────────────── -->
    <div v-else-if="step === 'downloading'" class="wiz-dl">
      <div class="wiz-dl-name">正在下载 {{ downloadingName }}</div>
      <el-progress :percentage="pct" :stroke-width="14" :text-inside="true" />
      <div class="wiz-dl-sub">
        {{ formatSize(received) }} / {{ formatSize(total) }} · {{ pct }}%
      </div>
      <div class="wiz-dl-note">
        断点续传已开启：中途关闭应用再打开，会从已下载位置继续，不会重头开始。
      </div>
      <div v-if="dlError" class="wiz-dl-err">{{ dlError }}</div>
      <div class="wiz-foot">
        <el-button link @click="skip">取消下载</el-button>
      </div>
    </div>

    <!-- ── 步骤三：完成 ─────────────────────────────────────────── -->
    <div v-else class="wiz-done">
      <div class="wiz-done-icon"><el-icon :size="34"><CircleCheck /></el-icon></div>
      <div class="wiz-done-title">{{ downloadingName }} 已安装完成</div>
      <div class="wiz-done-sub">
        <span v-if="verified === true">SHA-256 校验通过 · 模型已就绪，<b>可断网使用</b></span>
        <span v-else-if="verified === false">注意：云端清单未提供校验值，本次安装未做完整性校验</span>
        <span v-else>模型文件已就位</span>
      </div>
      <el-button type="primary" @click="finish">开始使用</el-button>
    </div>
  </el-dialog>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { CircleCheck } from '@element-plus/icons-vue'
import { modelsList, modelsDownload, onModelsProgress } from '../utils/modelsClient'
import { llmLoad, llmAvailable } from '../utils/llmClient'

const props = defineProps({ modelValue: Boolean })
const emit = defineEmits(['update:modelValue', 'skipped', 'installed'])

const step = ref('choose')
const list = ref([])
const loading = ref(true)
const downloadingId = ref(null)
const downloadingName = ref('')
const received = ref(0)
const total = ref(0)
const pct = ref(0)
const dlError = ref('')
const verified = ref(null)
let unsubProgress = () => {}

const CAP_LABELS = { narrate: '叙述', diagnose: '诊断', summarize: '摘要', reason: '推演' }
const CAP_DESCS = {
  narrate: '把诊断结论改写成人话',
  diagnose: '分析故障模式并给出初步诊断',
  summarize: '生成长周期报告摘要',
  reason: '复杂推演、多步推理'
}
function capLabel(c) { return CAP_LABELS[c] || c }
function capDesc(m) {
  return (m.capabilities || []).map((c) => CAP_DESCS[c] || c).join('、') || '基础叙述'
}

function formatSize(bytes) {
  if (!bytes) return '—'
  const n = Number(bytes)
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
  if (n >= 1024 * 1024) return Math.round(n / 1024 / 1024) + ' MB'
  return Math.round(n / 1024) + ' KB'
}

/** 按内存推荐：可下载且满足最低内存的最高档 */
const recommendedId = computed(() => {
  const mem = navigator.deviceMemory || 8
  const candidates = list.value
    .filter((m) => m.available && mem >= (m.minMemoryGB || 0))
    .sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0))
  if (candidates.length) return candidates[0].id
  const any = list.value.find((m) => m.available)
  return any ? any.id : null
})

async function refresh() {
  loading.value = true
  try {
    const r = await modelsList()
    if (r.ok) list.value = r.models || []
    else list.value = []
  } catch {
    list.value = []
  } finally {
    loading.value = false
  }
}

function startDownload(m) {
  downloadingId.value = m.id
  downloadingName.value = m.name
  received.value = 0
  total.value = m.sizeBytes || 0
  pct.value = 0
  dlError.value = ''
  verified.value = null
  step.value = 'downloading'
  modelsDownload(m.id).then((r) => {
    if (r && r.ok) {
      verified.value = !!(r.sha256)
      step.value = 'done'
      emit('installed', m.id)
      // 装好后顺手加载（就绪自检），失败不阻塞
      if (llmAvailable()) llmLoad().catch(() => {})
    } else {
      dlError.value = (r && r.error) || '下载失败，请重试'
      step.value = 'downloading'
    }
  })
}

function skip() {
  localStorage.setItem('ks:wizard-dismissed', '1')
  emit('skipped')
  emit('update:modelValue', false)
}

function finish() {
  emit('update:modelValue', false)
}

function onClose(v) {
  if (!v && step.value !== 'downloading') {
    localStorage.setItem('ks:wizard-dismissed', '1')
    emit('skipped')
  }
  emit('update:modelValue', v)
}

onMounted(async () => {
  if (props.modelValue) {
    await refresh()
    unsubProgress = onModelsProgress((p) => {
      if (!p || p.id !== downloadingId.value) return
      received.value = p.received || 0
      total.value = p.total || received.value
      pct.value = p.pct || 0
    })
  }
})

onBeforeUnmount(() => unsubProgress())
</script>

<style scoped>
.wiz-tip {
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.7;
  background: rgba(11, 58, 130, 0.04);
  border: 1px solid rgba(11, 58, 130, 0.1);
  border-radius: 8px;
  padding: 10px 14px;
  margin-bottom: 16px;
}
.wiz-empty {
  padding: 32px 0;
  text-align: center;
  color: var(--text-3);
  font-size: 13px;
}
.wiz-models {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.wiz-model {
  border: 1px solid rgba(11, 58, 130, 0.14);
  border-radius: 10px;
  padding: 14px;
  background: rgba(11, 58, 130, 0.03);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.wiz-model-rec {
  border-color: var(--accent);
  background: rgba(28, 107, 212, 0.07);
}
.wiz-model-disabled {
  opacity: 0.65;
}
.wiz-model-top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.wiz-model-name {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-1);
}
.wiz-model-meta {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.wm {
  font-size: 11px;
  color: var(--text-3);
  background: rgba(11, 58, 130, 0.06);
  padding: 2px 8px;
  border-radius: 999px;
}
.wm.cap {
  color: var(--accent);
  background: rgba(28, 107, 212, 0.1);
}
.wiz-model-desc {
  font-size: 12px;
  color: var(--text-2);
}
.wiz-pending {
  font-size: 12px;
  color: var(--text-3);
}
.wiz-foot {
  margin-top: 18px;
  display: flex;
  justify-content: flex-end;
}
.wiz-dl {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 8px 0;
}
.wiz-dl-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
}
.wiz-dl-sub {
  font-size: 12px;
  color: var(--text-2);
}
.wiz-dl-note {
  font-size: 12px;
  color: var(--text-3);
}
.wiz-dl-err {
  font-size: 12px;
  color: var(--danger, #e6a23c);
}
.wiz-done {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 24px 0;
}
.wiz-done-icon {
  color: var(--success, #52c41a);
}
.wiz-done-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-1);
}
.wiz-done-sub {
  font-size: 13px;
  color: var(--text-2);
}
</style>
