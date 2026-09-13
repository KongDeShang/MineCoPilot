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
          <el-icon :size="22"><Monitor /></el-icon>
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
        <div class="storage-line" :title="storageDetail">
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
</template>

<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import GlobalSearch from './components/GlobalSearch.vue'
import { useAppStore } from './stores/appStore'
import { llmAvailable, llmLoad, llmStatus } from './utils/llmClient'

const route = useRoute()
const router = useRouter()
const store = useAppStore()
const resetting = ref(false)
const navQuery = ref('')
const pinned = ref(loadPinned())

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
})

onBeforeUnmount(() => {
  if (llmTimer) clearInterval(llmTimer)
})

/** 最近一次口述录入（决定侧边栏是否显示撤销入口） */
const lastUndo = computed(() => store.peekUndo())

/** 导航注册表：按"设备健康智能体"三层叙事分组 */
const NAV_GROUPS = [
  {
    name: '设备健康',
    items: [
      { path: '/dashboard', label: '数据看板', icon: 'DataBoard' },
      { path: '/equipment', label: '设备台账', icon: 'SetUp' },
      { path: '/medical-records', label: '设备病历', icon: 'Notebook', badge: '体检' }
    ]
  },
  {
    name: '运维执行',
    items: [
      { path: '/alert-center', label: '告警中心', icon: 'Bell', badge: '告警' },
      { path: '/maintenance-calendar', label: '维保日历', icon: 'Calendar' },
      { path: '/workorder', label: '工单管理', icon: 'EditPen' },
      { path: '/recheck', label: '复诊管理', icon: 'CircleCheck', badge: '闭环' }
    ]
  },
  {
    name: 'AI 智能',
    items: [
      { path: '/ai-assistant', label: 'AI 助手', icon: 'ChatDotRound' },
      { path: '/model-hub', label: '本地模型', icon: 'Cpu', badge: '本地' },
      { path: '/knowledge-base', label: '维修规程库', icon: 'Reading', badge: '规程' },
      { path: '/documents', label: '手册资料库', icon: 'FolderOpened', badge: '文档' }
    ]
  },
  {
    name: '数据资产',
    items: [
      { path: '/fault-cases', label: '故障案例库', icon: 'Warning', badge: 'TOP' },
      { path: '/parts-inventory', label: '备件库存', icon: 'Box', badge: '联动' },
      { path: '/logs', label: '操作日志', icon: 'List' }
    ]
  },
  {
    name: '系统',
    items: [
      { path: '/settings', label: '系统设置', icon: 'Setting' }
    ]
  }
]

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
  const titles = {
    '/dashboard': '数据看板',
    '/equipment': '设备台账',
    '/medical-records': '设备病历',
    '/alert-center': '告警中心',
    '/parts-inventory': '备件库存',
    '/maintenance-calendar': '维保日历',
    '/workorder': '工单管理',
    '/recheck': '复诊管理',
    '/ai-assistant': 'AI 助手',
    '/model-hub': '本地模型',
    '/knowledge-base': '维修规程库',
    '/fault-cases': '故障案例库',
    '/logs': '操作日志',
    '/documents': '手册资料库',
    '/settings': '系统设置'
  }
  return titles[route.path] || '首页'
})

// 存储状态：让"数据存在本地"这件事在界面上可见
const storageLabel = computed(() => {
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
  transition: all 0.15s ease;
  border-left: 3px solid transparent;
  position: relative;
  white-space: nowrap;
}

.nav-item:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--accent-contrast);
}

.nav-item.active {
  background: rgba(11, 180, 196, 0.14);
  color: var(--accent-contrast);
  border-left-color: var(--signal);
  font-weight: 600;
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
}

.nav-pin {
  /* 原来放的是 emoji「📌 / ＋」，emoji 不受 font-size 约束、天生比文字大；
     换成 el-icon 后 font-size 即图标尺寸，11px 太小，抬到 13px 并居中对齐 */
  display: inline-flex;
  align-items: center;
  font-size: 13px;
  opacity: 0;
  cursor: pointer;
  transition: opacity 0.15s;
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

/* 响应式：窄屏折叠为图标栏 */
@media (max-width: 1024px) {
  .app-aside {
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
</style>
