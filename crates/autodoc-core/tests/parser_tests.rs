use autodoc_core::parser::parse_file;
use autodoc_core::cache::StorageEngine;
use autodoc_core::sanitizer::SanitizerEngine;
use autodoc_core::scanner::RepositoryScanner;
use tempfile::tempdir;
use std::sync::Arc;

#[test]
fn test_typescript_ast_parsing() {
    let code = r#"
    export interface GameSession {
        id: string;
        players: number;
    }

    export class SessionManager {
        public startSession(id: string): boolean {
            if (id.length === 0) {
                return false;
            }
            this.broadcastStart(id);
            return true;
        }

        private broadcastStart(id: string): void {
            console.log("Started: " + id);
        }
    }
    "#;

    let output = parse_file(code, "src/session.ts", "ts");
    assert!(!output.symbols.is_empty(), "Should extract TypeScript symbols");
    
    let names: Vec<&str> = output.symbols.iter().map(|s| s.name.as_str()).collect();
    assert!(names.contains(&"GameSession"), "Should contain GameSession interface");
    assert!(names.contains(&"SessionManager"), "Should contain SessionManager class");
    assert!(names.contains(&"startSession"), "Should contain startSession method");
    
    assert!(!output.edges.is_empty(), "Should extract call edges");
}

#[test]
fn test_rust_ast_parsing() {
    let code = r#"
    pub struct GameEngine {
        tick: u64,
    }

    pub trait EngineLifecycle {
        fn initialize(&mut self);
    }

    pub fn start_game() -> bool {
        let mut engine = GameEngine { tick: 0 };
        engine.initialize();
        true
    }
    "#;

    let output = parse_file(code, "src/engine.rs", "rs");
    assert!(!output.symbols.is_empty(), "Should extract Rust symbols");
    
    let names: Vec<&str> = output.symbols.iter().map(|s| s.name.as_str()).collect();
    assert!(names.contains(&"GameEngine"), "Should contain GameEngine struct");
    assert!(names.contains(&"EngineLifecycle"), "Should contain EngineLifecycle trait");
    assert!(names.contains(&"start_game"), "Should contain start_game function");
}

#[test]
fn test_python_ast_parsing() {
    let code = r#"
    class PlayerService:
        def get_profile(self, user_id: str):
            if not user_id:
                return None
            return self.load_db(user_id)
            
        def load_db(self, user_id: str):
            pass
    "#;

    let output = parse_file(code, "services/player.py", "py");
    assert!(!output.symbols.is_empty(), "Should extract Python symbols");
    
    let names: Vec<&str> = output.symbols.iter().map(|s| s.name.as_str()).collect();
    assert!(names.contains(&"PlayerService"));
    assert!(names.contains(&"get_profile"));
}

#[test]
fn test_sql_and_heuristics_parsing() {
    let sql_code = r#"
    CREATE TABLE users (
        id VARCHAR(36) PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    "#;

    let output = parse_file(sql_code, "migrations/001_users.sql", "sql");
    assert!(!output.symbols.is_empty());
    assert_eq!(output.symbols[0].name, "users");
    assert_eq!(output.symbols[0].kind, "table");
}

#[test]
fn test_scanner_end_to_end_symbol_extraction() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    // Create a mock multi-file project
    let src_dir = root.join("src");
    std::fs::create_dir_all(&src_dir).unwrap();

    std::fs::write(
        src_dir.join("main.ts"),
        r#"
        export class Server {
            start() {
                this.initRoutes();
            }
            initRoutes() {}
        }
        "#,
    ).unwrap();

    std::fs::write(
        src_dir.join("helper.py"),
        r#"
        def calculate_score(val):
            if val > 10:
                return val * 2
            return val
        "#,
    ).unwrap();

    let storage = Arc::new(StorageEngine::new(root).unwrap());
    let sanitizer = Arc::new(SanitizerEngine::new());
    let scanner = RepositoryScanner::new(root, storage.clone(), sanitizer);

    let res = scanner.scan_repository().unwrap();
    assert_eq!(res.total_files, 2);
    assert!(res.total_loc > 0);
    assert!(res.total_symbols >= 3, "Expected at least 3 symbols, got {}", res.total_symbols);
}
