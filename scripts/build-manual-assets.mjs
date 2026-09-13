/**
 * 矿山智工 - 随包手册资源生成
 *
 * 从《资料/》（gitignore 的本地资料目录）里把 bundledDocs.js 列出的那几份 PDF
 * 抽成"可随包 + 可问答"的两份产物：
 *   src/renderer/public/manuals/<slug>.pdf   原件，打开原文用
 *   src/renderer/public/manuals/<slug>.json  逐页文字层，问答检索用（出处 = 文件名 + 页码）
 *
 * 为什么要预抽而不是运行时抽：
 *   首次启动时在渲染进程里解析 30~200 页 PDF 要十几秒，用户看到的是"手册库卡住了"。
 *   抽一次、随包发，装完打开就是可检索状态。
 *
 * 用法：node scripts/build-manual-assets.mjs  （需要本机有《资料/》目录）
 *
 * 说明：项目是 CommonJS，而清单是渲染层的 ESM，所以先把清单镜像成 .mjs 再导入，
 * 与 self-check.mjs 的做法一致——跑的是同一份清单，不是复制品。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const srcDir = join(root, 'src', 'renderer', 'src', 'utils')
const publicDir = join(root, 'src', 'renderer', 'public', 'manuals')
const materialDir = join(root, '资料')

// ---- 镜像清单（ESM）后导入 ----
const mirrorDir = join(root, '.tmp-manual-assets')
rmSync(mirrorDir, { recursive: true, force: true })
mkdirSync(mirrorDir, { recursive: true })
writeFileSync(
  join(mirrorDir, 'bundledDocs.mjs'),
  readFileSync(join(srcDir, 'bundledDocs.js'), 'utf8')
    .replace(/(from\s+['"]\.\/[a-zA-Z0-9_-]+)(['"])/g, '$1.mjs$2'),
  'utf8'
)
const { BUNDLED_DOCS } = await import(`file://${mirrorDir}/bundledDocs.mjs`)

if (!existsSync(materialDir)) {
  console.error(`找不到资料目录：${materialDir}`)
  console.error('随包手册需要本机有《资料/》（gitignore 的本地资料目录）才能生成。')
  process.exitCode = 1
} else {
  mkdirSync(publicDir, { recursive: true })
  const rows = []
  for (const doc of BUNDLED_DOCS) {
    const source = join(materialDir, doc.src)
    if (!existsSync(source)) {
      rows.push({ slug: doc.slug, ok: false, note: `资料目录里没有 ${doc.src}` })
      continue
    }
    /**
     * data 必须是**副本**：pdfjs 会把它的 ArrayBuffer 转移（transfer）给 worker，
     * 转移之后原视图的 byteLength 变成 0——直接拿它写文件会写出一个 0 字节的 PDF。
     * 所以副本交给 pdfjs，raw（readFileSync 的 Buffer）留着写盘。
     * pdfjs 6.x 里 destroy() 也挂在 loadingTask 上，文档对象自身没有这个方法。
     */
    const raw = readFileSync(source)
    const task = getDocument({ data: new Uint8Array(raw), useSystemFonts: true })
    const pdf = await task.promise
    const chunks = []
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p)
      const content = await page.getTextContent()
      const text = (content.items || [])
        .map(it => (it && typeof it.str === 'string' ? it.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (text) chunks.push({ page: p, text })
    }
    const pages = pdf.numPages
    await task.destroy()

    // 原件原样拷进随包目录；文字层另存一份 JSON
    writeFileSync(join(publicDir, `${doc.slug}.pdf`), raw)
    writeFileSync(
      join(publicDir, `${doc.slug}.json`),
      JSON.stringify({ slug: doc.slug, title: doc.title, pages, chunks }),
      'utf8'
    )
    rows.push({
      slug: doc.slug,
      ok: true,
      pages,
      withText: chunks.length,
      chars: chunks.reduce((n, c) => n + c.text.length, 0)
    })
  }
  console.log('随包手册资源：')
  for (const r of rows) {
    console.log(r.ok
      ? `  ✓ ${r.slug.padEnd(18)} ${String(r.pages).padStart(3)} 页，有文字层 ${String(r.withText).padStart(3)} 页，${r.chars} 字符`
      : `  ✗ ${r.slug.padEnd(18)} ${r.note}`)
  }
  console.log(`\n输出目录：${publicDir}`)
  rmSync(mirrorDir, { recursive: true, force: true })
  if (rows.some(r => !r.ok)) process.exitCode = 1
}
