import {Effect, FileSystem, Option, Path} from 'effect';

import {credentialScrubberBlocker, SCRUBBER_PATTERNS} from '@threadnote/platform/scrubber';

import type {BundleMemberFile, SharedArtifactFile} from '../core.js';

import {
  BUNDLE_IGNORE_DIR_NAMES,
  BUNDLE_INSTALL_METADATA_FILE,
  BUNDLE_MANIFEST_FILE,
  OV_SUMMARY_FILES,
  pathJoin,
  pathRelative,
  pathSeparator,
  readFile,
  readdir,
} from '../core.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Array as EffectArray} from 'effect';

const collectBundleMemberFiles = Effect.fn('share.collectBundleMemberFiles')(function* (skillDir: string) {
  const out: BundleMemberFile[] = [];
  const visit: (dir: string) => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path> = Effect.fn(
    'share.visit',
  )(function* (dir: string) {
    const entries = yield* readdir(dir, {withFileTypes: true});
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const full = yield* pathJoin(dir, entry.name);
      if (entry.isDirectory()) {
        if (!BUNDLE_IGNORE_DIR_NAMES.includes(entry.name)) {
          yield* visit(full);
        }
        continue;
      }
      if (!entry.isFile() || isIgnoredBundleFile(entry.name)) {
        continue;
      }
      out.push({
        absolutePath: full,
        // oxlint-disable-next-line effecttsgo/prefer-effect-string -- This separator is not proven nonempty; native split returns [] for an empty receiver with an empty separator while Effect String split returns a nonempty array.
        relativePath: EffectArray.join((yield* pathRelative(skillDir, full)).split(yield* pathSeparator), '/'),
      });
    }
  });
  yield* visit(skillDir);
  return out.sort((a, b) => compareStrings(a.relativePath, b.relativePath));
});

function isIgnoredBundleFile(name: string): boolean {
  if (name === '.DS_Store' || name === BUNDLE_MANIFEST_FILE || name === BUNDLE_INSTALL_METADATA_FILE) {
    return true;
  }
  if (OV_SUMMARY_FILES.includes(name)) {
    return true;
  }
  return (
    Effect2.pipe(name, EffectString.endsWith('.log')) ||
    Effect2.pipe(name, EffectString.endsWith('.threadnote-install.json'))
  );
}

function isProbablyBinary(buffer: Uint8Array): boolean {
  if (buffer.includes(0)) {
    return true;
  }
  try {
    new TextDecoder('utf-8', {fatal: true}).decode(buffer);
    return false;
  } catch (_err: unknown) {
    return true;
  }
}

function detectBinaryCredential(buffer: Uint8Array): string | undefined {
  return credentialScrubberBlocker(new TextDecoder('latin1').decode(buffer));
}

// Scans binary bytes for a machine-local path that the pack rewriter would
// neutralize in text — a declared repo root, or a home-path soft-leak — so an
// --allow-binary member cannot silently carry one.
function detectBinaryLocalPath(buffer: Uint8Array, rewriteRoots: readonly string[]): string | undefined {
  const latin1 = new TextDecoder('latin1').decode(buffer);
  for (const root of rewriteRoots) {
    if (root.length > 0 && Effect2.pipe(latin1, EffectString.includes(root))) {
      return 'machine-local path';
    }
  }
  for (const pattern of SCRUBBER_PATTERNS) {
    if (pattern.placeholder !== undefined && pattern.regex.test(latin1)) {
      return pattern.name;
    }
  }
  return undefined;
}

const readFileBytesIfExists = Effect.fn('share.readFileBytesIfExists')(function* (path: string) {
  const bytes = yield* readFile(path).pipe(Effect.option);
  return Option.getOrUndefined(bytes);
});

function isBundleArtifact(artifact: SharedArtifactFile): boolean {
  if (artifact.artifact.kind === 'pack') {
    return true;
  }
  return artifact.members !== undefined && artifact.members.length > 1;
}

// Locale-independent ordering so manifests and git diffs are reproducible
// across machines regardless of the host locale.
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export {
  collectBundleMemberFiles,
  compareStrings,
  detectBinaryCredential,
  detectBinaryLocalPath,
  isBundleArtifact,
  isProbablyBinary,
  readFileBytesIfExists,
};
