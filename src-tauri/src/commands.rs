use crate::{ai, db, diff, version};
use tauri::{Emitter, State};
use serde_json;
use ai::ChatMessagePayload;

// ─── 精神融入：内置知识库摘要索引 ──────────────────────────────
// 每个内置 KB 一句话描述，用于 AI 阶段 1 做精匹配

const SPIRIT_KB_INDEX: &[(&str, &str, &str)] = &[
    ("kb_001", "企业概况", "公司背景、组织架构、核心业务方向与战略定位"),
    ("kb_002", "发展历程", "历史沿革、重大里程碑、关键转折与新时期使命"),
    ("kb_003", "经营管理", "管理制度、运营模式、治理结构与工作规范"),
    ("kb_004", "科技进步", "技术创新、产品研发、数字化转型与科技成果"),
    ("kb_005", "市场开发", "市场战略、客户拓展、品牌建设与营销推广"),
    ("kb_006", "党的建设", "组织建设、思想教育、党风廉政建设与政治引领"),
    ("kb_007", "企业英模", "先进典型、人物事迹、劳模精神与榜样力量"),
    ("kb_008", "企业故事", "创业故事、品牌叙事、员工风采与文化传承"),
    ("kb_009", "文化基地", "文化阵地建设、宣传载体、企业文化建设成果"),
    ("kb_010", "社会责任", "公益慈善、安全生产、绿色发展与社会贡献"),
    ("kb_011", "文艺体育", "员工文体活动、文艺创作、体育赛事与企业凝聚力"),
    ("kb_012", "亲切关怀", "领导关怀、政策支持、社会关注与鼓励认可"),
    ("kb_013", "媒体宣传", "媒体报道、舆情管理、对外传播与品牌形象塑造"),
];

/// 注入知识库内容到 system prompt
async fn build_knowledge_context(
    pool: &sqlx::SqlitePool,
    kb_ids: &[String],
) -> Result<String, String> {
    if kb_ids.is_empty() {
        return Ok(String::new());
    }
    let kbs = db::get_knowledge_bases_by_ids(pool, kb_ids)
        .await
        .map_err(|e| e.to_string())?;
    if kbs.is_empty() {
        return Ok(String::new());
    }
    let mut ctx = String::from("\n\n【参考知识库】\n");
    for kb in &kbs {
        ctx.push_str(&format!("\n## {}\n{}\n", kb.name, kb.content));
    }
    ctx.push_str("\n请基于以上知识库内容处理用户请求。\n");
    Ok(ctx)
}

/// 注入素材库内容到 system prompt（按标签聚合）
async fn build_material_context(
    pool: &sqlx::SqlitePool,
    material_tag_ids: &[String],
) -> Result<String, String> {
    if material_tag_ids.is_empty() {
        return Ok(String::new());
    }
    let materials = db::get_materials_by_tag_ids(pool, material_tag_ids)
        .await
        .map_err(|e| e.to_string())?;
    if materials.is_empty() {
        return Ok(String::new());
    }

    // 按标签分组
    let mut groups: std::collections::BTreeMap<String, Vec<&db::MaterialWithTags>> = std::collections::BTreeMap::new();
    for mat in &materials {
        for tag in &mat.tags {
            groups.entry(tag.name.clone()).or_default().push(mat);
        }
    }

    let mut ctx = String::from("\n\n【参考素材库】\n");
    for (tag_name, mats) in &groups {
        ctx.push_str(&format!("\n### {}（{} 条素材）\n", tag_name, mats.len()));
        for mat in mats {
            let text = extract_text_from_content(&mat.content);
            let source = if let (Some(title), Some(url)) = (&mat.source_title, &mat.source_url) {
                format!(" — 来源：{} ({})", title, url)
            } else if let Some(title) = &mat.source_title {
                format!(" — 来源：{}", title)
            } else if let Some(url) = &mat.source_url {
                format!(" — 来源：{}", url)
            } else {
                String::new()
            };
            ctx.push_str(&format!("- {}{}\n", text, source));
        }
    }
    ctx.push_str("\n请基于以上素材库内容处理用户请求。\n");
    Ok(ctx)
}

/// 从素材内容中提取纯文本（兼容 ProseMirror JSON 与旧纯文本）
fn extract_text_from_content(content: &str) -> String {
    // 尝试解析为 JSON
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(content) {
        if parsed.get("type").and_then(|v| v.as_str()) == Some("doc") {
            return extract_text_from_json_node(&parsed);
        }
    }
    // 纯文本回退
    content.to_string()
}

/// 递归提取 ProseMirror JSON 节点树中的所有文本
fn extract_text_from_json_node(node: &serde_json::Value) -> String {
    let mut result = String::new();
    if let Some(text) = node.get("text").and_then(|v| v.as_str()) {
        result.push_str(text);
    }
    if let Some(children) = node.get("content").and_then(|v| v.as_array()) {
        for child in children {
            result.push_str(&extract_text_from_json_node(child));
        }
    }
    result
}

// ─── 文件夹命令 ──────────────────────────────────────────────

#[tauri::command]
pub async fn create_folder(
    state: State<'_, crate::AppState>,
    name: String,
) -> Result<db::Folder, String> {
    db::create_folder(&state.db, &name).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_folders(
    state: State<'_, crate::AppState>,
) -> Result<Vec<db::Folder>, String> {
    db::list_folders(&state.db).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rename_folder(
    state: State<'_, crate::AppState>,
    folder_id: String,
    new_name: String,
) -> Result<(), String> {
    db::rename_folder(&state.db, &folder_id, &new_name).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_folder(
    state: State<'_, crate::AppState>,
    folder_id: String,
) -> Result<(), String> {
    db::delete_folder(&state.db, &folder_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn move_document(
    state: State<'_, crate::AppState>,
    doc_id: String,
    folder_id: String,
) -> Result<(), String> {
    db::move_document_to_folder(&state.db, &doc_id, &folder_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_document_from_folder(
    state: State<'_, crate::AppState>,
    doc_id: String,
) -> Result<(), String> {
    db::remove_document_from_folder(&state.db, &doc_id).await.map_err(|e| e.to_string())
}

// ─── 文档命令 ────────────────────────────────────────────────

#[tauri::command]
pub async fn create_document(
    state: State<'_, crate::AppState>,
    title: String,
) -> Result<db::Document, String> {
    db::create_document(&state.db, &title).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_document(
    state: State<'_, crate::AppState>,
    doc_id: String,
) -> Result<db::Document, String> {
    db::get_document(&state.db, &doc_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_documents(
    state: State<'_, crate::AppState>,
) -> Result<Vec<db::Document>, String> {
    db::list_documents(&state.db).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_draft(
    state: State<'_, crate::AppState>,
    doc_id: String,
    content: String,
) -> Result<(), String> {
    db::save_draft(&state.db, &doc_id, &content).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_draft(
    state: State<'_, crate::AppState>,
    doc_id: String,
) -> Result<Option<String>, String> {
    db::get_draft(&state.db, &doc_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_document_title(
    state: State<'_, crate::AppState>,
    doc_id: String,
    title: String,
) -> Result<(), String> {
    db::update_document_title(&state.db, &doc_id, &title).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_document(
    state: State<'_, crate::AppState>,
    doc_id: String,
) -> Result<(), String> {
    db::delete_document(&state.db, &doc_id).await.map_err(|e| e.to_string())
}

// ─── 版本命令 ────────────────────────────────────────────────

#[tauri::command]
pub async fn commit_version(
    state: State<'_, crate::AppState>,
    doc_id: String,
    content: String,
    commit_msg: String,
) -> Result<db::Version, String> {
    version::create_new_version(&state.db, &doc_id, &content, &commit_msg)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_versions(
    state: State<'_, crate::AppState>,
    doc_id: String,
) -> Result<Vec<db::Version>, String> {
    version::get_version_tree(&state.db, &doc_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_version(
    state: State<'_, crate::AppState>,
    version_id: String,
) -> Result<db::Version, String> {
    db::get_version(&state.db, &version_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rename_version(
    state: State<'_, crate::AppState>,
    version_id: String,
    commit_msg: String,
) -> Result<(), String> {
    db::update_version_msg(&state.db, &version_id, &commit_msg)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_version(
    state: State<'_, crate::AppState>,
    version_id: String,
) -> Result<(), String> {
    db::delete_version(&state.db, &version_id)
        .await
        .map_err(|e| e.to_string())
}

// ─── Diff 命令 ───────────────────────────────────────────────

#[tauri::command]
pub async fn get_diff(
    state: State<'_, crate::AppState>,
    old_version_id: String,
    new_version_id: String,
) -> Result<diff::DiffResult, String> {
    let old = db::get_version_content(&state.db, &old_version_id)
        .await
        .map_err(|e| e.to_string())?;
    let new = db::get_version_content(&state.db, &new_version_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(diff::diff_documents(&old, &new))
}

// ─── AI 分析命令 ─────────────────────────────────────────────

#[tauri::command]
pub async fn analyze_revision(
    state: State<'_, crate::AppState>,
    old_version_id: String,
    new_version_id: String,
    temperature: Option<f64>,
) -> Result<ai::AIAnalysis, String> {
    let config = {
        let cfg = state.ai_config.lock().map_err(|e| e.to_string())?;
        cfg.clone()
    };

    let old_raw = db::get_version_content(&state.db, &old_version_id)
        .await
        .map_err(|e| e.to_string())?;
    let new_raw = db::get_version_content(&state.db, &new_version_id)
        .await
        .map_err(|e| e.to_string())?;

    // 提取纯文本（ProseMirror JSON → 可读文本；旧 markdown 原样保留）
    let old = diff::prose_mirror_to_plain_text(&old_raw);
    let new = diff::prose_mirror_to_plain_text(&new_raw);

    let diff_result = diff::diff_documents(&old, &new);

    let temp = temperature.unwrap_or(0.3);
    let analysis = ai::analyze_revision(
        &old,
        &new,
        diff_result.additions,
        diff_result.deletions,
        temp,
        &config,
    )
    .await
    .map_err(|e| e.to_string())?;

    // 持久化分析结果
    let analysis_json = serde_json::to_string(&analysis).map_err(|e| e.to_string())?;
    db::save_analysis(&state.db, &new_version_id, Some(&old_version_id), &analysis_json)
        .await
        .ok();

    Ok(analysis)
}

#[tauri::command]
pub async fn get_analysis(
    state: State<'_, crate::AppState>,
    version_id: String,
) -> Result<Option<ai::AIAnalysis>, String> {
    let result = db::get_analysis(&state.db, &version_id)
        .await
        .map_err(|e| e.to_string())?;
    match result {
        Some((analysis_json, _old_vid)) => {
            let analysis: ai::AIAnalysis = serde_json::from_str(&analysis_json)
                .map_err(|e| format!("解析分析结果失败: {}", e))?;
            Ok(Some(analysis))
        }
        None => Ok(None),
    }
}

// ─── 配置命令 ────────────────────────────────────────────────

#[tauri::command]
pub async fn get_api_config(
    state: State<'_, crate::AppState>,
) -> Result<ai::AIConfig, String> {
    let cfg = state.ai_config.lock().map_err(|e| e.to_string())?;
    Ok(cfg.clone())
}

#[tauri::command]
pub async fn set_api_config(
    state: State<'_, crate::AppState>,
    api_key: String,
    api_url: String,
    model: String,
    thinking_enabled: bool,
    reasoning_effort: String,
) -> Result<(), String> {
    let cfg = ai::AIConfig {
        api_key,
        api_url: if api_url.is_empty() {
            "https://api.deepseek.com".into()
        } else {
            api_url
        },
        model: if model.is_empty() { "deepseek-v4-flash".into() } else { model },
        thinking_enabled,
        reasoning_effort: if reasoning_effort.is_empty() { "high".into() } else { reasoning_effort },
    };

    // 保存到内存
    {
        let mut stored = state.ai_config.lock().map_err(|e| e.to_string())?;
        *stored = cfg.clone();
    }

    // 持久化到数据库
    db::set_config(&state.db, "ai_model", &format!("\"{}\"", cfg.model))
        .await.map_err(|e| e.to_string())?;
    db::set_config(&state.db, "ai_api_url", &format!("\"{}\"", cfg.api_url))
        .await.map_err(|e| e.to_string())?;
    db::set_config(&state.db, "ai_api_key", &format!("\"{}\"", cfg.api_key))
        .await.map_err(|e| e.to_string())?;
    db::set_config(&state.db, "ai_thinking_enabled", &format!("{}", cfg.thinking_enabled))
        .await.map_err(|e| e.to_string())?;
    db::set_config(&state.db, "ai_reasoning_effort", &format!("\"{}\"", cfg.reasoning_effort))
        .await.map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn test_api_connection(
    state: State<'_, crate::AppState>,
) -> Result<String, String> {
    let cfg = state.ai_config.lock().map_err(|e| e.to_string())?.clone();
    ai::test_connection(&cfg).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn query_balance(
    state: State<'_, crate::AppState>,
) -> Result<String, String> {
    let cfg = state.ai_config.lock().map_err(|e| e.to_string())?.clone();
    ai::query_balance(&cfg).await.map_err(|e| e.to_string())
}

// ─── 文档排版设置命令 ────────────────────────────────────────

/// 读取指定文档的排版设置（返回 JSON 字符串，空字符串 = 使用默认值）
#[tauri::command]
pub async fn get_document_export_settings(
    state: State<'_, crate::AppState>,
    doc_id: String,
) -> Result<Option<String>, String> {
    db::get_document_export_settings(&state.db, &doc_id)
        .await
        .map_err(|e| e.to_string())
}

/// 保存指定文档的排版设置（JSON 字符串）
#[tauri::command]
pub async fn save_document_export_settings(
    state: State<'_, crate::AppState>,
    doc_id: String,
    settings_json: String,
) -> Result<(), String> {
    db::save_document_export_settings(&state.db, &doc_id, &settings_json)
        .await
        .map_err(|e| e.to_string())
}

// ─── 导出命令 ────────────────────────────────────────────────

/// 检查文件状态：是否存在、是否可写（未被其他程序锁定）
#[derive(serde::Serialize)]
pub struct FileStatus {
    pub exists: bool,
    pub writable: bool,
}

#[tauri::command]
pub async fn check_file_writable(path: String) -> Result<FileStatus, String> {
    let p = std::path::Path::new(&path);
    let exists = p.exists();
    let writable = if exists {
        // 尝试以写入模式打开，检测是否被其他程序锁定
        std::fs::OpenOptions::new().write(true).open(p).is_ok()
    } else {
        // 文件不存在 → 检查父目录是否可写
        if let Some(parent) = p.parent() {
            parent.exists() && parent.is_dir()
        } else {
            false
        }
    };
    Ok(FileStatus { exists, writable })
}

#[tauri::command]
pub async fn export_word_file(
    path: String,
    data: Vec<u8>,
) -> Result<(), String> {
    tokio::fs::write(&path, &data).await.map_err(|e| format!("写入文件失败: {}", e))
}

#[tauri::command]
pub async fn read_image_file(path: String) -> Result<Vec<u8>, String> {
    tokio::fs::read(&path).await.map_err(|e| format!("读取图片失败: {}", e))
}

/// 复制图片到目标路径，返回图片字节（绕过 fs 插件权限）
#[tauri::command]
pub async fn save_image_file(source_path: String, dest_path: String) -> Result<Vec<u8>, String> {
    let bytes = tokio::fs::read(&source_path).await.map_err(|e| format!("读取源图片失败: {}", e))?;
    // 确保目标父目录存在
    if let Some(parent) = std::path::Path::new(&dest_path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    let bytes_clone = bytes.clone();
    tokio::fs::write(&dest_path, &bytes).await.map_err(|e| format!("保存图片失败: {}", e))?;
    Ok(bytes_clone)
}

/// 保存原始字节到本地文件（用于粘贴等场景，绕过 fs 插件权限）
#[tauri::command]
pub async fn save_image_bytes(path: String, data: Vec<u8>) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    tokio::fs::write(&path, &data).await.map_err(|e| format!("保存图片失败: {}", e))
}

#[tauri::command]
pub fn exit_app() {
    std::process::exit(0);
}

// ─── 知识库命令 ───────────────────────────────────────────────

#[tauri::command]
pub async fn list_knowledge_bases(
    state: State<'_, crate::AppState>,
) -> Result<Vec<db::KnowledgeBase>, String> {
    db::list_knowledge_bases(&state.db).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_knowledge_base(
    state: State<'_, crate::AppState>,
    name: String,
    content: String,
    category: String,
) -> Result<db::KnowledgeBase, String> {
    db::create_knowledge_base(&state.db, &name, &content, &category)
        .await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_knowledge_base(
    state: State<'_, crate::AppState>,
    kb_id: String,
    name: String,
    content: String,
    category: String,
) -> Result<(), String> {
    db::update_knowledge_base(&state.db, &kb_id, &name, &content, &category)
        .await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_knowledge_base(
    state: State<'_, crate::AppState>,
    kb_id: String,
) -> Result<(), String> {
    db::delete_knowledge_base(&state.db, &kb_id).await.map_err(|e| e.to_string())
}

/// 解析用户上传的知识库文件（docx/txt/md）为纯文本
fn extract_text_from_bytes(data: &[u8], ext: &str) -> Result<String, String> {
    match ext.to_lowercase().as_str() {
        "docx" => {
            crate::db::extract_text_from_docx(data)
        }
        "txt" | "md" => {
            String::from_utf8(data.to_vec()).map_err(|e| format!("UTF-8 解码失败: {}", e))
        }
        _ => Err(format!("不支持的文件格式: {}", ext)),
    }
}

#[tauri::command]
pub async fn parse_kb_file(
    path: String,
) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
    let data = std::fs::read(p).map_err(|e| format!("读取文件失败: {}", e))?;
    extract_text_from_bytes(&data, ext)
}

// ─── 技能命令 ────────────────────────────────────────────────

#[tauri::command]
pub async fn list_skills(
    state: State<'_, crate::AppState>,
) -> Result<Vec<db::Skill>, String> {
    db::list_skills(&state.db).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_skill(
    state: State<'_, crate::AppState>,
    name: String,
    category: String,
    prompt_template: String,
    temperature: f64,
) -> Result<db::Skill, String> {
    db::create_skill(&state.db, &name, &category, &prompt_template, temperature)
        .await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_skill(
    state: State<'_, crate::AppState>,
    skill_id: String,
) -> Result<(), String> {
    db::delete_skill(&state.db, &skill_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_skill(
    state: State<'_, crate::AppState>,
    skill_id: String,
    name: String,
    category: String,
    prompt_template: String,
    temperature: f64,
) -> Result<db::Skill, String> {
    db::update_skill(&state.db, &skill_id, &name, &category, &prompt_template, temperature)
        .await.map_err(|e| e.to_string())
}

// ─── 常用提示词 (Interview Prompts) ────────────────────────────

#[tauri::command]
pub async fn list_interview_prompts(
    state: State<'_, crate::AppState>,
    recipe_id: String,
) -> Result<Vec<InterviewPromptOut>, String> {
    db::list_interview_prompts(&state.db, &recipe_id)
        .await.map_err(|e| e.to_string())
        .map(|rows| rows.into_iter().map(|p| InterviewPromptOut {
            id: p.id,
            recipe_id: p.recipe_id,
            question_id: p.question_id,
            label: p.label,
            content: p.content,
            sort_order: p.sort_order,
        }).collect())
}

#[derive(serde::Serialize)]
pub struct InterviewPromptOut {
    pub id: String,
    pub recipe_id: String,
    pub question_id: String,
    pub label: String,
    pub content: String,
    pub sort_order: i64,
}

#[tauri::command]
pub async fn save_interview_prompt(
    state: State<'_, crate::AppState>,
    prompt_id: Option<String>,
    recipe_id: String,
    question_id: String,
    label: String,
    content: String,
) -> Result<InterviewPromptOut, String> {
    let p = db::save_interview_prompt(&state.db, prompt_id.as_deref(), &recipe_id, &question_id, &label, &content)
        .await.map_err(|e| e.to_string())?;
    Ok(InterviewPromptOut {
        id: p.id,
        recipe_id: p.recipe_id,
        question_id: p.question_id,
        label: p.label,
        content: p.content,
        sort_order: p.sort_order,
    })
}

#[tauri::command]
pub async fn delete_interview_prompt(
    state: State<'_, crate::AppState>,
    prompt_id: String,
) -> Result<(), String> {
    db::delete_interview_prompt(&state.db, &prompt_id).await.map_err(|e| e.to_string())
}

// ─── 写作菜谱 (Compose Recipes) ──────────────────────────────

#[derive(serde::Serialize)]
pub struct ComposeRecipeOut {
    pub id: String,
    pub name: String,
    pub is_builtin: bool,
    pub config: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[tauri::command]
pub async fn list_compose_recipes(
    state: State<'_, crate::AppState>,
) -> Result<Vec<ComposeRecipeOut>, String> {
    db::list_compose_recipes(&state.db)
        .await.map_err(|e| e.to_string())
        .map(|rows| rows.into_iter().map(|r| ComposeRecipeOut {
            id: r.id,
            name: r.name,
            is_builtin: r.is_builtin,
            config: r.config,
            sort_order: r.sort_order,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }).collect())
}

#[tauri::command]
pub async fn save_compose_recipe(
    state: State<'_, crate::AppState>,
    id: String,
    name: String,
    config: String,
) -> Result<(), String> {
    db::save_compose_recipe(&state.db, &id, &name, &config).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_compose_recipe(
    state: State<'_, crate::AppState>,
    id: String,
) -> Result<(), String> {
    db::delete_compose_recipe(&state.db, &id).await.map_err(|e| e.to_string())
}

// ─── 精神融入：两阶段 AI 调用 ──────────────────────────────────

/// 解析 AI 返回的 KB ID 列表（从 JSON 数组或含噪声的文本中提取）
fn parse_kb_ids_from_response(text: &str) -> Result<Vec<String>, String> {
    let trimmed = text.trim();
    // 找第一个 [ 和最后一个 ]
    let json_str = match (trimmed.find('['), trimmed.rfind(']')) {
        (Some(s), Some(e)) if s < e => &trimmed[s..=e],
        _ => trimmed,
    };
    let ids: Vec<String> = serde_json::from_str(json_str)
        .map_err(|e| format!("解析知识库匹配结果失败: {}。AI 返回: {}", e, text))?;
    Ok(ids.into_iter().take(3).collect()) // 最多取 3 个
}

/// 精神融入：阶段 1 — AI 根据摘要匹配相关 KB
async fn match_spirit_kb_ids(
    user_text: &str,
    config: &ai::AIConfig,
) -> Result<Vec<String>, String> {
    let mut prompt = String::from(
        "你是知识库匹配专家。以下是可参考的知识库索引：\n\n"
    );
    for (id, title, summary) in SPIRIT_KB_INDEX {
        prompt.push_str(&format!("- id: {}, 标题: {}, 摘要: {}\n", id, title, summary));
    }
    prompt.push_str(&format!(
        "\n用户文本：\n\"{}\"\n\n请根据文本的内容主题和情感基调，从以上知识库中选择最相关的 1~3 个（不超过 3 个），返回其 ID 的 JSON 字符串数组。\n仅输出 JSON 数组，如 [\"kb_001\", \"kb_005\"]，不要包含其他内容。",
        user_text
    ));

    let response = ai::run_skill(
        "你是一个精准的知识库匹配引擎。只返回 JSON 数组。",
        &prompt,
        0.1, // 低温度确保稳定匹配
        config,
    ).await.map_err(|e| e.to_string())?;

    parse_kb_ids_from_response(&response)
}

/// 技能执行公共前处理：load skill → config → target → KB + 素材库 → 构建 prompts
async fn prepare_skill_run(
    pool: &sqlx::SqlitePool,
    ai_config_mutex: &std::sync::Mutex<ai::AIConfig>,
    skill_id: &str,
    content: String,
    selected_text: Option<String>,
    knowledge_base_ids: Option<Vec<String>>,
    material_tag_ids: Option<Vec<String>>,
) -> Result<(String, String, f64, ai::AIConfig), String> {
    let skill = db::get_skill(pool, skill_id).await.map_err(|e| e.to_string())?;
    let config = ai_config_mutex.lock().map_err(|e| e.to_string())?.clone();
    let target_content = selected_text.unwrap_or(content);

    // 精神融入技能：AI 自动匹配 KB
    let mut kb_ids = knowledge_base_ids.unwrap_or_default();
    if skill_id == db::SPIRIT_SKILL_ID {
        kb_ids = match_spirit_kb_ids(&target_content, &config).await?;
    }

    let kb_context = build_knowledge_context(pool, &kb_ids).await?;
    let mat_context = build_material_context(pool, &material_tag_ids.unwrap_or_default()).await?;

    // 精神融入：KB 全文拼入用户消息；普通技能：拼入 system prompt
    let (system_prompt, user_content) = if skill_id == db::SPIRIT_SKILL_ID {
        let final_user = if kb_context.is_empty() && mat_context.is_empty() {
            target_content
        } else {
            format!("{}{}\n\n用户文本：\n{}", kb_context, mat_context, target_content)
        };
        (skill.prompt_template, final_user)
    } else {
        let mut sp = skill.prompt_template;
        if !kb_context.is_empty() { sp.push_str(&kb_context); }
        if !mat_context.is_empty() { sp.push_str(&mat_context); }
        (sp, target_content)
    };

    Ok((system_prompt, user_content, skill.temperature, config))
}

#[tauri::command]
pub async fn run_skill(
    state: State<'_, crate::AppState>,
    skill_id: String,
    content: String,
    selected_text: Option<String>,
    knowledge_base_ids: Option<Vec<String>>,
    material_tag_ids: Option<Vec<String>>,
) -> Result<String, String> {
    let (system_prompt, user_content, temperature, config) = prepare_skill_run(
        &state.db, &state.ai_config, &skill_id, content, selected_text, knowledge_base_ids, material_tag_ids,
    ).await?;
    ai::run_skill(&system_prompt, &user_content, temperature, &config)
        .await.map_err(|e| e.to_string())
}

// ─── AI 对话命令 ──────────────────────────────────────────────

#[tauri::command]
pub async fn create_conversation(
    state: State<'_, crate::AppState>,
    title: String,
    doc_id: Option<String>,
) -> Result<db::ChatConversation, String> {
    db::create_conversation(&state.db, &title, doc_id.as_deref())
        .await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_conversations(
    state: State<'_, crate::AppState>,
    doc_id: Option<String>,
) -> Result<Vec<db::ChatConversation>, String> {
    db::list_conversations(&state.db, doc_id.as_deref())
        .await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_conversation(
    state: State<'_, crate::AppState>,
    conv_id: String,
) -> Result<(), String> {
    db::delete_conversation(&state.db, &conv_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rename_conversation(
    state: State<'_, crate::AppState>,
    conv_id: String,
    title: String,
) -> Result<(), String> {
    db::rename_conversation(&state.db, &conv_id, &title).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_chat_messages(
    state: State<'_, crate::AppState>,
    conv_id: String,
) -> Result<Vec<db::ChatMessage>, String> {
    db::list_chat_messages(&state.db, &conv_id).await.map_err(|e| e.to_string())
}

/// 对话公共前处理：加载历史 → 构建消息 → config → systemPrompt + KB + 素材库
async fn prepare_chat_prompt(
    pool: &sqlx::SqlitePool,
    ai_config_mutex: &std::sync::Mutex<ai::AIConfig>,
    conv_id: &str,
    message: &str,
    context_text: &Option<String>,
    knowledge_base_ids: Option<Vec<String>>,
    material_tag_ids: Option<Vec<String>>,
    temperature: Option<f64>,
) -> Result<(Vec<ChatMessagePayload>, String, f64, ai::AIConfig), String> {
    let history = db::list_chat_messages(pool, conv_id)
        .await.map_err(|e| e.to_string())?;

    let mut messages: Vec<ChatMessagePayload> = history.iter()
        .filter(|m| m.role != "system")
        .map(|m| {
            let content = match &m.context_text {
                Some(ctx) if !ctx.is_empty() && m.role == "user" => {
                    format!("[用户引用了以下文本作为参考]\n---\n{}\n---\n\n{}", ctx, m.content)
                }
                _ => m.content.clone(),
            };
            ChatMessagePayload { role: m.role.clone(), content }
        }).collect();

    let user_content = match context_text {
        Some(ctx) if !ctx.is_empty() => {
            format!("[用户引用了以下文本作为参考]\n---\n{}\n---\n\n{}", ctx, message)
        }
        _ => message.to_string(),
    };
    messages.push(ChatMessagePayload { role: "user".into(), content: user_content });

    let config = ai_config_mutex.lock().map_err(|e| e.to_string())?.clone();
    let mut system_prompt = String::from(
        "你是一个专业的写作助手，擅长中文公文写作、编辑润色和内容创作。请根据上下文提供有帮助、专业的回复。使用 Markdown 格式输出。"
    );
    let kb_context = build_knowledge_context(pool, &knowledge_base_ids.unwrap_or_default()).await?;
    let mat_context = build_material_context(pool, &material_tag_ids.unwrap_or_default()).await?;
    if !kb_context.is_empty() {
        system_prompt.push_str(&kb_context);
    }
    if !mat_context.is_empty() {
        system_prompt.push_str(&mat_context);
    }
    let temp = temperature.unwrap_or(0.7);
    Ok((messages, system_prompt, temp, config))
}

#[tauri::command]
pub async fn send_chat_message(
    state: State<'_, crate::AppState>,
    conv_id: String,
    message: String,
    context_text: Option<String>,
    knowledge_base_ids: Option<Vec<String>>,
    material_tag_ids: Option<Vec<String>>,
    temperature: Option<f64>,
) -> Result<db::ChatMessage, String> {
    let (messages, system_prompt, temp, config) = prepare_chat_prompt(
        &state.db, &state.ai_config, &conv_id, &message, &context_text, knowledge_base_ids, material_tag_ids, temperature,
    ).await?;

    let response = ai::chat_completion(&messages, &system_prompt, temp, &config)
        .await.map_err(|e| e.to_string())?;

    db::add_chat_message(&state.db, &conv_id, "user", &message, context_text.as_deref())
        .await.map_err(|e| e.to_string())?;
    let assistant_msg = db::add_chat_message(&state.db, &conv_id, "assistant", &response, None)
        .await.map_err(|e| e.to_string())?;
    Ok(assistant_msg)
}

// ─── AI 评分命令 ─────────────────────────────────────────────

#[tauri::command]
pub async fn score_document(
    state: State<'_, crate::AppState>,
    context_key: String,
    content: String,
    title: String,
) -> Result<ai::DocumentScore, String> {
    let config = state.ai_config.lock().map_err(|e| e.to_string())?.clone();
    // 提取纯文本后再评分，避免浪费 token 在 JSON 结构上
    let content_text = diff::prose_mirror_to_plain_text(&content);
    let score = ai::score_document(&content_text, &title, &config)
        .await
        .map_err(|e| e.to_string())?;
    // 自动持久化
    let score_json = serde_json::to_string(&score).map_err(|e| e.to_string())?;
    let key = format!("doc_score_{}", context_key);
    db::set_config(&state.db, &key, &score_json)
        .await
        .map_err(|e| e.to_string())?;
    Ok(score)
}

#[tauri::command]
pub async fn get_document_score(
    state: State<'_, crate::AppState>,
    context_key: String,
) -> Result<Option<ai::DocumentScore>, String> {
    let key = format!("doc_score_{}", context_key);
    let json_str = db::get_config(&state.db, &key)
        .await
        .map_err(|e| e.to_string())?;
    match json_str {
        Some(s) => {
            let score: ai::DocumentScore = serde_json::from_str(&s)
                .map_err(|e| format!("解析评分失败: {}", e))?;
            Ok(Some(score))
        }
        None => Ok(None),
    }
}

// ─── 数据备份/恢复命令 ──────────────────────────────────────────

#[tauri::command]
pub async fn export_data(
    state: State<'_, crate::AppState>,
) -> Result<db::ExportPackage, String> {
    db::export_all_data(&state.db).await.map_err(|e| e.to_string())
}

/// 按勾选项导出数据
#[tauri::command]
pub async fn export_selected_data(
    state: State<'_, crate::AppState>,
    export_documents: bool,
    export_knowledge_bases: bool,
    export_materials: bool,
    export_skills: bool,
    export_interview_prompts: bool,
    export_compose_recipes: bool,
) -> Result<db::ExportPackage, String> {
    db::export_selected_data(
        &state.db,
        export_documents,
        export_knowledge_bases,
        export_materials,
        export_skills,
        export_interview_prompts,
        export_compose_recipes,
    ).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn import_data(
    state: State<'_, crate::AppState>,
    data_json: String,
) -> Result<db::BackupStats, String> {
    let data: db::ExportPackage = serde_json::from_str(&data_json)
        .map_err(|e| format!("解析备份文件失败: {}", e))?;
    db::import_all_data(&state.db, &data).await.map_err(|e| e.to_string())
}

// ─── 智能写作流水线 ─────────────────────────────────────────────

/// 根据模板名称和描述，调用 AI 生成 InterviewStage 的 systemPrompt 和 questions
#[derive(serde::Serialize)]
pub struct InterviewGenerated {
    pub system_prompt: String,
    pub questions: Vec<InterviewQuestionOut>,
}

#[derive(serde::Serialize)]
pub struct InterviewQuestionOut {
    pub id: String,
    pub question: String,
    pub hint: String,
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_length: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multi_select: Option<bool>,
}

#[tauri::command]
pub async fn generate_interview_questions(
    state: State<'_, crate::AppState>,
    name: String,
    description: String,
) -> Result<InterviewGenerated, String> {
    let config = state.ai_config.lock().map_err(|e| e.to_string())?.clone();

    let user_prompt = format!(
        r#"你是一位写作采访专家。请根据以下写作模板信息，设计一套结构化的问题采访方案。

## 模板名称
{name}

## 简要描述
{description}

## 要求
1. 设计 6-12 个问题，覆盖该文体的核心写作要素（如：文体类型、基本信息、背景场合、受众对象、核心内容、数据案例、特殊要求、格式规范等）
2. 每个问题需包含：id（q_01/q_02等形式的唯一标识）、question（问题文本）、hint（输入框占位提示，可为空字符串）、required（必填为true/选填为false）
3. 对于有明确选项的单选题，给出 options 字符串数组
4. 同时撰写一段 systemPrompt（2-4句话），定义采访AI的角色定位、语气风格和操作规则（如：用户跳过时自行补充）

## 输出格式（严格 JSON，仅输出 JSON，不附加任何解释或标记）
{{
  "systemPrompt": "你是一位专业的XX写作助手，正在协助撰写一篇XX。逐项采集关键信息。语气专业干练。用户跳过的项目你将自行补充。",
  "questions": [
    {{"id": "q_01", "question": "这是什么类型的XX？", "hint": "", "required": true, "options": ["类型一", "类型二"]}},
    {{"id": "q_02", "question": "写作背景和目的？", "hint": "例如：年度总结、会议发言", "required": true}},
    {{"id": "q_03", "question": "目标受众是谁？", "hint": "", "required": false}}
  ]
}}"#,
        name = name,
        description = if description.is_empty() { "（用户仅提供了名称，请根据名称自行推断）".to_string() } else { description },
    );

    let response = ai::run_skill(
        "你是一个结构化的写作采访设计引擎。只输出 JSON，不附加任何解释。",
        &user_prompt,
        0.7,
        &config,
    ).await.map_err(|e| e.to_string())?;

    // 解析 AI 返回的 JSON
    let json_str = if let Some(start) = response.find('{') {
        if let Some(end) = response.rfind('}') {
            &response[start..=end]
        } else {
            &response
        }
    } else {
        &response
    };

    let parsed: serde_json::Value = serde_json::from_str(json_str)
        .map_err(|e| format!("解析AI返回失败: {}。原始返回: {}", e, response))?;

    let system_prompt = parsed["systemPrompt"]
        .as_str()
        .unwrap_or("你是一位专业的写作助手。逐项采集关键信息，用户跳过的项目你将自行补充。")
        .to_string();

    let questions: Vec<InterviewQuestionOut> = parsed["questions"]
        .as_array()
        .map(|arr| {
            arr.iter().enumerate().map(|(i, q)| {
                InterviewQuestionOut {
                    id: q["id"].as_str().map(String::from).unwrap_or_else(|| format!("q_{:02}", i + 1)),
                    question: q["question"].as_str().unwrap_or("请提供更多信息").to_string(),
                    hint: q["hint"].as_str().unwrap_or("").to_string(),
                    required: q["required"].as_bool().unwrap_or(false),
                    max_length: None,
                    options: q["options"].as_array().map(|opts| {
                        opts.iter().filter_map(|o| o.as_str().map(String::from)).collect()
                    }),
                    multi_select: q["multiSelect"].as_bool(),
                }
            }).collect()
        })
        .unwrap_or_else(|| {
            // 降级：返回 3 个通用问题
            vec![
                InterviewQuestionOut {
                    id: "q_title".into(),
                    question: "请描述一下写作主题和目的？".into(),
                    hint: "例如：汇报年度工作成果".into(),
                    required: true,
                    max_length: None,
                    options: None,
                    multi_select: None,
                },
                InterviewQuestionOut {
                    id: "q_context".into(),
                    question: "有什么特别需要强调的内容吗？".into(),
                    hint: "".into(),
                    required: false,
                    max_length: None,
                    options: None,
                    multi_select: None,
                },
                InterviewQuestionOut {
                    id: "q_extra".into(),
                    question: "还有其他补充信息吗？".into(),
                    hint: "".into(),
                    required: false,
                    max_length: None,
                    options: None,
                    multi_select: None,
                },
            ]
        });

    Ok(InterviewGenerated { system_prompt, questions })
}

/// 直接调用 AI 生成内容（不依赖 DB 中的 skill）
#[tauri::command]
/// 写作生成公共前处理：load config + 注入 KB 上下文 + 素材库上下文
async fn prepare_compose_generate(
    pool: &sqlx::SqlitePool,
    ai_config_mutex: &std::sync::Mutex<ai::AIConfig>,
    system_prompt: &str,
    user_content: &str,
    knowledge_base_ids: Option<Vec<String>>,
    material_tag_ids: Option<Vec<String>>,
) -> Result<(String, String, f64, ai::AIConfig), String> {
    let config = ai_config_mutex.lock().map_err(|e| e.to_string())?.clone();
    let kb_ctx = build_knowledge_context(pool, &knowledge_base_ids.unwrap_or_default()).await?;
    let mat_ctx = build_material_context(pool, &material_tag_ids.unwrap_or_default()).await?;
    let mut full_system = system_prompt.to_string();
    if !kb_ctx.is_empty() {
        full_system.push_str(&kb_ctx);
    }
    if !mat_ctx.is_empty() {
        full_system.push_str(&mat_ctx);
    }
    Ok((full_system, user_content.to_string(), 0.7, config))
}

#[tauri::command]
pub async fn ai_compose(
    state: State<'_, crate::AppState>,
    system_prompt: String,
    user_content: String,
    temperature: f64,
    knowledge_base_ids: Option<Vec<String>>,
    material_tag_ids: Option<Vec<String>>,
) -> Result<String, String> {
    let (full_system, user, _, config) = prepare_compose_generate(
        &state.db, &state.ai_config, &system_prompt, &user_content, knowledge_base_ids, material_tag_ids,
    ).await?;
    ai::run_skill(&full_system, &user, temperature, &config)
        .await.map_err(|e| e.to_string())
}

/// 流式 AI 写作（ai_compose 的 SSE 版本，emit token 事件）
#[tauri::command]
pub async fn ai_compose_streaming(
    app_handle: tauri::AppHandle,
    state: State<'_, crate::AppState>,
    event_id: String,
    system_prompt: String,
    user_content: String,
    temperature: f64,
    knowledge_base_ids: Option<Vec<String>>,
    material_tag_ids: Option<Vec<String>>,
) -> Result<String, String> {
    let (full_system, user, _, config) = prepare_compose_generate(
        &state.db, &state.ai_config, &system_prompt, &user_content, knowledge_base_ids, material_tag_ids,
    ).await?;

    let event_name = format!("ai-stream-{}", event_id);
    let event_name2 = event_name.clone();
    let handle = app_handle.clone();
    let result = ai::run_skill_streaming(
        &full_system, &user, temperature, &config,
        move |token| {
            let _ = handle.emit(&event_name, serde_json::json!({"token": token}));
        },
    ).await.map_err(|e| e.to_string())?;

    let _ = app_handle.emit(&event_name2, serde_json::json!({"done": true}));
    Ok(result)
}

/// 审查/润色公共前处理：load skill + config + 素材库上下文
async fn prepare_compose_review(
    pool: &sqlx::SqlitePool,
    ai_config_mutex: &std::sync::Mutex<ai::AIConfig>,
    skill_id: &str,
    content: &str,
    material_tag_ids: Option<Vec<String>>,
) -> Result<(String, String, f64, ai::AIConfig), String> {
    let skill = db::get_skill(pool, skill_id).await.map_err(|e| e.to_string())?;
    let config = ai_config_mutex.lock().map_err(|e| e.to_string())?.clone();
    let mat_ctx = build_material_context(pool, &material_tag_ids.unwrap_or_default()).await?;
    let full_system = if mat_ctx.is_empty() {
        skill.prompt_template
    } else {
        format!("{}{}", skill.prompt_template, mat_ctx)
    };
    Ok((full_system, content.to_string(), skill.temperature, config))
}

/// 审查技能（传入 skill_id 和内容，返回审查结果）
#[tauri::command]
pub async fn compose_review(
    state: State<'_, crate::AppState>,
    skill_id: String,
    content: String,
    material_tag_ids: Option<Vec<String>>,
) -> Result<String, String> {
    let (system_prompt, user_content, temperature, config) = prepare_compose_review(
        &state.db, &state.ai_config, &skill_id, &content, material_tag_ids,
    ).await?;
    ai::run_skill(&system_prompt, &user_content, temperature, &config)
        .await.map_err(|e| e.to_string())
}

/// 流式版本：加载技能 prompt → 流式执行，emit token 事件
#[tauri::command]
pub async fn compose_review_streaming(
    app_handle: tauri::AppHandle,
    state: State<'_, crate::AppState>,
    skill_id: String,
    content: String,
    event_id: String,
    material_tag_ids: Option<Vec<String>>,
) -> Result<String, String> {
    let (system_prompt, user_content, temperature, config) = prepare_compose_review(
        &state.db, &state.ai_config, &skill_id, &content, material_tag_ids,
    ).await?;

    let event_name = format!("ai-stream-{}", event_id);
    let event_name2 = event_name.clone();
    let handle = app_handle.clone();
    let result = ai::run_skill_streaming(
        &system_prompt, &user_content, temperature, &config,
        move |token| {
            let _ = handle.emit(&event_name, serde_json::json!({"token": token}));
        },
    ).await.map_err(|e| e.to_string())?;

    let _ = app_handle.emit(&event_name2, serde_json::json!({"done": true}));
    Ok(result)
}

/// 流式 AI 对话（send_chat_message 的 SSE 版本）
#[tauri::command]
pub async fn send_chat_message_streaming(
    app_handle: tauri::AppHandle,
    state: State<'_, crate::AppState>,
    event_id: String,
    conv_id: String,
    message: String,
    context_text: Option<String>,
    knowledge_base_ids: Option<Vec<String>>,
    material_tag_ids: Option<Vec<String>>,
    temperature: Option<f64>,
) -> Result<String, String> {
    let (messages, system_prompt, temp, config) = prepare_chat_prompt(
        &state.db, &state.ai_config, &conv_id, &message, &context_text, knowledge_base_ids, material_tag_ids, temperature,
    ).await?;

    let event_name = format!("ai-stream-{}", event_id);
    let event_name2 = event_name.clone();
    let handle = app_handle.clone();

    let response = ai::chat_completion_streaming(
        &messages, &system_prompt, temp, &config,
        move |token| {
            let _ = handle.emit(&event_name, serde_json::json!({"token": token}));
        },
    ).await.map_err(|e| e.to_string())?;

    db::add_chat_message(&state.db, &conv_id, "user", &message, context_text.as_deref())
        .await.map_err(|e| e.to_string())?;
    db::add_chat_message(&state.db, &conv_id, "assistant", &response, None)
        .await.map_err(|e| e.to_string())?;

    let _ = app_handle.emit(&event_name2, serde_json::json!({"done": true}));
    Ok(response)
}

/// 流式执行技能（run_skill 的 SSE 版本）
#[tauri::command]
pub async fn run_skill_streaming(
    app_handle: tauri::AppHandle,
    state: State<'_, crate::AppState>,
    event_id: String,
    skill_id: String,
    content: String,
    selected_text: Option<String>,
    knowledge_base_ids: Option<Vec<String>>,
    material_tag_ids: Option<Vec<String>>,
) -> Result<String, String> {
    let (system_prompt, user_content, temperature, config) = prepare_skill_run(
        &state.db, &state.ai_config, &skill_id, content, selected_text, knowledge_base_ids, material_tag_ids,
    ).await?;

    let event_name = format!("ai-stream-{}", event_id);
    let event_name2 = event_name.clone();
    let handle = app_handle.clone();
    let result = ai::run_skill_streaming(
        &system_prompt, &user_content, temperature, &config,
        move |token| {
            let _ = handle.emit(&event_name, serde_json::json!({"token": token}));
        },
    ).await.map_err(|e| e.to_string())?;

    let _ = app_handle.emit(&event_name2, serde_json::json!({"done": true}));
    Ok(result)
}

// ─── 技能组合流水线 ────────────────────────────────────────────

/// 流式执行技能组合管道：逐技能运行，每步诊断→修复，最终输出修改后文本
#[tauri::command]
pub async fn run_skill_pipeline_streaming(
    app_handle: tauri::AppHandle,
    state: State<'_, crate::AppState>,
    event_id: String,
    skill_ids: Vec<String>,
    content: String,
    selected_text: Option<String>,
    knowledge_base_ids: Option<Vec<String>>,
    material_tag_ids: Option<Vec<String>>,
) -> Result<String, String> {
    let event_name = format!("ai-pipeline-{}", event_id);
    let base_kb_ids = knowledge_base_ids.unwrap_or_default();
    let base_mat_tag_ids = material_tag_ids.unwrap_or_default();

    let mut text = selected_text.unwrap_or(content);
    let total = skill_ids.len();

    for (i, skill_id) in skill_ids.iter().enumerate() {
        // 通知前端：开始第 N 步
        let _ = app_handle.emit(&event_name, serde_json::json!({
            "step_start": { "step": i + 1, "total": total, "skillId": skill_id }
        }));

        // 1. 执行技能，获取诊断/改写结果（内部消费，不流式给前端）
        let (system_prompt, user_content, temperature, config) = prepare_skill_run(
            &state.db, &state.ai_config, skill_id, text.clone(), None, Some(base_kb_ids.clone()), Some(base_mat_tag_ids.clone()),
        ).await?;

        let skill_result = ai::run_skill_streaming(
            &system_prompt, &user_content, temperature, &config,
            |_| {},
        ).await.map_err(|e| e.to_string())?;

        // 2. 修复器：根据技能结果修正原文，流式输出给前端
        let handle = app_handle.clone();
        let evt = event_name.clone();
        text = ai::run_fixer_streaming(
            &skill_result, &text, &config,
            move |token| {
                let _ = handle.emit(&evt, serde_json::json!({"token": token}));
            },
        ).await.map_err(|e| e.to_string())?;

        // 通知前端：第 N 步完成
        let _ = app_handle.emit(&event_name, serde_json::json!({
            "step_done": { "step": i + 1, "total": total }
        }));
    }

    let _ = app_handle.emit(&event_name, serde_json::json!({"done": true}));
    Ok(text)
}

// ─── 素材库命令 ────────────────────────────────────────────────

#[tauri::command]
pub async fn list_materials(
    state: State<'_, crate::AppState>,
) -> Result<Vec<db::MaterialWithTags>, String> {
    db::list_materials(&state.db).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_material(
    state: State<'_, crate::AppState>,
    mat_id: String,
) -> Result<db::MaterialWithTags, String> {
    db::get_material(&state.db, &mat_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_material(
    state: State<'_, crate::AppState>,
    content: String,
    source_url: Option<String>,
    source_title: Option<String>,
) -> Result<db::MaterialWithTags, String> {
    db::save_material(
        &state.db, &content,
        source_url.as_deref(),
        source_title.as_deref(),
    ).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_material_content(
    state: State<'_, crate::AppState>,
    mat_id: String,
    content: String,
) -> Result<(), String> {
    db::update_material_content(&state.db, &mat_id, &content)
        .await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_material(
    state: State<'_, crate::AppState>,
    mat_id: String,
) -> Result<(), String> {
    db::delete_material(&state.db, &mat_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_material_tags(
    state: State<'_, crate::AppState>,
    mat_id: String,
    tag_ids: Vec<String>,
) -> Result<(), String> {
    db::set_material_tags(&state.db, &mat_id, &tag_ids)
        .await.map_err(|e| e.to_string())
}

// ─── 标签命令 ──────────────────────────────────────────────────

#[tauri::command]
pub async fn list_tags(
    state: State<'_, crate::AppState>,
) -> Result<Vec<db::MaterialTag>, String> {
    db::list_tags(&state.db).await.map_err(|e| e.to_string())
}

/// 列出所有标签及其素材数量（用于素材库上下文选择器）
#[tauri::command]
pub async fn list_tags_with_count(
    state: State<'_, crate::AppState>,
) -> Result<Vec<db::TagWithCount>, String> {
    db::list_tags_with_count(&state.db).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_tag(
    state: State<'_, crate::AppState>,
    name: String,
) -> Result<db::MaterialTag, String> {
    db::create_tag(&state.db, &name).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_tag(
    state: State<'_, crate::AppState>,
    tag_id: String,
) -> Result<(), String> {
    db::delete_tag(&state.db, &tag_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rename_tag(
    state: State<'_, crate::AppState>,
    tag_id: String,
    new_name: String,
) -> Result<(), String> {
    db::rename_tag(&state.db, &tag_id, &new_name).await.map_err(|e| e.to_string())
}

// ─── AI 打标签 ─────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize)]
pub struct SuggestTagsResult {
    pub matched_tags: Vec<String>,
    pub suggested_new_tags: Vec<String>,
}

#[tauri::command]
pub async fn suggest_tags(
    state: State<'_, crate::AppState>,
    content: String,
) -> Result<SuggestTagsResult, String> {
    let config = state.ai_config.lock().map_err(|e| e.to_string())?.clone();
    if config.api_key.is_empty() {
        // 未配置 API，返回空（前端会跳过 AI 弹窗直接存）
        return Ok(SuggestTagsResult {
            matched_tags: vec![],
            suggested_new_tags: vec![],
        });
    }

    let existing_tags = db::list_tags(&state.db)
        .await.map_err(|e| e.to_string())?;
    let tag_names: Vec<String> = existing_tags.iter().map(|t| t.name.clone()).collect();
    let tag_list = serde_json::to_string(&tag_names).unwrap_or_default();

    let system_prompt = "你是一个文本分类助手。根据用户提供的文本内容，从已有标签列表中选择最匹配的标签，如果没有匹配的，可以建议新标签。请严格以 JSON 格式输出，不附加任何解释。";

    let prompt = format!(
        r#"## 已有标签
{}

## 素材正文
{}

## 任务
1. 从已有标签中选出与素材最匹配的标签（最多 3 个）
2. 如果没有合适标签，建议 1-2 个新标签名称（简洁，2-4字）
3. 如果已有标签完全匹配，suggested_new_tags 留空

## 输出要求（严格 JSON）
{{
  "matched_tags": ["标签1", "标签2"],
  "suggested_new_tags": ["新标签1"]
}}"#,
        tag_list, extract_text_from_content(&content).chars().take(2000).collect::<String>()
    );

    let messages = vec![ChatMessagePayload {
        role: "user".into(),
        content: prompt,
    }];

    let response = ai::chat_completion(&messages, system_prompt, 0.3, &config)
        .await.map_err(|e| e.to_string())?;

    // 解析 JSON（支持 ```json 包裹）
    let json_str = if let Some(start) = response.find('{') {
        if let Some(end) = response.rfind('}') {
            &response[start..=end]
        } else {
            &response
        }
    } else {
        &response
    };

    serde_json::from_str::<SuggestTagsResult>(json_str)
        .map_err(|e| format!("解析标签结果失败: {}", e))
}

// ─── 书签命令 ──────────────────────────────────────────────────

#[tauri::command]
pub async fn add_bookmark(
    state: State<'_, crate::AppState>,
    url: String,
    title: String,
) -> Result<db::Bookmark, String> {
    db::add_bookmark(&state.db, &url, &title).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_bookmarks(
    state: State<'_, crate::AppState>,
) -> Result<Vec<db::Bookmark>, String> {
    db::list_bookmarks(&state.db).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_bookmark(
    state: State<'_, crate::AppState>,
    bm_id: String,
) -> Result<(), String> {
    db::delete_bookmark(&state.db, &bm_id).await.map_err(|e| e.to_string())
}

// ─── 浏览器内嵌窗口（无装饰、精确定位在编辑区上方） ──────────

use tauri::Manager;
use base64::Engine;

const BROWSER_INIT_SCRIPT: &str = r#"
(function() {
  // ── 拦截 target="_blank" 链接和 window.open，在当前窗口打开 ──
  // 劫持 window.open，重定向到当前页面
  window.open = function(url, target, features) {
    if (url && typeof url === 'string' && url.length > 0) {
      window.location.href = url;
    }
    return window;
  };

  // 捕获通过点击触发的 target="_blank" 链接
  document.addEventListener('click', function(e) {
    var el = e.target;
    while (el && el !== document.body) {
      if (el.tagName === 'A' && el.target && el.target.toLowerCase() === '_blank') {
        var href = el.getAttribute('href');
        if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
          e.preventDefault();
          e.stopImmediatePropagation();
          window.location.href = href;
          return;
        }
      }
      el = el.parentElement;
    }
  }, true);

  // ── 右键菜单（存入素材库 + 复制） ──
  var menuEl = null;
  var overlayEl = null;
  var pending = false;

  function cleanup() {
    if (pending) return;
    if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
    menuEl = null;
    if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
    overlayEl = null;
  }

  document.addEventListener('contextmenu', function(e) {
    var sel = window.getSelection();
    var text = (sel ? sel.toString() : '').trim();
    if (!text) { cleanup(); return; }
    e.preventDefault();
    e.stopPropagation();
    cleanup();

    overlayEl = document.createElement('div');
    overlayEl.style.cssText = 'position:fixed;inset:0;z-index:2147483646;cursor:default;';
    var timer = setTimeout(function() {
      if (overlayEl) overlayEl.addEventListener('click', cleanup);
    }, 100);
    overlayEl.addEventListener('contextmenu', function(ev) { ev.preventDefault(); clearTimeout(timer); cleanup(); });

    menuEl = document.createElement('div');
    menuEl.style.cssText = 'position:fixed;z-index:2147483647;background:#1e1e2e;border:1px solid #3b3b5c;border-radius:6px;padding:4px 0;min-width:200px;box-shadow:0 8px 24px rgba(0,0,0,0.5);font-family:sans-serif;font-size:12px;color:#c0caf5;';
    menuEl.style.left = e.clientX + 'px';
    menuEl.style.top = e.clientY + 'px';
    menuEl.addEventListener('mousedown', function(ev) { ev.stopPropagation(); });
    menuEl.addEventListener('contextmenu', function(ev) { ev.preventDefault(); });

    // 存入素材库
    var clipItem = document.createElement('div');
    clipItem.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:6px 12px;cursor:pointer;transition:background 0.1s;';
    clipItem.innerHTML = '<span>📦 存入 AiPen 素材库</span><span style="color:#565f89;font-size:11px;margin-left:16px;"></span>';
    clipItem.addEventListener('mouseenter', function() { if (!pending) clipItem.style.background = '#29293d'; });
    clipItem.addEventListener('mouseleave', function() { if (!pending) clipItem.style.background = ''; });
    clipItem.addEventListener('mousedown', function(ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (pending) return;
      pending = true;

      var savedText = text;
      var savedUrl = window.location.href;
      var savedTitle = document.title;

      // ── 发送"存入素材库"事件到主窗口 ──
      // 双重通道并行：__TAURI__ IPC（快速）+ URL 导航（可靠回退）
      var payload = JSON.stringify({ text: savedText, url: savedUrl, title: savedTitle });
      var enc = new TextEncoder();
      var bytes = enc.encode(payload);
      var bin = '';
      for (var i = 0; i < bytes.length; i++) {
        bin += String.fromCharCode(bytes[i]);
      }
      var encoded = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      // 方式 1（优先尝试）: Tauri v2 IPC 事件——内部页面极快
      try {
        if (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.emit) {
          window.__TAURI__.event.emit('browser-clip-selected-text', {
            text: savedText, url: savedUrl, title: savedTitle
          });
        }
      } catch(e) {}

      // 方式 2（可靠兜底）: URL 导航 → 触发 Rust on_navigation 回调
      // 外部 HTTPS 页面 __TAURI__ 不可用、fetch 被混合内容策略阻止时，这是唯一可靠通道
      // on_navigation 返回 false 会取消实际导航，不会离开当前页面
      var navUrl = 'https://aipen-clip.internal/save/' + encoded;
      // 使用 setTimeout(0) 延迟导航，确保在菜单清理后再触发（避免 WebView2 竞态）
      var savedNav = navUrl;
      setTimeout(function() {
        try { window.location.href = savedNav; } catch(e) {}
      }, 0);

      // 使用 setTimeout(0) 延迟清理，避免"在事件处理器内移除当前元素"
      // 这是修复 WebView2 下菜单无法销毁的核心关键
      var el = overlayEl;
      var mel = menuEl;
      setTimeout(function() {
        if (el && el.parentNode) el.parentNode.removeChild(el);
        if (mel && mel.parentNode) mel.parentNode.removeChild(mel);
        overlayEl = null;
        menuEl = null;
        pending = false;
      }, 0);
    });
    menuEl.appendChild(clipItem);

    // 复制
    var copyItem = document.createElement('div');
    copyItem.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:6px 12px;cursor:pointer;transition:background 0.1s;';
    copyItem.innerHTML = '<span>复制</span><span style="color:#565f89;font-size:11px;margin-left:16px;">Ctrl+C</span>';
    copyItem.addEventListener('mouseenter', function() { if (!pending) copyItem.style.background = '#29293d'; });
    copyItem.addEventListener('mouseleave', function() { if (!pending) copyItem.style.background = ''; });
    copyItem.addEventListener('mousedown', function(ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (pending) return;
      pending = true;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(function(){});
      }
      var el2 = overlayEl;
      var mel2 = menuEl;
      setTimeout(function() {
        if (el2 && el2.parentNode) el2.parentNode.removeChild(el2);
        if (mel2 && mel2.parentNode) mel2.parentNode.removeChild(mel2);
        overlayEl = null;
        menuEl = null;
        pending = false;
      }, 0);
    });
    menuEl.appendChild(copyItem);

    document.body.appendChild(overlayEl);
    document.body.appendChild(menuEl);
  }, true);
})();
"#;

#[tauri::command]
pub async fn create_browser_webview(
    app: tauri::AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    // 关闭已存在的浏览器
    if let Some(wv) = app.get_webview_window("browser") {
        let _ = wv.close();
    }

    let parsed = url::Url::parse(&url).map_err(|e| format!("无效网址: {}", e))?;
    let main = app.get_webview_window("main").ok_or("找不到主窗口")?;

    // 获取主窗口屏幕位置 + DPI 缩放，算出浏览器窗口的屏幕坐标
    let main_pos = main.outer_position().map_err(|e| format!("获取窗口位置失败: {}", e))?;
    let scale = main.scale_factor().map_err(|e| format!("获取缩放因子失败: {}", e))?;
    let logical_x = main_pos.x as f64 / scale + x;
    let logical_y = main_pos.y as f64 / scale + y;

    let app_handle = app.clone();
    let app_handle2 = app.clone();

    let wv = tauri::WebviewWindowBuilder::new(
        &app,
        "browser",
        tauri::WebviewUrl::External(parsed),
    )
    .position(logical_x, logical_y)
    .inner_size(width, height)
    .decorations(false)
    .skip_taskbar(true)
    .resizable(true)
    .always_on_top(true)
    .initialization_script(BROWSER_INIT_SCRIPT)
    .on_navigation(move |url| {
        eprintln!("[Browser] on_navigation: {}", url);
        // 拦截 https://aipen-clip.internal/save/<base64> 导航，提取剪藏 payload
        if url.host_str() == Some("aipen-clip.internal") && url.path().starts_with("/save/") {
            let encoded = url.path().strip_prefix("/save/").unwrap_or("");
            eprintln!("[Browser] 剪藏导航，base64 长度: {}", encoded.len());
            // 使用 URL 安全 base64 解码（与初始化脚本编码方式匹配）
            if let Ok(bytes) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(encoded) {
                if let Ok(json_str) = String::from_utf8(bytes) {
                    eprintln!("[Browser] 解码成功，payload 长度: {}", json_str.len());
                    if crate::should_process_clip(&json_str) {
                        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(&json_str) {
                            // 通道1: emit 事件
                            let _ = app_handle.emit("browser-clip-selected-text", &payload);
                            // 通道2: eval 直接调用主窗口全局函数
                            if let Some(main_win) = app_handle.get_webview_window("main") {
                                let js = format!(
                                    "window.__aipenReceiveClip && window.__aipenReceiveClip({})",
                                    json_str
                                );
                                let _ = main_win.eval(&js);
                            }
                            // 隐藏浏览器窗口，使主窗口的素材剪藏弹窗可见
                            if let Some(wv) = app_handle.get_webview_window("browser") {
                                let _ = wv.hide();
                            }
                            if let Some(main_win) = app_handle.get_webview_window("main") {
                                let _ = main_win.set_focus();
                            }
                        }
                    }
                }
            } else {
                eprintln!("[Browser] base64 解码失败");
            }
            return false;
        }
        true
    })
    .build()
    .map_err(|e| format!("创建浏览器窗口失败: {}", e))?;

    // 监听浏览器窗口失焦：当浏览器失焦且主窗口也没焦点时 → 隐藏浏览器
    // 这处理"用户点击程序外其他地方"的场景。浏览器窗口与主窗口是独立的，
    // 用户点击主窗口不会触发此处（主窗口获焦由前端 onFocusChanged 处理）。
    wv.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(false) = event {
            if let Some(main) = app_handle2.get_webview_window("main") {
                if let Ok(main_focused) = main.is_focused() {
                    if !main_focused {
                        // 浏览器失焦 + 主窗口也失焦 → 用户点到了程序外 → 隐藏浏览器
                        if let Some(wv) = app_handle2.get_webview_window("browser") {
                            let _ = wv.hide();
                        }
                    }
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn navigate_browser(
    app: tauri::AppHandle,
    url: String,
) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|e| format!("无效网址: {}", e))?;
    let wv = app.get_webview_window("browser").ok_or("浏览器未打开".to_string())?;
    wv.navigate(parsed).map_err(|e| format!("导航失败: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn navigate_browser_back(app: tauri::AppHandle) -> Result<(), String> {
    let wv = app.get_webview_window("browser").ok_or("浏览器未打开".to_string())?;
    wv.eval("history.back()").map_err(|e| format!("后退失败: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn navigate_browser_forward(app: tauri::AppHandle) -> Result<(), String> {
    let wv = app.get_webview_window("browser").ok_or("浏览器未打开".to_string())?;
    wv.eval("history.forward()").map_err(|e| format!("前进失败: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn navigate_browser_refresh(app: tauri::AppHandle) -> Result<(), String> {
    let wv = app.get_webview_window("browser").ok_or("浏览器未打开".to_string())?;
    wv.eval("location.reload()").map_err(|e| format!("刷新失败: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn resize_browser_webview(
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let wv = app.get_webview_window("browser").ok_or("浏览器未打开".to_string())?;
    let main = app.get_webview_window("main").ok_or("找不到主窗口")?;
    let main_pos = main.outer_position().map_err(|e| format!("获取窗口位置失败: {}", e))?;
    // 缩放因子使用主窗口的（与 create_browser_webview 保持一致），
    // 避免不同显示器/多屏场景下两个窗口的 scale_factor 不一致时换算误差
    let scale = main.scale_factor().map_err(|e| format!("获取缩放因子失败: {}", e))?;
    let logical_x = main_pos.x as f64 / scale + x;
    let logical_y = main_pos.y as f64 / scale + y;
    wv.set_position(tauri::LogicalPosition::new(logical_x, logical_y))
        .map_err(|e| format!("设置位置失败: {}", e))?;
    wv.set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| format!("设置大小失败: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn close_browser(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(wv) = app.get_webview_window("browser") {
        let _ = wv.close();
    }
    Ok(())
}

#[tauri::command]
pub async fn hide_browser(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(wv) = app.get_webview_window("browser") {
        wv.hide().map_err(|e| format!("隐藏浏览器失败: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn show_browser(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(wv) = app.get_webview_window("browser") {
        wv.show().map_err(|e| format!("显示浏览器失败: {}", e))?;
    }
    Ok(())
}
