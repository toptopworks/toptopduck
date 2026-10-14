//! The bounded single-line reader crate: one implementation shared by every
//! untrusted-input surface (issues #629/#639/#643/#647). Deliberately pure
//! std with no dependencies -- the ACP bridge binary links it without
//! pulling the app crate (ADR-0085). See `bounded_line` for the consumption
//! shapes and the over-long-line contract.

pub mod bounded_line;
