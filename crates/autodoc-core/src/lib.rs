use std::panic::{catch_unwind, AssertUnwindSafe};
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use tracing::{error, info};

pub mod cache;
pub mod errors;
pub mod graph;
pub mod parser;
pub mod sanitizer;
pub mod scanner;
pub mod telemetry;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[napi(object)]
#[derive(Debug, Serialize, Deserialize)]
pub struct PingResponse {
    pub trace_id: String,
    pub status: String,
    pub version: String,
    pub rustc_version: String,
    pub timestamp_ms: i64,
}

#[napi(object)]
#[derive(Debug, Serialize, Deserialize)]
pub struct SanitizeResult {
    pub sanitized_text: String,
    pub redaction_count: u32,
}

/// Initializes diagnostic tracing subscribers (stderr only).
#[napi]
pub fn init_logger() {
    telemetry::init_telemetry();
    info!("AutoDoc native telemetry initialized (logging strictly directed to stderr)");
}

/// Ping FFI Bridge sanity check passing Trace ID and ensuring memory boundary safety.
#[napi]
pub fn ping(trace_id: String) -> napi::Result<PingResponse> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        PingResponse {
            trace_id,
            status: "OK".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            rustc_version: "1.98.0".to_string(),
            timestamp_ms: now,
        }
    }));

    match result {
        Ok(res) => Ok(res),
        Err(payload) => {
            let panic_msg = if let Some(s) = payload.downcast_ref::<&str>() {
                s.to_string()
            } else if let Some(s) = payload.downcast_ref::<String>() {
                s.clone()
            } else {
                "Unknown panic payload".to_string()
            };
            error!("Panic caught in ping FFI boundary: {}", panic_msg);
            Err(errors::AutoDocError::FfiPanic { reason: panic_msg }.into())
        }
    }
}

/// Native sanitization API combining Secret and PII redaction.
#[napi]
pub fn sanitize_content(content: String) -> napi::Result<SanitizeResult> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let engine = sanitizer::SanitizerEngine::new();
        let sanitized = engine.sanitize(&content);
        let redactions = sanitized.matches("[REDACTED_").count() as u32;

        SanitizeResult {
            sanitized_text: sanitized,
            redaction_count: redactions,
        }
    }));

    match result {
        Ok(res) => Ok(res),
        Err(payload) => {
            let msg = if let Some(s) = payload.downcast_ref::<&str>() {
                s.to_string()
            } else {
                "Panic during content sanitization".to_string()
            };
            Err(errors::AutoDocError::FfiPanic { reason: msg }.into())
        }
    }
}

/// Native Prompt Guard wrapping untrusted code in semantic delimiters.
#[napi]
pub fn wrap_untrusted(content: String, origin: String, file: String, symbol: String) -> String {
    sanitizer::wrap_untrusted_code(&content, &origin, &file, &symbol)
}

/// Helper function to explicitly test panic interception via catch_unwind.
#[napi]
pub fn trigger_panic_test(reason: String) -> napi::Result<String> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        panic!("Controlled panic for testing: {}", reason);
    }));

    match result {
        Ok(_) => Ok("Unexpected success".to_string()),
        Err(payload) => {
            let panic_msg = if let Some(s) = payload.downcast_ref::<&str>() {
                s.to_string()
            } else if let Some(s) = payload.downcast_ref::<String>() {
                s.clone()
            } else {
                "Unknown panic payload".to_string()
            };
            Err(errors::AutoDocError::FfiPanic { reason: panic_msg }.into())
        }
    }
}

#[napi(object)]
#[derive(Debug, Serialize, Deserialize)]
pub struct NativeScanResult {
    pub total_files: u32,
    pub total_loc: u32,
    pub total_symbols: u32,
    pub total_edges: u32,
    pub languages: Vec<String>,
    pub cache_path: String,
}

/// Recursively scans a repository using parallel Rayon workers and writes to SQLite WAL cache.
#[napi]
pub fn scan_repository_native(repo_path: String) -> napi::Result<NativeScanResult> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let path = std::path::PathBuf::from(&repo_path);
        let storage = std::sync::Arc::new(cache::StorageEngine::new(&path)?);
        let sanitizer = std::sync::Arc::new(sanitizer::SanitizerEngine::new());
        let scanner = scanner::RepositoryScanner::new(&path, storage.clone(), sanitizer);
        let report = scanner.scan_repository()?;

        Ok(NativeScanResult {
            total_files: report.total_files as u32,
            total_loc: report.total_loc as u32,
            total_symbols: report.total_symbols as u32,
            total_edges: report.total_edges as u32,
            languages: report.scanned_languages,
            cache_path: storage.db_path().to_string_lossy().to_string(),
        })
    }));

    match result {
        Ok(res) => res,
        Err(payload) => {
            let panic_msg = if let Some(s) = payload.downcast_ref::<&str>() {
                s.to_string()
            } else if let Some(s) = payload.downcast_ref::<String>() {
                s.clone()
            } else {
                "Unknown panic in scan_repository_native".to_string()
            };
            Err(errors::AutoDocError::FfiPanic { reason: panic_msg }.into())
        }
    }
}
