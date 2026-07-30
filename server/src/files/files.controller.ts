import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { FilesService } from './files.service';
import { AccessControlService } from '../organizations/access-control.service';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';

/**
 * 仅声明用到的 express Response 子集，避免引入 @types/express 依赖
 * res.sendFile 由 @nestjs/platform-express 提供的 express 实例实现
 */
interface SendFileResponse {
  sendFile(absPath: string): void;
}

/**
 * 文件访问控制器
 * 全局前缀 /api 由 main.ts 设置
 *
 * 路由：
 * - GET /api/files/token/:docId            签发短期文件 token（需登录 + 读权限）
 * - GET /api/files/:docId/original?token=  下载原文件（@Public，校验 token）
 * - GET /api/files/:docId/image/:name?token=  下载图片（@Public，校验 token）
 *
 * 设计：图片/PDF 通过 <img src>/pdfjs 加载，无法带 Authorization 头，
 * 故用 ?token= 短期签名 token（绑定 docId，默认 10 分钟）。
 * token 由前端先调 /api/files/token/:docId（带 Bearer）取得。
 */
@Controller('files')
export class FilesController {
  constructor(
    private readonly filesService: FilesService,
    private readonly accessControl: AccessControlService,
  ) {}

  /**
   * 签发文件 token
   * 需登录，且对目标文档有读权限，否则 403
   * 返回 { token }，前端拼到图片/原文件 URL 的 ?token= 上
   */
  @Get('token/:docId')
  async signToken(
    @Param('docId') docId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ token: string }> {
    const doc = await this.filesService.findOneForAuth(docId);
    this.accessControl.assertCanRead(user, doc);
    const token = this.filesService.signFileToken(docId, user.id);
    return { token };
  }

  /**
   * 下载原文件（pdf/docx/odt 等）
   * @Public：跳过全局 JwtAuthGuard，由 query token 校验
   */
  @Public()
  @Get(':docId/original')
  async getOriginal(
    @Param('docId') docId: string,
    @Query('token') token: string | undefined,
    @Res() res: SendFileResponse,
  ): Promise<void> {
    if (!token) {
      throw new UnauthorizedException('缺少文件 token');
    }
    this.filesService.verifyFileToken(token, docId);
    const absPath = await this.filesService.getOriginalAbsPath(docId);
    res.sendFile(absPath);
  }

  /**
   * 下载图片（docx 预览抽取的图片 / 编辑器上传的图片）
   * @Public：跳过全局 JwtAuthGuard，由 query token 校验
   */
  @Public()
  @Get(':docId/image/:name')
  async getImage(
    @Param('docId') docId: string,
    @Param('name') name: string,
    @Query('token') token: string | undefined,
    @Res() res: SendFileResponse,
  ): Promise<void> {
    if (!token) {
      throw new UnauthorizedException('缺少文件 token');
    }
    this.filesService.verifyFileToken(token, docId);
    const absPath = await this.filesService.getImageAbsPath(docId, name);
    res.sendFile(absPath);
  }
}
