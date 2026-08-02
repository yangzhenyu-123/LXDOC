/**
 * Vision 多模态工具函数（纯逻辑 + 文件读取）
 *
 * 用途：当文档/chunk content 含图片引用 `![alt](/api/files/<docId>/image/<name>)` 时，
 * 把图片读为 data URI 注入 LlmMessage.content（多模态格式），让 vision 模型识图。
 *
 * 限制（防 token 爆炸，由 llm.config 提供）：
 * - 单次最多 visionMaxImages 张（默认 5）
 * - 单张 ≤ visionMaxImageBytes（默认 2MB），超出跳过 + warn
 * - 超出上限后剩余图片忽略，文本中的引用标记保留为 [图片: alt] 占位
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Logger } from '@nestjs/common';
import { getUploadDir } from '../config/upload.config';
import { llmConfig } from '../config/llm.config';
import {
  LlmContentPart,
  LlmMessage,
} from '../llm/llm-provider.interface';

const logger = new Logger('VisionUtils');

/** 匹配 markdown 图片引用 ![alt](/api/files/<docId>/image/<name>) */
const IMAGE_REF_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

/** MIME by extension（仅常见类型，未识别按 png 处理） */
const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

/**
 * 从文本中提取所有图片引用
 * 返回 [{alt, docId, name, raw}], 顺序按文本出现顺序
 */
export function extractImageRefs(
  text: string,
): { alt: string; docId: string; name: string; raw: string }[] {
  const refs: { alt: string; docId: string; name: string; raw: string }[] = [];
  for (const m of text.matchAll(IMAGE_REF_RE)) {
    const alt = m[1] ?? '';
    const url = m[2] ?? '';
    // 解析 /api/files/<docId>/image/<name>
    const parsed = parseFileUrl(url);
    if (parsed) {
      refs.push({ alt, docId: parsed.docId, name: parsed.name, raw: m[0] });
    }
  }
  return refs;
}

/** 解析 /api/files/<docId>/image/<name> URL，失败返回 null */
export function parseFileUrl(
  url: string,
): { docId: string; name: string } | null {
  const m = url.match(/\/api\/files\/([^/]+)\/image\/([^/?]+)/);
  if (!m) return null;
  const docId = decodeURIComponent(m[1]);
  const name = decodeURIComponent(m[2]);
  if (!docId || !name) return null;
  return { docId, name };
}

/**
 * 把图片读为 data URI（base64）
 * - 防路径穿越：规范化后必须落在 images/<docId>/ 内
 * - 超过 visionMaxImageBytes 跳过并 warn
 */
export async function imageToDataUri(
  docId: string,
  name: string,
  maxBytes = llmConfig.visionMaxImageBytes,
): Promise<string | null> {
  const imagesDir = path.join(getUploadDir(), 'images', docId);
  const abs = path.normalize(path.join(imagesDir, name));
  if (abs !== imagesDir && !abs.startsWith(imagesDir + path.sep)) {
    logger.warn(`非法图片路径（拒绝穿越）：images/${docId}/${name}`);
    return null;
  }
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return null;
    if (stat.size > maxBytes) {
      logger.warn(
        `图片过大跳过（${stat.size} > ${maxBytes}）：images/${docId}/${name}`,
      );
      return null;
    }
    const buf = await fs.readFile(abs);
    const ext = path.extname(name).slice(1).toLowerCase();
    const mime = EXT_MIME[ext] ?? 'image/png';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch (err) {
    logger.warn(`读取图片失败（跳过）：images/${docId}/${name} ${(err as Error).message}`);
    return null;
  }
}

/**
 * 把纯文本 user 消息升级为多模态消息
 *
 * 策略：
 * - 文本中的图片引用 `![alt](/api/files/<docId>/image/<name>)` 替换为 `[图片: alt]` 占位
 *   （避免把 URL 喂给模型当噪声）
 * - 在文本片段后追加 image_url 片段（按文本中出现顺序，最多 maxImages 张）
 * - 无图片时返回原 string content（向后兼容，不浪费 token）
 *
 * @param text user 消息文本
 * @param images 已读取的 data URI 列表（按文本中图片出现顺序）
 * @returns content 字段（string 或 LlmContentPart[]）
 */
export function buildVisionContent(
  text: string,
  images: string[],
): string | LlmContentPart[] {
  if (images.length === 0) return text;
  // 文本中所有图片引用替换为 [图片: alt] 占位
  const cleaned = text.replace(IMAGE_REF_RE, (_m, alt: string) =>
    `[图片${alt ? `: ${alt}` : ''}]`,
  );
  const parts: LlmContentPart[] = [{ type: 'text', text: cleaned }];
  for (const dataUri of images) {
    parts.push({ type: 'image_url', image_url: { url: dataUri } });
  }
  return parts;
}

/**
 * 处理一组 chunks：提取图片 → 读取 → 升级 user 消息为多模态
 *
 * 用于 RAG 问答：从检索命中的 chunks 中提取图片引用，读取后构造多模态 user 消息。
 * - 仅取前 maxImages 张（按 chunks 顺序，每个 chunk 内按文本出现顺序）
 * - 同时把 chunk content 中的图片引用替换为占位，避免 URL 噪声
 *
 * @param chunksContent 已经拼接好的 knowledge 文本（含图片引用）
 * @param maxImages 最多图片数
 * @returns { content, imageCount } 升级后的 content（string 或多模态数组）+ 实际投喂图片数
 */
export async function enhanceWithImages(
  chunksContent: string,
  maxImages = llmConfig.visionMaxImages,
): Promise<{ content: string | LlmContentPart[]; imageCount: number }> {
  const refs = extractImageRefs(chunksContent).slice(0, maxImages);
  if (refs.length === 0) {
    return { content: chunksContent, imageCount: 0 };
  }
  const dataUris: string[] = [];
  for (const r of refs) {
    const data = await imageToDataUri(r.docId, r.name);
    if (data) dataUris.push(data);
  }
  if (dataUris.length === 0) {
    // 所有图片都读取失败：保留原文本（含 URL），让 LLM 至少有文本上下文
    return { content: chunksContent, imageCount: 0 };
  }
  const content = buildVisionContent(chunksContent, dataUris);
  return { content, imageCount: dataUris.length };
}

/**
 * 判断消息数组是否含多模态内容（image_url 片段）
 * （GlmProvider 用此判断是否切 vision 模型）
 */
export function hasVisionMessage(messages: LlmMessage[]): boolean {
  return messages.some(
    (m) => Array.isArray(m.content) &&
      m.content.some((p: LlmContentPart) => p.type === 'image_url'),
  );
}
