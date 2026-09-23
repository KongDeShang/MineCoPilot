# 域化架构规范

每个业务域是一个自包含目录，声明自己的一切：**数据、页面、路由**。

> ⚠️ 2026-09-17 修订：本文原先还写着"命令、能力"，并给出 `commands.js` / `capabilities.js`
> 两个文件与 `getCommands()` / `getCapabilities()` 两个 accessor —— 但它们**没有任何调用方**
> （命令面板是未开工的任务 12，能力灰度从未实现），域声明里那两个字段也无人读取。
> 已于该日删除。**判据是：声明的接口没有消费方就不算完成，只算占位。**
> 真要做命令面板或能力灰度时，由那个任务把 accessor + 消费方**一起**加回来，
> 不要先加声明。

## 目录结构

```
domains/<name>/
  domain.js        域声明 + 注册（必须）
  routes.js        页面路由（必须）
  views/           本域页面（可选，迁移后从 views/ 搬入）
```

## 域声明格式

只写注册中心**真的会读**的字段：`getMenus()` 读 `id/name/group/icon/route`，
`getRoutes()` 读 `routes`。

```js
// domain.js
import { registerDomain } from '../registry'
import { routes } from './routes'

registerDomain({
  id: 'settings',     // 唯一标识
  name: '系统设置',    // 侧边栏显示名
  group: '系统',       // 所属菜单分组
  icon: 'Setting',    // Element Plus 图标名
  route: '/settings', // 主路由路径
  routes              // 路由条目数组（组件在这里按需 import）
})
```

父级不需要单独的 `component` 字段：路由条目自己带 `component: () => import(...)`。

## 注册中心

`registry.js` 提供：
- `registerDomain(def)` — 注册一个域
- `getMenus()` — 返回完整的侧边栏菜单结构（5 组 15 项）
- `getRoutes()` — 返回完整的路由表（含兜底路由）

## 渐进迁移

当前只有 settings 域完成迁移。其余 14 个页面保持硬编码过渡，
后续逐个迁入 domains/ 目录。迁移时：
1. 声明路由，并从 registry 的硬编码区（`LEGACY_MENUS` / `LEGACY_ROUTES`）移除对应条目
2. 跑 `npm run verify` 确认无回归（菜单与路由都有断言守着）

## 这个骨架目前**没有**做的事（别误读）

- 没有命令注册表（任务 12）
- 没有能力分级/入口灰度（任务 06 的能力声明只在「本地模型」页显示为文字角标，不参与任何分支）
- 15 个页面里只迁了 1 个，`LEGACY_ROUTES` 仍是主路由表
- 跨域联动没有走事件/服务钩子，仍是 store 里直接调用（例如工单完成 → 备件扣减）
