use std::cmp::Ordering;
use std::collections::BinaryHeap;

#[derive(Clone, Debug)]
pub struct Hit {
    pub uri: String,
    pub score: f64,
    // JavaScript orders strings by UTF-16 code units, not UTF-8 or Unicode scalar value.
    pub(crate) key: Vec<u16>,
}

impl Hit {
    pub fn new(id: String, uri: String, score: f64) -> Self {
        Self {
            key: id.encode_utf16().collect(),
            uri,
            score,
        }
    }
}
impl PartialEq for Hit {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for Hit {}
impl PartialOrd for Hit {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Hit {
    fn cmp(&self, other: &Self) -> Ordering {
        (if self.score == other.score {
            Ordering::Equal
        } else {
            other
                .score
                .partial_cmp(&self.score)
                .expect("NaN uses the legacy replay sorter")
        })
        .then(self.key.cmp(&other.key))
    }
}

pub fn offer(heap: &mut BinaryHeap<Hit>, hit: Hit, limit: usize) {
    if limit == 0 {
        return;
    }
    if heap.len() < limit {
        heap.push(hit);
    } else if hit < *heap.peek().unwrap() {
        *heap.peek_mut().unwrap() = hit;
    }
}

/// Rust's default strict floating-point operations preserve this ordered multiply/add.
/// Do not replace either accumulation with mul_add, SIMD reductions or fast-math.
#[cfg(test)]
pub fn score(bytes: &[u8], query: &[f64], id: &str) -> Result<f64, String> {
    score_with_cancel(bytes, query, id, || false)
}

pub fn score_with_cancel(
    bytes: &[u8],
    query: &[f64],
    id: &str,
    mut cancelled: impl FnMut() -> bool,
) -> Result<f64, String> {
    if bytes.len() != query.len() * 4 {
        return Err(format!(
            "Stored vector {id} has {} bytes; expected {}.",
            bytes.len(),
            query.len() * 4
        ));
    }
    let mut score = 0.0_f64;
    let mut squared_magnitude = 0.0_f64;
    for (index, (component, query_component)) in bytes.chunks_exact(4).zip(query).enumerate() {
        if index % 1024 == 0 && cancelled() {
            return Err("Native vector read cancelled.".into());
        }
        let component = f32::from_le_bytes(component.try_into().unwrap()) as f64;
        if !component.is_finite() {
            return Err(format!(
                "Stored vector {id} contains a non-finite component."
            ));
        }
        squared_magnitude += component * component;
        score += query_component * component;
    }
    if (squared_magnitude.sqrt() - 1.0).abs() > 0.002 {
        return Err(format!("Stored vector {id} is not L2-normalized."));
    }
    Ok(score.clamp(-1.0, 1.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn bytes(values: &[f32]) -> Vec<u8> {
        values.iter().flat_map(|v| v.to_le_bytes()).collect()
    }

    #[test]
    fn float32le_scalar_validation_and_clamp() {
        let vector = bytes(&[0.6, 0.8]);
        let expected = 0.6_f32 as f64 * 0.125 + 0.8_f32 as f64 * 0.5;
        assert_eq!(score(&vector, &[0.125, 0.5], "row").unwrap(), expected);
        assert_eq!(score(&vector, &[2.0, 2.0], "row").unwrap(), 1.0);
        assert!(score(&bytes(&[f32::NAN, 0.0]), &[1.0, 0.0], "bad")
            .unwrap_err()
            .contains("non-finite"));
        assert!(score(&bytes(&[0.0, 0.0]), &[1.0, 0.0], "bad")
            .unwrap_err()
            .contains("L2"));
        assert!(score(&vector[..4], &[1.0, 0.0], "bad")
            .unwrap_err()
            .contains("bytes"));
    }

    #[test]
    fn utf16_ties_keep_the_same_cutoff_as_javascript() {
        let mut heap = BinaryHeap::new();
        offer(
            &mut heap,
            Hit::new("\u{e000}".into(), "later".into(), 0.5),
            1,
        );
        offer(
            &mut heap,
            Hit::new("\u{10000}".into(), "first".into(), 0.5),
            1,
        );
        assert_eq!(heap.into_sorted_vec()[0].uri, "first");
    }

    #[test]
    fn accumulation_discriminates_fused_multiply_add() {
        let vector = [0.6_f32, 0.8_f32];
        let first = vector[0] as f64;
        let second = vector[1] as f64;
        let query = [-second / first, 1.0 + f64::EPSILON];
        let initial = query[0] * first;
        let product = query[1] * second;
        let separate = initial + product;
        let fused = query[1].mul_add(second, initial);
        assert_ne!(separate, fused, "this fixture must detect FMA");
        assert_eq!(score(&bytes(&vector), &query, "fma").unwrap(), separate);
    }
}
