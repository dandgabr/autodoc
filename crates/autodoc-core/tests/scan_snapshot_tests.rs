use autodoc_core::cache::schema::{initialize_schema, CURRENT_SCHEMA_VERSION};
use autodoc_core::{
    cache::StorageEngine,
    sanitizer::SanitizerEngine,
    scanner::{RepositoryScanner, ScanOptions},
};
use rusqlite::Connection;
use std::sync::Arc;
use tempfile::tempdir;

#[test]
fn a_complete_rescan_publishes_a_new_immutable_generation() {
    let dir = tempdir().unwrap();
    std::fs::write(
        dir.path().join("a.ts"),
        "export function first() { return 1; }\n",
    )
    .unwrap();
    std::fs::write(
        dir.path().join("b.ts"),
        "export function second() { return 2; }\n",
    )
    .unwrap();
    let storage = Arc::new(StorageEngine::new(dir.path()).unwrap());
    let scanner = RepositoryScanner::new(
        dir.path(),
        storage.clone(),
        Arc::new(SanitizerEngine::new()),
    );
    let first = scanner.scan_repository().unwrap();
    assert_eq!(
        first.active_scan_id.as_deref(),
        Some(first.scan_id.as_str())
    );
    std::fs::remove_file(dir.path().join("b.ts")).unwrap();
    let result = scanner.scan_repository().unwrap();
    assert_eq!(result.analysis_state, "complete");
    assert_ne!(result.scan_id, first.scan_id);
    assert_eq!(
        result.active_scan_id.as_deref(),
        Some(result.scan_id.as_str())
    );
    let conn = storage.reader().unwrap();
    let paths: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM generation_files WHERE scan_id=?1",
            [result.scan_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    let symbols: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM generation_symbols WHERE scan_id=?1",
            [result.scan_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    let stale_fts: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM generation_fts WHERE scan_id=?1 AND name='second'",
            [result.scan_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(paths, 1);
    assert_eq!(symbols, 1);
    assert_eq!(stale_fts, 0);
    let prior_generation_symbol: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM generation_symbols WHERE scan_id=?1 AND name='second'",
            [first.scan_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        prior_generation_symbol, 1,
        "the old generation remains independently queryable"
    );
}

#[test]
fn a_partial_scan_keeps_the_previous_complete_snapshot_active() {
    let dir = tempdir().unwrap();
    let source = dir.path().join("lib.rs");
    std::fs::write(&source, "pub fn stable() { }\n").unwrap();
    let storage = Arc::new(StorageEngine::new(dir.path()).unwrap());
    let scanner = RepositoryScanner::new(
        dir.path(),
        storage.clone(),
        Arc::new(SanitizerEngine::new()),
    );
    let first = scanner.scan_repository().unwrap();
    std::fs::write(&source, "pub fn broken( {\n").unwrap();

    let attempt = scanner.scan_repository().unwrap();
    assert_eq!(attempt.analysis_state, "partial");
    assert_ne!(attempt.scan_id, first.scan_id);
    assert_eq!(attempt.active_scan_id, first.active_scan_id);

    let conn = storage.reader().unwrap();
    let stable: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM generation_symbols WHERE scan_id=?1 AND name='stable'",
            [first.scan_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stable, 1);
    let active: Option<String> = conn
        .query_row(
            "SELECT active_scan_id FROM repository_state WHERE repository_key='default'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(active.as_deref(), Some(first.scan_id.as_str()));
}

#[test]
fn source_budget_marks_attempt_partial_and_preserves_previous_generation() {
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("stable.ts"), "x").unwrap();
    let storage = Arc::new(StorageEngine::new(dir.path()).unwrap());
    let scanner = RepositoryScanner::new(
        dir.path(),
        storage.clone(),
        Arc::new(SanitizerEngine::new()),
    );
    let complete = scanner.scan_repository().unwrap();
    std::fs::write(dir.path().join("large.ts"), "123456789").unwrap();

    let result = scanner
        .scan_repository_with_options(ScanOptions {
            max_source_bytes: 4,
            workers: 1,
            queue_capacity: 1,
            batch_size: 1,
        })
        .unwrap();

    assert_eq!(result.analysis_state, "partial");
    assert_eq!(
        result.active_scan_id.as_deref(),
        Some(complete.scan_id.as_str())
    );
    assert!(result.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == "SOURCE_SIZE_LIMIT" && diagnostic.path.as_deref() == Some("large.ts")
    }));
    let conn = storage.reader().unwrap();
    let latest: String = conn
        .query_row(
            "SELECT state FROM scan_runs WHERE scan_id=?1",
            [&result.scan_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(latest, "partial");
    let published_large: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM generation_files WHERE scan_id=?1 AND path='large.ts'",
            [&complete.scan_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(published_large, 0);
}

#[test]
fn scan_options_reject_budgets_above_defaults() {
    let options = ScanOptions {
        max_source_bytes: 4 * 1024 * 1024 + 1,
        ..ScanOptions::default()
    };
    assert!(options.validate().is_err());
}

#[test]
fn small_queue_and_inventory_batches_scan_multiple_sources() {
    let dir = tempdir().unwrap();
    for index in 0..5 {
        std::fs::write(
            dir.path().join(format!("file{index}.ts")),
            format!("export function f{index}() {{ return {index}; }}"),
        )
        .unwrap();
    }
    let storage = Arc::new(StorageEngine::new(dir.path()).unwrap());
    let scanner = RepositoryScanner::new(
        dir.path(),
        storage.clone(),
        Arc::new(SanitizerEngine::new()),
    );
    let result = scanner
        .scan_repository_with_options(ScanOptions {
            max_source_bytes: 128,
            workers: 1,
            queue_capacity: 1,
            batch_size: 1,
        })
        .unwrap();

    assert_eq!(result.analysis_state, "complete");
    assert_eq!(result.total_files, 5);
    let conn = storage.reader().unwrap();
    let inventory_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM inventory_files WHERE scan_id=?1",
            [&result.scan_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(inventory_count, 5);
}

#[test]
fn cli_and_library_fixture_symbols_are_published_in_the_active_generation() {
    let dir = tempdir().unwrap();
    std::fs::write(
        dir.path().join("main.py"),
        "def run():\n    return \"ready\"\n",
    )
    .unwrap();
    std::fs::write(
        dir.path().join("index.ts"),
        "export function add(left: number, right: number): number { return left + right; }\n",
    )
    .unwrap();
    let storage = Arc::new(StorageEngine::new(dir.path()).unwrap());
    let scanner = RepositoryScanner::new(
        dir.path(),
        storage.clone(),
        Arc::new(SanitizerEngine::new()),
    );
    let result = scanner.scan_repository().unwrap();
    assert_eq!(result.analysis_state, "complete");

    let conn = storage.reader().unwrap();
    let symbols = conn
        .prepare(
            "SELECT s.name, f.path, s.kind FROM generation_symbols s \
             JOIN generation_files f USING (scan_id, file_id) \
             WHERE s.scan_id=?1 ORDER BY f.path, s.name",
        )
        .unwrap()
        .query_map([result.scan_id.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(symbols.len(), 2);
    assert!(symbols
        .iter()
        .any(|(name, path, kind)| name == "run" && path == "main.py" && kind == "function"));
    assert!(symbols
        .iter()
        .any(|(name, path, kind)| name == "add" && path == "index.ts" && kind == "function"));

    // The legacy tables are deliberately not the active-snapshot projection.
    let legacy_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM symbols", [], |row| row.get(0))
        .unwrap();
    assert_eq!(legacy_count, 0);
}

#[test]
fn missing_repository_fails_before_opening_a_cache() {
    let dir = tempdir().unwrap();
    let missing = dir.path().join("missing");
    let storage = Arc::new(StorageEngine::new(dir.path()).unwrap());
    let scanner = RepositoryScanner::new(&missing, storage, Arc::new(SanitizerEngine::new()));
    assert!(scanner.scan_repository().is_err());
}

#[test]
fn unsupported_language_coverage_does_not_block_a_complete_inventory_snapshot() {
    let dir = tempdir().unwrap();
    std::fs::write(
        dir.path().join("Runner.cs"),
        "public void run() { execute(); }\n",
    )
    .unwrap();
    let storage = Arc::new(StorageEngine::new(dir.path()).unwrap());
    let scanner = RepositoryScanner::new(dir.path(), storage, Arc::new(SanitizerEngine::new()));
    let result = scanner.scan_repository().unwrap();
    assert_eq!(result.analysis_state, "complete");
    assert_eq!(result.coverage_state, "partial");
    assert!(result
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "AST_UNSUPPORTED"));
}

#[test]
fn migrates_schema_three_to_generation_scoped_tables_without_promoting_legacy_rows() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("legacy.db");
    let conn = Connection::open(&db_path).unwrap();
    conn.execute_batch(
        "CREATE TABLE files(file_id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE);\
         INSERT INTO files VALUES(1, 'legacy.rs');\
         CREATE TABLE symbols(symbol_id INTEGER PRIMARY KEY, file_id INTEGER, fqsn TEXT);\
         INSERT INTO symbols VALUES(1, 1, 'legacy::symbol');\
         CREATE VIRTUAL TABLE fts_symbols USING fts5(fqsn);\
         INSERT INTO fts_symbols VALUES('legacy::symbol');\
         CREATE TABLE scan_runs(scan_id TEXT PRIMARY KEY, state TEXT NOT NULL, diagnostics_json TEXT NOT NULL, created_at INTEGER NOT NULL);\
         CREATE TABLE scan_state(singleton INTEGER PRIMARY KEY, active_scan_id TEXT, latest_attempt_id TEXT);\
         INSERT INTO scan_runs VALUES('legacy-scan','complete','[]',0);\
         INSERT INTO scan_state VALUES(1, 'legacy-scan', 'legacy-scan');\
         PRAGMA user_version=3;",
    ).unwrap();
    drop(conn);

    let conn = Connection::open(&db_path).unwrap();
    initialize_schema(&conn).unwrap();

    let version: i32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, CURRENT_SCHEMA_VERSION);
    let generation_table_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN \
         ('generation_files','generation_symbols','generation_edges','generation_fts',\
          'inventory_files','facts','evidence','relations','repository_state')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(generation_table_count, 9);
    let legacy_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM symbols WHERE fqsn='legacy::symbol'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        legacy_count, 1,
        "legacy rows remain available for diagnosis"
    );
    let promoted_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM generation_symbols", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(
        promoted_count, 0,
        "legacy rows must not be treated as a verified snapshot"
    );
    let active_scan_id: Option<String> = conn
        .query_row(
            "SELECT active_scan_id FROM repository_state WHERE repository_key='default'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        active_scan_id, None,
        "legacy scans have no generation-qualified projection"
    );
    let legacy_run_state: String = conn
        .query_row(
            "SELECT state FROM scan_runs WHERE scan_id='legacy-scan'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(legacy_run_state, "superseded");
}

#[test]
fn rejects_future_schema_before_changing_journal_mode_or_creating_sidecars() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("future.db");
    let conn = Connection::open(&db_path).unwrap();
    conn.execute_batch(
        "PRAGMA journal_mode=DELETE; PRAGMA user_version=99; CREATE TABLE sentinel(value TEXT);",
    )
    .unwrap();

    assert!(initialize_schema(&conn).is_err());

    let version: i32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    let journal_mode: String = conn
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 99);
    assert_eq!(journal_mode.to_ascii_lowercase(), "delete");
    assert!(!std::path::PathBuf::from(format!("{}-wal", db_path.display())).exists());
    assert!(!std::path::PathBuf::from(format!("{}-shm", db_path.display())).exists());
}

#[test]
fn native_snapshot_reads_pin_a_generation_and_discover_existing_cache_without_creating_one() {
    let dir = tempdir().unwrap();
    let repo = dir.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::write(repo.join("a.ts"), "export function alpha() { return 1; }\n").unwrap();
    std::fs::write(repo.join("z.ts"), "export function omega() { return 2; }\n").unwrap();
    let storage = Arc::new(StorageEngine::new(&repo).unwrap());
    let scanner = RepositoryScanner::new(&repo, storage.clone(), Arc::new(SanitizerEngine::new()));
    let g1 = scanner.scan_repository().unwrap();

    let metadata =
        autodoc_core::read_repository_snapshot_native(repo.to_string_lossy().into_owned(), None)
            .unwrap();
    let metadata: serde_json::Value = serde_json::from_str(&metadata).unwrap();
    assert_eq!(metadata["scanId"], g1.scan_id);
    let first_page = autodoc_core::read_snapshot_page_native(
        repo.to_string_lossy().into_owned(),
        g1.scan_id.clone(),
        "files".into(),
        None,
        1,
    )
    .unwrap();
    let first_page: serde_json::Value = serde_json::from_str(&first_page).unwrap();
    assert_eq!(first_page["scanId"], g1.scan_id);
    assert_eq!(first_page["items"][0]["path"], "a.ts");
    let cursor = first_page["nextCursor"].as_str().unwrap().to_owned();
    let second_page = autodoc_core::read_snapshot_page_native(
        repo.to_string_lossy().into_owned(),
        g1.scan_id.clone(),
        "files".into(),
        Some(cursor.clone()),
        1,
    )
    .unwrap();
    let second_page: serde_json::Value = serde_json::from_str(&second_page).unwrap();
    assert_eq!(second_page["items"][0]["path"], "z.ts");
    assert!(autodoc_core::read_snapshot_page_native(
        repo.to_string_lossy().into_owned(),
        g1.scan_id.clone(),
        "facts".into(),
        Some(cursor.clone()),
        1
    )
    .unwrap_err()
    .to_string()
    .contains("INVALID_CURSOR"));

    std::fs::write(repo.join("b.ts"), "export function beta() { return 2; }\n").unwrap();
    let g2 = scanner.scan_repository().unwrap();
    assert_ne!(g1.scan_id, g2.scan_id);
    let old_page = autodoc_core::read_snapshot_page_native(
        repo.to_string_lossy().into_owned(),
        g1.scan_id.clone(),
        "files".into(),
        None,
        1,
    )
    .unwrap();
    let old_page: serde_json::Value = serde_json::from_str(&old_page).unwrap();
    assert_eq!(
        old_page["scanId"], g1.scan_id,
        "G1 reads cannot drift to G2"
    );
    let old_metadata = autodoc_core::read_repository_snapshot_native(
        repo.to_string_lossy().into_owned(),
        Some(g1.scan_id.clone()),
    )
    .unwrap();
    let old_metadata: serde_json::Value = serde_json::from_str(&old_metadata).unwrap();
    assert_eq!(
        old_metadata["scanId"], g1.scan_id,
        "metadata can be pinned to a retained generation"
    );
    assert!(autodoc_core::read_snapshot_page_native(
        repo.to_string_lossy().into_owned(),
        g1.scan_id.clone(),
        "files".into(),
        Some(cursor),
        1
    )
    .unwrap()
    .contains("z.ts"));

    let absent = dir.path().join("not-scanned");
    std::fs::create_dir(&absent).unwrap();
    let error =
        autodoc_core::read_repository_snapshot_native(absent.to_string_lossy().into_owned(), None)
            .unwrap_err();
    assert!(error.to_string().contains("NOT_SCANNED"));
    assert!(
        !absent.join(".autodoc").exists(),
        "read-only snapshot lookup must not create a cache"
    );
}

#[test]
fn native_snapshot_page_reports_a_single_record_over_one_mib_without_skipping_it() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    let cache_dir = repo.join(".autodoc");
    std::fs::create_dir_all(&cache_dir).unwrap();
    let db_path = cache_dir.join("cache.db");
    let conn = Connection::open(&db_path).unwrap();
    initialize_schema(&conn).unwrap();
    conn.execute("INSERT INTO scan_runs(scan_id,state,diagnostics_json,created_at) VALUES ('large','running','[]',0)", []).unwrap();
    conn.execute(
        "INSERT INTO inventory_files(scan_id,path,category,support) VALUES ('large',?1,'source','ast')",
        ["x".repeat(1024 * 1024 + 128)],
    ).unwrap();
    conn.execute(
        "UPDATE scan_runs SET state='complete' WHERE scan_id='large'",
        [],
    )
    .unwrap();
    conn.execute("UPDATE repository_state SET active_scan_id='large',latest_attempt_id='large' WHERE repository_key='default'", []).unwrap();
    drop(conn);

    let error = autodoc_core::read_snapshot_page_native(
        repo.to_string_lossy().into_owned(),
        "large".into(),
        "files".into(),
        None,
        1,
    )
    .unwrap_err()
    .to_string();
    assert!(error.contains("ITEM_TOO_LARGE"));
    assert!(error.contains("collection=files"));
    let bytes = error
        .split("bytes=")
        .nth(1)
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or_default();
    assert!(
        bytes > 1024 * 1024,
        "the error should include the serialized item size: {error}"
    );
}

#[test]
fn native_snapshot_pages_reject_divergent_or_expired_cursors_and_invalid_limits() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    std::fs::write(repo.join("a.ts"), "export function alpha() { return 1; }\n").unwrap();
    std::fs::write(repo.join("b.ts"), "export function beta() { return 2; }\n").unwrap();
    let (scan_id, valid_cursor) = {
        let storage = Arc::new(StorageEngine::new(repo).unwrap());
        let scanner = RepositoryScanner::new(repo, storage, Arc::new(SanitizerEngine::new()));
        let scan = scanner.scan_repository().unwrap();
        let first = autodoc_core::read_snapshot_page_native(
            repo.to_string_lossy().into_owned(),
            scan.scan_id.clone(),
            "files".into(),
            None,
            1,
        )
        .unwrap();
        let first: serde_json::Value = serde_json::from_str(&first).unwrap();
        (
            scan.scan_id,
            first["nextCursor"].as_str().unwrap().to_owned(),
        )
    };
    let cursor = Some("not-a-valid-cursor".to_owned());
    assert!(autodoc_core::read_snapshot_page_native(
        repo.to_string_lossy().into_owned(),
        scan_id.clone(),
        "files".into(),
        cursor,
        1
    )
    .is_err());
    assert!(autodoc_core::read_snapshot_page_native(
        repo.to_string_lossy().into_owned(),
        scan_id.clone(),
        "files".into(),
        None,
        501
    )
    .is_err());
    let other_root = dir.path().join("same-cache-at-another-root");
    std::fs::create_dir_all(other_root.join(".autodoc")).unwrap();
    std::fs::copy(
        repo.join(".autodoc/cache.db"),
        other_root.join(".autodoc/cache.db"),
    )
    .unwrap();
    assert!(autodoc_core::read_snapshot_page_native(
        other_root.to_string_lossy().into_owned(),
        scan_id.clone(),
        "files".into(),
        Some(valid_cursor),
        1
    )
    .unwrap_err()
    .to_string()
    .contains("INVALID_CURSOR"));
    assert!(autodoc_core::read_snapshot_page_native(
        repo.to_string_lossy().into_owned(),
        "expired-scan".into(),
        "files".into(),
        None,
        1
    )
    .unwrap_err()
    .to_string()
    .contains("SNAPSHOT_UNAVAILABLE"));
}

#[test]
fn another_process_discovers_the_xdg_cache_without_cwd_or_memory_registry() {
    if let Ok(repo) = std::env::var("AUTODOC_XDG_CHILD_REPO") {
        let metadata = autodoc_core::read_repository_snapshot_native(repo, None).unwrap();
        let metadata: serde_json::Value = serde_json::from_str(&metadata).unwrap();
        assert_eq!(
            metadata["scanId"],
            std::env::var("AUTODOC_XDG_CHILD_SCAN").unwrap()
        );
        return;
    }

    let dir = tempdir().unwrap();
    let repo = dir.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::write(repo.join("main.rs"), "pub fn stable() {}\n").unwrap();
    let scan_id = {
        let storage = Arc::new(StorageEngine::new(&repo).unwrap());
        let scanner = RepositoryScanner::new(&repo, storage, Arc::new(SanitizerEngine::new()));
        scanner.scan_repository().unwrap().scan_id
    };

    let cache_home = dir.path().join("xdg-cache");
    let canonical = repo.canonicalize().unwrap();
    let root_key = format!(
        "{:016x}",
        twox_hash::XxHash64::oneshot(0, canonical.to_string_lossy().as_bytes())
    );
    let fallback = cache_home.join("autodoc").join(root_key);
    std::fs::create_dir_all(&fallback).unwrap();
    std::fs::copy(repo.join(".autodoc/cache.db"), fallback.join("cache.db")).unwrap();
    std::fs::remove_dir_all(repo.join(".autodoc")).unwrap();
    let unrelated_cwd = dir.path().join("elsewhere");
    std::fs::create_dir(&unrelated_cwd).unwrap();

    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "another_process_discovers_the_xdg_cache_without_cwd_or_memory_registry",
            "--nocapture",
        ])
        .current_dir(unrelated_cwd)
        .env("AUTODOC_XDG_CHILD_REPO", &repo)
        .env("AUTODOC_XDG_CHILD_SCAN", &scan_id)
        .env("XDG_CACHE_HOME", &cache_home)
        .env("XDG_STATE_HOME", dir.path().join("xdg-state"))
        .status()
        .unwrap();
    assert!(
        status.success(),
        "a new process should discover the same XDG cache by canonical repository root"
    );
    assert!(
        !repo.join(".autodoc").exists(),
        "read-only discovery must not recreate a repository cache"
    );
}
