use sqlx::sqlite::SqlitePoolOptions;
use sqlx::{Pool, Sqlite, Row};
use serde::{Deserialize, Serialize};

// ─── 错误类型 ────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("数据库错误: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("记录未找到: {0}")]
    NotFound(String),
}

// ─── 模型 ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Document {
    pub id: String,
    pub title: String,
    pub project_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Version {
    pub id: String,
    pub doc_id: String,
    pub version_num: i64,
    pub commit_msg: String,
    pub content: String,
    pub parent_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AIAnalysisRecord {
    pub id: String,
    pub version_id: String,
    pub old_version_id: Option<String>,
    pub analysis: String,  // JSON string of AIAnalysis
    pub created_at: String,
}

// ─── 数据库初始化 ────────────────────────────────────────────

pub async fn init_db(db_path: &str) -> Result<Pool<Sqlite>, DbError> {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(db_path)
        .await?;

    // 启用外键约束
    sqlx::query("PRAGMA foreign_keys = ON").execute(&pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS documents (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL,
            project_id  TEXT NOT NULL DEFAULT 'default',
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        )"
    ).execute(&pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS versions (
            id          TEXT PRIMARY KEY,
            doc_id      TEXT NOT NULL,
            version_num INTEGER NOT NULL,
            commit_msg  TEXT NOT NULL DEFAULT '',
            content     TEXT NOT NULL,
            parent_id   TEXT,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE,
            FOREIGN KEY (parent_id) REFERENCES versions(id)
        )"
    ).execute(&pool).await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_versions_doc ON versions(doc_id)"
    ).execute(&pool).await?;

    sqlx::query(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_doc_num ON versions(doc_id, version_num)"
    ).execute(&pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS ai_analysis (
            id              TEXT PRIMARY KEY,
            version_id      TEXT NOT NULL,
            old_version_id  TEXT,
            analysis        TEXT NOT NULL,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (version_id) REFERENCES versions(id) ON DELETE CASCADE
        )"
    ).execute(&pool).await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_ai_analysis_version ON ai_analysis(version_id)"
    ).execute(&pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS app_config (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )"
    ).execute(&pool).await?;

    // 插入默认配置
    sqlx::query(
        "INSERT OR IGNORE INTO app_config (key, value) VALUES ('ai_provider', '\"openai\"')"
    ).execute(&pool).await?;
    sqlx::query(
        "INSERT OR IGNORE INTO app_config (key, value) VALUES ('ai_model', '\"gpt-4o\"')"
    ).execute(&pool).await?;
    sqlx::query(
        "INSERT OR IGNORE INTO app_config (key, value) VALUES ('ai_api_url', '\"https://api.openai.com/v1/chat/completions\"')"
    ).execute(&pool).await?;

    Ok(pool)
}

// ─── 文档 CRUD ──────────────────────────────────────────────

pub async fn create_document(pool: &Pool<Sqlite>, title: &str) -> Result<Document, DbError> {
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO documents (id, title) VALUES (?, ?)")
        .bind(&id).bind(title)
        .execute(pool).await?;
    get_document(pool, &id).await
}

pub async fn get_document(pool: &Pool<Sqlite>, doc_id: &str) -> Result<Document, DbError> {
    let row = sqlx::query(
        "SELECT id, title, project_id, created_at, updated_at FROM documents WHERE id = ?"
    ).bind(doc_id).fetch_optional(pool).await?
        .ok_or_else(|| DbError::NotFound(format!("文档 {} 不存在", doc_id)))?;
    Ok(Document {
        id: row.get("id"),
        title: row.get("title"),
        project_id: row.get("project_id"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

pub async fn list_documents(pool: &Pool<Sqlite>) -> Result<Vec<Document>, DbError> {
    let rows = sqlx::query(
        "SELECT id, title, project_id, created_at, updated_at FROM documents ORDER BY updated_at DESC"
    ).fetch_all(pool).await?;
    Ok(rows.into_iter().map(|row| Document {
        id: row.get("id"),
        title: row.get("title"),
        project_id: row.get("project_id"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }).collect())
}

pub async fn update_document_title(pool: &Pool<Sqlite>, doc_id: &str, title: &str) -> Result<(), DbError> {
    let affected = sqlx::query(
        "UPDATE documents SET title = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(title).bind(doc_id).execute(pool).await?.rows_affected();
    if affected == 0 {
        return Err(DbError::NotFound(format!("文档 {} 不存在", doc_id)));
    }
    Ok(())
}

// ─── 版本 CRUD ──────────────────────────────────────────────

pub async fn create_version(
    pool: &Pool<Sqlite>,
    doc_id: &str,
    content: &str,
    commit_msg: &str,
    version_num: i64,
    parent_id: Option<&str>,
) -> Result<Version, DbError> {
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO versions (id, doc_id, version_num, commit_msg, content, parent_id) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(&id).bind(doc_id).bind(version_num).bind(commit_msg).bind(content).bind(parent_id)
     .execute(pool).await?;
    get_version(pool, &id).await
}

pub async fn get_version(pool: &Pool<Sqlite>, version_id: &str) -> Result<Version, DbError> {
    let row = sqlx::query(
        "SELECT id, doc_id, version_num, commit_msg, content, parent_id, created_at FROM versions WHERE id = ?"
    ).bind(version_id).fetch_optional(pool).await?
        .ok_or_else(|| DbError::NotFound(format!("版本 {} 不存在", version_id)))?;
    Ok(Version {
        id: row.get("id"),
        doc_id: row.get("doc_id"),
        version_num: row.get("version_num"),
        commit_msg: row.get("commit_msg"),
        content: row.get("content"),
        parent_id: row.get("parent_id"),
        created_at: row.get("created_at"),
    })
}

pub async fn get_version_content(pool: &Pool<Sqlite>, version_id: &str) -> Result<String, DbError> {
    let row = sqlx::query("SELECT content FROM versions WHERE id = ?")
        .bind(version_id).fetch_optional(pool).await?
        .ok_or_else(|| DbError::NotFound(format!("版本 {} 不存在", version_id)))?;
    Ok(row.get::<String, _>("content"))
}

pub async fn get_versions_by_doc(pool: &Pool<Sqlite>, doc_id: &str) -> Result<Vec<Version>, DbError> {
    let rows = sqlx::query(
        "SELECT id, doc_id, version_num, commit_msg, content, parent_id, created_at FROM versions WHERE doc_id = ? ORDER BY version_num ASC"
    ).bind(doc_id).fetch_all(pool).await?;
    Ok(rows.into_iter().map(|row| Version {
        id: row.get("id"),
        doc_id: row.get("doc_id"),
        version_num: row.get("version_num"),
        commit_msg: row.get("commit_msg"),
        content: row.get("content"),
        parent_id: row.get("parent_id"),
        created_at: row.get("created_at"),
    }).collect())
}

pub async fn get_latest_version(pool: &Pool<Sqlite>, doc_id: &str) -> Result<Option<Version>, DbError> {
    let row = sqlx::query(
        "SELECT id, doc_id, version_num, commit_msg, content, parent_id, created_at FROM versions WHERE doc_id = ? ORDER BY version_num DESC LIMIT 1"
    ).bind(doc_id).fetch_optional(pool).await?;
    Ok(row.map(|r| Version {
        id: r.get("id"),
        doc_id: r.get("doc_id"),
        version_num: r.get("version_num"),
        commit_msg: r.get("commit_msg"),
        content: r.get("content"),
        parent_id: r.get("parent_id"),
        created_at: r.get("created_at"),
    }))
}

// ─── AI 分析 CRUD ───────────────────────────────────────────

pub async fn save_analysis(
    pool: &Pool<Sqlite>,
    version_id: &str,
    old_version_id: Option<&str>,
    analysis: &str,
) -> Result<(), DbError> {
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO ai_analysis (id, version_id, old_version_id, analysis) VALUES (?, ?, ?, ?)"
    ).bind(&id).bind(version_id).bind(old_version_id).bind(analysis)
     .execute(pool).await?;
    Ok(())
}

pub async fn get_analysis(pool: &Pool<Sqlite>, version_id: &str) -> Result<Option<(String, Option<String>)>, DbError> {
    let row = sqlx::query(
        "SELECT analysis, old_version_id FROM ai_analysis WHERE version_id = ? ORDER BY created_at DESC LIMIT 1"
    ).bind(version_id).fetch_optional(pool).await?;
    Ok(row.map(|r| (r.get("analysis"), r.get("old_version_id"))))
}

// ─── 配置 CRUD ──────────────────────────────────────────────

pub async fn get_config(pool: &Pool<Sqlite>, key: &str) -> Result<Option<String>, DbError> {
    let row = sqlx::query("SELECT value FROM app_config WHERE key = ?")
        .bind(key).fetch_optional(pool).await?;
    Ok(row.map(|r| r.get("value")))
}

pub async fn set_config(pool: &Pool<Sqlite>, key: &str, value: &str) -> Result<(), DbError> {
    sqlx::query(
        "INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)"
    ).bind(key).bind(value).execute(pool).await?;
    Ok(())
}

pub async fn get_all_configs(pool: &Pool<Sqlite>) -> Result<Vec<(String, String)>, DbError> {
    let rows = sqlx::query("SELECT key, value FROM app_config")
        .fetch_all(pool).await?;
    Ok(rows.into_iter().map(|r| (r.get("key"), r.get("value"))).collect())
}
