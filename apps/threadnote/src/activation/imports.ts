import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Path, Schema} from 'effect';
import {getAgentAdapter} from '../agent_integration/adapters.js';
import {readBoundedContainedStableRegularFile} from '@threadnote/graph/inventory/contained_file';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {collectGuidanceImportSourcesAtRoot} from '../guidance/index.js';
import {credentialScrubberBlocker} from '@threadnote/platform/scrubber';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const MAXIMUM_IMPORT_BYTES = 60 * 1024;
const MAXIMUM_IMPORT_SOURCES = 64;
const MAXIMUM_SELECTED_SURFACES = 16;

export class ActivationImportError extends Schema.TaggedError<ActivationImportError, {readonly brand: unique symbol}>()(
  'ActivationImportError',
  {
    message: Schema.String,
  },
) {}

export interface ActivationImportOptionsV1 {
  readonly adrPaths: readonly string[];
  readonly repositoryRoot: string;
  readonly surfaceIds: readonly string[];
}

export interface ActivationImportSourceV1 {
  readonly contentHash: string;
  readonly kinds: readonly ('adr' | 'guidance')[];
  readonly relativePath: string;
  readonly sourceId: string;
  readonly surfaceIds: readonly string[];
}

export interface ActivationImportReviewCandidateV1 {
  readonly candidateId: string;
  readonly contentHash: string;
  readonly proposedText: string;
  readonly sourceIds: readonly string[];
}

export interface ActivationImportPreviewV1 {
  readonly candidates: readonly ActivationImportReviewCandidateV1[];
  readonly mode: 'preview';
  readonly sourceSetHash: string;
  readonly sources: readonly ActivationImportSourceV1[];
  readonly version: 1;
}

interface ImportObservation {
  readonly contentHash: string;
  readonly kind: 'adr' | 'guidance';
  readonly relativePath: string;
  readonly surfaceId?: string;
  readonly text: string;
}

interface MergedImportSource {
  readonly contentHash: string;
  readonly kinds: readonly ('adr' | 'guidance')[];
  readonly relativePath: string;
  readonly surfaceIds: readonly string[];
  readonly text: string;
}

const collectActivationImportPreviewEffect = Effect.fn('activation.imports.collectPreview')(function* (
  options: ActivationImportOptionsV1,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!path.isAbsolute(options.repositoryRoot))
    return yield* activationImportFailure('Activation imports require an absolute repository root.');
  const selectedRoot = path.resolve(options.repositoryRoot);
  yield* assertDirectory(fs, selectedRoot);
  const root = yield* fs.realPath(selectedRoot);
  const adrPaths = yield* checked(() => validateAdrPaths(options.adrPaths));
  const adapters = yield* checked(() => validateSurfaceIds(options.surfaceIds));
  const guidance = yield* Effect.forEach(adapters, adapter =>
    adapter.guidance === undefined
      ? Effect.succeed([])
      : collectGuidanceImportSourcesAtRoot(adapter, root).pipe(
          Effect.map(sources =>
            EffectArray.map(
              sources,
              source =>
                ({...source, kind: 'guidance' as const, surfaceId: adapter.catalog.id}) satisfies ImportObservation,
            ),
          ),
        ),
  );
  const adrs = yield* Effect.forEach(adrPaths, relativePath => readAdr(fs, path, root, relativePath));
  const merged = yield* checked(() => mergeObservations([...guidance.flat(), ...adrs]));
  if (merged.length > MAXIMUM_IMPORT_SOURCES)
    return yield* activationImportFailure(`Activation import accepts at most ${MAXIMUM_IMPORT_SOURCES} sources.`);
  const totalBytes = EffectArray.reduce(merged, 0, (sum, source) => sum + utf8Bytes(source.text));
  if (totalBytes > MAXIMUM_IMPORT_BYTES)
    return yield* activationImportFailure(`Activation import exceeds ${MAXIMUM_IMPORT_BYTES} total bytes.`);
  const sources = EffectArray.map(merged, source => publicSource(source));
  const candidates = reviewCandidates(merged, sources);
  for (const candidate of candidates) {
    const blocker = credentialScrubberBlocker(candidate.proposedText);
    if (blocker)
      return yield* activationImportFailure(`Activation import contains ${blocker}; no review candidate was emitted.`);
  }
  const sourceSetHash = sha256HexSync(
    JSON.stringify(
      EffectArray.map(sources, ({contentHash, kinds, relativePath, surfaceIds}) => ({
        contentHash,
        kinds,
        relativePath,
        surfaceIds,
      })),
    ),
  );
  return {
    candidates,
    mode: 'preview',
    sourceSetHash,
    sources,
    version: 1,
  } satisfies ActivationImportPreviewV1;
});

export function collectActivationImportPreview(options: ActivationImportOptionsV1) {
  return collectActivationImportPreviewEffect(options).pipe(
    Effect.mapError(cause =>
      Schema.is(ActivationImportError)(cause)
        ? cause
        : activationImportFailure(causeMessage(cause, 'Activation import evidence is unavailable.')),
    ),
  );
}

function validateAdrPaths(paths: readonly string[]): readonly string[] {
  if (paths.length > MAXIMUM_IMPORT_SOURCES)
    throw activationImportFailure(`Activation import accepts at most ${MAXIMUM_IMPORT_SOURCES} ADR paths.`);
  const canonical = EffectArray.map(paths, value => {
    if (
      value.length === 0 ||
      value !== Effect2.pipe(value, EffectString.trim) ||
      Effect2.pipe(value, EffectString.includes('\\')) ||
      Effect2.pipe(value, EffectString.includes('\u0000')) ||
      Effect2.pipe(value, EffectString.includes('://')) ||
      Effect2.pipe(value, EffectString.startsWith('/')) ||
      EffectArray.some(
        Effect2.pipe(value, EffectString.split('/')),
        segment => segment === '' || segment === '.' || segment === '..',
      )
    )
      throw activationImportFailure('ADR paths must be canonical repository-relative local paths.');
    return value;
  });
  if (new Set(canonical).size !== canonical.length) throw activationImportFailure('Select each ADR path exactly once.');
  return canonical.sort(compareText);
}

function validateSurfaceIds(selectors: readonly string[]) {
  if (selectors.length > MAXIMUM_SELECTED_SURFACES)
    throw activationImportFailure(`Activation import accepts at most ${MAXIMUM_SELECTED_SURFACES} agent surfaces.`);
  const adapters = EffectArray.map(selectors, selector => {
    const adapter = getAgentAdapter(selector);
    if (!adapter) throw activationImportFailure(`Unknown agent surface: ${selector}`);
    return adapter;
  });
  const ids = EffectArray.map(adapters, adapter => adapter.catalog.id);
  if (new Set(ids).size !== ids.length)
    throw activationImportFailure('Select each catalog agent surface exactly once.');
  return adapters.sort((left, right) => compareText(left.catalog.id, right.catalog.id));
}

const readAdr = Effect.fn('activation.imports.readAdr')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  relativePath: string,
) {
  const target = path.resolve(root, relativePath);
  if (target === root || !Effect2.pipe(target, EffectString.startsWith(`${root}${path.sep}`)))
    return yield* activationImportFailure('ADR path escapes the repository root.');
  const bytes = yield* readBoundedContainedStableRegularFile(fs, path, root, relativePath, MAXIMUM_IMPORT_BYTES);
  const text = yield* checked(() => decodeExactText(bytes, relativePath));
  const proposedText = Effect2.pipe(text, EffectString.trim);
  if (!proposedText) return yield* activationImportFailure(`Selected ADR is empty: ${relativePath}`);
  return {
    contentHash: sha256HexSync(text),
    kind: 'adr',
    relativePath,
    text: proposedText,
  } satisfies ImportObservation;
});

function mergeObservations(observations: readonly ImportObservation[]): readonly MergedImportSource[] {
  const byPath = new Map<string, ImportObservation[]>();
  for (const observation of observations) {
    const entries = byPath.get(observation.relativePath) ?? [];
    entries.push(observation);
    byPath.set(observation.relativePath, entries);
  }
  return EffectArray.map(
    [...byPath.entries()].sort(([left], [right]) => compareText(left, right)),
    ([relativePath, entries]) => {
      const first = entries[0];
      if (EffectArray.some(entries, entry => entry.contentHash !== first.contentHash || entry.text !== first.text))
        throw activationImportFailure(`Selected import source is ambiguous or changed while reading: ${relativePath}`);
      return {
        contentHash: first.contentHash,
        kinds: [...new Set(EffectArray.map(entries, entry => entry.kind))].sort(compareText),
        relativePath,
        surfaceIds: [
          ...new Set(EffectArray.flatMap(entries, entry => (entry.surfaceId ? [entry.surfaceId] : []))),
        ].sort(compareText),
        text: first.text,
      };
    },
  );
}

function publicSource(source: MergedImportSource): ActivationImportSourceV1 {
  const metadata = {
    contentHash: source.contentHash,
    kinds: source.kinds,
    relativePath: source.relativePath,
    surfaceIds: source.surfaceIds,
  };
  return {
    ...metadata,
    sourceId: `activation-source-${Effect2.pipe(sha256HexSync(JSON.stringify(metadata)), EffectString.slice(0, 24))}`,
  };
}

function reviewCandidates(
  merged: readonly MergedImportSource[],
  sources: readonly ActivationImportSourceV1[],
): readonly ActivationImportReviewCandidateV1[] {
  const byTextHash = new Map<string, {readonly sourceIds: string[]; readonly text: string}>();
  for (const [index, source] of merged.entries()) {
    if (!source.text) continue;
    const contentHash = sha256HexSync(source.text);
    const group = byTextHash.get(contentHash) ?? {sourceIds: [], text: source.text};
    group.sourceIds.push(sources[index].sourceId);
    byTextHash.set(contentHash, group);
  }
  return EffectArray.map(
    [...byTextHash.entries()].sort(([left], [right]) => compareText(left, right)),
    ([contentHash, group]) => ({
      candidateId: `activation-candidate-${Effect2.pipe(
        sha256HexSync(JSON.stringify({contentHash, sourceIds: group.sourceIds})),
        EffectString.slice(0, 24),
      )}`,
      contentHash,
      proposedText: group.text,
      sourceIds: group.sourceIds,
    }),
  );
}

function decodeExactText(bytes: Uint8Array, relativePath: string): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
  } catch {
    throw activationImportFailure(`Selected ADR must be strict UTF-8 text: ${relativePath}`);
  }
  const encoded = new TextEncoder().encode(text);
  if (
    Effect2.pipe(text, EffectString.includes('\u0000')) ||
    bytes.byteLength !== encoded.byteLength ||
    !bytes.every((value, index) => value === encoded[index])
  )
    throw activationImportFailure(`Selected ADR must be exact, NUL-free UTF-8 text: ${relativePath}`);
  return text;
}

function assertDirectory(fs: FileSystem.FileSystem, root: string) {
  return fs
    .stat(root)
    .pipe(
      Effect.flatMap(info =>
        info.type === 'Directory'
          ? Effect.void
          : activationImportFailure('Activation import repository root must be a directory.'),
      ),
    );
}

function activationImportFailure(message: string): ActivationImportError {
  return ActivationImportError.make({message});
}

function checked<A>(evaluate: () => A): Effect.Effect<A, ActivationImportError> {
  return Effect.try({
    try: evaluate,
    catch: cause =>
      Schema.is(ActivationImportError)(cause)
        ? cause
        : activationImportFailure(causeMessage(cause, 'Activation import validation failed.')),
  });
}

function causeMessage(cause: unknown, fallback: string): string {
  return typeof cause === 'object' && cause !== null && 'message' in cause && typeof cause.message === 'string'
    ? cause.message
    : fallback;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
