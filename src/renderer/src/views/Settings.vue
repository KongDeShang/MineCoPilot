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

    <!-- ===== 应用锁（本机界面锁） ===== -->
    <el-card shadow="never" style="margin-bottom: 16px">
      <template #header>
        <div class="card-header">
          <span><el-icon><Lock /></el-icon> 应用锁（本机界面锁）</span>
          <el-tag size="small" :type="lockOn ? 'success' : 'info'" effect="plain">
            {{ lockOn ? '已启用 · 每次启动要求 PIN' : '未启用' }}
          </el-tag>
        </div>
      </template>

      <!-- 已启用的账户 -->
      <template v-if="lockOn">
        <div v-if="actorLabel" class="lock-current">
          本次运行已以 <b>{{ actorLabel }}</b> 的身份进入。
        </div>
        <div class="lock-list">
          <div v-for="a in accounts" :key="a.id" class="lock-item">
            <div class="lock-item-main">
              <span class="lock-item-name">{{ a.name }}</span>
              <span v-if="a.role" class="lock-item-role">{{ a.role }}</span>
            </div>
            <el-button link type="danger" size="small" @click="doRemoveAccount(a)">删除</el-button>
          </div>
        </div>

        <!-- 空闲自动锁（P4-2）。演示友好是硬要求：必须能关掉，也必须能一眼看出当前是什么状态 -->
        <div class="lock-idle">
          <span class="lock-idle-label">空闲自动锁</span>
          <el-select v-model="idleMinutes" size="small" style="width: 118px" @change="doSetIdle">
            <el-option :value="0" label="关闭" />
            <el-option :value="1" label="1 分钟" />
            <el-option :value="5" label="5 分钟" />
            <el-option :value="10" label="10 分钟" />
            <el-option :value="15" label="15 分钟" />
            <el-option :value="30" label="30 分钟" />
          </el-select>
          <span class="lock-idle-note" :class="{ 'is-off': idleMinutes === 0 }">{{ idleText }}</span>
        </div>
      </template>

      <!-- 新增账户表单：未启用时是"启用"，已启用时是"再加一个" -->
      <div v-if="showForm" class="lock-form">
        <el-input v-model="lockForm.name" maxlength="12" placeholder="姓名（例如：王建国）" style="width: 200px" />
        <el-input v-model="lockForm.role" maxlength="16" placeholder="角色（例如：维修工程师，可留空）" style="width: 260px" />
        <el-input v-model="lockForm.pin" type="password" maxlength="6" inputmode="numeric" placeholder="PIN（4~6 位数字）" style="width: 170px" />
        <el-input v-model="lockForm.pin2" type="password" maxlength="6" inputmode="numeric" placeholder="再输一次 PIN" style="width: 170px" />
        <el-button type="primary" :loading="lockBusy" @click="doCreateAccount">
          {{ lockOn ? '添加账户' : '启用应用锁' }}
        </el-button>
        <el-button v-if="lockOn" @click="clearLockForm">取消</el-button>
      </div>

      <div class="lock-actions">
        <el-button v-if="lockOn && !showForm" size="small" @click="adding = true">再加一个账户</el-button>
        <el-button v-if="lockOn" size="small" type="danger" plain @click="doDisableLock">停用应用锁</el-button>
      </div>

      <div class="lock-hint">
        启用后每次启动都要选身份、输 PIN；锁屏页提供「忘记 PIN？清空本机数据并解锁」的自救入口。
        多个账户用同一套界面，各自有各自的 PIN；<b>角色只作标识</b>（界面显示 + 操作日志），<b>不做权限拦截</b>。
        <b>上台演示前，建议把「空闲自动锁」改成关闭或调长</b> —— 讲解到一半当场弹回锁屏是最尴尬的一种失败。
      </div>
      <div class="lock-honest">
        <el-icon><WarningFilled /></el-icon>
        如实说明：这是一把<b>界面锁，不是文件加密</b>——本机的数据库文件仍可被 SQLite 工具直接打开；
        锁的配置也只存在本机浏览器存储里，清掉它就绕过了锁。它防的是「旁人随手翻看 / 误操作」，不是技术人员。
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

    <!-- ===== 恢复到出厂设置 =====
         排在「数据备份与迁移」之后：想留数据的人，上面那张卡就是退路，
         顺序上先给退路再给不可撤销的那一个。关于本软件仍是最末一张（它不是设置项）。 -->
    <el-card shadow="never" style="margin-top: 16px">
      <template #header>
        <div class="card-header">
          <span><el-icon><Delete /></el-icon> 恢复到出厂设置</span>
          <el-tag size="small" type="danger" effect="plain">不可撤销</el-tag>
        </div>
      </template>

      <div class="factory-note">
        <el-icon><WarningFilled /></el-icon>
        <span>把本机恢复到<b>刚装好、还没用过</b>的样子，连同本机数据库里的全部业务数据一起清除：设备台账、维保记录、工单、健康快照、知识库、文档资料、操作日志、聊天记录，以及{{ factoryScopeSummary }}。完成后应用会自动重启，重新生成一套演示数据，并回到首次使用时的「设置应用锁」那一屏。</span>
      </div>
      <div class="factory-note">
        <el-icon><InfoFilled /></el-icon>
        <span>两处如实说明：随包的<b>本地模型</b>与示例手册不会被删除（它们属于安装内容，不是你的数据）；这一步本身<b>不留操作日志</b> —— 日志就存在要被清掉的那个库里。锁屏上的「清空本机数据并解锁」是另一件事：那个只清数据、保留你的界面偏好。</span>
      </div>

      <div class="factory-row">
        <el-button type="danger" plain :loading="factoryBusy" @click="doFactoryReset">
          <el-icon style="margin-right: 4px"><Delete /></el-icon>恢复到出厂设置
        </el-button>
        <div class="backup-desc">要保留数据，请先用上面那张卡「一键导出备份」—— 这一步做完，本机数据无法找回</div>
      </div>
    </el-card>

    <!-- ===== 关于本软件（开发者署名与版权） =====
         放在最后一张卡：它不是设置项，改不了任何东西，摆在"数据备份"之后
         才不打断前面那几张真正能调的卡片。 -->
    <el-card shadow="never" style="margin-top: 16px">
      <template #header>
        <div class="card-header">
          <span><el-icon><InfoFilled /></el-icon> 关于本软件</span>
          <el-tag size="small" type="info" effect="plain">开发者署名 · 版权声明</el-tag>
        </div>
      </template>

      <div class="about-grid">
        <div class="about-row"><span class="about-k">软件名称</span><span class="about-v">矿山智工 · 设备健康智能体</span></div>
        <div class="about-row"><span class="about-k">当前版本</span><span class="about-v">v{{ appVersion }}</span></div>
        <div class="about-row"><span class="about-k">开发者</span><span class="about-v">孔德尚</span></div>
        <div class="about-row"><span class="about-k">所在单位</span><span class="about-v">石家庄铁道大学</span></div>
        <div class="about-row"><span class="about-k">运行方式</span><span class="about-v">全离线 · 不联网、不调用任何云端大模型 API，数据不出本机</span></div>
        <div class="about-row"><span class="about-k">许可</span><span class="about-v">专有许可 · 保留所有权利（全文见随包的 LICENSE）</span></div>
      </div>

      <div class="about-copy">
        版权所有 © 2026 石家庄铁道大学 孔德尚 · 保留所有权利。<br>
        未经著作权人事先书面许可，不得复制、修改、分发本软件或其任何部分，亦不得用于商业目的。
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAppStore } from '../stores/appStore'
import { DAILY_OUTPUT_LOSS, PRESET_SCENARIOS } from '../utils/health'
import { exportBackup, importBackup, isElectron } from '../utils/backup'
import { masterEnabled, setMasterEnabled } from '../utils/masterPersona'
import { getTroubleshootMaps, saveTroubleshootMap, resetTroubleshootMaps } from '../utils/troubleshootMaps'
import { applyPref, readMirror, readColorMirror, applyColor, saveColorMirror, watchSystem, THEME_PREF_META_KEY, COLOR_THEMES } from '../utils/theme'
import {
  createAccount, currentActorLabel, disableLock, getIdleMinutes, listAccounts, lockEnabled,
  removeAccount, setIdleMinutes
} from '../utils/appLock'
import * as db from '../utils/database'
// 恢复到出厂设置。清单（FACTORY_RESET_SCOPE）与确认框文案同源，都在那个模块里 ——
// 卡片上**不要**再抄一份清理项枚举，那就成了第二个会漂的真相源。
import { factoryReset, factoryResetSummary } from '../utils/factoryReset'

/**
 * 「关于」卡片里的版本号。与 App.vue 侧栏底部**同一个来源** —— vite define 注入的
 * 构建期常量（vite.config.mjs 里取自 package.json 的 version）。
 *
 * 这里一个版本字面量都不许写。self-check 的字面量扫描只覆盖 App.vue，
 * 但规矩是全局的：一旦哪一处手写死，改版本号时就会漏掉那一处，
 * 于是出现"关于页写着 1.1.0、安装包名却是 1.2.0"—— 这种不一致
 * 恰恰是答辩现场一眼能看见的。非构建环境退回 'dev'，不假装知道版本。
 */
const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'

const store = useAppStore()
const saving = ref(false)
const exporting = ref(false)
const importing = ref(false)
const dbPath = ref('')
const dbSize = ref('')

// ---------- 恢复到出厂设置 ----------
const factoryBusy = ref(false)
/** 确认框里那句枚举与 utils/factoryReset.js 的清单同源，卡片上也用它（别再抄一份） */
const factoryScopeSummary = factoryResetSummary()

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
  // 导入前的自动备份只在 Electron 下发生（浏览器模式没法静默写盘），
  // 所以这句提示按运行环境分叉 —— 不能让浏览器里的用户去 backups 目录找一个不存在的文件。
  const autoHint = isElectron()
    ? '导入前会自动备份当前数据到本机 backups 目录。'
    : '（浏览器模式下无法自动备份，需要留底请先自行导出一次。）'
  try {
    await ElMessageBox.confirm(
      `导入将覆盖当前全部本地数据（设备台账、维保、工单、快照、知识库、文档资料、设置、聊天记录）。${autoHint}是否继续？`,
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

      /**
       * 上面那句"文档资料均已替换为备份内容"曾是一句无条件的话，而文档恢复
       * 其实是这段流程里最容易半途失败的一步（要清空 documents/ 再写回，
       * 而 Windows 上正被阅读器占用的 PDF 删不掉）。失败时界面说"已替换"，
       * 手册库里却留着旧文件 —— 于是按实际结果分三种说法。
       */
      const doc = r.docRestore || { ok: true }
      // 这里不能用 Markdown 的 ** 强调：ElMessageBox.alert 收的是纯文本
      // （没开 dangerouslyUseHTMLString），星号会原样显示出来。
      const docNote = !doc.ok
        ? `\n\n⚠️ 但文档资料（手册库文件）没能恢复：${doc.error}\n数据主体已恢复；手册可在「手册资料库」页重新添加。`
        : (doc.warning ? `\n\n⚠️ 文档资料已写回，但${doc.warning}\n这些旧文件可能仍出现在手册库里，请到「手册资料库」页确认。` : '')
      const docClaim = doc.ok
        ? (doc.warning ? '文档资料已尽量替换为备份内容（见下方说明）' : '文档资料')
        : ''

      ElMessageBox.alert(
        `备份恢复成功，界面已同步刷新。设备台账、维保记录、工单、健康快照、知识库、${docClaim}、设置与聊天记录均已替换为备份内容。` +
          ledgerNote +
          docNote +
          (r.autoBackupPath ? `\n\n导入前已自动备份当前数据到：\n${r.autoBackupPath}\n（导入后如有问题可凭此文件回滚）` : ''),
        docNote ? '导入完成（有需注意项）' : '导入完成',
        { confirmButtonText: '知道了', type: docNote ? 'warning' : 'success' }
      )
      store.addLog({
        content: `导入数据备份${r.exportedAt ? `（导出于 ${r.exportedAt.slice(0, 10)}）` : ''}`,
        source: '设置',
        type: 'success',
        tagType: 'success'
      })
    } else if (r && r.canceled) {
      /* 用户自己按的取消：不该再弹一个框告诉他"失败了" */
    } else {
      /**
       * 失败要说话，也要留痕。
       *
       * 这里原来只弹一条 ElMessage 就完了，**不写操作日志** —— 于是导入失败
       * 在库里的痕迹为零：现场事后翻日志只能看到"什么时候导过"，看不到
       * "导失败了、为什么"。而这个弹窗几秒后就消失，是现场唯一一次提示。
       * 凡是走到这个 else 的都是真失败，一律留一条 danger 日志（会落库）。
       */
      const msg = (r && r.error) || '导入失败'
      ElMessage.error(msg)
      store.addLog({ content: `导入备份失败：${msg}`, source: '设置', type: 'danger', tagType: 'danger' })
    }
  } catch (error) {
    // 同 doExport：没有 catch 时抛错会静默消失在未处理 rejection 里
    ElMessage.error((error && error.message) || '导入失败')
  } finally {
    importing.value = false
  }
}

// ---------- 应用锁（本机界面锁 + 身份，P4-1） ----------
/**
 * 这一块只管**账户**：启用 / 停用 / 加删。
 *
 * 「启动时判锁」不在这个页面 —— 它在 main.js，发生在 store 装载之前，
 * 所以这里改完账户**不需要**重载界面：锁在下次启动时才生效。
 * 这一点要在界面上说清楚（下面的提示文案），否则用户会以为"点了启用没反应"。
 */
const lockOn = ref(lockEnabled())
const accounts = ref(listAccounts())
// 身份文案直接取共享实现（appLock.currentActorLabel）——侧边栏那行与
// 每条操作日志的 actor 用的是同一个函数，三处不会各写各的。
const actorLabel = ref(currentActorLabel())
const adding = ref(false)
const lockBusy = ref(false)
const lockForm = reactive({ name: '', role: '', pin: '', pin2: '' })
// 未启用时表单就是"启用"的入口；已启用时默认收起，点「再加一个账户」才展开
const showForm = computed(() => !lockOn.value || adding.value)

/**
 * 空闲自动锁（P4-2）。这里选的时长**当次就生效**：main.js 的计时器每 15 秒
 * 重新读一次阈值，所以调长/关掉不用重启 —— "改完要重启才生效"在演示前
 * 临时调整的那一刻最气人。
 *
 * 但要如实说清一个限定：**计时器本身只在启动装载时安装一次**（installIdleLock）。
 * 于是在"本次运行里刚启用应用锁"这一种情况下，要到下次启动才有计时器 ——
 * 这和整个应用锁"锁在下次启动才生效"的口径是一致的，卡片上的提示文案也是这么写的。
 */
const idleMinutes = ref(getIdleMinutes())
const idleText = computed(() =>
  idleMinutes.value === 0
    ? '不自动锁 —— 只在启动时要求 PIN'
    : `闲置 ${idleMinutes.value} 分钟就回锁屏，要重新输 PIN`
)

async function doSetIdle(value) {
  const r = setIdleMinutes(value)
  if (!r.ok) {
    ElMessage.error(r.error)
    idleMinutes.value = getIdleMinutes()
    return
  }
  // 回读一次：万一日后被夹取，界面显示的必须是真正落盘的那个值
  idleMinutes.value = getIdleMinutes()
  store.addLog({
    level: idleMinutes.value === 0 ? 'warning' : 'info',
    module: '应用锁',
    message: idleMinutes.value === 0 ? '关闭了空闲自动锁' : `空闲自动锁设为 ${idleMinutes.value} 分钟`
  })
  ElMessage.success(idleMinutes.value === 0 ? '已关闭空闲自动锁' : `空闲 ${idleMinutes.value} 分钟后自动锁屏`)
}

function refreshLock() {
  lockOn.value = lockEnabled()
  accounts.value = listAccounts()
  actorLabel.value = currentActorLabel()
  idleMinutes.value = getIdleMinutes()
}

function clearLockForm() {
  adding.value = false
  lockForm.name = ''
  lockForm.role = ''
  lockForm.pin = ''
  lockForm.pin2 = ''
}

async function doCreateAccount() {
  if (lockBusy.value) return
  // "两次输入一致"只有界面能判（appLock 拿不到第二个输入框）；
  // 姓名 / 角色的合法性交给 createAccount 统一判，免得两处规则各写一份。
  if (lockForm.pin !== lockForm.pin2) {
    ElMessage.error('两次输入的 PIN 不一致')
    return
  }
  const wasOn = lockOn.value
  lockBusy.value = true
  try {
    const r = await createAccount({ name: lockForm.name, role: lockForm.role, pin: lockForm.pin })
    if (!r.ok) {
      ElMessage.error(r.error)
      return
    }
    const who = r.account.role ? `${r.account.name} · ${r.account.role}` : r.account.name
    refreshLock()
    clearLockForm()
    ElMessage.success(wasOn
      ? `已添加账户「${who}」`
      : `应用锁已启用：下次启动需要用「${who}」的 PIN 解锁`)
    store.addLog({
      content: `${wasOn ? '添加应用锁账户' : '启用应用锁'}：${who}`,
      source: '设置',
      type: 'success',
      tagType: 'success'
    })
  } catch (error) {
    ElMessage.error((error && error.message) || '启用失败')
  } finally {
    lockBusy.value = false
  }
}

async function doRemoveAccount(a) {
  // 删掉最后一个账户 = 锁没了：这件事的说法必须变，不能还叫"删除账户"
  const last = accounts.value.length <= 1
  try {
    await ElMessageBox.confirm(
      last
        ? `「${a.name}」是本机最后一个账户，删除它等于停用应用锁：此后启动不再要求输入 PIN。是否继续？`
        : `删除账户「${a.name}」？该账户将无法再用于解锁，其它账户不受影响。`,
      last ? '停用应用锁' : '删除账户',
      { type: 'warning', confirmButtonText: last ? '确认停用' : '确认删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const before = currentActorLabel()
  removeAccount(a.id)
  refreshLock()
  ElMessage.success(last ? '应用锁已停用' : `已删除账户「${a.name}」`)
  store.addLog({
    content: `${last ? '停用应用锁（删除最后一个账户）' : '删除应用锁账户'}：${a.name}`,
    source: '设置',
    type: 'warning',
    tagType: 'warning'
  })
  reloadIfIdentityChanged(before)
}

/**
 * 删掉/停用之后，**身份真的变了**（停用，或删掉的正是当前这条身份）就得整页重载一次。
 *
 * 为什么非重载不可：侧边栏底部那行身份是**启动时读一次**的（App.vue 里读
 * currentActorLabel()）。不重载它会继续显示一个已经不存在的身份，而此后每条操作
 * 日志的 actor 已经变成空串 —— "界面上写着王建国、日志里却是未署名"，
 * 这正是 P4-3 要防的那件事。设置页卡片会当场刷新，侧边栏不会，两者还会互相矛盾。
 *
 * 为什么选重载而不是把身份做成响应式：整个应用锁走的都是"重载即重算"这一条路
 * （空闲自动锁到点也是 lockNow() + location.reload()，见 main.js），
 * 多引一套订阅机制只为同步一行文字不划算，而且重载不会漏掉任何一处副本。
 *
 * 删的是**别人**时身份没变，这里什么都不做 —— 为一次无关的删除重载整页太粗暴。
 */
function reloadIfIdentityChanged(before) {
  if (currentActorLabel() === before) return
  // 留 800ms 让上面那条成功提示先露个面，否则用户只看到"闪了一下"。
  setTimeout(() => location.reload(), 800)
}

async function doDisableLock() {
  try {
    await ElMessageBox.confirm(
      '停用后本机不再保留任何账户，每次启动都不再要求输入 PIN。已配置的账户与 PIN 会被清除（设备台账等业务数据不受影响）。',
      '停用应用锁',
      { type: 'warning', confirmButtonText: '确认停用', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const before = currentActorLabel()
  disableLock()
  refreshLock()
  ElMessage.success('应用锁已停用')
  store.addLog({
    content: '停用应用锁',
    source: '设置',
    type: 'warning',
    tagType: 'warning'
  })
  reloadIfIdentityChanged(before)
}

/**
 * 恢复到出厂设置。
 *
 * 与上面几个危险操作有三处不同，都是这个功能固有的：
 *   ① 确认框那句话**由清单渲染出来**（factoryResetSummary），不手写 ——
 *      手写就有"文案少写一项、实际多清一项"的空间，而这个操作不可撤销。
 *   ② 成功提示是"正在重启"：清完之后**必须重载**才落到首启那一屏
 *      （锁判据、身份、主题都是启动时读一次的）。走的是本文件既有的
 *      「重载即重算」那条路（见 reloadIfIdentityChanged 上面那段注释），
 *      留 800ms 让提示露个面。
 *   ③ **不写操作日志**：日志存在被清掉的那个库里，写了也会被自己删掉。
 *      这是这个功能的固有性质，不假装留痕 —— 如实写在卡片说明里。
 */
async function doFactoryReset() {
  if (factoryBusy.value) return
  try {
    await ElMessageBox.confirm(
      `将把本机恢复到刚装好的状态：清空本机数据库里的全部业务数据，并清除${factoryScopeSummary}。此操作不可撤销，本机数据无法找回。`,
      '恢复到出厂设置',
      { type: 'warning', confirmButtonText: '确认恢复到出厂设置', cancelButtonText: '取消' }
    )
  } catch {
    return // 用户按了取消：什么都不做（不是失败）
  }
  factoryBusy.value = true
  try {
    const r = await factoryReset()
    if (!r.ok) {
      ElMessage.error(r.error || '恢复出厂设置失败')
      return
    }
    /**
     * 两类"没清掉"要分开说，别笼统地都叫"未能清除"：
     *   · `r.failed` = 主进程真的没删掉（文件被占用等）—— 这是失败，得用告警色。
     *   · `r.idbFailed` = IndexedDB 那边**有连接正在使用**，删除请求被挡住。
     *     这种在浏览器里是 pending 而不是失败：页面一换（下面的 reload）连接就没了，
     *     请求随即完成。把它写成"未能清除"，用户会在明明成功的时候看到一句吓人的话。
     */
    const 真失败 = r.failed || []
    const 待重启清完 = r.idbFailed || []
    if (真失败.length) {
      ElMessage.warning(`已恢复出厂设置，但有 ${真失败.length} 项未能清除：${真失败.join('；')}`)
    } else if (待重启清完.length) {
      ElMessage.success(`已恢复到出厂设置，正在重启…（另有 ${待重启清完.length} 项缓存要等重启后才清完）`)
    } else {
      ElMessage.success('已恢复到出厂设置，正在重启…')
    }
    setTimeout(() => location.reload(), 800)
  } finally {
    factoryBusy.value = false
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
  color: var(--ink);
  text-shadow: 0 0 2px #fff, 0 0 2px #fff;
}

/* ---------- 应用锁卡片 ---------- */

.lock-current {
  font-size: 13px;
  color: var(--text-2);
  margin-bottom: 10px;
}

.lock-current b {
  color: var(--text-1);
}

.lock-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

.lock-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 10px;
  background: var(--card-2);
  border: 1px solid var(--line);
  border-radius: 8px;
}

/* min-width:0 让姓名过长时先压缩自己，而不是把「删除」挤出这一行 */
.lock-item-main {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.lock-item-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lock-item-role {
  font-size: 12px;
  color: var(--text-3);
  flex-shrink: 0;
}

.lock-form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 2px 0 12px;
}

.lock-idle {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.lock-idle-label {
  font-size: 13px;
  color: var(--text-2);
}

.lock-idle-note {
  font-size: 12px;
  color: var(--text-3);
}

/* 关掉时给个提示色：演示前专门来关它的人，不该看漏自己有没有关成功 */
.lock-idle-note.is-off {
  color: var(--warn-ink);
}

.lock-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.lock-hint {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.7;
  margin-bottom: 10px;
}

/* 如实说明那条：给个底色，让人一眼看出这是"边界声明"而不是又一段功能说明。
   .factory-note 是出厂重置卡上的同类说明块（"不可撤销" / "模型与示例手册不删"），
   与它共用一套外观 —— 同一种语气不该长出两种样子。 */
.lock-honest,
.factory-note {
  padding: 8px 10px;
  background: var(--card-2);
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.7;
}

/* 两张说明块之间留一点缝：紧贴着读起来会当成同一段 */
.factory-note + .factory-note {
  margin-top: 8px;
}

/*
 * 图标走 inline + vertical-align，**不要**把这一块做成 flex：
 * 段子里有行内 <b>（"界面锁，不是文件加密"），一旦父级是 flex，
 * 每个文本节点和 <b> 都会各自变成一个 flex 项，句子被拆成几段并排，
 * 实测渲染成"这是一 把 / 界面锁，不是文件加 密"这种夹着空隙的碎片。
 */
.lock-honest .el-icon,
.factory-note .el-icon {
  margin-right: 4px;
  vertical-align: -2px;
  color: var(--danger-ink);
}

/* 出厂重置卡里的按钮 + 一句退路提示。块级上下排，不是 flex —— 说明文字要能整段换行 */
.factory-row {
  margin-top: 14px;
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

/* 「关于」卡片（开发者署名与版权）。
   颜色一律走 tokens.css 已有的 --text-1/2/3 —— 那三档是照对比度定的
   （白底 18.5 / 8.8 / 6.0:1），这里另发明一个色值就会让 audit:contrast
   审 /settings 时红掉。字号取 13px（与页面其它正文同档），
   版权那句略小一点、用 --text-3，读得清但不是主角。 */
.about-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.about-row {
  display: flex;
  gap: 12px;
  font-size: 13px;
  line-height: 1.6;
}

.about-k {
  flex: none;
  width: 76px;
  color: var(--text-3);
}

.about-v {
  color: var(--text-2);
}

.about-copy {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--line-2);
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-3);
}
</style>
