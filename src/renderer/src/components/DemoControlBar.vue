<template>
  <div class="demo-bar">
    <div class="demo-bar-progress">
      <el-progress
        :percentage="pct"
        :stroke-width="6"
        :show-text="false"
        :color="'var(--signal)'"
      />
    </div>
    <div class="demo-bar-info">
      <span class="demo-bar-name">{{ routeName }}</span>
      <span class="demo-bar-step">{{ step }} / {{ total }}</span>
      <span v-if="paused" class="demo-bar-paused">已暂停</span>
      <span v-else-if="playing" class="demo-bar-auto">自动演示中</span>
      <span v-else class="demo-bar-manual">手动推进</span>
    </div>
    <div class="demo-bar-btns">
      <el-tooltip content="上一步" placement="top">
        <el-button size="small" circle @click="api.prev()"><el-icon><ArrowLeft /></el-icon></el-button>
      </el-tooltip>
      <!-- 一颗按钮两种角色：手动模式下是「开始自动」，自动模式下才是暂停/继续。
           默认是手动（首启演示就是手动），而 togglePause 只翻 paused、不把 playing
           置真 —— 照原样显示"暂停自动演示"的话，手动模式下按下去什么都不会发生。 -->
      <el-tooltip :content="playBtnTip" placement="top">
        <el-button
          size="small"
          :type="paused ? 'success' : 'primary'"
          circle
          :aria-label="playBtnTip"
          @click="onPlayPause()"
        >
          <el-icon><component :is="paused || !playing ? 'VideoPlay' : 'VideoPause'" /></el-icon>
        </el-button>
      </el-tooltip>
      <el-tooltip content="下一步" placement="top">
        <el-button size="small" circle @click="api.next()"><el-icon><ArrowRight /></el-icon></el-button>
      </el-tooltip>
      <el-tooltip content="重来（回到第一步）" placement="top">
        <el-button size="small" circle @click="api.reset()"><el-icon><RefreshLeft /></el-icon></el-button>
      </el-tooltip>
      <el-tooltip content="退出演示" placement="top">
        <el-button
          size="small"
          type="danger"
          plain
          circle
          aria-label="退出"
          @click="api.destroy(); emit('close')"
        >
          <el-icon><CircleClose /></el-icon>
        </el-button>
      </el-tooltip>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { ArrowLeft, ArrowRight, RefreshLeft, CircleClose } from '@element-plus/icons-vue'

const props = defineProps({
  api: { type: Object, required: true },
  routeName: { type: String, default: '' },
  step: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  paused: { type: Boolean, default: false },
  playing: { type: Boolean, default: true }
})
const emit = defineEmits(['close'])

const pct = computed(() => (props.total ? Math.round((props.step / props.total) * 100) : 0))

/** 这颗按钮此刻是"开始自动""继续"还是"暂停" */
const playBtnTip = computed(() => {
  if (!props.playing) return '开始自动演示'
  return props.paused ? '继续自动演示' : '暂停自动演示'
})

function onPlayPause() {
  // 手动模式：切到自动；自动模式：暂停/继续
  if (!props.playing) props.api.startAuto()
  else props.api.togglePause()
}
</script>

<style scoped>
.demo-bar {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 100000;
  width: 320px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: 0 8px 28px rgba(10, 19, 38, 0.22);
  padding: 10px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  backdrop-filter: blur(4px);
}
.demo-bar-progress {
  width: 100%;
}
.demo-bar-info {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.demo-bar-name {
  font-weight: 600;
  color: var(--text-1);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.demo-bar-step {
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.demo-bar-paused {
  color: var(--warn-ink);
  font-weight: 600;
}
.demo-bar-auto {
  color: var(--accent);
  font-weight: 600;
}
/* 手动模式（默认）：不喊"自动"，也不喊"暂停"—— 它没在跑，是等人点 */
.demo-bar-manual {
  color: var(--text-3);
  font-weight: 600;
}
.demo-bar-btns {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
</style>
