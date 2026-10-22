use rusqlite::{Connection, Result};
use tracing::info;

pub const CURRENT_SCHEMA_VERSION: i32 = 5;

const IMMUTABLE_GENERATION_TABLES: &[&str] = &[
    "generation_files",
    "generation_symbols",
    "generation_edges",
    "inventory_files",
    "facts",
    "evidence",
    "relations",
];

/// Applies idempotent migrations and configures SQLite DDL.
pub fn initialize_schema(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare("PRAGMA user_version;")?;
    let mut version: i32 = stmt.query_row([], |r| r.get(0))?;
    drop(stmt);

    if version > CURRENT_SCHEMA_VERSION {
        return Err(rusqlite::Error::InvalidQuery);
    }

    // Check the version before pragmas that can change the database or create sidecars.
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        PRAGMA auto_vacuum = INCREMENTAL;
        "#,
    )?;

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
                caller_id INTEGER NOT NULL REFERENCES symbols(symbol_id) ON DELETE CASCADE,
                callee_id INTEGER NOT NULL REFERENCES symbols(symbol_id) ON DELETE CASCADE,
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

            PRAGMA user_version = 2;
            "#,
        )?;
        version = 2;
    }

    if version == 1 {
        info!("Migrating SQLite cache from schema 1 to 2");
        conn.execute_batch(
            r#"
            BEGIN IMMEDIATE;
            DELETE FROM edges
              WHERE caller_id NOT IN (SELECT symbol_id FROM symbols)
                 OR callee_id NOT IN (SELECT symbol_id FROM symbols);
            ALTER TABLE edges RENAME TO edges_v1;
            CREATE TABLE edges (
                caller_id INTEGER NOT NULL REFERENCES symbols(symbol_id) ON DELETE CASCADE,
                callee_id INTEGER NOT NULL REFERENCES symbols(symbol_id) ON DELETE CASCADE,
                edge_kind TEXT NOT NULL,
                weight REAL NOT NULL DEFAULT 1.0,
                PRIMARY KEY (caller_id, callee_id, edge_kind)
            ) WITHOUT ROWID;
            INSERT INTO edges SELECT caller_id, callee_id, edge_kind, weight FROM edges_v1;
            DROP TABLE edges_v1;
            CREATE INDEX idx_edges_incoming_covering
              ON edges(callee_id, caller_id, edge_kind, weight);
            PRAGMA user_version = 2;
            COMMIT;
            "#,
        )?;
        version = 2;
    }

    if version == 2 {
        info!("Migrating SQLite cache from schema 2 to 3");
        conn.execute_batch(
            r#"
            BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS scan_runs (
                scan_id TEXT PRIMARY KEY,
                state TEXT NOT NULL CHECK (state IN ('running', 'complete', 'partial', 'failed')),
                diagnostics_json TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS scan_state (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                active_scan_id TEXT,
                latest_attempt_id TEXT
            );
            INSERT OR IGNORE INTO scan_state(singleton, active_scan_id, latest_attempt_id)
            VALUES (1, NULL, NULL);
            PRAGMA user_version = 3;
            COMMIT;
            "#,
        )?;
        version = 3;
    }

    if version == 3 {
        info!("Migrating SQLite cache from schema 3 to 4");
        conn.execute_batch(
            r#"
            BEGIN IMMEDIATE;
            ALTER TABLE scan_runs RENAME TO scan_runs_v3;
            CREATE TABLE scan_runs (
                scan_id TEXT PRIMARY KEY,
                state TEXT NOT NULL CHECK (state IN ('running', 'complete', 'partial', 'failed', 'superseded')),
                diagnostics_json TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            INSERT INTO scan_runs SELECT scan_id, state, diagnostics_json, created_at FROM scan_runs_v3;
            DROP TABLE scan_runs_v3;
            -- Previous schema runs have no generation-qualified rows. Keep them
            -- as diagnostic history, but never expose them as verified snapshots.
            UPDATE scan_runs SET state='superseded';
            UPDATE scan_state SET active_scan_id=NULL;

            CREATE TABLE generation_files (
                scan_id TEXT NOT NULL REFERENCES scan_runs(scan_id) ON DELETE CASCADE,
                file_id TEXT NOT NULL,
                path TEXT NOT NULL,
                content_sha256 TEXT,
                category TEXT NOT NULL,
                support TEXT NOT NULL,
                PRIMARY KEY (scan_id, file_id),
                UNIQUE (scan_id, path)
            ) WITHOUT ROWID;
            CREATE TABLE generation_symbols (
                scan_id TEXT NOT NULL,
                symbol_id TEXT NOT NULL,
                file_id TEXT NOT NULL,
                fqsn TEXT NOT NULL,
                name TEXT NOT NULL,
                kind TEXT NOT NULL,
                visibility TEXT NOT NULL,
                line_start INTEGER,
                line_end INTEGER,
                signature TEXT,
                PRIMARY KEY (scan_id, symbol_id),
                UNIQUE (scan_id, fqsn),
                FOREIGN KEY (scan_id, file_id) REFERENCES generation_files(scan_id, file_id) ON DELETE CASCADE
            ) WITHOUT ROWID;
            CREATE TABLE generation_edges (
                scan_id TEXT NOT NULL,
                caller_id TEXT NOT NULL,
                callee_id TEXT NOT NULL,
                edge_kind TEXT NOT NULL,
                weight REAL NOT NULL DEFAULT 1.0,
                PRIMARY KEY (scan_id, caller_id, callee_id, edge_kind),
                FOREIGN KEY (scan_id, caller_id) REFERENCES generation_symbols(scan_id, symbol_id) ON DELETE CASCADE,
                FOREIGN KEY (scan_id, callee_id) REFERENCES generation_symbols(scan_id, symbol_id) ON DELETE CASCADE
            ) WITHOUT ROWID;
            CREATE VIRTUAL TABLE generation_fts USING fts5(
                scan_id UNINDEXED, fqsn, name, docstring_clean, tokenize=trigram
            );
            CREATE TABLE inventory_files (
                scan_id TEXT NOT NULL REFERENCES scan_runs(scan_id) ON DELETE CASCADE,
                path TEXT NOT NULL,
                category TEXT NOT NULL,
                support TEXT NOT NULL,
                content_sha256 TEXT,
                excluded_reason TEXT,
                read_error TEXT,
                PRIMARY KEY (scan_id, path)
            ) WITHOUT ROWID;
            CREATE TABLE facts (
                scan_id TEXT NOT NULL REFERENCES scan_runs(scan_id) ON DELETE CASCADE,
                fact_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                attributes_json TEXT NOT NULL,
                evidence_ids_json TEXT NOT NULL,
                PRIMARY KEY (scan_id, fact_id)
            ) WITHOUT ROWID;
            CREATE TABLE evidence (
                scan_id TEXT NOT NULL,
                evidence_id TEXT NOT NULL,
                path TEXT NOT NULL,
                content_sha256 TEXT,
                line_start INTEGER,
                line_end INTEGER,
                extractor TEXT NOT NULL,
                method TEXT NOT NULL,
                PRIMARY KEY (scan_id, evidence_id),
                FOREIGN KEY (scan_id, path) REFERENCES inventory_files(scan_id, path) ON DELETE CASCADE
            ) WITHOUT ROWID;
            CREATE TABLE relations (
                scan_id TEXT NOT NULL,
                relation_id TEXT NOT NULL,
                from_id TEXT NOT NULL,
                to_id TEXT,
                kind TEXT NOT NULL,
                resolution TEXT NOT NULL CHECK (resolution IN ('resolved', 'ambiguous', 'unresolved')),
                candidate_ids_json TEXT NOT NULL,
                evidence_ids_json TEXT NOT NULL,
                PRIMARY KEY (scan_id, relation_id),
                FOREIGN KEY (scan_id, from_id) REFERENCES generation_symbols(scan_id, symbol_id) ON DELETE CASCADE,
                FOREIGN KEY (scan_id, to_id) REFERENCES generation_symbols(scan_id, symbol_id) ON DELETE CASCADE
            ) WITHOUT ROWID;
            CREATE TABLE repository_state (
                repository_key TEXT PRIMARY KEY,
                active_scan_id TEXT REFERENCES scan_runs(scan_id),
                latest_attempt_id TEXT REFERENCES scan_runs(scan_id)
            ) WITHOUT ROWID;
            INSERT INTO repository_state(repository_key, active_scan_id, latest_attempt_id)
              SELECT 'default', NULL, latest_attempt_id FROM scan_state WHERE singleton=1;
            PRAGMA user_version = 4;
            COMMIT;
            "#,
        )?;
        version = 4;
    }

    if version == 4 {
        info!("Migrating SQLite cache from schema 4 to 5");
        conn.execute_batch(
            r#"
            BEGIN IMMEDIATE;
            CREATE TABLE edge_occurrences (
                occurrence_id TEXT PRIMARY KEY,
                caller_fqsn TEXT NOT NULL,
                candidate_fqsns_json TEXT NOT NULL,
                callee_name TEXT NOT NULL,
                callee_expression TEXT NOT NULL,
                edge_kind TEXT NOT NULL,
                resolution TEXT NOT NULL CHECK (resolution IN ('resolved', 'ambiguous', 'unresolved')),
                line_start INTEGER NOT NULL,
                line_end INTEGER NOT NULL,
                column_start INTEGER NOT NULL,
                column_end INTEGER NOT NULL,
                content_sha256 TEXT NOT NULL,
                method TEXT NOT NULL
            ) WITHOUT ROWID;
            PRAGMA user_version = 5;
            COMMIT;
            "#,
        )?;
    }

    // Published generations are append-only. A generation may transition to
    // `superseded` only as part of retention, after which its rows can be
    // deleted with the scan_runs cascade. All other writes to a complete
    // generation are rejected by SQLite itself, including direct SQL callers.
    for table in IMMUTABLE_GENERATION_TABLES {
        for operation in ["INSERT", "UPDATE", "DELETE"] {
            let trigger = format!("guard_{table}_{}", operation.to_ascii_lowercase());
            let immutable_guard = match operation {
                "INSERT" => "EXISTS (SELECT 1 FROM scan_runs WHERE scan_id = NEW.scan_id AND state = 'complete')".to_string(),
                "UPDATE" => "EXISTS (SELECT 1 FROM scan_runs WHERE scan_id = OLD.scan_id AND state = 'complete') \
                    OR EXISTS (SELECT 1 FROM scan_runs WHERE scan_id = NEW.scan_id AND state = 'complete')".to_string(),
                _ => "EXISTS (SELECT 1 FROM scan_runs WHERE scan_id = OLD.scan_id AND state = 'complete')".to_string(),
            };
            let sql = format!(
                "CREATE TRIGGER IF NOT EXISTS {trigger} BEFORE {operation} ON {table} \
                 WHEN {immutable_guard} \
                 BEGIN SELECT RAISE(ABORT, 'published scan generation is immutable'); END;"
            );
            conn.execute_batch(&sql)?;
        }
    }

    Ok(())
}
