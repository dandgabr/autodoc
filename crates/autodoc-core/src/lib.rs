use std::panic::{catch_unwind, AssertUnwindSafe};
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use tracing::{error, info};

pub mod errors;
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

/// Initializes diagnostic tracing subscribers (stderr only).
#[napi]
pub fn init_logger() {
    telemetry::init_telemetry();
    info!("AutoDoc native telemetry initialized (logging strictly directed to stderr)");
}

/// Ping FFI Bridge sanity check passing Trace ID and ensuring memory boundary safety.
/// Wrapped in catch_unwind to prevent unwinding panics across the C-ABI FFI boundary.
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
