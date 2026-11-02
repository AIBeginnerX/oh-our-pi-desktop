//! Bakes the OOP release version into the binary: `OOP_VERSION` from the environment when the
//! packager sets it, else `version` of the workspace root `OOP_RELEASE.json` (the file the
//! TypeScript terminal inlines too), else the crate's own version.

use std::path::Path;

fn release_version(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let rest = text.split("\"version\"").nth(1)?;
    let rest = rest.trim_start().strip_prefix(':')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    let version = &rest[..rest.find('"')?];
    (!version.is_empty()).then(|| version.to_string())
}

fn main() {
    println!("cargo:rerun-if-env-changed=OOP_VERSION");
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let release = Path::new(&manifest).join("../../OOP_RELEASE.json");
    println!("cargo:rerun-if-changed={}", release.display());
    let version = std::env::var("OOP_VERSION")
        .ok()
        .map(|v| v.trim().trim_start_matches('v').to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| release_version(&release))
        .unwrap_or_else(|| std::env::var("CARGO_PKG_VERSION").unwrap_or_default());
    println!("cargo:rustc-env=OOP_RS_VERSION={version}");
}
