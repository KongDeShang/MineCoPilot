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
    chunkSizeWarningLimit: 1500
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
