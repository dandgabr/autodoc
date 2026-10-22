use autodoc_core::inventory::{
    build_inventory, build_inventory_with_reader, read_verified_source, InventoryCategory,
    InventorySupport,
};
use std::fs;
use std::os::unix::fs::symlink;
use tempfile::tempdir;

#[test]
fn inventory_covers_source_manifests_markup_and_assets_with_consistent_support() {
    let root = tempdir().unwrap();
    fs::create_dir_all(root.path().join("js")).unwrap();
    fs::create_dir_all(root.path().join("nested")).unwrap();
    fs::write(root.path().join("main.ts"), "export const root = true;").unwrap();
    fs::write(root.path().join("js/app.js"), "export const app = true;").unwrap();
    fs::write(root.path().join("nested/package.json"), "{}").unwrap();
    fs::write(root.path().join("index.html"), "<main />").unwrap();
    fs::write(root.path().join("site.css"), "body { color: red }").unwrap();
    fs::write(root.path().join("logo.png"), [0, 1, 2, 255]).unwrap();

    let inventory = build_inventory(root.path()).unwrap();
    let by_path = inventory
        .iter()
        .map(|f| (f.path.as_str(), f))
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(by_path["main.ts"].category, InventoryCategory::Source);
    assert_eq!(by_path["js/app.js"].support, InventorySupport::Ast);
    assert_eq!(
        by_path["nested/package.json"].category,
        InventoryCategory::Manifest
    );
    assert_eq!(by_path["index.html"].category, InventoryCategory::Markup);
    assert_eq!(by_path["site.css"].category, InventoryCategory::Style);
    assert_eq!(by_path["logo.png"].support, InventorySupport::Metadata);
    assert!(by_path["logo.png"].content_sha256.is_none());
}

#[test]
fn inventory_respects_gitignore_and_does_not_follow_external_symlinks() {
    let root = tempdir().unwrap();
    let outside = tempdir().unwrap();
    fs::create_dir(root.path().join(".git")).unwrap();
    fs::create_dir(root.path().join(".autodoc")).unwrap();
    fs::write(root.path().join(".autodoc/cache.db"), [0, 1, 2]).unwrap();
    fs::write(root.path().join(".gitignore"), "ignored.ts\n").unwrap();
    fs::write(root.path().join("ignored.ts"), "ignored()").unwrap();
    fs::write(outside.path().join("secret.ts"), "secret()").unwrap();
    symlink(outside.path(), root.path().join("external")).unwrap();
    let inventory = build_inventory(root.path()).unwrap();
    assert!(!inventory.iter().any(|f| f.path == "ignored.ts"));
    assert!(!inventory.iter().any(|f| f.path.starts_with(".autodoc/")));
    assert!(!inventory.iter().any(|f| f.path.starts_with("external/")));
}

#[test]
fn verified_reader_hashes_original_bytes_and_rejects_content_changed_after_scan() {
    let root = tempdir().unwrap();
    fs::write(root.path().join("main.ts"), [0xff, 0x00, 0x41]).unwrap();
    let inventory = build_inventory(root.path()).unwrap();
    let file = inventory.iter().find(|f| f.path == "main.ts").unwrap();
    let bytes = read_verified_source(
        root.path(),
        "main.ts",
        file.content_sha256.as_deref().unwrap(),
    )
    .unwrap();
    assert_eq!(bytes, [0xff, 0x00, 0x41]);
    fs::write(root.path().join("main.ts"), "changed").unwrap();
    assert!(read_verified_source(
        root.path(),
        "main.ts",
        file.content_sha256.as_deref().unwrap()
    )
    .is_err());
}

#[test]
fn verified_reader_rejects_symlink_swapped_after_enumeration() {
    let root = tempdir().unwrap();
    let outside = tempdir().unwrap();
    fs::write(root.path().join("main.ts"), "inside").unwrap();
    fs::write(outside.path().join("main.ts"), "outside secret").unwrap();
    let inventory = build_inventory(root.path()).unwrap();
    let file = inventory.iter().find(|f| f.path == "main.ts").unwrap();
    fs::remove_file(root.path().join("main.ts")).unwrap();
    symlink(outside.path().join("main.ts"), root.path().join("main.ts")).unwrap();
    assert!(read_verified_source(
        root.path(),
        "main.ts",
        file.content_sha256.as_deref().unwrap()
    )
    .is_err());
}

#[test]
fn inventory_records_denied_reads_without_relying_on_os_permission_bits() {
    let root = tempdir().unwrap();
    fs::create_dir_all(root.path().join("denied/subtree")).unwrap();
    fs::write(root.path().join("denied/subtree/main.ts"), "source").unwrap();
    let inventory = build_inventory_with_reader(root.path(), |_, _| {
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "injected subtree denial",
        ))
    })
    .unwrap();
    let source = inventory
        .iter()
        .find(|file| file.path == "denied/subtree/main.ts")
        .unwrap();
    assert!(source.content_sha256.is_none());
    assert!(source
        .read_error
        .as_deref()
        .unwrap()
        .contains("injected subtree denial"));
}

#[test]
fn canonical_and_equivalent_roots_produce_the_same_scope() {
    let root = tempdir().unwrap();
    fs::write(root.path().join("main.ts"), "source").unwrap();
    let equivalent = root.path().join("child/../");
    fs::create_dir(root.path().join("child")).unwrap();
    let canonical = build_inventory(root.path()).unwrap();
    let aliased = build_inventory(&equivalent).unwrap();
    assert_eq!(
        canonical.iter().map(|f| &f.path).collect::<Vec<_>>(),
        aliased.iter().map(|f| &f.path).collect::<Vec<_>>()
    );
}

#[test]
fn inventory_marks_source_over_injected_byte_budget_without_hashing_it() {
    let root = tempdir().unwrap();
    fs::write(root.path().join("large.ts"), "123456789").unwrap();
    let inventory = autodoc_core::inventory::build_inventory_with_options(
        root.path(),
        4,
        |root, relative, max_bytes| {
            autodoc_core::inventory::read_source_limited(root, relative, max_bytes)
        },
    )
    .unwrap();
    let file = inventory
        .iter()
        .find(|file| file.path == "large.ts")
        .unwrap();
    assert_eq!(file.content_sha256, None);
    assert_eq!(
        file.read_error.as_deref(),
        Some("SOURCE_SIZE_LIMIT: size=9 limit=4")
    );
}
