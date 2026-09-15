# 任务 03：安全加固（CSP + IPC sender 校验 + openPath 收敛）

## 背景

核查发现三个安全短板：

1. **无 CSP**：`src/renderer/index.html`（仅 13 行）没有 `Content-Security-Policy` meta；`src/main/index.js` 也未通过 `onHeadersReceived` 注入 CSP 头。渲染层有用户可写内容（知识库/工单描述/文档文本），一旦出现任何 XSS，可调用 preload 暴露的全部能力。
2. **IPC 无来源校验**：`src/main/index.js` 的 `registerIpc()` 里所有 `ipcMain.handle` 均未校验 `event.senderFrame`/`event.sender` 是否来自可信页面。破坏性能力如 `db:clear`（清空数据库）、`docs:delete`（删文件）、`app:openPath`（打开任意路径）都可被任何注入的脚本调用。
3. **openPath 无边界**：`app:openPath` IPC 直接 `shell.openPath(p)` 接受任意路径，而 `docs:open` 已有正确的边界校验函数 `resolveInDocs()`（`path.resolve` + 前缀比对，防止 `..` 穿越和兄弟目录前缀误判）——`app:openPath` 应复用同样的边界。

安全现状（做得好的，不要破坏）：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、preload 只暴露白名单方法不透传 `ipcRenderer`、`setWindowOpenHandler` 返回 deny 并转系统浏览器。

## 目标

1. 渲染层加载内容受 CSP 约束（`default-src 'self'` 级别），即使出现注入也无法外联/执行内联脚本（按项目实际情况放行必要来源）。
2. 所有 `ipcMain.handle` 校验调用来源，非可信页面直接拒绝。
3. `app:openPath` 与 `docs:open` 同样限制在 documents/ 目录内。

## 改动清单

| 文件 | 动作 | 说明 |
|------|------|------|
| `src/main/index.js` | 新增 CSP 注入 + sender 校验 + openPath 收敛 | 见实现要点 |
| `src/renderer/index.html` | 可加 meta CSP 兜底（与主进程头双保险） | 注意 Electron file:// 下 meta CSP 行为 |
| `src/preload/index.js` | 评估暴露面，注释说明 | 白名单本身不变，除非有新增/删减 |

## 实现要点

- **CSP**：优先在 `mainWindow.webContents.session.webRequest.onHeadersReceived` 注入 `Content-Security-Policy`：
  - 生产（`app.isPackaged`，加载 `file://`）：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'`（按实际资源类型微调；项目有 `sql-wasm.wasm` 需 `script-src 'wasm-unsafe-eval'` 或按 wasm 加载方式放行，`connect-src` 需放行开发模式的 `ws:`/`http://localhost:5173`）。
  - 开发（`http://localhost:5173`）：放行 Vite HMR 所需（`ws:`、`http:` localhost、内联脚本），可仅在生产生效严格策略。
  - 注意：不要用 `unsafe-eval` 除非必要；项目用 vite 生产构建为预编译 bundle，不需要 eval。
- **sender 校验**：在 `registerIpc()` 内定义 `const assertTrusted = (event) => { const url = event.senderFrame?.url || event.sender.getURL(); const ok = app.isPackaged ? url.startsWith('file://') : url.startsWith('http://localhost:5173'); if (!ok) throw new Error('拒绝来自不可信来源的 IPC 调用'); }`，并在每个 handler 第一行调用（或封装统一包装函数）。
- **openPath 收敛**：`app:openPath` 改为复用 `resolveInDocs()`——只允许打开 documents/ 目录内文件（与 `docs:open` 同一边界），非该目录返回 `{ ok:false, error:'拒绝打开资料库之外的文件' }`。
- **回归确认**：检查渲染层哪些地方调用了 `app.openPath`（全局搜 `openPath`），确认收敛后正常功能（如打开手册原文）仍走 `docs:open`，不受影响。

## 验收标准

1. 生产构建启动后，抓包/DevTools 确认响应头含 CSP；
2. 手工验证：`docs:open` 打开 documents/ 内文件正常；调用 `app:openPath` 传 documents/ 外路径被拒；
3. 自检脚本可加断言（可选）：在 `scripts/self-check.mjs` 加一条"IPC 边界函数存在且拒绝越界路径"（参照现有 resolveInDocs 相关断言风格）；
4. `npm run lint` 0 错；`npm run self-check` 288 条通过（含新增）；
5. `npm run e2e` 全过（确认 CSP 没有误伤页面正常加载，尤其 pdfjs/wasm/sql.js）。

## 注意

- 铁律：不加任何外部 CDN 依赖；CSP 不要放开到 `*`。
- 开发模式 HMR 需要的内联/ws 放行与生产严格策略分开，别混在一个策略里。
- 若 e2e 或 dev 模式因 CSP 起不来，优先调整放行清单而不是删掉 CSP。
