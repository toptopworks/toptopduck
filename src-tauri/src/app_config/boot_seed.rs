//! First-paint boot seed (issue #814, ADR-0113; the shell-collapse field
//! rides issue #1404): the narrow Rust -> webview channel delivering
//! `theme`, `locale`, and the sidebar collapse preference to the main
//! window BEFORE any frontend script runs, closing the first-paint flash
//! where the persisted preference differed from the OS-resolved default
//! (the fold face of the same flash: the sidebar rendered expanded until
//! the IPC resolved). `setup` attaches the script at window creation
//! (`create: false` + `from_config`); the payload is intentionally narrow --
//! everything else waits for the authoritative full `get_app_config` IPC.
//! The honest-degrade read result is injected unconditionally (defaults on a
//! failed read are a semantic no-op vs the pre-channel null fallback), so
//! "the global is absent" means exactly one thing: the script did not run.

use serde::Serialize;

use super::model::{AppConfig, LocalePreference, Theme};

/// The global the script assigns; read by `src/shell/bootSeed.ts`. The
/// double-underscore shape follows the tauri plugin convention
/// (`__TAURI_OS_PLUGIN_INTERNALS__`). Keep in sync with the frontend reader.
pub(crate) const BOOT_SEED_GLOBAL: &str = "__TOPTOPDUCK_BOOT_SEED__";

/// The wire payload. Reuses the model enums verbatim so the serde renames
/// keep the literals identical to the full `get_app_config` IPC wire by
/// construction (no parallel string mapping to drift); `sidebar_collapsed`
/// carries the ShellPrefs field name for the same reason.
#[derive(Debug, PartialEq, Serialize)]
pub(crate) struct BootSeedPayload {
    pub theme: Theme,
    pub locale: LocalePreference,
    pub sidebar_collapsed: bool,
}

/// Narrow the full config to the first-paint fields.
pub(crate) fn boot_seed_payload(cfg: &AppConfig) -> BootSeedPayload {
    BootSeedPayload {
        theme: cfg.theme,
        locale: cfg.locale,
        sidebar_collapsed: cfg.shell.sidebar_collapsed,
    }
}

/// The initialization script text. `serde_json` output over enum-only
/// fields is always a safe JSON literal (no free-form strings), so plain
/// `format!` carries no script-injection surface.
pub(crate) fn boot_seed_script(cfg: &AppConfig) -> String {
    let json = serde_json::to_string(&boot_seed_payload(cfg))
        .expect("serializing the narrow payload to JSON cannot fail");
    format!("window.{BOOT_SEED_GLOBAL} = {json};")
}

#[cfg(test)]
mod tests {
    use super::super::model::ShellPrefs;
    use super::*;

    fn config_with(theme: Theme, locale: LocalePreference, sidebar_collapsed: bool) -> AppConfig {
        AppConfig {
            theme,
            locale,
            shell: ShellPrefs { sidebar_collapsed },
            ..AppConfig::default()
        }
    }

    #[test]
    fn payload_narrows_to_the_first_paint_fields() {
        let payload = boot_seed_payload(&config_with(Theme::Dark, LocalePreference::ZhCN, true));
        assert_eq!(
            payload,
            BootSeedPayload {
                theme: Theme::Dark,
                locale: LocalePreference::ZhCN,
                sidebar_collapsed: true,
            }
        );
    }

    #[test]
    fn defaults_seed_system_system() {
        let script = boot_seed_script(&AppConfig::default());
        assert_eq!(
            script,
            "window.__TOPTOPDUCK_BOOT_SEED__ = {\"theme\":\"system\",\"locale\":\"system\",\"sidebar_collapsed\":false};"
        );
    }

    #[test]
    fn script_literals_match_the_ipc_wire_shapes() {
        // Lowercase theme (rename_all) + BCP-47 locale (explicit variant
        // renames) + the shell-prefs field name verbatim: the exact literals
        // the frontend whitelist accepts and the full `get_app_config` IPC
        // also emits.
        let script = boot_seed_script(&config_with(Theme::Dark, LocalePreference::ZhCN, true));
        assert_eq!(
            script,
            "window.__TOPTOPDUCK_BOOT_SEED__ = {\"theme\":\"dark\",\"locale\":\"zh-CN\",\"sidebar_collapsed\":true};"
        );
        let script = boot_seed_script(&config_with(Theme::Light, LocalePreference::EnUS, false));
        assert_eq!(
            script,
            "window.__TOPTOPDUCK_BOOT_SEED__ = {\"theme\":\"light\",\"locale\":\"en-US\",\"sidebar_collapsed\":false};"
        );
    }
}
