import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

interface DocumentTemplate {
  name: string;
  header_title: string | null;
  document_number: string | null;
  recipient: string | null;
  sender: string | null;
  date: string | null;
}

interface ConversionResult {
  output_path: string;
  success: boolean;
  message: string;
}

interface ExportDialogProps {
  markdownContent: string;
  onClose: () => void;
}

export default function ExportDialog({ markdownContent, onClose }: ExportDialogProps) {
  const [templates, setTemplates] = useState<DocumentTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [outputPath, setOutputPath] = useState("");
  const [converting, setConverting] = useState(false);
  const [result, setResult] = useState<ConversionResult | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    loadTemplates();
  }, []);

  const loadTemplates = async () => {
    try {
      const tmpls = await invoke<DocumentTemplate[]>("list_templates");
      setTemplates(tmpls);
    } catch (err) {
      console.error("加载模板失败:", err);
    }
  };

  const handleExport = async () => {
    setConverting(true);
    setError("");
    setResult(null);

    try {
      const output = outputPath.trim() || `output_${Date.now()}.docx`;
      const res = await invoke<ConversionResult>("convert_to_docx", {
        markdown: markdownContent,
        outputPath: output,
        templateName: selectedTemplate || null,
      });
      setResult(res);
    } catch (err) {
      setError(String(err));
    } finally {
      setConverting(false);
    }
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>导出 DOCX</h3>
          <button className="dialog-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="dialog-body">
          <div className="form-group">
            <label>公文模板</label>
            <select
              value={selectedTemplate}
              onChange={(e) => setSelectedTemplate(e.target.value)}
            >
              <option value="">无模板（纯文档）</option>
              {templates.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                  {t.header_title && ` — ${t.header_title}`}
                </option>
              ))}
            </select>
          </div>

          {selectedTemplate && (
            <div className="template-preview">
              <h4>模板预览</h4>
              {templates
                .filter((t) => t.name === selectedTemplate)
                .map((t) => (
                  <div key={t.name} className="template-fields">
                    {t.header_title && <p>红头：{t.header_title}</p>}
                    {t.document_number && <p>文号：{t.document_number}</p>}
                    {t.recipient && <p>主送：{t.recipient}</p>}
                    {t.sender && <p>发文：{t.sender}</p>}
                    {t.date && <p>日期：{t.date}</p>}
                  </div>
                ))}
            </div>
          )}

          <div className="form-group">
            <label>输出路径</label>
            <input
              type="text"
              value={outputPath}
              onChange={(e) => setOutputPath(e.target.value)}
              placeholder="留空自动生成文件名"
            />
          </div>

          {error && <div className="error-msg">{error}</div>}

          {result && (
            <div className={`result-msg ${result.success ? "success" : "failure"}`}>
              {result.success
                ? `✅ 导出成功：${result.output_path}`
                : `❌ 导出失败：${result.message}`}
            </div>
          )}
        </div>

        <div className="dialog-footer">
          <button className="btn-secondary" onClick={onClose}>
            取消
          </button>
          <button
            className="btn-primary"
            onClick={handleExport}
            disabled={converting}
          >
            {converting ? "转换中..." : "导出 DOCX"}
          </button>
        </div>
      </div>
    </div>
  );
}
