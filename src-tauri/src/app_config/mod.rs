//! App-level config (ADR-0038): the SECOND durable at-rest artifact, alongside
//! the user-owned `.duck`. App-config holds ONLY preferences, defaults, and
//! data-free state -- never a key, never user-data values, never dataset
//! contents. It lives in the OS app-data directory (machine-local, not portable
//! across users -- orthogonal to the shareable `.duck`).
//!
//! - [`model`] -- the durable schema (what persists, what does NOT). The
//!   secrets-never invariant starts here: there is no key field anywhere.
//! - [`io`] -- atomic temp+rename write + honest-degrade read (a corrupt /
//!   missing / version-mismatched / secret-carrying file all yield built-in
//!   defaults, never a crash).

pub mod io;
pub mod model;

pub use io::{read_at, write_at, WriteError};
pub use model::{
    AppConfig, DefaultRuntime, EngineDefaults, ExportDefaults, LocalePreference, ModelPosture,
    PrivacyDefaults, Theme, Tunables, APP_CONFIG_FORMAT_VERSION,
};
