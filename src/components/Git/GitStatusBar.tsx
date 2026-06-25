import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

interface RepoStatus {
  repo_path: string;
  current_branch: string;
  has_uncommitted_changes: boolean;
  commit_count: number;
}

interface CommitInfo {
  hash: string;
  message: string;
  author: string;
  timestamp: number;
}

export default function GitStatusBar({ repoPath }: { repoPath: string }) {
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);
  const [lastCommit, setLastCommit] = useState<CommitInfo | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    loadStatus();
    timerRef.current = setInterval(loadStatus, 3000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  const loadStatus = async () => {
    try {
      const s = await invoke<RepoStatus>("init_repo", { repoPath });
      setStatus(s);
    } catch (err) {
      console.error("获取仓库状态失败:", err);
    }
  };

  const handleCommit = async () => {
    setCommitting(true);
    try {
      const result = await invoke<CommitInfo>("auto_commit", {
        repoPath,
        message: commitMsg || `写作更新 ${new Date().toLocaleString("zh-CN")}`,
      });
      setLastCommit(result);
      setCommitMsg("");
      loadStatus();
    } catch (err) {
      console.error("提交失败:", err);
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div className="git-status-bar">
      <div className="git-status-info">
        {status && (
          <>
            <span className="git-branch">⎇ {status.current_branch}</span>
            <span className="git-commits">📝 {status.commit_count} commits</span>
            {status.has_uncommitted_changes && (
              <span className="git-dirty">● 有变更待提交</span>
            )}
          </>
        )}
      </div>

      <div className="git-commit-area">
        <input
          className="git-commit-input"
          type="text"
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          placeholder={status?.has_uncommitted_changes ? "提交说明（可选）" : "暂无变更，编辑文件后自动检测"}
          onKeyDown={(e) => e.key === "Enter" && status?.has_uncommitted_changes && handleCommit()}
        />
        <button
          className="btn-primary btn-sm"
          onClick={handleCommit}
          disabled={committing || !status?.has_uncommitted_changes}
          title={status?.has_uncommitted_changes ? "提交变更" : "没有变更需要提交"}
        >
          {committing ? "提交中..." : status?.has_uncommitted_changes ? "提交" : "无变更"}
        </button>
      </div>

      {lastCommit && (
        <div className="git-last-commit">
          上次提交: {lastCommit.hash.slice(0, 7)} — {lastCommit.message}
        </div>
      )}
    </div>
  );
}
