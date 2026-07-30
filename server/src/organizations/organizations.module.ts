import {
  Logger,
  Module,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Organization } from './organization.entity';
import { UserOrgRole } from './user-org-role.entity';
import { OrganizationsService } from './organizations.service';
import { OrganizationsController } from './organizations.controller';
import { AccessControlService } from './access-control.service';
import { User } from '../users/user.entity';
import { Document } from '../documents/document.entity';

/**
 * 组织模块
 * - 注册 Organization / UserOrgRole / User / Document 实体
 *   （User 用于成员列表 join 用户名；Document 用于删除节点时校验关联文档）
 * - 启动时 seedIfEmpty 创建示例组织
 * - 导出 OrganizationsService / AccessControlService 供各业务模块使用
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Organization, UserOrgRole, User, Document]),
  ],
  controllers: [OrganizationsController],
  providers: [OrganizationsService, AccessControlService],
  exports: [OrganizationsService, AccessControlService, TypeOrmModule],
})
export class OrganizationsModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrganizationsModule.name);

  constructor(private readonly organizationsService: OrganizationsService) {}

  async onApplicationBootstrap() {
    try {
      await this.organizationsService.seedIfEmpty();
    } catch (err) {
      // 数据库未就绪时不阻断启动
      this.logger.error(
        `组织种子初始化失败：${(err as Error).message}`,
      );
    }
  }
}
