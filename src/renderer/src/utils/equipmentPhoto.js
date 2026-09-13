// 设备类别 → 本地照片映射（离线可用，随安装包内置）
// 照片为统一风格徐工涂装工程机械图（AI 生成，无版权问题）
const PHOTO_MAP = {
  '挖掘机': '/equipment-photos/excavator.jpg',
  '矿卡': '/equipment-photos/mining-truck.jpg',
  '钻机': '/equipment-photos/drill-rig.jpg',
  '装载机': '/equipment-photos/loader.jpg',
  '破碎机': '/equipment-photos/crusher.jpg',
  '压路机': '/equipment-photos/roller.jpg',
  '平地机': '/equipment-photos/grader.jpg',
  '推土机': '/equipment-photos/bulldozer.jpg'
}

const DEFAULT_PHOTO = '/equipment-photos/excavator.jpg'

/** 按设备类别取照片；未知类别回退默认图 */
export function equipmentPhoto(category) {
  if (!category) return DEFAULT_PHOTO
  return PHOTO_MAP[category] || DEFAULT_PHOTO
}
