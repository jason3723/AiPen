mod ai;
mod commands;
mod db;
mod diff;
mod version;

use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use base64::Engine;

/// 剪藏去重：5 秒内相同 payload 只处理一次，防止 fetch + on_navigation 双通道重复
static LAST_CLIP: Mutex<Option<(String, Instant)>> = Mutex::new(None);

fn should_process_clip(payload: &str) -> bool {
    let mut last = LAST_CLIP.lock().unwrap();
    if let Some((last_payload, last_time)) = last.as_ref() {
        if last_payload == payload && last_time.elapsed() < Duration::from_secs(5) {
            return false;
        }
    }
    *last = Some((payload.to_string(), Instant::now()));
    true
}

pub struct AppState {
    pub db: sqlx::SqlitePool,
    pub ai_config: Mutex<ai::AIConfig>,
}

async fn load_config_from_db(pool: &sqlx::SqlitePool) -> ai::AIConfig {
    let model = db::get_config(pool, "ai_model")
        .await
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| "deepseek-v4-flash".to_string());
    let api_url = db::get_config(pool, "ai_api_url")
        .await
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| "https://api.deepseek.com".to_string());
    let api_key = db::get_config(pool, "ai_api_key")
        .await
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let thinking_enabled = db::get_config(pool, "ai_thinking_enabled")
        .await
        .ok()
        .flatten()
        .and_then(|s| s.parse().ok())
        .unwrap_or(false);
    let reasoning_effort = db::get_config(pool, "ai_reasoning_effort")
        .await
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| "high".to_string());

    ai::AIConfig {
        api_key,
        api_url,
        model,
        thinking_enabled,
        reasoning_effort,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // ── 自定义 URI scheme：aipen-clip ──
        // 浏览器 WebView（外部页面）通过 fetch('http://aipen-clip.localhost/save/<base64>')
        // 将选中文本发送回 Rust 端，绕过 __TAURI__ 不可用的问题
        .register_uri_scheme_protocol("aipen-clip", move |ctx, request| {
            let uri = request.uri().to_string();
            eprintln!("[aipen-clip] 收到请求: {}", uri);

            // 处理 CORS 预检
            if request.method() == "OPTIONS" {
                return tauri::http::Response::builder()
                    .header("Access-Control-Allow-Origin", "*")
                    .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                    .header("Access-Control-Allow-Headers", "*")
                    .status(204)
                    .body(Vec::new())
                    .unwrap();
            }

            // 解析 URL：http://aipen-clip.localhost/save/<base64>
            if let Ok(url) = url::Url::parse(&uri) {
                let path = url.path();
                if path.starts_with("/save/") {
                    let encoded = path.strip_prefix("/save/").unwrap_or("");
                    eprintln!("[aipen-clip] base64 长度: {}", encoded.len());

                    if let Ok(bytes) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(encoded) {
                        if let Ok(json_str) = String::from_utf8(bytes) {
                            eprintln!("[aipen-clip] 解码成功，payload 长度: {}", json_str.len());

                            // 去重检查
                            if should_process_clip(&json_str) {
                                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(&json_str) {
                                    let app = ctx.app_handle();
                                    // 通道1: emit 事件
                                    let _ = app.emit("browser-clip-selected-text", &payload);
                                    // 通道2: eval 直接调用主窗口全局函数
                                    if let Some(main_win) = app.get_webview_window("main") {
                                        let js = format!(
                                            "window.__aipenReceiveClip && window.__aipenReceiveClip({})",
                                            json_str
                                        );
                                        let _ = main_win.eval(&js);
                                    }
                                    // 隐藏浏览器窗口，使主窗口弹窗可见
                                    if let Some(wv) = app.get_webview_window("browser") {
                                        let _ = wv.hide();
                                    }
                                    if let Some(main_win) = app.get_webview_window("main") {
                                        let _ = main_win.set_focus();
                                    }
                                }
                            }
                        }
                    } else {
                        eprintln!("[aipen-clip] base64 解码失败");
                    }
                }
            }

            // 返回简单 JSON 响应
            tauri::http::Response::builder()
                .header("Content-Type", "application/json")
                .header("Access-Control-Allow-Origin", "*")
                .status(200)
                .body(b"{\"ok\":true}".to_vec())
                .unwrap()
        })
        .setup(|app| {
            let app_dir = app.path().app_data_dir()
                .map_err(|e| format!("获取应用数据目录失败: {}", e))
                .expect("无法获取应用数据目录");
            std::fs::create_dir_all(&app_dir)
                .expect("无法创建应用数据目录");

            // 创建本地数据目录 + images 子目录（用于图片等非关键持久化缓存）
            let local_dir = app.path().app_local_data_dir()
                .map_err(|e| format!("获取本地应用数据目录失败: {}", e))
                .expect("无法获取本地应用数据目录");
            let images_dir = local_dir.join("images");
            std::fs::create_dir_all(&images_dir)
                .expect("无法创建图片目录");

            let db_path = app_dir.join("aipen.db");
            eprintln!("[AiPen] 数据库路径: {:?}", db_path);

            let handle = app.handle().clone();
            tauri::async_runtime::block_on(async move {
                let pool = db::init_db(&db_path)
                    .await
                    .expect("数据库初始化失败");

                // 验证数据库中有多少文档
                let doc_count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM documents")
                    .fetch_one(&pool)
                    .await
                    .unwrap_or(0);
                eprintln!("[AiPen] 现有文档数: {}", doc_count);

                let ai_config = load_config_from_db(&pool).await;

                handle.manage(AppState {
                    db: pool,
                    ai_config: Mutex::new(ai_config),
                });
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_folder,
            commands::list_folders,
            commands::rename_folder,
            commands::delete_folder,
            commands::move_document,
            commands::remove_document_from_folder,
            commands::create_document,
            commands::get_document,
            commands::list_documents,
            commands::save_draft,
            commands::get_draft,
            commands::update_document_title,
            commands::delete_document,
            commands::commit_version,
            commands::get_versions,
            commands::get_version,
            commands::rename_version,
            commands::delete_version,
            commands::get_diff,
            commands::analyze_revision,
            commands::get_analysis,
            commands::get_api_config,
            commands::set_api_config,
            commands::test_api_connection,
            commands::query_balance,
            commands::get_document_export_settings,
            commands::save_document_export_settings,
            commands::check_file_writable,
            commands::export_word_file,
            commands::read_image_file,
            commands::save_image_file,
            commands::save_image_bytes,
            commands::exit_app,
            commands::list_knowledge_bases,
            commands::create_knowledge_base,
            commands::update_knowledge_base,
            commands::delete_knowledge_base,
            commands::parse_kb_file,
            commands::list_skills,
            commands::create_skill,
            commands::update_skill,
            commands::delete_skill,
            commands::list_interview_prompts,
            commands::save_interview_prompt,
            commands::delete_interview_prompt,
            commands::list_compose_recipes,
            commands::save_compose_recipe,
            commands::delete_compose_recipe,
            commands::run_skill,
            commands::create_conversation,
            commands::list_conversations,
            commands::delete_conversation,
            commands::rename_conversation,
            commands::get_chat_messages,
            commands::send_chat_message,
            commands::export_data,
            commands::export_selected_data,
            commands::import_data,
            commands::ai_compose,
            commands::ai_compose_streaming,
            commands::compose_review,
            commands::compose_review_streaming,
            commands::send_chat_message_streaming,
            commands::run_skill_streaming,
            commands::run_skill_pipeline_streaming,
            commands::generate_interview_questions,
            commands::score_document,
            commands::get_document_score,
            commands::list_materials,
            commands::get_material,
            commands::save_material,
            commands::update_material_content,
            commands::delete_material,
            commands::set_material_tags,
            commands::list_tags,
            commands::list_tags_with_count,
            commands::create_tag,
            commands::delete_tag,
            commands::rename_tag,
            commands::suggest_tags,
            commands::add_bookmark,
            commands::list_bookmarks,
            commands::delete_bookmark,
            commands::create_browser_webview,
            commands::navigate_browser,
            commands::navigate_browser_back,
            commands::navigate_browser_forward,
            commands::navigate_browser_refresh,
            commands::resize_browser_webview,
            commands::close_browser,
            commands::hide_browser,
            commands::show_browser,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
