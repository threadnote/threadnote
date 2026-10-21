import {Crypto, Data, Effect, FileSystem, Path} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  assertAutomaticMaintenanceAssessment,
  type AutomaticMaintenanceAssessmentV1,
} from '@threadnote/memory/automatic-maintenance';
import type {ConsolidationReceipt} from '@threadnote/memory/consolidation';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {ContextHealthCitationSourceExcerptV1} from '@threadnote/context/citation_validation';

const hashReceipt = (receipt: ConsolidationReceipt) => sha256HexSync(JSON.stringify(receipt));

export const AUTOMATIC_PREPARATION_MAPPER = 'exact-canonical-paragraph-v1';
export const AUTOMATIC_PREPARATION_MAX_BYTES = 512 * 1024;
export class AutomaticPreparationError extends Data.TaggedError('AutomaticPreparationError')<{
  readonly reason: 'cache-size-limit' | 'memory-fence-changed' | 'code-fence-changed';
}> {}
/** Disposable private scheduling data. Consumption must re-read target/source bytes and current access/scope,
 * assertAutomaticMaintenanceTarget, and revalidate the existing consolidation receipt against the live target.
 * Cached candidates and read vectors never confer review, apply, publication or historical-origin authority. */
export interface PreparedMemoryV1 {
  readonly version: 1;
  readonly mapper: typeof AUTOMATIC_PREPARATION_MAPPER;
  readonly assessment: AutomaticMaintenanceAssessmentV1;
  /** Exact re-read preconditions. Never use these as generation suppression identities. */
  readonly reads: readonly {readonly uri: string; readonly hash: string}[];
  readonly scopeRevision: string;
  readonly relevantRevision: string;
  readonly candidates: readonly {
    readonly evidenceId: string;
    readonly text: string;
    readonly excerpt?: ContextHealthCitationSourceExcerptV1;
  }[];
  /** Existing validated receipt, with its original revision and V2 origin/current separation intact. */
  readonly origin?: {readonly receiptHash: string; readonly receipt: ConsolidationReceipt};
  readonly omissions: readonly string[];
  readonly state: 'waiting-mapping' | 'assessed';
}
export interface AutomaticPreparationCursorV1 {
  readonly version: 1;
  readonly lastUri?: string;
}

const preparationPath = (path: Path.Path, config: RuntimeConfig, key: string) =>
  path.join(config.agentContextHome, 'context-maintenance', 'automatic', `${sha256HexSync(key)}.json`);
const readCache = Effect.fn('automaticPreparation.readCache')(function* (config: RuntimeConfig, key: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = preparationPath(path, config, key);
  return yield* Effect.gen(function* () {
    const info = yield* fs.stat(file);
    if (info.type !== 'File' || Number(info.size) > AUTOMATIC_PREPARATION_MAX_BYTES) return undefined;
    const text = yield* fs.readFileString(file);
    if (new TextEncoder().encode(text).byteLength > AUTOMATIC_PREPARATION_MAX_BYTES) return undefined;
    return yield* Effect.try((): unknown => JSON.parse(text));
  }).pipe(Effect.orElseSucceed(() => undefined));
});

export const readPreparedMemory = Effect.fn('automaticPreparation.readPrepared')(function* (
  config: RuntimeConfig,
  uri: string,
) {
  const value = yield* readCache(config, `target:${uri}`);
  return yield* Effect.try(() => {
    const prepared = value as PreparedMemoryV1;
    if (
      prepared?.version !== 1 ||
      prepared.mapper !== AUTOMATIC_PREPARATION_MAPPER ||
      prepared.assessment?.target.uri !== uri ||
      !Array.isArray(prepared.reads) ||
      !Array.isArray(prepared.candidates) ||
      !Array.isArray(prepared.omissions) ||
      !/^[0-9a-f]{64}$/u.test(prepared.scopeRevision) ||
      !/^[0-9a-f]{64}$/u.test(prepared.relevantRevision)
    )
      return undefined;
    assertAutomaticMaintenanceAssessment(prepared.assessment);
    if (
      prepared.reads.length > 16 ||
      new Set(prepared.reads.map(read => read.uri)).size !== prepared.reads.length ||
      prepared.reads.some(read => typeof read.uri !== 'string' || !/^[0-9a-f]{64}$/u.test(read.hash)) ||
      prepared.omissions.some(reason => typeof reason !== 'string' || reason.length > 128) ||
      !['waiting-mapping', 'assessed'].includes(prepared.state) ||
      prepared.candidates.length > 16
    )
      return undefined;
    for (const candidate of prepared.candidates) {
      const evidence = prepared.assessment.evidence.find(item => item.id === candidate.evidenceId);
      if (!evidence || typeof candidate.text !== 'string') return undefined;
      if (evidence.source.kind === 'memory' && sha256HexSync(candidate.text) !== evidence.source.fragment.hash)
        return undefined;
      if (
        candidate.excerpt &&
        (sha256HexSync(candidate.text) !== candidate.excerpt.excerptHash ||
          candidate.text !== candidate.excerpt.content)
      )
        return undefined;
    }
    if (prepared.origin && hashReceipt(prepared.origin.receipt) !== prepared.origin.receiptHash) return undefined;
    return prepared;
  }).pipe(Effect.orElseSucceed(() => undefined));
});
export const readAutomaticPreparationCursor = Effect.fn('automaticPreparation.readCursor')(function* (
  config: RuntimeConfig,
  scope?: string,
) {
  const value = (yield* readCache(config, `cursor:${scope ?? '*'}`)) as AutomaticPreparationCursorV1 | undefined;
  return value?.version === 1 && (value.lastUri === undefined || typeof value.lastUri === 'string')
    ? value
    : {version: 1 as const};
});
const writeCache = Effect.fn('automaticPreparation.writeCache')(function* (
  config: RuntimeConfig,
  key: string,
  value: unknown,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = preparationPath(path, config, key);
  const text = JSON.stringify(value);
  const previous = yield* readCache(config, key);
  if (previous !== undefined && JSON.stringify(previous) === text) return;
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength > AUTOMATIC_PREPARATION_MAX_BYTES)
    return yield* new AutomaticPreparationError({reason: 'cache-size-limit'});
  yield* fs.makeDirectory(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = `${file}.${yield* (yield* Crypto.Crypto).randomUUIDv4()}.tmp`;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fs.open(temporary, {flag: 'wx', mode: 0o600});
      yield* handle.writeAll(encoded);
      yield* handle.sync;
    }),
  ).pipe(
    Effect.andThen(fs.rename(temporary, file)),
    Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)),
  );
});
export const writePreparedMemory = (config: RuntimeConfig, prepared: PreparedMemoryV1) =>
  writeCache(config, `target:${prepared.assessment.target.uri}`, prepared);
export const writeAutomaticPreparationCursor = (config: RuntimeConfig, scope: string | undefined, lastUri: string) =>
  writeCache(config, `cursor:${scope ?? '*'}`, {version: 1, lastUri});
export const writeAutomaticPreparationFailure = (config: RuntimeConfig, uri: string, reason: string) =>
  writeCache(config, `target:${uri}`, {version: 1, uri, state: 'retry', reason});

/** Stable successor rotation: discovery order and one broken subject cannot monopolize turns. */
export function selectAutomaticPreparationUris(
  uris: readonly string[],
  lastUri: string | undefined,
  budget: number,
): readonly string[] {
  const ordered = [...new Set(uris)].sort();
  const pivot = lastUri === undefined ? -1 : ordered.findIndex(uri => uri > lastUri);
  const start = pivot < 0 ? 0 : pivot;
  return [...ordered.slice(start), ...ordered.slice(0, start)].slice(0, Math.max(1, Math.min(4, budget)));
}
