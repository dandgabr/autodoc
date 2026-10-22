use autodoc_core::cache::StorageEngine;
use tempfile::tempdir;

#[test]
fn upserts_return_the_existing_file_and_symbol_ids() {
    let dir = tempdir().unwrap();
    let storage = StorageEngine::new(dir.path()).unwrap();
    let a = storage.insert_file("a.rs", 1, 10, "a", "rs").unwrap();
    storage.insert_file("b.rs", 1, 10, "b", "rs").unwrap();
    assert_eq!(storage.insert_file("a.rs", 2, 11, "c", "rs").unwrap(), a);

    let sym_a = storage.insert_symbol(a, "a::f", "f", "function", "pub", 1, 1, 1, "fn f()", None).unwrap();
    storage.insert_symbol(a, "b::g", "g", "function", "pub", 1, 1, 1, "fn g()", None).unwrap();
    assert_eq!(storage.insert_symbol(a, "a::f", "f", "function", "pub", 2, 2, 1, "fn f()", None).unwrap(), sym_a);
}

#[test]
fn edge_foreign_keys_reject_unknown_symbols() {
    let dir = tempdir().unwrap();
    let storage = StorageEngine::new(dir.path()).unwrap();
    assert!(storage.insert_edge(9876, 9877, "calls", 1.0).is_err());
}

#[test]
fn rejects_future_schema_without_changing_version() {
    let dir = tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(".autodoc")).unwrap();
    let db_path = dir.path().join(".autodoc/cache.db");
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    conn.pragma_update(None, "user_version", 99).unwrap();
    drop(conn);
    assert!(StorageEngine::new(dir.path()).is_err());
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
    assert_eq!(version, 99);
}

#[test]
fn migrates_legacy_edges_to_foreign_keys_and_discards_orphans() {
    let dir = tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(".autodoc")).unwrap();
    let db_path = dir.path().join(".autodoc/cache.db");
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    conn.execute_batch("CREATE TABLE files(file_id INTEGER PRIMARY KEY, path TEXT); CREATE TABLE symbols(symbol_id INTEGER PRIMARY KEY, file_id INTEGER); CREATE TABLE edges(caller_id INTEGER NOT NULL, callee_id INTEGER NOT NULL, edge_kind TEXT NOT NULL, weight REAL NOT NULL, PRIMARY KEY(caller_id,callee_id,edge_kind)) WITHOUT ROWID; INSERT INTO edges VALUES(1,2,'calls',1.0); PRAGMA user_version=1;").unwrap();
    drop(conn);
    let storage = StorageEngine::new(dir.path()).unwrap();
    let conn = storage.reader().unwrap();
    let orphan_count: i64 = conn.query_row("SELECT COUNT(*) FROM edges", [], |row| row.get(0)).unwrap();
    assert_eq!(orphan_count, 0);
    let violations: i64 = conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| row.get(0)).unwrap();
    assert_eq!(violations, 0);
}
