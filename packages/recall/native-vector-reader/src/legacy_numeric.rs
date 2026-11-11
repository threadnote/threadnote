/*
 * Copyright (C) 2024-2026 Apple Inc. All rights reserved.
 * Copyright (C) 2018-2026 the V8 project authors. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY APPLE INC. ``AS IS'' AND ANY
 * EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
 * PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL APPLE INC. OR
 * CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
 * EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
 * PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 * PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY
 * OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
/*
 * Copyright (c) 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010,
 * 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018 Python Software Foundation;
 * All Rights Reserved
 *
 * Part of the implementation, e.g. galloping merge, is coming from Python's TimSort.
 *
 * https://github.com/python/cpython/blob/master/Objects/listobject.c
 *
 * Detailed analysis and a description of the algorithm can be found at:
 *
 * https://github.com/python/cpython/blob/master/Objects/listsort.txt
 */

//! Compatibility sort for the legacy JS comparator, which is non-transitive
//! when intermediate scoring produces NaN. Ordinary finite scores use the heap.
//! Keep this control flow synchronized with pinned Bun 1.4.4 / WebKit
//! d6375c72affe0f70222cdcb45012b10f0bf3a9d5 StableSort.h (galloping Powersort).
use crate::scoring::Hit;

pub fn js_max(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        f64::NAN
    } else {
        left.max(right)
    }
}

/// Array.slice(0, end): negative ends are relative to the current array length.
pub fn slice_end(end: f64, length: usize) -> usize {
    if end.is_nan() {
        0
    } else if end < 0.0 {
        (length as f64 + end.trunc()).max(0.0) as usize
    } else {
        end.min(length as f64).trunc() as usize
    }
}

fn less(left: &Hit, right: &Hit) -> bool {
    let difference = right.score - left.score;
    if difference != 0.0 && !difference.is_nan() {
        difference < 0.0
    } else {
        left.key < right.key
    }
}

// A cancellation checkpoint on every comparison also bounds insertion and
// galloping work; no JS callback or native resource escapes the owning operation.
struct Sort<'a, F: FnMut() -> Result<(), String>> {
    values: &'a mut [Hit],
    work: Vec<Hit>,
    checkpoint: F,
    min_gallop: usize,
}
impl<F: FnMut() -> Result<(), String>> Sort<'_, F> {
    fn less(&mut self, left: usize, right: usize) -> Result<bool, String> {
        (self.checkpoint)()?;
        Ok(less(&self.values[left], &self.values[right]))
    }
    fn insertion(&mut self, begin: usize, size: usize, header: usize) -> Result<(), String> {
        for i in header + 1..size {
            let mut left = 0;
            let mut right = i;
            while left < right {
                let middle = left + (right - left) / 2;
                if !self.less(begin + i, begin + middle)? {
                    left = middle + 1;
                } else {
                    right = middle;
                }
            }
            self.values[begin + left..=begin + i].rotate_right(1);
        }
        Ok(())
    }
    fn normalize(&mut self, begin: usize) -> Result<(usize, usize), String> {
        let mut end = begin;
        if end + 1 < self.values.len() {
            let descending = self.less(end + 1, end)?;
            end += 1;
            while end + 1 < self.values.len() {
                let next_less = self.less(end + 1, end)?;
                if if descending { !next_less } else { next_less } {
                    break;
                }
                end += 1;
            }
            if descending {
                self.values[begin..=end].reverse();
            }
        }
        if end - begin < 8 {
            let size = 64.min(self.values.len() - begin);
            self.insertion(begin, size, end - begin)?;
            end = begin + size - 1;
        }
        while end + 1 < self.values.len() {
            if self.less(end + 1, end)? {
                break;
            }
            end += 1;
        }
        Ok((begin, end))
    }
    fn gallop(
        &mut self,
        key: usize,
        start: usize,
        length: usize,
        hint: usize,
        right: bool,
    ) -> Result<usize, String> {
        let mut last: isize = 0;
        let mut offset: isize = 1;
        let compare = if right {
            self.less(key, start + hint)?
        } else {
            self.less(start + hint, key)?
        };
        if compare == right {
            let max = hint as isize + 1;
            while offset < max {
                let result = if right {
                    self.less(key, start + hint - offset as usize)?
                } else {
                    self.less(start + hint - offset as usize, key)?
                };
                if result != right {
                    break;
                }
                last = offset;
                offset = (offset * 2 + 1).min(max);
            }
            let previous = last;
            last = hint as isize - offset;
            offset = hint as isize - previous;
        } else {
            let max = (length - hint) as isize;
            while offset < max {
                let result = if right {
                    self.less(key, start + hint + offset as usize)?
                } else {
                    self.less(start + hint + offset as usize, key)?
                };
                if result == right {
                    break;
                }
                last = offset;
                offset = (offset * 2 + 1).min(max);
            }
            last += hint as isize;
            offset += hint as isize;
        }
        last += 1;
        while last < offset {
            let middle = last + (offset - last) / 2;
            let result = if right {
                self.less(key, start + middle as usize)?
            } else {
                self.less(start + middle as usize, key)?
            };
            if result == right {
                offset = middle;
            } else {
                last = middle + 1;
            }
        }
        Ok(offset as usize)
    }
    fn copy(&mut self, destination: usize, source: usize, count: usize) {
        self.work[destination..destination + count]
            .clone_from_slice(&self.values[source..source + count]);
    }
    fn merge(
        &mut self,
        start1: usize,
        end1: usize,
        start2: usize,
        end2: usize,
    ) -> Result<(), String> {
        let left_length = end1 - start1;
        let right_length = end2 - start2;
        if left_length == 0 || right_length == 0 {
            self.copy(start1, start1, end2 - start1);
            return Ok(());
        }
        let skip_left = self.gallop(start2, start1, left_length, 0, true)?;
        self.copy(start1, start1, skip_left);
        let mut left = start1 + skip_left;
        if left == end1 {
            self.copy(start2, start2, right_length);
            return Ok(());
        }
        let skip_right =
            right_length - self.gallop(end1 - 1, start2, right_length, right_length - 1, false)?;
        self.copy(end2 - skip_right, end2 - skip_right, skip_right);
        let right_end = end2 - skip_right;
        if start2 == right_end {
            self.copy(left, left, end1 - left);
            return Ok(());
        }
        let mut right = start2;
        let mut destination = left;
        'merge: loop {
            let mut left_wins = 0;
            let mut right_wins = 0;
            while left_wins < self.min_gallop && right_wins < self.min_gallop {
                if right >= right_end || left >= end1 {
                    break 'merge;
                }
                if self.less(right, left)? {
                    self.copy(destination, right, 1);
                    right += 1;
                    right_wins += 1;
                    left_wins = 0;
                } else {
                    self.copy(destination, left, 1);
                    left += 1;
                    left_wins += 1;
                    right_wins = 0;
                }
                destination += 1;
            }
            self.min_gallop += 1;
            loop {
                if self.min_gallop > 1 {
                    self.min_gallop -= 1;
                }
                if left >= end1 || right >= right_end {
                    break 'merge;
                }
                let count = self.gallop(right, left, end1 - left, 0, true)?;
                left_wins = count;
                self.copy(destination, left, count);
                destination += count;
                left += count;
                self.copy(destination, right, 1);
                destination += 1;
                right += 1;
                if left >= end1 || right >= right_end {
                    break 'merge;
                }
                let count = self.gallop(left, right, right_end - right, 0, false)?;
                right_wins = count;
                self.copy(destination, right, count);
                destination += count;
                right += count;
                self.copy(destination, left, 1);
                destination += 1;
                left += 1;
                if left >= end1 || right >= right_end {
                    break 'merge;
                }
                if left_wins < 7 && right_wins < 7 {
                    break;
                }
            }
            self.min_gallop += 1;
        }
        self.copy(destination, left, end1 - left);
        destination += end1 - left;
        self.copy(destination, right, right_end - right);
        Ok(())
    }
    fn merge_back(&mut self, begin: usize, middle: usize, end: usize) -> Result<(), String> {
        self.merge(begin, middle, middle, end + 1)?;
        self.values[begin..=end].clone_from_slice(&self.work[begin..=end]);
        Ok(())
    }
}

pub fn sort(
    values: &mut [Hit],
    checkpoint: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    if values.is_empty() {
        return Ok(());
    }
    let work = values.to_vec();
    let mut sorter = Sort {
        values,
        work,
        checkpoint,
        min_gallop: 7,
    };
    if sorter.values.len() < 8 {
        return sorter.insertion(0, sorter.values.len(), 0);
    }
    let power = |left: usize, middle: usize, right: usize, n: usize| {
        let a = (((left as u128) * 2 + (middle - left) as u128) << 62) / n as u128;
        let b = (((middle as u128) * 2 + (right - middle + 1) as u128) << 62) / n as u128;
        ((a ^ b) as u64).leading_zeros()
    };
    let mut stack = Vec::new();
    let mut run = sorter.normalize(0)?;
    while run.1 + 1 < sorter.values.len() {
        let next = sorter.normalize(run.1 + 1)?;
        let p = power(run.0, next.0, next.1, sorter.values.len());
        while stack
            .last()
            .is_some_and(|entry: &(usize, usize, u32)| entry.2 > p)
        {
            let previous = stack.pop().unwrap();
            sorter.merge_back(previous.0, run.0, run.1)?;
            run.0 = previous.0;
        }
        stack.push((run.0, run.1, p));
        run = next;
    }
    while let Some(previous) = stack.pop() {
        sorter.merge_back(previous.0, run.0, run.1)?;
        run.0 = previous.0;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_sort_remains_cooperatively_cancellable() {
        let mut hits: Vec<_> = (0..801)
            .map(|index| {
                Hit::new(
                    format!("{index:06}"),
                    format!("uri{index}"),
                    if index % 3 == 0 {
                        f64::NAN
                    } else {
                        (index % 7) as f64 / 7.0
                    },
                )
            })
            .collect();
        let mut comparisons = 0;
        let result = sort(&mut hits, || {
            comparisons += 1;
            if comparisons == 97 {
                Err("cancelled".into())
            } else {
                Ok(())
            }
        });
        assert_eq!(result, Err("cancelled".into()));
        assert_eq!(comparisons, 97);
    }
}
