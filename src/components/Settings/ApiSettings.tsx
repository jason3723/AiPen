import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

interface ProviderPreset {
  name: string;
  label: string;
  apiUrl: string;
  models: { value: string; label: string }[];
}

const PRESETS: Record<string, ProviderPreset> = {
  openai: {
    name: "openai",
    label: "OpenAI",
    apiUrl: "https://api.openai.com/v1/chat/completions",
    models: [
      { value: "gpt-4o", label: "GPT-4o" },
      { value: "gpt-4o-mini", label: "GPT-4o Mini" },
      { value: "gpt-4-turbo", label: "GPT-4 Turbo" },
    ],
  },
  deepseek: {
    name: "deepseek",
    label: "DeepSeek",
    apiUrl: "https://api.deepseek.com/v1/chat/completions",
    models: [
      { value: "deepseek-v4-flash", label: "DeepSeek V4 Flash (1M 上下文)" },
      { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro (1M 上下文)" },
    ],
  },
  claude: {
    name: "claude",
    label: "Anthropic Claude",
    apiUrl: "https://api.anthropic.com/v1/messages",
    models: [
      { value: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
      { value: "claude-haiku-3-5-20241022", label: "Claude Haiku 3.5" },
    ],
  },
  siliconflow: {
    name: "siliconflow",
    label: "SiliconFlow (硅基流动)",
    apiUrl: "https://api.siliconflow.cn/v1/chat/completions",
    models: [
      { value: "deepseek-ai/DeepSeek-V3", label: "DeepSeek V3 (硅基)" },
      { value: "deepseek-ai/DeepSeek-R1", label: "DeepSeek R1 (硅基)" },
      { value: "Qwen/Qwen2.5-72B-Instruct", label: "Qwen 2.5 72B" },
    ],
  },
};

export default function ApiSettings() {
  const [apiKey, setApiKey] = useState("");
  const [apiUrl, setApiUrl] = useState("https://api.openai.com/v1/chat/completions");
  const [model, setModel] = useState("gpt-4o");
  const [provider, setProvider] = useState("openai");
  const [testResult, setTestResult] = useState("");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      const cfg = await invoke<{ api_key: string; api_url: string; model: string }>("get_api_config");
      setApiKey(cfg.api_key);
      setApiUrl(cfg.api_url);
      setModel(cfg.model);
      // 尝试匹配预设
      for (const [key, p] of Object.entries(PRESETS)) {
        if (cfg.api_url.includes(p.apiUrl.replace(/^https?:\/\//, "").replace(/\/v1\/.*$/, ""))) {
          setProvider(key);
          break;
        }
      }
    } catch (err) {
      console.error("加载配置失败:", err);
    }
  };

  const handleProviderChange = (providerName: string) => {
    setProvider(providerName);
    if (providerName === "custom") return;
    const preset = PRESETS[providerName];
    if (preset) {
      setApiUrl(preset.apiUrl);
      if (preset.models.length > 0) {
        setModel(preset.models[0].value);
      }
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await invoke("set_api_config", { apiKey, apiUrl, model });
      setTestResult("✅ 配置已保存");
    } catch (err) {
      setTestResult("❌ 保存失败: " + String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult("");
    try {
      await invoke("set_api_config", { apiKey, apiUrl, model });
      const res = await invoke<string>("test_api_connection");
      setTestResult(res);
    } catch (err) {
      setTestResult("❌ " + String(err));
    } finally {
      setTesting(false);
    }
  };

  const currentPreset = PRESETS[provider];
  const models = currentPreset?.models ?? [];

  return (
    <div className="api-settings">
      <h3>⚙️ API 配置</h3>

      <div className="form-group">
        <label>服务商</label>
        <select
          value={provider}
          onChange={(e) => handleProviderChange(e.target.value)}
          className="form-input"
        >
          <option value="openai">OpenAI</option>
          <option value="deepseek">DeepSeek</option>
          <option value="claude">Anthropic Claude</option>
          <option value="siliconflow">SiliconFlow (硅基流动)</option>
          <option value="custom">自定义</option>
        </select>
      </div>

      <div className="form-group">
        <label>API 密钥</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={provider === "deepseek" ? "sk-..." : provider === "claude" ? "sk-ant-..." : "输入 API 密钥"}
          className="form-input"
        />
      </div>

      <div className="form-group">
        <label>API 地址</label>
        <input
          type="text"
          value={apiUrl}
          onChange={(e) => {
            setApiUrl(e.target.value);
            setProvider("custom");
          }}
          placeholder="https://api.openai.com/v1/chat/completions"
          className="form-input"
        />
      </div>

      <div className="form-group">
        <label>模型</label>
        {models.length > 0 ? (
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="form-input"
          >
            {models.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="输入模型名称"
            className="form-input"
          />
        )}
      </div>

      <div className="settings-actions">
        <button onClick={handleSave} disabled={saving} className="btn-primary">
          {saving ? "保存中..." : "💾 保存"}
        </button>
        <button onClick={handleTest} disabled={testing} className="btn-secondary">
          {testing ? "测试中..." : "🔗 测试连接"}
        </button>
      </div>

      {testResult && (
        <div className={`test-result ${testResult.startsWith("✅") ? "success" : "failure"}`}>
          {testResult.includes("\n") ? (
            <pre className="error-detail">{testResult}</pre>
          ) : (
            testResult
          )}
        </div>
      )}
    </div>
  );
}
