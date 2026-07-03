/**
 * 文本差分工具
 *
 * 采用 Myers 差分算法（字符级），输入原文和修正稿，输出操作序列。
 * 供 ComposeWorkbench 审查自动修复阶段使用：原文不动，逐操作回放 diff，
 * 配合编辑器的滚动 + 高亮能力实现"改哪看哪"的视觉效果。
 */

// ── 类型定义 ────────────────────────────────────────────────────

/** 一次差分操作（由 diff 算法产出） */
export interface DiffOp {
  type: 'equal' | 'delete' | 'insert'
  text: string
}

/** 合并后的可视化操作块（用于逐块回放到编辑器） */
export interface DiffChunk {
  kind: 'keep' | 'replace' | 'delete' | 'insert'
  /** 在原文中的起始位置（代码点偏移，非字节偏移） */
  oldPos: number
  /** 原文中被替换/删除的文本 */
  oldText: string
  /** 新文本（对 delete 为空串） */
  newText: string
  /** 应用后，高亮区域的起止位置（绝对偏移，便于编辑器定位） */
  highlightFrom: number
  highlightTo: number
}

// ── Myers 差分（O(ND) 时间 / 空间） ────────────────────────────

/**
 * 对两个字符串做字符级 diff，返回操作序列。
 * 中文文本中每个 Unicode 代码点视为一个"字符"。
 */
export function diffChars(a: string, b: string): DiffOp[] {
  const aChars = [...a]
  const bChars = [...b]
  const n = aChars.length
  const m = bChars.length

  // 短路径：一边为空
  if (n === 0 && m === 0) return []
  if (n === 0) return [{ type: 'insert', text: b }]
  if (m === 0) return [{ type: 'delete', text: a }]

  // 预处理等长公共前缀
  let prefix = 0
  while (prefix < n && prefix < m && aChars[prefix] === bChars[prefix]) {
    prefix++
  }

  // 预处理等长公共后缀
  let suffix = 0
  while (
    suffix < n - prefix &&
    suffix < m - prefix &&
    aChars[n - 1 - suffix] === bChars[m - 1 - suffix]
  ) {
    suffix++
  }

  const aMid = aChars.slice(prefix, n - suffix)
  const bMid = bChars.slice(prefix, m - suffix)

  const midOps = myersCompute(aMid, bMid)

  const result: DiffOp[] = []
  if (prefix > 0) {
    result.push({ type: 'equal', text: aChars.slice(0, prefix).join('') })
  }
  result.push(...midOps)
  if (suffix > 0) {
    result.push({
      type: 'equal',
      text: aChars.slice(n - suffix).join(''),
    })
  }

  return result
}

/** Myers 核心：对两个字符数组计算最短编辑脚本 */
function myersCompute(a: string[], b: string[]): DiffOp[] {
  const n = a.length
  const m = b.length

  if (n === 0 && m === 0) return []
  if (n === 0) return [{ type: 'insert', text: b.join('') }]
  if (m === 0) return [{ type: 'delete', text: a.join('') }]

  const max = n + m
  // v[k] 表示在 d 步时，对角线 k 上能到达的最远 x 坐标
  const v: number[] = new Array(2 * max + 1)
  // trace[d] 保存第 d 步的 v 快照，用于回溯
  const trace: number[][] = []

  // 初始化
  v[max + 1] = 0

  let x = 0
  let y = 0
  let d = 0

  for (d = 0; d <= max; d++) {
    trace.push([...v])

    for (let k = -d; k <= d; k += 2) {
      const idx = max + k

      // 向下走（删除 a 中的字符）
      let goDown = k === -d || (k !== d && v[idx - 1] < v[idx + 1])

      if (goDown) {
        x = v[idx + 1] // 从 k+1 向右
      } else {
        x = v[idx - 1] + 1 // 从 k-1 向下
      }

      y = x - k

      // 沿对角线尽可能走（匹配的字符）
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }

      v[idx] = x

      if (x >= n && y >= m) {
        // 找到解，回溯路径
        return backtrack(a, b, trace, d, max)
      }
    }
  }

  // 无法到达（理论上不会）
  return [
    { type: 'delete', text: a.join('') },
    { type: 'insert', text: b.join('') },
  ]
}

/** 从 trace 回溯出操作序列 */
function backtrack(
  a: string[],
  b: string[],
  trace: number[][],
  d: number,
  max: number,
): DiffOp[] {
  const ops: DiffOp[] = []
  let x = a.length
  let y = b.length

  for (let step = d; step >= 0; step--) {
    const v = trace[step]
    const k = x - y
    const idx = max + k

    let prevK: number
    let prevX: number

    if (k === -step || (k !== step && v[idx - 1] < v[idx + 1])) {
      // 来自 k+1 → 向右（x 不变）
      prevK = k + 1
      prevX = v[idx + 1]
    } else {
      // 来自 k-1 → 向下（x-1）
      prevK = k - 1
      prevX = v[idx - 1]
    }

    const prevY = prevX - prevK

    // 对角线（匹配）部分
    while (x > prevX && y > prevY) {
      x--
      y--
      ops.unshift({ type: 'equal', text: a[x] })
    }

    if (step > 0) {
      if (x === prevX) {
        // 水平移动 = insert
        y--
        ops.unshift({ type: 'insert', text: b[y] })
      } else {
        // 垂直移动 = delete
        x--
        ops.unshift({ type: 'delete', text: a[x] })
      }
    }
  }

  return ops
}

// ── 合并与优化 ──────────────────────────────────────────────────

/**
 * 将原始 diff 操作序列合并为适合编辑器回放的大块。
 *
 * 合并规则：
 * - 连续 equal → 1 个 keep
 * - delete + insert 相邻 → 1 个 replace（最直观）
 * - 孤立 delete → 删除块
 * - 孤立 insert → 插入块
 *
 * 同时计算每个块在原文中的位置和高亮区域。
 */
export function chunkDiffOps(ops: DiffOp[]): DiffChunk[] {
  const chunks: DiffChunk[] = []
  let oldPos = 0   // 当前在原文中的偏移
  let newPos = 0   // 当前在新文档中的偏移（影响高亮位置）
  let i = 0

  while (i < ops.length) {
    const op = ops[i]

    if (op.type === 'equal') {
      // 合并连续 equal
      let text = op.text
      while (i + 1 < ops.length && ops[i + 1].type === 'equal') {
        text += ops[++i].text
      }
      chunks.push({
        kind: 'keep',
        oldPos,
        oldText: text,
        newText: text,
        highlightFrom: newPos,
        highlightTo: newPos,
      })
      oldPos += text.length
      newPos += text.length
    } else if (op.type === 'delete') {
      let delText = op.text
      while (i + 1 < ops.length && ops[i + 1].type === 'delete') {
        delText += ops[++i].text
      }

      // 检查 delete 后是否紧接 insert → 合并为 replace
      if (i + 1 < ops.length && ops[i + 1].type === 'insert') {
        let insText = ops[++i].text
        while (i + 1 < ops.length && ops[i + 1].type === 'insert') {
          insText += ops[++i].text
        }
        chunks.push({
          kind: 'replace',
          oldPos,
          oldText: delText,
          newText: insText,
          highlightFrom: newPos,
          highlightTo: newPos + insText.length,
        })
        oldPos += delText.length
        newPos += insText.length
      } else {
        chunks.push({
          kind: 'delete',
          oldPos,
          oldText: delText,
          newText: '',
          highlightFrom: newPos,
          highlightTo: newPos,
        })
        oldPos += delText.length
        // newPos 不变（删除不增加新文档偏移）
      }
    } else if (op.type === 'insert') {
      let insText = op.text
      while (i + 1 < ops.length && ops[i + 1].type === 'insert') {
        insText += ops[++i].text
      }
      chunks.push({
        kind: 'insert',
        oldPos,
        oldText: '',
        newText: insText,
        highlightFrom: newPos,
        highlightTo: newPos + insText.length,
      })
      // oldPos 不变（插入不消耗原文）
      newPos += insText.length
    }

    i++
  }

  return chunks
}

/**
 * 便捷方法：对两个字符串做 diff，直接返回合并后的操作块。
 */
export function computeDiff(oldText: string, newText: string): DiffChunk[] {
  const ops = diffChars(oldText, newText)
  return chunkDiffOps(ops)
}

// ── 文本预览（调试用） ──────────────────────────────────────────

/** 生成人类可读的 diff 摘要 */
export function diffSummary(chunks: DiffChunk[]): string {
  const lines: string[] = []
  for (const c of chunks) {
    switch (c.kind) {
      case 'keep':
        if (c.oldText.length <= 6) {
          lines.push(`  ${c.oldText}`)
        } else {
          lines.push(`  ${c.oldText.slice(0, 6)}…`)
        }
        break
      case 'replace':
        lines.push(`- ${c.oldText.length <= 10 ? c.oldText : c.oldText.slice(0, 10) + '…'}`)
        lines.push(`+ ${c.newText.length <= 10 ? c.newText : c.newText.slice(0, 10) + '…'}`)
        break
      case 'delete':
        lines.push(`- ${c.oldText.length <= 10 ? c.oldText : c.oldText.slice(0, 10) + '…'} [删除]`)
        break
      case 'insert':
        lines.push(`+ ${c.newText.length <= 10 ? c.newText : c.newText.slice(0, 10) + '…'} [新增]`)
        break
    }
  }
  return lines.join('\n')
}
