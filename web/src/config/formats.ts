/**
 * 文件格式 accept 字符串（供 el-upload 的 accept 属性使用）
 *
 * 与后端 upload.config.ts 的白名单保持同步：
 * - DOC_ACCEPT：主文档允许的格式（对应 allowedDocExtensions）
 * - ATTACH_ACCEPT：附件允许的格式（对应 allowedAttachmentExtensions）
 *
 * 注：accept 仅做前端筛选提示，真实校验在后端白名单。
 */

// 主文档 accept：可解析 + office 类 + 版式 + 模板
export const DOC_ACCEPT = [
  '.md', '.markdown', '.txt',
  '.docx', '.odt', '.pdf',
  '.doc', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.tsv',
  '.wps', '.dps', '.et', '.ett', '.wpt',
  '.ods', '.odp', '.ott', '.fodt', '.fods',
  '.ofd', '.rtf',
  '.xlsm', '.dotm', '.xlt', '.xltm', '.dot', '.xlam', '.dotx', '.xla', '.pptm',
  '.ots', '.otp', '.six',
].join(',');

// 附件 accept：覆盖 kkFileView 5.0.1 支持的全部格式
export const ATTACH_ACCEPT = [
  // 压缩包
  '.zip', '.rar', '.jar', '.tar', '.gz', '.7z',
  // 源码/文本
  '.xml', '.java', '.js', '.css', '.py', '.php', '.c', '.cpp', '.h', '.hpp',
  '.go', '.rs', '.rb', '.sh', '.bash', '.json', '.yaml', '.yml', '.toml',
  '.sql', '.md', '.markdown', '.txt', '.log',
  // 图片
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.jfif', '.webp',
  '.heic', '.heif', '.tif', '.tiff', '.tga', '.svg', '.wmf', '.emf',
  // Photoshop/矢量
  '.psd', '.eps',
  // office 类
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.tsv',
  '.wps', '.dps', '.et', '.ett', '.wpt',
  '.odt', '.ods', '.odp', '.ott', '.fodt', '.fods', '.pdf',
  // 版式/富文本
  '.ofd', '.rtf',
  // Office 宏/模板
  '.xlsm', '.dotm', '.xlt', '.xltm', '.dot', '.xlam', '.dotx', '.xla', '.pptm',
  '.ots', '.otp', '.six', '.pages',
  // Visio
  '.vsd', '.vsdx',
  // CAD
  '.dwg', '.dxf', '.dwf', '.igs', '.dwt', '.dng', '.dwfx', '.cf2', '.plt',
  // 3D 模型
  '.obj', '.3ds', '.stl', '.ply', '.gltf', '.glb', '.off', '.3dm',
  '.fbx', '.dae', '.wrl', '.3mf', '.ifc', '.brep', '.step', '.iges',
  '.fcstd', '.bim',
  // 模型/绘图/工作流
  '.xmind', '.bpmn', '.drawio',
  // 邮件
  '.eml', '.msg',
  // 电子书
  '.epub',
  // 医疗影像
  '.dcm',
  // 财务报告
  '.xbrl',
  // 音频
  '.mp3', '.wav',
  // 视频
  '.mp4', '.flv', '.avi', '.mov', '.wmv', '.mkv', '.3gp', '.rm',
].join(',');

/**
 * OnlyOffice 可编辑格式集合（与后端 onlyoffice.service.ts 的三个集合对齐）
 * 来源：OnlyOffice Docs conversion-tables
 * https://api.onlyoffice.com/docs/docs-api/additional-api/conversion-api/conversion-tables/
 *
 * - word：文档类（doc/docx/odt/rtf/txt/md/wps/wpt/ofd + 模板 dot/dotm/dotm/dotx/odt/ott）
 * - cell：表格类（xlsx/xls/xlsm/ods/et/csv/tsv + 模板 xlt/xltm/ots）
 * - slide：演示类（pptx/ppt/pptm/odp/dps + 模板 otp）
 *
 * 不纳入 OnlyOffice 编辑（走 kkFileView 预览或 MarkdownEditor）：
 * - pdf：保持只读（docling 解析文本）
 * - fodt/fods/fodp（flat XML）：走预览
 * - six/epub/fb2 等：走预览
 *
 * 注：md/txt 虽在 OnlyOffice word 列表中，但 LXDOC 优先用 MarkdownEditor（Vditor）
 *     编辑体验更好（所见即所得 + 图片粘贴），故从 OnlyOffice 集合中排除。
 */
export const ONLYOFFICE_WORD_FORMATS = new Set([
  'doc', 'docx', 'dot', 'dotm', 'dotx',
  'odt', 'ott', 'rtf', 'wps', 'wpt', 'ofd',
]);

export const ONLYOFFICE_CELL_FORMATS = new Set([
  'xls', 'xlsx', 'xlsm', 'xlt', 'xltm', 'xlam',
  'ods', 'ots', 'fods', 'et', 'ett',
  'csv', 'tsv',
]);

export const ONLYOFFICE_SLIDE_FORMATS = new Set([
  'ppt', 'pptx', 'pptm',
  'odp', 'otp', 'dps',
]);

/** 判断 format 是否可由 OnlyOffice 编辑，返回 documentType 或 null */
export function getOnlyOfficeDocumentType(
  format: string | undefined,
): 'word' | 'cell' | 'slide' | null {
  if (!format) return null;
  if (ONLYOFFICE_WORD_FORMATS.has(format)) return 'word';
  if (ONLYOFFICE_CELL_FORMATS.has(format)) return 'cell';
  if (ONLYOFFICE_SLIDE_FORMATS.has(format)) return 'slide';
  return null;
}

/** 判断 format 是否可由 OnlyOffice 编辑（任何类型） */
export function isOnlyOfficeEditable(format: string | undefined): boolean {
  return getOnlyOfficeDocumentType(format) !== null;
}
