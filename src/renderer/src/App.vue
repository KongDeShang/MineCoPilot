<template>
  <!-- Landing 页面：全屏无边框 -->
  <div v-if="isLanding" class="landing-wrapper">
    <router-view />
  </div>

  <!-- 主应用：侧边栏 + 内容 -->
  <el-container v-else class="app-container">
    <!-- 侧边栏 -->
    <el-aside width="230px" class="app-aside blueprint-grid">
      <!-- Logo -->
      <div class="logo">
        <div class="logo-mark">
          <BrandMark :size="24" />
        </div>
        <div class="logo-text-wrap">
          <div class="logo-text">矿山智工</div>
          <div class="logo-sub">设备健康智能体</div>
        </div>
      </div>

      <!-- 导航搜索 -->
      <div class="nav-search">
        <el-icon class="nav-search-icon"><Search /></el-icon>
        <input v-model="navQuery" class="nav-search-input" placeholder="搜索功能…" />
      </div>

      <!-- 钉住常用 -->
      <div v-if="pinnedMenus.length" class="nav-pinned">
        <div class="nav-group-title">常用</div>
        <div
          v-for="item in pinnedMenus"
          :key="item.path"
          class="nav-item"
          :class="{ active: route.path === item.path }"
          @click="go(item.path)"
        >
          <el-icon :size="16"><component :is="item.icon" /></el-icon>
          <span class="nav-label">{{ item.label }}</span>
          <span class="nav-pin pinned" @click.stop="togglePin(item)"><el-icon><StarFilled /></el-icon></span>
        </div>
      </div>

      <!-- 分组导航 -->
      <nav class="nav-groups">
        <template v-for="group in visibleGroups" :key="group.name">
          <div class="nav-group-title">{{ group.name }}</div>
          <div
            v-for="item in group.items"
            :key="item.path"
            class="nav-item"
            :class="{ active: route.path === item.path }"
            @click="go(item.path)"
          >
            <el-icon :size="16"><component :is="item.icon" /></el-icon>
            <span class="nav-label">{{ item.label }}</span>
            <el-tag v-if="item.badge" size="small" effect="dark" class="nav-badge">{{ item.badge }}</el-tag>
            <span class="nav-pin" :class="{ pinned: item.pin }" @click.stop="togglePin(item)">
              <el-icon><component :is="item.pin ? 'StarFilled' : 'Star'" /></el-icon>
            </span>
          </div>
        </template>
      </nav>

      <!-- 侧边栏底部 -->
      <div class="aside-footer">
        <div class="offline-badge">
          <span class="dot-green"></span> 离线运行中 · 数据在本机
        </div>
        <div class="storage-line" :class="{ 'storage-error': !!store.dbError }" :title="storageDetail">
          <el-icon><Coin /></el-icon>
          {{ storageLabel }}
        </div>
        <el-tooltip
          v-if="lastUndo"
          :content="`撤销「${lastUndo.rawText}」：${lastUndo.changes.map(c => c.label).join('、')}`"
          placement="top"
        >
          <el-button link size="small" class="undo-btn" @click="doUndo">
            <el-icon><RefreshLeft /></el-icon> 撤销上一步录入
          </el-button>
        </el-tooltip>
        <el-button link size="small" class="reset-btn" :loading="resetting" @click="resetDemo">
          重置演示数据
        </el-button>
        <div class="version">v1.0.0</div>
      </div>
    </el-aside>

    <!-- 主内容区 -->
    <el-container>
      <el-header class="app-header">
        <div class="header-left">
          <el-breadcrumb separator="/">
            <el-breadcrumb-item :to="{ path: '/dashboard' }">首页</el-breadcrumb-item>
            <el-breadcrumb-item>{{ currentPageTitle }}</el-breadcrumb-item>
          </el-breadcrumb>
          <GlobalSearch style="margin-left: 24px" />
        </div>
        <div class="header-right">
          <!-- 引导演示：把"该看什么"固化成可重复播放的路线（多条可选手动/自动）。
               评委自己上手、或演示的人讲快了，都可以按一下重来。 -->
          <el-dropdown trigger="click" @command="onPickDemoRoute">
            <el-tooltip content="按路线自动带你走一遍（可暂停/手动）" placement="bottom">
              <el-button
                size="small"
                type="primary"
                plain
                :loading="tourStarting"
              >
                <el-icon><Guide /></el-icon> 引导演示
                <el-icon class="el-icon--right"><ArrowDown /></el-icon>
              </el-button>
            </el-tooltip>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item
                  v-for="r in demoRoutes"
                  :key="r.id"
                  :command="r.id"
                  :disabled="r.pending"
                >
                  <div class="demo-route-item">
                    <span>{{ r.name }}</span>
                    <span class="demo-route-desc">{{ r.pending ? '待上线' : r.desc }}</span>
                  </div>
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-tooltip :content="llmModeTip" placement="bottom">
            <el-tag
              :type="llmMode === 'local' ? 'success' : 'info'"
              :effect="llmMode === 'local' || llmMode === 'loading' ? 'dark' : 'plain'"
              size="small"
            >
              <el-icon><Cpu /></el-icon>
              {{ llmMode === 'loading' ? '本地模型加载中' : '本地模型' }}
            </el-tag>
          </el-tooltip>
          <el-tooltip content="纯离线：全部能力由内置规则引擎完成，数据不出本机" placement="bottom">
            <el-tag
              :type="llmMode === 'offline' ? 'primary' : 'info'"
              :effect="llmMode === 'offline' ? 'dark' : 'plain'"
              size="small"
            >
              <el-icon><Connection /></el-icon>
              离线
            </el-tag>
          </el-tooltip>
        </div>
      </el-header>
      <el-main class="app-main">
        <router-view v-slot="{ Component }">
          <transition name="fade-slide" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </el-main>
    </el-container>
  </el-container>

  <!-- 首次启动模型选择向导（无本地模型时弹出，可跳过） -->
  <ModelWizard v-model="wizardOpen" @installed="onWizardInstalled" />

  <!-- 演示工具条：悬浮右下角，driver 遮罩之上（自动演示的暂停/步进/重置/退出） -->
  <DemoControlBar
    v-if="tourApi"
    :api="tourApi"
    :route-name="tourState ? tourState.routeName : ''"
    :step="tourState ? tourState.step : 0"
    :total="tourState ? tourState.total : 0"
    :paused="tourState ? tourState.paused : false"
    :playing="tourState ? tourState.playing : true"
    @close="tourApi = null"
  />
</template>

<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import BrandMark from './components/BrandMark.vue'
import GlobalSearch from './components/GlobalSearch.vue'
import ModelWizard from './components/ModelWizard.vue'
import DemoControlBar from './components/DemoControlBar.vue'
import { useAppStore } from './stores/appStore'
import { llmAvailable, llmLoad, llmStatus } from './utils/llmClient'
import { modelsAvailable, modelsList } from './utils/modelsClient'
import { startTour } from './utils/demoTour'
import { DEMO_ROUTES } from './utils/demoRoutes'
import { getMenus } from './domains/registry'

const route = useRoute()
const router = useRouter()
const store = useAppStore()
const resetting = ref(false)
const tourStarting = ref(false)
const navQuery = ref('')
const pinned = ref(loadPinned())
const wizardOpen = ref(false)

// 演示路线与工具条状态（任务 14）
const demoRoutes = DEMO_ROUTES
const tourApi = ref(null)
const tourState = ref(null)

// 运行模式（右上角互斥高亮）：local=本地模型就绪 / loading=加载中 / offline=纯离线
const llmMode = ref('offline')
let llmTimer = null

const llmModeTip = computed(() => {
  if (llmMode.value === 'local') return '本地模型就绪：AI 结论由内置模型叙述，数据不出本机'
  if (llmMode.value === 'loading') return '本地模型加载中，首次约 4-5 秒'
  return '离线模式：AI 使用内置规则叙述，数据不出本机'
})

async function refreshLlmMode() {
  if (!llmAvailable()) {
    llmMode.value = 'offline'
    return
  }
  try {
    const st = await llmStatus()
    if (st.state === 'ready' || st.state === 'generating') llmMode.value = 'local'
    else if (st.state === 'loading') llmMode.value = 'loading'
    else llmMode.value = 'offline'
  } catch {
    llmMode.value = 'offline'
  }
}

// 启动预热：本地模型在后台加载，AI 助手首问零等待（尊重 llmEnabled 开关；浏览器模式自动跳过）
onMounted(() => {
  const want = store.settings ? store.settings.llmEnabled !== false : true
  if (want && llmAvailable()) {
    setTimeout(() => { llmLoad().catch(() => { /* 预热失败不打扰，状态机降级即可 */ }) }, 800)
  }
  refreshLlmMode()
  llmTimer = setInterval(refreshLlmMode, 5000)
  maybeOpenWizard()
})

/** 首次向导：仅 Electron 模式 + 没有任何已安装模型 + 用户未跳过过 */
async function maybeOpenWizard() {
  if (!modelsAvailable()) return
  if (localStorage.getItem('ks:wizard-dismissed')) return
  try {
    const r = await modelsList()
    if (r && r.ok && r.models.length && r.models.every((m) => !m.installed)) {
      wizardOpen.value = true
    }
  } catch { /* 拉取失败不打扰，稍后模型中心可重试 */ }
}

function onWizardInstalled() {
  refreshLlmMode()
  ElMessage.success('模型已就绪，可断网使用')
}

/**
 * 落盘失败要主动弹一次，不能只等用户去悬停状态栏。
 *
 * 只在"从没有错误 → 出现错误"这一刻弹（用 immediate:false 的 watch，天然是变化触发）；
 * 写清楚"这次改动没保存"与"怎么恢复"，因为这是唯一会让用户丢数据的提示。
 * 恢复成功（dbError 被清空）时也给一句，避免用户一直以为还在失败状态。
 */
watch(() => store.dbError, (now, before) => {
  if (now && !before) {
    ElMessage({
      type: 'error',
      duration: 0, // 不自动消失：数据没落盘这件事不该被几秒后忘掉
      showClose: true,
      message: `保存失败：${now}`
    })
  } else if (!now && before) {
    ElMessage.success('本地保存已恢复正常（刚才失败的改动已重试写入）')
  }
})

onBeforeUnmount(() => {
  if (llmTimer) clearInterval(llmTimer)
})

/** 最近一次口述录入（决定侧边栏是否显示撤销入口） */
const lastUndo = computed(() => store.peekUndo())

/** 导航注册表：由域注册中心提供，5 组 15 项 */
const NAV_GROUPS = getMenus()

const allNavItems = NAV_GROUPS.flatMap(g => g.items)

/** 搜索过滤：标题包含关键词才显示，整组为空则隐藏 */
const visibleGroups = computed(() => {
  const q = navQuery.value.trim().toLowerCase()
  if (!q) return NAV_GROUPS.map(g => ({ ...g, items: g.items.map(i => ({ ...i, pin: pinned.value.includes(i.path) })) }))
  return NAV_GROUPS
    .map(g => ({ ...g, items: g.items.filter(i => i.label.toLowerCase().includes(q)).map(i => ({ ...i, pin: pinned.value.includes(i.path) })) }))
    .filter(g => g.items.length)
})

const pinnedMenus = computed(() => {
  const set = new Set(pinned.value)
  return allNavItems.filter(i => set.has(i.path))
})

function loadPinned() {
  try {
    return JSON.parse(localStorage.getItem('mining-nav-pinned') || '[]')
  } catch {
    return []
  }
}

function savePinned() {
  localStorage.setItem('mining-nav-pinned', JSON.stringify(pinned.value))
}

function togglePin(item) {
  const idx = pinned.value.indexOf(item.path)
  if (idx >= 0) pinned.value.splice(idx, 1)
  else pinned.value.push(item.path)
  savePinned()
}

function go(path) {
  if (route.path !== path) router.push(path)
}

function doUndo() {
  const outcome = store.performUndo()
  if (!outcome.ok) {
    ElMessage.warning(outcome.error)
    return
  }
  ElMessage.warning(`已撤销 ${outcome.reverted} 项变更，数据恢复到写入前`)
}

const isLanding = computed(() => route.path === '/')
const currentPageTitle = computed(() => {
  const item = allNavItems.find(i => i.path === route.path)
  return item ? item.label : '首页'
})

// 存储状态：让"数据存在本地"这件事在界面上可见
const storageLabel = computed(() => {
  /**
   * ⚠️ 落盘失败必须**占据**这一行，而不是只躺在 tooltip 里。
   *
   * 原来这里先看 `saving`、再看 `lastSavedAt`，`dbError` 只出现在 :title 的
   * storageDetail 里（要悬停才看得见）。于是磁盘满 / 文件被占用时，状态栏显示的
   * 是**上一次成功**的"已保存 HH:MM" —— 界面在说"存好了"，而这次改动一个字节都没落盘。
   * 这正好把 P0 那条修复（失败即抛错 → dbError）变成了看不见的修复。
   */
  if (store.dbError) return '保存失败'
  if (!store.dbReady) return '内存模式'
  if (store.saving) return '保存中…'
  return store.lastSavedAt ? `已保存 ${store.lastSavedAt.slice(11)}` : '本地已就绪'
})

const storageDetail = computed(() => {
  const backend = {
    'electron-file': '桌面版：数据写入本机 userData 目录的 .db 文件',
    'indexeddb': '浏览器版：数据写入本机 IndexedDB',
    'localstorage': '降级模式：数据写入本机 localStorage'
  }[store.storageBackend] || '本地存储'
  return store.dbError ? `${backend}\n注意：${store.dbError}` : backend
})

async function resetDemo() {
  try {
    await ElMessageBox.confirm(
      '将清空本机保存的全部设备、维保与工单数据，并重新生成一套演示数据（日期对齐到今天）。此操作不可撤销。',
      '重置演示数据',
      { type: 'warning', confirmButtonText: '确认重置', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  resetting.value = true
  try {
    await store.resetToSeedData()
    ElMessage.success('演示数据已重置，日期已对齐到今天')
  } catch (error) {
    ElMessage.error(`重置失败：${error.message}`)
  } finally {
    resetting.value = false
  }
}

/**
 * 引导演示。
 *
 * `startTour` 只在"环境不支持"时返回 ok:false（正常浏览器里不会发生），
 * 但那句话必须让用户看见 —— 静默什么都不发生，比报错更像坏了。
 * 其余情况（某一步的元素没出现）由播放器内部跳过，不往上抛，
 * 因为演示途中弹错误框是最糟的收场。
 *
 * 默认自动演示：每步停留后自动前进，工具条可暂停/手动步进/重来。
 */
function onPickDemoRoute(routeId) {
  void startDemoTour(routeId)
}

async function startDemoTour(routeId) {
  if (tourStarting.value) return
  tourStarting.value = true
  try {
    const result = await startTour(router, routeId, {
      auto: true,
      onState: (s) => {
        if (!s) {
          tourApi.value = null
          tourState.value = null
          return
        }
        tourState.value = s
      }
    })
    if (!result.ok) {
      ElMessage.warning(result.reason)
      return
    }
    tourApi.value = result.api
    // 若 onState 尚未触发（路线极短），同步一次初始状态
    if (!tourState.value) tourState.value = result.api.getState()
  } catch (error) {
    ElMessage.error(`引导演示启动失败：${error.message}`)
  } finally {
    tourStarting.value = false
  }
}
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html, body, #app {
  height: 100%;
  /* 用令牌里的完整字体栈，而不是只写死微软雅黑：
     令牌里排在前面的 HarmonyOS Sans SC / PingFang SC 在各自的系统上比雅黑清晰，
     此前这条覆盖把 --font-sans 整个作废了（实测 computed 只剩 Microsoft YaHei）。 */
  font-family: var(--font-sans);
}

.landing-wrapper {
  height: 100vh;
  overflow-y: auto;
}

.app-container {
  height: 100vh;
}

.app-aside {
  background: linear-gradient(180deg, var(--accent) 0%, var(--accent-dark) 100%);
  border-right: 1px solid rgba(255, 255, 255, 0.06);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

/* Logo */
.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 18px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.logo-mark {
  width: 36px;
  height: 36px;
  border-radius: var(--r-sm);
  background: rgba(11, 180, 196, 0.16);
  border: 1px solid rgba(11, 180, 196, 0.35);
  color: var(--signal-bright);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.logo-text {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 2px;
  color: var(--accent-contrast);
  line-height: 1.2;
}

.logo-sub {
  font-size: 10.5px;
  color: rgba(255, 255, 255, 0.66);
  letter-spacing: 0.5px;
  margin-top: 2px;
}

/* 导航搜索 */
.nav-search {
  margin: 12px 12px 4px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.1);
  transition: border-color 0.2s;
}

.nav-search:focus-within {
  border-color: rgba(11, 180, 196, 0.5);
  background: rgba(255, 255, 255, 0.12);
}

.nav-search-icon {
  color: rgba(255, 255, 255, 0.5);
  font-size: 14px;
  flex-shrink: 0;
}

.nav-search-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: var(--accent-contrast);
  font-size: 12.5px;
}

.nav-search-input::placeholder {
  color: rgba(255, 255, 255, 0.55);
}

/* 分组标题 */
.nav-group-title {
  padding: 7px 16px 4px;
  font-size: 10.5px;
  letter-spacing: 1.5px;
  /* 0.38 的白压在 #0b3a82 上只有 2.9:1 —— 组标题是导航的一半信息量，
     不该是全站最看不清的文字。提到 0.6 后为 4.9:1（顶部）/ 6.3:1（底部）。 */
  color: rgba(255, 255, 255, 0.6);
  font-weight: 600;
  white-space: nowrap;
}

/* 导航项 */
.nav-groups {
  flex: 1;
  overflow-y: auto;
  padding-bottom: 2px;
}

.nav-pinned {
  padding-top: 2px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 9px;
  /* 由 8px 16px / margin 2px 收成 6px 14px / margin 1px，配合组标题的内边距
     收紧，900px 视口下 15 个导航项刚好全部露出、不必滚动 */
  padding: 6px 14px;
  margin: 1px 8px;
  border-radius: 9px;
  color: rgba(255, 255, 255, 0.72);
  font-size: 13.5px;
  cursor: pointer;
  /* 精确列出过渡属性，避免 transition: all 性能开销 */
  transition: transform 0.22s var(--ease-out), background 0.22s var(--ease-out),
              color 0.22s, box-shadow 0.22s var(--ease-out);
  border-left: 3px solid transparent;
  position: relative;
  white-space: nowrap;
  will-change: transform;
}

/* ── hover 位移反馈（参考外贸智能体） ── */
.nav-item:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--accent-contrast);
  transform: translateX(3px);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
}

/* hover 时图标微旋转缩放 */
.nav-item:hover > .el-icon:first-child {
  transform: scale(1.12) rotate(-3deg);
  transition: transform 0.25s var(--ease-out);
}

.nav-item > .el-icon:first-child {
  transition: transform 0.25s var(--ease-out);
}

/* ── active 入场动画 ── */
@keyframes navActiveIn {
  from { opacity: 0.72; transform: translateX(-5px) scale(0.985); }
  to   { opacity: 1;    transform: translateX(0)    scale(1); }
}

.nav-item.active {
  background: rgba(11, 180, 196, 0.14);
  color: var(--accent-contrast);
  border-left-color: var(--signal);
  font-weight: 600;
  animation: navActiveIn 0.34s cubic-bezier(0.16, 1, 0.3, 1) both;
}

.nav-item.active .nav-label {
  color: var(--accent-contrast);
}

.nav-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nav-badge {
  /* 原本是 rgba(11,180,196,0.85) 配白字，实测 2.52:1。
     徽标承担的是"分类标签"语义（体检/告警/闭环…），不是严重度，
     所以不按类型分色，只把底色压深到 --signal-ink（白字 5.82:1）。 */
  background: var(--signal-ink);
  border: none;
  border-radius: 999px;
  font-size: 10px;
  padding: 0 7px;
  height: 17px;
  line-height: 17px;
  transition: transform 0.2s var(--ease-out);
}

/* badge hover 微动 */
.nav-item:hover .nav-badge {
  transform: translateX(-1px) scale(1.05);
}

.nav-pin {
  /* 原来放的是 emoji「📌 / ＋」，emoji 不受 font-size 约束、天生比文字大；
     换成 el-icon 后 font-size 即图标尺寸，11px 太小，抬到 13px 并居中对齐 */
  display: inline-flex;
  align-items: center;
  font-size: 13px;
  opacity: 0;
  cursor: pointer;
  transition: opacity 0.15s, transform 0.2s var(--ease-out);
  flex-shrink: 0;
}

.nav-pin.pinned {
  opacity: 0.75;
  color: var(--amber-on-dark);
}

.nav-item:hover .nav-pin {
  opacity: 0.55;
}

.nav-item .nav-pin:hover {
  opacity: 1 !important;
  color: var(--amber-on-dark);
}

/* 底部 */
.aside-footer {
  padding: 14px 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  text-align: center;
}

.version {
  font-size: 10.5px;
  color: rgba(255, 255, 255, 0.58);
  margin-top: 6px;
}

.offline-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 12px;
  color: var(--signal-bright);
}

.storage-line {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  margin-top: 8px;
  font-size: 11px;
  /* "数据存在本机"是这一页的卖点之一，看不清等于白写 —— 0.5 → 0.62 */
  color: rgba(255, 255, 255, 0.62);
}

/* 选择器必须带上 .aside-footer 再配 .el-button（0,3,0）。
   只写 .reset-btn 是 0,1,0，会被 Element Plus 自带的
   `.el-button.is-link { color: var(--el-button-text-color) }`（0,2,0）整个盖掉 ——
   实测这两个按钮因此渲染成 --el-text-color-regular #2a3852 压在侧栏 #072159 上，
   对比度 1.3:1，等于隐形。导入顺序救不了它：这里输的是特异度，不是先后。 */
.aside-footer .el-button.reset-btn {
  margin-top: 4px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.62);
}

.aside-footer .el-button.reset-btn:hover {
  /* 深底版的悬停提亮：同色相再亮一档，不必为一次 hover 单开令牌 */
  color: var(--danger-on-dark);
  filter: brightness(1.15);
}

/* .undo-btn 有一模一样的缺陷（同样被 .el-button.is-link 盖掉）。
   它挂在 v-if="lastUndo" 后面，没有撤销记录时不进 DOM，所以审计扫不到它 ——
   一旦有历史就会和重置按钮一样隐形。同一处修掉。 */
.aside-footer .el-button.undo-btn {
  margin-top: 6px;
  font-size: 11px;
  color: var(--amber-on-dark);
}

.aside-footer .el-button.undo-btn:hover {
  color: var(--amber-on-dark);
  filter: brightness(1.15);
}

.dot-green {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--emerald);
  box-shadow: 0 0 0 3px rgba(18, 160, 107, 0.25);
  animation: blink 2s ease-in-out infinite;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--chrome-bg);
  border-bottom: 1px solid var(--line);
  padding: 0 24px;
  height: 56px;
}

.header-left {
  display: flex;
  align-items: center;
}

.header-right {
  display: flex;
  gap: 8px;
}

.app-main {
  background: var(--bg);
  padding: 20px;
  overflow-y: auto;
}

/* 路由过渡动画 */
.fade-slide-enter-active,
.fade-slide-leave-active {
  transition: all 0.25s ease;
}

.fade-slide-enter-from {
  opacity: 0;
  transform: translateY(12px);
}

.fade-slide-leave-to {
  opacity: 0;
  transform: translateY(-12px);
}

.demo-route-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  line-height: 1.3;
}
.demo-route-desc {
  font-size: 11px;
  color: var(--text-3);
}

/* 响应式：窄屏折叠为图标栏 */
@media (max-width: 1024px) {  .app-aside {
    width: 64px !important;
  }
  .logo-text-wrap,
  .logo-sub,
  .nav-search,
  .nav-group-title,
  .nav-item .nav-label,
  .nav-item .nav-badge,
  .nav-item .nav-pin,
  .aside-footer .version,
  .aside-footer .storage-line,
  .aside-footer .reset-btn,
  .aside-footer .offline-badge {
    display: none;
  }
  .logo {
    justify-content: center;
    padding: 14px 0;
  }
  .nav-item {
    justify-content: center;
    padding: 10px 0;
    margin: 2px 10px;
  }
  .app-header {
    padding: 0 16px;
  }
  .app-main {
    padding: 12px;
  }
}

/* 落盘失败时的状态栏高亮。
   选择器比基础的 .storage-line 多一个类，因此不必关心它在样式表里的先后位置。
   颜色优先取深色语义色 --on-dark-danger，取不到时回落到字面值 —— 侧栏是深色底，
   不能用为白底调的 --danger。 */
.storage-line.storage-error {
  color: var(--on-dark-danger, #ff9a9a);
  font-weight: 600;
}
</style>
