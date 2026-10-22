use autodoc_core::cache::StorageEngine;
use rusqlite::Connection;
use sha2::Digest;
use tempfile::tempdir;

fn insert_symbol(storage: &StorageEngine, path: &str, fqsn: &str, name: &str) {
    let (file_id, _) = storage
        .insert_batch_analysis(
            path,
            1,
            1,
            "oid",
            "rust",
            vec![autodoc_core::parser::ExtractedSymbol {
                fqsn: fqsn.into(),
                name: name.into(),
                kind: "function".into(),
                visibility: "public".into(),
                line_start: 1,
                line_end: 1,
                complexity: 1,
                signature: format!("fn {name}()"),
                docstring: None,
            }],
        )
        .unwrap();
    assert!(file_id > 0);
}

fn insert_inventory_file(storage: &StorageEngine, scan_id: &str, path: &str) {
    storage
        .replace_inventory(
            scan_id,
            &[autodoc_core::inventory::InventoryFile {
                path: path.into(),
                category: autodoc_core::inventory::InventoryCategory::Source,
                support: autodoc_core::inventory::InventorySupport::Ast,
                content_sha256: None,
                excluded_reason: None,
                read_error: None,
                size_bytes: 1,
                modified_ns: 1,
            }],
        )
        .unwrap();
}

#[test]
fn dropping_staging_removes_attempt_database_and_wal_files() {
    let dir = tempdir().unwrap();
    let active = StorageEngine::new(dir.path()).unwrap();
    let staged = active.new_staging("scan-cleanup").unwrap();
    let path = staged.db_path().to_path_buf();
    assert!(path.exists());
    drop(staged);
    assert!(!path.exists());
    assert!(!std::path::PathBuf::from(format!("{}-wal", path.display())).exists());
    assert!(!std::path::PathBuf::from(format!("{}-shm", path.display())).exists());
}

#[test]
fn partial_attempt_updates_latest_without_changing_active_snapshot() {
    let dir = tempdir().unwrap();
    let active = StorageEngine::new(dir.path()).unwrap();
    let staged = active.new_staging("scan-complete-1").unwrap();
    active.begin_scan_attempt("scan-complete-1").unwrap();
    insert_symbol(&staged, "src/old.rs", "old::symbol", "old");
    active
        .publish_snapshot_from(&staged, "scan-complete-1", "[]")
        .unwrap();
    drop(staged);

    let partial = active.new_staging("scan-partial-2").unwrap();
    active.begin_scan_attempt("scan-partial-2").unwrap();
    insert_symbol(&partial, "src/new.rs", "new::symbol", "new");
    active
        .record_scan_attempt("scan-partial-2", "partial", "[\"parse warning\"]")
        .unwrap();

    assert_eq!(
        active.active_scan_id().unwrap().as_deref(),
        Some("scan-complete-1")
    );
    assert_eq!(
        active.latest_attempt_id().unwrap().as_deref(),
        Some("scan-partial-2")
    );
    let conn = active.reader().unwrap();
    let names: Vec<String> = conn
        .prepare(
            "SELECT name FROM generation_symbols WHERE scan_id='scan-complete-1' ORDER BY name",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(names, ["old"]);
    let state: String = conn
        .query_row(
            "SELECT state FROM scan_runs WHERE scan_id='scan-partial-2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "partial");
}

#[test]
fn complete_staging_is_published_with_metadata_as_one_snapshot() {
    let dir = tempdir().unwrap();
    let active = StorageEngine::new(dir.path()).unwrap();
    let first = active.new_staging("scan-1").unwrap();
    active.begin_scan_attempt("scan-1").unwrap();
    insert_symbol(&first, "old.rs", "old::entry", "old_entry");
    active
        .publish_snapshot_from(&first, "scan-1", "[]")
        .unwrap();
    drop(first);

    let second = active.new_staging("scan-2").unwrap();
    active.begin_scan_attempt("scan-2").unwrap();
    insert_symbol(&second, "new.rs", "new::entry", "new_entry");
    active
        .publish_snapshot_from(&second, "scan-2", "[\"ok\"]")
        .unwrap();

    assert_eq!(active.active_scan_id().unwrap().as_deref(), Some("scan-2"));
    assert_eq!(
        active.latest_attempt_id().unwrap().as_deref(),
        Some("scan-2")
    );
    let conn = active.reader().unwrap();
    let paths: Vec<String> = conn
        .prepare("SELECT path FROM generation_files WHERE scan_id='scan-2' ORDER BY path")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(paths, ["new.rs"]);
    let run_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM scan_runs WHERE state='complete'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(run_count, 2);
}

#[test]
fn publication_preserves_call_site_relations_and_evidence() {
    let dir = tempdir().unwrap();
    let active = StorageEngine::new(dir.path()).unwrap();
    let staged = active.new_staging("scan-evidence").unwrap();
    active.begin_scan_attempt("scan-evidence").unwrap();
    let source = "function target() {}\nfunction caller() { target(); target(); }\n";
    let parsed = autodoc_core::parser::parse_file(source, "src/main.js", "js");
    let hash = format!("{:x}", sha2::Sha256::digest(source.as_bytes()));
    staged
        .replace_inventory(
            "scan-evidence",
            &[autodoc_core::inventory::InventoryFile {
                path: "src/main.js".into(),
                category: autodoc_core::inventory::InventoryCategory::Source,
                support: autodoc_core::inventory::InventorySupport::Ast,
                content_sha256: Some(hash.clone()),
                excluded_reason: None,
                read_error: None,
                size_bytes: source.len() as u64,
                modified_ns: 1,
            }],
        )
        .unwrap();
    staged
        .insert_batch_analysis(
            "src/main.js",
            1,
            source.len() as i64,
            "oid",
            "js",
            parsed.symbols,
        )
        .unwrap();
    staged.bulk_resolve_edges(parsed.edges).unwrap();
    active
        .publish_snapshot_from(&staged, "scan-evidence", "[]")
        .unwrap();

    let conn = active.reader().unwrap();
    let relation: (String, String, String, String) = conn
        .query_row(
            "SELECT r.from_id, r.to_id, r.resolution, r.evidence_ids_json \
             FROM relations r WHERE r.scan_id='scan-evidence' AND r.kind='call'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("published generation contains a call relation");
    let relation_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM relations WHERE scan_id='scan-evidence' AND kind='call'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        relation_count, 2,
        "same-line callsites keep separate identities"
    );
    assert_eq!(relation.0, "src/main.js::caller");
    assert_eq!(relation.1, "src/main.js::target");
    assert_eq!(relation.2, "resolved");
    let evidence_id: String = serde_json::from_str::<Vec<String>>(&relation.3)
        .unwrap()
        .into_iter()
        .next()
        .expect("call relation references source evidence");
    let evidence: (String, String, i32, i32, String, String) = conn
        .query_row(
            "SELECT path, content_sha256, line_start, line_end, extractor, method \
             FROM evidence WHERE scan_id='scan-evidence' AND evidence_id=?1",
            [&evidence_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .expect("relation evidence is persisted");
    assert_eq!(evidence.0, "src/main.js");
    assert_eq!(evidence.1, hash);
    assert_eq!(evidence.2, 2);
    assert_eq!(evidence.3, 2);
    assert_eq!(evidence.4, "callsite");
    assert_eq!(evidence.5, "tree_sitter_ast");
}

#[test]
fn legacy_schema_two_is_migrated_without_discarding_cache_rows() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join(".autodoc/cache.db");
    std::fs::create_dir_all(db_path.parent().unwrap()).unwrap();
    let conn = Connection::open(&db_path).unwrap();
    conn.execute_batch(
        "CREATE TABLE files(file_id INTEGER PRIMARY KEY, path TEXT); \
         CREATE TABLE symbols(symbol_id INTEGER PRIMARY KEY, file_id INTEGER, name TEXT); \
         INSERT INTO files VALUES(1,'legacy.rs'); INSERT INTO symbols VALUES(1,1,'legacy'); \
         PRAGMA user_version=2;",
    )
    .unwrap();
    drop(conn);

    let storage = StorageEngine::new(dir.path()).unwrap();
    let conn = storage.reader().unwrap();
    let legacy: String = conn
        .query_row("SELECT name FROM symbols WHERE symbol_id=1", [], |row| {
            row.get(0)
        })
        .unwrap();
    let version: i32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(legacy, "legacy");
    assert_eq!(version, autodoc_core::cache::schema::CURRENT_SCHEMA_VERSION);
}

#[test]
fn failed_publication_rolls_back_rows_and_active_pointer() {
    let dir = tempdir().unwrap();
    let active = StorageEngine::new(dir.path()).unwrap();
    let first = active.new_staging("scan-stable").unwrap();
    active.begin_scan_attempt("scan-stable").unwrap();
    insert_symbol(&first, "stable.rs", "stable::entry", "stable");
    active
        .publish_snapshot_from(&first, "scan-stable", "[]")
        .unwrap();
    drop(first);

    let rejected = active.new_staging("scan-rejected").unwrap();
    active.begin_scan_attempt("scan-rejected").unwrap();
    insert_symbol(
        &rejected,
        "replacement.rs",
        "replacement::entry",
        "replacement",
    );
    active
        .reader()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER reject_snapshot_symbol BEFORE INSERT ON generation_symbols \
             BEGIN SELECT RAISE(ABORT, 'injected publication failure'); END;",
        )
        .unwrap();

    assert!(active
        .publish_snapshot_from(&rejected, "scan-rejected", "[]")
        .is_err());
    assert_eq!(
        active.active_scan_id().unwrap().as_deref(),
        Some("scan-stable")
    );
    let conn = active.reader().unwrap();
    let paths: Vec<String> = conn
        .prepare("SELECT path FROM generation_files WHERE scan_id='scan-stable' ORDER BY path")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(paths, ["stable.rs"]);
    let rejected_files: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM generation_files WHERE scan_id='scan-rejected'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let rejected_inventory: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM inventory_files WHERE scan_id='scan-rejected'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        rejected_files, 0,
        "file rows inserted before the injected failure roll back"
    );
    assert_eq!(
        rejected_inventory, 0,
        "inventory rows inserted before the injected failure roll back"
    );
    conn.execute_batch("DROP TRIGGER reject_snapshot_symbol")
        .unwrap();
}

#[test]
fn older_concurrent_scan_cannot_publish_after_newer_attempt_begins() {
    let dir = tempdir().unwrap();
    let active = StorageEngine::new(dir.path()).unwrap();
    let older = active.new_staging("scan-older").unwrap();
    active.begin_scan_attempt("scan-older").unwrap();
    insert_symbol(&older, "older.rs", "older::entry", "older");

    let newer = active.new_staging("scan-newer").unwrap();
    active.begin_scan_attempt("scan-newer").unwrap();
    insert_symbol(&newer, "newer.rs", "newer::entry", "newer");

    assert!(active
        .publish_snapshot_from(&older, "scan-older", "[]")
        .is_err());
    assert_eq!(active.active_scan_id().unwrap(), None);
    assert_eq!(
        active.latest_attempt_id().unwrap().as_deref(),
        Some("scan-newer")
    );

    active
        .record_scan_attempt("scan-older", "failed", "[\"superseded\"]")
        .unwrap();
    assert_eq!(
        active.latest_attempt_id().unwrap().as_deref(),
        Some("scan-newer")
    );
    active
        .publish_snapshot_from(&newer, "scan-newer", "[]")
        .unwrap();
    assert_eq!(
        active.active_scan_id().unwrap().as_deref(),
        Some("scan-newer")
    );
}

#[test]
fn staging_path_cannot_be_reused_while_the_attempt_is_open() {
    let dir = tempdir().unwrap();
    let active = StorageEngine::new(dir.path()).unwrap();
    let first = active.new_staging("scan-unique").unwrap();
    assert!(active.new_staging("scan-unique").is_err());
    assert!(first.db_path().exists());
}

#[test]
fn published_generations_are_preserved_and_never_rewritten() {
    let dir = tempdir().unwrap();
    let active = StorageEngine::new(dir.path()).unwrap();
    let first = active.new_staging("scan-immutable-1").unwrap();
    active.begin_scan_attempt("scan-immutable-1").unwrap();
    insert_symbol(&first, "src/entry.rs", "entry::first", "first");
    insert_inventory_file(&first, "scan-immutable-1", "src/entry.rs");
    active
        .publish_snapshot_from(&first, "scan-immutable-1", "[]")
        .unwrap();
    drop(first);

    let second = active.new_staging("scan-immutable-2").unwrap();
    active.begin_scan_attempt("scan-immutable-2").unwrap();
    insert_symbol(&second, "src/entry.rs", "entry::second", "second");
    insert_inventory_file(&second, "scan-immutable-2", "src/entry.rs");
    active
        .publish_snapshot_from(&second, "scan-immutable-2", "[]")
        .unwrap();
    drop(second);

    let conn = active.reader().unwrap();
    let first_symbol: String = conn.query_row(
        "SELECT name FROM generation_symbols WHERE scan_id='scan-immutable-1' AND fqsn='entry::first'",
        [], |row| row.get(0),
    ).unwrap();
    assert_eq!(first_symbol, "first");
    let inventory_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM inventory_files WHERE scan_id='scan-immutable-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let fts_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM generation_fts WHERE scan_id='scan-immutable-1' AND fqsn='entry::first'", [], |row| row.get(0),
    ).unwrap();
    assert_eq!(inventory_count, 1);
    assert_eq!(fts_count, 1);
    assert!(conn.execute(
        "UPDATE generation_symbols SET name='tampered' WHERE scan_id='scan-immutable-1' AND fqsn='entry::first'",
        [],
    ).is_err(), "published generation must reject mutation");
    assert!(conn.execute(
        "DELETE FROM generation_symbols WHERE scan_id='scan-immutable-1' AND fqsn='entry::first'",
        [],
    ).is_err(), "published generation must reject deletion");
    drop(conn);
    active.begin_scan_attempt("scan-mutation-source").unwrap();
    let conn = active.reader().unwrap();
    conn.execute(
        "INSERT INTO generation_files(scan_id,file_id,path,category,support) VALUES ('scan-mutation-source','path-id','other.rs','source','indexed')",
        [],
    ).unwrap();
    assert!(conn.execute(
        "UPDATE generation_files SET scan_id='scan-immutable-1' WHERE scan_id='scan-mutation-source'",
        [],
    ).is_err(), "moving a row into a published generation must also be rejected");
    drop(conn);
    assert!(active.begin_scan_attempt("scan-immutable-1").is_err());
    assert!(active
        .record_scan_attempt("scan-immutable-1", "failed", "[]")
        .is_err());
    assert_eq!(
        active.active_scan_id().unwrap().as_deref(),
        Some("scan-immutable-2")
    );
}

#[test]
fn retention_keeps_active_and_five_previous_complete_generations() {
    let dir = tempdir().unwrap();
    let active = StorageEngine::new(dir.path()).unwrap();
    for index in 0..7 {
        let scan_id = format!("retention-{index}");
        let staged = active.new_staging(&scan_id).unwrap();
        active.begin_scan_attempt(&scan_id).unwrap();
        insert_symbol(
            &staged,
            &format!("{index}.rs"),
            &format!("entry::{index}"),
            &format!("entry_{index}"),
        );
        active
            .publish_snapshot_from(&staged, &scan_id, "[]")
            .unwrap();
    }
    let conn = active.reader().unwrap();
    let complete: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM scan_runs WHERE state='complete'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        complete, 6,
        "default retention is active plus five prior complete scans"
    );
    let retained_oldest: i64 = conn.query_row(
        "SELECT COUNT(*) FROM generation_symbols WHERE scan_id='retention-1' AND fqsn='entry::1'", [], |r| r.get(0),
    ).unwrap();
    let expired_oldest: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM generation_symbols WHERE scan_id='retention-0'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(retained_oldest, 1);
    assert_eq!(expired_oldest, 0);
}

#[test]
fn publication_translates_staged_edges_to_generation_scoped_symbols() {
    let dir = tempdir().unwrap();
    let active = StorageEngine::new(dir.path()).unwrap();
    let staged = active.new_staging("scan-edge-copy").unwrap();
    active.begin_scan_attempt("scan-edge-copy").unwrap();
    let symbol = |fqsn: &str, name: &str| autodoc_core::parser::ExtractedSymbol {
        fqsn: fqsn.into(),
        name: name.into(),
        kind: "function".into(),
        visibility: "public".into(),
        line_start: 1,
        line_end: 2,
        complexity: 1,
        signature: format!("fn {name}()"),
        docstring: None,
    };
    staged
        .insert_batch_analysis(
            "src/caller.rs",
            1,
            1,
            "caller",
            "rust",
            vec![symbol("app::caller", "caller")],
        )
        .unwrap();
    staged
        .insert_batch_analysis(
            "src/callee.rs",
            1,
            1,
            "callee",
            "rust",
            vec![symbol("app::callee", "callee")],
        )
        .unwrap();
    let (caller, callee): (i64, i64) = {
        let conn = staged.reader().unwrap();
        let caller = conn
            .query_row(
                "SELECT symbol_id FROM symbols WHERE fqsn='app::caller'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let callee = conn
            .query_row(
                "SELECT symbol_id FROM symbols WHERE fqsn='app::callee'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        (caller, callee)
    };
    staged.insert_edge(caller, callee, "calls", 1.0).unwrap();
    active
        .publish_snapshot_from(&staged, "scan-edge-copy", "[]")
        .unwrap();

    let conn = active.reader().unwrap();
    let edge: (String, String, String) = conn.query_row(
        "SELECT caller_id, callee_id, edge_kind FROM generation_edges WHERE scan_id='scan-edge-copy'",
        [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).unwrap();
    assert_eq!(
        edge,
        ("app::caller".into(), "app::callee".into(), "calls".into())
    );
}

#[test]
fn publication_copies_staged_inventory_values_scoped_to_scan_id() {
    let dir = tempdir().unwrap();
    let active = StorageEngine::new(dir.path()).unwrap();
    let staged = active.new_staging("scan-inventory-copy").unwrap();
    active.begin_scan_attempt("scan-inventory-copy").unwrap();
    let inventory = vec![
        autodoc_core::inventory::InventoryFile {
            path: "src/app.ts".into(),
            category: autodoc_core::inventory::InventoryCategory::Source,
            support: autodoc_core::inventory::InventorySupport::Ast,
            content_sha256: Some("sha256-value".into()),
            excluded_reason: None,
            read_error: None,
            size_bytes: 12,
            modified_ns: 1,
        },
        autodoc_core::inventory::InventoryFile {
            path: "assets/logo.png".into(),
            category: autodoc_core::inventory::InventoryCategory::Asset,
            support: autodoc_core::inventory::InventorySupport::Metadata,
            content_sha256: None,
            excluded_reason: Some("binary_asset".into()),
            read_error: None,
            size_bytes: 2048,
            modified_ns: 2,
        },
        autodoc_core::inventory::InventoryFile {
            path: "broken.ts".into(),
            category: autodoc_core::inventory::InventoryCategory::Source,
            support: autodoc_core::inventory::InventorySupport::Unsupported,
            content_sha256: None,
            excluded_reason: None,
            read_error: Some("permission denied".into()),
            size_bytes: 0,
            modified_ns: 0,
        },
    ];
    assert!(staged
        .replace_inventory("another-scan", &inventory)
        .is_err());
    staged
        .replace_inventory("scan-inventory-copy", &inventory)
        .unwrap();
    {
        let conn = staged.reader().unwrap();
        conn.execute(
            "INSERT INTO scan_runs(scan_id,state,diagnostics_json,created_at) VALUES ('other-scan','running','[]',1)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO inventory_files(scan_id,path,category,support,content_sha256,excluded_reason,read_error) \
             VALUES ('other-scan','ignored.ts','source','ast','other-hash',NULL,NULL)",
            [],
        ).unwrap();
    }

    active
        .publish_snapshot_from(&staged, "scan-inventory-copy", "[]")
        .unwrap();

    let conn = active.reader().unwrap();
    let rows: Vec<(
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = conn
        .prepare(
            "SELECT path,category,support,content_sha256,excluded_reason,read_error \
             FROM inventory_files WHERE scan_id='scan-inventory-copy' ORDER BY path",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        rows,
        vec![
            (
                "assets/logo.png".into(),
                "asset".into(),
                "metadata".into(),
                None,
                Some("binary_asset".into()),
                None
            ),
            (
                "broken.ts".into(),
                "source".into(),
                "unsupported".into(),
                None,
                None,
                Some("permission denied".into())
            ),
            (
                "src/app.ts".into(),
                "source".into(),
                "ast".into(),
                Some("sha256-value".into()),
                None,
                None
            ),
        ]
    );
}
