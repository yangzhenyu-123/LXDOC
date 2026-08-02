/**
 * Vision 多模态工具函数单元测试
 *
 * 覆盖：
 * - parseFileUrl：URL 解析 + 非法格式
 * - extractImageRefs：从文本提取图片引用
 * - buildVisionContent：纯文本 → 多模态升级 + 占位替换
 * - hasVisionMessage：消息数组是否含 image_url 片段
 * - imageToDataUri / enhanceWithImages：文件 IO 用 jest.mock 替换，验证路径穿越/超限/读取失败降级
 */
import {
  parseFileUrl,
  extractImageRefs,
  buildVisionContent,
  hasVisionMessage,
  imageToDataUri,
  enhanceWithImages,
} from './vision.utils';
import { LlmMessage } from '../llm/llm-provider.interface';

// jest.mock 替换 node:fs.promises 的 stat/readFile（工厂内不引用外部变量）
jest.mock('node:fs', () => {
  const actual = jest.requireActual('node:fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      stat: jest.fn(),
      readFile: jest.fn(),
    },
  };
});
// mock upload.config 避免依赖真实磁盘与 env
jest.mock('../config/upload.config', () => ({
  getUploadDir: () => '/mock/uploads',
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('node:fs').promises as {
  stat: jest.Mock;
  readFile: jest.Mock;
};

describe('parseFileUrl', () => {
  it('解析标准 URL', () => {
    expect(parseFileUrl('/api/files/abc-123/image/xyz.png')).toEqual({
      docId: 'abc-123',
      name: 'xyz.png',
    });
  });
  it('解析带 query 的 URL', () => {
    expect(parseFileUrl('/api/files/doc1/image/a.jpg?token=xxx')).toEqual({
      docId: 'doc1',
      name: 'a.jpg',
    });
  });
  it('解析 URL 编码的文件名', () => {
    expect(parseFileUrl('/api/files/d1/image/%E4%B8%AD%E6%96%87.png')).toEqual({
      docId: 'd1',
      name: '中文.png',
    });
  });
  it.each([
    'not-a-url',
    '/api/files/abc',
    '/api/files/abc/image/',
    '/other/abc/image/xyz.png',
  ])('非法 URL 返回 null: %s', (url) => {
    expect(parseFileUrl(url)).toBeNull();
  });
});

describe('extractImageRefs', () => {
  it('提取多个图片引用', () => {
    const text = '前文 ![图1](/api/files/d1/image/a.png) 中间 ![图2](/api/files/d2/image/b.jpg) 后文';
    const refs = extractImageRefs(text);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual({
      alt: '图1',
      docId: 'd1',
      name: 'a.png',
      raw: '![图1](/api/files/d1/image/a.png)',
    });
    expect(refs[1].alt).toBe('图2');
  });
  it('alt 为空时保留为空字符串', () => {
    const refs = extractImageRefs('![](/api/files/d1/image/a.png)');
    expect(refs[0].alt).toBe('');
  });
  it('忽略非 /api/files/ 的图片', () => {
    const refs = extractImageRefs('![x](https://example.com/a.png) ![](/api/files/d1/image/b.png)');
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe('b.png');
  });
  it('无图片返回空数组', () => {
    expect(extractImageRefs('纯文本')).toEqual([]);
  });
});

describe('buildVisionContent', () => {
  it('无图片时返回原 string', () => {
    expect(buildVisionContent('纯文本', [])).toBe('纯文本');
  });
  it('有图片时返回多模态数组，文本中图片引用替换为占位', () => {
    const text = '前文 ![图1](/api/files/d1/image/a.png) 后文';
    const result = buildVisionContent(text, ['data:image/png;base64,AAA']);
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        type: 'text',
        text: '前文 [图片: 图1] 后文',
      });
      expect(result[1]).toEqual({
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,AAA' },
      });
    }
  });
  it('alt 为空时占位为 [图片]', () => {
    const result = buildVisionContent('![](/api/files/d/x.png)', ['data:xxx']);
    if (Array.isArray(result)) {
      expect((result[0] as { text: string }).text).toBe('[图片]');
    }
  });
  it('多张图片按顺序追加', () => {
    const text = '![a](/api/files/d/a.png) ![b](/api/files/d/b.png)';
    const result = buildVisionContent(text, ['data:1', 'data:2']);
    if (Array.isArray(result)) {
      expect(result).toHaveLength(3); // 1 text + 2 image
      expect(result[1].type).toBe('image_url');
      expect(result[2].type).toBe('image_url');
    }
  });
});

describe('hasVisionMessage', () => {
  it('纯文本消息返回 false', () => {
    const msgs: LlmMessage[] = [{ role: 'user', content: '纯文本' }];
    expect(hasVisionMessage(msgs)).toBe(false);
  });
  it('含 image_url 片段返回 true', () => {
    const msgs: LlmMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image_url', image_url: { url: 'data:x' } },
        ],
      },
    ];
    expect(hasVisionMessage(msgs)).toBe(true);
  });
  it('混合消息中部分含图返回 true', () => {
    const msgs: LlmMessage[] = [
      { role: 'system', content: '系统' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '问题' },
          { type: 'image_url', image_url: { url: 'data:y' } },
        ],
      },
    ];
    expect(hasVisionMessage(msgs)).toBe(true);
  });
});

describe('imageToDataUri', () => {
  beforeEach(() => {
    fs.stat.mockClear();
    fs.readFile.mockClear();
    fs.stat.mockResolvedValue({ isFile: () => false, size: 0 } as any);
    fs.readFile.mockResolvedValue(Buffer.alloc(0));
  });

  it('正常读取返回 data URI', async () => {
    fs.stat.mockResolvedValue({ isFile: () => true, size: 100 } as any);
    fs.readFile.mockResolvedValue(Buffer.from('fake-image'));
    const result = await imageToDataUri('d1', 'a.png');
    expect(result).toBe('data:image/png;base64,ZmFrZS1pbWFnZQ==');
  });

  it('路径穿越被拒绝（返回 null）', async () => {
    const result = await imageToDataUri('d1', '../../etc/passwd');
    expect(result).toBeNull();
    expect(fs.stat).not.toHaveBeenCalled();
  });

  it('文件超过 maxBytes 跳过', async () => {
    fs.stat.mockResolvedValue({ isFile: () => true, size: 3 * 1024 * 1024 } as any);
    const result = await imageToDataUri('d1', 'big.png', 2 * 1024 * 1024);
    expect(result).toBeNull();
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('stat 抛错（文件不存在）返回 null', async () => {
    fs.stat.mockRejectedValue(new Error('ENOENT'));
    const result = await imageToDataUri('d1', 'missing.png');
    expect(result).toBeNull();
  });

  it('非文件（目录）返回 null', async () => {
    fs.stat.mockResolvedValue({ isFile: () => false, size: 0 } as any);
    const result = await imageToDataUri('d1', 'dir');
    expect(result).toBeNull();
  });

  it('按扩展名识别 MIME（jpeg/webp）', async () => {
    fs.stat.mockResolvedValue({ isFile: () => true, size: 100 } as any);
    fs.readFile.mockResolvedValue(Buffer.from('x'));
    expect(await imageToDataUri('d', 'a.jpeg')).toContain('data:image/jpeg;base64,');
    expect(await imageToDataUri('d', 'b.webp')).toContain('data:image/webp;base64,');
  });
});

describe('enhanceWithImages', () => {
  beforeEach(() => {
    fs.stat.mockClear();
    fs.readFile.mockClear();
  });

  it('无图片引用返回原文本 + imageCount=0', async () => {
    const result = await enhanceWithImages('纯文本内容');
    expect(result).toEqual({ content: '纯文本内容', imageCount: 0 });
  });

  it('所有图片读取失败回退纯文本 + imageCount=0', async () => {
    fs.stat.mockRejectedValue(new Error('ENOENT'));
    const text = '![a](/api/files/d/image/a.png) 文本';
    const result = await enhanceWithImages(text);
    expect(result.imageCount).toBe(0);
    expect(typeof result.content).toBe('string');
  });

  it('成功读取返回多模态 + imageCount', async () => {
    fs.stat.mockResolvedValue({ isFile: () => true, size: 100 } as any);
    fs.readFile.mockResolvedValue(Buffer.from('img'));
    const text = '![a](/api/files/d/image/a.png) 文本';
    const result = await enhanceWithImages(text);
    expect(result.imageCount).toBe(1);
    expect(Array.isArray(result.content)).toBe(true);
  });

  it('超过 maxImages 截断', async () => {
    fs.stat.mockResolvedValue({ isFile: () => true, size: 100 } as any);
    fs.readFile.mockResolvedValue(Buffer.from('x'));
    const text = '![](u1) ![](u2) ![](u3)'.replace(/u\d/g, '/api/files/d/image/a.png');
    const result = await enhanceWithImages(text, 2);
    expect(result.imageCount).toBe(2);
  });
});
