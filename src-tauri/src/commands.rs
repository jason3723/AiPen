use crate::{ai, db, diff, version};
use tauri::State;

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
) -> Result<ai::AIAnalysis, String> {
    let config = {
        let cfg = state.ai_config.lock().map_err(|e| e.to_string())?;
        cfg.clone()
    };

    let old = db::get_version_content(&state.db, &old_version_id)
        .await
        .map_err(|e| e.to_string())?;
    let new = db::get_version_content(&state.db, &new_version_id)
        .await
        .map_err(|e| e.to_string())?;
    let diff_result = diff::diff_documents(&old, &new);

    let analysis = ai::analyze_revision(
        &old,
        &new,
        diff_result.additions,
        diff_result.deletions,
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
    provider: String,
    api_key: String,
    api_url: String,
    model: String,
) -> Result<(), String> {
    let cfg = ai::AIConfig {
        provider: if provider.is_empty() { "openai".into() } else { provider },
        api_key,
        api_url: if api_url.is_empty() {
            "https://api.openai.com/v1/chat/completions".into()
        } else {
            api_url
        },
        model: if model.is_empty() { "gpt-4o".into() } else { model },
    };

    // 保存到内存
    {
        let mut stored = state.ai_config.lock().map_err(|e| e.to_string())?;
        *stored = cfg.clone();
    }

    // 持久化到数据库
    db::set_config(&state.db, "ai_provider", &format!("\"{}\"", cfg.provider))
        .await.map_err(|e| e.to_string())?;
    db::set_config(&state.db, "ai_model", &format!("\"{}\"", cfg.model))
        .await.map_err(|e| e.to_string())?;
    db::set_config(&state.db, "ai_api_url", &format!("\"{}\"", cfg.api_url))
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
