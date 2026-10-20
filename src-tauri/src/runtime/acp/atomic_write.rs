//! The atomic temp+fsync+rename write the two app-data stores share (issue
//! #1343): `<target>.tmp` in the same directory, fsync, rename over the
//! target -- a crash before the rename leaves the prior file intact.

use std::io::Write;
use std::path::Path;

/// The temp-file suffix (same directory as the target so the rename is
/// intra-volume -- mirrors `persistence::io`).
const TMP_SUFFIX: &str = ".tmp";

/// Write a string payload atomically. `private` selects the
/// private-permissions face (issue #1341: env rows may carry plaintext
/// keys): mode-at-creation -- 0600 on the temp file at open time, so the
/// final file never exists with wider perms, not even in the create->chmod
/// window a post-hoc permissions pass would leave open. Non-private callers
/// (the pure-cache sidecar) keep the plain create.
pub(super) fn write_atomic(target: &Path, json: &str, private: bool) -> Result<(), String> {
    let file_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "could not derive temp file path".to_string())?;
    let tmp = target.with_file_name(format!("{file_name}{TMP_SUFFIX}"));
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
    }
    {
        #[cfg(unix)]
        let mut file = if private {
            use std::os::unix::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&tmp)
        } else {
            std::fs::File::create(&tmp)
        }
        .map_err(|e| format!("create temp: {e}"))?;
        #[cfg(not(unix))]
        let mut file = {
            // The default ACL on Windows user-profile files is already
            // owner-private; `private` needs no special-casing.
            let _ = private;
            std::fs::File::create(&tmp)
        }
        .map_err(|e| format!("create temp: {e}"))?;
        file.write_all(json.as_bytes())
            .map_err(|e| format!("write temp: {e}"))?;
        file.sync_all().map_err(|e| format!("sync temp: {e}"))?;
    }
    if let Err(e) = std::fs::rename(&tmp, target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("rename: {e}"));
    }
    Ok(())
}
