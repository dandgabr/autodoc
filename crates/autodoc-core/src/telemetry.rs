use std::sync::Once;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

static INIT: Once = Once::new();

/// Initializes structured logging to stderr.
/// Stdio MCP servers rely on clean stdout for JSON-RPC 2.0 messages.
/// Contaminating stdout with logs corrupts communication and breaks clients.
pub fn init_telemetry() {
    INIT.call_once(|| {
        let filter = EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new("info,autodoc_core=debug"));

        // Direct all diagnostic events strictly to stderr
        let stderr_layer = fmt::layer()
            .with_writer(std::io::stderr)
            .with_ansi(true)
            .with_target(true)
            .with_thread_ids(true);

        tracing_subscriber::registry()
            .with(filter)
            .with(stderr_layer)
            .init();
    });
}
