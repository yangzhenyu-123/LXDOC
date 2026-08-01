import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

/**
 * 附件类型枚举
 * - FILE: 普通附件文件（落盘到 attachments/<docId>/<file>），通过 kkFileView 预览
 * - DOCUMENT: 文档集成员引用（指向另一个 documents.id，实现"文档集"）
 */
export enum AttachmentType {
  FILE = 'file',
  DOCUMENT = 'document',
}

/**
 * 文档附件实体
 *
 * 统一承载两种语义：
 * 1. 普通附件文件（attach_type='file'）：上传到主文档的配套文件（代码/工具/测试包等），
 *    落盘到 attachments/<docId>/<file>，通过 kkFileView 预览。
 * 2. 文档集成员引用（attach_type='document'）：主文档是"文档集"（is_collection=true）时，
 *    通过 linked_document_id 引用另一个文档作为集合成员，被引用文档仍可独立访问。
 *
 * 权限：附件权限完全继承主文档（document_id 指向的文档），无独立权限。
 */
@Entity('document_attachments')
@Index(['documentId', 'sort'])
export class DocumentAttachment {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  // 主文档 id（附件绑定到的文档；文档集场景下指向集合主文档）
  @Index()
  @Column({ name: 'document_id', type: 'uuid' })
  documentId: string;

  // 附件类型：file=普通附件文件，document=文档集成员引用
  @Column({ name: 'attach_type', type: 'varchar', length: 20 })
  attachType: string;

  // 显示名（file 类型为文件名，document 类型为成员文档标题）
  @Column({ type: 'varchar', length: 200 })
  name: string;

  // 仅 file 类型：附件文件相对路径（attachments/<docId>/<file>）
  @Column({ name: 'file_path', type: 'varchar', length: 500, nullable: true })
  filePath: string | null;

  // 仅 file 类型：文件大小（字节）
  @Column({ name: 'file_size', type: 'bigint', nullable: true })
  fileSize: number | null;

  // 仅 file 类型：文件扩展名（如 .zip .py）
  @Column({ name: 'file_ext', type: 'varchar', length: 20, nullable: true })
  fileExt: string | null;

  // 仅 document 类型：被引用的成员文档 id
  @Index()
  @Column({ name: 'linked_document_id', type: 'uuid', nullable: true })
  linkedDocumentId: string | null;

  // 排序值（数字越小越靠前）
  @Column({ type: 'int', default: 0 })
  sort: number;

  // 上传者/创建者
  @Index()
  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
