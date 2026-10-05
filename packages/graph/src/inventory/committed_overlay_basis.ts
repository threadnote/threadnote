import {Effect} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION, codeGraphInventoryExclusionReason} from './policy.js';
import type {RepositoryIdentity} from '../types.js';
import type {GitTreeEntry, PolicyExclusionEntry} from '../inventory.js';

export interface CommittedOverlayBasis {
  readonly committedTreeEntries: ReadonlyMap<string, GitTreeEntry>;
  readonly committedPolicyExclusions: ReadonlyMap<string, PolicyExclusionEntry>;
  readonly projectRoots: readonly string[];
  readonly sourceRoots: readonly string[];
}

const MAX_ENTRIES = 20_000;
const MAX_STRING_BYTES = 4 * 1_048_576;
let cached: {readonly key: string; readonly basis: CommittedOverlayBasis} | undefined;

export function committedOverlayBasis<E, R>(
  identity: RepositoryIdentity,
  discoverRoots: (
    entries: readonly GitTreeEntry[],
  ) => Effect.Effect<{readonly projectRoots: readonly string[]; readonly sourceRoots: readonly string[]}, E, R>,
) {
  return Effect.gen(function* () {
    const key = JSON.stringify([
      identity.repoRoot,
      identity.gitCommonDirectory,
      identity.objectFormat,
      identity.headCommit,
      CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION,
    ]);
    if (cached?.key === key) return cached.basis;
    const allTreeEntries = /^0{40}(?:0{24})?$/.test(identity.headCommit)
      ? []
      : parseGitTree(
          (yield* runCommandEffect('git', ['-C', identity.repoRoot, 'ls-tree', '-r', '-l', '-z', identity.headCommit], {
            maxOutputBytes: 0,
            timeoutMs: 0,
          })).stdout,
        );
    const committedPolicyExclusions = policyExclusionsForEntries(allTreeEntries);
    const roots = yield* discoverRoots(allTreeEntries.filter(entry => !committedPolicyExclusions.has(entry.path)));
    const basis = {
      committedTreeEntries: new Map(allTreeEntries.map(entry => [entry.path, entry])),
      committedPolicyExclusions,
      projectRoots: roots.projectRoots,
      sourceRoots: roots.sourceRoots,
    } satisfies CommittedOverlayBasis;
    // Retain only one immutable HEAD basis; each caller still observes its dirty overlay.
    cached = retainable(key, allTreeEntries, roots) ? {key, basis} : undefined;
    return basis;
  });
}

function retainable(
  key: string,
  entries: readonly GitTreeEntry[],
  roots: Pick<CommittedOverlayBasis, 'projectRoots' | 'sourceRoots'>,
): boolean {
  if (entries.length > MAX_ENTRIES) return false;
  let upperBound = 3 * key.length;
  for (const entry of entries) {
    upperBound += 3 * entry.path.length + entry.blobId.length + entry.mode.length;
    if (upperBound > MAX_STRING_BYTES) return false;
  }
  for (const root of [...roots.projectRoots, ...roots.sourceRoots]) {
    upperBound += 3 * root.length;
    if (upperBound > MAX_STRING_BYTES) return false;
  }
  return true;
}

export function parseGitTree(output: string): readonly GitTreeEntry[] {
  const entries: GitTreeEntry[] = [];
  for (const record of output.split('\0')) {
    if (!record) continue;
    const match = /^([0-7]{6}) (blob|commit) ([0-9a-f]+) +(-|\d+)\t([\s\S]+)$/.exec(record);
    if (!match || match[2] !== 'blob' || match[1] === '120000' || match[4] === '-') continue;
    const size = Number(match[4]);
    if (!Number.isSafeInteger(size) || size < 0) continue;
    entries.push({blobId: match[3], mode: match[1], path: match[5].replace(/^\.\/+/, ''), size});
  }
  return entries;
}

export function policyExclusionsForEntries(entries: readonly GitTreeEntry[]): Map<string, PolicyExclusionEntry> {
  const exclusions = new Map<string, PolicyExclusionEntry>();
  for (const entry of entries) {
    const reason = codeGraphInventoryExclusionReason(entry.path, entry.size);
    if (reason !== undefined) exclusions.set(entry.path, {reason, size: entry.size});
  }
  return exclusions;
}
