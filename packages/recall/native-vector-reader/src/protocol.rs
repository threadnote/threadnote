//! Private recall capability protocol. Public recall requests never contain these predicates.
#[cfg(not(test))]
use napi_derive::napi;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Clone, Debug)]
#[cfg_attr(not(test), napi(object))]
pub struct NativePredicate {
    pub sql: String,
    pub params: Vec<String>,
}

#[derive(Clone, Debug)]
#[cfg_attr(not(test), napi(object))]
pub struct NativeReadModel {
    pub id: String,
    pub sha256: String,
    pub dimensions: f64,
    pub embedding_recipe: String,
    pub chunker_version: f64,
}

#[derive(Clone, Debug)]
#[cfg_attr(not(test), napi(object))]
pub struct NativeReadRequest {
    pub db_path: String,
    pub generation: String,
    pub model: NativeReadModel,
    pub expected_preparation_job_id: String,
    pub corpus_generation: Option<String>,
    pub limit: f64,
    pub selection: NativePredicate,
    pub alias_scope: NativePredicate,
    pub alias_eligibility: NativePredicate,
}

#[derive(Debug, PartialEq)]
#[cfg_attr(not(test), napi(object))]
pub struct NativeScore {
    pub uri: String,
    pub score: f64,
}

#[derive(Debug)]
#[cfg_attr(not(test), napi(object))]
pub struct NativeReadOutcome {
    pub status: String,
    pub corpus_check_required: bool,
    pub scores: Option<Vec<NativeScore>>,
    pub message: Option<String>,
}

impl NativeReadOutcome {
    pub fn absent() -> Self {
        Self {
            status: "absent".into(),
            corpus_check_required: false,
            scores: None,
            message: None,
        }
    }
    pub fn success(scores: Vec<NativeScore>) -> Self {
        Self {
            status: "success".into(),
            corpus_check_required: true,
            scores: Some(scores),
            message: None,
        }
    }
    pub fn failure(status: &str, message: impl Into<String>, corpus_check_required: bool) -> Self {
        Self {
            status: status.into(),
            corpus_check_required,
            scores: None,
            message: Some(message.into()),
        }
    }
}

#[cfg_attr(not(test), napi(object))]
pub struct NativeBuildInfo {
    pub protocol_version: u32,
    pub napi_version: u32,
    pub crate_version: String,
    pub sqlite_version: String,
    pub sqlite_source_id: String,
    pub target: String,
    pub rust_version: String,
    pub source_commit: String,
    pub source_tree: String,
    pub lock_sha256: String,
    pub toolchain_sha256: String,
    pub source_sha256: String,
}

/// The factory emits expressions with bind parameters, never comments/quoted identifiers.
/// Verify that a private fragment cannot close the surrounding fixed WHERE expression.
/// SQLite additionally verifies the complete statement, readonly bit and bind/column counts.
pub fn validate_predicate(predicate: &NativePredicate) -> Result<(), String> {
    let sql = predicate.sql.as_bytes();
    let mut depth = 0usize;
    let mut index = 0;
    while index < sql.len() {
        match sql[index] {
            b'(' => depth += 1,
            b')' if depth > 0 => depth -= 1,
            b')' => return Err("Native predicate closes its statement boundary.".into()),
            b'\0' | b';' | b'\'' | b'"' | b'`' | b'[' | b']' => {
                return Err("Invalid native predicate boundary.".into())
            }
            b'-' if sql.get(index + 1) == Some(&b'-') => {
                return Err("Native predicate comments are not supported.".into())
            }
            b'/' if sql.get(index + 1) == Some(&b'*') => {
                return Err("Native predicate comments are not supported.".into())
            }
            _ => (),
        }
        index += 1;
    }
    if depth != 0 || predicate.sql.trim().is_empty() {
        return Err("Unbalanced or empty native predicate.".into());
    }
    Ok(())
}
