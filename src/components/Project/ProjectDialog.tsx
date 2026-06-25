import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

interface ProjectDialogProps {
  onClose: () => void;
  onLoadContent: (content: string) => void;
}

export default function ProjectDialog({ onClose, onLoadContent }: ProjectDialogProps) {
  const [projects, setProjects] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [newName, setNewName] = useState("");

  useEffect(() => {
    loadList();
  }, []);

  const loadList = async () => {
    setLoading(true);
    try {
      const list = await invoke<string[]>("list_projects");
      setProjects(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    const name = newName.trim() || `doc_${Date.now().toString(36)}`;
    try {
      const savedName = await invoke<string>("create_project", { name });
      const content = await invoke<string>("read_file", { path: `./projects/${savedName}.md` });
      onLoadContent(content);
      onClose();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleOpen = async (name: string) => {
    try {
      const content = await invoke<string>("read_file", { path: `./projects/${name}.md` });
      onLoadContent(content);
      onClose();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog project-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>项目管理</h3>
          <button className="dialog-close" onClick={onClose}>×</button>
        </div>
        <div className="dialog-body">
          {error && <div className="error-msg">{error}</div>}

          <div className="form-group">
            <label>新建项目</label>
            <div className="inline-form">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="项目名称（留空自动生成）"
                className="form-input"
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              />
              <button className="btn-primary" onClick={handleCreate}>创建</button>
            </div>
          </div>

          <div className="form-group">
            <label>已有项目</label>
            {loading ? (
              <p className="empty-hint">加载中...</p>
            ) : projects.length === 0 ? (
              <p className="empty-hint">暂无项目，请先新建</p>
            ) : (
              <div className="project-list">
                {projects.map((name) => (
                  <div key={name} className="project-item" onClick={() => handleOpen(name)}>
                    <span className="project-icon">📄</span>
                    <span className="project-name-item">{name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
