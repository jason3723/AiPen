mod ai;
mod commands;
mod db;
mod diff;
mod version;

use std::sync::Mutex;

pub struct AppState {
    pub db: sqlx::SqlitePool,
    pub ai_config: Mutex<ai::AIConfig>,
}

fn load_config_from_db(pool: &sqlx::SqlitePool) -> ai::AIConfig {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let provider = rt.block_on(db::get_config(pool, "ai_provider"))
        .ok().flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| "openai".to_string());
    let model = rt.block_on(db::get_config(pool, "ai_model"))
        .ok().flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| "gpt-4o".to_string());
    let api_url = rt.block_on(db::get_config(pool, "ai_api_url"))
        .ok().flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| "https://api.openai.com/v1/chat/completions".to_string());

    ai::AIConfig {
        provider,
        api_key: String::new(),  // 密钥不持久化存储，每次由前端设置
        api_url,
        model,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 使用 tokio runtime 初始化数据库
    let rt = tokio::runtime::Runtime::new().unwrap();
    let db_path = dirs_next::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("aipen")
        .join("aipen.db");

    // 确保目录存在
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    let pool = rt.block_on(db::init_db(db_path.to_str().unwrap()))
        .expect("数据库初始化失败");

    let ai_config = load_config_from_db(&pool);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            db: pool,
            ai_config: Mutex::new(ai_config),
        })
        .invoke_handler(tauri::generate_handler![
            // 文档
            commands::create_document,
            commands::get_document,
            commands::list_documents,
            // 版本
            commands::commit_version,
            commands::get_versions,
            commands::get_version,
            // Diff
            commands::get_diff,
            // AI
            commands::analyze_revision,
            commands::get_analysis,
            // 配置
            commands::get_api_config,
            commands::set_api_config,
            commands::test_api_connection,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
