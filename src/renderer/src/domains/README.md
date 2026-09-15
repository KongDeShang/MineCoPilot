# 域化架构规范

每个业务域是一个自包含目录，声明自己的一切：数据、页面、动作、命令、能力。

## 目录结构

```
domains/<name>/
  domain.js        域声明 + 注册（必须）
  routes.js        页面路由（必须）
  commands.js      命令面板命令（Task 12 实现后生效）
  capabilities.js  AI 能力声明（narrate/diagnose/summarize/asr/ocr/parse）
  views/           本域页面（可选，迁移后从 views/ 搬入）
```

## 域声明格式

```js
// domain.js
import { registerDomain } from '../registry'
import { routes } from './routes'
import { commands } from './commands'
import { capabilities } from './capabilities'

registerDomain({
  id: 'settings',          // 唯一标识
  name: '系统设置',         // 侧边栏显示名
  group: '系统',            // 所属菜单分组
  icon: 'Setting',         // Element Plus 图标名
  route: '/settings',      // 主路由路径
  component: () => import('../../views/Settings.vue'), // 页面组件（懒加载）
  routes,                  // 路由条目数组
  commands,                // 命令声明数组
  capabilities             // 能力声明数组
})
```

## 注册中心

`registry.js` 提供：
- `registerDomain(def)` — 注册一个域
- `getMenus()` — 返回完整的侧边栏菜单结构（5 组 15 项）
- `getRoutes()` — 返回完整的路由表
- `getCommands()` — 返回所有域的命令列表

## 渐进迁移

当前只有 settings 域完成迁移。其余 14 个页面保持硬编码过渡，
后续逐个迁入 domains/ 目录。迁移时：
1. 在 `views/` 下新建域目录
2. 声明路由/命令/能力
3. 从 registry 的硬编码区移到域声明
4. 跑 `npm run verify` 确认无回归