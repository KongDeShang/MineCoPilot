<template>
  <div class="lock-screen">
    <!-- 背景纯 CSS，刻意不用照片（设计稿原图是远程 URL，铁律①零联网）—— 见 styles/lockTheme.css -->
    <div class="lock-stage" aria-hidden="true" />

    <main class="lock-wrap">
      <section class="lock-card" :aria-label="ariaLabel">
        <!-- 品牌区：BrandMark 与侧栏、exe、标签页是同一份造型，
             这里只是把它放进设计稿那颗金底圆角方块里 -->
        <div class="lock-brand">
          <div class="lock-mark"><BrandMark :size="22" /></div>
          <div class="lock-brand-txt">
            <div class="lock-title">矿山智工</div>
            <div class="lock-sub">{{ subtitle }}</div>
          </div>
        </div>

        <slot />
      </section>
    </main>
  </div>
</template>

<script setup>
/**
 * 锁屏外壳：背景 + 毛玻璃卡片 + 品牌区。
 *
 * ── 为什么拆出来 ────────────────────────────────────────────────────────────
 * 「解锁」（LockScreen）与「首启设置 PIN」（LockSetup）是两个不同的界面，
 * 但必须是同一张脸 —— 同一台机器上前后脚出现，长得不一样会让人以为是两个软件。
 * 视觉语言（配色、圆角、间距、卡片）全在 styles/lockTheme.css 里，
 * 这个组件只负责把它组装起来，业务逻辑一概没有。
 *
 * ── 它为什么只依赖 BrandMark ────────────────────────────────────────────────
 * 它跑在**主应用之外**：Element Plus 全量注册、全局图标白名单、store、路由，
 * 这时候都还不存在（见 main.js 的启动判锁）。所以外壳里不能出现任何 el-* 组件，
 * 否则"锁着启动正常、不锁启动异常"这类只在一条路上复现的毛病就有了入口。
 * 两个使用者（LockScreen / LockSetup）遵守同一条：只用原生 input/button。
 */
// 视觉语言在这里 import 一次，两个使用者就都拿到了 —— 见 styles/lockTheme.css 头部说明
import '../styles/lockTheme.css'
import BrandMark from './BrandMark.vue'

defineProps({
  /** 副标题。两个界面各说各的侧重点，所以不写死 */
  subtitle: { type: String, default: '工程机械运维 AI 工作台' },
  /** 卡片的无障碍名称（读屏软件念的那一句） */
  ariaLabel: { type: String, default: '身份验证' }
})
</script>
