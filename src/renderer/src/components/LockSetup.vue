<template>
  <LockShell data-lock-view="setup" subtitle="首次使用 · 为本机设一把界面锁" aria-label="首次设置应用锁">
    <div class="lock-field">
      <label class="lock-label" for="setup-name">姓名</label>
      <input
        id="setup-name"
        ref="nameRef"
        v-model="name"
        class="lock-input"
        type="text"
        maxlength="12"
        autocomplete="off"
        placeholder="姓名（例如：王建国）"
        @keyup.enter="focusPin"
      >
    </div>

    <div class="lock-field">
      <label class="lock-label" for="setup-pin">PIN</label>
      <input
        id="setup-pin"
        ref="pinRef"
        v-model="pin"
        class="lock-input lock-pin"
        type="password"
        maxlength="6"
        inputmode="numeric"
        autocomplete="off"
        placeholder="PIN（4~6 位数字）"
      >
    </div>

    <div class="lock-field">
      <label class="lock-label" for="setup-pin2">再输一次 PIN</label>
      <input
        id="setup-pin2"
        ref="pin2Ref"
        v-model="pin2"
        class="lock-input lock-pin"
        type="password"
        maxlength="6"
        inputmode="numeric"
        autocomplete="off"
        placeholder="再输一次"
        @keyup.enter="submit"
      >
    </div>

    <button class="lock-btn" type="button" :disabled="busy" @click="submit">
      {{ busy ? '正在启用…' : '启 用 并 进 入' }}
    </button>

    <!-- 跳过做成同宽的次按钮，不做成角落小字：它和「启用」是并列的两个正当选择。
         做成小链接会让人以为跳过是"不推荐"的那条路，而演示现场恰恰最需要它。 -->
    <button class="lock-btn-ghost" type="button" :disabled="busy" @click="skip">
      跳过，先不设锁
    </button>

    <div v-if="message" class="lock-err">{{ message }}</div>

    <div class="lock-hint">
      锁的是<b>界面</b>：启动时要输 PIN，钥匙走开后别人翻不了台账。它不是文件加密
      （本机数据库文件仍可被 SQLite 工具直接打开），角色也只作标识、不做权限拦截。
    </div>
    <div class="lock-note">
      跳过后随时可在「设置 → 应用锁」里再开 · 角色可以稍后在设置页补上
    </div>
  </LockShell>
</template>

<script setup>
/**
 * 首启「设置 PIN」屏。
 *
 * ── 它取代了一条**已经写进文档、还有探针断言守着**的旧决定 ──────────────────
 * 旧口径是「首启不锁（无账户 ⇒ 不锁），装完双击直接进主界面」。现在装完第一次
 * 双击先出这一屏。这是使用者的明确要求，代价与对策都记在 docs 里，要点：
 *   · 「跳过」是**同宽并列**的按钮，不是角落小字 —— 演示现场最怕的就是
 *     "打开先问你设不设密码"，所以这一屏必须一眼看得出可以不理会它；
 *   · 跳过之后**不再问**（写 ks:lock-setup-seen），下次启动直接进主界面；
 *   · 打完包装的实测探针同步改了判据（原第 5 项「首启不锁」→「首启出设置屏、跳过即进」）。
 *
 * ── 它和 LockScreen 是同一层的东西 ─────────────────────────────────────────
 * 也由 main.js 在**创建主应用之前**挂载：这一屏没走完，store / 路由 / 模型预热
 * 一概没启动。所以这里同样不能碰 store / router / el-* 组件，只用原生控件。
 * 也因此它没法用 ElMessage 报错 —— 错误就地显示在卡片里。
 *
 * ── 为什么首启不收「角色」 ────────────────────────────────────────────────
 * 三格已经够长了。角色是可选字段，设置页随时能补；首启硬塞第四格只会让人更快地
 * 去点「跳过」，而那正是这一屏最不该有的结果。
 */
import { computed, onMounted, ref } from 'vue'
import LockShell from './LockShell.vue'
import { createAccount, markLockSetupSeen, validatePin } from '../utils/appLock'

const emit = defineEmits(['done'])

const name = ref('')
const pin = ref('')
const pin2 = ref('')
const error = ref('')
const busy = ref(false)

const nameRef = ref(null)
const pinRef = ref(null)
const pin2Ref = ref(null)

const message = computed(() => error.value)

onMounted(() => {
  const el = nameRef.value
  if (el && typeof el.focus === 'function') el.focus()
})

function focusPin() {
  const el = pinRef.value
  if (el && typeof el.focus === 'function') el.focus()
}

async function submit() {
  if (busy.value) return
  // "两次输入一致"只有界面能判（appLock 拿不到第二个输入框），与设置页同一口径
  if (pin.value !== pin2.value) {
    error.value = '两次输入的 PIN 不一致'
    pin2.value = ''
    return
  }
  const check = validatePin(pin.value)
  if (!check.ok) {
    error.value = check.error
    return
  }
  error.value = ''
  busy.value = true
  const result = await createAccount({ name: name.value, role: '', pin: pin.value })
  if (!result.ok) {
    error.value = result.error
    pin.value = ''
    pin2.value = ''
    busy.value = false
    return
  }
  // createAccount 已经把本次身份认成这个新账户（见 appLock.js），所以这里不需要再"解锁"
  emit('done')
}

/**
 * 跳过：记下"做过选择了"，然后照旧进主界面。
 *
 * 写标记失败（隐私模式）**不拦人**，只记一行控制台 —— 这时下次启动会再问一遍，
 * 那是个可接受的降级，而为此弹一个框挡住首次启动是不可接受的。
 */
function skip() {
  if (busy.value) return
  const marked = markLockSetupSeen()
  if (!marked.ok) console.warn('[应用锁] 跳过标记没能落盘，下次启动会再问一次：', marked.error)
  emit('done')
}
</script>

<style scoped>
/* 两格 PIN 用等宽数字：六位数字对齐，输错时容易看出来差在哪一位 */
.lock-pin {
  font-variant-numeric: tabular-nums;
  letter-spacing: 2px;
}
</style>
