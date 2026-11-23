const INVALID_ARGUMENT: i32 = i32::MIN;
const MAX_ROWS: usize = 400;
const COMPONENT_BYTES: usize = size_of::<f32>();

/// Returns zero for a valid page. A positive one-based row reports a non-finite
/// component. A negative one-based row reports a vector outside the unit tolerance.
fn validate_page(bytes: &[u8], dimensions: u32) -> i32 {
    let Some(row_bytes) = (dimensions as usize).checked_mul(COMPONENT_BYTES) else {
        return INVALID_ARGUMENT;
    };
    if row_bytes == 0 || bytes.len() % row_bytes != 0 || bytes.len() / row_bytes > MAX_ROWS {
        return INVALID_ARGUMENT;
    }

    for (index, row) in bytes.chunks_exact(row_bytes).enumerate() {
        let mut sum = 0.0;
        for component in row.as_chunks::<COMPONENT_BYTES>().0 {
            let value = f64::from(f32::from_le_bytes(*component));
            if !value.is_finite() {
                return index as i32 + 1;
            }
            sum += value * value;
        }
        if (sum.sqrt() - 1.0).abs() > 0.002 {
            return -(index as i32 + 1);
        }
    }
    0
}

/// # Safety
///
/// For the duration of the call, `bytes` must point to `byte_length` readable,
/// initialized bytes in one allocation. The caller must prevent concurrent writes.
/// The function does not retain the pointer. Byte alignment suffices.
#[no_mangle]
pub unsafe extern "C" fn threadnote_validate_graph_vector_page(
    bytes: *const u8,
    byte_length: u32,
    dimensions: u32,
) -> i32 {
    let byte_length = byte_length as usize;
    if bytes.is_null() || byte_length > isize::MAX as usize {
        return INVALID_ARGUMENT;
    }
    // SAFETY: The caller supplies the readable extent of its live typed-array view.
    let bytes = unsafe { std::slice::from_raw_parts(bytes, byte_length) };
    validate_page(bytes, dimensions)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(components: &[f32]) -> Vec<u8> {
        components
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect()
    }

    #[test]
    fn accepts_float32_rounding_and_rejects_rows_in_order() {
        assert_eq!(validate_page(&page(&[1.0019, -0.0, 0.9981, 0.0]), 2), 0);
        assert_eq!(
            validate_page(&page(&[1.0, 0.0, 0.9979, 0.0, f32::NAN, 0.0]), 2),
            -2
        );
        assert_eq!(
            validate_page(&page(&[1.0, 0.0, 10.0, f32::NAN, 0.0, 0.0]), 2),
            2
        );
        assert_eq!(validate_page(&page(&[1.0, f32::NEG_INFINITY]), 2), 1);
        assert_eq!(validate_page(&page(&[1.0]), 2), INVALID_ARGUMENT);
        assert_eq!(validate_page(&page(&[1.0]), 0), INVALID_ARGUMENT);
        assert_eq!(validate_page(&page(&[1.0; 401]), 1), INVALID_ARGUMENT);
    }

    #[test]
    fn reads_an_unaligned_view_extent() {
        let mut backing = vec![0xff];
        backing.extend(page(&[1.0, -0.0]));
        backing.extend([0xff; 4]);
        // SAFETY: The call reads the eight initialized bytes inside backing.
        let result =
            unsafe { threadnote_validate_graph_vector_page(backing.as_ptr().add(1), 8, 2) };
        assert_eq!(result, 0);
    }
}
