use std::sync::Arc;
use std::thread;
use autodoc_core::cache::StorageEngine;

#[test]
fn test_sqlite_wal_concurrent_stress() {
    let temp_dir = tempfile::tempdir().expect("Failed to create tempdir");
    let storage = Arc::new(StorageEngine::new(temp_dir.path()).expect("StorageEngine init failed"));

    // Insert base file
    let file_id = storage.insert_file("src/main.rs", 1000, 2048, "a1b2c3d4e5f6", "rust")
        .expect("File insertion failed");

    // Spawn 10 reader threads
    let mut reader_handles = Vec::new();
    for t in 0..10 {
        let storage_ref = Arc::clone(&storage);
        let handle = thread::spawn(move || {
            for _ in 0..50 {
                let conn = storage_ref.reader().expect("Failed to get connection from reader pool");
                let mut stmt = conn.prepare("SELECT count(*) FROM symbols WHERE file_id = ?1").unwrap();
                let count: i64 = stmt.query_row([file_id], |r| r.get(0)).unwrap();
                assert!(count >= 0);
            }
            t
        });
        reader_handles.push(handle);
    }

    // Simultaneously insert symbols and edges via DedicatedWriter
    for i in 0..200 {
        let fqsn = format!("crate::module::func_{}", i);
        let name = format!("func_{}", i);
        let sym_id = storage.insert_symbol(
            file_id,
            &fqsn,
            &name,
            "function",
            "pub",
            i * 10,
            i * 10 + 9,
            3,
            &format!("fn {}() -> bool", name),
            Some("Documented function"),
        ).expect("Insert symbol failed");

        if sym_id > 1 {
            storage.insert_edge(sym_id - 1, sym_id, "calls", 1.0)
                .expect("Insert edge failed");
        }
    }

    // Await reader threads
    for handle in reader_handles {
        let tid = handle.join().expect("Reader thread panicked");
        assert!(tid < 10);
    }

    // Verify database integrity via PRAGMA integrity_check
    let conn = storage.reader().expect("Reader connection failed");
    let mut stmt = conn.prepare("PRAGMA integrity_check").unwrap();
    let status: String = stmt.query_row([], |r| r.get(0)).unwrap();
    assert_eq!(status, "ok");
}

#[test]
fn test_without_rowid_and_covering_indexes() {
    let temp_dir = tempfile::tempdir().expect("Failed to create tempdir");
    let storage = StorageEngine::new(temp_dir.path()).expect("StorageEngine init failed");

    // Insert edges
    storage.insert_edge(10, 20, "calls", 1.0).unwrap();
    storage.insert_edge(10, 30, "calls", 1.0).unwrap();
    storage.insert_edge(20, 30, "calls", 1.0).unwrap();

    let conn = storage.reader().unwrap();
    // Query incoming edges to node 30 using covering index
    let mut stmt = conn.prepare(
        "SELECT caller_id, edge_kind FROM edges WHERE callee_id = ?1 ORDER BY caller_id"
    ).unwrap();

    let callers: Vec<i64> = stmt.query_map([30], |r| r.get(0)).unwrap().filter_map(|r| r.ok()).collect();
    assert_eq!(callers, vec![10, 20]);
}
