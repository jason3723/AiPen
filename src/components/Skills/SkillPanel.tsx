import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  trigger: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

interface SkillIssue {
  severity: string;
  location: string;
  message: string;
  suggestion: string;
}

interface SkillResult {
  skill_id: string;
  passed: boolean;
  issues: SkillIssue[];
  suggestions: string[];
}

export default function SkillPanel({ documentContent = "" }: { documentContent?: string }) {
  const [skills, setSkills] = useState<SkillDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, SkillResult>>({});
  const [error, setError] = useState("");

  useEffect(() => {
    loadSkills();
  }, []);

  const loadSkills = async () => {
    setLoading(true);
    try {
      const res = await invoke<SkillDefinition[]>("list_skills");
      setSkills(res);
    } catch (err) {
      console.error("加载技能失败:", err);
    } finally {
      setLoading(false);
    }
  };

  const toggleSkill = async (skillId: string, enabled: boolean) => {
    try {
      await invoke("toggle_skill", { skillId, enabled });
      setSkills((prev) => prev.map((s) => (s.id === skillId ? { ...s, enabled } : s)));
    } catch (err) {
      console.error("切换技能失败:", err);
    }
  };

  const runSkill = async (skillId: string) => {
    if (!documentContent.trim()) {
      setError("请先在编辑器中输入内容");
      return;
    }
    setRunningId(skillId);
    setError("");
    try {
      const result = await invoke<SkillResult>("run_skill_check", {
        skillId,
        documentContent,
      });
      setResults((prev) => ({ ...prev, [skillId]: result }));
    } catch (err) {
      setError(String(err));
    } finally {
      setRunningId(null);
    }
  };

  const triggerLabels: Record<string, string> = {
    Realtime: "实时", OnSave: "保存时", Manual: "手动", PostCommit: "提交后",
  };

  if (loading) return <div className="skill-panel"><p>加载中...</p></div>;

  return (
    <div className="skill-panel">
      <h3>公文写作技能</h3>

      {error && <div className="error-msg">{error}</div>}

      <div className="skill-list">
        {skills.map((skill) => {
          const result = results[skill.id];
          return (
            <div key={skill.id} className={`skill-card ${skill.enabled ? "enabled" : "disabled"}`}>
              <div className="skill-header">
                <h4>{skill.name}</h4>
                <label className="toggle-switch">
                  <input type="checkbox" checked={skill.enabled}
                    onChange={(e) => toggleSkill(skill.id, e.target.checked)} />
                  <span className="toggle-slider"></span>
                </label>
              </div>
              <p className="skill-description">{skill.description}</p>
              <div className="skill-footer">
                <span className="skill-trigger">触发: {triggerLabels[skill.trigger] || skill.trigger}</span>
                <button
                  className="btn-small"
                  onClick={() => runSkill(skill.id)}
                  disabled={runningId === skill.id}
                >
                  {runningId === skill.id ? "⏳" : "▶ 运行"}
                </button>
              </div>

              {result && (
                <div className="skill-result">
                  <div className={`skill-result-badge ${result.passed ? "pass" : "fail"}`}>
                    {result.passed ? "✅ 通过" : "⚠️ 发现问题"}
                  </div>
                  {result.issues.map((iss, i) => (
                    <div key={i} className={`skill-issue severity-${iss.severity}`}>
                      <strong>[{iss.location}]</strong> {iss.message}
                      <p className="issue-suggestion">💡 {iss.suggestion}</p>
                    </div>
                  ))}
                  {result.suggestions.map((s, i) => (
                    <p key={i} className="skill-suggestion">💡 {s}</p>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
