use std::path::{Path, PathBuf};
use std::sync::Arc;
use ignore::WalkBuilder;
use rayon::prelude::*;
use crate::cache::StorageEngine;
use crate::errors::AutoDocError;
use crate::sanitizer::SanitizerEngine;

pub struct ScanResult {
    pub total_files: usize,
    pub total_loc: usize,
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
                // Filter out non-code or known noisy binaries
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    if matches!(ext, "rs" | "ts" | "js" | "py" | "java" | "c" | "cpp" | "h" | "hpp" | "cs" | "go" | "php" | "rb" | "sql") {
                        candidate_files.push(path.to_path_buf());
                    }
                }
            }
        }

        let total_files = candidate_files.len();

        // Process files in parallel using Rayon threadpool
        let processed: Vec<(usize, String)> = candidate_files
            .par_iter()
            .filter_map(|file_path| {
                if let Ok(content) = std::fs::read_to_string(file_path) {
                    let sanitized = self.sanitizer.sanitize(&content);
                    let loc = sanitized.lines().count();
                    let ext = file_path.extension().and_then(|e| e.to_str()).unwrap_or("unknown").to_string();

                    // Insert or update file in SQLite storage
                    let metadata = std::fs::metadata(file_path).ok()?;
                    let mtime = metadata.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos() as i64;
                    let size = metadata.len() as i64;
                    let rel_path = file_path.strip_prefix(&self.root).unwrap_or(file_path).to_string_lossy().to_string();

                    let git_oid = format!("{:016x}", twox_hash::XxHash64::oneshot(0, content.as_bytes()));
                    let _ = self.storage.insert_file(&rel_path, mtime, size, &git_oid, &ext);

                    Some((loc, ext))
                } else {
                    None
                }
            })
            .collect();

        let total_loc: usize = processed.iter().map(|(loc, _)| *loc).sum();
        let mut languages: Vec<String> = processed.into_iter().map(|(_, lang)| lang).collect();
        languages.sort();
        languages.dedup();

        Ok(ScanResult {
            total_files,
            total_loc,
            scanned_languages: languages,
        })
    }
}
