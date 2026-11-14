use crate::{
    legacy_numeric,
    protocol::*,
    scoring::{self, Hit},
    CancellationState,
};
use rusqlite::{types::ValueRef, Connection, OpenFlags, Row, Statement};
use sha2::{Digest, Sha256};
use std::{
    collections::{BinaryHeap, HashMap},
    sync::{atomic::Ordering, Arc},
    time::Duration,
};

type ReadResult<T> = Result<T, Failure>;
struct Failure {
    status: &'static str,
    message: String,
}
impl Failure {
    fn operation(message: impl Into<String>) -> Self {
        Self {
            status: "operation-error",
            message: message.into(),
        }
    }
    fn cancelled() -> Self {
        Self {
            status: "cancelled",
            message: "Native vector read cancelled.".into(),
        }
    }
    fn corrupt(message: impl Into<String>) -> Self {
        Self {
            status: "corrupt",
            message: message.into(),
        }
    }
}
impl From<rusqlite::Error> for Failure {
    fn from(error: rusqlite::Error) -> Self {
        Self::operation(error.to_string())
    }
}
struct Registration<'a>(&'a CancellationState);
impl Drop for Registration<'_> {
    fn drop(&mut self) {
        self.0.unregister();
    }
}
fn checkpoint(cancellation: &CancellationState) -> ReadResult<()> {
    if cancellation.is_cancelled() {
        Err(Failure::cancelled())
    } else {
        Ok(())
    }
}

pub(crate) fn read(
    request: &NativeReadRequest,
    query: Option<&[f64]>,
    cancellation: &CancellationState,
) -> NativeReadOutcome {
    let mut corpus_check_required = false;
    match read_inner(request, query, cancellation, &mut corpus_check_required) {
        Ok(result) => result,
        Err(error) => {
            // Interrupt may be reported by SQLite before the next explicit checkpoint.
            let error = if cancellation.is_cancelled() {
                Failure::cancelled()
            } else {
                error
            };
            NativeReadOutcome::failure(error.status, error.message, corpus_check_required)
        }
    }
}

fn read_inner(
    request: &NativeReadRequest,
    query: Option<&[f64]>,
    cancellation: &CancellationState,
    corpus_check_required: &mut bool,
) -> ReadResult<NativeReadOutcome> {
    checkpoint(cancellation)?;
    let mut db = Connection::open_with_flags(
        &request.db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    db.busy_timeout(Duration::from_millis(50))?;
    cancellation.register(db.get_interrupt_handle());
    let _registration = Registration(cancellation);
    let cancelled = Arc::clone(&cancellation.cancelled);
    db.progress_handler(1000, Some(move || cancelled.load(Ordering::Acquire)))?;
    db.execute_batch("PRAGMA foreign_keys = ON")?;
    let tx = db.transaction()?;
    let has_scope_mapping = validate_schema(&tx)?;
    let Some(active) = active_generation(&tx, has_scope_mapping)? else {
        return Ok(NativeReadOutcome::absent());
    };
    if active.generation != request.generation || !active.compatible(&request.model) {
        return Ok(NativeReadOutcome::absent());
    }
    if active.job_id.starts_with("idle-recall-v2:")
        && active.job_id != preparation_job_id(request, &active)
    {
        return Ok(NativeReadOutcome::absent());
    }
    if let Some(corpus) = &request.corpus_generation_utf16 {
        if active
            .corpus_generation
            .as_ref()
            .map(|value| value.encode_utf16().collect::<Vec<_>>())
            .as_ref()
            != Some(corpus)
        {
            return Err(Failure {
                status: "corpus-changed",
                message:
                    "The active vector index no longer matches the requested lexical recall corpus."
                        .into(),
            });
        }
    }
    *corpus_check_required = true;
    checkpoint(cancellation)?;
    if active.chunk_count == 0.0 {
        tx.commit()?;
        return Ok(NativeReadOutcome::success(Vec::new()));
    }
    let query = query.ok_or_else(|| {
        Failure::operation("The active vector corpus changed shape during semantic scoring.")
    })?;
    if query.len() as f64 != active.dimensions || !query.iter().all(|v| v.is_finite()) {
        return Err(Failure::corrupt(format!(
            "Query vector has {} dimensions; expected {}.",
            query.len(),
            active.dimensions
        )));
    }
    for predicate in [
        &request.selection,
        &request.alias_scope,
        &request.alias_eligibility,
    ] {
        validate_predicate(predicate).map_err(Failure::operation)?;
    }
    let end = if request.limit.is_nan() {
        f64::NAN
    } else {
        active.chunk_count.min(request.limit)
    };
    let limit = legacy_numeric::slice_end(end, active.chunk_count as usize);
    let mut replay = end < 0.0;
    let sql = format!("SELECT chunk.chunk_id,chunk.uri,value.vector FROM vector_chunks AS chunk JOIN vector_values AS value ON value.id=chunk.vector_id WHERE chunk.generation=? AND chunk.chunk_id > '' AND ({}) ORDER BY chunk.chunk_id", request.selection.sql);
    let mut stmt = tx.prepare(&sql)?;
    checked_statement(&stmt, 3, request.selection.params.len() + 1)?;
    let params = std::iter::once(&request.generation).chain(&request.selection.params);
    let mut rows = stmt.query(rusqlite::params_from_iter(params))?;
    let mut best = BinaryHeap::<Hit>::new();
    while let Some(row) = rows.next()? {
        checkpoint(cancellation)?;
        // Safe SQLite-owned row borrow ends before the next rows.next(). No vector
        // allocation, typed-array export or asynchronous work occurs with this borrow.
        let bytes = match row.get_ref(2)? {
            ValueRef::Blob(bytes) => bytes,
            _ => {
                return Err(Failure::corrupt(
                    "Stored vector is not a binary SQLite value.",
                ))
            }
        };
        // The id is needed in strict validation diagnostics even when limit is zero.
        let id = text(row, 0)?;
        let score = scoring::score_with_cancel(bytes, query, &id, || cancellation.is_cancelled())
            .map_err(Failure::corrupt)?;
        if score.is_nan() && limit > 0 {
            replay = true;
        }
        if replay {
            break;
        }
        if limit == 0 || (best.len() == limit && score < best.peek().unwrap().score) {
            continue;
        }
        let uri = text(row, 1)?;
        scoring::offer(&mut best, Hit::new(id, uri, score), limit);
    }
    drop(rows);
    drop(stmt);
    let hits = if replay {
        legacy_replay(&tx, request, query, end, cancellation)?
    } else {
        best.into_sorted_vec()
    };
    let mut scores = Vec::<NativeScore>::new();
    let mut indices = HashMap::<String, usize>::new();
    for hit in hits {
        let score = legacy_numeric::js_max(hit.score, 0.0);
        if let Some(index) = indices.get(&hit.uri) {
            scores[*index].score = legacy_numeric::js_max(scores[*index].score, score);
        } else {
            indices.insert(hit.uri.clone(), scores.len());
            scores.push(NativeScore {
                uri: hit.uri,
                score,
            });
        }
    }
    let representatives: Vec<String> = scores.iter().map(|score| score.uri.clone()).collect();
    load_aliases(
        &tx,
        request,
        &representatives,
        &mut scores,
        &mut indices,
        cancellation,
    )?;
    checkpoint(cancellation)?;
    tx.commit()?;
    Ok(NativeReadOutcome::success(scores))
}

fn legacy_replay(
    db: &Connection,
    request: &NativeReadRequest,
    query: &[f64],
    end: f64,
    cancellation: &CancellationState,
) -> ReadResult<Vec<Hit>> {
    let sql = format!("SELECT chunk.chunk_id,chunk.uri,value.vector FROM vector_chunks AS chunk JOIN vector_values AS value ON value.id=chunk.vector_id WHERE chunk.generation=? AND chunk.chunk_id > ? AND ({}) ORDER BY chunk.chunk_id LIMIT 400", request.selection.sql);
    let mut stmt = db.prepare(&sql)?;
    checked_statement(&stmt, 3, request.selection.params.len() + 2)?;
    let mut cursor = String::new();
    let mut best = Vec::new();
    loop {
        checkpoint(cancellation)?;
        let mut rows = stmt.query(rusqlite::params_from_iter(
            std::iter::once(&request.generation)
                .chain(std::iter::once(&cursor))
                .chain(&request.selection.params),
        ))?;
        let mut page = Vec::with_capacity(400);
        let mut next_cursor = cursor.clone();
        while let Some(row) = rows.next()? {
            checkpoint(cancellation)?;
            let id = text(row, 0)?;
            let bytes = match row.get_ref(2)? {
                ValueRef::Blob(bytes) => bytes,
                _ => {
                    return Err(Failure::corrupt(
                        "Stored vector is not a binary SQLite value.",
                    ))
                }
            };
            let score =
                scoring::score_with_cancel(bytes, query, &id, || cancellation.is_cancelled())
                    .map_err(Failure::corrupt)?;
            next_cursor = id.clone();
            page.push(Hit::new(id, text(row, 1)?, score));
        }
        let count = page.len();
        if count == 0 {
            break;
        }
        legacy_numeric::sort(&mut page, || {
            checkpoint(cancellation).map_err(|error| error.message)
        })
        .map_err(Failure::operation)?;
        page.truncate(legacy_numeric::slice_end(end, count));
        best.extend(page);
        legacy_numeric::sort(&mut best, || {
            checkpoint(cancellation).map_err(|error| error.message)
        })
        .map_err(Failure::operation)?;
        best.truncate(legacy_numeric::slice_end(end, best.len()));
        cursor = next_cursor;
        if count < 400 {
            break;
        }
    }
    Ok(best)
}

// The caller owns the identity policy and serializes its suffix with JSON.stringify.
// Only the pinned snapshot's corpus string must be serialized here. This avoids
// validating a prepared job against an earlier opening state when no corpus was requested.
fn preparation_job_id(request: &NativeReadRequest, active: &Generation) -> String {
    if request.corpus_generation.is_some() {
        return request.expected_preparation_job_id.clone();
    }
    let corpus = active.corpus_generation.as_deref().unwrap_or("");
    let mut encoded = String::from("[\"idle-recall-v2\",\"");
    for character in corpus.chars() {
        match character {
            '"' => encoded.push_str("\\\""),
            '\\' => encoded.push_str("\\\\"),
            '\u{0008}' => encoded.push_str("\\b"),
            '\u{000c}' => encoded.push_str("\\f"),
            '\n' => encoded.push_str("\\n"),
            '\r' => encoded.push_str("\\r"),
            '\t' => encoded.push_str("\\t"),
            c if c < '\u{0020}' => encoded.push_str(&format!("\\u{:04x}", c as u32)),
            c => encoded.push(c),
        }
    }
    encoded.push_str("\",");
    encoded.push_str(&request.preparation_identity_suffix);
    format!(
        "idle-recall-v2:{}",
        Sha256::digest(encoded.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn checked_statement(stmt: &Statement<'_>, columns: usize, params: usize) -> ReadResult<()> {
    if !stmt.readonly() || stmt.column_count() != columns || stmt.parameter_count() != params {
        return Err(Failure::operation(
            "Invalid native selected-vector statement boundary.",
        ));
    }
    Ok(())
}

fn validate_schema(db: &Connection) -> ReadResult<bool> {
    let version: i64 = db.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version != 5 {
        return Err(Failure::operation(format!(
            "Unsupported vector index schema {version}; expected 5."
        )));
    }
    let shapes: &[(&str, &[&str])] = &[
        (
            "vector_aliases",
            &["generation", "uri", "representative_uri"],
        ),
        (
            "vector_chunks",
            &[
                "generation",
                "chunk_id",
                "uri",
                "fingerprint",
                "project",
                "approved_authoritative",
                "vector_id",
            ],
        ),
        (
            "vector_generations",
            &[
                "generation",
                "job_id",
                "corpus_generation",
                "model_id",
                "model_sha256",
                "dimensions",
                "embedding_recipe",
                "chunker_version",
                "normalized",
                "chunk_count",
                "state",
                "created_at",
                "scope_mapping_version",
            ],
        ),
        ("vector_pointer", &["singleton", "generation"]),
        ("vector_values", &["id", "vector_key", "vector"]),
    ];
    let mut has_scope_mapping = false;
    for (table, expected) in shapes {
        let mut stmt = db.prepare(&format!("PRAGMA table_info('{table}')"))?;
        let actual = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        let expected = if *table == "vector_generations" {
            has_scope_mapping = actual.iter().any(|name| name == "scope_mapping_version");
            if !has_scope_mapping {
                &expected[..expected.len() - 1]
            } else {
                expected
            }
        } else {
            expected
        };
        if actual.len() != expected.len() || actual.iter().zip(expected.iter()).any(|(a, e)| a != e)
        {
            return Err(Failure::operation(format!(
                "Vector index table {table} has invalid columns: {}.",
                if actual.is_empty() {
                    "(missing)".into()
                } else {
                    actual.join(", ")
                }
            )));
        }
    }
    Ok(has_scope_mapping)
}

struct Generation {
    generation: String,
    job_id: String,
    corpus_generation: Option<String>,
    model_id: String,
    model_sha256: String,
    dimensions: f64,
    embedding_recipe: String,
    chunker_version: f64,
    chunk_count: f64,
}
impl Generation {
    fn compatible(&self, model: &NativeReadModel) -> bool {
        self.model_id
            .encode_utf16()
            .eq(model.id_utf16.iter().copied())
            && self.model_sha256 == model.sha256
            && self.dimensions == model.dimensions
            && self.embedding_recipe == model.embedding_recipe
            && self.chunker_version == model.chunker_version
    }
}
fn text(row: &Row<'_>, column: usize) -> ReadResult<String> {
    match row.get_ref(column)? {
        ValueRef::Text(value) => Ok(String::from_utf8_lossy(value).into_owned()),
        _ => Err(Failure::operation(
            "Invalid vector metadata or identity type.",
        )),
    }
}
fn number(row: &Row<'_>, column: usize) -> ReadResult<f64> {
    match row.get_ref(column)? {
        ValueRef::Integer(value) => Ok(value as f64),
        ValueRef::Real(value) => Ok(value),
        _ => Err(Failure::operation("Vector generation metadata is invalid.")),
    }
}
fn numeric_count(row: &Row<'_>, column: usize) -> ReadResult<f64> {
    match row.get_ref(column)? {
        ValueRef::Text(bytes) => std::str::from_utf8(bytes)
            .ok()
            .and_then(js_number)
            .ok_or_else(|| Failure::operation("Vector generation metadata is invalid.")),
        ValueRef::Null => Ok(0.0),
        _ => number(row, column),
    }
}
// The existing reader coerces only counts through JavaScript Number(), including
// empty/whitespace and radix strings. Other metadata requires actual numeric cells.
fn js_number(value: &str) -> Option<f64> {
    let value = value.trim_matches(|c| matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'));
    if value.is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0b", 2),
        ("0B", 2),
        ("0o", 8),
        ("0O", 8),
    ] {
        if let Some(digits) = value.strip_prefix(prefix) {
            if digits.is_empty() {
                return None;
            }
            let mut number = 0.0;
            for digit in digits.chars() {
                number = number * radix as f64 + digit.to_digit(radix)? as f64;
            }
            return Some(number);
        }
    }
    value.parse().ok()
}
fn hex_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn valid_generation(value: &str) -> bool {
    let Some((time, suffix)) = value.split_once('-') else {
        return false;
    };
    !time.is_empty()
        && time.bytes().all(|c| c.is_ascii_digit())
        && !suffix.is_empty()
        && suffix
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c) || c == b'-')
}
fn active_generation(db: &Connection, has_scope_mapping: bool) -> ReadResult<Option<Generation>> {
    let scope_column = if has_scope_mapping {
        "generation.scope_mapping_version"
    } else {
        "NULL"
    };
    let mut stmt = db.prepare(&format!("SELECT generation.generation,generation.job_id,generation.corpus_generation,generation.model_id,generation.model_sha256,generation.dimensions,generation.embedding_recipe,generation.chunker_version,generation.normalized,generation.chunk_count,generation.state,generation.created_at,{scope_column},(SELECT COUNT(*) FROM vector_chunks WHERE vector_chunks.generation=generation.generation) FROM vector_pointer AS pointer JOIN vector_generations AS generation ON generation.generation=pointer.generation WHERE pointer.singleton=1 AND generation.state='ready' LIMIT 1"))?;
    let mut rows = stmt.query([])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    let generation_name = text(row, 0)?;
    let job_id = text(row, 1)?;
    let active = Generation {
        generation: generation_name.clone(),
        job_id: job_id.clone(),
        corpus_generation: match row.get_ref(2)? {
            ValueRef::Null => None,
            _ => Some(text(row, 2)?),
        },
        model_id: text(row, 3)?,
        model_sha256: text(row, 4)?,
        dimensions: number(row, 5)?,
        embedding_recipe: text(row, 6)?,
        chunker_version: number(row, 7)?,
        chunk_count: numeric_count(row, 9)?,
    };
    let scope_valid = if has_scope_mapping {
        let value = number(row, 12)?;
        value.is_finite() && value.fract() == 0.0 && (0.0..=1.0).contains(&value)
    } else {
        true
    };
    let actual_count = numeric_count(row, 13)?;
    if !valid_generation(&active.generation)
        || !hex_hash(job_id.strip_prefix("idle-recall-v2:").unwrap_or(&job_id))
        || active.model_id.is_empty()
        || !hex_hash(&active.model_sha256)
        || !hex_hash(&active.embedding_recipe)
        || !active.dimensions.is_finite()
        || active.dimensions.fract() != 0.0
        || active.dimensions <= 0.0
        || !scope_valid
        || !active.chunker_version.is_finite()
        || active.chunker_version.fract() != 0.0
        || active.chunker_version <= 0.0
        || text(row, 8)? != "l2"
        || !active.chunk_count.is_finite()
        || active.chunk_count.fract() != 0.0
        || active.chunk_count < 0.0
        || !actual_count.is_finite()
        || actual_count.fract() != 0.0
        || actual_count < 0.0
        || !["building", "ready"].contains(&text(row, 10)?.as_str())
        || text(row, 11)?.is_empty()
    {
        return Err(Failure::operation(format!(
            "Vector generation {} metadata is invalid.",
            if generation_name.is_empty() {
                "<unknown>"
            } else {
                &generation_name
            }
        )));
    }
    if actual_count != active.chunk_count {
        return Err(Failure::operation(format!(
            "Vector generation {} contains {actual_count}/{} chunks.",
            active.generation, active.chunk_count
        )));
    }
    Ok(Some(active))
}

fn load_aliases(
    db: &Connection,
    request: &NativeReadRequest,
    representatives: &[String],
    scores: &mut Vec<NativeScore>,
    indices: &mut HashMap<String, usize>,
    cancellation: &CancellationState,
) -> ReadResult<()> {
    // Match the TS reader's batches and alias iteration order. Representative
    // scores are looked up as aliases are merged, preserving its map semantics.
    for batch in representatives.chunks(100) {
        checkpoint(cancellation)?;
        let sql = format!("SELECT alias.uri,alias.representative_uri FROM vector_aliases AS alias WHERE alias.generation=? AND alias.representative_uri IN ({}) AND ({}) AND EXISTS (SELECT 1 FROM vector_chunks AS chunk WHERE chunk.generation=alias.generation AND chunk.uri=alias.representative_uri AND ({})) ORDER BY alias.representative_uri,alias.uri", vec!["?"; batch.len()].join(","), request.alias_scope.sql, request.alias_eligibility.sql);
        let mut stmt = db.prepare(&sql)?;
        let params = std::iter::once(&request.generation)
            .chain(batch)
            .chain(&request.alias_scope.params)
            .chain(&request.alias_eligibility.params);
        checked_statement(
            &stmt,
            2,
            1 + batch.len()
                + request.alias_scope.params.len()
                + request.alias_eligibility.params.len(),
        )?;
        let mut rows = stmt.query(rusqlite::params_from_iter(params))?;
        while let Some(row) = rows.next()? {
            checkpoint(cancellation)?;
            let uri = text(row, 0)?;
            let representative = text(row, 1)?;
            if let Some(index) = indices.get(&representative) {
                let score = scores[*index].score;
                if let Some(index) = indices.get(&uri) {
                    scores[*index].score = legacy_numeric::js_max(scores[*index].score, score);
                } else {
                    indices.insert(uri.clone(), scores.len());
                    scores.push(NativeScore { uri, score });
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering as AtomicOrdering},
    };
    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);
    struct Fixture {
        path: PathBuf,
    }
    impl Fixture {
        fn new(legacy: bool) -> Self {
            let path = std::env::temp_dir().join(format!(
                "threadnote-native-vector-test-{}-{}.sqlite",
                std::process::id(),
                NEXT_FIXTURE.fetch_add(1, AtomicOrdering::Relaxed)
            ));
            let db = Connection::open(&path).unwrap();
            db.execute_batch(&format!("PRAGMA user_version=5; CREATE TABLE vector_aliases(generation TEXT,uri TEXT,representative_uri TEXT); CREATE TABLE vector_chunks(generation TEXT,chunk_id TEXT,uri TEXT,fingerprint TEXT,project TEXT,approved_authoritative INTEGER,vector_id INTEGER); CREATE TABLE vector_generations(generation TEXT,job_id TEXT,corpus_generation TEXT,model_id TEXT,model_sha256 TEXT,dimensions INTEGER,embedding_recipe TEXT,chunker_version INTEGER,normalized TEXT,chunk_count INTEGER,state TEXT,created_at TEXT{}); CREATE TABLE vector_pointer(singleton INTEGER,generation TEXT); CREATE TABLE vector_values(id INTEGER,vector_key TEXT,vector BLOB);", if legacy { "" } else { ",scope_mapping_version INTEGER" })).unwrap();
            let hash = "a".repeat(64);
            let suffix = if legacy { "" } else { ",1" };
            db.execute_batch(&format!("INSERT INTO vector_generations VALUES('1-ab','{hash}','corpus','model','{hash}',2,'{hash}',1,'l2',1,'ready','created'{suffix}); INSERT INTO vector_pointer VALUES(1,'1-ab'); INSERT INTO vector_chunks VALUES('1-ab','chunk','representative','fingerprint',NULL,0,1); INSERT INTO vector_aliases VALUES('1-ab','alias','representative');")).unwrap();
            let vector: Vec<u8> = [0.6_f32, 0.8_f32]
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect();
            db.execute("INSERT INTO vector_values VALUES(1,'key',?)", [vector])
                .unwrap();
            Self { path }
        }
        fn db(&self) -> Connection {
            Connection::open(&self.path).unwrap()
        }
        fn request(&self) -> NativeReadRequest {
            let predicate = || NativePredicate {
                sql: "1=1".into(),
                params: Vec::new(),
            };
            NativeReadRequest {
                db_path: self.path.to_string_lossy().into_owned(),
                generation: "1-ab".into(),
                model: NativeReadModel {
                    id: "model".into(),
                    id_utf16: "model".encode_utf16().collect(),
                    sha256: "a".repeat(64),
                    dimensions: 2.0,
                    embedding_recipe: "a".repeat(64),
                    chunker_version: 1.0,
                },
                expected_preparation_job_id: format!("idle-recall-v2:{}", "b".repeat(64)),
                preparation_identity_suffix: "\"authorization\",\"model\",\"recipe\",1]".into(),
                corpus_generation: Some("corpus".into()),
                corpus_generation_utf16: Some("corpus".encode_utf16().collect()),
                limit: 25.0,
                selection: predicate(),
                alias_scope: predicate(),
                alias_eligibility: predicate(),
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    #[test]
    fn legacy_schema_legacy_jobs_aliases_and_negative_presentation_match() {
        let fixture = Fixture::new(true);
        let outcome = read(
            &fixture.request(),
            Some(&[-0.6, -0.8]),
            &CancellationState::default(),
        );
        assert_eq!(outcome.status, "success");
        assert!(outcome.corpus_check_required);
        assert_eq!(
            outcome.scores.unwrap(),
            vec![
                NativeScore {
                    uri: "representative".into(),
                    score: 0.0
                },
                NativeScore {
                    uri: "alias".into(),
                    score: 0.0
                }
            ]
        );
    }

    #[test]
    fn invalid_metadata_and_counts_precede_compatibility_or_corpus_checks() {
        let fixture = Fixture::new(false);
        fixture
            .db()
            .execute("UPDATE vector_generations SET chunk_count=2", [])
            .unwrap();
        let mut request = fixture.request();
        request.generation = "other".into();
        request.corpus_generation = Some("other".into());
        let outcome = read(&request, Some(&[0.6, 0.8]), &CancellationState::default());
        assert_eq!(outcome.status, "operation-error");
        assert!(!outcome.corpus_check_required);
        assert!(outcome.message.unwrap().contains("1/2 chunks"));
        fixture
            .db()
            .execute(
                "UPDATE vector_generations SET chunk_count=1,model_sha256='invalid'",
                [],
            )
            .unwrap();
        let outcome = read(&request, Some(&[0.6, 0.8]), &CancellationState::default());
        assert_eq!(outcome.status, "operation-error");
        assert!(!outcome.corpus_check_required);
    }

    #[test]
    fn prepared_job_mismatch_is_absent_and_requested_corpus_follows_compatibility() {
        let fixture = Fixture::new(false);
        let mut request = fixture.request();
        fixture
            .db()
            .execute(
                "UPDATE vector_generations SET job_id=?",
                [format!("idle-recall-v2:{}", "c".repeat(64))],
            )
            .unwrap();
        let outcome = read(&request, Some(&[0.6, 0.8]), &CancellationState::default());
        assert_eq!(outcome.status, "absent");
        assert!(!outcome.corpus_check_required);
        request.expected_preparation_job_id = format!("idle-recall-v2:{}", "c".repeat(64));
        request.corpus_generation = Some("different".into());
        request.corpus_generation_utf16 = Some("different".encode_utf16().collect());
        let outcome = read(&request, Some(&[0.6, 0.8]), &CancellationState::default());
        assert_eq!(outcome.status, "corpus-changed");
        assert!(!outcome.corpus_check_required);
    }

    #[test]
    fn k0_still_validates_rows_and_releases_resources_after_corruption() {
        let fixture = Fixture::new(false);
        let mut request = fixture.request();
        request.limit = 0.0;
        fixture
            .db()
            .execute("UPDATE vector_values SET vector=?", [vec![0u8; 8]])
            .unwrap();
        let outcome = read(&request, Some(&[0.6, 0.8]), &CancellationState::default());
        assert_eq!(outcome.status, "corrupt");
        assert!(outcome.corpus_check_required);
        assert!(outcome.message.unwrap().contains("L2-normalized"));
        let vector: Vec<u8> = [0.6_f32, 0.8_f32]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        fixture
            .db()
            .execute("UPDATE vector_values SET vector=?", [vector])
            .unwrap();
        let outcome = read(&request, Some(&[0.6, 0.8]), &CancellationState::default());
        assert_eq!(outcome.status, "success");
        assert!(outcome.scores.unwrap().is_empty());
    }

    #[test]
    fn empty_generation_needs_no_query_but_nonempty_generation_does() {
        let fixture = Fixture::new(false);
        let outcome = read(&fixture.request(), None, &CancellationState::default());
        assert_eq!(outcome.status, "operation-error");
        assert!(outcome.corpus_check_required);
        fixture
            .db()
            .execute_batch(
                "DELETE FROM vector_chunks; UPDATE vector_generations SET chunk_count=' '",
            )
            .unwrap();
        let outcome = read(&fixture.request(), None, &CancellationState::default());
        assert_eq!(outcome.status, "success");
        assert!(outcome.scores.unwrap().is_empty());
    }

    #[test]
    fn cooperative_interrupt_stops_sqlite_and_next_request_succeeds() {
        let fixture = Fixture::new(false);
        let mut request = fixture.request();
        request.selection.sql = "EXISTS (WITH RECURSIVE counting(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM counting WHERE x<1000000000) SELECT 1 FROM counting WHERE x=1000000000)".into();
        let cancellation = Arc::new(CancellationState::default());
        let worker_state = Arc::clone(&cancellation);
        let worker = std::thread::spawn(move || read(&request, Some(&[0.6, 0.8]), &worker_state));
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while cancellation.interrupt.lock().unwrap().is_none() {
            assert!(
                std::time::Instant::now() < deadline,
                "worker did not register its connection"
            );
            std::thread::yield_now();
        }
        cancellation.cancel();
        let outcome = worker.join().unwrap();
        assert_eq!(outcome.status, "cancelled");
        assert!(cancellation.interrupt.lock().unwrap().is_none());
        assert_eq!(
            read(
                &fixture.request(),
                Some(&[0.6, 0.8]),
                &CancellationState::default()
            )
            .status,
            "success"
        );
        let cancelled = CancellationState::default();
        cancelled.cancel();
        assert_eq!(
            read(&fixture.request(), Some(&[0.6, 0.8]), &cancelled).status,
            "cancelled"
        );
    }
}
