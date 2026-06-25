import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface WritingReview {
  period: string;
  total_commits: number;
  total_changes: number;
  patterns: WritingPattern[];
  overall_assessment: string;
}

interface WritingPattern {
  pattern_type: string;
  description: string;
  examples: string[];
  suggestion: string;
}

export default function WritingReviewPanel({ repoPath, documentContent }: { repoPath: string; documentContent?: string }) {
  const [review, setReview] = useState<WritingReview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleReview = async () => {
    setLoading(true);
    setError("");
    setReview(null);
    try {
      const res = await invoke<WritingReview>("review_writing_history", {
        repoPath,
        commitRange: 10,
        documentContent,
      });
      setReview(res);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="writing-review">
      <h3>写作复盘</h3>
      <p className="diff-hint">分析多次 commit 的写作模式，发现重复问题和进步趋势</p>

      <button onClick={handleReview} disabled={loading} className="btn-primary">
        {loading ? "分析中..." : "📊 开始复盘"}
      </button>

      {error && <div className="error-msg">{error}</div>}

      {loading && (
        <div className="loading-spinner">
          <div className="spinner"></div>
          <span>正在分析写作历史...</span>
        </div>
      )}

      {review && (
        <div className="review-result">
          <div className="review-meta">
            <span>📅 {review.period}</span>
            <span>📝 {review.total_commits} 次提交</span>
            <span>✏️ {review.total_changes} 处变更</span>
          </div>

          {review.total_commits === 0 ? (
            <div className="review-empty">
              <p>还没有提交记录。写作后记得提交（底部状态栏），积累几次 commit 后再来复盘，AI 就能分析你的写作模式了。</p>
            </div>
          ) : (
            <>
              <div className="review-assessment">
                <h4>总体评估</h4>
                <p>{review.overall_assessment}</p>
              </div>

              {review.patterns.length > 0 && (
                <div className="review-patterns">
                  <h4>写作模式分析</h4>
                  {review.patterns.map((p, i) => (
                    <div key={i} className={`pattern-item ${p.pattern_type}`}>
                      <strong>
                        {p.pattern_type === "repeated_issue" ? "🔁 重复问题" :
                         p.pattern_type === "improvement" ? "📈 进步发现" : "📉 退步提醒"}
                      </strong>
                      <p>{p.description}</p>
                      {p.examples.length > 0 && (
                        <ul>{p.examples.map((ex, j) => <li key={j}>{ex}</li>)}</ul>
                      )}
                      <p className="pattern-suggestion">💡 {p.suggestion}</p>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
