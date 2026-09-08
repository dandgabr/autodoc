use std::path::{Path, PathBuf};
use crate::errors::AutoDocError;

/// Enforces path confinement within the designated workspace root.
/// Rejects path traversal attempts (e.g. "../../../etc/passwd").
pub fn validate_and_confine_path(root: &Path, target: &Path) -> Result<PathBuf, AutoDocError> {
    let canonical_root = root.canonicalize().map_err(|_| AutoDocError::RepositoryNotFound {
        path: root.display().to_string(),
    })?;

    let full_target = if target.is_absolute() {
        target.to_path_buf()
    } else {
        root.join(target)
    };

    let canonical_target = full_target.canonicalize().map_err(|_| AutoDocError::CanonicalizationFailed {
        path: full_target.display().to_string(),
    })?;

    if !canonical_target.starts_with(&canonical_root) {
        return Err(AutoDocError::AccessDeniedPathEscape {
            path: canonical_target.display().to_string(),
        });
    }

    Ok(canonical_target)
}

/// Normalizes absolute OS host paths (e.g. /home/user/... or C:\\Users\\user\\...)
/// into repo-relative or sanitized paths to prevent host environment leaks.
pub fn sanitize_host_path(path: &str, repo_root: &Path) -> String {
    let repo_root_str = repo_root.to_string_lossy();
    if path.starts_with(repo_root_str.as_ref()) {
        let relative = path.trim_start_matches(repo_root_str.as_ref()).trim_start_matches('/').trim_start_matches('\\');
        return relative.to_string();
    }

    // Replace typical unix and windows home directories
    let sanitized = if path.starts_with("/home/") || path.starts_with("/Users/") {
        let parts: Vec<&str> = path.split('/').collect();
        if parts.len() > 2 {
            format!("[USER_HOME]/{}", parts[3..].join("/"))
        } else {
            "[USER_HOME]".to_string()
        }
    } else {
        path.to_string()
    };

    sanitized
}
