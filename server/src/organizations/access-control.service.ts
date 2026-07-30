import {
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Brackets, SelectQueryBuilder } from 'typeorm';
import { UserRole } from '../users/user.entity';
import {
  DocumentOwnerType,
  Document,
} from '../documents/document.entity';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { UserOrgRoleValue } from './user-org-role.entity';
import { OrganizationsService } from './organizations.service';

/**
 * 组织角色缓存条目
 * key = userId，value = { roles, expireAt }
 */
interface RoleCacheEntry {
  roles: { orgId: string; path: string; role: UserOrgRoleValue }[];
  expireAt: number;
}

/**
 * 访问控制服务
 * 统一实现"部门/组/个人"三层权限判断，替代 documents/categories 各自重复的 assertCanWrite。
 *
 * 读权限（每层有读权限）：
 * - admin 全读
 * - personal 文档：仅 ownerId === userId
 * - group/department 文档：owner 节点是用户所属节点的祖先或自身
 *   （即 owner.id ∈ user.orgPath 按 '.' 拆分的 id 段集合）
 *
 * 编辑权限（需对应编辑授权）：
 * - admin 全权
 * - personal 文档：ownerId === userId
 * - group/department 文档：用户在 owner 节点有 editor/admin 角色，
 *   或在 owner 的某祖先节点有 admin 角色（向下继承）
 *
 * path 段使用节点 id（UUID），故 user.orgPath.split('.') 即用户祖先+自身 org id 集合，免 DB 查询。
 */
@Injectable()
export class AccessControlService {
  private readonly logger = new Logger(AccessControlService.name);
  // 编辑授权缓存：userId → { roles, expireAt }，30s 有效
  private readonly roleCache = new Map<string, RoleCacheEntry>();
  private readonly CACHE_TTL_MS = 30_000;

  constructor(
    private readonly organizationsService: OrganizationsService,
  ) {}

  /**
   * 用户祖先+自身 org id 集合（path 段即 id）
   * 用户无 orgPath 时返回空数组（只能读个人文档）
   */
  private ancestorOrgIds(user: AuthUser): string[] {
    if (!user.orgPath) {
      return [];
    }
    return user.orgPath.split('.').filter(Boolean);
  }

  /**
   * 是否可读文档
   */
  canRead(user: AuthUser, doc: Pick<Document, 'ownerType' | 'ownerId' | 'createdBy'>): boolean {
    if (user.role === UserRole.ADMIN) {
      return true;
    }
    if (doc.ownerType === DocumentOwnerType.PERSONAL) {
      return doc.ownerId === user.id;
    }
    // group/department：owner 节点是用户祖先或自身
    const ids = this.ancestorOrgIds(user);
    return !!doc.ownerId && ids.includes(doc.ownerId);
  }

  /**
   * 校验读权限，失败抛 403
   */
  assertCanRead(
    user: AuthUser,
    doc: Pick<Document, 'ownerType' | 'ownerId' | 'createdBy'>,
  ): void {
    if (!this.canRead(user, doc)) {
      throw new ForbiddenException('无权访问该文档');
    }
  }

  /**
   * 是否可编辑文档
   * group/department 文档需查询用户授权（带缓存），并解析 owner.path 做祖先继承判断
   */
  async canWrite(
    user: AuthUser,
    doc: Pick<Document, 'ownerType' | 'ownerId' | 'createdBy'>,
  ): Promise<boolean> {
    if (user.role === UserRole.ADMIN) {
      return true;
    }
    if (doc.ownerType === DocumentOwnerType.PERSONAL) {
      return doc.ownerId === user.id;
    }
    if (!doc.ownerId) {
      return false;
    }
    // group/department：查授权
    const roles = await this.getManageableRoles(user.id);
    if (roles.length === 0) {
      return false;
    }
    // editor / admin 精确命中 owner 节点
    if (roles.some((r) => r.orgId === doc.ownerId)) {
      return true;
    }
    // admin 在 owner 祖先节点（向下继承）
    const ownerOrg = await this.organizationsService.findByIdOrNull(doc.ownerId);
    if (!ownerOrg) {
      return false;
    }
    return roles.some(
      (r) =>
        r.role === UserOrgRoleValue.ADMIN &&
        (ownerOrg.path === r.path ||
          ownerOrg.path.startsWith(r.path + '.')),
    );
  }

  /**
   * 校验写权限，失败抛 403
   */
  async assertCanWrite(
    user: AuthUser,
    doc: Pick<Document, 'ownerType' | 'ownerId' | 'createdBy'>,
  ): Promise<void> {
    if (!(await this.canWrite(user, doc))) {
      throw new ForbiddenException('无权修改该文档');
    }
  }

  /**
   * 获取用户编辑授权（带 30s 缓存）
   * 返回 [{ orgId, path, role }]，path 用于 admin 祖先继承判断
   */
  private async getManageableRoles(
    userId: string,
  ): Promise<{ orgId: string; path: string; role: UserOrgRoleValue }[]> {
    const cached = this.roleCache.get(userId);
    if (cached && cached.expireAt > Date.now()) {
      return cached.roles;
    }
    const roles = await this.organizationsService.getUserOrgRolesWithPath(userId);
    this.roleCache.set(userId, {
      roles,
      expireAt: Date.now() + this.CACHE_TTL_MS,
    });
    return roles;
  }

  /**
   * 失效某用户的授权缓存（成员授权变更时调用）
   */
  invalidateUserCache(userId: string): void {
    this.roleCache.delete(userId);
  }

  /**
   * 生成读权限的 TypeORM where 片段（参数化），供 findRecent/listByCategory/search 复用
   * admin 返回 null 表示不附加过滤；非 admin 返回 Brackets 兼容的 where 条件对象
   *
   * 返回 { query: string, params: Record<string, unknown> }
   * query 是可直接拼到 WHERE 后的 SQL 片段（针对 documents 表别名 d）
   */
  getReadScope(
    user: AuthUser,
  ): { isFullAccess: boolean; userId: string; ancestorOrgIds: string[] } {
    return {
      isFullAccess: user.role === UserRole.ADMIN,
      userId: user.id,
      ancestorOrgIds: this.ancestorOrgIds(user),
    };
  }

  /**
   * 把读权限过滤应用到 QueryBuilder（documents 表别名 d）
   * admin 不附加；非 admin 追加 Brackets：个人文档 OR 归属祖先 org 的文档
   */
  applyReadScopeToQb(
    qb: SelectQueryBuilder<Document>,
    user: AuthUser,
  ): void {
    if (user.role === UserRole.ADMIN) {
      return;
    }
    const ancestorIds = this.ancestorOrgIds(user);
    if (ancestorIds.length === 0) {
      qb.andWhere(
        new Brackets((q) => {
          q.where('d.ownerType = :scopePersonal', {
            scopePersonal: DocumentOwnerType.PERSONAL,
          }).andWhere('d.ownerId = :scopeUserId', {
            scopeUserId: user.id,
          });
        }),
      );
      return;
    }
    qb.andWhere(
      new Brackets((q) => {
        q.where(
          'd.ownerType = :scopePersonal AND d.ownerId = :scopeUserId',
          {
            scopePersonal: DocumentOwnerType.PERSONAL,
            scopeUserId: user.id,
          },
        ).orWhere(
          'd.ownerType IN (:...scopeOrgTypes) AND d.ownerId IN (:...scopeAncestorIds)',
          {
            scopeOrgTypes: [DocumentOwnerType.GROUP, DocumentOwnerType.DEPARTMENT],
            scopeAncestorIds: ancestorIds,
          },
        );
      }),
    );
  }

  /**
   * 是否可管理某组织节点（用于组织 CRUD/成员管理）
   * admin 全权；否则需在该节点或其祖先有 admin 角色
   */
  async canManageOrg(user: AuthUser, orgId: string): Promise<boolean> {
    if (user.role === UserRole.ADMIN) {
      return true;
    }
    const roles = await this.getManageableRoles(user.id);
    if (roles.length === 0) {
      return false;
    }
    const target = await this.organizationsService.findByIdOrNull(orgId);
    if (!target) {
      return false;
    }
    return roles.some(
      (r) =>
        r.role === UserOrgRoleValue.ADMIN &&
        (target.path === r.path || target.path.startsWith(r.path + '.')),
    );
  }
}
