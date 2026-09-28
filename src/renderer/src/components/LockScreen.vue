<template>
  <!-- data-lock-view：两屏共用 .lock-btn 与 PIN 输入框，光靠它们分不出此刻是哪一屏
       （e2e/探针要判"现在该出锁屏还是该出首启设置"）。落一个显式标记，不靠猜。 -->
  <LockShell data-lock-view="unlock" subtitle="设备健康智能体 · 本机离线运行" aria-label="解锁">
    <div class="lock-field">
      <label class="lock-label">账号</label>
      <!-- 多账户才摆选择：只有一个账户时摆一行"选谁"反而像在选登录方式 -->
      <div v-if="accounts.length > 1" class="lock-accounts">
        <button
          v-for="a in accounts"
          :key="a.id"
          type="button"
          class="lock-account"
          :class="{ 'is-on': a.id === selectedId }"
          @click="selectedId = a.id"
        >
          <span class="lock-account-name">{{ a.name }}</span>
          <span v-if="a.role" class="lock-account-role">{{ a.role }}</span>
        </button>
      </div>
      <div v-else-if="selected" class="lock-who">
        <span class="lock-who-name">{{ selected.name }}</span>
        <span v-if="selected.role" class="lock-who-role">{{ selected.role }}</span>
      </div>
      <div v-else class="lock-who">
        <span class="lock-who-name">本机没有可用账户</span>
      </div>
    </div>

    <div class="lock-field">
      <label class="lock-label" for="lock-pin">PIN</label>
      <input
        id="lock-pin"
        ref="pinRef"
        v-model="pin"
        class="lock-input"
        type="password"
        maxlength="6"
        inputmode="numeric"
        autocomplete="off"
        placeholder="PIN（4~6 位数字）"
        @keyup.enter="submit"
      >
    </div>

    <button class="lock-btn" type="button" :disabled="busy || !accounts.length" @click="submit">
      {{ busy ? '正在校验…' : '解 锁' }}
    </button>

    <!-- 一行既报 PIN 错，也报"解锁后装载界面失败"（后者来自 main.js 的 bootError） -->
    <div v-if="message" class="lock-err">{{ message }}</div>

    <div class="lock-foot">
      <button type="button" class="lock-rescue" @click="rescue">忘记 PIN？清空本机数据并解锁</button>
    </div>
    <div class="lock-note">数据全部保存在本机 · 不联网 · 不上传</div>
  </LockShell>
</template>

<script setup>
/**
 * 锁屏（应用锁的界面部分）
 *
 * ── 它为什么是一个**独立的应用**，而不是 App.vue 里的一个分支 ──────────────
 * 见 main.js 的说明：未解锁时业务应用（store / 路由 / 模型预热 / 引导演示）
 * 根本不创建，"不闪数据"因此是结构保证，不是靠 v-if 记得写对。
 * 代价是这个组件不能假设主应用的环境：
 *   · 不能 import store / router（那两个都没起来）
 *   · 全局注册的 Element Plus 图标拿不到
 *   · **不装错误边界**：装了会和主应用那套重复监听 window 'error'，
 *     一次异常被记两条日志。这里保持"出错就进控制台"的默认行为。
 *
 * ── 为什么用原生 input/button，不继续用 el-input ────────────────────────────
 * 一是这一版视觉来自设计稿，字段是"下划线感"的自绘控件，套 el-input 的
 * `.el-input__wrapper` 要和它打架；二是少一层 Element Plus 依赖，这个独立
 * 应用要装的东西就少一点。**类名与 placeholder 一律照旧**（`.lock-btn`、
 * `.lock-screen`、`input[placeholder^="PIN"]`），因为 e2e 与打包探针都靠它们定位，
 * 改视觉不该顺手把这些观测点改掉。
 *
 * ── 视觉口径 ────────────────────────────────────────────────────────────
 * 锁屏是一块**固定暗暖色**的封面，不跟随浅/深主题：它盖住整个应用，
 * 不存在"和谁并排看"的问题。代价如实说明 —— 解锁瞬间从暖色封面切到应用
 * （浅色主题下是浅蓝白），会有一次明显的换色。这是设计稿的口径，认了。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import LockShell from './LockShell.vue'
import { listAccounts, rescueAndUnlock, unlock, validatePin } from '../utils/appLock'

const props = defineProps({
  /** 解锁成功但主应用装载失败时由 main.js 传进来的原因（正常情况下为空） */
  bootError: { type: String, default: '' }
})
const emit = defineEmits(['unlock'])

// setup 期读一次即可：锁屏存活期间账户不会变（改账户要先进设置页）
const accounts = ref(listAccounts())
const selectedId = ref(accounts.value.length ? accounts.value[0].id : '')
const selected = computed(() => accounts.value.find(a => a.id === selectedId.value) || null)

const pin = ref('')
const pinError = ref('')
const busy = ref(false)
const pinRef = ref(null)

const message = computed(() => pinError.value || props.bootError)

onMounted(() => {
  // 焦点直接落在 PIN 上：这条路只有一件事可做
  const el = pinRef.value
  if (el && typeof el.focus === 'function') el.focus()
})

async function submit() {
  if (busy.value || !accounts.value.length) return
  const check = validatePin(pin.value)
  if (!check.ok) {
    pinError.value = check.error
    return
  }
  pinError.value = ''
  busy.value = true
  const result = await unlock(pin.value, selectedId.value)
  if (!result.ok) {
    pinError.value = result.error
    pin.value = ''
    busy.value = false
    // 说一下为什么不留 loading：解锁成功后本组件会被整体卸载（main.js 换挂主应用），
    // 那之后再去改 busy 就是在动一个已经停掉的渲染副作用。
    return
  }
  emit('unlock')
}

/**
 * 忘记 PIN 的自救。
 *
 * 二次确认里必须**如实**写清后果 —— 这是本项目对用户唯一的诚实口径：
 * 清空这件事既包括数据，也包括这台机器上的账户（否则自救完还是进不去）。
 * 文案与 utils/appLock.js 的 RESCUE_KEYS 同源，改一处要两处一起改。
 */
async function rescue() {
  try {
    await ElMessageBox.confirm(
      '将清空本机保存的全部数据：设备台账、维保记录、工单、健康快照、知识库、手册资料、操作日志与聊天记录，并重新生成一套演示数据；本机配置的账户与 PIN 也会一并清除。此操作不可撤销。',
      '清空本机数据并解锁',
      { type: 'warning', confirmButtonText: '确认清空并解锁', cancelButtonText: '取消' }
    )
  } catch {
    // 用户按了取消：什么都不做（不是失败）
    return
  }
  busy.value = true
  const result = await rescueAndUnlock()
  if (!result.ok) {
    pinError.value = result.error
    busy.value = false
    return
  }
  emit('unlock')
}
</script>

<style scoped>
/* 账户选择块（只有锁屏用，留在 scoped 里；其余视觉在 styles/lockTheme.css） */
.lock-accounts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.lock-account {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 7px 12px;
  /* 用与输入框同一条描边令牌（--lk-field-border）：这是一颗**可选中的控件**，
     边界要求同 WCAG 1.4.11；稿子里没有这个块（一个账户时不出现），
     所以没有"照稿"的值可抄，就沿用它旁边那个控件的。 */
  border: 1px solid var(--lk-field-border);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.07);
  cursor: pointer;
  font-family: inherit;
  transition: border-color 0.18s ease, background 0.18s ease;
}

.lock-account:hover {
  border-color: rgba(240, 169, 78, 0.55);
}

.lock-account.is-on {
  border-color: var(--lk-accent);
  background: rgba(240, 169, 78, 0.16);
}

.lock-account-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--lk-ink);
}

.lock-account-role {
  font-size: 10.5px;
  /* 稿子的 muted 档就是 0.68，别在这两处再发明一个 0.66 */
  color: var(--lk-muted);
}

.lock-who {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-height: 42px;
  padding: 0 12px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.05);
  line-height: 40px;
}

.lock-who-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--lk-ink);
}

.lock-who-role {
  font-size: 12px;
  color: var(--lk-muted);
}
</style>
