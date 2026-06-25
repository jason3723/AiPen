use similar::{ChangeTag, TextDiff};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct DiffHunk {
    pub tag: String,      // "equal" | "insert" | "delete"
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiffResult {
    pub hunks: Vec<DiffHunk>,
    pub additions: usize,
    pub deletions: usize,
    pub change_ratio: f64,
}

pub fn diff_documents(old: &str, new: &str) -> DiffResult {
    // Normalize: ensure both texts end with a newline so from_lines treats
    // the last line consistently (identical content is never mis-identified
    // as a change just because one side has a trailing newline and the other doesn't).
    let old = if old.ends_with('\n') {
        old.to_string()
    } else {
        format!("{}\n", old)
    };
    let new = if new.ends_with('\n') {
        new.to_string()
    } else {
        format!("{}\n", new)
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
        });
    }

    let total = additions + deletions;
    let change_ratio = if total == 0 {
        0.0
    } else {
        total as f64 / (hunks.len().max(1) as f64)
    };

    DiffResult { hunks, additions, deletions, change_ratio }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_diff_identical() {
        let result = diff_documents("hello\nworld", "hello\nworld");
        assert_eq!(result.additions, 0);
        assert_eq!(result.deletions, 0);
        assert_eq!(result.change_ratio, 0.0);
    }

    #[test]
    fn test_diff_addition() {
        let result = diff_documents("hello", "hello\nworld");
        assert_eq!(result.additions, 1);
        assert_eq!(result.deletions, 0);
        // 验证 hunk 内容
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
}
