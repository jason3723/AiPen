import { useState, useCallback } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";

interface MarkdownEditorProps {
  onContentChange?: (content: string) => void;
}

export default function MarkdownEditor({ onContentChange }: MarkdownEditorProps) {
  const [content, setContent] = useState(`# 新文档

## 正文

请在此输入您的公文内容...

`);

  const onChange = useCallback(
    (val: string) => {
      setContent(val);
      onContentChange?.(val);
    },
    [onContentChange]
  );

  return (
    <div className="editor-pane">
      <div className="editor-toolbar">
        <span className="editor-title">编辑器</span>
        <span className="heading-hints">
          <span className="hh-item"># H1</span>
          <span className="hh-item">## H2</span>
          <span className="hh-item">### H3</span>
          <span className="hh-item">#### H4</span>
        </span>
        <span className="editor-info">Markdown</span>
      </div>
      <CodeMirror
        value={content}
        height="100%"
        theme={oneDark}
        extensions={[markdown({ base: markdownLanguage })]}
        onChange={onChange}
        className="codemirror-container"
      />
    </div>
  );
}
