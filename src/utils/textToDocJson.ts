/**
 * 将纯文本按双换行拆分段落，并解析 Markdown 语法：
 *   - # / ## / ### / #### → Heading 1~4
 *   - - / * → 无序列表项
 *   - 1. / 2. → 有序列表项
 *   - > → 块引用
 *   - **text** → 加粗
 *   - *text* → 斜体
 *   - ~~text~~ → 删除线
 *   - `text` → 行内代码
 *
 * 返回 ProseMirror JSON 文档（{ type: 'doc', content: [...] }）。
 */

/** 段落/块级节点的 ProseMirror JSON */
interface DocNode {
  type: string
  attrs?: Record<string, any>
  content?: DocNode[]
  text?: string
  marks?: DocMark[]
}

interface DocMark {
  type: string
  attrs?: Record<string, any>
}

// ── 内联格式化解析 ──────────────────────────────────────────

interface TextSegment {
  text: string
  marks: string[] // 'bold' | 'italic' | 'strike' | 'code'
}

/**
 * 从一段纯文本中解析内联 Markdown：
 *   **bold** | *italic* | ~~strike~~ | `code`
 *
 * 返回 ProseMirror text 节点的数组。
 */
function parseInlineFormatting(text: string): DocNode[] {
  if (!text) return []

  // 第一遍：找到所有标记位，按位置排序
  // 标记: [startPos, endPos, markerType]
  type Marker = { from: number; to: number; mark: string }
  const markers: Marker[] = []

  // 辅助：查找指定模式的所有位置（只记录，不替换）
  function findPairs(regex: RegExp, mark: string) {
    let m: RegExpExecArray | null
    while ((m = regex.exec(text)) !== null) {
      markers.push({
        from: m.index,                    // 内部文本起始
        to: m.index + m[1].length,       // 内部文本结束（exclusive）
        mark,
      })
    }
  }

  // 从最长标记到最短标记查找（避免 ** 内的 * 被误匹配）
  findPairs(/\*\*(.+?)\*\*/g, 'bold')     // **bold**
  findPairs(/~~(.+?)~~/g, 'strike')       // ~~strike~~
  findPairs(/`(.+?)`/g, 'code')           // `code`
  findPairs(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, 'italic') // *italic* (非 **)

  // 无标记 → 纯文本
  if (markers.length === 0) {
    return [{ type: 'text', text }]
  }

  // 按位置排序
  markers.sort((a, b) => a.from - b.from || b.to - a.to)

  // 去重：移除完全重复的区间（同一区间被多个 regex 匹配）
  const unique: Marker[] = []
  for (const m of markers) {
    const dup = unique.find(u => u.from === m.from && u.to === m.to)
    if (!dup) unique.push(m)
  }

  // 按 from 排序，区间不重叠就保留；重叠时优先长区间（外层的 bold 优先于内层 italic）
  unique.sort((a, b) => a.from - b.from || b.to - a.from)

  // 合并重叠标记：同一个文本区间可以同时有 bold + italic
  // 用区间索引聚合
  const finalRanges: { from: number; to: number; marks: string[] }[] = []
  for (const m of unique) {
    // 查找是否有完全相同的区间
    const existing = finalRanges.find(r => r.from === m.from && r.to === m.to)
    if (existing) {
      existing.marks.push(m.mark)
    } else {
      finalRanges.push({ from: m.from, to: m.to, marks: [m.mark] })
    }
  }

  // 按位置排序
  finalRanges.sort((a, b) => a.from - b.from)

  // 构建文本片段（格式化区间 + 纯文本间隙）
  const segments: TextSegment[] = []
  let pos = 0

  for (const range of finalRanges) {
    // 前面的纯文本
    if (pos < range.from) {
      segments.push({ text: text.slice(pos, range.from), marks: [] })
    }
    // 格式化文本
    segments.push({
      text: text.slice(range.from, range.to),
      marks: range.marks,
    })
    pos = range.to
  }
  // 尾部纯文本
  if (pos < text.length) {
    segments.push({ text: text.slice(pos), marks: [] })
  }

  // 转为 ProseMirror text 节点（合并相邻同 marks 段）
  const nodes: DocNode[] = []
  for (const seg of segments) {
    const last = nodes[nodes.length - 1]
    const marksEqual =
      last &&
      last.text !== undefined &&
      JSON.stringify(last.marks?.map((m: any) => m.type).sort()) ===
        JSON.stringify([...seg.marks].sort())

    if (marksEqual) {
      last.text! += seg.text
    } else {
      nodes.push({
        type: 'text',
        text: seg.text,
        ...(seg.marks.length > 0
          ? { marks: seg.marks.map(m => ({ type: m })) }
          : {}),
      })
    }
  }

  return nodes
}

// ── 块级解析 ────────────────────────────────────────────────

/**
 * 将一行文本解析为块级节点（heading / bulletList / orderedList / blockquote）。
 * 返回该段落的首个顶层节点定义（不含 doc 包裹）。
 */
function parseBlockLine(line: string): DocNode {
  const trimmed = line.trim()
  if (!trimmed) return { type: 'paragraph' }

  // 分隔线：--- / *** / ___
  if (/^[\-\*_]{3,}$/.test(trimmed)) {
    return { type: 'horizontalRule' }
  }

  // 标题：### Title
  const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)/)
  if (headingMatch) {
    const level = headingMatch[1].length as 1 | 2 | 3 | 4
    return {
      type: 'heading',
      attrs: { level },
      content: parseInlineFormatting(headingMatch[2]),
    }
  }

  // 无序列表：- / *
  const ulMatch = trimmed.match(/^[\-\*]\s+(.+)/)
  if (ulMatch) {
    return {
      type: 'bulletList',
      content: [{
        type: 'listItem',
        content: [{ type: 'paragraph', content: parseInlineFormatting(ulMatch[1]) }],
      }],
    }
  }

  // 有序列表：1. / 2)
  const olMatch = trimmed.match(/^\d+[\.\)]\s+(.+)/)
  if (olMatch) {
    return {
      type: 'orderedList',
      content: [{
        type: 'listItem',
        content: [{ type: 'paragraph', content: parseInlineFormatting(olMatch[1]) }],
      }],
    }
  }

  // 块引用：> text
  const bqMatch = trimmed.match(/^>\s*(.+)/)
  if (bqMatch) {
    return {
      type: 'blockquote',
      content: [{ type: 'paragraph', content: parseInlineFormatting(bqMatch[1]) }],
    }
  }

  // 普通段落
  return { type: 'paragraph', content: parseInlineFormatting(trimmed) }
}

/**
 * 合并连续的同类型列表节点。
 * 例如连续多个 bulletList 行 → 合并为一个 bulletList，内含多个 listItem。
 */
function mergeConsecutiveLists(nodes: DocNode[]): DocNode[] {
  const merged: DocNode[] = []

  for (const node of nodes) {
    const last = merged[merged.length - 1]
    if (
      last &&
      (last.type === 'bulletList' || last.type === 'orderedList') &&
      last.type === node.type &&
      node.content?.[0]?.type === 'listItem'
    ) {
      // 同类型列表 → 合并 listItem
      last.content!.push(node.content[0])
    } else {
      merged.push(node)
    }
  }

  return merged
}

// ── 入口 ────────────────────────────────────────────────────

export function textToDocJson(text: string): any {
  if (!text) return { type: 'doc', content: [] }

  // 按单换行拆分，逐行解析（兼容旧 Markdown 数据中单 \n 分隔的标题/列表/段落）
  const lines = text.split(/\r?\n/)

  // 每行解析为块级节点
  const nodes: DocNode[] = []
  for (const line of lines) {
    if (!line.trim()) continue // 跳过空行
    nodes.push(parseBlockLine(line))
  }

  // 合并连续列表
  const merged = mergeConsecutiveLists(nodes)

  return { type: 'doc', content: merged }
}
