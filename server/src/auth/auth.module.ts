import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { authConfig } from '../config/auth.config';
import { UsersModule } from '../users/users.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';

/**
 * 认证模块
 * - 导入 UsersModule 拿 UsersService
 * - 导入 OrganizationsModule 拿 OrganizationsService（解析用户所属组织 path 注入 JWT）
 * - 导入 PassportModule + JwtModule 用于签发与校验 JWT
 * - 提供 AuthService（业务逻辑）与 JwtStrategy（passport 策略）
 */
@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: () => ({
        // 读 authConfig（从 process.env 读取），统一与 strategy / service 的密钥来源
        secret: authConfig.jwtSecret,
        signOptions: { expiresIn: authConfig.jwtAccessExpires },
      }),
    }),
    UsersModule,
    OrganizationsModule,
  ],
  providers: [AuthService, JwtStrategy],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}
