<template>
  <div class="settings-page">
    <!-- ===== 演示参数 ===== -->
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span><el-icon><Setting /></el-icon> 系统设置 · 演示参数（可审计口径）</span>
          <el-tag size="small" type="info" effect="plain">改动即时生效 · 历史快照不受影响</el-tag>
        </div>
      </template>

      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="所有估算数字都来自这里的口径：日产出假设 → 停机损失；风险系数 → 健康分与损失放大；健康分档 → A/B/C/D 分级。参数一经调整，看板、体检报告、AI 助手立即同源重算。"
        style="margin-bottom: 16px"
      />

      <!-- 预设生产场景：一键应用整套口径 -->
      <div class="section-title">预设生产场景（一键切换整套估算口径）</div>
      <div class="scenario-row">
        <div
          v-for="(sc, key) in scenarios"
          :key="key"
          class="scenario-card"
          :class="{ active: activeScenario === key }"
          @click="applyScenario(key)"
        >
          <div class="scenario-name">{{ sc.name }}</div>
          <div class="scenario-desc">{{ sc.desc }}</div>
          <div class="scenario-tags">
            <el-tag size="small" effect="plain">产出系数 ×{{ sc.factor }}</el-tag>
            <el-tag size="small" type="warning" effect="plain">D 级风险 {{ sc.risk.D }}</el-tag>
          </div>
        </div>
      </div>
      <div class="scenario-note">点击即应用：日产出假设 × 场景系数、风险系数切换到对应档位，并立即落盘生效。</div>

      <!-- 日产出假设 -->
      <div class="section-title" style="margin-top: 14px">停机损失 · 日产出假设（元 / 日 / 台）</div>
      <el-row :gutter="14">
        <el-col :xs="12" :sm="8" :md="4" v-for="cat in categories" :key="cat" style="margin-bottom: 12px">
          <div class="param-field">
            <div class="param-label">{{ cat }}</div>
            <el-input-number
              v-model="form.dailyOutputLoss[cat]"
              :min="0" :step="5000" :controls="false"
              style="width: 100%"
            />
          </div>
        </el-col>
      </el-row>
      <div class="param-note">
        口径：数值为"该设备停机一天对产线的产出损失"演示假设，参照公开台班费 / 租赁报价量级，非真实财务数据。
      </div>

      <!-- 风险系数 -->
      <div class="section-title" style="margin-top: 8px">停机损失 · 风险系数（等级越高，损失放大越多）</div>
      <el-row :gutter="14">
        <el-col :xs="12" :sm="6" v-for="lvl in ['A', 'B', 'C', 'D']" :key="lvl" style="margin-bottom: 12px">
          <div class="param-field">
            <div class="param-label">{{ lvl }} 级（{{ levelDesc[lvl] }}）</div>
            <el-input-number v-model="form.riskFactor[lvl]" :min="0.1" :max="0.9" :step="0.1" style="width: 100%" />
          </div>
        </el-col>
      </el-row>

      <!-- 健康分档 -->
      <div class="section-title" style="margin-top: 8px">健康分等级分档（≥ 阈值进入对应档）</div>
      <el-row :gutter="14">
        <el-col :xs="12" :sm="6" v-for="lvl in ['A', 'B', 'C']" :key="lvl" style="margin-bottom: 12px">
          <div class="param-field">
            <div class="param-label">{{ lvl }} 档起始分</div>
            <el-input-number v-model="form.bounds[lvl]" :min="0" :max="100" :step="5" style="width: 100%" />
          </div>
        </el-col>
        <el-col :xs="12" :sm="6">
          <div class="param-field">
            <div class="param-label">D 档</div>
            <div class="param-static">低于 C 档起始分</div>
          </div>
        </el-col>
      </el-row>

      <div class="actions">
        <el-button type="primary" :loading="saving" @click="save">
          <el-icon style="margin-right: 4px"><Check /></el-icon>保存并立即生效
        </el-button>
        <el-button @click="reset">恢复默认参数</el-button>
      </div>

      <div class="settings-note">
        演示口径：日产出为假设值而非真实财务数据；历史体检快照是已发生的事实，调整参数不会改写历史，
        只影响之后生成的健康分、损失估算与新快照——这正是"可审计"的一部分：参数可追溯、结果可复算。
      </div>
    </el-card>

    <!-- ===== 数据备份与迁移 ===== -->
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span><el-icon><Files /></el-icon> 数据备份与迁移（一键换机）</span>
          <el-tag size="small" type="success" effect="plain">数据全在本机 · 备份就是带走</el-tag>
        </div>
      </template>

      <div class="backup-row">
        <div class="backup-action">
          <el-button type="primary" size="large" :loading="exporting" @click="doExport">
            <el-icon style="margin-right: 4px"><Download /></el-icon>一键导出备份
          </el-button>
          <div class="backup-desc">生成单个 .mbak 文件：设备台账、维保记录、工单、健康快照、知识库、AI 聊天记录全带走</div>
        </div>
        <div class="backup-action">
          <el-button type="success" size="large" :loading="importing" @click="doImport">
            <el-icon style="margin-right: 4px"><Upload /></el-icon>一键导入备份
          </el-button>
          <div class="backup-desc">选择 .mbak 文件恢复全部数据，完成后重启应用生效</div>
        </div>
      </div>

      <div class="backup-steps">
        <div class="backup-steps-title"><el-icon><Guide /></el-icon> 换电脑三步走</div>
        <div class="backup-steps-grid">
          <div class="step-item"><span class="step-num">1</span><div class="step-txt"><b>旧电脑导出</b><span>设置页点「一键导出备份」，把 .mbak 文件拷到 U 盘 / 网盘</span></div></div>
          <div class="step-item"><span class="step-num">2</span><div class="step-txt"><b>新电脑安装</b><span>安装矿山智工安装包（模型与照片随包内置，无需另拷）</span></div></div>
          <div class="step-item"><span class="step-num">3</span><div class="step-txt"><b>新电脑导入</b><span>设置页点「一键导入备份」，重启即全部恢复</span></div></div>
        </div>
      </div>

      <div class="backup-meta" v-if="dbPath">
        <el-icon><FolderOpened /></el-icon>
        本地数据库位置：<code>{{ dbPath }}</code>
        <span v-if="dbSize">（{{ dbSize }}）</span>
        <el-button link type="primary" size="small" @click="openDbFolder">打开所在文件夹</el-button>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAppStore } from '../stores/appStore'
import { DAILY_OUTPUT_LOSS, PRESET_SCENARIOS } from '../utils/health'
import { exportBackup, importBackup } from '../utils/backup'

const store = useAppStore()
const saving = ref(false)
const exporting = ref(false)
const importing = ref(false)
const dbPath = ref('')
const dbSize = ref('')

const categories = Object.keys(DAILY_OUTPUT_LOSS)
const levelDesc = { A: '优', B: '良', C: '预警', D: '严重' }
const scenarios = PRESET_SCENARIOS
const activeScenario = ref('')

const form = reactive({
  dailyOutputLoss: { ...DAILY_OUTPUT_LOSS },
  riskFactor: { ...PRESET_SCENARIOS.aggregate.risk },
  bounds: { A: 85, B: 70, C: 55 }
})

// 用 store 当前设置初始化（启动时已从本地库恢复）
if (store.settings) {
  Object.assign(form.dailyOutputLoss, store.settings.dailyOutputLoss)
  Object.assign(form.riskFactor, store.settings.riskFactor)
  Object.assign(form.bounds, store.settings.bounds)
  // 识别当前最接近的场景（默认聚合场景）
  const cur = form.dailyOutputLoss['矿卡'] || 0
  const base = DAILY_OUTPUT_LOSS['矿卡'] || 1
  const ratio = cur / base
  if (Math.abs(ratio - PRESET_SCENARIOS.openPit.factor) < 0.15) activeScenario.value = 'openPit'
  else if (Math.abs(ratio - PRESET_SCENARIOS.construction.factor) < 0.15) activeScenario.value = 'construction'
  else activeScenario.value = 'aggregate'
}

function applyScenario(key) {
  const sc = scenarios[key]
  if (!sc) return
  activeScenario.value = key
  const next = {}
  for (const cat of categories) {
    next[cat] = Math.round((DAILY_OUTPUT_LOSS[cat] || 30000) * sc.factor / 1000) * 1000
  }
  Object.assign(form.dailyOutputLoss, next)
  Object.assign(form.riskFactor, { ...sc.risk })
  store.updateSettings({
    dailyOutputLoss: { ...form.dailyOutputLoss },
    riskFactor: { ...form.riskFactor }
  })
  ElMessage.success(`已应用「${sc.name}」预设场景：日产出假设与风险系数已同源更新`)
}

function save() {
  saving.value = true
  setTimeout(() => {
    store.updateSettings({
      dailyOutputLoss: { ...form.dailyOutputLoss },
      riskFactor: { ...form.riskFactor },
      bounds: { ...form.bounds }
    })
    saving.value = false
    activeScenario.value = ''
    ElMessage.success('设置已保存并生效：健康分、停机损失、等级分档已同源重算')
  }, 200)
}

function reset() {
  Object.assign(form.dailyOutputLoss, DAILY_OUTPUT_LOSS)
  Object.assign(form.riskFactor, { ...PRESET_SCENARIOS.aggregate.risk })
  Object.assign(form.bounds, { A: 85, B: 70, C: 55 })
  store.resetSettings()
  activeScenario.value = 'aggregate'
  ElMessage.success('已恢复默认演示参数')
}

// ---------- 备份与迁移 ----------
async function doExport() {
  exporting.value = true
  try {
    const r = await exportBackup()
    if (r && r.ok) {
      ElMessage.success(`备份导出成功${r.path ? `：${r.path}` : ''}`)
      store.addLog({ content: `导出数据备份（${(r.size / 1024).toFixed(0)} KB）`, source: '设置', type: 'success', tagType: 'success' })
    } else if (r && r.canceled) {
      /* 用户取消 */
    } else {
      ElMessage.error((r && r.error) || '导出失败')
    }
  } finally {
    exporting.value = false
  }
}

async function doImport() {
  try {
    await ElMessageBox.confirm(
      '导入将覆盖当前全部本地数据（设备台账、维保、工单、快照、知识库、聊天记录）。建议先导出当前备份再导入。是否继续？',
      '导入备份',
      { confirmButtonText: '继续导入', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  importing.value = true
  try {
    const r = await importBackup()
    if (r && r.ok) {
      // ⚠️ 必须先把内存状态换成导入后的库，再记日志：
      // addLog 默认会触发 persistAll()，若此时内存里还是导入前的数据，
      // 一次"导入成功"的日志写入就会把整库覆盖回旧数据。
      await store.reloadFromDb()
      ElMessageBox.alert(
        '备份恢复成功，界面已同步刷新。设备台账、维保记录、工单、健康快照、知识库、操作日志与聊天记录均已替换为备份内容。',
        '导入完成',
        { confirmButtonText: '知道了' }
      )
      store.addLog({
        content: `导入数据备份${r.exportedAt ? `（导出于 ${r.exportedAt.slice(0, 10)}）` : ''}`,
        source: '设置',
        type: 'success',
        tagType: 'success'
      })
    } else if (r && r.canceled) {
      /* 用户取消 */
    } else {
      ElMessage.error((r && r.error) || '导入失败')
    }
  } finally {
    importing.value = false
  }
}

// 展示数据库文件位置（Electron 桌面版）
async function loadDbInfo() {
  try {
    if (window.electronAPI && window.electronAPI.db) {
      const info = await window.electronAPI.db.info()
      if (info && info.path) {
        dbPath.value = info.path
        if (info.size > 0) dbSize.value = (info.size / 1024).toFixed(0) + ' KB'
      }
    }
  } catch {
    /* 非桌面环境不展示 */
  }
}
function openDbFolder() {
  const idx = dbPath.value.lastIndexOf('\\')
  const folder = idx > 0 ? dbPath.value.slice(0, idx) : dbPath.value
  if (window.electronAPI && window.electronAPI.app && window.electronAPI.app.openPath) window.electronAPI.app.openPath(folder)
}
loadDbInfo()
</script>

<style scoped>
.settings-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
  color: #0b3a82;
  margin: 4px 0 12px;
}

.param-field {
  background: #fafcff;
  border: 1px solid #dde4ef;
  border-radius: 10px;
  padding: 10px 12px;
}

.param-label {
  font-size: 12px;
  color: #5a6779;
  margin-bottom: 8px;
}

.param-static {
  font-size: 13px;
  color: #8a95a7;
  line-height: 32px;
}

.param-note {
  font-size: 11.5px;
  color: #8a95a7;
  margin: -4px 0 10px;
}

.actions {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px dashed #dde4ef;
  display: flex;
  gap: 10px;
}

.settings-note {
  margin-top: 16px;
  font-size: 12px;
  color: #8a95a7;
  line-height: 1.8;
  background: #f4f7fb;
  border-radius: 10px;
  padding: 12px 14px;
}

/* 预设场景 */
.scenario-row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.scenario-card {
  flex: 1 1 220px;
  min-width: 200px;
  border: 1.5px solid #dde4ef;
  border-radius: 10px;
  padding: 12px 14px;
  cursor: pointer;
  transition: all 0.2s;
  background: #fff;
}
.scenario-card:hover {
  border-color: #0b3a82;
  box-shadow: 0 4px 14px rgba(11, 58, 130, 0.1);
}
.scenario-card.active {
  border-color: #0b3a82;
  background: linear-gradient(135deg, rgba(11, 58, 130, 0.06), rgba(28, 107, 212, 0.1));
  box-shadow: 0 4px 14px rgba(11, 58, 130, 0.16);
}
.scenario-name {
  font-size: 14px;
  font-weight: 700;
  color: #0b3a82;
}
.scenario-desc {
  font-size: 11.5px;
  color: #6b7280;
  margin: 4px 0 8px;
  line-height: 1.5;
}
.scenario-tags {
  display: flex;
  gap: 6px;
}
.scenario-note {
  font-size: 11.5px;
  color: #8a95a7;
  margin-bottom: 6px;
}

/* 备份 */
.backup-row {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
}
.backup-action {
  flex: 1 1 300px;
  min-width: 0;
}
.backup-desc {
  margin-top: 8px;
  font-size: 12px;
  color: #8a95a7;
  line-height: 1.6;
}
.backup-steps {
  margin-top: 18px;
  background: #f4f7fb;
  border-radius: 10px;
  padding: 12px 14px;
}
.backup-steps-title {
  font-size: 12.5px;
  font-weight: 700;
  color: #0b3a82;
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
}
.backup-steps-grid {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
}
.step-item {
  flex: 1 1 200px;
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.step-num {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #0b3a82;
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.step-txt {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.step-txt b {
  font-size: 12.5px;
  color: #1f2937;
}
.step-txt span {
  font-size: 11.5px;
  color: #6b7280;
  line-height: 1.5;
}
.backup-meta {
  margin-top: 16px;
  font-size: 12px;
  color: #6b7280;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  background: #fafcff;
  border: 1px solid #eef0f3;
  border-radius: 8px;
  padding: 8px 12px;
}
.backup-meta code {
  background: #eef1f6;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 11px;
  word-break: break-all;
}
</style>
