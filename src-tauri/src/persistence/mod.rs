//! Cross-session persistence (ADR-0034/0036/0042): the `.duck` recipe.
//!
//! A session bound to a `.duck` path rewrites the whole recipe atomically on
//! every terminal turn / source lifecycle event (ADR-0034 per-turn atomic
//! write). Resume reads the recipe back, verifies each source's post-rectify
//! fingerprint (ADR-0035/0042), and eagerly re-executes the productive SQL
//! chain (ADR-0034) -- LLM-free, the SQL and disambiguation choices already
//! live in the recipe.
//!
//! - [`recipe`] -- the durable model (what persists, what does NOT).
//! - [`io`] -- atomic temp+rename whole-file write + version-checked read.
//! - [`registry`] -- in-process single-writer enforcement (ADR-0035 Decision 3, #50):
//!   tracks the canonical `.duck` paths currently open in this process.

pub mod io;
pub mod recipe;
pub mod registry;

pub use io::{read_duck, save_atomic, LoadError, SaveError};
pub use recipe::{
    ProductiveTurn, Recipe, RecipeEntry, RecipeOutcome, RecipeTurn, SourceRef,
    RECIPE_FORMAT_VERSION,
};
pub use registry::{canonicalize_duck, release, try_acquire};
