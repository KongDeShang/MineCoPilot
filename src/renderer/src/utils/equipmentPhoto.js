// 设备类别 → 本地照片映射（离线可用，随安装包内置）
// 照片为统一风格徐工涂装工程机械图（AI 生成，无版权问题）
//
// ⚠️ 路径必须是**相对页面**的，不能写成根绝对路径 `/equipment-photos/…`。
//    开发态页面是 http://localhost:5173/，`/equipment-photos/x.jpg` 解析到 5173 下，一切正常；
//    打包版是 `mainWindow.loadFile(dist/index.html)`（src/main/index.js:486），页面 URL 是 file://，
//    同一串按 URL 规范解析成 **file:///D:/equipment-photos/x.jpg** —— 盘符根目录，
//    于是安装包里 8 张设备照片全是碎图，而开发态/e2e（走的都是 5173）一条断言都看不见。
//    实测（临时探针 node_modules/.probe/url-form.mjs，file:// 页面 + 与应用一致的 CSP）：
//      `/equipment-photos/excavator.jpg`  → file:///D:/equipment-photos/excavator.jpg，解码宽 0
//      `./equipment-photos/excavator.jpg` → <dist>/equipment-photos/excavator.jpg，解码宽 1365
//    vite 的 base 是 './'（见 vite.config.mjs），产物里的静态资源也都是相对路径，
//    所以相对写法在开发与打包两种加载方式下都成立。
const PHOTO_DIR = './equipment-photos/'

const PHOTO_MAP = {
  '挖掘机': PHOTO_DIR + 'excavator.jpg',
  '矿卡': PHOTO_DIR + 'mining-truck.jpg',
  '钻机': PHOTO_DIR + 'drill-rig.jpg',
  '装载机': PHOTO_DIR + 'loader.jpg',
  '破碎机': PHOTO_DIR + 'crusher.jpg',
  '压路机': PHOTO_DIR + 'roller.jpg',
  '平地机': PHOTO_DIR + 'grader.jpg',
  '推土机': PHOTO_DIR + 'bulldozer.jpg'
}

const DEFAULT_PHOTO = PHOTO_DIR + 'excavator.jpg'

/** 按设备类别取照片；未知类别回退默认图 */
export function equipmentPhoto(category) {
  if (!category) return DEFAULT_PHOTO
  return PHOTO_MAP[category] || DEFAULT_PHOTO
}
