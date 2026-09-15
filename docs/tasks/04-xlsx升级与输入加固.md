# 任务 04：xlsx 依赖升级（CVE 修复）或输入加固

## 背景

- `package.json` 依赖 `"xlsx": "^0.18.5"`（SheetJS CE）。
- 该 npm 版本存在**已公开安全漏洞**：
  - `CVE-2023-30533`：原型污染（prototype pollution，< 0.19.3）；
  - `CVE-2024-22362` / `CVE-2024-22363`：ReDoS（正则拒绝服务）。
- 应用用其解析**用户上传的 Excel 文件**（`src/renderer/src/utils/excelParser.js` + `src/renderer/src/components/ExcelImportPanel.vue`）——"不受信输入进解析器"是标准攻击面；恶意构造的 xlsx 可能污染对象原型或卡死主线程。
- 注意：SheetJS CE 在 npm 上 0.18.5 之后不再发布（官方转到自己的 CDN 分发），npm registry 上 0.19+/0.20+ 都是被第三方占名的**恶意包**，不能 `npm i xlsx@0.20` 直接升。

## 目标

消除解析用户文件的已知漏洞面。**两条路线二选一**（按可行性优先推荐路线 A）：

- **路线 A（推荐）**：升级到官方 SheetJS CE 0.20.x（官方 CDN tarball），保留全部解析能力；
- **路线 B（保守）**：保持 0.18.5，但在 `excelParser.js` 解析入口做输入加固（文件大小上限、行列数上限、禁用公式计算、限制单元格数量），并记录已知 CVE 作为接受风险。

## 改动清单（路线 A）

| 文件 | 动作 | 说明 |
|------|------|------|
| `package.json` | 更换依赖来源 | `"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"`（固定版本，勿用 `^`） |
| `package-lock.json` | `npm install` 更新 | 用 `npm install --save-exact` 锁版本 |
| `src/renderer/src/utils/excelParser.js` | 兼容性检查 | 0.20.x API 与 0.18.5 基本兼容（`XLSX.read`/`sheet_to_json`），跑通即可，如有弃用 API 按官方迁移说明改 |
| `src/renderer/src/components/ExcelImportPanel.vue` | 回归验证 | 上传样例文件正常解析 |

## 实现要点

- 官方安装方式：`npm i https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`。若网络受限，可下载 tarball 后本地安装，**不要**从 `registry.npmjs.org` 装任何 `xlsx@0.19+`（npm 上的新版均为冒名恶意包）。
- 若选择路线 B：在 `excelParser.js` 入口加：文件大小 ≤ 10MB；Sheet 数 ≤ 20；每表行数 ≤ 5000、列数 ≤ 100；`read` 时 `cellFormula: false`（不解析公式）；超限直接返回结构化错误（沿用 `{ ok:false, error }` 风格），并在 README 已知边界记录"xlsx 0.18.5 存在 CVE-2023-30533 / CVE-2024-22362/22363，已输入加固缓释"。

## 验收标准

1. `npm ls xlsx` 显示目标版本（A：0.20.3，来源为 cdn.sheetjs.com；B：0.18.5 + 加固代码）；
2. 用仓库 `资料/` 或自带样例 Excel 走一遍导入：多 Sheet 合并、字段对齐、入库正常（`npm run self-check` 中 Excel 相关断言通过）；
3. 构造超限文件（如 20MB 假 xlsx / 超列数文件），确认被拒绝且不崩溃、不卡死；
4. `npm run lint` 0 错；`npm run e2e` 全过（含导入路径）。

## 注意

- 离线铁律：解析仍是纯本地（SheetJS 是纯 JS）；升级只改依赖来源，不改架构。
- 若采用路线 A 且 cdn.sheetjs.com 不可达，向用户说明并回退路线 B 继续。
