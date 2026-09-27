<template>
  <div class="lock-screen">
    <div class="lock-card">
      <!-- 品牌区：与侧栏 logo 同一份 BrandMark，浅深主题由外层 color 决定 -->
      <div class="lock-brand">
        <div class="lock-mark"><BrandMark :size="26" /></div>
        <div class="lock-brand-txt">
          <div class="lock-title">矿山智工</div>
          <div class="lock-sub">设备健康智能体 · 本机离线运行</div>
        </div>
      </div>

      <div class="lock-prompt">请选择身份并输入 PIN</div>

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

      <div class="lock-input">
        <el-input
          ref="pinRef"
          v-model="pin"
          type="password"
          maxlength="6"
          inputmode="numeric"
          placeholder="PIN（4~6 位数字）"
          @keyup.enter="submit"
        />
      </div>

      <button class="lock-btn" type="button" :disabled="busy || !accounts.length" @click="submit">
        {{ busy ? '正在校验…' : '解锁' }}
      </button>

      <!-- 一行既报 PIN 错，也报"解锁后装载界面失败"（后者来自 main.js 的 bootError） -->
      <div v-if="message" class="lock-err">{{ message }}</div>

      <div class="lock-foot">
        <button type="button" class="lock-rescue" @click="rescue">忘记 PIN？清空本机数据并解锁</button>
      </div>
      <div class="lock-note">数据全部保存在本机 · 不联网 · 不上传</div>
    </div>
  </div>
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
 *   · 全局注册的 Element Plus 图标拿不到 —— 所以这里只用 BrandMark 与 el-input
 *   · **不装错误边界**：装了会和主应用那套重复监听 window 'error'，
 *     一次异常被记两条日志。这里保持"出错就进控制台"的默认行为。
 *
 * ── 视觉口径 ────────────────────────────────────────────────────────────
 * 主题在锁屏阶段来自 localStorage 镜像（theme-init.js 已按镜像设好首帧），
 * meta 表的权威值要等解锁后才校正 —— 换机导入备份后首帧主题可能与镜像不一致，
 * 解锁瞬间会跳一次色。这是取舍：要么先开库（违背"不装载"），要么接受这一跳。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import BrandMark from './BrandMark.vue'
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
 * 文案与 utils/appLock.js 的 RESCUE_KEYS 注释同源，改一处要两处一起改。
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
.lock-screen {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg);
  /* 蓝图网格：与侧栏同一套质感，锁屏不至于像一块无来由的白板 */
  background-image:
    linear-gradient(var(--grid-color) 1px, transparent 1px),
    linear-gradient(90deg, var(--grid-color) 1px, transparent 1px);
  background-size: 26px 26px;
  font-family: var(--font-sans);
  padding: var(--sp-6);
}

.lock-card {
  width: 100%;
  max-width: 380px;
  padding: var(--sp-8) var(--sp-6) var(--sp-6);
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  box-shadow: var(--sh-md);
}

.lock-brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.lock-mark {
  width: 40px;
  height: 40px;
  border-radius: var(--r-sm);
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.lock-title {
  font-size: 18px;
  font-weight: var(--weight-bd);
  letter-spacing: 1.5px;
  color: var(--text-1);
  line-height: 1.2;
}

.lock-sub {
  font-size: var(--fs-2xs);
  color: var(--text-3);
  margin-top: 3px;
}

.lock-prompt {
  margin: var(--sp-6) 0 var(--sp-3);
  font-size: var(--fs-sm);
  color: var(--text-3);
}

.lock-accounts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  margin-bottom: var(--sp-4);
}

.lock-account {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 7px 12px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  background: var(--card-2);
  cursor: pointer;
  font-family: inherit;
  transition: border-color var(--dur-fast), background var(--dur-fast);
}

.lock-account:hover {
  border-color: var(--accent-line);
}

.lock-account.is-on {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.lock-account-name {
  font-size: var(--fs-sm);
  font-weight: var(--weight-md);
  color: var(--text-1);
}

.lock-account-role {
  font-size: var(--fs-2xs);
  color: var(--text-3);
}

.lock-who {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  margin-bottom: var(--sp-4);
}

.lock-who-name {
  font-size: var(--fs-h3);
  font-weight: var(--weight-sb);
  color: var(--text-1);
}

.lock-who-role {
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.lock-input {
  margin-bottom: var(--sp-4);
}

.lock-btn {
  width: 100%;
  height: 40px;
  border: none;
  border-radius: var(--r-sm);
  background: var(--grad-strip);
  color: var(--accent-contrast);
  font-family: inherit;
  font-size: var(--fs-body);
  font-weight: var(--weight-sb);
  letter-spacing: 4px;
  cursor: pointer;
  transition: filter var(--dur-fast);
}

.lock-btn:hover:not(:disabled) {
  filter: brightness(1.1);
}

.lock-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.lock-err {
  margin-top: var(--sp-3);
  padding: 8px 10px;
  border-radius: var(--r-xs);
  background: var(--danger-soft);
  border: 1px solid var(--danger-line);
  color: var(--danger-ink);
  font-size: var(--fs-xs);
  line-height: 1.5;
}

.lock-foot {
  margin-top: var(--sp-5);
  padding-top: var(--sp-4);
  border-top: 1px solid var(--line-2);
  display: flex;
  justify-content: center;
}

.lock-rescue {
  border: none;
  background: none;
  padding: 0;
  font-family: inherit;
  font-size: var(--fs-xs);
  color: var(--text-3);
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}

.lock-rescue:hover {
  color: var(--danger-ink);
}

.lock-note {
  margin-top: var(--sp-3);
  text-align: center;
  font-size: var(--fs-2xs);
  color: var(--text-mute);
}
</style>
