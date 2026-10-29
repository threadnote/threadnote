import * as EffectString from 'effect/String';
import * as Effect from 'effect';
/**
 * Parses Git's stable porcelain-v1 `-z` contract. Rename/copy records use the
 * documented destination-then-source order, while untracked rows remain
 * distinguishable for exact overlay admission.
 */
export function parsePorcelainV1Status(output: string): {
  readonly added: Set<string>;
  readonly changed: Set<string>;
  readonly deleted: Set<string>;
  readonly untracked: Set<string>;
} {
  const added = new Set<string>();
  const changed = new Set<string>();
  const deleted = new Set<string>();
  const untracked = new Set<string>();
  const fields = Effect.pipe(output, EffectString.split('\0'));
  for (let index = 0; index < fields.length;) {
    const record = fields[index++];
    if (!record || record.length < 4 || record[2] !== ' ') continue;
    const status = Effect.pipe(record, EffectString.slice(0, 2));
    const path = normalizeRepositoryPath(Effect.pipe(record, EffectString.slice(3)));
    if (!path) continue;
    if (status === '??') {
      added.add(path);
      changed.add(path);
      untracked.add(path);
      continue;
    }
    const rename = Effect.pipe(status, EffectString.includes('R'));
    const copy = Effect.pipe(status, EffectString.includes('C'));
    if (rename || copy) {
      const source = normalizeRepositoryPath(fields[index++] ?? '');
      if (rename && source) deleted.add(source);
      added.add(path);
      changed.add(path);
      continue;
    }
    const [indexStatus, worktreeStatus] = status;
    // Every two-letter unmerged state containing D still represents a
    // conflicted worktree path. Only the ordinary staged/unstaged delete
    // states remove the path without hashing a possible conflict file.
    if (status === 'D ' || status === ' D') {
      deleted.add(path);
      continue;
    }
    if (status !== '  ' && status !== '!!') {
      changed.add(path);
      if (indexStatus === 'A' || worktreeStatus === 'A') added.add(path);
    }
  }
  return {added, changed, deleted, untracked};
}

/** Parses the NUL-delimited source-then-destination records from Git diff --name-status. */
export function parseNameStatus(output: string): {
  readonly added: Set<string>;
  readonly changed: Set<string>;
  readonly deleted: Set<string>;
} {
  const added = new Set<string>();
  const changed = new Set<string>();
  const deleted = new Set<string>();
  const fields = Effect.pipe(output, EffectString.split('\0'));
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) continue;
    const first = normalizeRepositoryPath(fields[index++] ?? '');
    if (Effect.pipe(status, EffectString.startsWith('R')) || Effect.pipe(status, EffectString.startsWith('C'))) {
      const second = normalizeRepositoryPath(fields[index++] ?? '');
      if (Effect.pipe(status, EffectString.startsWith('R')) && first) deleted.add(first);
      if (second) {
        added.add(second);
        changed.add(second);
      }
    } else if (Effect.pipe(status, EffectString.startsWith('D'))) {
      if (first) deleted.add(first);
    } else if (first) {
      changed.add(first);
      if (Effect.pipe(status, EffectString.startsWith('A'))) added.add(first);
    }
  }
  return {added, changed, deleted};
}

function normalizeRepositoryPath(value: string): string {
  return Effect.pipe(value, EffectString.replace(/^\.\/+/, ''));
}
