use serde::{Deserialize, Serialize};
use serde_json::json;

// ─── 类型 ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AIConfig {
    pub provider: String,   // "claude" | "openai" | "deepseek" | "custom"
    pub api_key: String,
    pub api_url: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AIAnalysis {
    pub highlights: Vec<String>,
    pub issues: Vec<String>,
    pub suggestions: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum AIError {
    #[error("API 请求失败: {0}")]
    RequestFailed(String),
    #[error("API 返回错误 ({status}): {message}")]
    ApiError { status: u16, message: String },
    #[error("解析响应失败: {0}")]
    ParseFailed(String),
    #[error("API 密钥未配置")]
    NotConfigured,
}

// ─── API URL 归一化 ──────────────────────────────────────────

/// 自动补全 API URL 路径
pub fn normalize_api_url(url: &str) -> String {
    let url = url.trim_end_matches('/');
    if url.contains("/chat/completions") || url.contains("/v1/messages") {
        return url.to_string();
    }
    if url.contains("anthropic.com") {
        format!("{}/v1/messages", url)
    } else {
        format!("{}/v1/chat/completions", url)
    }
}

// ─── 连通性测试 ──────────────────────────────────────────────

/// 测试 API 连接
pub async fn test_connection(config: &AIConfig) -> Result<String, AIError> {
    if config.api_key.is_empty() {
        return Err(AIError::NotConfigured);
    }

    let client = reqwest::Client::new();
    let api_url = normalize_api_url(&config.api_url);
    let is_claude = api_url.contains("anthropic.com");

    let request_body = if is_claude {
        json!({
            "model": &config.model,
            "max_tokens": 20,
            "system": "只回复OK",
            "messages": [{"role": "user", "content": "连通性测试"}]
        })
    } else {
        json!({
            "model": &config.model,
            "max_tokens": 20,
            "messages": [
                {"role": "system", "content": "只回复OK"},
                {"role": "user", "content": "连通性测试"}
            ]
        })
    };

    let mut req = client.post(&api_url)
        .header("Content-Type", "application/json");

    if is_claude {
        req = req.header("x-api-key", &config.api_key)
            .header("anthropic-version", "2023-06-01");
    } else {
        req = req.header("Authorization", format!("Bearer {}", config.api_key));
    }

    let response = req.json(&request_body).send().await
        .map_err(|e| AIError::RequestFailed(e.to_string()))?;

    let status = response.status();
    if status.is_success() {
        Ok("✅ 连接成功！API 密钥有效。".to_string())
    } else {
        let body = response.text().await.unwrap_or_default();
        let msg = if body.len() > 200 {
            format!("{}...", &body[..200])
        } else {
            body
        };
        Err(AIError::ApiError { status: status.as_u16(), message: msg })
    }
}

// ─── 核心分析函数 ────────────────────────────────────────────

/// 分析版本修订
pub async fn analyze_revision(
    old_content: &str,
    new_content: &str,
    diff_additions: usize,
    diff_deletions: usize,
    config: &AIConfig,
) -> Result<AIAnalysis, AIError> {
    if config.api_key.is_empty() {
        return Err(AIError::NotConfigured);
    }

    let prompt = build_analysis_prompt(old_content, new_content, diff_additions, diff_deletions);
    let response = call_ai_api(config, &prompt).await?;
    parse_analysis_response(&response)
}

/// 构建分析提示词
fn build_analysis_prompt(old: &str, new: &str, add: usize, del: usize) -> String {
    format!(
        r#"你是一位资深编辑。请分析以下文档修改：

## 修改前
{old}

## 修改后
{new}

## 修改摘要
新增 {add} 处，删除 {del} 处

请以严格 JSON 格式返回分析结果（只输出 JSON，不要包含其他文字）：
{{
  "highlights": ["修改的优点1", "修改的优点2"],
  "issues": ["存在的问题1", "存在的问题2"],
  "suggestions": ["改进建议1", "改进建议2"]
}}"#,
        old = old, new = new, add = add, del = del
    )
}

// ─── AI API 调用 ─────────────────────────────────────────────

/// 调用 AI API
async fn call_ai_api(config: &AIConfig, prompt: &str) -> Result<String, AIError> {
    let client = reqwest::Client::new();
    let api_url = normalize_api_url(&config.api_url);
    let is_claude = api_url.contains("anthropic.com");

    let request_body = if is_claude {
        json!({
            "model": &config.model,
            "max_tokens": 4096,
            "system": "你是一位资深编辑，精通文档审阅与修改分析。请用中文回答，保持专业、客观、具体。",
            "messages": [{"role": "user", "content": prompt}]
        })
    } else {
        let mut body = serde_json::Map::new();
        body.insert("model".into(), json!(&config.model));
        body.insert("max_tokens".into(), json!(4096));
        body.insert("response_format".into(), json!({"type": "json_object"}));
        body.insert("messages".into(), json!([
            {"role": "system", "content": "你是一位资深编辑，精通文档审阅与修改分析。请用中文回答，保持专业、客观、具体。"},
            {"role": "user", "content": prompt}
        ]));
        if config.model.contains("deepseek") {
            body.insert("thinking".into(), json!({"type": "enabled"}));
            body.insert("reasoning_effort".into(), json!("high"));
        }
        serde_json::Value::Object(body)
    };

    let mut req = client.post(&api_url)
        .header("Content-Type", "application/json");

    if is_claude {
        req = req.header("x-api-key", &config.api_key)
            .header("anthropic-version", "2023-06-01");
    } else {
        req = req.header("Authorization", format!("Bearer {}", config.api_key));
    }

    let response = req.json(&request_body).send().await
        .map_err(|e| AIError::RequestFailed(e.to_string()))?;

    let status = response.status();
    let body = response.text().await.map_err(|e| AIError::RequestFailed(e.to_string()))?;

    if !status.is_success() {
        let msg = if body.len() > 200 { format!("{}...", &body[..200]) } else { body };
        return Err(AIError::ApiError { status: status.as_u16(), message: msg });
    }

    // 解析响应
    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| AIError::ParseFailed(format!("JSON 解析失败: {}", e)))?;

    let content = parsed["content"]
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|c| c["text"].as_str())
        .or_else(|| {
            parsed["choices"]
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|c| c["message"]["content"].as_str())
        })
        .ok_or_else(|| AIError::ParseFailed("无法从响应中提取文本".to_string()))?;

    Ok(content.to_string())
}

/// 解析 AI 响应为结构化结果
fn parse_analysis_response(text: &str) -> Result<AIAnalysis, AIError> {
    // 尝试从 ```json 代码块提取
    let json_str = if let Some(start) = text.find("```json\n") {
        let s = start + "```json\n".len();
        if let Some(end) = text[s..].find("\n```") {
            &text[s..s + end]
        } else {
            text
        }
    } else {
        text
    };

    let analysis: AIAnalysis = serde_json::from_str(json_str)
        .map_err(|e| AIError::ParseFailed(format!("JSON 解析失败: {}", e)))?;

    Ok(analysis)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_analysis_response() {
        let json = r#"{"highlights":["优点1"],"issues":["问题1"],"suggestions":["建议1"]}"#;
        let result = parse_analysis_response(json).unwrap();
        assert_eq!(result.highlights.len(), 1);
        assert_eq!(result.highlights[0], "优点1");
    }

    #[test]
    fn test_parse_with_code_block() {
        let text = "分析结果如下：\n```json\n{\"highlights\":[],\"issues\":[],\"suggestions\":[]}\n```";
        let result = parse_analysis_response(text).unwrap();
        assert_eq!(result.highlights.len(), 0);
    }

    #[test]
    fn test_normalize_api_url() {
        assert_eq!(
            normalize_api_url("https://api.openai.com"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            normalize_api_url("https://api.anthropic.com"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            normalize_api_url("https://api.deepseek.com/v1/chat/completions"),
            "https://api.deepseek.com/v1/chat/completions"
        );
    }
}
