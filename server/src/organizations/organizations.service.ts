import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Organization,
  OrganizationType,
} from './organization.entity';
import {
  UserOrgRole,
  UserOrgRoleValue,
} from './user-org-role.entity';
import { User } from '../users/user.entity';
import { Document } from '../documents/document.entity';

/**
 * 成员授权 + 用户基本信息（列表响应）
 */
export interface MemberWithUser {
  id: string;
  userId: string;
  orgId: string;
  role: UserOrgRoleValue;
  createdAt: Date;
  username: string;
  email: string;
}

/**
 * 组织服务
 * - seedIfEmpty：首次启动 seed 两个示例部门含子组
 * - 树查询 / CRUD / 成员授权
 *
 * path 物化路径维护：顶层节点 path = id，子节点 path = `${parent.path}.${id}`
 */
@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(
    @InjectRepository(Organization)
    private readonly orgRepo: Repository<Organization>,
    @InjectRepository(UserOrgRole)
    private readonly userOrgRoleRepo: Repository<UserOrgRole>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Document)
    private readonly documentRepo: Repository<Document>,
  ) {}

  /**
   * 启动时若 organizations 表为空，seed 两个示例部门各含一个组
   * 研发部 / 前端组、产品部 / 需求组，便于联调
   */
  async seedIfEmpty(): Promise<void> {
    const count = await this.orgRepo.count();
    if (count > 0) {
      return;
    }

    const dept1 = this.orgRepo.create({
      name: '研发部',
      type: OrganizationType.DEPARTMENT,
      parentId: null,
      sort: 0,
      path: '',
    });
    const savedDept1 = await this.orgRepo.save(dept1);
    savedDept1.path = savedDept1.id;
    await this.orgRepo.save(savedDept1);

    const group1 = this.orgRepo.create({
      name: '前端组',
      type: OrganizationType.GROUP,
      parentId: savedDept1.id,
      sort: 0,
      path: '',
    });
    const savedGroup1 = await this.orgRepo.save(group1);
    savedGroup1.path = `${savedDept1.path}.${savedGroup1.id}`;
    await this.orgRepo.save(savedGroup1);

    const dept2 = this.orgRepo.create({
      name: '产品部',
      type: OrganizationType.DEPARTMENT,
      parentId: null,
      sort: 1,
      path: '',
    });
    const savedDept2 = await this.orgRepo.save(dept2);
    savedDept2.path = savedDept2.id;
    await this.orgRepo.save(savedDept2);

    const group2 = this.orgRepo.create({
      name: '需求组',
      type: OrganizationType.GROUP,
      parentId: savedDept2.id,
      sort: 0,
      path: '',
    });
    const savedGroup2 = await this.orgRepo.save(group2);
    savedGroup2.path = `${savedDept2.path}.${savedGroup2.id}`;
    await this.orgRepo.save(savedGroup2);

    this.logger.log('已 seed 示例组织：研发部/前端组、产品部/需求组');
  }

  /**
   * 查询全部组织节点（扁平），前端自行构建树
   */
  async findAll(): Promise<Organization[]> {
    return this.orgRepo.find({ order: { sort: 'ASC', createdAt: 'ASC' } });
  }

  /**
   * 按 id 查询单个组织节点
   */
  async findById(id: string): Promise<Organization> {
    const org = await this.orgRepo.findOne({ where: { id } });
    if (!org) {
      throw new NotFoundException(`组织节点 ${id} 不存在`);
    }
    return org;
  }

  /**
   * 按 id 查询组织节点，不存在返回 null（用于解析用户所属组织，避免抛错阻断登录）
   */
  async findByIdOrNull(id: string): Promise<Organization | null> {
    return this.orgRepo.findOne({ where: { id } });
  }

  /**
   * 计算新节点 path：顶层为自身 id，子节点为 `${parent.path}.${id}`
   * 调用方需先 save 拿到 id 再回填 path
   */
  private buildPath(parent: Organization | null, selfId: string): string {
    return parent ? `${parent.path}.${selfId}` : selfId;
  }

  /**
   * 新建组织节点
   * - type=department 时 parentId 必须为 null
   * - type=group 时 parentId 必须存在且为 department
   * - 同级（同 parent）重名拒绝
   */
  async create(input: {
    name: string;
    type: OrganizationType;
    parentId: string | null;
    sort?: number;
  }): Promise<Organization> {
    const { name, type, parentId } = input;

    if (type === OrganizationType.DEPARTMENT && parentId) {
      throw new BadRequestException('部门为顶层节点，不能有 parent');
    }
    let parent: Organization | null = null;
    if (parentId) {
      parent = await this.findById(parentId);
      if (parent.type !== OrganizationType.DEPARTMENT) {
        throw new BadRequestException('组只能挂在部门下');
      }
    }
    if (type === OrganizationType.GROUP && !parent) {
      throw new BadRequestException('组必须挂在某个部门下');
    }

    // 同级重名校验
    const dup = await this.orgRepo.findOne({
      where: { parentId: parentId ?? null, name },
    });
    if (dup) {
      throw new BadRequestException('同级已存在同名节点');
    }

    const node = this.orgRepo.create({
      name,
      type,
      parentId: parentId ?? null,
      sort: input.sort ?? 0,
      // path 先占位，save 后回填
      path: '',
    });
    const saved = await this.orgRepo.save(node);
    saved.path = this.buildPath(parent, saved.id);
    return this.orgRepo.save(saved);
  }

  /**
   * 改名 / 排序（不支持移动 parent，避免子树 path 重算复杂度）
   */
  async update(
    id: string,
    input: { name?: string; sort?: number },
  ): Promise<Organization> {
    const node = await this.findById(id);
    if (input.name !== undefined && input.name !== node.name) {
      const dup = await this.orgRepo.findOne({
        where: { parentId: node.parentId, name: input.name },
      });
      if (dup && dup.id !== id) {
        throw new BadRequestException('同级已存在同名节点');
      }
      node.name = input.name;
    }
    if (input.sort !== undefined) {
      node.sort = input.sort;
    }
    return this.orgRepo.save(node);
  }

  /**
   * 删除节点：拒绝有子节点或关联文档的节点
   * 关联文档 = ownerId 指向该节点的 group/department 文档
   */
  async remove(id: string): Promise<void> {
    const node = await this.findById(id);
    const childCount = await this.orgRepo.count({
      where: { parentId: id },
    });
    if (childCount > 0) {
      throw new BadRequestException('存在子节点，不能删除');
    }
    const docCount = await this.documentRepo.count({
      where: { ownerId: id },
    });
    if (docCount > 0) {
      throw new BadRequestException('该节点下存在关联文档，不能删除');
    }
    // 清理该节点的成员授权
    await this.userOrgRoleRepo.delete({ orgId: id });
    await this.orgRepo.remove(node);
  }

  /**
   * 查询某组织节点的成员授权列表（含 user 基本信息）
   * 返回 UserOrgRole 关联，controller 层 join users 取 username
   */
  async listMembers(orgId: string): Promise<UserOrgRole[]> {
    await this.findById(orgId);
    return this.userOrgRoleRepo.find({ where: { orgId } });
  }

  /**
   * 查询某组织节点的成员授权列表并 join 用户基本信息（username/email）
   * 供前端成员管理表格展示
   */
  async listMembersWithUser(orgId: string): Promise<MemberWithUser[]> {
    await this.findById(orgId);
    const roles = await this.userOrgRoleRepo.find({ where: { orgId } });
    if (roles.length === 0) {
      return [];
    }
    const users = await this.userRepo.find({
      where: roles.map((r) => ({ id: r.userId })),
      select: ['id', 'username', 'email'],
    });
    const userMap = new Map(users.map((u) => [u.id, u]));
    return roles
      .map((r) => {
        const u = userMap.get(r.userId);
        if (!u) return null;
        return {
          id: r.id,
          userId: r.userId,
          orgId: r.orgId,
          role: r.role,
          createdAt: r.createdAt,
          username: u.username,
          email: u.email,
        } satisfies MemberWithUser;
      })
      .filter((x): x is MemberWithUser => x !== null);
  }

  /**
   * 给组织节点添加成员授权
   */
  async addMember(
    orgId: string,
    userId: string,
    role: UserOrgRoleValue,
  ): Promise<UserOrgRole> {
    await this.findById(orgId);
    const exists = await this.userOrgRoleRepo.findOne({
      where: { orgId, userId },
    });
    if (exists) {
      throw new BadRequestException('该用户在此节点已有授权，请用更新接口');
    }
    const row = this.userOrgRoleRepo.create({ orgId, userId, role });
    return this.userOrgRoleRepo.save(row);
  }

  /**
   * 更新成员授权角色
   */
  async updateMemberRole(
    orgId: string,
    userId: string,
    role: UserOrgRoleValue,
  ): Promise<UserOrgRole> {
    const row = await this.userOrgRoleRepo.findOne({
      where: { orgId, userId },
    });
    if (!row) {
      throw new NotFoundException('该用户在此节点无授权');
    }
    row.role = role;
    return this.userOrgRoleRepo.save(row);
  }

  /**
   * 移除成员授权
   */
  async removeMember(orgId: string, userId: string): Promise<void> {
    const row = await this.userOrgRoleRepo.findOne({
      where: { orgId, userId },
    });
    if (!row) {
      return;
    }
    await this.userOrgRoleRepo.remove(row);
  }

  /**
   * 查询用户拥有的全部组织授权（用于 AccessControlService 计算可编辑范围）
   */
  async getUserOrgRoles(userId: string): Promise<UserOrgRole[]> {
    return this.userOrgRoleRepo.find({ where: { userId } });
  }

  /**
   * 查询用户组织授权并附带 org path（用于编辑权限的祖先继承判断）
   * 返回 { orgId, path, role } 列表
   */
  async getUserOrgRolesWithPath(
    userId: string,
  ): Promise<{ orgId: string; path: string; role: UserOrgRoleValue }[]> {
    const roles = await this.userOrgRoleRepo.find({ where: { userId } });
    if (roles.length === 0) {
      return [];
    }
    const orgs = await this.orgRepo.find({
      where: roles.map((r) => ({ id: r.orgId })),
    });
    const pathMap = new Map(orgs.map((o) => [o.id, o.path]));
    return roles.map((r) => ({
      orgId: r.orgId,
      path: pathMap.get(r.orgId) ?? '',
      role: r.role,
    }));
  }
}
