pub mod entropy;
pub mod validators;
pub mod path_guard;
pub mod pii_registry;
pub mod secret_scanner;
pub mod prompt_guard;

pub use entropy::{correlation_hash, shannon_entropy};
pub use path_guard::{sanitize_host_path, validate_and_confine_path};
pub use pii_registry::{PiiCategory, PiiRegistry};
pub use prompt_guard::wrap_untrusted_code;
pub use secret_scanner::SecretScanner;

/// Unified Sanitizer Engine orchestrating secret scanning, PII redaction, and path normalization.
pub struct SanitizerEngine {
    pii_registry: PiiRegistry,
    secret_scanner: SecretScanner,
}

impl Default for SanitizerEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl SanitizerEngine {
    pub fn new() -> Self {
        Self {
            pii_registry: PiiRegistry::new(),
            secret_scanner: SecretScanner::new(),
        }
    }

    pub fn pii_registry_mut(&mut self) -> &mut PiiRegistry {
        &mut self.pii_registry
    }

    pub fn secret_scanner_mut(&mut self) -> &mut SecretScanner {
        &mut self.secret_scanner
    }

    /// Redacts both secrets and PII in input text in a single unified pipeline.
    pub fn sanitize(&self, input: &str) -> String {
        let no_secrets = self.secret_scanner.redact_secrets(input);
        self.pii_registry.sanitize_text(&no_secrets)
    }
}
