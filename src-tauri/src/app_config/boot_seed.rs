//! First-paint boot seed (issue #814, ADR-0113): the narrow Rust -> webview
//! channel delivering `theme` + `locale` to the main window BEFORE any
//! frontend script runs, closing the first-paint flash where the persisted
//! preference differed from the OS-resolved default. `setup` attaches the
//! script at window creation (`create: false` + `from_config`); the payload
//! is intentionally TWO enum fields -- everything else waits for the
//! authoritative full `get_app_config` IPC. The honest-degrade read result
//! is injected unconditionally (defaults on a failed read are a semantic
//! no-op vs the pre-channel null fallback), so "the global is absent" means
//! exactly one thing: the script did not run.

use serde::Serialize;

use super::model::{AppConfig, LocalePreference, Theme};

/// The global the script assigns; read by `src/shell/bootSeed.ts`. The
/// double-underscore shape follows the tauri plugin convention
/// (`__TAURI_OS_PLUGIN_INTERNALS__`). Keep in sync with the frontend reader.
pub(crate) const BOOT_SEED_GLOBAL: &str = "__TOPTOPDUCK_BOOT_SEED__";

/// The wire payload. Reuses the model enums verbatim so the serde renames
/// keep the literals identical to the full `get_app_config` IPC wire by
/// construction (no parallel string mapping to drift).
#[derive(Debug, PartialEq, Serialize)]
pub(crate) struct BootSeedPayload {
    pub theme: Theme,
    pub locale: LocalePreference,
}

/// Narrow the full config to the two first-paint fields.
pub(crate) fn boot_seed_payload(cfg: &AppConfig) -> BootSeedPayload {
    BootSeedPayload {
        theme: cfg.theme,
        locale: cfg.locale,
    }
}

/// The initialization script text. `serde_json` output over enum-only
/// fields is always a safe JSON literal (no free-form strings), so plain
/// `format!` carries no script-injection surface.
pub(crate) fn boot_seed_script(cfg: &AppConfig) -> String {
    let json = serde_json::to_string(&boot_seed_payload(cfg))
        .expect("serializing two unit enums to JSON cannot fail");
    format!("window.{BOOT_SEED_GLOBAL} = {json};")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_with(theme: Theme, locale: LocalePreference) -> AppConfig {
        AppConfig {
            theme,
            locale,
            ..AppConfig::default()
        }
    }

    #[test]
    fn payload_narrows_to_the_two_first_paint_fields() {
        let payload = boot_seed_payload(&config_with(Theme::Dark, LocalePreference::ZhCN));
        assert_eq!(
            payload,
            BootSeedPayload {
                theme: Theme::Dark,
                locale: LocalePreference::ZhCN,
            }
        );
    }

    #[test]
    fn defaults_seed_system_system() {
        let script = boot_seed_script(&AppConfig::default());
        assert_eq!(
            script,
            "window.__TOPTOPDUCK_BOOT_SEED__ = {\"theme\":\"system\",\"locale\":\"system\"};"
        );
    }

    #[test]
    fn script_literals_match_the_ipc_wire_shapes() {
        // Lowercase theme (rename_all) + BCP-47 locale (explicit variant
        // renames): the exact literals the frontend whitelist accepts and
        // the full `get_app_config` IPC also emits.
        let script = boot_seed_script(&config_with(Theme::Dark, LocalePreference::ZhCN));
        assert_eq!(
            script,
            "window.__TOPTOPDUCK_BOOT_SEED__ = {\"theme\":\"dark\",\"locale\":\"zh-CN\"};"
        );
        let script = boot_seed_script(&config_with(Theme::Light, LocalePreference::EnUS));
        assert_eq!(
            script,
            "window.__TOPTOPDUCK_BOOT_SEED__ = {\"theme\":\"light\",\"locale\":\"en-US\"};"
        );
    }
}
