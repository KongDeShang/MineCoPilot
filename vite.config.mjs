import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { readFileSync } from 'fs'

const projectRoot = fileURLToPath(new URL('.', import.meta.url))

const SQLJS_WASM = resolve(projectRoot, 'node_modules/sql.js/dist/sql-wasm.wasm')

/**
 * sql.js 的 wasm 二进制不会被 Vite 自动打包/服务：
 *   - 开发模式：需要把它作为一个静态资源提供出来
 *   - 生产构建：需要把它复制到 dist/assets 下，并让运行时按实际文件名定位
 * 这里统一处理，避免"数据库功能在开发或打包后失效"。
 */
function sqlJsWasm() {
  return {
    name: 'sqljs-wasm',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith('/sql-wasm.wasm')) return next()
        res.setHeader('Content-Type', 'application/wasm')
        res.setHeader('Cache-Control', 'no-cache')
        res.end(readFileSync(SQLJS_WASM))
      })
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'assets/sql-wasm.wasm',
        source: readFileSync(SQLJS_WASM)
      })
    }
  }
}

export default defineConfig({
  plugins: [vue(), sqlJsWasm()],
  root: 'src/renderer',
  base: './',
  // 把包内实际路径暴露给运行时代码（database.js 用它定位 wasm 与元数据文件）
  define: {
    __SQLJS_WASM_URL__: JSON.stringify('./assets/sql-wasm.wasm')
  },
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    // 阈值回到默认量级，让"包又大了"这件事重新可见。
    // 之前设成 1500 是为了让 1789 KB 的主 chunk 不再告警 —— 那是把体温计调低，
    // 不是退烧。图标白名单 + 懒加载两项优化做完后，主 chunk 应低于该阈值。
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        /**
         * 把长期不变的第三方拆成独立 chunk。
         *
         * 目的有二：
         *   1) 业务代码改动时第三方 chunk 的 hash 不变，热更新只需重新下载业务代码；
         *   2) 让"谁把包撑大了"一眼可见 —— 现在全挤在 index 里看不出来。
         *
         * 只列真正静态引入且体积大的库。pdfjs 已改为按需 dynamic import
         * （见 stores/documentDomain.js），xlsx 走 ExcelImportPanel 的异步组件，
         * 两者都不该再出现在这里。
         *
         * ⚠️ 必须是**函数**形式。这里原来写的是对象形式（`{ 'vendor-vue': [...] }`），
         * Rollup 认、Rolldown 不认：Vite 8 底层是 Rolldown，两种形式的差别不是
         * "拆不拆 chunk"，而是**构建会不会直接崩**。
         *
         * 对象形式在只有一个 chunk 时只是打一条 `Invalid type: Expected Function`
         * 的警告，看起来像"配置被忽略了"（本文件早先的注释就是这么写的，判断错了）。
         * 一旦代码里出现第一个真正的动态 import、产生了第二个 chunk，Rolldown
         * 就会拿它当函数调用：
         *     TypeError: manualChunks is not a function
         * 构建直接失败，而且失败点跟引发它的那次 import 看起来毫无关系。
         *
         * 所以这段配置此前一直是"没炸的哑弹"，谁加第一个 dynamic import 谁踩。
         * 函数形式在两种打包器下都成立，保留原有分组意图不变。
         */
        manualChunks(id) {
          // 先统一成正斜杠再切分：Windows 下 id 是 `D:\…\node_modules\vue\dist\…`，
          // 直接 split('node_modules') 得到的是 `\vue\dist\…`，开头的反斜杠会让下面
          // 每条正则都匹配不上，于是所有模块都落到默认 chunk —— 配置看着在跑，
          // 实际什么都没拆。
          const rest = id.replace(/\\/g, '/').split('node_modules/')[1]
          if (!rest) return
          // vue 本体只是个再导出壳，真正的实现在 @vue/* 下，两者必须同组
          if (/^(@vue|vue-router|pinia|vue)\//.test(rest)) return 'vendor-vue'
          if (/^(@element-plus|element-plus)\//.test(rest)) return 'vendor-element'
          if (/^sql\.js\//.test(rest)) return 'vendor-sqljs'
          // echarts 由 components/TrendChart.vue 异步引入，本来就会单独成块；
          // 显式命名只是为了让它在产物列表里一眼认得出
          if (/^(echarts|vue-echarts|zrender)\//.test(rest)) return 'vendor-echarts'
        }
      }
    }
  },
  server: {
    port: 5173,
    watch: {
      // 编辑器保存时会在源码目录写入原子替换用的临时目录/文件，
      // Windows 下 chokidar 监视它们会抛 EBUSY 并让 dev server 直接退出，这里显式忽略。
      ignored: [
        '**/.*.tmpdir/**',
        '**/*.tmp',
        '**/node_modules/**',
        '**/dist/**',
        '**/release/**'
      ]
    }
  },
  resolve: {
    alias: {
      '@': resolve(projectRoot, 'src/renderer/src')
    }
  }
})
