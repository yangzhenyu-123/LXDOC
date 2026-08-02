import { Injectable, Logger } from '@nestjs/common';
import { ChunkType } from './entities/kb-chunk.entity';

/**
 * Chunk 切分结果
 */
export interface ChunkResult {
  /** chunk 文本 */
  content: string;
  /** chunk 类型 */
  chunkType: ChunkType;
  /** 标题路径（如 "第一章 > 1.2 系统架构"） */
  headingPath: string | null;
  /** 元数据（tokenCount 等） */
  metadata: Record<string, any>;
}

/**
 * Chunk 切分策略配置
 */
export interface ChunkStrategy {
  /** 切分策略名：markdown_structure / fixed_size */
  strategy: 'markdown_structure' | 'fixed_size';
  /** 目标 chunk 长度（字符数，中文约 1.5 字符/token，512 token ≈ 768 字符） */
  chunkSize: number;
  /** 重叠长度（字符数） */
  overlap: number;
}

/** 默认切分策略 */
export const DEFAULT_CHUNK_STRATEGY: ChunkStrategy = {
  strategy: 'markdown_structure',
  chunkSize: 768,
  overlap: 96,
};

/**
 * 文本净化：chunking 前去除会污染向量的字符
 *
 * 处理内容：
 * 1. BOM（U+FEFF）
 * 2. 零宽字符（U+200B/200C/200D/2060/FEFF）——文档编辑器/转换工具常见副产物
 * 3. 控制字符 U+0000-U+001F（保留 \n \t \r）——PDF 抽取常混入
 * 4. 全角空格 U+3000 → 半角空格
 * 5. 连续空白压缩为单个空格（保留换行）
 * 6. 行尾空白
 * 7. Windows 换行 CRLF → LF
 *
 * 不做：
 * - 错别字修正（需 LLM，留 P10+）
 * - hyphenation 断词修复（"inter-\nnational"→"international"，误伤风险高）
 * - 删除合法 Unicode（CJK/emoji 等保留）
 *
 * 对应 TODO 2.2.3：提取后文档错字/乱码净化的最小可行版本
 */
export function sanitizeText(text: string): string {
  if (!text) return text;
  return text
    // 1. BOM
    .replace(/\uFEFF/g, '')
    // 2. 零宽字符（零宽空格/连接符/非连接符/不间断分隔符）
    .replace(/[\u200B\u200C\u200D\u2060]/g, '')
    // 3. 控制字符，保留 \n(0A) \t(09) \r(0D)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    // 4. 全角空格 → 半角
    .replace(/\u3000/g, ' ')
    // 7. CRLF → LF（在压缩空白前先统一换行）
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // 5. 连续空格/制表符压缩为单个空格（不影响换行）
    .replace(/[^\S\n]+/g, ' ')
    // 6. 行尾空白
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .trim();
}

/**
 * Markdown chunk 切分服务
 *
 * 策略：markdown_structure（默认）
 * 1. 按 ATX 标题（# ~ ######）切 section
 * 2. section 内按段落（空行分隔）聚合
 * 3. 段落聚合超过 chunkSize 时切分（保留 overlap）
 * 4. 代码块 ```...``` 和表格 |...| 整块保留，不切分
 * 5. 标题层级累计为 headingPath
 *
 * 输入：docling 输出的 markdown（含 data URI 图片已落盘后的 markdown）
 * 输出：ChunkResult[]（不含 embedding，由 EmbeddingService 异步生成）
 */
@Injectable()
export class ChunkingService {
  private readonly logger = new Logger(ChunkingService.name);

  /**
   * 切分 markdown 为 chunks
   * @param markdown docling 解析后的 markdown 全文
   * @param strategy 切分策略，省略用默认
   * @returns chunk 数组（顺序为文档顺序）
   */
  chunk(markdown: string, strategy?: Partial<ChunkStrategy>): ChunkResult[] {
    const cfg: ChunkStrategy = { ...DEFAULT_CHUNK_STRATEGY, ...strategy };
    // 净化：去 BOM/零宽字符/控制字符/全角空格，压缩空白（防止污染 embedding 向量）
    const clean = markdown ? sanitizeText(markdown) : '';
    if (!clean || !clean.trim()) return [];

    const lines = clean.split('\n');
    const chunks: ChunkResult[] = [];
    let headingStack: string[] = []; // 标题层级栈
    let currentSection: string[] = []; // 当前 section 累积行
    let chunkIndex = 0;

    const flushSection = () => {
      if (currentSection.length === 0) return;
      const sectionText = currentSection.join('\n').trim();
      if (sectionText) {
        chunks.push(...this.splitSection(sectionText, headingStack, cfg));
      }
      currentSection = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

      if (headingMatch) {
        // 遇到新标题，先 flush 旧 section
        flushSection();
        const level = headingMatch[1].length;
        const title = headingMatch[2].trim();
        // 维护标题栈：弹出 >= 当前 level 的标题
        headingStack = headingStack.slice(0, level - 1);
        headingStack[level - 1] = title;
        continue;
      }

      // 代码块检测（``` 或 ~~~）
      const fenceMatch = line.match(/^(\s*)(```|~~~)/);
      if (fenceMatch) {
        // 整个代码块作为一个 chunk
        const fence = fenceMatch[2];
        const codeLines = [line];
        let j = i + 1;
        while (j < lines.length) {
          codeLines.push(lines[j]);
          if (lines[j].includes(fence)) break;
          j++;
        }
        i = j;
        const codeText = codeLines.join('\n');
        chunks.push({
          content: codeText,
          chunkType: ChunkType.CODE,
          headingPath: headingStack.filter(Boolean).join(' > ') || null,
          metadata: { tokenCount: this.estimateTokens(codeText) },
        });
        chunkIndex++;
        continue;
      }

      // 表格检测（| 开头且后续行也是 |）
      if (line.trim().startsWith('|') && i + 1 < lines.length && lines[i + 1].includes('|---')) {
        const tableLines = [line];
        let j = i + 1;
        while (j < lines.length && lines[j].trim().startsWith('|')) {
          tableLines.push(lines[j]);
          j++;
        }
        i = j - 1;
        const tableText = tableLines.join('\n');
        chunks.push({
          content: tableText,
          chunkType: ChunkType.TABLE,
          headingPath: headingStack.filter(Boolean).join(' > ') || null,
          metadata: { tokenCount: this.estimateTokens(tableText) },
        });
        chunkIndex++;
        continue;
      }

      // 普通行累积到 section
      currentSection.push(line);
    }
    // flush 最后一个 section
    flushSection();

    this.logger.log(`chunking 完成：${chunks.length} 个 chunk（strategy=${cfg.strategy}）`);
    return chunks;
  }

  /**
   * 将一个 section（标题下的一段正文）按段落 + chunkSize 切分
   */
  private splitSection(
    sectionText: string,
    headingStack: string[],
    cfg: ChunkStrategy,
  ): ChunkResult[] {
    const headingPath = headingStack.filter(Boolean).join(' > ') || null;
    const paragraphs = sectionText.split(/\n\s*\n/).filter((p) => p.trim());

    const chunks: ChunkResult[] = [];
    let buffer = '';
    let bufferTokens = 0;

    for (const para of paragraphs) {
      const paraTokens = this.estimateTokens(para);

      // 单段落超长，强制切分（保留 overlap）
      if (paraTokens > cfg.chunkSize) {
        // 先 flush 已 buffer 的内容
        if (buffer.trim()) {
          chunks.push(this.makeChunk(buffer, headingPath));
          buffer = '';
          bufferTokens = 0;
        }
        // 切分长段落
        const subChunks = this.splitLongParagraph(para, cfg);
        for (const sc of subChunks) {
          chunks.push(this.makeChunk(sc, headingPath));
        }
        continue;
      }

      // 累积到 buffer，超 chunkSize 则 flush
      if (bufferTokens + paraTokens > cfg.chunkSize && buffer.trim()) {
        chunks.push(this.makeChunk(buffer, headingPath));
        // overlap：保留尾部部分
        const overlapText = this.tailOverlap(buffer, cfg.overlap);
        buffer = overlapText + '\n\n' + para;
        bufferTokens = this.estimateTokens(buffer);
      } else {
        buffer = buffer ? `${buffer}\n\n${para}` : para;
        bufferTokens += paraTokens;
      }
    }

    if (buffer.trim()) {
      chunks.push(this.makeChunk(buffer, headingPath));
    }
    return chunks;
  }

  /** 切分超长段落（按句号/换行切） */
  private splitLongParagraph(text: string, cfg: ChunkStrategy): string[] {
    // 按句号、换行切句子
    const sentences = text.split(/(?<=[。！？.!?])\s+|\n+/).filter((s) => s.trim());
    const chunks: string[] = [];
    let buffer = '';
    let bufTokens = 0;
    for (const s of sentences) {
      const sTokens = this.estimateTokens(s);
      if (bufTokens + sTokens > cfg.chunkSize && buffer.trim()) {
        chunks.push(buffer.trim());
        buffer = this.tailOverlap(buffer, cfg.overlap) + s;
        bufTokens = this.estimateTokens(buffer);
      } else {
        buffer = buffer ? `${buffer} ${s}` : s;
        bufTokens += sTokens;
      }
    }
    if (buffer.trim()) chunks.push(buffer.trim());
    return chunks;
  }

  /** 取文本尾部 overlap 字符数 */
  private tailOverlap(text: string, overlap: number): string {
    if (text.length <= overlap) return text + ' ';
    return text.slice(-overlap) + ' ';
  }

  private makeChunk(content: string, headingPath: string | null): ChunkResult {
    const trimmed = content.trim();
    return {
      content: trimmed,
      chunkType: ChunkType.TEXT,
      headingPath,
      metadata: { tokenCount: this.estimateTokens(trimmed) },
    };
  }

  /**
   * 粗略估算 token 数
   * 中文约 1.5 字符/token，英文约 4 字符/token，混合取 2 字符/token
   */
  private estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 2);
  }
}
