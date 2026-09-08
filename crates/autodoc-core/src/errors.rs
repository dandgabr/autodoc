use thiserror::Error;

/// Precise taxonomy of AutoDoc errors for diagnostic tracing and reporting.
#[derive(Debug, Error)]
pub enum AutoDocError {
    #[error("AUTODOC_E101: Repository path does not exist: {path}")]
    RepositoryNotFound { path: String },

    #[error("AUTODOC_E102: Path canonicalization failed: {path}")]
    CanonicalizationFailed { path: String },

    #[error("AUTODOC_E103: Access denied: Path escapes configured workspace root: {path}")]
    AccessDeniedPathEscape { path: String },

    #[error("AUTODOC_E201: SQLite storage error: {detail}")]
    StorageError { detail: String },

    #[error("AUTODOC_E301: AST Parsing failed for file: {path} (Language: {lang})")]
    AstParsingFailed { path: String, lang: String },

    #[error("AUTODOC_E401: NAPI FFI Panic intercepted: {reason}")]
    FfiPanic { reason: String },

    #[error("AUTODOC_E501: Invalid tool argument: {param} - {reason}")]
    InvalidArgument { param: String, reason: String },

    #[error("AUTODOC_E999: Internal error: {0}")]
    Internal(String),
}

impl From<AutoDocError> for napi::Error {
    fn from(err: AutoDocError) -> Self {
        napi::Error::from_reason(err.to_string())
    }
}
