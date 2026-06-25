import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface AnalysisResult {
  analysis_type: string;
  summary: string;
  change_reasons: ChangeReason[];
  quality_issues: QualityIssue[];
  suggestions: string[];
}

interface ChangeReason {
  location: string;
  original: string;
  revised: string;
  reason: string;
  confidence: number;
}

interface QualityIssue {
  severity: string;
  location: string;
  description: string;
  suggestion: string;
}

export default function DiffReview({ repoPath, diffContent }: { repoPath: string; diffContent: string }) {
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleQualityCheck = async () => {
    if (!diffContent.trim()) {
      setError("请先在编辑器中输入内容");
      return;
    }
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const res = await invoke<AnalysisResult>("analyze_diff", {
        repoPath,
        diffContent,
        analysisType: "quality_check",
      });
      setResult(res);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="diff-review">
      <h3>文档审阅</h3>
      <p className="diff-hint">AI 将分析当前文档的格式规范、语言表达、逻辑结构</p>
      <button onClick={handleQualityCheck} disabled={loading} className="btn-primary">
        {loading ? "AI 分析中..." : "📝 AI 审阅文档"}
      </button>

      {error && <div className="error-msg">{error}</div>}

      {loading && (
        <div className="loading-spinner">
          <div className="spinner"></div>
          <span>正在调用 AI 分析...</span>
        </div>
      )}

      {result && (
        <div className="analysis-result">
          <div className="result-section">
            <h4>📋 总览</h4>
            <p>{result.summary}</p>
          </div>

          {result.quality_issues.length > 0 && (
            <div className="result-section">
              <h4>⚠️ 问题与改进建议</h4>
              {result.quality_issues.map((q, i) => (
                <div key={i} className={`issue-item severity-${q.severity}`}>
                  <div className="issue-header">
                    <span className={`severity-badge ${q.severity}`}>
                      {q.severity === "critical" ? "严重" : q.severity === "major" ? "主要" : "建议"}
                    </span>
                    <span className="issue-location">{q.location}</span>
                  </div>
                  <p>{q.description}</p>
                  <p className="issue-suggestion">💡 {q.suggestion}</p>
                </div>
              ))}
            </div>
          )}

          {result.suggestions.length > 0 && (
            <div className="result-section">
              <h4>✨ 改进建议</h4>
              <ul>
                {result.suggestions.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
