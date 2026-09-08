use rusqlite::{Connection, Result};
use tracing::info;

pub const CURRENT_SCHEMA_VERSION: i32 = 1;

/// Applies idempotent migrations and configures SQLite DDL.
pub fn initialize_schema(conn: &Connection) -> Result<()> {
    // 1. Pragmas configuration
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        PRAGMA auto_vacuum = INCREMENTAL;
        "#,
    )?;

    let mut stmt = conn.prepare("PRAGMA user_version;")?;
    let version: i32 = stmt.query_row([], |r| r.get(0))?;

    if version < 1 {
        info!("Applying SQLite DDL migrations to version 1");
        conn.execute_batch(
            r#"
            -- Monitored files metadata & Git-OID change detection
            CREATE TABLE IF NOT EXISTS files (
                file_id INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT NOT NULL UNIQUE,
                mtime_ns INTEGER NOT NULL,
                size_bytes INTEGER NOT NULL,
                git_oid TEXT NOT NULL,
                language TEXT NOT NULL,
                indexed_at INTEGER NOT NULL
            );

            -- Extracted code symbols
            CREATE TABLE IF NOT EXISTS symbols (
                symbol_id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_id INTEGER NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
                fqsn TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                kind TEXT NOT NULL,
                visibility TEXT NOT NULL,
                line_start INTEGER NOT NULL,
                line_end INTEGER NOT NULL,
                cyclomatic_complexity INTEGER NOT NULL DEFAULT 1,
                signature_clean TEXT NOT NULL,
                docstring_clean TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_symbols_file_covering 
            ON symbols(file_id, symbol_id, fqsn, kind);

            -- Graph edges with WITHOUT ROWID for 35-50% disk reduction & zero double-lookup
            CREATE TABLE IF NOT EXISTS edges (
                caller_id INTEGER NOT NULL,
                callee_id INTEGER NOT NULL,
                edge_kind TEXT NOT NULL,
                weight REAL NOT NULL DEFAULT 1.0,
                PRIMARY KEY (caller_id, callee_id, edge_kind)
            ) WITHOUT ROWID;

            -- Covering index for incoming dependency / caller queries (Index-Only Scan)
            CREATE INDEX IF NOT EXISTS idx_edges_incoming_covering 
            ON edges(callee_id, caller_id, edge_kind, weight);

            -- Full-Text Search on clean symbols
            CREATE VIRTUAL TABLE IF NOT EXISTS fts_symbols USING fts5(
                fqsn,
                name,
                docstring_clean,
                tokenize=trigram
            );

            PRAGMA user_version = 1;
            "#,
        )?;
    }

    Ok(())
}
