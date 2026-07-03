use serde::{Deserialize, Deserializer, Serialize};
use serde_json::json;
use std::sync::OnceLock;
use futures_util::StreamExt;

// ─── 工具函数 ────────────────────────────────────────────────

/// 接受 JSON 字符串或数字，统一转为 String
fn deser_flex_string<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    use serde::de;
    struct V;
    impl<'de> de::Visitor<'de> for V {
        type Value = String;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("string or number")
        }
        fn visit_str<E: de::Error>(self, v: &str) -> Result<String, E> { Ok(v.into()) }
        fn visit_i64<E: de::Error>(self, v: i64) -> Result<String, E> { Ok(v.to_string()) }
        fn visit_u64<E: de::Error>(self, v: u64) -> Result<String, E> { Ok(v.to_string()) }
        fn visit_f64<E: de::Error>(self, v: f64) -> Result<String, E> { Ok(v.to_string()) }
        fn visit_bool<E: de::Error>(self, v: bool) -> Result<String, E> { Ok(v.to_string()) }
    }
    d.deserialize_any(V)
}

// ─── 类型 ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AIConfig {
    pub api_key: String,
    pub api_url: String,
    pub model: String,
    pub thinking_enabled: bool,
    pub reasoning_effort: String,  // "high" | "max"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverallAssessment {
    pub verdict: String,
    pub summary: String,
    #[serde(deserialize_with = "deser_flex_string")]
    pub score_old: String,
    #[serde(deserialize_with = "deser_flex_string")]
    pub score_new: String,
    #[serde(deserialize_with = "deser_flex_string")]
    pub delta: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdeologicalAnalysis {
    pub elevation: String,
    pub positioning: String,
    pub depth: String,
    pub risk: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogicAnalysis {
    pub strengths: Vec<String>,
    pub weaknesses: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InsightAnalysis {
    pub added_value: Vec<String>,
    pub hollow_parts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExpressionAnalysis {
    pub highlights: Vec<String>,
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModificationBreakdown {
    #[serde(rename = "type")]
    pub mod_type: String,
    pub example: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RevisionSuggestion {
    pub target: String,
    pub advice: String,
    pub rationale: String,
    pub priority: String,
    pub category: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AIAnalysis {
    pub overall_assessment: OverallAssessment,
    pub ideological_analysis: IdeologicalAnalysis,
    pub logic_analysis: LogicAnalysis,
    pub insight_analysis: InsightAnalysis,
    pub expression_analysis: ExpressionAnalysis,
    pub modification_breakdown: Vec<ModificationBreakdown>,
    pub comparison: Vec<String>,
    pub revision_suggestions: Vec<RevisionSuggestion>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessagePayload {
    pub role: String,
    pub content: String,
}

/// 单文档评分结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DimensionScore {
    pub name: String,
    pub score: u32,
    pub comment: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentScore {
    pub total_score: u32,
    pub encouragement: String,
    pub dimensions: Vec<DimensionScore>,
    pub top_suggestion: String,
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

/// 将 thinking 参数注入 OpenAI 格式请求体
/// DeepSeek 默认 thinking=enabled，因此"关闭"也必须显式发送 disabled
fn apply_thinking_params(mut body: serde_json::Value, config: &AIConfig) -> serde_json::Value {
    if let Some(obj) = body.as_object_mut() {
        if config.thinking_enabled {
            obj.insert("thinking".into(), json!({"type": "enabled"}));
            obj.insert("reasoning_effort".into(), json!(config.reasoning_effort));
        } else {
            obj.insert("thinking".into(), json!({"type": "disabled"}));
        }
    }
    body
}

/// 查询 DeepSeek 账户余额和额度
pub async fn query_balance(config: &AIConfig) -> Result<String, AIError> {
    if config.api_key.is_empty() {
        return Err(AIError::NotConfigured);
    }

    let client = reqwest::Client::new();
    let base_url = config.api_url.trim_end_matches('/');
    let balance_url = format!("{}/user/balance", base_url);

    let response = client.get(&balance_url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .send().await
        .map_err(|e| AIError::RequestFailed(e.to_string()))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let msg = if body.len() > 300 { format!("{}...", &body[..300]) } else { body };
        return Err(AIError::ApiError { status: status.as_u16(), message: msg });
    }

    // 解析余额信息
    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| AIError::ParseFailed(format!("解析余额响应失败: {}", e)))?;

    let mut result = String::new();

    // 尝试解析 balance_infos 数组
    if let Some(balances) = parsed["balance_infos"].as_array() {
        for b in balances {
            let currency = b["currency"].as_str().unwrap_or("未知币种");
            let total = b["total_balance"].as_str().unwrap_or("0");
            let granted = b["granted_balance"].as_str().unwrap_or("0");
            let topped_up = b["topped_up_balance"].as_str().unwrap_or("0");
            result.push_str(&format!(
                "💰 {}\n  总余额: {}\n  赠送余额: {}\n  充值余额: {}\n",
                currency, total, granted, topped_up
            ));
        }
    }

    // 备选：解析单个 balance 字段
    if result.is_empty() {
        if let Some(balance) = parsed["balance"].as_f64() {
            result = format!("💰 总余额: {:.4} 元\n", balance);
        } else if let Some(balance) = parsed["balance"].as_str() {
            result = format!("💰 总余额: {} 元\n", balance);
        }
    }

    if result.is_empty() {
        // 返回原始 JSON 供用户参考
        let pretty = serde_json::to_string_pretty(&parsed)
            .unwrap_or(body);
        result = format!("📊 余额信息:\n{}", pretty);
    }

    result.push_str(&format!("\n最近查询：{}", chrono::Local::now().format("%Y-%m-%d %H:%M")));

    Ok(result)
}

/// 测试 API 连接
pub async fn test_connection(config: &AIConfig) -> Result<String, AIError> {
    if config.api_key.is_empty() {
        return Err(AIError::NotConfigured);
    }

    let client = reqwest::Client::new();
    let api_url = normalize_api_url(&config.api_url);

    let request_body = json!({
        "model": &config.model,
        "max_tokens": 20,
        "messages": [
            {"role": "system", "content": "只回复OK"},
            {"role": "user", "content": "连通性测试"}
        ]
    });

    let response = client.post(&api_url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", config.api_key))
        .json(&request_body).send().await
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
    temperature: f64,
    config: &AIConfig,
) -> Result<AIAnalysis, AIError> {
    if config.api_key.is_empty() {
        return Err(AIError::NotConfigured);
    }

    let prompt = build_analysis_prompt(old_content, new_content, diff_additions, diff_deletions);
    let messages = vec![ChatMessagePayload {
        role: "user".into(),
        content: prompt,
    }];
    let system_prompt = "你是一位资深编辑，精通文档审阅与修改分析。请用中文回答，保持专业、客观、具体。请严格以 JSON 格式输出。";
    let response = chat_completion(&messages, system_prompt, temperature, config).await?;
    parse_analysis_response(&response)
}

/// 构建分析提示词
fn build_analysis_prompt(old: &str, new: &str, add: usize, del: usize) -> String {
    format!(
        r#"你是一位具有战略思维和内容策划能力的资深编辑，擅长从思想性、逻辑性、表达力三个维度评估文本修改质量。

## 任务要求
对以下文档修改进行深度对比分析。评估重点：**主旨深化、思想站位、逻辑架构、表达精度**，而非格式规范。

## 评估维度

### 1. 主旨与立意
- 核心观点是否更鲜明、集中
- 是否存在跑题、稀释主题或"降格"核心观点的情况

### 2. 思想站位
- 政治站位、价值取向是否正确、稳健
- 视野是否提升（局部 → 全局 / 战术 → 战略）
- 是否符合当前政策导向与会议精神
- 具体表述是否存在舆情风险或歧义解读空间

### 3. 逻辑与结构
- 论述链条是否更严密、层次是否更清晰
- 段落/层次衔接是否更顺畅
- 是否存在跳跃、重复论证或逻辑断裂

### 4. 深度与洞察
- 是否增加了有价值的判断、洞见或背景
- 是否避免了空话、套话、表面化表述
- 理论高度是否有实质提升

### 5. 语言与表达
- 用词是否更准确、克制、有力
- 是否消除了歧义、过度情绪化或立场模糊的表述
- 长难句拆分是否合理，节奏感如何
- 是否存在过度修饰导致空洞，或过于口语化导致不严肃

## 修改信息
- 新增：{add} 处
- 删除：{del} 处

## 修改前
{old}

## 修改后
{new}

## 输出要求（严格 JSON，仅输出 JSON，不附加说明）

{{
  "overall_assessment": {{
    "verdict": "显著提升 / 略有提升 / 基本持平 / 略有退步 / 明显退步",
    "summary": "30字以内总体定性",
    "score_old": "1-10",
    "score_new": "1-10",
    "delta": "+X / -X / 0"
  }},
  "ideological_analysis": {{
    "elevation": "主旨提升的具体表现；若无则写'无明显变化'",
    "positioning": "政治站位与价值取向评价",
    "depth": "理论深度与视野变化",
    "risk": "表述风险点，若无则写'无'"
  }},
  "logic_analysis": {{
    "strengths": ["逻辑优化点1", "逻辑优化点2"],
    "weaknesses": ["逻辑问题1", "逻辑问题2"]
  }},
  "insight_analysis": {{
    "added_value": ["新增洞见1", "新增洞见2"],
    "hollow_parts": ["空话/套话位置1", "表面化表述位置2"]
  }},
  "expression_analysis": {{
    "highlights": ["表达亮点1：具体说明为何好"],
    "issues": ["表达问题1：具体说明为何差"]
  }},
  "modification_breakdown": [
    {{"type": "优化型", "example": "具体修改内容", "reason": "为何提升质量"}},
    {{"type": "调整型", "example": "具体修改内容", "reason": "中性改动，可改可不改"}},
    {{"type": "退化型", "example": "具体修改内容", "reason": "为何反而变差"}},
    {{"type": "冗余型", "example": "具体修改内容", "reason": "为何无实质价值"}}
  ],
  "comparison": [
    "相比旧稿，新稿在 XX 维度上：加强 / 削弱 / 持平，具体表现为……"
  ],
  "revision_suggestions": [
    {{
      "target": "具体段落或问题",
      "advice": "具体修改建议",
      "rationale": "为何这样改更好",
      "priority": "高/中/低",
      "category": "主旨/站位/逻辑/深度/语言"
    }}
  ]
}}
"#,
        old = old,
        new = new,
        add = add,
        del = del
    )
}

// ─── HTTP 客户端复用 ─────────────────────────────────────────

/// 全局复用 HTTP 客户端（连接池 + 180s 超时）
fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(180))
            .build()
            .expect("Failed to build shared HTTP client")
    })
}

/// 通用 AI API 请求：构建请求体 → 发送 → 解析响应
async fn send_ai_request(
    config: &AIConfig,
    request_body: serde_json::Value,
) -> Result<String, AIError> {
    if config.api_key.is_empty() {
        return Err(AIError::NotConfigured);
    }

    let api_url = normalize_api_url(&config.api_url);

    let response = http_client()
        .post(&api_url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", config.api_key))
        .json(&request_body).send().await
        .map_err(|e| AIError::RequestFailed(e.to_string()))?;

    let status = response.status();
    let body = response.text().await
        .map_err(|e| AIError::RequestFailed(e.to_string()))?;

    if !status.is_success() {
        let msg = if body.len() > 300 { format!("{}...", &body[..300]) } else { body };
        return Err(AIError::ApiError { status: status.as_u16(), message: msg });
    }

    extract_content_from_response(&body)
}

/// SSE 流式 AI 请求：逐 token 回调，返回累积完整内容
pub async fn send_ai_request_streaming(
    config: &AIConfig,
    mut request_body: serde_json::Value,
    mut on_token: impl FnMut(String),
) -> Result<String, AIError> {
    if config.api_key.is_empty() {
        return Err(AIError::NotConfigured);
    }

    // 注入 stream: true
    if let Some(obj) = request_body.as_object_mut() {
        obj.insert("stream".into(), json!(true));
    }

    let api_url = normalize_api_url(&config.api_url);

    let response = http_client()
        .post(&api_url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", config.api_key))
        .json(&request_body).send().await
        .map_err(|e| AIError::RequestFailed(e.to_string()))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let msg = if body.len() > 300 { format!("{}...", &body[..300]) } else { body };
        return Err(AIError::ApiError { status: status.as_u16(), message: msg });
    }

    let mut stream = response.bytes_stream();
    let mut full_content = String::new();
    let mut buffer = String::new();

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| AIError::RequestFailed(e.to_string()))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // 处理缓冲区中的完整 SSE 事件（以 \n\n 分隔）
        while let Some(pos) = buffer.find("\n\n") {
            let event = buffer[..pos].to_string();
            buffer = buffer[pos + 2..].to_string();

            for line in event.lines() {
                let data = match line.strip_prefix("data: ") {
                    Some(d) => d,
                    None => if line == "data:" { "" } else { continue },
                };
                if data == "[DONE]" || data.is_empty() {
                    continue;
                }
                // 跳过 reasoning_content，只取正文 delta.content
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(token) = parsed["choices"][0]["delta"]["content"].as_str() {
                        full_content.push_str(token);
                        on_token(token.to_string());
                    }
                }
            }
        }
    }

    // 流结束后处理 buffer 中残留的数据（防御性处理，应对非标准 SSE 末尾）
    if !buffer.trim().is_empty() {
        for line in buffer.lines() {
            let data = match line.strip_prefix("data: ") {
                Some(d) => d,
                None => if line == "data:" { "" } else { continue },
            };
            if data == "[DONE]" || data.is_empty() {
                continue;
            }
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                if let Some(token) = parsed["choices"][0]["delta"]["content"].as_str() {
                    full_content.push_str(token);
                    on_token(token.to_string());
                }
            }
        }
    }

    Ok(full_content)
}

// ─── AI API 调用 ─────────────────────────────────────────────

/// 调用 AI API — 通用聊天补全
pub async fn chat_completion(
    messages: &[ChatMessagePayload],
    system_prompt: &str,
    temperature: f64,
    config: &AIConfig,
) -> Result<String, AIError> {
    // 构建消息列表
    let all_messages: Vec<serde_json::Value> = {
        let mut msgs: Vec<serde_json::Value> = messages.iter().map(|m| {
            let mut map = serde_json::Map::new();
            map.insert("role".into(), json!(m.role));
            map.insert("content".into(), json!(m.content));
            serde_json::Value::Object(map)
        }).collect();
        if !system_prompt.is_empty() {
            msgs.insert(0, serde_json::Value::Object({
                let mut m = serde_json::Map::new();
                m.insert("role".into(), json!("system"));
                m.insert("content".into(), json!(system_prompt));
                m
            }));
        }
        msgs
    };

    let request_body = apply_thinking_params(json!({
        "model": &config.model,
        "max_tokens": 4096,
        "temperature": temperature,
        "messages": all_messages
    }), config);

    send_ai_request(config, request_body).await
}

/// 执行单个技能（大文档输出提升至 16384 tokens）
pub async fn run_skill(
    system_prompt: &str,
    user_content: &str,
    temperature: f64,
    config: &AIConfig,
) -> Result<String, AIError> {
    let token_count = user_content.chars().count();
    let max_tokens = if token_count > 5000 { 16384 } else { 4096 };

    let request_body = apply_thinking_params(json!({
        "model": &config.model,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content}
        ]
    }), config);

    let content = send_ai_request(config, request_body).await?;

    // 空响应 = max_tokens 不足以让模型开始输出
    if content.trim().is_empty() {
        return Err(AIError::ParseFailed(
            "AI 返回了空内容。文档可能过长，请尝试选中部分文本再执行技能。".into()
        ));
    }

    Ok(content)
}

/// 流式聊天补全（通用对话）
pub async fn chat_completion_streaming(
    messages: &[ChatMessagePayload],
    system_prompt: &str,
    temperature: f64,
    config: &AIConfig,
    on_token: impl FnMut(String),
) -> Result<String, AIError> {
    let all_messages: Vec<serde_json::Value> = {
        let mut msgs: Vec<serde_json::Value> = messages.iter().map(|m| {
            let mut map = serde_json::Map::new();
            map.insert("role".into(), json!(m.role));
            map.insert("content".into(), json!(m.content));
            serde_json::Value::Object(map)
        }).collect();
        if !system_prompt.is_empty() {
            msgs.insert(0, serde_json::Value::Object({
                let mut m = serde_json::Map::new();
                m.insert("role".into(), json!("system"));
                m.insert("content".into(), json!(system_prompt));
                m
            }));
        }
        msgs
    };

    let request_body = apply_thinking_params(json!({
        "model": &config.model,
        "max_tokens": 4096,
        "temperature": temperature,
        "messages": all_messages
    }), config);

    send_ai_request_streaming(config, request_body, on_token).await
}

/// 流式执行技能
pub async fn run_skill_streaming(
    system_prompt: &str,
    user_content: &str,
    temperature: f64,
    config: &AIConfig,
    on_token: impl FnMut(String),
) -> Result<String, AIError> {
    let token_count = user_content.chars().count();
    let max_tokens = if token_count > 5000 { 16384 } else { 4096 };

    let request_body = apply_thinking_params(json!({
        "model": &config.model,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content}
        ]
    }), config);

    let content = send_ai_request_streaming(config, request_body, on_token).await?;

    if content.trim().is_empty() {
        return Err(AIError::ParseFailed(
            "AI 返回了空内容。文档可能过长，请尝试选中部分文本再执行技能。".into()
        ));
    }

    Ok(content)
}

/// 修复器：接收诊断报告 + 原文，输出修正后的全文（流式）
pub async fn run_fixer_streaming(
    diagnostic: &str,
    original: &str,
    config: &AIConfig,
    on_token: impl FnMut(String),
) -> Result<String, AIError> {
    let system_prompt = "你是文档修正专家。根据审查意见修正文档，只输出修正后的完整文档，不要解释。如果审查意见说明无需修改，则原样输出原文。";
    let user_content = format!("## 审查意见\n{}\n\n## 原文\n{}", diagnostic, original);
    run_skill_streaming(system_prompt, &user_content, 0.3, config, on_token).await
}

/// 从 AI 响应中提取文本内容
fn extract_content_from_response(body: &str) -> Result<String, AIError> {
    let parsed: serde_json::Value = serde_json::from_str(body)
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
        .or_else(|| {
            parsed["delta"]["content"].as_str()
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

/// 单文档综合评分
pub async fn score_document(
    content: &str,
    title: &str,
    config: &AIConfig,
) -> Result<DocumentScore, AIError> {
    if config.api_key.is_empty() {
        return Err(AIError::NotConfigured);
    }

    let prompt = build_scoring_prompt(content, title);
    let response = run_skill(
        "你是一位严格、公正的公文评审专家。请根据文档实际质量打分，不要给出安全的中等分。请严格以 JSON 格式输出，不附加任何解释。",
        &prompt,
        0.8,
        config,
    ).await?;
    parse_scoring_response(&response)
}

/// 构建评分提示词
fn build_scoring_prompt(content: &str, title: &str) -> String {
    let preview = if content.chars().count() > 8000 {
        format!("{}...（文档过长，已截取前8000字）", &content[..content.char_indices().nth(8000).map(|(i, _)| i).unwrap_or(content.len())])
    } else {
        content.to_string()
    };
    format!(
        r#"你是一位严格、客观的公文评审专家。请对以下文档进行多维度评分，评分必须拉开差距，如实反映质量。

## 分数校准标准（重要！请严格按照此标准打分）
- **95~100**：堪称范文，思想深刻、逻辑无懈可击、用词精准有力，几乎无需修改
- **85~94**：整体优秀，有个别小瑕疵但不影响大局
- **75~84**：良好水平，结构完整但某些维度存在明显可改进空间
- **65~74**：基本合格，完成写作任务但有较多不足之处
- **55~64**：勉强可用，多处存在逻辑漏洞或表达问题
- **40~54**：质量较差，需要大幅修改
- **40以下**：不合格，建议重写

## 评分原则（必须遵守！）
1. **以 60 分作为"能用"基准线**，不是以 80 分为基准
2. 每项维度独立打分，不要全部趋同
3. 有明显缺陷的维度必须低于 70 分
4. 严禁所有维度都在 80-85 区间打转
5. **必须用到分数全量程**：真正写得好的文档至少有一个维度 ≥ 88，写得差的文档至少有一个维度 ≤ 52
6. 不同文档的分数必须有显著区分度，好文档总分可达 85+，差文档总分可低至 45 以下
7. total_score 取各维度平均分后四舍五入

## 文档标题
{title}

## 文档正文
{preview}

## 评分维度（每项0-100分）
1. **思想站位** — 政治站位、价值取向、政策把握
2. **逻辑结构** — 层次清晰度、论证严密性、衔接流畅度
3. **表达文采** — 用词准确性、语言力度、节奏感
4. **深度洞察** — 实质洞见、理论高度、是否空话套话
5. **规范性** — 格式规范、用语规范、文体匹配度

## 输出要求（严格 JSON，仅输出 JSON，不要附加任何解释）
{{
  "total_score": 一,
  "encouragement": "一句话鼓励（20字以内）",
  "dimensions": [
    {{"name": "思想站位", "score": 一, "comment": "具体评语，指出优点或不足"}},
    {{"name": "逻辑结构", "score": 一, "comment": "具体评语"}},
    {{"name": "表达文采", "score": 一, "comment": "具体评语"}},
    {{"name": "深度洞察", "score": 一, "comment": "具体评语"}},
    {{"name": "规范性", "score": 一, "comment": "具体评语"}}
  ],
  "top_suggestion": "最优先的改进建议（30字以内）"
}}
（注意：示例中 score 和 total_score 用"一"代表整数，请替换为实际分数）"#,
        title = title,
        preview = preview,
    )
}

/// 解析评分 JSON 响应
fn parse_scoring_response(text: &str) -> Result<DocumentScore, AIError> {
    let json_str = if let Some(start) = text.find('{') {
        if let Some(end) = text.rfind('}') {
            &text[start..=end]
        } else {
            text
        }
    } else {
        text
    };

    let score: DocumentScore = serde_json::from_str(json_str)
        .map_err(|e| AIError::ParseFailed(format!("评分 JSON 解析失败: {}", e)))?;

    Ok(score)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_analysis_response() {
        let json = r#"{"overall_assessment":{"verdict":"显著提升","summary":"整体质量有明显提高","score_old":"6","score_new":"8","delta":"+2"},"ideological_analysis":{"elevation":"无明显变化","positioning":"稳健","depth":"无明显变化","risk":"无"},"logic_analysis":{"strengths":["逻辑更清晰"],"weaknesses":[]},"insight_analysis":{"added_value":["新增了有价值的洞见"],"hollow_parts":[]},"expression_analysis":{"highlights":["表达更精准"],"issues":[]},"modification_breakdown":[{"type":"优化型","example":"改了标题","reason":"更吸引人"}],"comparison":["思想维度持平"],"revision_suggestions":[{"target":"开头部分","advice":"增加背景引入","rationale":"便于读者理解","priority":"中","category":"逻辑"}]}"#;
        let result = parse_analysis_response(json).unwrap();
        assert_eq!(result.overall_assessment.verdict, "显著提升");
        assert_eq!(result.overall_assessment.delta, "+2");
        assert_eq!(result.expression_analysis.highlights.len(), 1);
        assert_eq!(result.modification_breakdown.len(), 1);
        assert_eq!(result.revision_suggestions.len(), 1);
    }

    #[test]
    fn test_parse_with_code_block() {
        let text = r#"分析结果如下：
```json
{
  "overall_assessment": {"verdict": "基本持平", "summary": "无显著变化", "score_old": "7", "score_new": "7", "delta": "0"},
  "ideological_analysis": {"elevation": "无明显变化", "positioning": "无风险", "depth": "无明显变化", "risk": "无"},
  "logic_analysis": {"strengths": [], "weaknesses": []},
  "insight_analysis": {"added_value": [], "hollow_parts": []},
  "expression_analysis": {"highlights": [], "issues": []},
  "modification_breakdown": [],
  "comparison": [],
  "revision_suggestions": []
}
```"#;
        let result = parse_analysis_response(text).unwrap();
        assert_eq!(result.overall_assessment.verdict, "基本持平");
        assert_eq!(result.overall_assessment.delta, "0");
    }

    /// 验证 AI 返回整数而非字符串时也能正确解析
    #[test]
    fn test_parse_score_as_integer() {
        let json = r#"{"overall_assessment":{"verdict":"显著提升","summary":"好","score_old":6,"score_new":8,"delta":2},"ideological_analysis":{"elevation":"无明显变化","positioning":"无风险","depth":"无明显变化","risk":"无"},"logic_analysis":{"strengths":[],"weaknesses":[]},"insight_analysis":{"added_value":[],"hollow_parts":[]},"expression_analysis":{"highlights":[],"issues":[]},"modification_breakdown":[],"comparison":[],"revision_suggestions":[]}"#;
        let result = parse_analysis_response(json).unwrap();
        assert_eq!(result.overall_assessment.score_old, "6");
        assert_eq!(result.overall_assessment.score_new, "8");
        assert_eq!(result.overall_assessment.delta, "2");
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
