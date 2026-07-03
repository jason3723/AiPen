import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { textToDocJson } from "../utils/textToDocJson";

// ─── 类型定义 ────────────────────────────────────────────────

export interface MaterialTag {
  id: string;
  name: string;
}

export interface Material {
  id: string;
  title: string;
  content: string;
  source_url: string | null;
  source_title: string | null;
  created_at: string;
  updated_at: string;
  tags: MaterialTag[];
}

// ─── 辅助函数 ────────────────────────────────────────────────

/** 从素材 content（DB 中的字符串）解析为 ProseMirror JSON 文档 */
function parseMaterialContent(raw: string): any {
  if (!raw) return { type: 'doc', content: [] }
  // 尝试 ProseMirror JSON
  try {
    const parsed = JSON.parse(raw)
    if (parsed && parsed.type === 'doc') {
      return parsed
    }
  } catch {}
  // 纯文本 → 按双换行拆分段落 + 解析 Markdown
  return textToDocJson(raw)
}

/** 从素材 content（可能是 JSON 字符串或纯文本）中提取纯文本 */
function extractMaterialText(content: string): string {
  if (!content) return ''
  try {
    const parsed = JSON.parse(content)
    if (parsed && parsed.type === 'doc') {
      return extractTextFromDoc(parsed)
    }
  } catch {}
  return content
}

/** DB 存的是 UTC 时间（"2026-07-03 16:58:00"），转换为本地时间显示 */
function formatMaterialTime(ts: string | null | undefined): string {
  if (!ts) return '';
  try {
    // 归一化为 ISO 8601 UTC 格式："2026-07-03 16:58:00" → "2026-07-03T16:58:00Z"
    const normalized = ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z';
    const d = new Date(normalized);
    if (isNaN(d.getTime())) return ts.slice(0, 16).replace('T', ' ');
    return d.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return ts.slice(0, 16).replace('T', ' ');
  }
}

/** 递归提取 ProseMirror 文档中的所有文本 */
function extractTextFromDoc(node: any): string {
  let text = ''
  if (node.text) text += node.text
  if (node.content && Array.isArray(node.content)) {
    for (const child of node.content) {
      text += extractTextFromDoc(child)
    }
  }
  return text
}

export interface Bookmark {
  id: string;
  url: string;
  title: string;
  created_at: string;
}

export interface SuggestTagsResult {
  matched_tags: string[];
  suggested_new_tags: string[];
}

export interface MaterialOffset {
  from: number;
  to: number;
  matId: string;
}

export interface TagDocumentGroup {
  tag: MaterialTag | null; // null = 未分类
  materials: Material[];
  content: string;
  materialOffsets: MaterialOffset[]; // 每个素材在 content 中的位置范围（Markdown 文本坐标）
}

/** 标签 + 素材数量（用于素材库上下文选择器） */
export interface TagWithCount {
  id: string;
  name: string;
  material_count: number;
}

// ─── Store ────────────────────────────────────────────────────

export const useMaterialStore = defineStore("material", () => {
  const materials = ref<Material[]>([]);
  const tags = ref<MaterialTag[]>([]);
  const tagWithCounts = ref<TagWithCount[]>([]);
  const bookmarks = ref<Bookmark[]>([]);
  const currentMaterialId = ref<string | null>(null);
  const currentMaterialContent = ref<any>("");
  const currentTagDocumentId = ref<string | null>(null); // 当前选中的标签文档（null=未分类）
  /** 当前标签文档中素材的显示顺序（与 buildCardDocumentJson 的卡片顺序一致） */
  const currentTagDocOrderedIds = ref<string[]>([]);
  const loading = ref({ materials: false, tags: false, bookmarks: false });

  // ── 素材标签选择（用于 AI 上下文注入） ──
  const selectedMaterialTagIds = ref<string[]>([]);

  function toggleMaterialTag(tagId: string) {
    const idx = selectedMaterialTagIds.value.indexOf(tagId);
    if (idx >= 0) {
      selectedMaterialTagIds.value.splice(idx, 1);
    } else {
      selectedMaterialTagIds.value.push(tagId);
    }
  }

  // ── 素材剪藏弹窗（跨组件共享，绕过 emit 机制） ──
  const clipText = ref('');
  const clipSourceUrl = ref<string | undefined>(undefined);
  const clipSourceTitle = ref<string | undefined>(undefined);
  const showClipDialog = ref(false);

  function openClipDialog(text: string, sourceUrl?: string, sourceTitle?: string) {
    clipText.value = text;
    clipSourceUrl.value = sourceUrl;
    clipSourceTitle.value = sourceTitle;
    showClipDialog.value = true;
  }

  function closeClipDialog() {
    showClipDialog.value = false;
  }

  // 当前选中的素材（单个）
  const currentMaterial = computed(() => {
    if (!currentMaterialId.value) return null;
    return materials.value.find(m => m.id === currentMaterialId.value) ?? null;
  });

  // 按标签分组的标签文档
  const tagDocumentGroups = computed<TagDocumentGroup[]>(() => {
    const groups = new Map<string, TagDocumentGroup>();

    for (const mat of materials.value) {
      if (mat.tags.length === 0) {
        // 未分类
        if (!groups.has("__uncategorized__")) {
          groups.set("__uncategorized__", {
            tag: null,
            materials: [],
            content: "",
            materialOffsets: [],
          });
        }
        const g = groups.get("__uncategorized__")!;
        g.materials.push(mat);
      } else {
        for (const tag of mat.tags) {
          if (!groups.has(tag.id)) {
            groups.set(tag.id, { tag, materials: [], content: "", materialOffsets: [] });
          }
          const g = groups.get(tag.id)!;
          if (!g.materials.find(m => m.id === mat.id)) {
            g.materials.push(mat);
          }
        }
      }
    }

    // 拼接每组内容，按时间正序，格式化输出
    for (const [, g] of groups) {
      const sorted = [...g.materials].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
      // 逐块拼接为 Markdown 卡片格式：标题 → 正文 → 元信息 → 分隔线
      const offsets: MaterialOffset[] = [];
      let content = '';
      for (let i = 0; i < sorted.length; i++) {
        const m = sorted[i];
        const bodyText = extractMaterialText(m.content);
        // 标题取 body 前 20 字
        const title = bodyText.slice(0, 20) || m.title;

        const parts: string[] = [];
        parts.push(`## 📌 ${title}`);
        parts.push(bodyText);
        // 元信息
        const metaParts: string[] = [];
        if (m.source_title || m.source_url) {
          const src = [m.source_title, m.source_url].filter(Boolean).join(' — ');
          metaParts.push(`📎 ${src}`);
        }
        const date = formatMaterialTime(m.created_at);
        metaParts.push(`🕐 ${date}`);
        if (metaParts.length > 0) {
          parts.push(`*${metaParts.join('  |  ')}*`);
        }

        const block = parts.join('\n\n');
        const from = content.length;
        content += block;
        const to = content.length;
        offsets.push({ from, to, matId: m.id });

        // 素材间分隔线
        if (i < sorted.length - 1) {
          content += "\n\n---\n\n";
        }
      }
      g.content = content;
      g.materialOffsets = offsets;
    }

    // 排序：有标签的在前（按标签名），未分类在最后
    return [...groups.values()].sort((a, b) => {
      if (!a.tag) return 1;
      if (!b.tag) return -1;
      return a.tag.name.localeCompare(b.tag.name);
    });
  });

  // ── Materials ──

  async function loadMaterials() {
    loading.value.materials = true;
    try {
      materials.value = await invoke<Material[]>("list_materials");
    } catch (e) {
      console.error("加载素材失败:", e);
    } finally {
      loading.value.materials = false;
    }
  }

  async function saveMaterial(
    content: string,
    sourceUrl?: string,
    sourceTitle?: string
  ): Promise<Material> {
    // 将纯文本转为 ProseMirror JSON 后存储
    const doc = textToDocJson(content);
    const contentStr = JSON.stringify(doc);
    const mat = await invoke<Material>("save_material", {
      content: contentStr,
      sourceUrl: sourceUrl ?? null,
      sourceTitle: sourceTitle ?? null,
    });
    materials.value.unshift(mat);
    return mat;
  }

  async function updateMaterialContent(matId: string, content: any) {
    // content 可能是 ProseMirror JSON 对象或纯文本字符串，统一序列化为字符串存 DB
    const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
    await invoke("update_material_content", { matId, content: contentStr });
    const idx = materials.value.findIndex(m => m.id === matId);
    if (idx !== -1) {
      materials.value[idx].content = contentStr;
      // 标题取 body 文本前 30 字
      const bodyText = extractMaterialText(contentStr);
      materials.value[idx].title = bodyText.slice(0, 30);
      materials.value[idx].updated_at = new Date().toISOString();
    }
  }

  async function deleteMaterial(matId: string) {
    await invoke("delete_material", { matId });
    materials.value = materials.value.filter(m => m.id !== matId);
    if (currentMaterialId.value === matId) {
      currentMaterialId.value = null;
      currentMaterialContent.value = "";
    }
  }

  async function setMaterialTags(matId: string, tagIds: string[]) {
    await invoke("set_material_tags", { matId, tagIds });
    await loadMaterials(); // 刷新以获取最新 tags
  }

  function selectMaterial(matId: string) {
    const mat = materials.value.find(m => m.id === matId);
    if (mat) {
      currentMaterialId.value = matId;
      currentTagDocumentId.value = null;
      currentMaterialContent.value = parseMaterialContent(mat.content);
    }
  }

  /** 选择标签文档：合并该标签下所有素材为一个卡片文档 */
  function selectTagDocument(tagId: string | null) {
    const key = tagId ?? "__uncategorized__";
    const group = tagDocumentGroups.value.find(g => {
      if (tagId === null) return g.tag === null;
      return g.tag?.id === tagId;
    });
    if (group) {
      currentMaterialId.value = null;
      currentTagDocumentId.value = key;
      // 按时间排序（与 buildCardDocumentJson 一致）
      const sorted = [...group.materials].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
      currentTagDocOrderedIds.value = sorted.map(m => m.id);
      currentMaterialContent.value = buildCardDocumentJson(sorted);
    }
  }

  /**
   * 将一组素材构建为卡片式 ProseMirror JSON 文档。
   * 每张卡片：h2 标题 → 正文段落 → em 元信息 → hr 分隔线
   * 直接构建 JSON，不经过 Markdown 文本中转，避免解析歧义。
   */
  function buildCardDocumentJson(materials: Material[]): any {
    const sorted = [...materials].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    const content: any[] = [];

    for (let i = 0; i < sorted.length; i++) {
      const m = sorted[i];
      const bodyText = extractMaterialText(m.content);

      // 标题选取优先级：source_title > m.title > 正文首句 > "摘录"
      const cardTitle = pickCardTitle(m, bodyText);

      // 卡片标题 h2
      content.push({
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: `📌 ${cardTitle}` }],
      });

      // 正文：按换行拆为段落
      const bodyLines = bodyText.split('\n').filter(line => line.trim());
      for (const line of bodyLines) {
        content.push({
          type: 'paragraph',
          content: [{ type: 'text', text: line }],
        });
      }

      // 元信息（em 斜体）
      const metaParts: string[] = [];
      // 有来源时元信息只保留 URL（标题已在 h2 显示）和日期
      if (m.source_url && (!m.source_title || m.source_url !== m.source_title)) {
        metaParts.push(`🔗 ${m.source_url}`);
      }
      const date = formatMaterialTime(m.created_at);
      metaParts.push(`🕐 ${date}`);
      if (metaParts.length > 0) {
        content.push({
          type: 'paragraph',
          content: [{
            type: 'text',
            text: metaParts.join('  |  '),
            marks: [{ type: 'italic' }],
          }],
        });
      }

      // 素材间分隔线
      if (i < sorted.length - 1) {
        content.push({ type: 'horizontalRule' });
      }
    }

    return { type: 'doc', content };
  }

  /**
   * 为卡片选取最佳标题。
   * 优先级：source_title（来源标题最完整）> m.title > 正文首句（智能断句）> "📝 摘录"
   */
  function pickCardTitle(m: Material, bodyText: string): string {
    // 1. 来源标题（网页/文章标题，最有意义）
    if (m.source_title?.trim()) return truncate(m.source_title.trim(), 40);
    // 2. 素材自身标题
    if (m.title?.trim()) return truncate(m.title.trim(), 40);
    // 3. 正文首句（按标点断句，避免半句话）
    if (bodyText.trim()) {
      const firstSentence = extractFirstSentence(bodyText);
      if (firstSentence) return firstSentence;
    }
    return '📝 摘录';
  }

  /** 从文本开头提取第一个完整句子（支持中英文标点） */
  function extractFirstSentence(text: string): string | null {
    // 匹配到第一个句号/问号/感叹号/分号
    const match = text.match(/^.{1,60}[。！？;！？\.!\?]/);
    if (match) return match[0];
    // 无标点则截取前 35 字加省略号
    const truncated = text.slice(0, 35).trim();
    if (truncated) return truncated + '...';
    return null;
  }

  /** 截断文本，超长时加省略号 */
  function truncate(s: string, maxLen: number): string {
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen - 1) + '…';
  }

  /**
   * 根据卡片文档中的 ProseMirror 位置，定位所属素材 ID。
   * 卡片结构：每素材 = [h2, p..., p(em), (hr)]，按 h2 边界切分。
   */
  function resolveDocPositionToMaterial(doc: any, pos: number): string | null {
    if (!doc?.content || currentTagDocOrderedIds.value.length === 0) return null;
    let cardIndex = -1;
    let accumulatedPos = 0;
    for (const node of doc.content) {
      const nodeSize = nodeSizeOf(node);
      if (node.type === 'heading') cardIndex++;
      if (pos >= accumulatedPos && pos < accumulatedPos + nodeSize) {
        if (cardIndex >= 0 && cardIndex < currentTagDocOrderedIds.value.length) {
          return currentTagDocOrderedIds.value[cardIndex];
        }
        return null;
      }
      accumulatedPos += nodeSize;
    }
    // pos 可能在最后一个节点末尾附近
    if (cardIndex >= 0 && cardIndex < currentTagDocOrderedIds.value.length) {
      return currentTagDocOrderedIds.value[cardIndex];
    }
    return null;
  }

  /** 估算 ProseMirror 节点的文档大小 */
  function nodeSizeOf(node: any): number {
    if (!node) return 1;
    if (node.text !== undefined) return node.text.length; // text leaf
    if (node.content?.length) {
      // block 节点: content size + 前后各 1 个 position (open/start)
      let inner = 0;
      for (const child of node.content) {
        inner += nodeSizeOf(child);
      }
      return inner + 2; // 每个块级节点前后各占 1 位
    }
    // empty block (如 hr, empty paragraph)
    return 2; // hr = 2 (start + end), empty p = 2
  }

  // ── Tags ──

  async function loadTags() {
    loading.value.tags = true;
    try {
      tags.value = await invoke<MaterialTag[]>("list_tags");
    } catch (e) {
      console.error("加载标签失败:", e);
    } finally {
      loading.value.tags = false;
    }
  }

  async function loadTagWithCounts() {
    try {
      tagWithCounts.value = await invoke<TagWithCount[]>("list_tags_with_count");
    } catch (e) {
      console.error("加载标签计数失败:", e);
    }
  }

  async function createTag(name: string): Promise<MaterialTag> {
    const tag = await invoke<MaterialTag>("create_tag", { name });
    if (!tags.value.find(t => t.id === tag.id)) {
      tags.value.push(tag);
    }
    return tag;
  }

  async function deleteTag(tagId: string) {
    try {
      await invoke("delete_tag", { tagId });
    } catch (e) {
      // DB 操作可能失败（如标签已被其他方式删除），但本地状态必须清理
      console.warn("删除标签DB操作失败，将清理本地状态:", e);
    }
    // 无论如何都从本地状态移除
    tags.value = tags.value.filter(t => t.id !== tagId);
    // 重新加载素材（标签引用可能变化）
    await loadMaterials();
  }

  async function renameTag(tagId: string, newName: string) {
    await invoke("rename_tag", { tagId, newName });
    const tag = tags.value.find(t => t.id === tagId);
    if (tag) {
      tag.name = newName;
    }
    await loadMaterials();
  }

  // ── AI 打标签 ──

  async function suggestTags(content: string): Promise<SuggestTagsResult> {
    return invoke<SuggestTagsResult>("suggest_tags", { content });
  }

  // ── Bookmarks ──

  async function loadBookmarks() {
    loading.value.bookmarks = true;
    try {
      bookmarks.value = await invoke<Bookmark[]>("list_bookmarks");
    } catch (e) {
      console.error("加载书签失败:", e);
    } finally {
      loading.value.bookmarks = false;
    }
  }

  async function addBookmark(url: string, title: string): Promise<Bookmark> {
    const bm = await invoke<Bookmark>("add_bookmark", { url, title });
    bookmarks.value.unshift(bm);
    return bm;
  }

  async function deleteBookmark(bmId: string) {
    await invoke("delete_bookmark", { bmId });
    bookmarks.value = bookmarks.value.filter(b => b.id !== bmId);
  }

  // ── 迁移：将现有纯文本素材转为 ProseMirror JSON ──
  async function migrateMaterialsToJson() {
    const needsMigration: { id: string; content: string }[] = []
    for (const mat of materials.value) {
      if (!mat.content) continue
      try {
        const parsed = JSON.parse(mat.content)
        if (parsed && parsed.type === 'doc') continue // 已是 JSON，跳过
      } catch {}
      // 纯文本，需迁移
      needsMigration.push({ id: mat.id, content: mat.content })
    }
    if (needsMigration.length === 0) return

    for (const { id, content: text } of needsMigration) {
      const doc = textToDocJson(text)
      const jsonStr = JSON.stringify(doc)
      try {
        await invoke("update_material_content", { matId: id, content: jsonStr })
        // 更新本地状态
        const idx = materials.value.findIndex(m => m.id === id)
        if (idx !== -1) {
          materials.value[idx].content = jsonStr
          materials.value[idx].title = extractMaterialText(jsonStr).slice(0, 30)
        }
      } catch (e) {
        console.warn(`迁移素材 ${id} 失败:`, e)
      }
    }
    if (needsMigration.length > 0) {
      console.log(`已迁移 ${needsMigration.length} 条素材为 JSON 格式`)
    }
  }

  // 初始化：加载所有数据
  async function init() {
    await Promise.all([loadMaterials(), loadTags(), loadTagWithCounts(), loadBookmarks()]);
    // 加载完成后自动迁移旧素材
    await migrateMaterialsToJson();
  }

  return {
    materials,
    tags,
    tagWithCounts,
    selectedMaterialTagIds,
    bookmarks,
    currentMaterialId,
    currentTagDocumentId,
    currentTagDocOrderedIds,
    currentMaterialContent,
    currentMaterial,
    tagDocumentGroups,
    loading,
    clipText,
    clipSourceUrl,
    clipSourceTitle,
    showClipDialog,
    openClipDialog,
    closeClipDialog,
    toggleMaterialTag,
    loadMaterials,
    saveMaterial,
    updateMaterialContent,
    deleteMaterial,
    setMaterialTags,
    selectMaterial,
    selectTagDocument,
    resolveDocPositionToMaterial,
    loadTags,
    loadTagWithCounts,
    createTag,
    deleteTag,
    renameTag,
    suggestTags,
    loadBookmarks,
    addBookmark,
    deleteBookmark,
    init,
  };
});
