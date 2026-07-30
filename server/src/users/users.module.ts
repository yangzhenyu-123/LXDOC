import {
  Logger,
  Module,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './user.entity';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';

/**
 * 用户模块
 * - 注册 User 实体 Repository
 * - 启动时通过 OnApplicationBootstrap 调用 seedIfEmpty() 自动初始化默认管理员
 * - 导出 UsersService 供 AuthModule 在阶段三使用
 */
@Module({
  imports: [TypeOrmModule.forFeature([User])],
  providers: [UsersService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(UsersModule.name);

  constructor(private readonly usersService: UsersService) {}

  async onApplicationBootstrap() {
    try {
      await this.usersService.seedIfEmpty();
    } catch (err) {
      // 数据库未就绪时不阻断启动
      this.logger.error(
        `用户种子初始化失败：${(err as Error).message}`,
      );
    }
  }
}
