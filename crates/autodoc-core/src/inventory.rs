use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::CString;
use std::fs::File;
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd};
use std::path::{Component, Path};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InventoryCategory {
    Source,
    Markup,
    Style,
    Manifest,
    Infra,
    Docs,
    Asset,
    Other,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InventorySupport {
    Ast,
    Heuristic,
    Metadata,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryFile {
    pub path: String,
    pub category: InventoryCategory,
    pub support: InventorySupport,
    pub content_sha256: Option<String>,
    pub excluded_reason: Option<String>,
    pub read_error: Option<String>,
    pub size_bytes: u64,
    pub modified_ns: i64,
}

fn source_extensions() -> &'static [&'static str] {
    &[
        "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "pyi", "java", "c", "cpp", "cc", "cxx",
        "h", "hpp", "cs", "go", "php", "rb", "sql", "kt", "kts", "swift", "r", "R", "f", "f90",
        "f95", "pas", "dpr", "m", "s", "asm", "pl", "pm", "vb", "sh", "bash",
    ]
}

fn classify(path: &Path) -> (InventoryCategory, InventorySupport, bool) {
    let name = path
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let ext = path.extension().and_then(|v| v.to_str()).unwrap_or("");
    if source_extensions().contains(&ext) || ext == "prisma" {
        let ast = matches!(
            ext,
            "rs" | "ts"
                | "tsx"
                | "js"
                | "jsx"
                | "mjs"
                | "cjs"
                | "py"
                | "go"
                | "java"
                | "c"
                | "h"
                | "cpp"
                | "cc"
        );
        return (
            InventoryCategory::Source,
            if ast {
                InventorySupport::Ast
            } else {
                InventorySupport::Heuristic
            },
            true,
        );
    }
    if matches!(ext, "html" | "htm" | "vue" | "svelte") {
        return (InventoryCategory::Markup, InventorySupport::Heuristic, true);
    }
    if matches!(ext, "css" | "scss" | "sass" | "less") {
        return (InventoryCategory::Style, InventorySupport::Heuristic, true);
    }
    if matches!(
        name.as_str(),
        "package.json"
            | "cargo.toml"
            | "go.mod"
            | "pyproject.toml"
            | "requirements.txt"
            | "pom.xml"
            | "composer.json"
            | "gemfile"
            | "pnpm-workspace.yaml"
            | "lerna.json"
    ) || matches!(ext, "lock")
    {
        return (
            InventoryCategory::Manifest,
            InventorySupport::Heuristic,
            true,
        );
    }
    if name == "dockerfile"
        || name.starts_with("dockerfile.")
        || matches!(
            name.as_str(),
            "docker-compose.yml"
                | "docker-compose.yaml"
                | "compose.yml"
                | "compose.yaml"
                | "makefile"
        )
        || matches!(
            ext,
            "yaml" | "yml" | "toml" | "ini" | "container" | "kube" | "pod" | "nomad"
        )
    {
        return (InventoryCategory::Infra, InventorySupport::Heuristic, true);
    }
    if matches!(ext, "md" | "mdx" | "rst" | "txt") {
        return (InventoryCategory::Docs, InventorySupport::Metadata, false);
    }
    (InventoryCategory::Asset, InventorySupport::Metadata, false)
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Walks the canonical repository root once, honoring Git ignore rules and never following symlinks.
/// Textual files are hashed from their original bytes; assets are represented by metadata only.
pub fn build_inventory(root: &Path) -> io::Result<Vec<InventoryFile>> {
    build_inventory_with_options(
        root,
        crate::scanner::ScanOptions::default().max_source_bytes,
        read_root_relative_limited,
    )
}

/// Testable inventory builder. The injected reader models unreadable files without relying on host permissions.
pub fn build_inventory_with_reader(
    root: &Path,
    mut read: impl FnMut(&Path, &str) -> io::Result<Vec<u8>>,
) -> io::Result<Vec<InventoryFile>> {
    build_inventory_with_options(root, u64::MAX, |root, relative, _| read(root, relative))
}

/// Builds inventory with an injected per-source byte budget and reader.
pub fn build_inventory_with_options(
    root: &Path,
    max_source_bytes: u64,
    mut read: impl FnMut(&Path, &str, u64) -> io::Result<Vec<u8>>,
) -> io::Result<Vec<InventoryFile>> {
    let root = root.canonicalize()?;
    let mut builder = ignore::WalkBuilder::new(&root);
    builder
        .hidden(false)
        .parents(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .follow_links(false);
    let mut files = Vec::new();
    for result in builder
        .filter_entry(|entry| entry.file_name() != ".autodoc")
        .build()
    {
        let entry = match result {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        let rel = match path.strip_prefix(&root) {
            Ok(path) => path,
            Err(_) => continue,
        };
        let rel_string = rel.to_string_lossy().replace('\\', "/");
        let (category, support, inspect_bytes) = classify(rel);
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        let (content_sha256, read_error) = if inspect_bytes {
            if category == InventoryCategory::Source && metadata.len() > max_source_bytes {
                (
                    None,
                    Some(format!(
                        "SOURCE_SIZE_LIMIT: size={} limit={max_source_bytes}",
                        metadata.len()
                    )),
                )
            } else {
                match read(&root, &rel_string, max_source_bytes) {
                    Ok(bytes) if bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() => {
                        (Some(sha256(&bytes)), Some("BINARY_CONTENT".to_string()))
                    }
                    Ok(bytes) => (Some(sha256(&bytes)), None),
                    Err(error) => (None, Some(error.to_string())),
                }
            }
        } else {
            (None, None)
        };
        let modified_ns = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos().min(i64::MAX as u128) as i64)
            .unwrap_or_default();
        files.push(InventoryFile {
            path: rel_string,
            category,
            support,
            content_sha256,
            excluded_reason: None,
            read_error,
            size_bytes: metadata.len(),
            modified_ns,
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

/// Opens each path component relative to an already-open directory descriptor and rejects symlinks.
/// Hash verification is performed on the bytes returned to the caller, before decoding/sanitizing.
pub fn read_verified_source(
    root: &Path,
    relative: &str,
    expected_sha256: &str,
) -> io::Result<Vec<u8>> {
    read_verified_source_with_limit(root, relative, expected_sha256, u64::MAX)
}

pub fn read_verified_source_with_limit(
    root: &Path,
    relative: &str,
    expected_sha256: &str,
    max_bytes: u64,
) -> io::Result<Vec<u8>> {
    let bytes = read_root_relative_limited(root, relative, max_bytes)?;
    let actual = sha256(&bytes);
    if actual != expected_sha256 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("STALE_SOURCE expected={expected_sha256} actual={actual}"),
        ));
    }
    Ok(bytes)
}

/// Reads at most `max_bytes + 1`, so growth after metadata inspection is also rejected.
pub fn read_source_limited(root: &Path, relative: &str, max_bytes: u64) -> io::Result<Vec<u8>> {
    read_root_relative_limited(root, relative, max_bytes)
}

fn read_root_relative_limited(root: &Path, relative: &str, max_bytes: u64) -> io::Result<Vec<u8>> {
    let canonical_root = root.canonicalize()?;
    let path = Path::new(relative);
    let components: Vec<_> = path.components().collect();
    if components.is_empty()
        || components
            .iter()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path must be a non-empty root-relative path",
        ));
    }
    let root_c = CString::new(canonical_root.as_os_str().as_encoded_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid root path"))?;
    let root_fd = unsafe {
        libc::open(
            root_c.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if root_fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut current = unsafe { File::from_raw_fd(root_fd) };
    for (index, component) in components.iter().enumerate() {
        let name = CString::new(component.as_os_str().as_encoded_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid path component"))?;
        let final_component = index + 1 == components.len();
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | if final_component {
                0
            } else {
                libc::O_DIRECTORY
            };
        let fd = unsafe { libc::openat(current.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let opened = unsafe { File::from_raw_fd(fd) };
        if final_component {
            let metadata = opened.metadata()?;
            if !metadata.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "source is not a regular file",
                ));
            }
            if metadata.len() > max_bytes {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "SOURCE_SIZE_LIMIT: size={} limit={max_bytes}",
                        metadata.len()
                    ),
                ));
            }
            let capacity = metadata.len().min(max_bytes).min(16 * 1024 * 1024) as usize;
            let mut bytes = Vec::with_capacity(capacity);
            opened
                .take(max_bytes.saturating_add(1))
                .read_to_end(&mut bytes)?;
            if bytes.len() as u64 > max_bytes {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("SOURCE_SIZE_LIMIT: size>{max_bytes} limit={max_bytes}"),
                ));
            }
            return Ok(bytes);
        }
        current = opened;
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "path has no file component",
    ))
}
