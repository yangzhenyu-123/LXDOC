import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User, UserRole, UserStatus } from './user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

/**
 * 当前登录用户的最小结构（仅用于权限校验）
 */
interface CurrentUser {
  id: string;
  role: string;
}

/**
 * 用户服务
 * - seedIfEmpty：首次启动时创建默认管理员
 * - findByEmail / findById / findByUsername：基础查询
 * - findAll：分页查询
 * - create / update / remove：阶段四实现的 CRUD
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  /**
   * 启动时若 users 表为空，自动 seed 一个默认管理员
   * admin@lxdoc.local / lxdoc12345，role=admin
   */
  async seedIfEmpty(): Promise<void> {
    const count = await this.userRepo.count();
    if (count > 0) {
      return;
    }

    const passwordHash = await bcrypt.hash('lxdoc12345', 10);
    const admin = this.userRepo.create({
      email: 'admin@lxdoc.local',
      username: 'admin',
      passwordHash,
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
    });
    await this.userRepo.save(admin);
    this.logger.warn(
      '已创建默认管理员 admin@lxdoc.local / lxdoc12345，请立即修改密码',
    );
  }

  /**
   * 按 email 查询用户
   * @param email 邮箱
   * @param withPassword 是否带出 password_hash（登录校验密码时传 true）
   */
  async findByEmail(email: string, withPassword = false): Promise<User | null> {
    const qb = this.userRepo.createQueryBuilder('user').where('user.email = :email', {
      email,
    });
    if (withPassword) {
      qb.addSelect('user.password_hash');
    }
    return qb.getOne();
  }

  /**
   * 按 id 查询用户
   * @param id 用户 id
   * @param withPassword 是否带出 password_hash（修改密码校验旧密码时传 true）
   */
  async findById(id: string, withPassword = false): Promise<User | null> {
    const qb = this.userRepo
      .createQueryBuilder('user')
      .where('user.id = :id', { id });
    if (withPassword) {
      qb.addSelect('user.password_hash');
    }
    return qb.getOne();
  }

  /**
   * 按 username 查询用户（自注册时校验用户名是否占用）
   */
  async findByUsername(username: string): Promise<User | null> {
    return this.userRepo.findOne({ where: { username } });
  }

  /**
   * 创建用户（自注册 / 管理员创建均走此方法）
   * @param input 用户字段，调用方负责 hash 密码
   */
  async createUser(input: {
    email: string;
    username: string;
    passwordHash: string;
    role: UserRole;
    status: UserStatus;
  }): Promise<User> {
    const user = this.userRepo.create(input);
    return this.userRepo.save(user);
  }

  /**
   * 更新指定用户的密码哈希
   * 修改密码成功后调用，同时应清空该用户所有 refresh token
   */
  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.userRepo.update(userId, { passwordHash });
  }

  /**
   * 分页查询用户列表
   * User 实体 passwordHash 为 select:false，普通 find 不会返回密码哈希
   * 按 createdAt DESC 排序
   */
  async findAll(
    page = 1,
    pageSize = 20,
  ): Promise<{ items: User[]; total: number }> {
    const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    const safePageSize =
      Number.isFinite(pageSize) && pageSize > 0
        ? Math.min(Math.floor(pageSize), 100)
        : 20;
    const [items, total] = await this.userRepo.findAndCount({
      skip: (safePage - 1) * safePageSize,
      take: safePageSize,
      order: { createdAt: 'DESC' },
    });
    return { items, total };
  }

  /**
   * 管理员创建用户
   * - email / username 唯一校验
   * - bcrypt.hash(password, 10)
   * - 返回时手动剥离 passwordHash（实体 select:false 已保证，这里再保险删除）
   */
  async create(dto: CreateUserDto): Promise<User> {
    const existsByEmail = await this.findByEmail(dto.email);
    if (existsByEmail) {
      throw new BadRequestException('email 已被占用');
    }
    const existsByUsername = await this.findByUsername(dto.username);
    if (existsByUsername) {
      throw new BadRequestException('用户名已被占用');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = this.userRepo.create({
      email: dto.email,
      username: dto.username,
      passwordHash,
      role: dto.role,
      status: UserStatus.ACTIVE,
      organizationId: dto.organizationId ?? null,
    });
    const saved = await this.userRepo.save(user);
    // passwordHash 为 select:false，save 返回的对象理论上不含该字段，这里保险删除
    delete (saved as { passwordHash?: string }).passwordHash;
    return saved;
  }

  /**
   * 更新用户（修改 username / role / status）
   * - 用户不存在 404
   * - 防误锁：不能把自己降级（id === currentUser.id 且 dto.role !== admin）
   * - 防误锁：不能禁用自己（id === currentUser.id 且 dto.status === disabled）
   */
  async update(
    id: string,
    dto: UpdateUserDto,
    currentUser: CurrentUser,
  ): Promise<User> {
    const user = await this.findById(id);
    if (!user) {
      throw new NotFoundException(`用户 ${id} 不存在`);
    }

    // 防误锁：不能把自己降级为非 admin
    if (
      id === currentUser.id &&
      dto.role !== undefined &&
      dto.role !== UserRole.ADMIN
    ) {
      throw new BadRequestException('不能把自己降级');
    }
    // 防误锁：不能禁用自己
    if (
      id === currentUser.id &&
      dto.status === UserStatus.DISABLED
    ) {
      throw new BadRequestException('不能禁用自己');
    }

    if (dto.username !== undefined) {
      // 若修改了 username，校验唯一性（排除自身）
      const dup = await this.findByUsername(dto.username);
      if (dup && dup.id !== id) {
        throw new BadRequestException('用户名已被占用');
      }
      user.username = dto.username;
    }
    if (dto.role !== undefined) {
      user.role = dto.role;
    }
    if (dto.status !== undefined) {
      user.status = dto.status;
    }
    if (dto.organizationId !== undefined) {
      user.organizationId = dto.organizationId;
    }

    const saved = await this.userRepo.save(user);
    delete (saved as { passwordHash?: string }).passwordHash;
    return saved;
  }

  /**
   * 删除用户
   * - 不能删除自己
   * - 不能删除最后一个管理员
   */
  async remove(
    id: string,
    currentUser: CurrentUser,
  ): Promise<void> {
    if (id === currentUser.id) {
      throw new BadRequestException('不能删除自己');
    }

    // 统计当前 admin 数量
    const adminCount = await this.userRepo.count({
      where: { role: UserRole.ADMIN },
    });

    const target = await this.findById(id);
    if (!target) {
      throw new NotFoundException(`用户 ${id} 不存在`);
    }

    // 若目标是 admin 且当前仅剩这一个 admin，拒绝删除
    if (target.role === UserRole.ADMIN && adminCount <= 1) {
      throw new BadRequestException('不能删除最后一个管理员');
    }

    await this.userRepo.remove(target);
  }
}
