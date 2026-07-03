use similar::{ChangeTag, TextDiff};
use serde::Serialize;
use serde_json::Value;

/// 字符级内联变化片段
#[derive(Debug, Clone, Serialize)]
pub struct InlineChange {
    pub tag: String,    // "equal" | "insert" | "delete"
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiffHunk {
    pub tag: String,      // "equal" | "insert" | "delete"
    pub content: String,
    /// 字符级内联对比：当该行与相邻行存在"修改"关系时填充，
    /// 前端据此渲染字级红/绿高亮，而非整行涂抹
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inline_changes: Option<Vec<InlineChange>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiffResult {
    pub hunks: Vec<DiffHunk>,
    pub additions: usize,
    pub deletions: usize,
}

/// 对 old/new 文本做字符级 diff，产出内联变化列表
fn inline_diff(old: &str, new: &str) -> Vec<InlineChange> {
    let diff = TextDiff::from_chars(old, new);
    let mut changes = Vec::new();
    for change in diff.iter_all_changes() {
        let tag = match change.tag() {
            ChangeTag::Equal => "equal",
            ChangeTag::Insert => "insert",
            ChangeTag::Delete => "delete",
        };
        changes.push(InlineChange {
            tag: tag.to_string(),
            content: change.value().to_string(),
        });
    }
    changes
}

/// 字符 Bigram Jaccard 相似度。
/// 相比字符集 Jaccard，bigram 捕捉了字符序列信息，
/// 对中文更敏感："今天天气很好"vs"今天下雨不好"在字符集层面高度重叠，
/// 但 bigram 层面完全不同（很好 vs 雨不）。
/// 阈值以上才做内联 Diff，避免把完全无关的两行硬做字符级对比。
///
/// 注意：不做长度差异预检查。两段内容相似但长度差异大的文本（如一端多了空行/空格/标点）
/// 在 bigram 层面仍然高度重叠，会得到高相似度并正确触发内联 diff；
/// 而内容完全无关的文本无论长度如何，bigram 相似度都会很低，不会被误判。
fn similarity(a: &str, b: &str) -> f64 {
    use std::collections::HashSet;

    let len_a = a.chars().count();
    let len_b = b.chars().count();
    if len_a == 0 && len_b == 0 {
        return 1.0;
    }

    // Bigram 集合
    let chars_a: Vec<char> = a.chars().collect();
    let chars_b: Vec<char> = b.chars().collect();
    let bigrams_a: HashSet<(char, char)> =
        chars_a.windows(2).map(|w| (w[0], w[1])).collect();
    let bigrams_b: HashSet<(char, char)> =
        chars_b.windows(2).map(|w| (w[0], w[1])).collect();

    let intersection = bigrams_a.intersection(&bigrams_b).count();
    let union = bigrams_a.union(&bigrams_b).count();

    if union == 0 {
        // 两条都是单字，回退到字符级
        let cs_a: HashSet<char> = chars_a.into_iter().collect();
        let cs_b: HashSet<char> = chars_b.into_iter().collect();
        let isect = cs_a.intersection(&cs_b).count();
        let un = cs_a.union(&cs_b).count();
        return if un == 0 { 1.0 } else { isect as f64 / un as f64 };
    }

    intersection as f64 / union as f64
}

const INLINE_SIMILARITY_THRESHOLD: f64 = 0.22;

// ── ProseMirror JSON → 纯文本提取 ──────────────────────────────

/// 递归遍历 ProseMirror JSON 节点树，提取纯文本内容。
/// 每个段落/标题/引用块作为一个独立行（末尾加 `\n`）。
/// 非 ProseMirror JSON（旧 markdown 等）原样返回，保持向后兼容。
pub fn prose_mirror_to_plain_text(input: &str) -> String {
    let v: Value = match serde_json::from_str(input) {
        Ok(v) => v,
        Err(_) => return input.to_string(),
    };
    // 必须是 ProseMirror doc 节点
    if v.get("type").and_then(|t| t.as_str()) != Some("doc") {
        return input.to_string();
    }

    let mut output = String::new();
    extract_text(&v, &mut output);

    // 去除末尾多余换行，保证与旧纯文本格式一致的尾部行为
    while output.ends_with('\n') {
        output.pop();
    }
    output
}

/// 行级块节点 → 递归处理子节点后追加 `\n`
const BLOCK_NODES: &[&str] = &["paragraph", "heading", "blockquote", "codeBlock"];

/// 容器节点 → 仅递归处理子节点，自身不产生换行
const CONTAINER_NODES: &[&str] = &["doc", "listItem", "bulletList", "orderedList"];

fn extract_text(node: &Value, output: &mut String) {
    let node_type = node
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("");

    match node_type {
        "text" => {
            if let Some(t) = node.get("text").and_then(|v| v.as_str()) {
                output.push_str(t);
            }
        }
        "hardBreak" => {
            output.push('\n');
        }
        "horizontalRule" => {
            output.push_str("---\n");
        }
        t if BLOCK_NODES.contains(&t) => {
            if let Some(content) = node.get("content").and_then(|v| v.as_array()) {
                for child in content {
                    extract_text(child, output);
                }
            }
            output.push('\n');
        }
        t if CONTAINER_NODES.contains(&t) => {
            if let Some(content) = node.get("content").and_then(|v| v.as_array()) {
                for child in content {
                    extract_text(child, output);
                }
            }
        }
        // 未知节点：有 content 子节点则递归，无则跳过
        _ => {
            if let Some(content) = node.get("content").and_then(|v| v.as_array()) {
                for child in content {
                    extract_text(child, output);
                }
            }
        }
    }
}

// ── Diff 主逻辑 ────────────────────────────────────────────────

pub fn diff_documents(old: &str, new: &str) -> DiffResult {
    // 先提取纯文本（ProseMirror JSON → 纯文本；旧 markdown 原样保留）
    let old_text = prose_mirror_to_plain_text(old);
    let new_text = prose_mirror_to_plain_text(new);

    // Normalize：确保两端以换行结尾，避免 from_lines 因尾部换行差异误判
    let old = if old_text.ends_with('\n') {
        old_text
    } else {
        format!("{}\n", old_text)
    };
    let new = if new_text.ends_with('\n') {
        new_text
    } else {
        format!("{}\n", new_text)
    };
    let diff = TextDiff::from_lines(&old, &new);
    let mut hunks = Vec::new();
    let mut additions = 0;
    let mut deletions = 0;

    for change in diff.iter_all_changes() {
        let tag = match change.tag() {
            ChangeTag::Equal => "equal",
            ChangeTag::Insert => { additions += 1; "insert" }
            ChangeTag::Delete => { deletions += 1; "delete" }
        };
        hunks.push(DiffHunk {
            tag: tag.to_string(),
            content: change.value().to_string(),
            inline_changes: None,
        });
    }

    // ── 第二遍：为 delete / insert 对注入字符级内联 Diff ──
    // TextDiff::from_lines 可能将连续多行变更合并为一个多行 hunk，
    // 也可能拆成 delete-delete-insert-insert 的分组模式。
    // 因此先收集连续 deletes + 连续 inserts 按位置配对，再对每对按 \n 拆分
    // 逐行独立计算相似度与内联 diff，避免整体 bigram 相似度被稀释。
    let mut i = 0;
    while i < hunks.len() {
        if hunks[i].tag == "delete" {
            // 收集连续 delete
            let mut del_indices = vec![i];
            let mut j = i + 1;
            while j < hunks.len() && hunks[j].tag == "delete" {
                del_indices.push(j);
                j += 1;
            }
            // 收集后续连续 insert
            let mut ins_indices = vec![];
            while j < hunks.len() && hunks[j].tag == "insert" {
                ins_indices.push(j);
                j += 1;
            }
            // 按位置逐一配对：delete[k] ↔ insert[k]
            let pair_count = del_indices.len().min(ins_indices.len());
            for k in 0..pair_count {
                let di = del_indices[k];
                let ii = ins_indices[k];

                let old_content = hunks[di].content.trim_end_matches('\n');
                let new_content = hunks[ii].content.trim_end_matches('\n');

                // 按行拆分，对每对子行分别做内联 diff
                let old_lines: Vec<&str> = old_content.lines().collect();
                let new_lines: Vec<&str> = new_content.lines().collect();
                let max_sub = old_lines.len().max(new_lines.len());

                let mut old_parts: Vec<InlineChange> = Vec::new();
                let mut new_parts: Vec<InlineChange> = Vec::new();

                for s in 0..max_sub {
                    let old_sub = old_lines.get(s).copied().unwrap_or("");
                    let new_sub = new_lines.get(s).copied().unwrap_or("");

                    // 子行间插入换行分隔符（非首子行）
                    if s > 0 {
                        old_parts.push(InlineChange { tag: "equal".to_string(), content: "\n".into() });
                        new_parts.push(InlineChange { tag: "equal".to_string(), content: "\n".into() });
                    }

                    if similarity(old_sub, new_sub) >= INLINE_SIMILARITY_THRESHOLD {
                        let sub_old = inline_diff(old_sub, new_sub);
                        let sub_new = inline_diff(old_sub, new_sub);
                        old_parts.extend(sub_old.into_iter().filter(|c| c.tag != "insert"));
                        new_parts.extend(sub_new.into_iter().filter(|c| c.tag != "delete"));
                    } else {
                        if !old_sub.is_empty() {
                            old_parts.push(InlineChange { tag: "delete".to_string(), content: old_sub.to_string() });
                        }
                        if !new_sub.is_empty() {
                            new_parts.push(InlineChange { tag: "insert".to_string(), content: new_sub.to_string() });
                        }
                    }
                }

                if !old_parts.is_empty() {
                    hunks[di].inline_changes = Some(old_parts);
                }
                if !new_parts.is_empty() {
                    hunks[ii].inline_changes = Some(new_parts);
                }
            }
            i = j; // 跳过整个 delete/insert 块
        } else {
            i += 1;
        }
    }

    DiffResult { hunks, additions, deletions }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_diff_identical() {
        let result = diff_documents("hello\nworld", "hello\nworld");
        assert_eq!(result.additions, 0);
        assert_eq!(result.deletions, 0);
    }

    #[test]
    fn test_diff_addition() {
        let result = diff_documents("hello", "hello\nworld");
        assert_eq!(result.additions, 1);
        assert_eq!(result.deletions, 0);
        assert_eq!(result.hunks.len(), 2);
        assert_eq!(result.hunks[0].tag, "equal");
        assert_eq!(result.hunks[1].tag, "insert");
    }

    #[test]
    fn test_diff_deletion() {
        let result = diff_documents("hello\nworld", "hello");
        assert_eq!(result.additions, 0);
        assert_eq!(result.deletions, 1);
        assert_eq!(result.hunks.len(), 2);
        assert_eq!(result.hunks[0].tag, "equal");
        assert_eq!(result.hunks[1].tag, "delete");
    }

    #[test]
    fn test_diff_both() {
        let result = diff_documents("hello\nfoo", "hello\nbar");
        assert_eq!(result.additions, 1);
        assert_eq!(result.deletions, 1);
    }

    #[test]
    fn test_diff_empty_both() {
        let result = diff_documents("", "");
        assert_eq!(result.additions, 0);
        assert_eq!(result.deletions, 0);
    }

    #[test]
    fn test_diff_empty_to_content() {
        let result = diff_documents("", "hello");
        assert_eq!(result.additions, 1);
    }

    #[test]
    fn test_diff_single_line_identical() {
        let result = diff_documents("hello", "hello");
        assert_eq!(result.additions, 0);
        assert_eq!(result.deletions, 0);
    }

    #[test]
    fn test_diff_newline_consistency() {
        let r1 = diff_documents("a\nb", "a\nc");
        let r2 = diff_documents("a\nb\n", "a\nc\n");
        assert_eq!(r1.additions, r2.additions);
        assert_eq!(r1.deletions, r2.deletions);
    }

    #[test]
    fn test_inline_diff_modified_line() {
        // 同一行仅部分修改 → 应生成 inline_changes
        let result = diff_documents("hello world", "hello rust world");
        assert_eq!(result.additions, 1);
        assert_eq!(result.deletions, 1);
        let del_hunk = result.hunks.iter().find(|h| h.tag == "delete").unwrap();
        let ins_hunk = result.hunks.iter().find(|h| h.tag == "insert").unwrap();
        assert!(del_hunk.inline_changes.is_some(), "delete 行应有 inline_changes");
        assert!(ins_hunk.inline_changes.is_some(), "insert 行应有 inline_changes");
    }

    #[test]
    fn test_no_char_level_diff_for_totally_different_lines() {
        // 两行完全不同 → 应有 inline_changes，但全是整行级别的 delete/insert（无字级 diff）
        let result = diff_documents("hello world", "completely unrelated text here");
        let del_hunk = result.hunks.iter().find(|h| h.tag == "delete").unwrap();
        let ins_hunk = result.hunks.iter().find(|h| h.tag == "insert").unwrap();
        assert!(del_hunk.inline_changes.is_some(), "应生成 inline_changes");
        assert!(ins_hunk.inline_changes.is_some(), "应生成 inline_changes");
        // 完全不同的行：整行都是 delete/insert，没有 equal 片段
        let old_parts = del_hunk.inline_changes.as_ref().unwrap();
        assert!(old_parts.iter().all(|c| c.tag == "delete"), "旧行应全标记为 delete");
        let new_parts = ins_hunk.inline_changes.as_ref().unwrap();
        assert!(new_parts.iter().all(|c| c.tag == "insert"), "新行应全标记为 insert");
    }

    #[test]
    fn test_multi_pair_inline_diff() {
        // TextDiff 可能产出的结构：delete-delete-insert-insert
        // 需要按位置配对而非仅检查相邻
        let old = "段落A旧内容\n段落B旧内容";
        let new = "段落A新内容（修改）\n段落B新内容（修改）";
        let result = diff_documents(old, new);
        // 应该有两对 delete/insert
        let dels: Vec<_> = result.hunks.iter().enumerate().filter(|(_, h)| h.tag == "delete").collect();
        let inss: Vec<_> = result.hunks.iter().enumerate().filter(|(_, h)| h.tag == "insert").collect();
        assert_eq!(dels.len(), 2);
        assert_eq!(inss.len(), 2);
        // 每对都应有 inline_changes
        for (_, h) in &dels {
            assert!(h.inline_changes.is_some(), "每个 delete hunk 应有 inline_changes");
        }
        for (_, h) in &inss {
            assert!(h.inline_changes.is_some(), "每个 insert hunk 应有 inline_changes");
        }
        // 验证 hunks 索引顺序：dels 在 inss 之前
        assert!(dels[1].0 < inss[0].0);
    }

    #[test]
    fn test_multi_line_merged_inline_diff() {
        // 逐字变化的多行文本 → TextDiff 可能合并为一个 hunk → 内部按 \n 拆分子行
        let old = "第一段\n第二段";
        let new = "第一段修改\n第二段修改";
        let result = diff_documents(old, new);
        let del_hunk = result.hunks.iter().find(|h| h.tag == "delete").unwrap();
        let ins_hunk = result.hunks.iter().find(|h| h.tag == "insert").unwrap();
        assert!(del_hunk.inline_changes.is_some(), "delete 应有 inline_changes");
        assert!(ins_hunk.inline_changes.is_some(), "insert 应有 inline_changes");
        // 如果 TextDiff 合并了多行，应该有换行分隔符；如果没合并，单行也不影响
    }

    #[test]
    fn test_similarity() {
        assert!(similarity("hello world", "hello world") > 0.9);
        assert!(similarity("hello world", "hello rust world") > 0.5, "共享多数字符，相似度应 > 0.5");
        assert!(similarity("abc", "xyz") == 0.0, "完全无交集字符集");
        assert_eq!(similarity("", ""), 1.0);
        assert_eq!(similarity("a", ""), 0.0);
        assert_eq!(similarity("", "b"), 0.0);
    }

    #[test]
    fn test_inline_diff_chinese() {
        // 中文部分修改
        let result = diff_documents(
            "今天天气很好，适合出去玩",
            "今天天气非常好，适合出去郊游",
        );
        let del_hunk = result.hunks.iter().find(|h| h.tag == "delete").unwrap();
        let ins_hunk = result.hunks.iter().find(|h| h.tag == "insert").unwrap();
        assert!(del_hunk.inline_changes.is_some(), "部分修改的中文行应有 inline_changes");
        assert!(ins_hunk.inline_changes.is_some(), "部分修改的中文行应有 inline_changes");
    }
}
