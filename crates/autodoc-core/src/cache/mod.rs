pub mod schema;
use crate::cache::schema::initialize_schema;
use crate::errors::AutoDocError;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, Connection, TransactionBehavior};
use sha2::Digest;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::thread;
use tracing::{error, info, warn};

fn storage_error(error: rusqlite::Error) -> AutoDocError {
    AutoDocError::StorageError {
        detail: error.to_string(),
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

const DEFAULT_RETAINED_PRIOR_GENERATIONS: usize = 5;

fn retained_prior_generations() -> usize {
    std::env::var("AUTODOC_GENERATION_RETENTION")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .map(|count| count.min(1_000))
        .unwrap_or(DEFAULT_RETAINED_PRIOR_GENERATIONS)
}

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
    InsertBatchAnalysis {
        path: String,
        mtime_ns: i64,
        size_bytes: i64,
        git_oid: String,
        language: String,
        symbols: Vec<crate::parser::ExtractedSymbol>,
        responder: Sender<Result<(i64, usize), AutoDocError>>,
    },
    BulkResolveEdges {
        edges: Vec<crate::parser::ExtractedEdge>,
        responder: Sender<Result<usize, AutoDocError>>,
    },
    ReconcileFiles {
        current_paths: Vec<String>,
        responder: Sender<Result<usize, AutoDocError>>,
    },
    ReplaceInventory {
        scan_id: String,
        files: Vec<crate::inventory::InventoryFile>,
        clear_existing: bool,
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
    writer_thread: Option<thread::JoinHandle<()>>,
    is_staging: bool,
    staging_scan_id: Option<String>,
}

impl StorageEngine {
    /// Opens or creates the SQLite WAL database.
    /// Implements automatic fallback to XDG cache if repo_root is read-only.
    pub fn new(repo_root: &Path) -> Result<Self, AutoDocError> {
        let default_dir = repo_root.join(".autodoc");
        let is_ro = if default_dir.exists() {
            std::fs::metadata(&default_dir)
                .map(|m| m.permissions().readonly())
                .unwrap_or(false)
        } else {
            std::fs::create_dir_all(&default_dir).is_err()
        };

        let db_path = if is_ro {
            let cache_home = std::env::var("XDG_CACHE_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|_| {
                    std::env::var_os("HOME")
                        .map(|h| PathBuf::from(h).join(".cache"))
                        .unwrap_or_else(|| PathBuf::from("/tmp"))
                });
            let canonical_root = repo_root
                .canonicalize()
                .unwrap_or_else(|_| repo_root.to_path_buf());
            let repo_hash = format!(
                "{:016x}",
                twox_hash::XxHash64::oneshot(0, canonical_root.to_string_lossy().as_bytes())
            );
            let fallback_dir = cache_home.join("autodoc").join(repo_hash);
            let _ = std::fs::create_dir_all(&fallback_dir);
            warn!(
                "Target repository directory is read-only. Falling back to XDG cache: {:?}",
                fallback_dir
            );
            fallback_dir.join("cache.db")
        } else {
            default_dir.join("cache.db")
        };

        Self::open_db_path(db_path, false, None)
    }

    fn open_db_path(
        db_path: PathBuf,
        is_staging: bool,
        staging_scan_id: Option<String>,
    ) -> Result<Self, AutoDocError> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| AutoDocError::StorageError {
                detail: format!("Failed to create cache directory: {e}"),
            })?;
        }

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
        let manager = SqliteConnectionManager::file(&db_path).with_init(|c| {
            c.execute_batch(
                r#"
                    PRAGMA journal_mode = WAL;
                    PRAGMA synchronous = NORMAL;
                    PRAGMA busy_timeout = 5000;
                    PRAGMA mmap_size = 67108864;
                    PRAGMA foreign_keys = ON;
                    PRAGMA cache_size = -16000;
                    "#,
            )
        });

        let num_readers = (std::thread::available_parallelism()
            .map(|p| p.get())
            .unwrap_or(4)
            * 2)
        .clamp(2, 32);
        let reader_pool = Pool::builder()
            .max_size(num_readers as u32)
            .build(manager)
            .map_err(|e| AutoDocError::StorageError {
                detail: format!("Failed to build reader connection pool: {}", e),
            })?;

        // 2. Dedicated Writer Thread
        let (writer_sender, receiver) = channel::<StorageCommand>();
        let writer_db_path = db_path.clone();

        let writer_thread = thread::Builder::new()
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
                    PRAGMA foreign_keys = ON;
                    "#,
                );

                while let Ok(cmd) = receiver.recv() {
                    match cmd {
                        StorageCommand::InsertFile {
                            path,
                            mtime_ns,
                            size_bytes,
                            git_oid,
                            language,
                            responder,
                        } => {
                            let res = Self::write_file(
                                &mut conn, &path, mtime_ns, size_bytes, &git_oid, &language,
                            );
                            let _ = responder.send(res);
                        }
                        StorageCommand::InsertSymbol {
                            file_id,
                            fqsn,
                            name,
                            kind,
                            visibility,
                            line_start,
                            line_end,
                            complexity,
                            signature,
                            docstring,
                            responder,
                        } => {
                            let res = Self::write_symbol(
                                &mut conn,
                                file_id,
                                &fqsn,
                                &name,
                                &kind,
                                &visibility,
                                line_start,
                                line_end,
                                complexity,
                                &signature,
                                docstring.as_deref(),
                            );
                            let _ = responder.send(res);
                        }
                        StorageCommand::InsertEdge {
                            caller_id,
                            callee_id,
                            edge_kind,
                            weight,
                            responder,
                        } => {
                            let res = Self::write_edge(
                                &mut conn, caller_id, callee_id, &edge_kind, weight,
                            );
                            let _ = responder.send(res);
                        }
                        StorageCommand::InsertBatchAnalysis {
                            path,
                            mtime_ns,
                            size_bytes,
                            git_oid,
                            language,
                            symbols,
                            responder,
                        } => {
                            let res = Self::write_batch_analysis(
                                &mut conn, &path, mtime_ns, size_bytes, &git_oid, &language,
                                &symbols,
                            );
                            let _ = responder.send(res);
                        }
                        StorageCommand::BulkResolveEdges { edges, responder } => {
                            let res = Self::write_bulk_edges(&mut conn, &edges);
                            let _ = responder.send(res);
                        }
                        StorageCommand::ReconcileFiles {
                            current_paths,
                            responder,
                        } => {
                            let res = Self::write_reconcile_files(&mut conn, &current_paths);
                            let _ = responder.send(res);
                        }
                        StorageCommand::ReplaceInventory {
                            scan_id,
                            files,
                            clear_existing,
                            responder,
                        } => {
                            let res =
                                Self::write_inventory(&mut conn, &scan_id, &files, clear_existing);
                            let _ = responder.send(res);
                        }
                        StorageCommand::CheckpointPassive { responder } => {
                            let res = conn
                                .execute_batch("PRAGMA wal_checkpoint(PASSIVE);")
                                .map_err(|e| AutoDocError::StorageError {
                                    detail: e.to_string(),
                                });
                            let _ = responder.send(res);
                        }
                        StorageCommand::VacuumAndOptimize { responder } => {
                            let res = conn
                                .execute_batch(
                                    "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize; VACUUM;",
                                )
                                .map_err(|e| AutoDocError::StorageError {
                                    detail: e.to_string(),
                                });
                            let _ = responder.send(res);
                        }
                        StorageCommand::Shutdown => {
                            let _ = conn
                                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;");
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
            writer_thread: Some(writer_thread),
            is_staging,
            staging_scan_id,
        })
    }

    /// Creates an isolated database beside the active cache for a scan attempt.
    /// Scan identifiers are restricted because they become part of a local filename.
    pub fn new_staging(&self, scan_id: &str) -> Result<Self, AutoDocError> {
        if scan_id.is_empty()
            || !scan_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(AutoDocError::InvalidArgument {
                param: "scan_id".into(),
                reason: "must contain only ASCII letters, digits, hyphens, and underscores".into(),
            });
        }
        let staging_path = self
            .db_path
            .with_file_name(format!("cache.staging.{scan_id}.db"));
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging_path)
            .map_err(|error| AutoDocError::StorageError {
                detail: format!("Failed to reserve a unique staging database path: {error}"),
            })?;
        match Self::open_db_path(staging_path.clone(), true, Some(scan_id.to_string())) {
            Ok(storage) => Ok(storage),
            Err(error) => {
                for suffix in ["", "-wal", "-shm"] {
                    let path = PathBuf::from(format!("{}{suffix}", staging_path.display()));
                    let _ = std::fs::remove_file(path);
                }
                Err(error)
            }
        }
    }

    /// Marks an attempt as running and makes it the newest attempt without changing active data.
    pub fn begin_scan_attempt(&self, scan_id: &str) -> Result<(), AutoDocError> {
        let mut conn = Connection::open(&self.db_path).map_err(storage_error)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        tx.execute(
            "INSERT INTO scan_runs(scan_id,state,diagnostics_json,created_at) VALUES (?1,'running','[]',?2)",
            params![scan_id, now_millis()],
        )
        .map_err(storage_error)?;
        tx.execute(
            "UPDATE scan_state SET latest_attempt_id=?1 WHERE singleton=1",
            params![scan_id],
        )
        .map_err(storage_error)?;
        tx.execute(
            "INSERT INTO repository_state(repository_key,latest_attempt_id) VALUES ('default',?1) \
             ON CONFLICT(repository_key) DO UPDATE SET latest_attempt_id=excluded.latest_attempt_id",
            params![scan_id],
        )
        .map_err(storage_error)?;
        tx.commit().map_err(storage_error)
    }

    /// Records an unsuccessful attempt without changing either active or latest pointers.
    pub fn record_scan_attempt(
        &self,
        scan_id: &str,
        state: &str,
        diagnostics_json: &str,
    ) -> Result<(), AutoDocError> {
        if !matches!(state, "partial" | "failed") {
            return Err(AutoDocError::InvalidArgument {
                param: "state".into(),
                reason: "scan attempts must be partial or failed".into(),
            });
        }
        let mut conn = Connection::open(&self.db_path).map_err(storage_error)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let updated = tx.execute(
            "UPDATE scan_runs SET state=?2, diagnostics_json=?3 WHERE scan_id=?1 AND state='running'",
            params![scan_id, state, diagnostics_json],
        ).map_err(storage_error)?;
        if updated != 1 {
            return Err(AutoDocError::InvalidArgument {
                param: "scan_id".into(),
                reason: "only an existing running scan attempt can be finalized".into(),
            });
        }
        tx.commit().map_err(storage_error)
    }

    /// Publishes a staged scan as an immutable generation and atomically advances
    /// the active pointer only after its projections have been persisted.
    pub fn publish_snapshot_from(
        &self,
        staged: &StorageEngine,
        scan_id: &str,
        diagnostics_json: &str,
    ) -> Result<(), AutoDocError> {
        if self.db_path == staged.db_path {
            return Err(AutoDocError::InvalidArgument {
                param: "staged".into(),
                reason: "staging database must be distinct from the active database".into(),
            });
        }
        let mut conn = Connection::open(&self.db_path).map_err(storage_error)?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(storage_error)?;
        conn.execute(
            "ATTACH DATABASE ?1 AS staged",
            params![staged.db_path.to_string_lossy().as_ref()],
        )
        .map_err(storage_error)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;

        let latest_attempt: Option<String> = tx
            .query_row(
                "SELECT latest_attempt_id FROM scan_state WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        if latest_attempt.as_deref() != Some(scan_id) {
            return Err(AutoDocError::InvalidArgument {
                param: "scan_id".into(),
                reason: "stale scan attempt cannot publish after a newer attempt began".into(),
            });
        }
        let attempt_state: String = tx
            .query_row(
                "SELECT state FROM scan_runs WHERE scan_id=?1",
                [scan_id],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        if attempt_state != "running" {
            return Err(AutoDocError::InvalidArgument {
                param: "scan_id".into(),
                reason: "only a running scan attempt can be published".into(),
            });
        }

        tx.execute(
            "INSERT INTO generation_files(scan_id,file_id,path,content_sha256,category,support) \
             SELECT ?1, path, path, NULL, 'source', language FROM staged.files",
            [scan_id],
        )
        .map_err(storage_error)?;
        tx.execute(
            "INSERT INTO inventory_files(scan_id,path,category,support,content_sha256,excluded_reason,read_error) \
             SELECT ?1,path,category,support,content_sha256,excluded_reason,read_error \
             FROM staged.inventory_files WHERE scan_id=?1",
            [scan_id],
        ).map_err(storage_error)?;
        tx.execute(
            "INSERT INTO generation_symbols(scan_id,symbol_id,file_id,fqsn,name,kind,visibility,line_start,line_end,signature) \
             SELECT ?1, s.fqsn, f.path, s.fqsn, s.name, s.kind, s.visibility, s.line_start, s.line_end, s.signature_clean \
             FROM staged.symbols s JOIN staged.files f ON f.file_id=s.file_id",
            [scan_id],
        ).map_err(storage_error)?;
        tx.execute(
            "INSERT INTO generation_edges(scan_id,caller_id,callee_id,edge_kind,weight) \
             SELECT ?1, caller.fqsn, callee.fqsn, e.edge_kind, e.weight \
             FROM staged.edges e JOIN staged.symbols caller ON caller.symbol_id=e.caller_id \
             JOIN staged.symbols callee ON callee.symbol_id=e.callee_id",
            [scan_id],
        )
        .map_err(storage_error)?;
        let occurrences: Vec<(
            String,
            String,
            String,
            String,
            String,
            String,
            i32,
            i32,
            i32,
            i32,
            String,
            String,
        )> = {
            let mut stmt = tx.prepare(
                "SELECT occurrence_id,caller_fqsn,candidate_fqsns_json,edge_kind,resolution,callee_expression,line_start,line_end,column_start,column_end,content_sha256,method \
                 FROM staged.edge_occurrences ORDER BY occurrence_id",
            ).map_err(storage_error)?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                        row.get(9)?,
                        row.get(10)?,
                        row.get(11)?,
                    ))
                })
                .map_err(storage_error)?
                .collect::<Result<_, _>>()
                .map_err(storage_error)?;
            rows
        };
        for (
            occurrence_id,
            caller,
            candidates_json,
            kind,
            claimed_resolution,
            _expression,
            line_start,
            line_end,
            _column_start,
            _column_end,
            source_hash,
            method,
        ) in occurrences
        {
            let candidates: Vec<String> =
                serde_json::from_str(&candidates_json).unwrap_or_default();
            let caller_exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM generation_symbols WHERE scan_id=?1 AND symbol_id=?2)",
                params![scan_id, caller], |row| row.get(0),
            ).map_err(storage_error)?;
            if !caller_exists {
                continue;
            }
            let inventory_valid: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM inventory_files WHERE scan_id=?1 AND path=(SELECT path FROM generation_symbols WHERE scan_id=?1 AND symbol_id=?2) AND content_sha256=?3)",
                params![scan_id, caller, source_hash], |row| row.get(0),
            ).map_err(storage_error)?;
            let evidence_ids = if inventory_valid {
                let path: String = tx.query_row(
                    "SELECT path FROM generation_files WHERE scan_id=?1 AND file_id=(SELECT file_id FROM generation_symbols WHERE scan_id=?1 AND symbol_id=?2)",
                    params![scan_id, caller], |row| row.get(0),
                ).map_err(storage_error)?;
                tx.execute(
                    "INSERT OR IGNORE INTO evidence(scan_id,evidence_id,path,content_sha256,line_start,line_end,extractor,method) VALUES (?1,?2,?3,?4,?5,?6,'callsite',?7)",
                    params![scan_id, occurrence_id, path, source_hash, line_start, line_end, method],
                ).map_err(storage_error)?;
                vec![occurrence_id.clone()]
            } else {
                Vec::new()
            };
            let valid_candidates: Vec<String> = candidates.into_iter().filter(|id| {
                tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM generation_symbols WHERE scan_id=?1 AND symbol_id=?2)",
                    params![scan_id, id], |row| row.get::<_, bool>(0),
                ).unwrap_or(false)
            }).collect();
            let (resolution, to_id) = if !evidence_ids.is_empty()
                && claimed_resolution == "resolved"
                && valid_candidates.len() == 1
            {
                ("resolved", Some(valid_candidates[0].as_str()))
            } else if !evidence_ids.is_empty() && valid_candidates.len() > 1 {
                ("ambiguous", None)
            } else {
                ("unresolved", None)
            };
            let candidates_json = serde_json::to_string(&valid_candidates).map_err(|e| {
                AutoDocError::StorageError {
                    detail: e.to_string(),
                }
            })?;
            let evidence_json =
                serde_json::to_string(&evidence_ids).map_err(|e| AutoDocError::StorageError {
                    detail: e.to_string(),
                })?;
            tx.execute(
                "INSERT INTO relations(scan_id,relation_id,from_id,to_id,kind,resolution,candidate_ids_json,evidence_ids_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![scan_id, occurrence_id, caller, to_id, kind, resolution, candidates_json, evidence_json],
            ).map_err(storage_error)?;
        }
        tx.execute(
            "INSERT INTO generation_fts(scan_id,fqsn,name,docstring_clean) \
             SELECT ?1, fqsn, name, COALESCE(docstring_clean,'') FROM staged.symbols",
            [scan_id],
        )
        .map_err(storage_error)?;
        let now = now_millis();
        tx.execute(
            "INSERT INTO scan_runs(scan_id,state,diagnostics_json,created_at) VALUES (?1,'complete',?2,?3) \
             ON CONFLICT(scan_id) DO UPDATE SET state='complete', diagnostics_json=excluded.diagnostics_json",
            params![scan_id, diagnostics_json, now],
        )
        .map_err(storage_error)?;
        tx.execute(
            "UPDATE scan_state SET active_scan_id=?1, latest_attempt_id=?1 WHERE singleton=1",
            params![scan_id],
        )
        .map_err(storage_error)?;
        tx.execute(
            "INSERT INTO repository_state(repository_key,active_scan_id,latest_attempt_id) VALUES ('default',?1,?1) \
             ON CONFLICT(repository_key) DO UPDATE SET active_scan_id=excluded.active_scan_id, latest_attempt_id=excluded.latest_attempt_id",
            params![scan_id],
        )
        .map_err(storage_error)?;
        // Keep active plus the configured number of previous complete snapshots.
        // Expired rows are first marked superseded so immutability triggers permit
        // their cascade deletion; active rows are never eligible for expiry.
        let keep_previous = retained_prior_generations();
        let mut expired = tx
            .prepare(
                "SELECT scan_id FROM scan_runs WHERE state='complete' AND scan_id<>?1 \
             ORDER BY created_at DESC, scan_id DESC LIMIT -1 OFFSET ?2",
            )
            .map_err(storage_error)?;
        let expired_ids = expired
            .query_map(params![scan_id, keep_previous as i64], |row| {
                row.get::<_, String>(0)
            })
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        drop(expired);
        for expired_id in expired_ids {
            tx.execute(
                "UPDATE scan_runs SET state='superseded' WHERE scan_id=?1 AND state='complete'",
                [&expired_id],
            )
            .map_err(storage_error)?;
            tx.execute("DELETE FROM generation_fts WHERE scan_id=?1", [&expired_id])
                .map_err(storage_error)?;
            tx.execute(
                "DELETE FROM scan_runs WHERE scan_id=?1 AND scan_id<>?2",
                params![expired_id, scan_id],
            )
            .map_err(storage_error)?;
        }
        tx.commit().map_err(storage_error)?;
        conn.execute_batch("DETACH DATABASE staged")
            .map_err(storage_error)?;
        Ok(())
    }

    pub fn active_scan_id(&self) -> Result<Option<String>, AutoDocError> {
        let conn = self.reader()?;
        conn.query_row(
            "SELECT active_scan_id FROM scan_state WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)
    }

    pub fn latest_attempt_id(&self) -> Result<Option<String>, AutoDocError> {
        let conn = self.reader()?;
        conn.query_row(
            "SELECT latest_attempt_id FROM scan_state WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)
    }

    fn write_file(
        conn: &mut Connection,
        path: &str,
        mtime_ns: i64,
        size_bytes: i64,
        git_oid: &str,
        lang: &str,
    ) -> Result<i64, AutoDocError> {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| AutoDocError::StorageError {
                detail: e.to_string(),
            })?;

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        let file_id = tx
            .query_row(
                r#"
            INSERT INTO files (path, mtime_ns, size_bytes, git_oid, language, indexed_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(path) DO UPDATE SET
                mtime_ns = excluded.mtime_ns,
                size_bytes = excluded.size_bytes,
                git_oid = excluded.git_oid,
                language = excluded.language,
                indexed_at = excluded.indexed_at
            RETURNING file_id
            "#,
                params![path, mtime_ns, size_bytes, git_oid, lang, now],
                |row| row.get(0),
            )
            .map_err(|e| AutoDocError::StorageError {
                detail: e.to_string(),
            })?;

        tx.commit().map_err(|e| AutoDocError::StorageError {
            detail: e.to_string(),
        })?;
        Ok(file_id)
    }

    #[allow(clippy::too_many_arguments)]
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
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| AutoDocError::StorageError {
                detail: e.to_string(),
            })?;

        let symbol_id = tx.query_row(
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
                docstring_clean = excluded.docstring_clean
            RETURNING symbol_id
            "#,
            params![file_id, fqsn, name, kind, visibility, line_start, line_end, complexity, signature, docstring],
            |row| row.get(0),
        ).map_err(|e| AutoDocError::StorageError { detail: e.to_string() })?;

        // Index in FTS5
        tx.execute("DELETE FROM fts_symbols WHERE fqsn = ?1", params![fqsn])
            .map_err(|e| AutoDocError::StorageError {
                detail: e.to_string(),
            })?;
        tx.execute(
            "INSERT INTO fts_symbols (fqsn, name, docstring_clean) VALUES (?1, ?2, ?3);",
            params![fqsn, name, docstring.unwrap_or("")],
        )
        .map_err(|e| AutoDocError::StorageError {
            detail: e.to_string(),
        })?;

        tx.commit().map_err(|e| AutoDocError::StorageError {
            detail: e.to_string(),
        })?;
        Ok(symbol_id)
    }

    fn write_edge(
        conn: &mut Connection,
        caller_id: i64,
        callee_id: i64,
        edge_kind: &str,
        weight: f64,
    ) -> Result<(), AutoDocError> {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| AutoDocError::StorageError {
                detail: e.to_string(),
            })?;

        tx.execute(
            r#"
            INSERT INTO edges (caller_id, callee_id, edge_kind, weight)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(caller_id, callee_id, edge_kind) DO UPDATE SET
                weight = excluded.weight;
            "#,
            params![caller_id, callee_id, edge_kind, weight],
        )
        .map_err(|e| AutoDocError::StorageError {
            detail: e.to_string(),
        })?;

        tx.commit().map_err(|e| AutoDocError::StorageError {
            detail: e.to_string(),
        })?;
        Ok(())
    }

    fn write_batch_analysis(
        conn: &mut Connection,
        path: &str,
        mtime_ns: i64,
        size_bytes: i64,
        git_oid: &str,
        lang: &str,
        symbols: &[crate::parser::ExtractedSymbol],
    ) -> Result<(i64, usize), AutoDocError> {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| AutoDocError::StorageError {
                detail: e.to_string(),
            })?;

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        let file_id = tx
            .query_row(
                r#"
            INSERT INTO files (path, mtime_ns, size_bytes, git_oid, language, indexed_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(path) DO UPDATE SET
                mtime_ns = excluded.mtime_ns,
                size_bytes = excluded.size_bytes,
                git_oid = excluded.git_oid,
                language = excluded.language,
                indexed_at = excluded.indexed_at
            RETURNING file_id
            "#,
                params![path, mtime_ns, size_bytes, git_oid, lang, now],
                |row| row.get(0),
            )
            .map_err(|e| AutoDocError::StorageError {
                detail: e.to_string(),
            })?;

        tx.execute(
            "DELETE FROM fts_symbols WHERE fqsn IN (SELECT fqsn FROM symbols WHERE file_id = ?1)",
            params![file_id],
        )
        .map_err(|e| AutoDocError::StorageError {
            detail: e.to_string(),
        })?;
        tx.execute("DELETE FROM symbols WHERE file_id = ?1", params![file_id])
            .map_err(|e| AutoDocError::StorageError {
                detail: e.to_string(),
            })?;

        let mut inserted_symbols = 0;
        for sym in symbols {
            tx.query_row(
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
                    docstring_clean = excluded.docstring_clean
                RETURNING symbol_id
                "#,
                params![file_id, sym.fqsn, sym.name, sym.kind, sym.visibility, sym.line_start, sym.line_end, sym.complexity, sym.signature, sym.docstring.as_deref()],
                |row| row.get::<_, i64>(0),
            ).map_err(|e| AutoDocError::StorageError { detail: e.to_string() })?;

            tx.execute("DELETE FROM fts_symbols WHERE fqsn = ?1", params![sym.fqsn])
                .map_err(|e| AutoDocError::StorageError {
                    detail: e.to_string(),
                })?;
            tx.execute(
                "INSERT INTO fts_symbols (fqsn, name, docstring_clean) VALUES (?1, ?2, ?3);",
                params![sym.fqsn, sym.name, sym.docstring.as_deref().unwrap_or("")],
            )
            .map_err(|e| AutoDocError::StorageError {
                detail: e.to_string(),
            })?;
            inserted_symbols += 1;
        }

        tx.commit().map_err(|e| AutoDocError::StorageError {
            detail: e.to_string(),
        })?;
        Ok((file_id, inserted_symbols))
    }

    fn write_bulk_edges(
        conn: &mut Connection,
        edges: &[crate::parser::ExtractedEdge],
    ) -> Result<usize, AutoDocError> {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| AutoDocError::StorageError {
                detail: e.to_string(),
            })?;

        let mut inserted_edges = 0;
        {
            let mut stmt_find_caller = tx
                .prepare_cached("SELECT symbol_id, file_id FROM symbols WHERE fqsn = ?1 LIMIT 1")
                .map_err(|e| AutoDocError::StorageError {
                    detail: e.to_string(),
                })?;
            let mut stmt_find_callee = tx
                .prepare_cached(
                    "SELECT symbol_id FROM symbols WHERE name = ?1 AND file_id = ?2 ORDER BY fqsn",
                )
                .map_err(|e| AutoDocError::StorageError {
                    detail: e.to_string(),
                })?;
            let mut stmt_insert_edge = tx.prepare_cached(
                "INSERT INTO edges (caller_id, callee_id, edge_kind, weight) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(caller_id, callee_id, edge_kind) DO UPDATE SET weight = excluded.weight"
            ).map_err(|e| AutoDocError::StorageError { detail: e.to_string() })?;

            for edge in edges {
                let identity = format!(
                    "{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}",
                    edge.caller_fqsn,
                    edge.callee_expression,
                    edge.edge_kind,
                    edge.line_start,
                    edge.line_end,
                    edge.column_start,
                    edge.column_end,
                    edge.content_sha256,
                    edge.method
                );
                let occurrence_id = format!("{:x}", sha2::Sha256::digest(identity.as_bytes()));
                let candidates = serde_json::to_string(&edge.candidate_fqsns).map_err(|e| {
                    AutoDocError::StorageError {
                        detail: e.to_string(),
                    }
                })?;
                tx.execute(
                    "INSERT OR REPLACE INTO edge_occurrences(occurrence_id,caller_fqsn,candidate_fqsns_json,callee_name,callee_expression,edge_kind,resolution,line_start,line_end,column_start,column_end,content_sha256,method) \
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                    params![occurrence_id, edge.caller_fqsn, candidates, edge.callee_name, edge.callee_expression, edge.edge_kind, edge.resolution, edge.line_start, edge.line_end, edge.column_start, edge.column_end, edge.content_sha256, edge.method],
                ).map_err(storage_error)?;

                let caller: Option<(i64, i64)> = stmt_find_caller
                    .query_row(params![edge.caller_fqsn], |r| Ok((r.get(0)?, r.get(1)?)))
                    .ok();
                let callee_ids = if let Some((_, file_id)) = caller {
                    stmt_find_callee
                        .query_map(params![edge.callee_name, file_id], |r| r.get::<_, i64>(0))
                        .map_err(|e| AutoDocError::StorageError {
                            detail: e.to_string(),
                        })?
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|e| AutoDocError::StorageError {
                            detail: e.to_string(),
                        })?
                } else {
                    Vec::new()
                };

                // A bare name cannot identify one destination when several symbols share it.
                if let (Some((caller, _)), [callee]) = (caller, callee_ids.as_slice()) {
                    stmt_insert_edge
                        .execute(params![caller, callee, edge.edge_kind, edge.weight])
                        .map_err(|e| AutoDocError::StorageError {
                            detail: e.to_string(),
                        })?;
                    inserted_edges += 1;
                }
            }
        }

        tx.commit().map_err(|e| AutoDocError::StorageError {
            detail: e.to_string(),
        })?;
        Ok(inserted_edges)
    }

    fn write_reconcile_files(
        conn: &mut Connection,
        current_paths: &[String],
    ) -> Result<usize, AutoDocError> {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| AutoDocError::StorageError {
                detail: e.to_string(),
            })?;
        tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS current_scan_paths(path TEXT PRIMARY KEY); DELETE FROM current_scan_paths;")
            .map_err(|e| AutoDocError::StorageError { detail: e.to_string() })?;
        {
            let mut insert = tx
                .prepare_cached("INSERT INTO current_scan_paths(path) VALUES (?1)")
                .map_err(|e| AutoDocError::StorageError {
                    detail: e.to_string(),
                })?;
            for path in current_paths {
                insert
                    .execute(params![path])
                    .map_err(|e| AutoDocError::StorageError {
                        detail: e.to_string(),
                    })?;
            }
        }
        tx.execute("DELETE FROM fts_symbols WHERE fqsn IN (SELECT s.fqsn FROM symbols s JOIN files f ON f.file_id=s.file_id WHERE NOT EXISTS (SELECT 1 FROM current_scan_paths p WHERE p.path=f.path))", [])
            .map_err(|e| AutoDocError::StorageError { detail: e.to_string() })?;
        let removed = tx.execute("DELETE FROM files WHERE NOT EXISTS (SELECT 1 FROM current_scan_paths p WHERE p.path=files.path)", [])
            .map_err(|e| AutoDocError::StorageError { detail: e.to_string() })?;
        tx.execute_batch("DROP TABLE current_scan_paths;")
            .map_err(|e| AutoDocError::StorageError {
                detail: e.to_string(),
            })?;
        tx.commit().map_err(|e| AutoDocError::StorageError {
            detail: e.to_string(),
        })?;
        Ok(removed)
    }

    fn write_inventory(
        conn: &mut Connection,
        scan_id: &str,
        files: &[crate::inventory::InventoryFile],
        clear_existing: bool,
    ) -> Result<(), AutoDocError> {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        tx.execute(
            "INSERT OR IGNORE INTO scan_runs(scan_id,state,diagnostics_json,created_at) VALUES (?1,'running','[]',?2)",
            params![scan_id, now_millis()],
        )
        .map_err(storage_error)?;
        let state: String = tx
            .query_row(
                "SELECT state FROM scan_runs WHERE scan_id=?1",
                [scan_id],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        if state != "running" {
            return Err(AutoDocError::InvalidArgument {
                param: "scan_id".into(),
                reason: "inventory can only be replaced in a running staged scan".into(),
            });
        }
        if clear_existing {
            tx.execute("DELETE FROM inventory_files WHERE scan_id=?1", [scan_id])
                .map_err(storage_error)?;
        }
        {
            let mut insert = tx.prepare_cached(
                "INSERT INTO inventory_files(scan_id,path,category,support,content_sha256,excluded_reason,read_error) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7)",
            ).map_err(storage_error)?;
            for file in files {
                let category = match file.category {
                    crate::inventory::InventoryCategory::Source => "source",
                    crate::inventory::InventoryCategory::Markup => "markup",
                    crate::inventory::InventoryCategory::Style => "style",
                    crate::inventory::InventoryCategory::Manifest => "manifest",
                    crate::inventory::InventoryCategory::Infra => "infra",
                    crate::inventory::InventoryCategory::Docs => "docs",
                    crate::inventory::InventoryCategory::Asset => "asset",
                    crate::inventory::InventoryCategory::Other => "other",
                };
                let support = match file.support {
                    crate::inventory::InventorySupport::Ast => "ast",
                    crate::inventory::InventorySupport::Heuristic => "heuristic",
                    crate::inventory::InventorySupport::Metadata => "metadata",
                    crate::inventory::InventorySupport::Unsupported => "unsupported",
                };
                insert
                    .execute(params![
                        scan_id,
                        file.path,
                        category,
                        support,
                        file.content_sha256,
                        file.excluded_reason,
                        file.read_error,
                    ])
                    .map_err(storage_error)?;
            }
        }
        tx.commit().map_err(storage_error)
    }

    pub fn insert_file(
        &self,
        path: &str,
        mtime_ns: i64,
        size_bytes: i64,
        git_oid: &str,
        lang: &str,
    ) -> Result<i64, AutoDocError> {
        let (tx, rx) = channel();
        self.writer_sender
            .send(StorageCommand::InsertFile {
                path: path.to_string(),
                mtime_ns,
                size_bytes,
                git_oid: git_oid.to_string(),
                language: lang.to_string(),
                responder: tx,
            })
            .map_err(|e| AutoDocError::Internal(e.to_string()))?;

        rx.recv()
            .map_err(|e| AutoDocError::Internal(e.to_string()))?
    }

    #[allow(clippy::too_many_arguments)]
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
        self.writer_sender
            .send(StorageCommand::InsertSymbol {
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
            })
            .map_err(|e| AutoDocError::Internal(e.to_string()))?;

        rx.recv()
            .map_err(|e| AutoDocError::Internal(e.to_string()))?
    }

    pub fn insert_edge(
        &self,
        caller_id: i64,
        callee_id: i64,
        edge_kind: &str,
        weight: f64,
    ) -> Result<(), AutoDocError> {
        let (tx, rx) = channel();
        self.writer_sender
            .send(StorageCommand::InsertEdge {
                caller_id,
                callee_id,
                edge_kind: edge_kind.to_string(),
                weight,
                responder: tx,
            })
            .map_err(|e| AutoDocError::Internal(e.to_string()))?;

        rx.recv()
            .map_err(|e| AutoDocError::Internal(e.to_string()))?
    }

    pub fn insert_batch_analysis(
        &self,
        path: &str,
        mtime_ns: i64,
        size_bytes: i64,
        git_oid: &str,
        lang: &str,
        symbols: Vec<crate::parser::ExtractedSymbol>,
    ) -> Result<(i64, usize), AutoDocError> {
        let (tx, rx) = channel();
        self.writer_sender
            .send(StorageCommand::InsertBatchAnalysis {
                path: path.to_string(),
                mtime_ns,
                size_bytes,
                git_oid: git_oid.to_string(),
                language: lang.to_string(),
                symbols,
                responder: tx,
            })
            .map_err(|e| AutoDocError::Internal(e.to_string()))?;

        rx.recv()
            .map_err(|e| AutoDocError::Internal(e.to_string()))?
    }

    pub fn bulk_resolve_edges(
        &self,
        edges: Vec<crate::parser::ExtractedEdge>,
    ) -> Result<usize, AutoDocError> {
        let (tx, rx) = channel();
        self.writer_sender
            .send(StorageCommand::BulkResolveEdges {
                edges,
                responder: tx,
            })
            .map_err(|e| AutoDocError::Internal(e.to_string()))?;

        rx.recv()
            .map_err(|e| AutoDocError::Internal(e.to_string()))?
    }

    pub fn reconcile_files(&self, current_paths: Vec<String>) -> Result<usize, AutoDocError> {
        let (tx, rx) = channel();
        self.writer_sender
            .send(StorageCommand::ReconcileFiles {
                current_paths,
                responder: tx,
            })
            .map_err(|e| AutoDocError::Internal(e.to_string()))?;
        rx.recv()
            .map_err(|e| AutoDocError::Internal(e.to_string()))?
    }

    /// Replaces the scan-qualified inventory in a per-scan staging database.
    pub fn replace_inventory(
        &self,
        scan_id: &str,
        files: &[crate::inventory::InventoryFile],
    ) -> Result<(), AutoDocError> {
        self.replace_inventory_with_batch_size(
            scan_id,
            files,
            crate::scanner::ScanOptions::default().batch_size,
        )
    }

    pub fn replace_inventory_with_batch_size(
        &self,
        scan_id: &str,
        files: &[crate::inventory::InventoryFile],
        batch_size: usize,
    ) -> Result<(), AutoDocError> {
        if !self.is_staging {
            return Err(AutoDocError::InvalidArgument {
                param: "storage".into(),
                reason: "inventory must be written to a scan staging database".into(),
            });
        }
        if self.staging_scan_id.as_deref() != Some(scan_id) {
            return Err(AutoDocError::InvalidArgument {
                param: "scan_id".into(),
                reason: "inventory scan_id must match the staging database scan_id".into(),
            });
        }
        for (index, batch) in files.chunks(batch_size.max(1)).enumerate() {
            let (tx, rx) = channel();
            self.writer_sender
                .send(StorageCommand::ReplaceInventory {
                    scan_id: scan_id.to_string(),
                    files: batch.to_vec(),
                    clear_existing: index == 0,
                    responder: tx,
                })
                .map_err(|e| AutoDocError::Internal(e.to_string()))?;
            rx.recv()
                .map_err(|e| AutoDocError::Internal(e.to_string()))??;
        }
        if files.is_empty() {
            let (tx, rx) = channel();
            self.writer_sender
                .send(StorageCommand::ReplaceInventory {
                    scan_id: scan_id.to_string(),
                    files: Vec::new(),
                    clear_existing: true,
                    responder: tx,
                })
                .map_err(|e| AutoDocError::Internal(e.to_string()))?;
            rx.recv()
                .map_err(|e| AutoDocError::Internal(e.to_string()))??;
        }
        Ok(())
    }

    pub fn reader(&self) -> Result<r2d2::PooledConnection<SqliteConnectionManager>, AutoDocError> {
        self.reader_pool
            .get()
            .map_err(|e| AutoDocError::StorageError {
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
        if let Some(writer_thread) = self.writer_thread.take() {
            let _ = writer_thread.join();
        }
        if self.is_staging {
            for suffix in ["", "-wal", "-shm"] {
                let path = PathBuf::from(format!("{}{suffix}", self.db_path.display()));
                let _ = std::fs::remove_file(path);
            }
        }
    }
}
