import client from './client';

// AI 知识库树节点（前端按 knowledgePath 构建的树结构）
export interface KnowledgeNode {
  // 目录节点：name=目录名，children=子节点；文档节点：name=标题， docId=文档 id
  name: string;
  path: string;
  type: 'dir' | 'doc';
  docId?: string;
  docFormat?: string;
  docUpdatedAt?: string;
  children?: KnowledgeNode[];
}

// 后端返回的 AI 总结文档项（扁平列表，前端构建树）
export interface KnowledgeDocItem {
  id: string;
  title: string;
  knowledgePath: string;
  format: string;
  updatedAt: string;
}

/**
 * 获取 AI 知识库所有文档（扁平列表，含 knowledgePath）
 * GET /documents/knowledge-tree
 * 后端返回 contentSource=ai_summary 的所有文档，前端按 knowledgePath 构建树
 */
export async function getKnowledgeTree(): Promise<KnowledgeDocItem[]> {
  const res = await client.get<KnowledgeDocItem[], KnowledgeDocItem[]>(
    '/documents/knowledge-tree',
  );
  return res ?? [];
}

/**
 * 将扁平文档列表按 knowledgePath 构建为树
 * path 格式："根目录/子目录/叶子"，按 / 分隔
 */
export function buildKnowledgeTree(docs: KnowledgeDocItem[]): KnowledgeNode[] {
  const root: KnowledgeNode = { name: '', path: '', type: 'dir', children: [] };
  const dirMap = new Map<string, KnowledgeNode>();
  dirMap.set('', root);

  for (const doc of docs) {
    const path = (doc.knowledgePath || '未分类').trim() || '未分类';
    const segs = path.split('/').map((s) => s.trim()).filter(Boolean);
    let cur = root;
    let curPath = '';
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      curPath = curPath ? `${curPath}/${seg}` : seg;
      let child = cur.children?.find(
        (c) => c.type === 'dir' && c.name === seg,
      );
      if (!child) {
        child = { name: seg, path: curPath, type: 'dir', children: [] };
        cur.children?.push(child);
        dirMap.set(curPath, child);
      }
      cur = child;
    }
    // 叶子：文档节点
    cur.children?.push({
      name: doc.title,
      path,
      type: 'doc',
      docId: doc.id,
      docFormat: doc.format,
      docUpdatedAt: doc.updatedAt,
    });
  }

  // 排序：目录在前，文档在后；同类按名称排序
  function sortNode(node: KnowledgeNode) {
    if (!node.children) return;
    node.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
    node.children.forEach(sortNode);
  }
  if (root.children) sortNode(root);
  return root.children ?? [];
}
