import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

interface CommitInfo {
  hash: string;
  message: string;
  author: string;
  timestamp: number;
}

interface DiffEntry {
  path: string;
  change_type: string;
  raw_diff: string;
  structured: StructuredChange[];
}

interface StructuredChange {
  section: string;
  old_text: string;
  new_text: string;
  change_reason_hint: string;
}

export default function VersionHistory({ repoPath }: { repoPath: string }) {
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [compareHash, setCompareHash] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<DiffEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadHistory();
  }, []);

  const loadHistory = async () => {
    setLoading(true);
    try {
      const history = await invoke<CommitInfo[]>("get_commit_history", {
        repoPath,
        limit: 20,
      });
      setCommits(history);
    } catch (err) {
      console.error("加载历史失败:", err);
    } finally {
      setLoading(false);
    }
  };

  const showDiff = async (hash: string) => {
    // 点击已选中的 commit → 取消选择
    if (selectedHash === hash) {
      setSelectedHash(null);
      setCompareHash(null);
      setDiffs([]);
      return;
    }

    if (selectedHash && !compareHash) {
      // 第二次选择：对比两个 commit
      setCompareHash(hash);
      try {
        const result = await invoke<DiffEntry[]>("diff_between", {
          repoPath,
          fromHash: hash,
          toHash: selectedHash,
        });
        setDiffs(result);
      } catch (err) {
        console.error("获取 diff 失败:", err);
      }
      return;
    }

    // 已处于对比状态，再点一个 → 清空对比，显示该 commit 的 diff
    if (selectedHash && compareHash) {
      setSelectedHash(hash);
      setCompareHash(null);
    } else {
      // 首次选择：获取单个 commit 的 diff
      setSelectedHash(hash);
    }

    try {
      const result = await invoke<DiffEntry[]>("get_commit_diff", {
        repoPath,
        hash,
      });
      setDiffs(result);
    } catch (err) {
      console.error("获取 diff 失败:", err);
    }
  };

  const formatDate = (ts: number) => {
    const d = new Date(ts * 1000);
    return d.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const shortHash = (hash: string) => hash.slice(0, 7);

  const changeTypeLabel: Record<string, string> = {
    added: "新增",
    modified: "修改",
    deleted: "删除",
  };

  return (
    <div className="version-history">
      <div className="vh-header">
        <h3>版本历史</h3>
        <button className="btn-small" onClick={loadHistory} disabled={loading}>
          {loading ? "加载中..." : "刷新"}
        </button>
        {selectedHash && (
          <button className="btn-small" onClick={() => { setSelectedHash(null); setCompareHash(null); setDiffs([]); }}>
            清除选择
          </button>
        )}
      </div>

      {selectedHash && !compareHash && (
        <div className="vh-hint">
          再点击另一个 commit 可对比两个版本
        </div>
      )}

      {/* Commit 时间线 */}
      <div className="vh-timeline">
        {commits.length === 0 && !loading && (
          <p className="empty-hint">暂无提交记录</p>
        )}

        {commits.map((commit, _idx) => {
          const isSelected = commit.hash === selectedHash;
          const isCompare = commit.hash === compareHash;
          return (
            <div
              key={commit.hash}
              className={`vh-item ${isSelected ? "selected" : ""} ${isCompare ? "compare" : ""}`}
              onClick={() => showDiff(commit.hash)}
            >
              <div className="vh-timeline-dot">
                {isSelected ? "●" : "○"}
              </div>
              <div className="vh-content">
                <div className="vh-message">{commit.message}</div>
                <div className="vh-meta">
                  <span className="vh-hash">{shortHash(commit.hash)}</span>
                  <span className="vh-date">{formatDate(commit.timestamp)}</span>
                  <span className="vh-author">{commit.author}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Diff 详情 */}
      {diffs.length > 0 && (
        <div className="vh-diffs">
          <h4>
            {compareHash ? "版本对比" : "当前变更"}
          </h4>
          {diffs.map((diff, i) => (
            <div key={i} className="vh-diff-entry">
              <div className="vh-diff-header">
                <span className={`change-badge ${diff.change_type}`}>
                  {changeTypeLabel[diff.change_type] || diff.change_type}
                </span>
                <span className="vh-diff-path">{diff.path}</span>
              </div>

              {diff.structured.length > 0 ? (
                <div className="vh-diff-structured">
                  {diff.structured.map((chg, j) => (
                    <div key={j} className="vh-structured-change">
                      {chg.section && (
                        <div className="vh-change-section">{chg.section}</div>
                      )}
                      {chg.old_text && (
                        <div className="vh-change-old">
                          <span className="change-marker">-</span>
                          {chg.old_text}
                        </div>
                      )}
                      {chg.new_text && (
                        <div className="vh-change-new">
                          <span className="change-marker">+</span>
                          {chg.new_text}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <pre className="vh-raw-diff">{diff.raw_diff.slice(0, 500)}</pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
