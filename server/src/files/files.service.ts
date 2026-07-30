import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Document } from '../documents/document.entity';
import { getUploadDir } from '../config/upload.config';
import { authConfig } from '../config/auth.config';

/**
 * 文件签名 token 的 JWT 载荷
 * - type: 'file' 区分于 access/refresh token
 * - docId: 绑定的文档 id，校验时必须与请求的 docId 一致
 * - sub: 签发用户 id，用于审计追溯
 */
export interface FileTokenPayload {
  sub: string;
  docId: string;
  type: 'file';
}

/**
 * 文件访问服务
 * - 签发短期文件 token（绑定 docId），供前端 <img src>/pdf 加载使用
 * - 校验 token 并解析原文件 / 图片的磁盘绝对路径
 *
 * 文件目录约定（与 uploads.service 保持一致）：
 * - 原文件：${UPLOAD_DIR}/original/<docId>/<filename>，Document.originalPath = original/<docId>/<filename>
 * - 图片：${UPLOAD_DIR}/images/<docId>/<filename>
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    @InjectRepository(Document)
    private readonly documentRepo: Repository<Document>,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * 为指定文档签发短期文件 token
   * 调用方需先完成读权限校验（assertCanRead），本方法仅负责签发
   */
  signFileToken(docId: string, userId: string): string {
    return this.jwtService.sign(
      { sub: userId, docId, type: 'file' } satisfies FileTokenPayload,
      {
        secret: authConfig.jwtSecret,
        expiresIn: authConfig.fileTokenExpires,
      },
    );
  }

  /**
   * 校验文件 token：签名、过期、type、docId 匹配
   * 校验失败抛 401
   */
  verifyFileToken(token: string, expectedDocId: string): void {
    let payload: FileTokenPayload;
    try {
      payload = this.jwtService.verify<FileTokenPayload>(token, {
        secret: authConfig.jwtSecret,
      });
    } catch {
      throw new UnauthorizedException('文件 token 无效或已过期');
    }
    if (payload.type !== 'file' || payload.docId !== expectedDocId) {
      throw new UnauthorizedException('文件 token 与文档不匹配');
    }
  }

  /**
   * 取文档原文件的绝对路径
   * 文档不存在或缺 originalPath 抛 404
   */
  async getOriginalAbsPath(docId: string): Promise<string> {
    const doc = await this.findOneForAuth(docId);
    if (!doc.originalPath) {
      throw new NotFoundException(`文档 ${docId} 缺少原始文件`);
    }
    const abs = path.join(getUploadDir(), doc.originalPath);
    return this.assertFileExists(abs, doc.originalPath);
  }

  /**
   * 查文档实体（供 controller 做读权限校验）
   * 不存在抛 404
   */
  async findOneForAuth(docId: string): Promise<Document> {
    const doc = await this.documentRepo.findOne({ where: { id: docId } });
    if (!doc) {
      throw new NotFoundException(`文档 ${docId} 不存在`);
    }
    return doc;
  }

  /**
   * 取文档图片的绝对路径
   * name 形如 <uuid>.png，存放在 ${UPLOAD_DIR}/images/<docId>/<name>
   * 防路径穿越：规范化后必须落在 images/<docId>/ 目录内
   */
  async getImageAbsPath(docId: string, name: string): Promise<string> {
    const imagesDir = path.join(getUploadDir(), 'images', docId);
    const abs = path.normalize(path.join(imagesDir, name));
    // 防路径穿越：解析后必须以 imagesDir 开头
    if (abs !== imagesDir && !abs.startsWith(imagesDir + path.sep)) {
      throw new UnauthorizedException('非法的图片路径');
    }
    return this.assertFileExists(abs, `images/${docId}/${name}`);
  }

  /**
   * 校验文件存在，不存在抛 404
   */
  private async assertFileExists(
    absPath: string,
    relPath: string,
  ): Promise<string> {
    try {
      await fs.access(absPath);
      return absPath;
    } catch {
      throw new NotFoundException(`文件不存在：${relPath}`);
    }
  }
}
