//! Full-text search over the stash (spec «Поиск»): one index, one query
//! language and one ranking for the drawer and for agents.
//!
//! `entries_fts` (roadmap schema v1, trigram tokenizer, rowid = entries.rowid)
//! is derived data: everything here may fail without losing anything, and
//! `rebuild_index` recreates it from the entries and their files.

// Siblings reach each other as `super::query::…`. No re-export until code
// outside `search` needs one: an unused `pub use` is a warning of its own.
mod index;
mod query;
mod snippet;
#[cfg(test)]
mod test_support;
mod text;

pub(crate) use index::register_functions;
