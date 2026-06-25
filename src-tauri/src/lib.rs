mod ai;
mod commands;
mod db;
mod diff;
mod version;

use std::sync::Mutex;
use tauri::Manager;

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
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // 使用 Tauri 的 app data 目录存储数据库
            let app_dir = app.path().app_data_dir()
                .map_err(|e| format!("获取应用数据目录失败: {}", e))
                .expect("无法获取应用数据目录");
            std::fs::create_dir_all(&app_dir)
                .expect("无法创建应用数据目录");

            let db_path = app_dir.join("aipen.db");
            println!("数据库路径: {:?}", db_path);

            let rt = tokio::runtime::Runtime::new().unwrap();
            let pool = rt.block_on(db::init_db(db_path.to_str().unwrap()))
                .expect("数据库初始化失败");

            let ai_config = load_config_from_db(&pool);

            app.manage(AppState {
                db: pool,
                ai_config: Mutex::new(ai_config),
            });

            Ok(())
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
