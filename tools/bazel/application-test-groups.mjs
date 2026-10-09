/* oxlint-disable effecttsgo/node-builtin-import -- Target grouping runs before the declared Bazel graph exists. */
import {posix} from 'node:path';

const fnv1a = value => {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const tokens = path =>
  posix
    .basename(path, '.test.ts')
    .split(/[^a-zA-Z0-9]+/u)
    .filter(Boolean)
    .map(value => value.toLowerCase());

const nextPowerOfTwo = value => {
  let result = 1;
  while (result < value) result *= 2;
  return result;
};

const emitBucketed = (result, key, entries, maxEntries, targetEntries, prefix) => {
  if (entries.length <= maxEntries) {
    result.push({name: `test_standard_${prefix}${key}`, entries});
    return;
  }
  let bucketCount = nextPowerOfTwo(Math.ceil(entries.length / targetEntries));
  let buckets;
  do {
    buckets = Array.from({length: bucketCount}, () => []);
    for (const entry of entries) buckets[fnv1a(entry) % bucketCount].push(entry);
    if (buckets.every(bucket => bucket.length <= maxEntries)) break;
    bucketCount *= 2;
  } while (bucketCount <= 256);
  if (buckets.some(bucket => bucket.length > maxEntries))
    throw new Error(`Unable to bound generated application test group ${key}`);
  const width = String(bucketCount).length;
  buckets.forEach((bucket, index) => {
    if (bucket.length === 0) return;
    result.push({
      name: `test_standard_${prefix}${key}_${String(index + 1).padStart(width, '0')}_of_${bucketCount}`,
      entries: bucket,
    });
  });
};

const emitPooledFamilies = (result, families, maxEntries, targetEntries, prefix) => {
  const entries = families.flatMap(([, familyEntries]) => familyEntries);
  if (entries.length === 0) return;
  if (entries.length <= maxEntries) {
    result.push({name: `test_standard_${prefix}pooled`, entries: entries.sort()});
    return;
  }
  let bucketCount = nextPowerOfTwo(Math.ceil(entries.length / targetEntries));
  let buckets;
  do {
    buckets = Array.from({length: bucketCount}, () => []);
    for (const [family, familyEntries] of families) buckets[fnv1a(family) % bucketCount].push(...familyEntries);
    if (buckets.every(bucket => bucket.length <= maxEntries)) break;
    bucketCount *= 2;
  } while (bucketCount <= 256);
  if (buckets.some(bucket => bucket.length > maxEntries))
    throw new Error('Unable to bound generated pooled application test groups');
  const width = String(bucketCount).length;
  buckets.forEach((bucket, index) => {
    if (bucket.length === 0) return;
    result.push({
      name: `test_standard_${prefix}pooled_${String(index + 1).padStart(width, '0')}_of_${bucketCount}`,
      entries: bucket.sort(),
    });
  });
};

/**
 * Builds deterministic, readable application-test groups without maintaining a
 * target list by hand. Large feature families split into stable hash buckets.
 */
export function groupApplicationTests(
  paths,
  {maxEntries = 40, minFeatureEntries = 12, targetEntries = 24, affinities = {}} = {},
) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('maxEntries must be positive');
  if (!Number.isSafeInteger(targetEntries) || targetEntries < 1 || targetEntries > maxEntries)
    throw new Error('targetEntries must be between one and maxEntries');
  if (!Number.isSafeInteger(minFeatureEntries) || minFeatureEntries < 1 || minFeatureEntries > maxEntries)
    throw new Error('minFeatureEntries must be between one and maxEntries');
  const entries = [...new Set(paths)].sort();
  if (entries.length !== paths.length) throw new Error('Application test paths must be unique');
  const byAffinity = new Map();
  for (const entry of entries) {
    const affinity = affinities[entry] ?? '';
    if (!byAffinity.has(affinity)) byAffinity.set(affinity, []);
    byAffinity.get(affinity).push(entry);
  }
  const result = [];
  for (const [affinity, affinityEntries] of [...byAffinity].sort(([left], [right]) => left.localeCompare(right))) {
    const prefix = affinity ? `${affinity}_` : '';
    const primary = new Map();
    for (const entry of affinityEntries) {
      const [first = 'misc'] = tokens(entry);
      if (!primary.has(first)) primary.set(first, []);
      primary.get(first).push(entry);
    }
    const pooled = [];
    for (const [first, firstEntries] of [...primary].sort(([left], [right]) => left.localeCompare(right))) {
      if (firstEntries.length <= maxEntries) {
        if (firstEntries.length < minFeatureEntries) pooled.push([first, firstEntries]);
        else emitBucketed(result, first, firstEntries, maxEntries, targetEntries, prefix);
        continue;
      }
      const secondary = new Map();
      for (const entry of firstEntries) {
        const [, second = 'misc'] = tokens(entry);
        if (!secondary.has(second)) secondary.set(second, []);
        secondary.get(second).push(entry);
      }
      for (const [second, secondEntries] of [...secondary].sort(([left], [right]) => left.localeCompare(right))) {
        const key = `${first}_${second}`;
        if (secondEntries.length < minFeatureEntries) pooled.push([key, secondEntries]);
        else emitBucketed(result, key, secondEntries, maxEntries, targetEntries, prefix);
      }
    }
    emitPooledFamilies(result, pooled, maxEntries, targetEntries, prefix);
  }
  return result.sort((left, right) => left.name.localeCompare(right.name));
}
