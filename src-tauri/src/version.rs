use crate::db;
use sqlx::SqlitePool;

#[derive(Debug, thiserror::Error)]
pub enum VersionError {
    #[error("{0}")]
    Db(#[from] db::DbError),
    #[error("文档不存在: {0}")]
    DocNotFound(String),
}

/// 创建新版本
/// - 检查文档是否存在
/// - 获取最新版本号并 +1
/// - 记录 parent_id 为上一版本的 id
pub async fn create_new_version(
    pool: &SqlitePool,
    doc_id: &str,
    content: &str,
    commit_msg: &str,
) -> Result<db::Version, VersionError> {
    // 检查文档是否存在
    db::get_document(pool, doc_id).await.map_err(|_| VersionError::DocNotFound(doc_id.to_string()))?;

    // 获取当前最大版本号
    let latest = db::get_latest_version(pool, doc_id).await?;
    let (new_version_num, parent_id) = match latest {
        Some(v) => (v.version_num + 1, Some(v.id)),
        None => (1, None),
    };

    // 创建新版本
    let version = db::create_version(pool, doc_id, content, commit_msg, new_version_num, parent_id.as_deref()).await?;
    Ok(version)
}

/// 获取版本时间线（按版本号升序）
pub async fn get_version_tree(
    pool: &SqlitePool,
    doc_id: &str,
) -> Result<Vec<db::Version>, VersionError> {
    let versions = db::get_versions_by_doc(pool, doc_id).await?;
    Ok(versions)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    async fn setup_test_db() -> SqlitePool {
        let pool = db::init_db("sqlite::memory:").await.unwrap();
        // 创建测试文档
        db::create_document(&pool, "测试文档").await.unwrap();
        pool
    }

    #[tokio::test]
    async fn test_create_first_version() {
        let pool = setup_test_db().await;
        let doc = db::list_documents(&pool).await.unwrap().into_iter().next().unwrap();

        let version = create_new_version(&pool, &doc.id, "# Hello", "初始版本").await.unwrap();
        assert_eq!(version.version_num, 1);
        assert_eq!(version.commit_msg, "初始版本");
        assert!(version.parent_id.is_none());
    }

    #[tokio::test]
    async fn test_create_second_version() {
        let pool = setup_test_db().await;
        let doc = db::list_documents(&pool).await.unwrap().into_iter().next().unwrap();

        let v1 = create_new_version(&pool, &doc.id, "# Hello", "v1").await.unwrap();
        let v2 = create_new_version(&pool, &doc.id, "# Hello World", "v2").await.unwrap();

        assert_eq!(v2.version_num, 2);
        assert_eq!(v2.parent_id, Some(v1.id));
    }

    #[tokio::test]
    async fn test_get_version_tree() {
        let pool = setup_test_db().await;
        let doc = db::list_documents(&pool).await.unwrap().into_iter().next().unwrap();

        create_new_version(&pool, &doc.id, "v1", "v1").await.unwrap();
        create_new_version(&pool, &doc.id, "v2", "v2").await.unwrap();
        create_new_version(&pool, &doc.id, "v3", "v3").await.unwrap();

        let tree = get_version_tree(&pool, &doc.id).await.unwrap();
        assert_eq!(tree.len(), 3);
        assert_eq!(tree[0].version_num, 1);
        assert_eq!(tree[2].version_num, 3);
    }
}
