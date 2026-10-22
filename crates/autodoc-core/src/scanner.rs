use crate::cache::StorageEngine;
use crate::errors::AutoDocError;
use crate::inventory::{
    build_inventory_with_options, read_verified_source_with_limit, InventoryCategory, InventoryFile,
};
use crate::sanitizer::SanitizerEngine;
use rayon::prelude::*;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

static SCAN_COUNTER: AtomicU64 = AtomicU64::new(1);

fn next_scan_id() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = SCAN_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("scan-{now:x}-{sequence:x}")
}

pub struct ScanResult {
    pub scan_id: String,
    pub active_scan_id: Option<String>,
    pub total_files: usize,
    pub candidate_files: usize,
    pub files_with_errors: usize,
    pub total_loc: usize,
    pub total_symbols: usize,
    pub total_edges: usize,
    pub scanned_languages: Vec<String>,
    pub analysis_state: String,
    pub coverage_state: String,
    pub diagnostics: Vec<ScanDiagnostic>,
}

/// Resource budgets for one scan. Callers may lower, but never raise, the safe defaults.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ScanOptions {
    pub max_source_bytes: u64,
    pub workers: usize,
    pub queue_capacity: usize,
    pub batch_size: usize,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            max_source_bytes: 4 * 1024 * 1024,
            workers: 4,
            queue_capacity: 16,
            batch_size: 256,
        }
    }
}

impl ScanOptions {
    pub fn validate(self) -> Result<Self, AutoDocError> {
        let defaults = Self::default();
        if self.max_source_bytes == 0
            || self.max_source_bytes > defaults.max_source_bytes
            || self.workers == 0
            || self.workers > defaults.workers
            || self.queue_capacity == 0
            || self.queue_capacity > defaults.queue_capacity
            || self.batch_size == 0
            || self.batch_size > defaults.batch_size
        {
            return Err(AutoDocError::InvalidArgument { param: "scan_options".into(), reason: "budgets must be positive and cannot exceed defaults (4 MiB, 4 workers, queue 16, batch 256)".into() });
        }
        Ok(self)
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ScanDiagnostic {
    pub stage: String,
    pub code: String,
    pub path: Option<String>,
    pub message: String,
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
        self.scan_repository_with_options(ScanOptions::default())
    }

    pub fn scan_repository_with_options(
        &self,
        options: ScanOptions,
    ) -> Result<ScanResult, AutoDocError> {
        let options = options.validate()?;
        if !self.root.is_dir() {
            return Err(AutoDocError::RepositoryNotFound {
                path: self.root.display().to_string(),
            });
        }
        let scan_id = next_scan_id();
        self.storage.begin_scan_attempt(&scan_id)?;
        let staging_storage = match self.storage.new_staging(&scan_id) {
            Ok(storage) => Arc::new(storage),
            Err(error) => {
                let diagnostic = ScanDiagnostic {
                    stage: "staging".into(),
                    code: "STAGING_CREATE_FAILED".into(),
                    path: None,
                    message: error.to_string(),
                };
                self.storage.record_scan_attempt(
                    &scan_id,
                    "failed",
                    &serde_json::to_string(&[diagnostic]).unwrap_or_else(|_| "[]".to_string()),
                )?;
                return Err(error);
            }
        };
        let inventory = build_inventory_with_options(
            &self.root,
            options.max_source_bytes,
            crate::inventory::read_source_limited,
        )
        .map_err(|error| AutoDocError::Internal(format!("Inventory failed: {error}")))?;
        staging_storage.replace_inventory_with_batch_size(
            &scan_id,
            &inventory,
            options.batch_size,
        )?;
        let root = self.root.canonicalize().map_err(|error| {
            AutoDocError::Internal(format!("Repository root canonicalization failed: {error}"))
        })?;
        let diagnostics = Mutex::new(Vec::new());
        for file in &inventory {
            if let Some(error) = &file.read_error {
                diagnostics.lock().unwrap().push(ScanDiagnostic {
                    stage: "inventory".into(),
                    code: if error == "BINARY_CONTENT" {
                        error.clone()
                    } else if error.starts_with("SOURCE_SIZE_LIMIT:") {
                        "SOURCE_SIZE_LIMIT".into()
                    } else {
                        "FILE_READ_FAILED".into()
                    },
                    path: Some(file.path.clone()),
                    message: error.clone(),
                });
            }
        }
        let candidate_files: Vec<&InventoryFile> = inventory
            .iter()
            .filter(|file| {
                file.category == InventoryCategory::Source
                    && file.content_sha256.is_some()
                    && file.read_error.is_none()
            })
            .collect();
        let candidate_count = candidate_files.len();

        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(options.workers)
            .build()
            .map_err(|error| {
                AutoDocError::Internal(format!("Unable to create bounded scan workers: {error}"))
            })?;
        let mut total_loc = 0usize;
        let mut total_symbols = 0usize;
        let mut processed_count = 0usize;
        let mut languages = Vec::new();
        let mut total_edges = 0usize;
        // Process at most queue_capacity files at once; bytes are read inside the bounded worker pool.
        for queue in candidate_files.chunks(options.queue_capacity) {
            let processed: Vec<(usize, String, usize)> = pool.install(|| {
                queue
                    .par_iter()
                    .filter_map(|inventory_file| {
                        let file_path = &inventory_file.path;
                        let expected_hash =
                            inventory_file.content_sha256.as_deref().unwrap_or_default();
                        let bytes = match read_verified_source_with_limit(
                            &root,
                            file_path,
                            expected_hash,
                            options.max_source_bytes,
                        ) {
                            Ok(bytes) => bytes,
                            Err(error) => {
                                let error_text = error.to_string();
                                let code = if error_text.starts_with("STALE_SOURCE") {
                                    "STALE_SOURCE"
                                } else if error_text.starts_with("SOURCE_SIZE_LIMIT") {
                                    "SOURCE_SIZE_LIMIT"
                                } else {
                                    "FILE_READ_FAILED"
                                };
                                diagnostics.lock().unwrap().push(ScanDiagnostic {
                                    stage: "read".into(),
                                    code: code.into(),
                                    path: Some(file_path.clone()),
                                    message: error_text,
                                });
                                return None;
                            }
                        };
                        let content = match String::from_utf8(bytes) {
                            Ok(text) => text,
                            Err(error) => {
                                diagnostics.lock().unwrap().push(ScanDiagnostic {
                                    stage: "read".into(),
                                    code: "BINARY_CONTENT".into(),
                                    path: Some(file_path.clone()),
                                    message: error.to_string(),
                                });
                                return None;
                            }
                        };
                        let loc = content.lines().count();
                        let ext = Path::new(file_path)
                            .extension()
                            .and_then(|e| e.to_str())
                            .unwrap_or("unknown")
                            .to_string();
                        let mtime = inventory_file.modified_ns;
                        let size = inventory_file.size_bytes as i64;
                        let rel_path = file_path.clone();
                        let git_oid = format!(
                            "{:016x}",
                            twox_hash::XxHash64::oneshot(0, content.as_bytes())
                        );

                        // Extract AST symbols and edges using polyglot parser
                        let mut parse_output = crate::parser::parse_file(&content, &rel_path, &ext);
                        if parse_output.analysis_state != "complete" {
                            for diagnostic in &parse_output.diagnostics {
                                diagnostics.lock().unwrap().push(ScanDiagnostic {
                                    stage: "parse".into(),
                                    code: diagnostic.code.clone(),
                                    path: Some(rel_path.clone()),
                                    message: diagnostic.message.clone(),
                                });
                            }
                        }
                        for symbol in &mut parse_output.symbols {
                            symbol.signature = self.sanitizer.sanitize(&symbol.signature);
                            symbol.docstring = symbol
                                .docstring
                                .as_deref()
                                .map(|text| self.sanitizer.sanitize(text));
                        }
                        let symbol_count = parse_output.symbols.len();

                        // Insert or update file and symbols in SQLite storage via batch command
                        if let Err(error) = staging_storage.insert_batch_analysis(
                            &rel_path,
                            mtime,
                            size,
                            &git_oid,
                            &ext,
                            parse_output.symbols,
                        ) {
                            diagnostics.lock().unwrap().push(ScanDiagnostic {
                                stage: "persist".into(),
                                code: "PERSIST_FAILED".into(),
                                path: Some(rel_path),
                                message: error.to_string(),
                            });
                            return None;
                        }

                        Some((loc, ext, symbol_count))
                    })
                    .collect()
            });

            total_loc += processed.iter().map(|(loc, _, _)| *loc).sum::<usize>();
            total_symbols += processed.iter().map(|(_, _, sc)| *sc).sum::<usize>();
            processed_count += processed.len();
            languages.extend(processed.iter().map(|(_, lang, _)| lang.clone()));
        }

        // Resolve edges only after every file's symbols have been staged, preserving cross-file calls.
        // Re-parse in bounded queues to avoid retaining the repository's complete edge set in memory.
        let mut edge_batch = Vec::with_capacity(options.batch_size);
        for queue in candidate_files.chunks(options.queue_capacity) {
            for inventory_file in queue {
                let file_path = &inventory_file.path;
                let expected_hash = inventory_file.content_sha256.as_deref().unwrap_or_default();
                let bytes = match read_verified_source_with_limit(
                    &root,
                    file_path,
                    expected_hash,
                    options.max_source_bytes,
                ) {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        diagnostics.lock().unwrap().push(ScanDiagnostic {
                            stage: "read".into(),
                            code: if error.to_string().starts_with("STALE_SOURCE") {
                                "STALE_SOURCE"
                            } else if error.to_string().starts_with("SOURCE_SIZE_LIMIT") {
                                "SOURCE_SIZE_LIMIT"
                            } else {
                                "FILE_READ_FAILED"
                            }
                            .into(),
                            path: Some(file_path.clone()),
                            message: error.to_string(),
                        });
                        continue;
                    }
                };
                let content = match String::from_utf8(bytes) {
                    Ok(text) => text,
                    Err(error) => {
                        diagnostics.lock().unwrap().push(ScanDiagnostic {
                            stage: "read".into(),
                            code: "BINARY_CONTENT".into(),
                            path: Some(file_path.clone()),
                            message: error.to_string(),
                        });
                        continue;
                    }
                };
                let ext = Path::new(file_path)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("unknown");
                for edge in crate::parser::parse_file(&content, file_path, ext).edges {
                    edge_batch.push(edge);
                    if edge_batch.len() == options.batch_size {
                        match staging_storage.bulk_resolve_edges(std::mem::take(&mut edge_batch)) {
                            Ok(count) => total_edges += count,
                            Err(error) => diagnostics.lock().unwrap().push(ScanDiagnostic {
                                stage: "resolve".into(),
                                code: "EDGE_RESOLUTION_FAILED".into(),
                                path: None,
                                message: error.to_string(),
                            }),
                        }
                        edge_batch = Vec::with_capacity(options.batch_size);
                    }
                }
            }
        }
        if !edge_batch.is_empty() {
            match staging_storage.bulk_resolve_edges(edge_batch) {
                Ok(count) => total_edges += count,
                Err(error) => diagnostics.lock().unwrap().push(ScanDiagnostic {
                    stage: "resolve".into(),
                    code: "EDGE_RESOLUTION_FAILED".into(),
                    path: None,
                    message: error.to_string(),
                }),
            }
        }
        let mut diagnostics = diagnostics.into_inner().unwrap_or_default();
        languages.sort();
        languages.dedup();
        let has_blocking_diagnostics = diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code != "AST_UNSUPPORTED");
        if !has_blocking_diagnostics {
            let current_paths = candidate_files
                .iter()
                .map(|file| file.path.clone())
                .collect();
            if let Err(error) = staging_storage.reconcile_files(current_paths) {
                diagnostics.push(ScanDiagnostic {
                    stage: "reconcile".into(),
                    code: "RECONCILE_FAILED".into(),
                    path: None,
                    message: error.to_string(),
                });
            }
        }
        let has_blocking_diagnostics = diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code != "AST_UNSUPPORTED");
        let analysis_state = if !has_blocking_diagnostics {
            "complete"
        } else if processed_count == 0 {
            "failed"
        } else {
            "partial"
        }
        .to_string();
        let files_with_errors = diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code != "AST_UNSUPPORTED")
            .filter_map(|diagnostic| diagnostic.path.as_deref())
            .collect::<std::collections::HashSet<_>>()
            .len();
        let diagnostics_json =
            serde_json::to_string(&diagnostics).unwrap_or_else(|_| "[]".to_string());
        if analysis_state == "complete" {
            if let Err(error) =
                self.storage
                    .publish_snapshot_from(&staging_storage, &scan_id, &diagnostics_json)
            {
                diagnostics.push(ScanDiagnostic {
                    stage: "publish".into(),
                    code: "SNAPSHOT_PUBLISH_FAILED".into(),
                    path: None,
                    message: error.to_string(),
                });
                self.storage.record_scan_attempt(
                    &scan_id,
                    "failed",
                    &serde_json::to_string(&diagnostics).unwrap_or_else(|_| "[]".to_string()),
                )?;
            }
        } else {
            self.storage
                .record_scan_attempt(&scan_id, &analysis_state, &diagnostics_json)?;
        }
        let active_scan_id = self.storage.active_scan_id()?;
        let final_state = if active_scan_id.as_deref() == Some(scan_id.as_str()) {
            "complete"
        } else if analysis_state == "failed"
            || diagnostics
                .iter()
                .any(|d| d.code == "SNAPSHOT_PUBLISH_FAILED")
        {
            "failed"
        } else {
            "partial"
        }
        .to_string();
        let coverage_state = if final_state != "complete"
            || diagnostics.iter().any(|d| d.code == "AST_UNSUPPORTED")
        {
            "partial"
        } else {
            "complete"
        }
        .to_string();

        Ok(ScanResult {
            scan_id,
            active_scan_id,
            total_files: processed_count,
            candidate_files: candidate_count,
            files_with_errors,
            total_loc,
            total_symbols,
            total_edges,
            scanned_languages: languages,
            analysis_state: final_state,
            coverage_state,
            diagnostics,
        })
    }
}
