<template>
  <div class="landing">
    <!-- 背景粒子效果 -->
    <div class="bg-particles">
      <div v-for="i in 20" :key="i" class="particle" :style="particleStyle(i)"></div>
    </div>

    <!-- 主内容 -->
    <div class="landing-content">
      <!-- 标题区：宽屏左右分栏（文案在左、设备实拍在右），
           窄屏再堆叠回居中。整块原先只有文字，1100px 宽度里右侧空着一半。 -->
      <div class="hero-section">
        <div class="hero-copy">
          <div class="logo-big">
            <el-icon :size="64" color="var(--signal-bright)"><Monitor /></el-icon>
          </div>
          <h1 class="main-title">矿山智工</h1>
          <p class="sub-title">工程机械运维 AI 工作台</p>
          <div class="tagline">
            <el-tag effect="dark" class="tag-pill">本地优先</el-tag>
            <el-tag effect="dark" class="tag-pill">离线可用</el-tag>
            <el-tag effect="dark" class="tag-pill">数据不出设备</el-tag>
          </div>
        </div>
        <div class="hero-visual">
          <img :src="heroPhoto" alt="矿用挖掘机" />
        </div>
      </div>

      <!-- 老王的故事 -->
      <div class="story-section">
        <h2 class="story-title">
          <el-icon><User /></el-icon>
          老王的故事
        </h2>
        <p class="story-subtitle">某矿山设备运维工程师，管理 50 台挖掘机和装载机</p>

        <!-- 痛点卡片 -->
        <div class="pain-cards">
          <div class="pain-card" v-for="(pain, index) in pains" :key="index" :class="`pain-${index}`">
            <div class="pain-icon">
              <el-icon :size="32"><component :is="pain.icon" /></el-icon>
            </div>
            <div class="pain-content">
              <h3>{{ pain.title }}</h3>
              <p class="pain-desc">{{ pain.desc }}</p>
              <div class="pain-metric">
                <span class="metric-value">{{ pain.value }}</span>
                <span class="metric-unit">{{ pain.unit }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 损失高亮 -->
        <div class="loss-highlight">
          <div class="loss-icon">
            <el-icon :size="36"><WarningFilled /></el-icon>
          </div>
          <div class="loss-text">
            <p>去年漏了一台挖掘机的液压油更换</p>
            <p class="loss-number">停机 3 天，损失 <span>¥400,000</span></p>
          </div>
        </div>
      </div>

      <!-- 解决方案对比 -->
      <div class="solution-section">
        <h2 class="solution-title">
          <el-icon><MagicStick /></el-icon>
          矿山智工如何解决？
        </h2>

        <div class="compare-grid">
          <div class="compare-item" v-for="(item, index) in solutions" :key="index">
            <div class="compare-index">{{ `0${index + 1}` }}</div>
            <div class="compare-before">
              <div class="compare-label">
                <el-icon><CircleCloseFilled /></el-icon>以前
              </div>
              <p>{{ item.before }}</p>
            </div>
            <div class="compare-arrow">
              <el-icon :size="24"><Right /></el-icon>
            </div>
            <div class="compare-after">
              <div class="compare-label">
                <el-icon><CircleCheckFilled /></el-icon>现在
              </div>
              <p>{{ item.after }}</p>
            </div>
          </div>
        </div>
      </div>

      <!-- CTA -->
      <div class="cta-section">
        <el-button type="primary" size="large" round @click="enterApp">
          <el-icon><Right /></el-icon>
          开始体验
        </el-button>
        <p class="cta-hint">点击进入工作台，体验离线 AI 运维</p>
      </div>

      <!-- 底部数据 -->
      <div class="bottom-stats">
        <div class="stat-item">
          <div class="stat-num">900万+</div>
          <div class="stat-text">中国工程机械保有量</div>
        </div>
        <div class="stat-item">
          <div class="stat-num">5000亿+</div>
          <div class="stat-text">后市场规模/年</div>
        </div>
        <div class="stat-item">
          <div class="stat-num">50万+</div>
          <div class="stat-text">目标用户</div>
        </div>
      </div>
    </div>

    <!-- 底部固定 CTA -->
    <div class="sticky-cta">
      <el-button type="primary" size="large" round @click="enterApp">
        <el-icon><Right /></el-icon>
        开始体验
      </el-button>
    </div>
  </div>
</template>

<script setup>
import { useRouter } from 'vue-router'
import { equipmentPhoto } from '../utils/equipmentPhoto'

const router = useRouter()

// 首屏右侧的设备实拍取本地已有图（离线可用，不引任何外部资源）
const heroPhoto = equipmentPhoto('挖掘机')

// icon 存的是 Element Plus 图标组件名（main.js 已全量注册），
// 模板里用 <component :is> 渲染 —— 原先存的是 emoji 字符。
const pains = [
  {
    icon: 'Files',
    title: '多部门 Excel 混乱',
    desc: '生产部、维修部、安全部各发一份表格，格式不统一，字段冲突',
    value: '5',
    unit: '个部门，5种格式'
  },
  {
    icon: 'Cpu',
    title: '维保靠人脑记忆',
    desc: '200 台设备的保养周期、历史故障、配件更换全凭经验',
    value: '200+',
    unit: '台设备靠人脑记'
  },
  {
    icon: 'EditPen',
    title: '纸笔记录二次录入',
    desc: '现场巡检只能手写，回办公室再花 2 小时录系统',
    value: '2h',
    unit: '每天重复录入'
  },
  {
    icon: 'Lock',
    title: '工业数据不能上云',
    desc: '设备参数、产量数据、故障记录属于商业机密和安全数据',
    value: '0',
    unit: '公有云可信赖'
  }
]

const solutions = [
  {
    before: '5 个部门发来 5 种格式的 Excel，手动对齐要半天',
    after: '拖入文件，自动识别表头、智能合并，1 分钟搞定'
  },
  {
    before: '200 台设备保养周期全靠脑子记，漏了就是停机',
    after: '系统自动计算到期日，提前提醒，0 遗漏'
  },
  {
    before: '现场巡检纸笔记录，回办公室再录 2 小时',
    after: '语音说一句自动转工单，拍张照自动识别'
  },
  {
    before: '想用 AI 辅助？数据必须上传公有云',
    after: '本地离线推理，数据不出设备，安全无忧'
  }
]

function particleStyle(i) {
  const size = Math.random() * 4 + 2
  return {
    width: `${size}px`,
    height: `${size}px`,
    left: `${Math.random() * 100}%`,
    top: `${Math.random() * 100}%`,
    animationDelay: `${Math.random() * 5}s`,
    animationDuration: `${Math.random() * 10 + 5}s`
  }
}

function enterApp() {
  localStorage.setItem('hasSeenLanding', 'true')
  router.push('/dashboard')
}
</script>

<style scoped>
.landing {
  min-height: 100vh;
  background: var(--grad-landing);
  color: var(--on-dark-1);
  overflow-y: auto;
  position: relative;
}

/* 背景粒子 */
.bg-particles {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
}

.particle {
  position: absolute;
  background: rgba(11, 180, 196, 0.3);
  border-radius: 50%;
  animation: float linear infinite;
}

@keyframes float {
  0% { transform: translateY(0) translateX(0); opacity: 0; }
  10% { opacity: 1; }
  90% { opacity: 1; }
  100% { transform: translateY(-100vh) translateX(50px); opacity: 0; }
}

/* 主内容 */
.landing-content {
  position: relative;
  z-index: 1;
  max-width: 1100px;
  margin: 0 auto;
  /* 底部留白要盖过固定 CTA（按钮 + 上下 padding 约 78px），
     原先只有 30px —— 底部"900万+/5000亿/50万+"那排数据被压在按钮底下。 */
  padding: 40px 24px 104px;
}

/* 标题区：宽屏左右分栏，文案在左、设备实拍在右 */
.hero-section {
  display: flex;
  align-items: center;
  gap: 48px;
  margin-bottom: 44px;
}

.hero-copy {
  flex: 1 1 0;
  min-width: 0;
}

.hero-visual {
  flex: 1 1 0;
  min-width: 0;
}

.hero-visual img {
  display: block;
  width: 100%;
  height: 268px;
  object-fit: cover;
  border-radius: 16px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  /* 照片压深色渐变上，给一点投影让高光边缘不"飘" */
  box-shadow: 0 18px 40px rgba(3, 12, 30, 0.55);
}

.logo-big {
  margin-bottom: 16px;
  animation: pulse-glow 3s ease-in-out infinite;
}

@keyframes pulse-glow {
  0%, 100% { filter: drop-shadow(0 0 8px rgba(11, 180, 196, 0.4)); }
  50% { filter: drop-shadow(0 0 20px rgba(11, 180, 196, 0.8)); }
}

.main-title {
  font-size: 44px;
  font-weight: 800;
  letter-spacing: 8px;
  margin: 0 0 6px;
  background: var(--grad-hero);
  background-size: 200% 200%;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: gradient-shift 4s ease infinite;
}

@keyframes gradient-shift {
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}

.sub-title {
  font-size: 20px;
  color: var(--on-dark-3);
  margin: 0 0 20px;
  letter-spacing: 4px;
}

.tagline {
  display: flex;
  justify-content: flex-start;
  gap: 12px;
}

/* 三个标签原本是 success / warning / danger 三色 —— 但"本地优先 / 离线可用 /
   数据不出设备"是三条正面声明，用琥珀和红色说出来等于给自己贴了个警告条。
   改成同一套品牌标记样式（跟侧栏 logo 同款：信号青淡底 + 细边 + 亮青字）。 */
.tagline :deep(.el-tag.tag-pill) {
  height: 26px;
  padding: 0 12px;
  font-weight: 500;
  background: rgba(11, 180, 196, 0.14);
  border-color: rgba(11, 180, 196, 0.42);
  color: var(--signal-bright);
}

/* 老王的故事 */
.story-section {
  margin-bottom: 36px;
}

.story-title {
  font-size: 24px;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 4px;
  color: var(--amber-on-dark);
}

.story-subtitle {
  color: var(--on-dark-3);
  margin: 0 0 32px;
  font-size: 15px;
}

/* 痛点卡片 */
.pain-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-bottom: 28px;
}

.pain-card {
  display: flex;
  gap: 14px;
  padding: 18px;
  border-radius: 12px;
  /* 面板底色用"压暗"而不是"提亮"（原来是 rgba(255,255,255,0.04)）。
     --on-dark-* / --danger-on-dark 这套令牌是按**深底**标定的（注释里记的
     4.6~12.0:1 都是对 #061530 一族算的），可白色叠加层把面板实际抬到了 #153261，
     文字落到 3.85~4.49:1 全线不达标。深色叠加层把面板压回令牌的标定区间，
     一个改动同时解决 .pain-content h3 / .pain-desc / .metric-unit 三类。 */
  background: rgba(3, 12, 30, 0.45);
  border: 1px solid rgba(255, 255, 255, 0.08);
  transition: all 0.3s;
}

.pain-card:hover {
  /* 悬停仍是"提亮一档"，只是方向改在深底这一侧：0.45 → 0.30 就是变浅 */
  background: rgba(3, 12, 30, 0.3);
  border-color: rgba(11, 180, 196, 0.3);
  transform: translateY(-2px);
}

.pain-icon {
  flex-shrink: 0;
  /* 图标与标题、数字同色，三者读成一个"痛点"信号 */
  color: var(--danger-on-dark);
}

.pain-content h3 {
  font-size: 16px;
  margin: 0 0 6px;
  color: var(--danger-on-dark);
}

.pain-desc {
  font-size: 13px;
  color: var(--on-dark-3);
  margin: 0 0 10px;
  line-height: 1.5;
}

.pain-metric {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.metric-value {
  font-size: 28px;
  font-weight: 800;
  color: var(--danger-on-dark);
}

.metric-unit {
  font-size: 13px;
  color: var(--on-dark-3);
}

/* 损失高亮 */
.loss-highlight {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 18px 24px;
  border-radius: 12px;
  background: linear-gradient(135deg, rgba(232, 111, 109, 0.15), rgba(232, 182, 79, 0.1));
  border: 1px solid rgba(232, 111, 109, 0.3);
  animation: pulse-border 2s ease-in-out infinite;
}

@keyframes pulse-border {
  0%, 100% { border-color: rgba(232, 111, 109, 0.3); }
  50% { border-color: rgba(232, 111, 109, 0.6); }
}

.loss-icon {
  flex-shrink: 0;
  display: flex;
  color: var(--danger-on-dark);
}

.loss-text p {
  margin: 0;
  font-size: 15px;
  color: var(--on-dark-1);
}

.loss-number {
  font-size: 18px !important;
  margin-top: 4px !important;
}

.loss-number span {
  font-size: 28px;
  font-weight: 800;
  color: var(--danger-on-dark);
}

/* 解决方案 */
.solution-section {
  margin-bottom: 36px;
}

.solution-title {
  font-size: 24px;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 28px;
  color: var(--emerald-on-dark);
}

.compare-grid {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.compare-item {
  display: grid;
  /* 首列是序号：四行内容本是同一个"以前→现在"的句式，加个 01–04
     让它读成一串序列（与上方痛点卡片一一对应），而不是四张一样的卡 */
  grid-template-columns: auto 1fr 40px 1fr;
  align-items: center;
  gap: 12px;
  padding: 14px 20px;
  border-radius: 10px;
  /* 同 .pain-card：白叠层换成压暗层。这行是"以前/现在"的底座，
     再叠 10% 的红/绿仍然远高于 4.5:1（.compare-label 实测 3.85 → 5.0 左右）。 */
  background: rgba(3, 12, 30, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.compare-index {
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 1px;
  font-variant-numeric: tabular-nums;
  color: var(--on-dark-3);
}

.compare-before, .compare-after {
  padding: 12px 16px;
  border-radius: 8px;
}

.compare-before {
  background: rgba(232, 111, 109, 0.1);
  border: 1px solid rgba(232, 111, 109, 0.2);
}

.compare-after {
  background: rgba(77, 182, 141, 0.1);
  border: 1px solid rgba(77, 182, 141, 0.2);
}

.compare-label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 700;
  margin-bottom: 6px;
}

.compare-before .compare-label { color: var(--danger-on-dark); }
.compare-after .compare-label { color: var(--emerald-on-dark); }

.compare-before p, .compare-after p {
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
  color: var(--on-dark-2);
}

.compare-arrow {
  text-align: center;
  color: var(--signal);
}

/* CTA */
.cta-section {
  text-align: center;
  margin-bottom: 36px;
}

.cta-section .el-button {
  font-size: 18px;
  padding: 16px 48px;
}

.cta-hint {
  margin: 12px 0 0;
  font-size: 13px;
  color: var(--on-dark-3);
}

/* 底部数据 */
.bottom-stats {
  display: flex;
  justify-content: center;
  gap: 60px;
  padding: 32px 0;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.stat-item {
  text-align: center;
}

.stat-num {
  font-size: 32px;
  font-weight: 800;
  color: var(--signal);
}

.stat-text {
  font-size: 13px;
  color: var(--on-dark-3);
  margin-top: 4px;
}

/* 底部固定 CTA */
.sticky-cta {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 10;
  display: flex;
  justify-content: center;
  padding: 16px 24px;
  background: linear-gradient(transparent, rgba(7, 27, 61, 0.95) 30%);
}

.sticky-cta .el-button {
  font-size: 16px;
  padding: 12px 40px;
  box-shadow: 0 4px 20px rgba(11, 180, 196, 0.4);
}

/* 响应式
   注意：这里原先写的 .comparison-grid / .market-stats 两个类在模板里不存在，
   三个 *-section 的 padding 也压在没设置 padding 的元素上 —— 四条规则全是空转的，
   窄屏下对比区仍是 1fr 40px 1fr 三列，正文被挤成一列字。类名已对齐实际模板。 */
/* 中等宽度以下分栏会挤成一团，收回居中堆叠 */
@media (max-width: 900px) {
  .hero-section {
    flex-direction: column;
    gap: 28px;
    text-align: center;
  }
  .hero-visual {
    width: 100%;
  }
  .hero-visual img {
    height: 200px;
  }
  .tagline {
    justify-content: center;
  }
}

@media (max-width: 768px) {
  .pain-cards {
    grid-template-columns: 1fr;
  }
  .compare-item {
    grid-template-columns: 1fr;
  }
  /* 竖排后箭头要转向，否则 40px 的空列会横在"以前"和"现在"中间 */
  .compare-arrow {
    transform: rotate(90deg);
  }
  .bottom-stats {
    flex-direction: column;
    gap: 20px;
  }
  .main-title {
    font-size: 34px;
    letter-spacing: 4px;
  }
  .landing-content {
    padding: 32px 20px 104px;
  }
}
</style>
