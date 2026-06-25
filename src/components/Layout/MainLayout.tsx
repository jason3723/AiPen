import { useState } from "react";
import MarkdownEditor from "../Editor/MarkdownEditor";
import DiffReview from "../Analysis/DiffReview";
import WritingReviewPanel from "../Analysis/WritingReview";
import SkillPanel from "../Skills/SkillPanel";
import VersionHistory from "../Analysis/VersionHistory";
import ApiSettings from "../Settings/ApiSettings";
import GitStatusBar from "../Git/GitStatusBar";
import ExportDialog from "../Export/ExportDialog";
import ProjectDialog from "../Project/ProjectDialog";

export default function MainLayout() {
  const [activeTab, setActiveTab] = useState<"skills" | "diff" | "review" | "history" | "settings">("skills");
  const [editorContent, setEditorContent] = useState("");
  const [showExport, setShowExport] = useState(false);
  const [showProject, setShowProject] = useState(false);
  const repoPath = ".";

  return (
    <div className="app-layout">
      <div className="app-main">
        <div className="editor-area">
          <div className="editor-global-toolbar">
            <span className="app-brand">AiPen</span>
            <div className="toolbar-actions">
              <button className="toolbar-btn" onClick={() => setShowProject(true)} title="项目">📁 项目</button>
              <button className="toolbar-btn" onClick={() => setActiveTab("skills")} title="技能面板">⚡</button>
              <button className="toolbar-btn" onClick={() => setActiveTab("diff")} title="文档审阅">🔍</button>
              <button className="toolbar-btn" onClick={() => setActiveTab("review")} title="写作复盘">📊</button>
              <button className="toolbar-btn" onClick={() => setActiveTab("history")} title="版本历史">🕐</button>
              <button className="toolbar-btn" onClick={() => setActiveTab("settings")} title="设置">⚙️</button>
              <button className="toolbar-btn export-btn" onClick={() => setShowExport(true)} title="导出 DOCX">
                📄 导出
              </button>
            </div>
          </div>
          <MarkdownEditor onContentChange={setEditorContent} />
        </div>

        <div className="analysis-area">
          <div className="analysis-tabs">
            <button className={`tab-btn ${activeTab === "skills" ? "active" : ""}`}
              onClick={() => setActiveTab("skills")}>⚡ 技能</button>
            <button className={`tab-btn ${activeTab === "diff" ? "active" : ""}`}
              onClick={() => setActiveTab("diff")}>🔍 审阅</button>
            <button className={`tab-btn ${activeTab === "review" ? "active" : ""}`}
              onClick={() => setActiveTab("review")}>📊 复盘</button>
            <button className={`tab-btn ${activeTab === "history" ? "active" : ""}`}
              onClick={() => setActiveTab("history")}>🕐 历史</button>
            <button className={`tab-btn ${activeTab === "settings" ? "active" : ""}`}
              onClick={() => setActiveTab("settings")}>⚙️</button>
          </div>

          <div className="analysis-content">
            {activeTab === "skills" && <SkillPanel documentContent={editorContent} />}
            {activeTab === "diff" && <DiffReview repoPath={repoPath} diffContent={editorContent} />}
            {activeTab === "review" && <WritingReviewPanel repoPath={repoPath} documentContent={editorContent} />}
            {activeTab === "history" && <VersionHistory repoPath={repoPath} />}
            {activeTab === "settings" && <ApiSettings />}
          </div>
        </div>
      </div>

      <div className="app-footer">
        <GitStatusBar repoPath={repoPath} />
      </div>

      {showExport && (
        <ExportDialog markdownContent={editorContent} onClose={() => setShowExport(false)} />
      )}

      {showProject && (
        <ProjectDialog
          onClose={() => setShowProject(false)}
          onLoadContent={(content) => setEditorContent(content)}
        />
      )}
    </div>
  );
}
