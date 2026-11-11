use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

const MAX_ROWS: usize = 512;
const MAX_BYTES: usize = 8 * 1024 * 1024;
static INFLIGHT: AtomicUsize = AtomicUsize::new(0);

struct Permit;
impl Drop for Permit {
    fn drop(&mut self) { INFLIGHT.fetch_sub(1, AtomicOrdering::AcqRel); }
}

#[napi(object)]
pub struct BatchResult {
    pub indices: Vec<u32>,
    pub scores: Vec<f64>,
}

#[derive(Clone, Copy)]
struct Hit { index: u32, rank: u32, score: f64 }
impl PartialEq for Hit { fn eq(&self, other: &Self) -> bool { self.cmp(other) == Ordering::Equal } }
impl Eq for Hit {}
impl PartialOrd for Hit { fn partial_cmp(&self, other: &Self) -> Option<Ordering> { Some(self.cmp(other)) } }
impl Ord for Hit {
    // Greater means worse: BinaryHeap keeps the discard candidate at its root.
    fn cmp(&self, other: &Self) -> Ordering {
        let score = if self.score == other.score { Ordering::Equal } else { other.score.total_cmp(&self.score) };
        score.then(self.rank.cmp(&other.rank)).then(self.index.cmp(&other.index))
    }
}

pub struct SearchTask {
    rows: Vec<u8>, query: Vec<f64>, ranks: Vec<u32>, limit: usize,
    threshold: f64, validate_unit: bool, _permit: Permit,
}

impl Task for SearchTask {
    type Output = BatchResult;
    type JsValue = BatchResult;
    fn compute(&mut self) -> Result<BatchResult> {
        score_batch(&self.rows, &self.query, &self.ranks, self.limit, self.threshold, self.validate_unit)
    }
    fn resolve(&mut self, _env: Env, output: BatchResult) -> Result<BatchResult> { Ok(output) }
}

fn invalid(message: &str) -> Error { Error::new(Status::InvalidArg, message) }

/// Protocol 1: caller supplies selected rows and an already prepared f64 query.
/// Copy every input before scheduling; no JS memory reaches the worker thread.
#[napi]
pub fn search_batch(
    protocol: u32, rows: Uint8Array, query: Float64Array, ranks: Uint32Array,
    limit: u32, threshold: f64, validate_unit: bool, signal: Option<AbortSignal>,
) -> Result<AsyncTask<SearchTask>> {
    if protocol != 1 { return Err(invalid("Unsupported vector batch protocol")); }
    let dimensions = query.len();
    if dimensions == 0 || dimensions > 4096 || ranks.len() > MAX_ROWS || rows.len() > MAX_BYTES
        || rows.len() != ranks.len() * dimensions * 4 || limit as usize > MAX_ROWS
        || !threshold.is_finite() || !query.iter().all(|v| v.is_finite()) {
        return Err(invalid("Malformed or oversized vector batch"));
    }
    let mut sorted_ranks = ranks.to_vec();
    sorted_ranks.sort_unstable();
    if sorted_ranks.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(invalid("Duplicate vector tie rank"));
    }
    INFLIGHT.fetch_update(AtomicOrdering::AcqRel, AtomicOrdering::Acquire, |n| (n < 2).then_some(n + 1))
        .map_err(|_| Error::new(Status::GenericFailure, "Vector batch capacity exceeded"))?;
    let permit = Permit;
    Ok(AsyncTask::with_optional_signal(SearchTask {
        rows: rows.to_vec(), query: query.to_vec(), ranks: ranks.to_vec(),
        limit: limit as usize, threshold, validate_unit, _permit: permit,
    }, signal))
}

fn score_batch(rows: &[u8], query: &[f64], ranks: &[u32], limit: usize, threshold: f64, validate_unit: bool) -> Result<BatchResult> {
    let mut heap = BinaryHeap::<Hit>::with_capacity(limit);
    for (index, row) in rows.chunks_exact(query.len() * 4).enumerate() {
        let mut score = 0.0_f64;
        let mut magnitude = 0.0_f64;
        let mut finite = true;
        for (component_bytes, q) in row.chunks_exact(4).zip(query) {
            let value = f32::from_le_bytes(component_bytes.try_into().unwrap()) as f64;
            finite &= value.is_finite();
            // Deliberately separate ordered multiply/add. No fast-math or mul_add.
            score += q * value;
            magnitude += value * value;
        }
        if !finite { return Err(invalid(&format!("invalid-row:{}:non-finite", index))); }
        if validate_unit && (!magnitude.is_finite() || (magnitude.sqrt() - 1.0).abs() > 0.002) {
            return Err(invalid(&format!("invalid-row:{}:not-normalized", index)));
        }
        let score = score.clamp(-1.0, 1.0);
        if !(score >= threshold) || limit == 0 { continue; }
        let hit = Hit { index: index as u32, rank: ranks[index], score };
        if heap.len() < limit { heap.push(hit); }
        else if hit < *heap.peek().unwrap() { *heap.peek_mut().unwrap() = hit; }
    }
    let hits = heap.into_sorted_vec();
    Ok(BatchResult { indices: hits.iter().map(|h| h.index).collect(), scores: hits.iter().map(|h| h.score).collect() })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ties_use_rank_before_discard() {
        let rows = [1_f32, 0., 1., 0., 1., 0.].into_iter().flat_map(f32::to_le_bytes).collect::<Vec<_>>();
        let result = score_batch(&rows, &[1., 0.], &[2, 1, 0], 1, 1., true).unwrap();
        assert_eq!(result.indices, vec![2]);
        assert_eq!(result.scores, vec![1.]);
    }
}
