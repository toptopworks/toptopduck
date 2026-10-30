//! Pre-paint window background (issue #881): the boot `show()` reveals the
//! main window before the webview has painted anything, and that gap shows
//! the native window background -- default white, a perceptible flash under
//! a dark theme (ADR-0113's seed fixes the first *render*, not the gap
//! before it). This module resolves the persisted theme to the matching
//! canvas token so the gap itself carries the right floor color.
//!
//! The color must ride the `WebviewWindowBuilder` chain: window-state's
//! `restore_state` -> `show()` runs synchronously *inside* `build()`
//! (main-thread dispatch executes inline, not queued), so a post-build
//! `set_background_color` lands only after the white frame was already
//! composited. An unresolved system theme (registry unreadable,
//! non-Windows) keeps the static `backgroundColor` declared in
//! `tauri.conf.json` instead of inventing a color here.

use crate::app_config::model::Theme;
use tauri::window::Color;

/// Light page floor -- DESIGN.md `canvas` token (#ffffff). The window
/// background must match the floor the first paint renders, not the card
/// surface one brightness step above it.
const LIGHT_CANVAS: Color = Color(0xff, 0xff, 0xff, 0xff);

/// Dark page floor -- DESIGN.md `canvas-dark` token (#0f1410, RGB 15, 20,
/// 16; the green-undertone dark canvas).
const DARK_CANVAS: Color = Color(0x0f, 0x14, 0x10, 0xff);

/// Resolve the boot theme to the window background color. `os_light` is the
/// OS apps-theme resolution (`os_uses_light_theme`): `Some(true)` = the OS
/// prefers light. `Theme::System` with an unresolved OS (`None`) returns
/// `None` -- the caller then keeps the config-declared static value rather
/// than guessing.
pub(crate) fn background_color(theme: Theme, os_light: Option<bool>) -> Option<Color> {
    let is_dark = match theme {
        Theme::Dark => true,
        Theme::Light => false,
        // `?` propagates the unresolved-OS signal: None means the caller
        // keeps the static config value (see the fn doc).
        Theme::System => !os_light?,
    };
    Some(if is_dark { DARK_CANVAS } else { LIGHT_CANVAS })
}

/// The OS apps-theme preference, read from the same registry value tao's
/// dark-mode detection and WebView2's `prefers-color-scheme` consume
/// (`AppsUseLightTheme`). Windows-only; every other platform (and any read
/// failure) yields `None`, keeping the static config background.
#[cfg(windows)]
pub(crate) fn os_uses_light_theme() -> Option<bool> {
    use std::iter::once;

    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};

    const SUBKEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize";
    const VALUE: &str = "AppsUseLightTheme";

    let subkey: Vec<u16> = SUBKEY.encode_utf16().chain(once(0)).collect();
    let value: Vec<u16> = VALUE.encode_utf16().chain(once(0)).collect();
    let mut data: u32 = 0;
    let mut size: u32 = std::mem::size_of::<u32>() as u32;
    // SAFETY: RegGetValueW writes only through the two out-pointers, both
    // valid and sized to one DWORD; the two wide strings are NUL-terminated
    // by construction; no registry handle is opened or leaked.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            &mut data as *mut u32 as *mut core::ffi::c_void,
            &mut size,
        )
    };
    (status == ERROR_SUCCESS).then_some(data != 0)
}

#[cfg(not(windows))]
pub(crate) fn os_uses_light_theme() -> Option<bool> {
    // No OS-theme query wired for other desktop platforms yet; None keeps
    // the config-declared static background in place.
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_themes_map_to_their_canvas_token() {
        assert_eq!(background_color(Theme::Light, None), Some(LIGHT_CANVAS));
        assert_eq!(background_color(Theme::Dark, None), Some(DARK_CANVAS));
        // An explicit theme ignores the OS resolution entirely.
        assert_eq!(
            background_color(Theme::Light, Some(false)),
            Some(LIGHT_CANVAS)
        );
        assert_eq!(background_color(Theme::Dark, Some(true)), Some(DARK_CANVAS));
    }

    #[test]
    fn system_theme_resolves_through_the_os_preference() {
        assert_eq!(
            background_color(Theme::System, Some(true)),
            Some(LIGHT_CANVAS)
        );
        assert_eq!(
            background_color(Theme::System, Some(false)),
            Some(DARK_CANVAS)
        );
    }

    #[test]
    fn unresolved_system_theme_keeps_the_static_config_value() {
        assert_eq!(background_color(Theme::System, None), None);
    }

    #[test]
    fn canvas_literals_pin_the_design_tokens() {
        // DESIGN.md surface tokens: light `canvas` #ffffff; dark
        // `canvas-dark` #0f1410 (RGB 15, 20, 16).
        assert_eq!(LIGHT_CANVAS, Color(255, 255, 255, 255));
        assert_eq!(DARK_CANVAS, Color(15, 20, 16, 255));
    }
}
