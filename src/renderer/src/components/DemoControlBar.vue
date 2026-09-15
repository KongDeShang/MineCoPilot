<template>
  <div class="demo-bar">
    <div class="demo-bar-progress">
      <el-progress
        :percentage="pct"
        :stroke-width="6"
        :show-text="false"
        :color="'#0BB4C4'"
      />
    </div>
    <div class="demo-bar-info">
      <span class="demo-bar-name">{{ routeName }}</span>
      <span class="demo-bar-step">{{ step }} / {{ total }}</span>
      <span v-if="paused" class="demo-bar-paused">已暂停</span>
      <span v-else-if="playing" class="demo-bar-auto">自动演示中</span>
    </div>
    <div class="demo-bar-btns">
      <el-tooltip content="上一步" placement="top">
        <el-button size="small" circle @click="api.prev()"><el-icon><ArrowLeft /></el-icon></el-button>
      </el-tooltip>
      <el-tooltip :content="paused ? '继续自动演示' : '暂停自动演示'" placement="top">
        <el-button
          size="small"
          :type="paused ? 'success' : 'primary'"
          circle
          :aria-label="paused ? '继续' : '暂停'"
          @click="api.togglePause()"
        >
          <el-icon><component :is="paused ? 'VideoPlay' : 'VideoPause'" /></el-icon>
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
</script>

<style scoped>
.demo-bar {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 100000;
  width: 320px;
  background: rgba(255, 255, 255, 0.97);
  border: 1px solid rgba(11, 58, 130, 0.16);
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
  color: #e6a23c;
  font-weight: 600;
}
.demo-bar-auto {
  color: var(--accent);
  font-weight: 600;
}
.demo-bar-btns {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
</style>
