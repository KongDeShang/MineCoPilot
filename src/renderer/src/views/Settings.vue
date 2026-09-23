<template>
  <div class="settings-page">
    <!-- ===== 外观 · 主题 ===== -->
    <el-card shadow="never" style="margin-bottom: 16px">
      <template #header>
        <div class="card-header">
          <span><el-icon><Moon /></el-icon> 外观 · 主题</span>
          <el-tag size="small" type="info" effect="plain">立即生效 · 重启保持 · 随备份迁移</el-tag>
        </div>
      </template>

      <div class="theme-row">
        <el-radio-group v-model="themePref" @change="setTheme">
          <el-radio-button value="light">浅色</el-radio-button>
          <el-radio-button value="dark">深色</el-radio-button>
          <el-radio-button value="system">跟随系统</el-radio-button>
        </el-radio-group>
        <div class="theme-hint">
          深色主题为夜间答辩 / 数据大屏场景准备；「跟随系统」会随操作系统深浅自动切换。
          <span v-if="themePref === 'system'" class="theme-sys-now">当前系统为{{ systemIsDark ? '深色' : '浅色' }}，应用现处于{{ systemIsDark ? '深色' : '浅色' }}模式。</span>
        </div>
      </div>

      <!-- 色彩主题 -->
      <div class="theme-row" style="margin-top: 16px">
        <div class="color-theme-label">色彩主题</div>
        <div class="color-swatches">
          <div
            v-for="(theme, key) in colorThemes"
            :key="key"
            class="color-swatch"
            :class="{ active: colorPref === key }"
            :title="theme.label"
            @click="setColor(key)"
          >
            <span class="swatch-fill" :style="{ background: theme.accent }"></span>
            <span class="swatch-signal" :style="{ background: theme.signal }"></span>
            <span v-if="colorPref === key" class="swatch-check">✓</span>
          </div>
        </div>
        <div class="theme-hint">选择品牌色调，覆盖全局主色和强调色。深色模式下同样生效。</div>
      </div>
    </el-card>

    <!-- ===== AI 助手（老师傅人设 + 排查思路表） ===== -->
    <el-card shadow="never" style="margin-bottom: 16px">
      <template #header>
        <div class="card-header">
          <span><el-icon><ChatDotRound /></el-icon> AI 助手 · 老师傅模式与排查经验</span>
          <el-tag size="small" type="info" effect="plain">即时生效 · 随备份迁移</el-tag>
        </div>
      </template>

      <!-- 老师傅模式开关 -->
      <div class="theme-row">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <el-switch v-model="masterMode" @change="toggleMaster" />
          <span style="font-weight:600">AI 老师傅模式</span>
          <span class="theme-hint">开启后 AI 助手以矿山老机修的口吻回答：直接、带经验式引导（先查→再换→后试），仍只动语气不动事实——数字来自本地台账、规程来自知识库，不新增任何内容。</span>
        </div>
      </div>

      <el-divider />

      <!-- 四类排查思路表（用户可维护） -->
      <div class="section-title">四类故障排查思路表（未命中知识库时的兜底经验，可现场维护）</div>
      <div style="margin-bottom:12px;font-size:12px;color:var(--text-3);line-height:1.7">
        每类思路按「先看 → 再查 → 后动」分层，供 AI 助手在知识库没有精确条目时给出排查方向。
        编辑格式：<strong>每行一条，格式「步骤名：步骤详情」</strong>；保存后 AI 助手立即生效。
      </div>
      <el-collapse>
        <el-collapse-item v-for="m in troubleshootMaps" :key="m.id" :name="m.id">
          <template #title>
            <span style="font-weight:600">{{ m.system }}</span>
            <span style="margin-left:12px;font-size:12px;color:var(--text-3)">
              {{ (m.checkOrder || []).length }} 步 · {{ (m.userNotes || []).length ? `${m.userNotes.length} 条现场备注` : '默认思路' }}
            </span>
          </template>
          <el-input
            v-model="troubleshootDrafts[m.id]"
            type="textarea"
            :rows="(m.checkOrder || []).length + 1"
            style="margin-bottom:8px"
          />
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <el-button type="primary" size="small" @click="saveTroubleshoot(m.id)">保存该类思路</el-button>
            <el-button size="small" @click="resetTroubleshoot(m.id)">恢复该类默认</el-button>
            <el-button size="small" plain @click="resetAllTroubleshoot">恢复全部默认</el-button>
          </div>
        </el-collapse-item>
      </el-collapse>
    </el-card>

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
          <div class="backup-desc">生成单个 .mbak 文件：设备台账、维保记录、工单、健康快照、知识库、文档资料、设置、AI 聊天记录全带走（含完整性校验）</div>
        </div>
        <div class="backup-action">
          <el-button type="success" size="large" :loading="importing" @click="doImport">
            <el-icon style="margin-right: 4px"><Upload /></el-icon>一键导入备份
          </el-button>
          <div class="backup-desc">选择 .mbak 文件恢复全部数据（导入前自动备份当前数据，可回滚），完成后重启应用生效</div>
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
        <el-button link type="primary" size="small" @click="copyDbPath">复制路径</el-button>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAppStore } from '../stores/appStore'
import { DAILY_OUTPUT_LOSS, PRESET_SCENARIOS } from '../utils/health'
import { exportBackup, importBackup } from '../utils/backup'
import { masterEnabled, setMasterEnabled } from '../utils/masterPersona'
import { getTroubleshootMaps, saveTroubleshootMap, resetTroubleshootMaps } from '../utils/troubleshootMaps'
import { applyPref, readMirror, readColorMirror, applyColor, saveColorMirror, watchSystem, THEME_PREF_META_KEY, COLOR_THEMES } from '../utils/theme'
import * as db from '../utils/database'

const store = useAppStore()
const saving = ref(false)
const exporting = ref(false)
const importing = ref(false)
const dbPath = ref('')
const dbSize = ref('')

// ---------- AI 助手（老师傅人设 + 排查思路表） ----------
const masterMode = ref(masterEnabled())
function toggleMaster(on) {
  setMasterEnabled(on)
  masterMode.value = on
  ElMessage.success(on ? '已开启「AI 老师傅」模式：AI 助手将以老机修口吻回答（数字与规程仍来自本地）' : '已关闭「AI 老师傅」模式')
}

const troubleshootMaps = ref([])
const troubleshootDrafts = reactive({})
function loadTroubleshootMaps() {
  troubleshootMaps.value = getTroubleshootMaps()
  for (const m of troubleshootMaps.value) {
    // textarea 编辑格式：每行"步骤：详情"，便于现场维护
    troubleshootDrafts[m.id] = (m.checkOrder || []).map(c => `${c.step}：${c.detail}`).join('\n')
  }
}
function saveTroubleshoot(id) {
  const text = String(troubleshootDrafts[id] || '').trim()
  if (!text) return
  const checkOrder = text.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const idx = line.indexOf('：')
    return idx > 0
      ? { step: line.slice(0, idx).trim(), detail: line.slice(idx + 1).trim() }
      : { step: line.slice(0, 12), detail: line }
  }).filter(c => c.step)
  const r = saveTroubleshootMap(id, { checkOrder })
  if (r.ok) {
    ElMessage.success('排查思路已保存（本机生效，随备份迁移）')
    loadTroubleshootMaps()
  } else {
    ElMessage.error((r && r.error) || '保存失败')
  }
}
function resetTroubleshoot(id) {
  const r = saveTroubleshootMap(id, null)
  if (r.ok) {
    ElMessage.success('已恢复默认排查思路')
    loadTroubleshootMaps()
  } else {
    ElMessage.error((r && r.error) || '恢复失败')
  }
}
function resetAllTroubleshoot() {
  resetTroubleshootMaps()
  ElMessage.success('已恢复全部默认排查思路')
  loadTroubleshootMaps()
}

// ---------- 主题（任务 09） ----------
const themePref = ref(db.getMeta(THEME_PREF_META_KEY) || readMirror())
const systemIsDark = ref(typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: dark)').matches
  : false)
// 跟随系统模式下，系统切换时同步"当前系统为XX"提示
const stopSystemWatch = watchSystem(() => {
  systemIsDark.value = window.matchMedia('(prefers-color-scheme: dark)').matches
})

/** 写入 meta（权威）+ 应用 + 回写镜像（供首帧 theme-init 用） */
function setTheme() {
  const p = themePref.value
  db.setMeta(THEME_PREF_META_KEY, p)
  applyPref(p)
  systemIsDark.value = window.matchMedia('(prefers-color-scheme: dark)').matches
  ElMessage.success(`已切换为${p === 'dark' ? '深色' : p === 'light' ? '浅色' : '跟随系统'}主题`)
}

// ---------- 色彩主题 ----------
const colorThemes = COLOR_THEMES
const colorPref = ref(readColorMirror())

function setColor(key) {
  colorPref.value = key
  applyColor(key)
  saveColorMirror(key)
  ElMessage.success(`已切换为「${COLOR_THEMES[key]?.label || key}」色彩主题`)
}

onMounted(() => {
  systemIsDark.value = window.matchMedia('(prefers-color-scheme: dark)').matches
  loadTroubleshootMaps()
})
onBeforeUnmount(() => stopSystemWatch())

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
  } catch (error) {
    // 原来这里只有 try/finally 没有 catch：备份导出中途抛错（如手册文件读取失败）
    // 会变成未处理的 rejection —— 界面既不提示成功也不提示失败，用户以为没点。
    ElMessage.error((error && error.message) || '导出失败')
    store.addLog({ content: `导出备份失败：${(error && error.message) || error}`, source: '设置', type: 'danger', tagType: 'danger' })
  } finally {
    exporting.value = false
  }
}

async function doImport() {
  try {
    await ElMessageBox.confirm(
      '导入将覆盖当前全部本地数据（设备台账、维保、工单、快照、知识库、文档资料、设置、聊天记录）。导入前会自动备份当前数据到本机 backups 目录。是否继续？',
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
      const reloaded = await store.reloadFromDb()

      /**
       * 备份导入的结果必须如实呈现。
       *
       * 此前这里无条件弹"备份恢复成功…均已替换为备份内容"，包括两种其实没恢复好的情况：
       *   1) 备份里没有设备台账（但有工单/日志等）—— 曾被换成演示数据，界面却说成功；
       *   2) 备份整库为空 —— 曾被整套演示数据替换，界面同样说成功。
       * 现在按 reloadFromDb 的三态如实分支，绝不谎报。
       */
      if (!reloaded || !reloaded.ok) {
        if (reloaded && reloaded.reason === 'empty-backup') {
          ElMessageBox.alert(
            '这份备份里没有任何数据（设备台账、工单、维保记录、日志、知识库、备件全为空），已按"不恢复"处理，没有改动你的数据。' +
              (r.autoBackupPath ? `\n\n导入前的自动备份仍在：\n${r.autoBackupPath}` : ''),
            '备份为空，未恢复',
            { confirmButtonText: '知道了', type: 'warning' }
          )
          return
        }
        ElMessage.error('备份内容已读入，但界面刷新失败，请重启应用后确认数据。')
        return
      }

      const ledgerNote = reloaded.reason === 'empty-ledger'
        ? '\n\n注意：这份备份里没有设备台账（其余数据已照常恢复），因此台账页会是空的——这是备份本身的状况，不是恢复失败。'
        : ''
      ElMessageBox.alert(
        '备份恢复成功，界面已同步刷新。设备台账、维保记录、工单、健康快照、知识库、文档资料、设置与聊天记录均已替换为备份内容。' +
          ledgerNote +
          (r.autoBackupPath ? `\n\n导入前已自动备份当前数据到：\n${r.autoBackupPath}\n（导入后如有问题可凭此文件回滚）` : ''),
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
  } catch (error) {
    // 同 doExport：没有 catch 时抛错会静默消失在未处理 rejection 里
    ElMessage.error((error && error.message) || '导入失败')
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
function copyDbPath() {
  if (dbPath.value) navigator.clipboard.writeText(dbPath.value)
}
loadDbInfo()
</script>

<style scoped>
.settings-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.theme-row {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  flex-wrap: wrap;
}
.theme-hint {
  font-size: 12.5px;
  color: var(--text-3);
  line-height: 1.6;
  max-width: 420px;
  padding-top: 4px;
}
.theme-sys-now {
  color: var(--text-2);
}

.color-theme-label {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-1);
  padding-top: 4px;
}
.color-swatches {
  display: flex;
  gap: 12px;
  align-items: center;
}
.color-swatch {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  cursor: pointer;
  position: relative;
  border: 3px solid transparent;
  transition: border-color 0.2s var(--ease-out), transform 0.2s var(--ease-out), box-shadow 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.color-swatch:hover {
  transform: scale(1.1);
  box-shadow: var(--sh-sm);
}
.color-swatch.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft), var(--sh-sm);
}
.swatch-fill {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  clip-path: polygon(0 0, 100% 0, 0 100%);
}
.swatch-signal {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  clip-path: polygon(100% 0, 100% 100%, 0 100%);
}
.swatch-check {
  position: relative;
  z-index: 1;
  font-size: 16px;
  font-weight: 700;
  /* 深色对勾 + 白晕：深色/浅色 swatch 上都可辨认（白字在浅底上 1:1 不达标） */
  color: var(--ink-1);
  text-shadow: 0 0 2px #fff, 0 0 2px #fff;
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
  color: var(--accent);
  margin: 4px 0 12px;
}

.param-field {
  background: var(--card-2);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px 12px;
}

.param-label {
  font-size: 12px;
  color: var(--text-3);
  margin-bottom: 8px;
}

.param-static {
  font-size: 13px;
  color: var(--text-3);
  line-height: 32px;
}

.param-note {
  font-size: 11.5px;
  color: var(--text-3);
  margin: -4px 0 10px;
}

.actions {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px dashed var(--line);
  display: flex;
  gap: 10px;
}

.settings-note {
  margin-top: 16px;
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.8;
  background: var(--line-2);
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
  border: 1.5px solid var(--line);
  border-radius: 10px;
  padding: 12px 14px;
  cursor: pointer;
  transition: all 0.2s;
  background: var(--card);
}
.scenario-card:hover {
  border-color: var(--accent);
  box-shadow: 0 4px 14px var(--accent-shadow);
}
.scenario-card.active {
  border-color: var(--accent);
  background: linear-gradient(135deg, var(--accent-glass), var(--accent-glass-strong));
  box-shadow: 0 4px 14px var(--accent-shadow);
}
.scenario-name {
  font-size: 14px;
  font-weight: 700;
  color: var(--accent);
}
.scenario-desc {
  font-size: 11.5px;
  color: var(--text-3);
  margin: 4px 0 8px;
  line-height: 1.5;
}
.scenario-tags {
  display: flex;
  gap: 6px;
}
.scenario-note {
  font-size: 11.5px;
  color: var(--text-3);
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
  color: var(--text-3);
  line-height: 1.6;
}
.backup-steps {
  margin-top: 18px;
  background: var(--line-2);
  border-radius: 10px;
  padding: 12px 14px;
}
.backup-steps-title {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--accent);
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
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
/* 深色下 --accent 提亮成文字色，步骤号实心底 + 白字必须压回深蓝 */
html[data-theme="dark"] .step-num { background: #1c6bd4; }
.step-txt {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.step-txt b {
  font-size: 12.5px;
  color: var(--text-1);
}
.step-txt span {
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.5;
}
.backup-meta {
  margin-top: 16px;
  font-size: 12px;
  color: var(--text-3);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  background: var(--card-2);
  border: 1px solid var(--line-2);
  border-radius: 8px;
  padding: 8px 12px;
}
.backup-meta code {
  background: var(--line-2);
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 11px;
  word-break: break-all;
}
</style>
