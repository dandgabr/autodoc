use napi_derive::napi;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tracing::{error, info};

pub mod cache;
pub mod errors;
pub mod graph;
pub mod inventory;
pub mod parser;
pub mod sanitizer;
pub mod scanner;
pub mod telemetry;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

static EXPORT_LOCKS: OnceLock<Mutex<ExportLockRegistry>> = OnceLock::new();

#[derive(Default)]
struct ExportLockRegistry {
    active: HashMap<String, Connection>,
    released: HashSet<String>,
    next_token: u64,
}

/// Acquires a process-safe export lock by holding SQLite's RESERVED write lock.
/// SQLite releases it automatically if the process exits unexpectedly.
#[napi]
pub fn acquire_export_lock_native(path: String) -> napi::Result<String> {
    let destination = std::path::Path::new(&path);
    let identity = std::fs::metadata(destination).map_err(|error| {
        napi::Error::from_reason(format!("export destination identity failed: {error}"))
    })?;
    if !identity.is_dir() {
        return Err(napi::Error::from_reason(
            "export lock requires a destination directory",
        ));
    }
    #[cfg(unix)]
    let lock_name = {
        use std::os::unix::fs::MetadataExt;
        format!("{:x}-{:x}.sqlite", identity.dev(), identity.ino())
    };
    #[cfg(not(unix))]
    let lock_name = {
        let canonical = destination
            .canonicalize()
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        format!(
            "{:016x}.sqlite",
            twox_hash::XxHash64::oneshot(0, canonical.to_string_lossy().as_bytes())
        )
    };
    let lock_dir = export_lock_directory()?;
    let lock_path = lock_dir.join(lock_name);
    let connection = Connection::open_with_flags(
        &lock_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|error| napi::Error::from_reason(format!("export lock open failed: {error}")))?;
    connection
        .busy_timeout(Duration::from_millis(100))
        .map_err(|error| {
            napi::Error::from_reason(format!("export lock timeout setup failed: {error}"))
        })?;
    let integrity: String = connection
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(|error| napi::Error::from_reason(format!("export lock integrity check failed: {error}")))?;
    if integrity != "ok" {
        return Err(napi::Error::from_reason(format!(
            "export lock database is corrupt: {integrity}"
        )));
    }
    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| {
            napi::Error::from_reason(format!("export destination is locked: {error}"))
        })?;

    let registry = EXPORT_LOCKS.get_or_init(|| Mutex::new(ExportLockRegistry::default()));
    let mut registry = registry
        .lock()
        .map_err(|_| napi::Error::from_reason("export lock registry poisoned"))?;
    registry.next_token = registry.next_token.wrapping_add(1);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let token = format!("{}-{timestamp}-{}", std::process::id(), registry.next_token);
    registry.released.remove(&token);
    registry.active.insert(token.clone(), connection);
    Ok(token)
}

fn export_lock_directory() -> napi::Result<std::path::PathBuf> {
    let base = std::env::var_os("XDG_STATE_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".local/state"))
        })
        .ok_or_else(|| {
            napi::Error::from_reason("export lock store has no XDG_STATE_HOME or HOME")
        })?;
    let target = base.join("autodoc").join("export-locks");
    let mut current = std::path::PathBuf::new();
    for component in target.components() {
        current.push(component.as_os_str());
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(napi::Error::from_reason(
                        "export lock store contains a symlink or non-directory",
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&current).map_err(|e| {
                    napi::Error::from_reason(format!("export lock store creation failed: {e}"))
                })?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&current, std::fs::Permissions::from_mode(0o700))
                        .map_err(|e| {
                            napi::Error::from_reason(format!(
                                "export lock store permissions failed: {e}"
                            ))
                        })?;
                }
            }
            Err(error) => {
                return Err(napi::Error::from_reason(format!(
                    "export lock store inspection failed: {error}"
                )))
            }
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let metadata =
            std::fs::metadata(&target).map_err(|e| napi::Error::from_reason(e.to_string()))?;
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err(napi::Error::from_reason(
                "export lock store is not owned by the current user",
            ));
        }
        if metadata.permissions().mode() & 0o077 != 0 {
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o700)).map_err(
                |e| napi::Error::from_reason(format!("export lock store permissions failed: {e}")),
            )?;
        }
    }
    Ok(target)
}

/// Releases a known export lock. Releasing the same token twice is harmless.
#[napi]
pub fn release_export_lock_native(token: String) -> napi::Result<()> {
    let registry = EXPORT_LOCKS.get_or_init(|| Mutex::new(ExportLockRegistry::default()));
    let mut registry = registry
        .lock()
        .map_err(|_| napi::Error::from_reason("export lock registry poisoned"))?;
    if let Some(connection) = registry.active.remove(&token) {
        connection.execute_batch("ROLLBACK").map_err(|error| {
            napi::Error::from_reason(format!("export lock release failed: {error}"))
        })?;
        registry.released.insert(token);
        return Ok(());
    }
    if registry.released.contains(&token) {
        return Ok(());
    }
    Err(napi::Error::from_reason("unknown export lock token"))
}

const SNAPSHOT_SCHEMA_VERSION: i64 = 5;
const SNAPSHOT_CONTRACT_VERSION: i64 = 2;
const MAX_SNAPSHOT_PAGE_ITEMS: usize = 500;
const MAX_SNAPSHOT_PAGE_BYTES: usize = 1024 * 1024;

fn contract_category(value: &str) -> &'static str {
    match value {
        "source" => "source",
        "markup" => "markup",
        "style" => "style",
        "manifest" => "manifest",
        "infra" => "infra",
        "docs" => "docs",
        "asset" => "asset",
        _ => "other",
    }
}

fn contract_support(value: &str) -> &'static str {
    match value {
        "ast" => "ast",
        "heuristic" => "heuristic",
        "metadata" => "metadata",
        "unsupported" => "unsupported",
        "typescript" | "javascript" | "ts" | "js" | "python" | "rust" | "go" | "java" | "c" => {
            "ast"
        }
        _ => "unsupported",
    }
}

#[derive(Serialize, Deserialize)]
struct SnapshotCursor {
    version: u8,
    root: String,
    scan_id: String,
    collection: String,
    filter: String,
    offset: usize,
}

fn canonical_repository_root(repo_path: &str) -> napi::Result<std::path::PathBuf> {
    std::fs::canonicalize(repo_path).map_err(|error| {
        napi::Error::from_reason(format!(
            "NOT_SCANNED: repository root is unavailable: {error}"
        ))
    })
}

fn snapshot_cache_candidates(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut candidates = vec![root.join(".autodoc").join("cache.db")];
    let root_key = format!(
        "{:016x}",
        twox_hash::XxHash64::oneshot(0, root.to_string_lossy().as_bytes())
    );
    for variable in ["XDG_CACHE_HOME", "XDG_STATE_HOME"] {
        if let Some(home) = std::env::var_os(variable) {
            candidates.push(
                std::path::PathBuf::from(home)
                    .join("autodoc")
                    .join(&root_key)
                    .join("cache.db"),
            );
        } else if variable == "XDG_CACHE_HOME" {
            if let Some(home) = std::env::var_os("HOME") {
                candidates.push(
                    std::path::PathBuf::from(home)
                        .join(".cache/autodoc")
                        .join(&root_key)
                        .join("cache.db"),
                );
            }
        }
    }
    candidates
}

fn open_snapshot_cache(root: &std::path::Path) -> napi::Result<Connection> {
    use rusqlite::OpenFlags;
    let mut selected: Option<(i64, Connection)> = None;
    let mut saw_cache = false;
    let mut last_error = None;
    for path in snapshot_cache_candidates(root) {
        if !path.is_file() {
            continue;
        }
        saw_cache = true;
        let connection = match Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ) {
            Ok(connection) => connection,
            Err(error) => {
                last_error = Some(error.to_string());
                continue;
            }
        };
        let active_created_at = connection.query_row(
            "SELECT r.created_at FROM repository_state s JOIN scan_runs r ON r.scan_id=s.active_scan_id WHERE s.repository_key='default' AND r.state='complete'",
            [], |row| row.get::<_, i64>(0),
        );
        match active_created_at {
            Ok(created_at) => {
                if selected
                    .as_ref()
                    .map_or(true, |(best, _)| created_at > *best)
                {
                    selected = Some((created_at, connection));
                }
            }
            Err(error) => last_error = Some(error.to_string()),
        }
    }
    if let Some((_, connection)) = selected {
        return Ok(connection);
    }
    if saw_cache {
        return Err(napi::Error::from_reason(format!(
            "FAILED: no usable AutoDoc snapshot cache exists: {}",
            last_error.unwrap_or_else(|| "no active snapshot".into())
        )));
    }
    Err(napi::Error::from_reason(
        "NOT_SCANNED: no AutoDoc cache exists for this repository",
    ))
}

fn iso8601_millis(timestamp_ms: i64) -> String {
    let seconds = timestamp_ms.div_euclid(1000);
    let millis = timestamp_ms.rem_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += if month <= 2 { 1 } else { 0 };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        day_seconds / 3600,
        (day_seconds % 3600) / 60,
        day_seconds % 60
    )
}

fn count_for_scan(conn: &Connection, table: &str, scan_id: &str) -> rusqlite::Result<i64> {
    let sql = format!("SELECT COUNT(*) FROM {table} WHERE scan_id=?1");
    conn.query_row(&sql, [scan_id], |row| row.get(0))
}

/// Reads metadata from an existing cache without opening the scanner or creating files.
#[napi]
pub fn read_repository_snapshot_native(
    repo_path: String,
    requested_scan_id: Option<String>,
) -> napi::Result<String> {
    let root = canonical_repository_root(&repo_path)?;
    let mut conn = open_snapshot_cache(&root)?;
    let tx = conn.transaction().map_err(|error| {
        napi::Error::from_reason(format!("FAILED: snapshot read transaction failed: {error}"))
    })?;
    let version: i64 = tx
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| {
            napi::Error::from_reason(format!(
                "FAILED: unable to inspect snapshot schema: {error}"
            ))
        })?;
    if version != SNAPSHOT_SCHEMA_VERSION {
        return Err(napi::Error::from_reason(format!(
            "FAILED: unsupported snapshot schema version {version}"
        )));
    }
    let (active, latest): (Option<String>, Option<String>) = tx.query_row(
        "SELECT active_scan_id, latest_attempt_id FROM repository_state WHERE repository_key='default'", [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(|error| napi::Error::from_reason(format!("NOT_SCANNED: no published snapshot: {error}")))?;
    let scan_id = requested_scan_id.or(active).ok_or_else(|| {
        napi::Error::from_reason("NOT_SCANNED: repository has no active verified snapshot")
    })?;
    let (created_at, run_state, diagnostics): (i64, String, String) = tx
        .query_row(
            "SELECT created_at,state,diagnostics_json FROM scan_runs WHERE scan_id=?1",
            [&scan_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| {
            napi::Error::from_reason(format!(
                "SNAPSHOT_UNAVAILABLE: active snapshot metadata is missing: {error}"
            ))
        })?;
    if run_state != "complete" {
        return Err(napi::Error::from_reason(
            "SNAPSHOT_UNAVAILABLE: active snapshot is not complete",
        ));
    }
    let latest_attempt = latest.map(|id| {
        let state = tx
            .query_row(
                "SELECT state FROM scan_runs WHERE scan_id=?1",
                [&id],
                |row| row.get::<_, String>(0),
            )
            .unwrap_or_else(|_| "failed".into());
        serde_json::json!({ "scanId": id, "state": state })
    });
    let raw_diagnostics: serde_json::Value =
        serde_json::from_str(&diagnostics).unwrap_or(serde_json::json!([]));
    let diagnostics_json = raw_diagnostics
        .as_array()
        .map(|items| {
            items.iter().map(|item| serde_json::json!({
        "code": item.get("code").and_then(serde_json::Value::as_str).unwrap_or("SCAN_DIAGNOSTIC"),
        "path": item.get("path").cloned().unwrap_or(serde_json::Value::Null),
    })).collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let coverage_state = if !diagnostics_json.is_empty() {
        "partial"
    } else {
        "complete"
    };
    let files = count_for_scan(&tx, "inventory_files", &scan_id).unwrap_or(0);
    let fact_count = count_for_scan(&tx, "facts", &scan_id).unwrap_or(0);
    let evidence_count = count_for_scan(&tx, "evidence", &scan_id).unwrap_or(0);
    let relation_count = count_for_scan(&tx, "relations", &scan_id).unwrap_or(0);
    let metadata = serde_json::json!({
        "contractVersion": SNAPSHOT_CONTRACT_VERSION,
        "schemaVersion": SNAPSHOT_SCHEMA_VERSION,
        "scanId": scan_id,
        "repositoryRoot": root.to_string_lossy(),
        "createdAt": iso8601_millis(created_at),
        "extractorVersions": { "autodoc-core": env!("CARGO_PKG_VERSION") },
        "coverage": {
            "overall": { "state": coverage_state, "examined": files, "excluded": 0, "diagnostics": diagnostics_json },
            "facts": { "state": "unsupported", "examined": fact_count, "excluded": 0, "diagnostics": [{"code":"FACT_EXTRACTION_UNAVAILABLE"}] },
            "schema": { "state": "unsupported", "examined": 0, "excluded": 0, "diagnostics": [{"code":"SCHEMA_FACT_EXTRACTION_UNAVAILABLE"}] },
            "evidence": { "state": "partial", "examined": evidence_count, "excluded": 0, "diagnostics": [{"code":"CALLSITE_EVIDENCE_ONLY"}] },
            "relations": { "state": "partial", "examined": relation_count, "excluded": 0, "diagnostics": [{"code":"CALL_RELATIONS_ONLY"}] }
        },
        "latestAttempt": latest_attempt,
        "freshness": "verified",
        "totals": {
            "facts": fact_count,
            "evidence": evidence_count,
            "relations": relation_count,
            "files": files
        }
    });
    let serialized = serde_json::to_string(&metadata).map_err(|error| {
        napi::Error::from_reason(format!("FAILED: metadata serialization failed: {error}"))
    })?;
    tx.commit().map_err(|error| {
        napi::Error::from_reason(format!("FAILED: snapshot read commit failed: {error}"))
    })?;
    Ok(serialized)
}

/// Reads one deterministic, byte-bounded page from the requested immutable generation.
#[napi]
pub fn read_snapshot_page_native(
    repo_path: String,
    scan_id: String,
    collection: String,
    cursor: Option<String>,
    limit: u32,
) -> napi::Result<String> {
    let root = canonical_repository_root(&repo_path)?;
    let mut conn = open_snapshot_cache(&root)?;
    let tx = conn.transaction().map_err(|error| {
        napi::Error::from_reason(format!("FAILED: snapshot read transaction failed: {error}"))
    })?;
    let state: Option<String> = tx
        .query_row(
            "SELECT state FROM scan_runs WHERE scan_id=?1",
            [&scan_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| {
            napi::Error::from_reason(format!("FAILED: snapshot lookup failed: {error}"))
        })?;
    match state.as_deref() {
        Some("complete") => (),
        Some(_) => {
            return Err(napi::Error::from_reason(
                "SNAPSHOT_UNAVAILABLE: requested scan is not a complete generation",
            ))
        }
        None => {
            return Err(napi::Error::from_reason(
                "SNAPSHOT_UNAVAILABLE: requested scan generation is expired or unknown",
            ))
        }
    }
    if limit == 0 || limit as usize > MAX_SNAPSHOT_PAGE_ITEMS {
        return Err(napi::Error::from_reason(format!(
            "INVALID_LIMIT: limit must be between 1 and {MAX_SNAPSHOT_PAGE_ITEMS}"
        )));
    }
    if !["files", "facts", "evidence", "relations"].contains(&collection.as_str()) {
        return Err(napi::Error::from_reason(
            "INVALID_COLLECTION: unsupported snapshot collection",
        ));
    }
    let mut offset = 0usize;
    if let Some(encoded) = cursor {
        if encoded.len() % 2 != 0 {
            return Err(napi::Error::from_reason("INVALID_CURSOR: malformed cursor"));
        }
        let bytes = (0..encoded.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&encoded[i..i + 2], 16))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| napi::Error::from_reason("INVALID_CURSOR: malformed cursor"))?;
        let decoded: SnapshotCursor = serde_json::from_slice(&bytes)
            .map_err(|_| napi::Error::from_reason("INVALID_CURSOR: malformed cursor"))?;
        if decoded.version != 1
            || decoded.root != root.to_string_lossy()
            || decoded.scan_id != scan_id
            || decoded.collection != collection
            || !decoded.filter.is_empty()
        {
            return Err(napi::Error::from_reason("INVALID_CURSOR: cursor does not match repository, generation, collection, or filter"));
        }
        offset = decoded.offset;
    }
    let table = match collection.as_str() {
        "files" => "inventory_files",
        "facts" => "facts",
        "evidence" => "evidence",
        _ => "relations",
    };
    let total = count_for_scan(&tx, table, &scan_id)
        .map_err(|error| napi::Error::from_reason(format!("FAILED: page count failed: {error}")))?;
    if offset > total as usize {
        return Err(napi::Error::from_reason(
            "INVALID_CURSOR: cursor position is beyond the end of this collection",
        ));
    }
    let sql = match collection.as_str() {
        "files" => "SELECT path,category,support,content_sha256,excluded_reason,read_error FROM inventory_files WHERE scan_id=?1 ORDER BY path LIMIT ?2 OFFSET ?3",
        "facts" => "SELECT fact_id,kind,attributes_json,evidence_ids_json FROM facts WHERE scan_id=?1 ORDER BY fact_id LIMIT ?2 OFFSET ?3",
        "evidence" => "SELECT evidence_id,path,content_sha256,line_start,line_end,extractor,method FROM evidence WHERE scan_id=?1 ORDER BY evidence_id LIMIT ?2 OFFSET ?3",
        _ => "SELECT relation_id,from_id,to_id,kind,resolution,candidate_ids_json,evidence_ids_json FROM relations WHERE scan_id=?1 ORDER BY relation_id LIMIT ?2 OFFSET ?3",
    };
    let mut statement = tx
        .prepare(sql)
        .map_err(|error| napi::Error::from_reason(format!("FAILED: page query failed: {error}")))?;
    let rows = statement.query_map(rusqlite::params![scan_id, limit, offset as i64], |row| {
        let item = match collection.as_str() {
            "files" => {
                let category: String = row.get(1)?;
                let support: String = row.get(2)?;
                serde_json::json!({"path":row.get::<_,String>(0)?,"category":contract_category(&category),"support":contract_support(&support),"contentSha256":row.get::<_,Option<String>>(3)?,"excludedReason":row.get::<_,Option<String>>(4)?,"readError":row.get::<_,Option<String>>(5)?})
            },
            "facts" => serde_json::json!({"id":row.get::<_,String>(0)?,"kind":row.get::<_,String>(1)?,"attributes":serde_json::from_str::<serde_json::Value>(&row.get::<_,String>(2)?).unwrap_or(serde_json::json!({})),"evidenceIds":serde_json::from_str::<serde_json::Value>(&row.get::<_,String>(3)?).unwrap_or(serde_json::json!([]))}),
            "evidence" => serde_json::json!({"id":row.get::<_,String>(0)?,"path":row.get::<_,String>(1)?,"contentSha256":row.get::<_,Option<String>>(2)?,"lineStart":row.get::<_,Option<i64>>(3)?,"lineEnd":row.get::<_,Option<i64>>(4)?,"extractor":row.get::<_,String>(5)?,"method":row.get::<_,String>(6)?}),
            _ => serde_json::json!({"id":row.get::<_,String>(0)?,"fromId":row.get::<_,String>(1)?,"toId":row.get::<_,Option<String>>(2)?,"kind":row.get::<_,String>(3)?,"resolution":row.get::<_,String>(4)?,"candidateIds":serde_json::from_str::<serde_json::Value>(&row.get::<_,String>(5)?).unwrap_or(serde_json::json!([])),"evidenceIds":serde_json::from_str::<serde_json::Value>(&row.get::<_,String>(6)?).unwrap_or(serde_json::json!([]))}),
        };
        Ok(item)
    }).map_err(|error| napi::Error::from_reason(format!("FAILED: page query failed: {error}")))?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|error| {
            napi::Error::from_reason(format!("FAILED: page row failed: {error}"))
        })?);
    }
    drop(statement);
    let make_cursor = |next: usize| -> napi::Result<String> {
        let bytes = serde_json::to_vec(&SnapshotCursor {
            version: 1,
            root: root.to_string_lossy().into_owned(),
            scan_id: scan_id.clone(),
            collection: collection.clone(),
            filter: String::new(),
            offset: next,
        })
        .map_err(|error| {
            napi::Error::from_reason(format!("FAILED: cursor serialization failed: {error}"))
        })?;
        Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
    };
    let mut next_offset = offset + items.len();
    let mut page = serde_json::json!({"contractVersion":SNAPSHOT_CONTRACT_VERSION,"schemaVersion":SNAPSHOT_SCHEMA_VERSION,"scanId":scan_id,"repositoryRoot":root.to_string_lossy(),"collection":collection,"items":items,"total":total,"nextCursor":if next_offset < total as usize { Some(make_cursor(next_offset)?) } else { None },"coverage":{"state":"complete","examined":total,"excluded":0,"diagnostics":[]}});
    while serde_json::to_vec(&page)
        .map(|bytes| bytes.len())
        .unwrap_or(MAX_SNAPSHOT_PAGE_BYTES + 1)
        > MAX_SNAPSHOT_PAGE_BYTES
    {
        let items = page["items"]
            .as_array_mut()
            .expect("page items are an array");
        if items.len() <= 1 {
            let item_id = items
                .first()
                .and_then(|item| item.get("id").or_else(|| item.get("path")))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown");
            let item_bytes = items
                .first()
                .map(|item| {
                    serde_json::to_vec(item)
                        .map(|bytes| bytes.len())
                        .unwrap_or(0)
                })
                .unwrap_or(0);
            return Err(napi::Error::from_reason(format!(
                "ITEM_TOO_LARGE: collection={collection} id={item_id} bytes={item_bytes}"
            )));
        }
        items.pop();
        next_offset -= 1;
        page["nextCursor"] = if next_offset < total as usize {
            serde_json::json!(make_cursor(next_offset)?)
        } else {
            serde_json::Value::Null
        };
    }
    let serialized = serde_json::to_string(&page).map_err(|error| {
        napi::Error::from_reason(format!("FAILED: page serialization failed: {error}"))
    })?;
    tx.commit().map_err(|error| {
        napi::Error::from_reason(format!("FAILED: snapshot read commit failed: {error}"))
    })?;
    Ok(serialized)
}

#[napi(object)]
#[derive(Debug, Serialize, Deserialize)]
pub struct PingResponse {
    pub trace_id: String,
    pub status: String,
    pub version: String,
    pub rustc_version: String,
    pub timestamp_ms: i64,
}

#[napi(object)]
#[derive(Debug, Serialize, Deserialize)]
pub struct SanitizeResult {
    pub sanitized_text: String,
    pub redaction_count: u32,
}

/// Initializes diagnostic tracing subscribers (stderr only).
#[napi]
pub fn init_logger() {
    telemetry::init_telemetry();
    info!("AutoDoc native telemetry initialized (logging strictly directed to stderr)");
}

/// Ping FFI Bridge sanity check passing Trace ID and ensuring memory boundary safety.
#[napi]
pub fn ping(trace_id: String) -> napi::Result<PingResponse> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        PingResponse {
            trace_id,
            status: "OK".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            rustc_version: "1.98.0".to_string(),
            timestamp_ms: now,
        }
    }));

    match result {
        Ok(res) => Ok(res),
        Err(payload) => {
            let panic_msg = if let Some(s) = payload.downcast_ref::<&str>() {
                s.to_string()
            } else if let Some(s) = payload.downcast_ref::<String>() {
                s.clone()
            } else {
                "Unknown panic payload".to_string()
            };
            error!("Panic caught in ping FFI boundary: {}", panic_msg);
            Err(errors::AutoDocError::FfiPanic { reason: panic_msg }.into())
        }
    }
}

/// Native sanitization API combining Secret and PII redaction.
#[napi]
pub fn sanitize_content(content: String) -> napi::Result<SanitizeResult> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let engine = sanitizer::SanitizerEngine::new();
        let sanitized = engine.sanitize(&content);
        let redactions = sanitized.matches("[REDACTED_").count() as u32;

        SanitizeResult {
            sanitized_text: sanitized,
            redaction_count: redactions,
        }
    }));

    match result {
        Ok(res) => Ok(res),
        Err(payload) => {
            let msg = if let Some(s) = payload.downcast_ref::<&str>() {
                s.to_string()
            } else {
                "Panic during content sanitization".to_string()
            };
            Err(errors::AutoDocError::FfiPanic { reason: msg }.into())
        }
    }
}

/// Native Prompt Guard wrapping untrusted code in semantic delimiters.
#[napi]
pub fn wrap_untrusted(content: String, origin: String, file: String, symbol: String) -> String {
    sanitizer::wrap_untrusted_code(&content, &origin, &file, &symbol)
}

/// Helper function to explicitly test panic interception via catch_unwind.
#[napi]
pub fn trigger_panic_test(reason: String) -> napi::Result<String> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        panic!("Controlled panic for testing: {}", reason);
    }));

    match result {
        Ok(_) => Ok("Unexpected success".to_string()),
        Err(payload) => {
            let panic_msg = if let Some(s) = payload.downcast_ref::<&str>() {
                s.to_string()
            } else if let Some(s) = payload.downcast_ref::<String>() {
                s.clone()
            } else {
                "Unknown panic payload".to_string()
            };
            Err(errors::AutoDocError::FfiPanic { reason: panic_msg }.into())
        }
    }
}

#[napi(object)]
#[derive(Debug, Serialize, Deserialize)]
pub struct NativeScanResult {
    pub scan_id: String,
    pub active_scan_id: Option<String>,
    pub total_files: u32,
    pub candidate_files: u32,
    pub files_with_errors: u32,
    pub total_loc: u32,
    pub total_symbols: u32,
    pub total_edges: u32,
    pub languages: Vec<String>,
    pub cache_path: String,
    pub analysis_state: String,
    pub coverage_state: String,
    pub diagnostics: Vec<NativeScanDiagnostic>,
}

#[napi(object)]
#[derive(Debug, Serialize, Deserialize)]
pub struct NativeScanDiagnostic {
    pub stage: String,
    pub code: String,
    pub path: Option<String>,
    pub message: String,
}

/// Optional per-scan budgets. Omitted fields use the core defaults.
#[napi(object)]
#[derive(Debug, Default)]
pub struct NativeScanOptions {
    pub max_source_bytes: Option<u32>,
    pub workers: Option<u32>,
    pub queue_capacity: Option<u32>,
    pub batch_size: Option<u32>,
}

/// Recursively scans a repository using parallel Rayon workers and writes to SQLite WAL cache.
#[napi]
pub fn scan_repository_native(
    repo_path: String,
    options: Option<NativeScanOptions>,
) -> napi::Result<NativeScanResult> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let path = std::path::PathBuf::from(&repo_path);
        if !path.is_dir() {
            return Err(errors::AutoDocError::RepositoryNotFound {
                path: repo_path.clone(),
            }
            .into());
        }
        let storage = std::sync::Arc::new(cache::StorageEngine::new(&path)?);
        let sanitizer = std::sync::Arc::new(sanitizer::SanitizerEngine::new());
        let scanner = scanner::RepositoryScanner::new(&path, storage.clone(), sanitizer);
        let defaults = scanner::ScanOptions::default();
        let options = options.unwrap_or_default();
        let scan_options = scanner::ScanOptions {
            max_source_bytes: options
                .max_source_bytes
                .map(u64::from)
                .unwrap_or(defaults.max_source_bytes),
            workers: options
                .workers
                .map(|value| value as usize)
                .unwrap_or(defaults.workers),
            queue_capacity: options
                .queue_capacity
                .map(|value| value as usize)
                .unwrap_or(defaults.queue_capacity),
            batch_size: options
                .batch_size
                .map(|value| value as usize)
                .unwrap_or(defaults.batch_size),
        };
        let report = scanner.scan_repository_with_options(scan_options)?;

        Ok(NativeScanResult {
            scan_id: report.scan_id,
            active_scan_id: report.active_scan_id,
            total_files: report.total_files as u32,
            candidate_files: report.candidate_files as u32,
            files_with_errors: report.files_with_errors as u32,
            total_loc: report.total_loc as u32,
            total_symbols: report.total_symbols as u32,
            total_edges: report.total_edges as u32,
            languages: report.scanned_languages,
            cache_path: storage.db_path().to_string_lossy().to_string(),
            analysis_state: report.analysis_state,
            coverage_state: report.coverage_state,
            diagnostics: report
                .diagnostics
                .into_iter()
                .map(|d| NativeScanDiagnostic {
                    stage: d.stage,
                    code: d.code,
                    path: d.path,
                    message: d.message,
                })
                .collect(),
        })
    }));

    match result {
        Ok(res) => res,
        Err(payload) => {
            let panic_msg = if let Some(s) = payload.downcast_ref::<&str>() {
                s.to_string()
            } else if let Some(s) = payload.downcast_ref::<String>() {
                s.clone()
            } else {
                "Unknown panic in scan_repository_native".to_string()
            };
            Err(errors::AutoDocError::FfiPanic { reason: panic_msg }.into())
        }
    }
}

/// Reads a root-relative regular file without following symlinks and verifies its original-byte SHA-256.
#[napi]
pub fn read_verified_source_native(
    repo_path: String,
    relative_path: String,
    expected_sha256: String,
) -> napi::Result<napi::bindgen_prelude::Buffer> {
    let root = std::path::PathBuf::from(&repo_path);
    let bytes = inventory::read_verified_source(&root, &relative_path, &expected_sha256)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    Ok(bytes.into())
}
