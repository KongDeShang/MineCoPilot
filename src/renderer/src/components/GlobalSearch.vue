<template>
  <div class="global-search">
    <el-input
      v-model="searchText"
      placeholder="搜索设备、工单、维保记录..."
      clearable
      @focus="showPanel = true"
      @input="doSearch"
    >
      <template #prefix>
        <el-icon><Search /></el-icon>
      </template>
      <template #append>
        <el-button @click="showPanel = !showPanel">
          <el-icon><Search /></el-icon>
        </el-button>
      </template>
    </el-input>

    <!-- 搜索结果面板 -->
    <div v-if="showPanel && searchText" class="search-panel">
      <div class="search-section" v-for="(section, i) in searchResults" :key="i">
        <div class="section-title">
          <el-icon><component :is="section.icon" /></el-icon>
          {{ section.title }}
          <el-tag size="small" type="info">{{ section.items.length }}</el-tag>
        </div>
        <div
          v-for="(item, j) in section.items"
          :key="j"
          class="search-item"
          @click="navigateTo(item)"
        >
          <div class="item-title" v-html="highlight(item.title)"></div>
          <div class="item-meta">{{ item.meta }}</div>
        </div>
        <el-empty v-if="section.items.length === 0" :description="`未找到匹配的${section.title}`" :image-size="40" />
      </div>

      <div v-if="totalResults === 0" class="no-results">
        <el-icon :size="32" color="var(--text-mute)"><Search /></el-icon>
        <p>未找到匹配结果</p>
      </div>
    </div>

    <!-- 遮罩 -->
    <div v-if="showPanel" class="search-overlay" @click="showPanel = false"></div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '../stores/appStore'
import { statusLabel, priorityLabel, equipmentStatusLabel } from '../utils/dictionaries'

const store = useAppStore()
const router = useRouter()
const searchText = ref('')
const showPanel = ref(false)

// 工单状态/优先级的中文名统一取自 utils/dictionaries.js（单一来源）

/** 统一转小写并压成字符串：台账字段可能缺失（如 technician 未填），直接 .includes 会抛 */
const lower = (value) => String(value ?? '').toLowerCase()

const searchResults = computed(() => {
  const keyword = lower(searchText.value.trim())
  if (!keyword) return []

  const allMaintenance = []
  for (const eq of store.equipmentList) {
    const records = store.getMaintenanceByEquipmentId(eq.id)
    records.forEach(r => {
      allMaintenance.push({ equipment: eq.name, ...r })
    })
  }

  return [
    {
      title: '设备',
      icon: 'SetUp',
      items: store.equipmentList
        .filter(e => lower(e.name).includes(keyword) || lower(e.model).includes(keyword) || lower(e.location).includes(keyword))
        .map(e => ({
          title: `${e.name} (${e.model})`,
          meta: `${e.location} · ${equipmentStatusLabel(e.status)}`,
          route: '/equipment',
          // 复用设备台账已有的 ?id= 直达画像，而不是跳到列表让用户自己再找一遍
          focus: { path: '/equipment', query: { id: String(e.id) } }
        }))
    },
    {
      title: '工单',
      icon: 'EditPen',
      items: store.workOrders
        .filter(o => lower(o.title).includes(keyword) || lower(o.equipment_name).includes(keyword))
        .map(o => ({
          title: `#${o.id} ${o.title}`,
          meta: `${o.equipment_name} · ${statusLabel(o.status)} · ${priorityLabel(o.priority)}`,
          route: '/workorder',
          focus: { path: '/workorder', query: { focus: String(o.id) } }
        }))
    },
    {
      title: '维保记录',
      icon: 'Calendar',
      items: allMaintenance
        .filter(m => lower(m.equipment).includes(keyword) || lower(m.description).includes(keyword) || lower(m.technician).includes(keyword))
        .map(m => ({
          title: `${m.equipment} - ${m.typeLabel || m.type || '维保'}`,
          meta: `${m.date} · ${m.technician || '未填'} · ${m.description || ''}`,
          route: '/maintenance-calendar',
          focus: { path: '/maintenance-calendar', query: { focus: m.equipment } }
        }))
    }
  ]
})

const totalResults = computed(() => {
  return searchResults.value.reduce((sum, s) => sum + s.items.length, 0)
})

function doSearch() {
  showPanel.value = searchText.value.length > 0
}

/** 正则元字符转义：搜索框直接吃用户输入，( [ * \ 这些字符会让 new RegExp 抛
 *  Invalid regular expression，而 highlight 是在模板渲染里调的 —— 一抛就是整页白屏。 */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function highlight(text) {
  const keyword = searchText.value.trim()
  if (!keyword) return text
  // 再兜一层 try/catch：万一还有转义覆盖不到的情况，退化成不高亮，而不是把页面炸掉
  try {
    const regex = new RegExp(`(${escapeRegExp(keyword)})`, 'gi')
    return text.replace(regex, '<span class="highlight">$1</span>')
  } catch {
    return text
  }
}

function navigateTo(item) {
  // 优先带上定位参数：跳到目标页并直接打开/高亮那一条，而不是丢用户在列表里自己找
  router.push(item.focus || item.route)
  showPanel.value = false
  searchText.value = ''
}
</script>

<style scoped>
.global-search {
  position: relative;
  width: 320px;
}

.search-overlay {
  position: fixed;
  inset: 0;
  z-index: 99;
}

.search-panel {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 100;
  background: var(--card);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
  margin-top: 4px;
  max-height: 400px;
  overflow-y: auto;
}

.search-section {
  padding: 12px;
  border-bottom: 1px solid var(--line-2);
}

.search-section:last-child {
  border-bottom: none;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-3);
  margin-bottom: 8px;
}

.search-item {
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.2s;
}

.search-item:hover {
  background: var(--accent-soft);
}

.item-title {
  font-size: 14px;
  color: var(--text-1);
}

.item-title :deep(.highlight) {
  color: var(--accent);
  font-weight: 700;
}

.item-meta {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 2px;
}

.no-results {
  text-align: center;
  padding: 24px;
  color: var(--text-mute);
}

.no-results p {
  margin: 8px 0 0;
  font-size: 14px;
}
</style>
