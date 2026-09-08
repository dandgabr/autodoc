use std::path::{Path, PathBuf};
use std::sync::Arc;
use ignore::WalkBuilder;
use rayon::prelude::*;
use crate::cache::StorageEngine;
use crate::errors::AutoDocError;
use crate::parser::ExtractedEdge;
use crate::sanitizer::SanitizerEngine;

pub struct ScanResult {
    pub total_files: usize,
    pub total_loc: usize,
    pub total_symbols: usize,
    pub total_edges: usize,
    pub scanned_languages: Vec<String>,
}

pub struct RepositoryScanner {
    root: PathBuf,
    storage: Arc<StorageEngine>,
    sanitizer: Arc<SanitizerEngine>,
}

impl RepositoryScanner {
    pub fn new(root: &Path, storage: Arc<StorageEngine>, sanitizer: Arc<SanitizerEngine>) -> Self {
        Self {
            root: root.to_path_buf(),
            storage,
            sanitizer,
        }
    }

    /// Recursively discovers files obeying .gitignore, binary exclusions and symlink safety.
    /// Extracts AST symbols and call-graph edges across the Top 20 TIOBE languages.
    pub fn scan_repository(&self) -> Result<ScanResult, AutoDocError> {
        let mut builder = WalkBuilder::new(&self.root);
        builder
            .hidden(true)
            .parents(true)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .follow_links(false);

        let walker = builder.build();
        let mut candidate_files = Vec::new();

        for entry in walker.flatten() {
            if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                let path = entry.path();
                // Filter out non-code or known noisy binaries, supporting Top 20 TIOBE
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    if matches!(
                        ext,
                        "rs" | "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "py" | "pyi"
                            | "java" | "c" | "cpp" | "cc" | "cxx" | "h" | "hpp" | "cs"
                            | "go" | "php" | "rb" | "sql" | "kt" | "kts" | "swift" | "r"
                            | "R" | "f" | "f90" | "f95" | "pas" | "dpr" | "m" | "s"
                            | "asm" | "pl" | "pm" | "vb" | "sh" | "bash"
                    ) {
                        candidate_files.push(path.to_path_buf());
                    }
                }
            }
        }

        let total_files = candidate_files.len();

        // Process files in parallel using Rayon threadpool
        let processed: Vec<(usize, String, usize, Vec<ExtractedEdge>)> = candidate_files
            .par_iter()
            .filter_map(|file_path| {
                if let Ok(content) = std::fs::read_to_string(file_path) {
                    let sanitized = self.sanitizer.sanitize(&content);
                    let loc = sanitized.lines().count();
                    let ext = file_path.extension().and_then(|e| e.to_str()).unwrap_or("unknown").to_string();

                    let metadata = std::fs::metadata(file_path).ok()?;
                    let mtime = metadata.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos() as i64;
                    let size = metadata.len() as i64;
                    let rel_path = file_path.strip_prefix(&self.root).unwrap_or(file_path).to_string_lossy().to_string();
                    let git_oid = format!("{:016x}", twox_hash::XxHash64::oneshot(0, content.as_bytes()));

                    // Extract AST symbols and edges using polyglot parser
                    let parse_output = crate::parser::parse_file(&sanitized, &rel_path, &ext);
                    let symbol_count = parse_output.symbols.len();

                    // Insert or update file and symbols in SQLite storage via batch command
                    let _ = self.storage.insert_batch_analysis(
                        &rel_path,
                        mtime,
                        size,
                        &git_oid,
                        &ext,
                        parse_output.symbols,
                    );

                    Some((loc, ext, symbol_count, parse_output.edges))
                } else {
                    None
                }
            })
            .collect();

        let total_loc: usize = processed.iter().map(|(loc, _, _, _)| *loc).sum();
        let total_symbols: usize = processed.iter().map(|(_, _, sc, _)| *sc).sum();

        let mut languages: Vec<String> = processed.iter().map(|(_, lang, _, _)| lang.clone()).collect();
        languages.sort();
        languages.dedup();

        // Flatten all extracted raw edges and bulk resolve caller/callee IDs
        let all_edges: Vec<ExtractedEdge> = processed.into_iter().flat_map(|(_, _, _, edges)| edges).collect();
        let total_edges = self.storage.bulk_resolve_edges(all_edges).unwrap_or(0);

        Ok(ScanResult {
            total_files,
            total_loc,
            total_symbols,
            total_edges,
            scanned_languages: languages,
        })
    }
}
