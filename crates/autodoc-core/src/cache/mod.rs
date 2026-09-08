pub mod schema;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::thread;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, Connection, TransactionBehavior};
use tracing::{error, info, warn};
use crate::cache::schema::initialize_schema;
use crate::errors::AutoDocError;

pub enum StorageCommand {
    InsertFile {
        path: String,
        mtime_ns: i64,
        size_bytes: i64,
        git_oid: String,
        language: String,
        responder: Sender<Result<i64, AutoDocError>>,
    },
    InsertSymbol {
        file_id: i64,
        fqsn: String,
        name: String,
        kind: String,
        visibility: String,
        line_start: i32,
        line_end: i32,
        complexity: i32,
        signature: String,
        docstring: Option<String>,
        responder: Sender<Result<i64, AutoDocError>>,
    },
    InsertEdge {
        caller_id: i64,
        callee_id: i64,
        edge_kind: String,
        weight: f64,
        responder: Sender<Result<(), AutoDocError>>,
    },
    CheckpointPassive {
        responder: Sender<Result<(), AutoDocError>>,
    },
    VacuumAndOptimize {
        responder: Sender<Result<(), AutoDocError>>,
    },
    Shutdown,
}

pub struct StorageEngine {
    reader_pool: Pool<SqliteConnectionManager>,
    writer_sender: Sender<StorageCommand>,
    db_path: PathBuf,
}

impl StorageEngine {
    /// Opens or creates the SQLite WAL database.
    /// Implements automatic fallback to XDG cache if repo_root is read-only.
    pub fn new(repo_root: &Path) -> Result<Self, AutoDocError> {
        let default_dir = repo_root.join(".autodoc");
        let is_ro = if default_dir.exists() {
            std::fs::metadata(&default_dir).map(|m| m.permissions().readonly()).unwrap_or(false)
        } else {
            std::fs::create_dir_all(&default_dir).is_err()
        };

        let db_path = if is_ro {
            let cache_home = std::env::var("XDG_CACHE_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|_| {
                    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")).unwrap_or_else(|| PathBuf::from("/tmp"))
                });
            let repo_hash = format!("{:016x}", twox_hash::XxHash64::oneshot(0, repo_root.to_string_lossy().as_bytes()));
            let fallback_dir = cache_home.join("autodoc").join(repo_hash);
            let _ = std::fs::create_dir_all(&fallback_dir);
            warn!("Target repository directory is read-only. Falling back to XDG cache: {:?}", fallback_dir);
            fallback_dir.join("cache.db")
        } else {
            default_dir.join("cache.db")
        };

        // Initialize schema with temporary connection
        {
            let conn = Connection::open(&db_path).map_err(|e| AutoDocError::StorageError {
                detail: format!("Failed to open DB for schema init: {}", e),
            })?;
            initialize_schema(&conn).map_err(|e| AutoDocError::StorageError {
                detail: format!("Schema initialization error: {}", e),
            })?;
        }

        // 1. Reader Pool (r2d2)
        let manager = SqliteConnectionManager::file(&db_path)
            .with_init(|c| {
                c.execute_batch(
                    r#"
                    PRAGMA journal_mode = WAL;
                    PRAGMA synchronous = NORMAL;
                    PRAGMA busy_timeout = 5000;
                    PRAGMA mmap_size = 67108864;
                    PRAGMA cache_size = -16000;
                    "#,
                )
            });

        let num_readers = (std::thread::available_parallelism().map(|p| p.get()).unwrap_or(4) * 2).clamp(2, 32);
        let reader_pool = Pool::builder()
            .max_size(num_readers as u32)
            .build(manager)
            .map_err(|e| AutoDocError::StorageError {
                detail: format!("Failed to build reader connection pool: {}", e),
            })?;

        // 2. Dedicated Writer Thread
        let (writer_sender, receiver) = channel::<StorageCommand>();
        let writer_db_path = db_path.clone();

        thread::Builder::new()
            .name("autodoc-sqlite-writer".to_string())
            .spawn(move || {
                let mut conn = match Connection::open(&writer_db_path) {
                    Ok(c) => c,
                    Err(e) => {
                        error!("Failed to open writer connection: {}", e);
                        return;
                    }
                };

                let _ = conn.execute_batch(
                    r#"
                    PRAGMA journal_mode = WAL;
                    PRAGMA synchronous = NORMAL;
                    PRAGMA busy_timeout = 5000;
                    PRAGMA mmap_size = 67108864;
                    "#,
                );

                while let Ok(cmd) = receiver.recv() {
                    match cmd {
                        StorageCommand::InsertFile { path, mtime_ns, size_bytes, git_oid, language, responder } => {
                            let res = Self::write_file(&mut conn, &path, mtime_ns, size_bytes, &git_oid, &language);
                            let _ = responder.send(res);
                        }
                        StorageCommand::InsertSymbol { file_id, fqsn, name, kind, visibility, line_start, line_end, complexity, signature, docstring, responder } => {
                            let res = Self::write_symbol(&mut conn, file_id, &fqsn, &name, &kind, &visibility, line_start, line_end, complexity, &signature, docstring.as_deref());
                            let _ = responder.send(res);
                        }
                        StorageCommand::InsertEdge { caller_id, callee_id, edge_kind, weight, responder } => {
                            let res = Self::write_edge(&mut conn, caller_id, callee_id, &edge_kind, weight);
                            let _ = responder.send(res);
                        }
                        StorageCommand::CheckpointPassive { responder } => {
                            let res = conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE);")
                                .map_err(|e| AutoDocError::StorageError { detail: e.to_string() });
                            let _ = responder.send(res);
                        }
                        StorageCommand::VacuumAndOptimize { responder } => {
                            let res = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize; VACUUM;")
                                .map_err(|e| AutoDocError::StorageError { detail: e.to_string() });
                            let _ = responder.send(res);
                        }
                        StorageCommand::Shutdown => {
                            let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;");
                            break;
                        }
                    }
                }
            })
            .map_err(|e| AutoDocError::Internal(format!("Failed to spawn writer thread: {}", e)))?;

        info!("Storage engine initialized cleanly at {:?}", db_path);
        Ok(Self {
            reader_pool,
            writer_sender,
            db_path,
        })
    }

    fn write_file(conn: &mut Connection, path: &str, mtime_ns: i64, size_bytes: i64, git_oid: &str, lang: &str) -> Result<i64, AutoDocError> {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| AutoDocError::StorageError { detail: e.to_string() })?;

        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
        tx.execute(
            r#"
            INSERT INTO files (path, mtime_ns, size_bytes, git_oid, language, indexed_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(path) DO UPDATE SET
                mtime_ns = excluded.mtime_ns,
                size_bytes = excluded.size_bytes,
                git_oid = excluded.git_oid,
                language = excluded.language,
                indexed_at = excluded.indexed_at;
            "#,
            params![path, mtime_ns, size_bytes, git_oid, lang, now],
        ).map_err(|e| AutoDocError::StorageError { detail: e.to_string() })?;

        let file_id = tx.last_insert_rowid();
        tx.commit().map_err(|e| AutoDocError::StorageError { detail: e.to_string() })?;
        Ok(file_id)
    }

    fn write_symbol(
        conn: &mut Connection,
        file_id: i64,
        fqsn: &str,
        name: &str,
        kind: &str,
        visibility: &str,
        line_start: i32,
        line_end: i32,
        complexity: i32,
        signature: &str,
        docstring: Option<&str>,
    ) -> Result<i64, AutoDocError> {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| AutoDocError::StorageError { detail: e.to_string() })?;

        tx.execute(
            r#"
            INSERT INTO symbols (file_id, fqsn, name, kind, visibility, line_start, line_end, cyclomatic_complexity, signature_clean, docstring_clean)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(fqsn) DO UPDATE SET
                file_id = excluded.file_id,
                name = excluded.name,
                kind = excluded.kind,
                visibility = excluded.visibility,
                line_start = excluded.line_start,
                line_end = excluded.line_end,
                cyclomatic_complexity = excluded.cyclomatic_complexity,
                signature_clean = excluded.signature_clean,
                docstring_clean = excluded.docstring_clean;
            "#,
            params![file_id, fqsn, name, kind, visibility, line_start, line_end, complexity, signature, docstring],
        ).map_err(|e| AutoDocError::StorageError { detail: e.to_string() })?;

        let symbol_id = tx.last_insert_rowid();

        // Index in FTS5
        tx.execute(
            "INSERT INTO fts_symbols (fqsn, name, docstring_clean) VALUES (?1, ?2, ?3);",
            params![fqsn, name, docstring.unwrap_or("")],
        ).map_err(|e| AutoDocError::StorageError { detail: e.to_string() })?;

        tx.commit().map_err(|e| AutoDocError::StorageError { detail: e.to_string() })?;
        Ok(symbol_id)
    }

    fn write_edge(conn: &mut Connection, caller_id: i64, callee_id: i64, edge_kind: &str, weight: f64) -> Result<(), AutoDocError> {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| AutoDocError::StorageError { detail: e.to_string() })?;

        tx.execute(
            r#"
            INSERT INTO edges (caller_id, callee_id, edge_kind, weight)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(caller_id, callee_id, edge_kind) DO UPDATE SET
                weight = excluded.weight;
            "#,
            params![caller_id, callee_id, edge_kind, weight],
        ).map_err(|e| AutoDocError::StorageError { detail: e.to_string() })?;

        tx.commit().map_err(|e| AutoDocError::StorageError { detail: e.to_string() })?;
        Ok(())
    }

    pub fn insert_file(&self, path: &str, mtime_ns: i64, size_bytes: i64, git_oid: &str, lang: &str) -> Result<i64, AutoDocError> {
        let (tx, rx) = channel();
        self.writer_sender.send(StorageCommand::InsertFile {
            path: path.to_string(),
            mtime_ns,
            size_bytes,
            git_oid: git_oid.to_string(),
            language: lang.to_string(),
            responder: tx,
        }).map_err(|e| AutoDocError::Internal(e.to_string()))?;

        rx.recv().map_err(|e| AutoDocError::Internal(e.to_string()))?
    }

    pub fn insert_symbol(
        &self,
        file_id: i64,
        fqsn: &str,
        name: &str,
        kind: &str,
        visibility: &str,
        line_start: i32,
        line_end: i32,
        complexity: i32,
        signature: &str,
        docstring: Option<&str>,
    ) -> Result<i64, AutoDocError> {
        let (tx, rx) = channel();
        self.writer_sender.send(StorageCommand::InsertSymbol {
            file_id,
            fqsn: fqsn.to_string(),
            name: name.to_string(),
            kind: kind.to_string(),
            visibility: visibility.to_string(),
            line_start,
            line_end,
            complexity,
            signature: signature.to_string(),
            docstring: docstring.map(|s| s.to_string()),
            responder: tx,
        }).map_err(|e| AutoDocError::Internal(e.to_string()))?;

        rx.recv().map_err(|e| AutoDocError::Internal(e.to_string()))?
    }

    pub fn insert_edge(&self, caller_id: i64, callee_id: i64, edge_kind: &str, weight: f64) -> Result<(), AutoDocError> {
        let (tx, rx) = channel();
        self.writer_sender.send(StorageCommand::InsertEdge {
            caller_id,
            callee_id,
            edge_kind: edge_kind.to_string(),
            weight,
            responder: tx,
        }).map_err(|e| AutoDocError::Internal(e.to_string()))?;

        rx.recv().map_err(|e| AutoDocError::Internal(e.to_string()))?
    }

    pub fn reader(&self) -> Result<r2d2::PooledConnection<SqliteConnectionManager>, AutoDocError> {
        self.reader_pool.get().map_err(|e| AutoDocError::StorageError {
            detail: format!("Failed to acquire connection from reader pool: {}", e),
        })
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }
}

impl Drop for StorageEngine {
    fn drop(&mut self) {
        let _ = self.writer_sender.send(StorageCommand::Shutdown);
    }
}
