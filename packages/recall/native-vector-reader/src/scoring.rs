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

// Match from_utf8_lossy by emitting one replacement code unit per invalid chunk.
fn lossy_utf16(id: &[u8]) -> impl Iterator<Item = u16> + '_ {
    id.utf8_chunks().flat_map(|chunk| {
        chunk
            .valid()
            .encode_utf16()
            .chain((!chunk.invalid().is_empty()).then_some(0xfffd))
    })
}

pub fn offer(heap: &mut BinaryHeap<Hit>, id: &[u8], uri: &[u8], score: f64, limit: usize) {
    let owned_hit = || Hit {
        key: lossy_utf16(id).collect(),
        uri: String::from_utf8_lossy(uri).into_owned(),
        score,
    };
    if heap.len() < limit {
        heap.push(owned_hit());
    } else if let Some(worst) = heap.peek() {
        if score > worst.score
            || (score == worst.score && lossy_utf16(id).cmp(worst.key.iter().copied()).is_lt())
        {
            *heap.peek_mut().unwrap() = owned_hit();
        }
    }
}

/// Rust's default strict floating-point operations preserve this ordered multiply/add.
/// Do not replace either accumulation with mul_add, SIMD reductions or fast-math.
#[cfg(test)]
pub fn score(bytes: &[u8], query: &[f64], id: &str) -> Result<f64, String> {
    score_with_cancel(bytes, query, id.as_bytes(), || false)
}

pub fn score_with_cancel(
    bytes: &[u8],
    query: &[f64],
    id: &[u8],
    mut cancelled: impl FnMut() -> bool,
) -> Result<f64, String> {
    if bytes.len() != query.len() * 4 {
        return Err(format!(
            "Stored vector {} has {} bytes; expected {}.",
            String::from_utf8_lossy(id),
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
                "Stored vector {} contains a non-finite component.",
                String::from_utf8_lossy(id)
            ));
        }
        squared_magnitude += component * component;
        score += query_component * component;
    }
    if (squared_magnitude.sqrt() - 1.0).abs() > 0.002 {
        return Err(format!(
            "Stored vector {} is not L2-normalized.",
            String::from_utf8_lossy(id)
        ));
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
        offer(&mut heap, "\u{e000}".as_bytes(), b"later", 0.5, 1);
        offer(&mut heap, "\u{10000}".as_bytes(), b"first", 0.5, 1);
        assert_eq!(heap.into_sorted_vec()[0].uri, "first");
    }

    #[test]
    fn malformed_utf8_ties_use_the_same_replacements_as_owned_hits() {
        let mut heap = BinaryHeap::new();
        offer(&mut heap, b"\xffz", b"later", 0.5, 1);
        offer(&mut heap, b"\xe2\x82a", b"first\xff", 0.5, 1);
        offer(&mut heap, "\u{fffd}a".as_bytes(), b"equal", 0.5, 1);
        let hit = &heap.into_sorted_vec()[0];
        assert_eq!(hit.uri, "first\u{fffd}");
        assert_eq!(
            hit.key,
            String::from_utf8_lossy(b"\xe2\x82a")
                .encode_utf16()
                .collect::<Vec<_>>()
        );
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
