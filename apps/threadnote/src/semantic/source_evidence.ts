import * as EffectArray from 'effect/Array';
import * as EffectString from 'effect/String';
import {Context, Effect, Path, Schema} from 'effect';
import {Observation, observationKey, FileUri, Digest, type QueryOutcome} from '@threadnote/semantic/contracts';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  runtimePlatform,
  runtimeCaptureWindowsSource,
  runtimeSameWindowsSourceEvidence,
  runtimeExportWindowsSourceWitness,
  type RuntimeWindowsSourceEvidence,
} from '@threadnote/platform/system';
const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !EffectArray.isArray(value);

export class SemanticSessionFault extends Schema.TaggedError<SemanticSessionFault, {readonly brand: unique symbol}>()(
  'SemanticSessionFault',
  {
    reason: Schema.Literals(['invalid', 'conflict', 'stale', 'not-ready', 'provider']),
  },
) {}
export interface LspEditSource {
  readonly uri: string;
  readonly text: string;
  readonly content: string;
  readonly identity: string;
}
export interface SemanticPrivateSourceRow {
  readonly capture: LspEditSource;
  readonly observation: Observation;
}
/** Fixed session-owned bridge. No proof is attached to provider results or caller JSON. */
export interface SemanticPrivateSourcePort {
  readonly beforeUpsert: (capture: LspEditSource, previous: Observation | undefined) => Effect.Effect<void, unknown>;
  readonly bind: (capture: LspEditSource, actual: Observation) => Effect.Effect<void, unknown>;
  readonly prepared: (result: QueryOutcome, rows: readonly SemanticPrivateSourceRow[]) => Effect.Effect<void, unknown>;
}
export const SemanticPrivateSourceEvidence = Context.Reference<SemanticPrivateSourcePort | undefined>(
  'semantic/PrivateSourceEvidence',
  {defaultValue: () => undefined},
);
export type SemanticPreparedUse =
  | {readonly kind: 'ordinary'; readonly outcome: QueryOutcome}
  | {
      readonly kind: 'writer-prepared';
      readonly outcome: QueryOutcome;
      readonly privateSourceRows: readonly SemanticPrivateSourceRow[];
      readonly privateSourceProof?: WindowsSourceProof;
      readonly assertCurrentSync: () => void;
    };
export interface WindowsSemanticSources {
  readonly port: SemanticPrivateSourcePort;
  readonly capture: (uri: string) => Effect.Effect<LspEditSource, unknown>;
  readonly poisoned: () => boolean;
  readonly assertObservation: (observation: Observation) => void;
  readonly take: (outcome: QueryOutcome) => SemanticPreparedUse;
}
/** Session-local issuer and original-object result join. Certificates never become public object fields. */
export const makeWindowsSemanticSources = Effect.fn('semantic.makeWindowsSources')(function* (
  worktree: string,
  seed: Observation,
  text: string,
) {
  const path = yield* Path.Path;
  const certificates = new WeakMap<LspEditSource, RuntimeWindowsSourceEvidence>();
  const bindings = new Map<string, SemanticPrivateSourceRow>();
  const prepared = new WeakMap<QueryOutcome, readonly SemanticPrivateSourceRow[]>();
  let poisoned = false;
  let bindingBasis: Observation | undefined;
  function stale(): never {
    poisoned = true;
    throw SemanticSessionFault.make({reason: 'stale'});
  }
  const certificate = (capture: LspEditSource) => certificates.get(capture) ?? stale();
  const assertRow = (row: SemanticPrivateSourceRow) => {
    const current = bindings.get(row.observation.uri);
    if (
      poisoned ||
      !current ||
      current.capture !== row.capture ||
      observationKey(current.observation) !== observationKey(row.observation)
    )
      throw SemanticSessionFault.make({reason: 'stale'});
  };
  const capture = (uri: string) =>
    Effect.gen(function* () {
      const file = yield* path.fromFileUrl(new URL(uri));
      if (!EffectString.startsWith(worktree + path.sep)(file) || EffectString.split(path.sep)(file).includes('.git'))
        return yield* SemanticSessionFault.make({reason: 'stale'});
      const native = yield* Effect.try({
        try: () =>
          runtimeCaptureWindowsSource(
            worktree,
            EffectString.split(path.sep)(path.relative(worktree, file)),
            4 * 1024 * 1024,
          ),
        catch: () => {
          poisoned = true;
          return SemanticSessionFault.make({reason: 'stale'});
        },
      });
      const capturedText = yield* Effect.try({
        try: () => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(native.bytes),
        catch: () => {
          poisoned = true;
          return SemanticSessionFault.make({reason: 'stale'});
        },
      });
      const result: LspEditSource = Object.freeze({
        uri,
        text: capturedText,
        content: sha256HexSync(native.bytes),
        identity: native.physicalIdentity,
      });
      certificates.set(result, native.evidence);
      return result;
    });
  const initial = yield* capture(seed.uri);
  if (initial.text !== text || initial.content !== seed.content)
    return yield* SemanticSessionFault.make({reason: 'stale'});
  const port: SemanticPrivateSourcePort = {
    beforeUpsert: (captured, previous) =>
      Effect.try({
        try: () => {
          if (poisoned) stale();
          const incoming = certificate(captured),
            retained = bindings.get(captured.uri);
          if (previous) {
            if (
              !retained ||
              observationKey(retained.observation) !== observationKey(previous) ||
              !runtimeSameWindowsSourceEvidence(certificate(retained.capture), incoming, false)
            )
              stale();
          } else if (retained) stale();
          else if (captured.uri === seed.uri && !runtimeSameWindowsSourceEvidence(certificate(initial), incoming, true))
            stale();
        },
        catch: () => SemanticSessionFault.make({reason: 'stale'}),
      }),
    bind: (captured, actual) =>
      Effect.try({
        try: () => {
          const retained = bindings.get(actual.uri);
          // Validate at the mutation point: an in-flight old read must never resurrect its epoch.
          if (retained && actual.projectEpoch < retained.observation.projectEpoch)
            throw SemanticSessionFault.make({reason: 'stale'});
          if (
            poisoned ||
            captured.uri !== actual.uri ||
            captured.content !== actual.content ||
            actual.documentVersion !== null
          )
            stale();
          if (
            bindingBasis &&
            observationKey({
              ...actual,
              uri: bindingBasis.uri,
              content: bindingBasis.content,
              documentVersion: bindingBasis.documentVersion,
              projectEpoch: bindingBasis.projectEpoch,
            }) !== observationKey(bindingBasis)
          )
            stale();
          bindingBasis ??= structuredClone(actual);
          const incoming = certificate(captured);
          if (retained) {
            const exact = observationKey(retained.observation) === observationKey(actual);
            if (!runtimeSameWindowsSourceEvidence(certificate(retained.capture), incoming, exact)) stale();
            if (exact) return; // Same-key binding is assertion only: FIRST witness is immutable.
          }
          const first =
            retained && retained.capture.content === captured.content
              ? retained.capture
              : !retained && actual.uri === seed.uri
                ? initial
                : captured;
          bindings.set(
            actual.uri,
            Object.freeze({capture: first, observation: Object.freeze(structuredClone(actual))}),
          );
        },
        catch: () => SemanticSessionFault.make({reason: 'stale'}),
      }),
    prepared: (outcome, rows) =>
      Effect.try({
        try: () => {
          if (
            poisoned ||
            !rows.length ||
            new Set(EffectArray.map(rows, row => row.observation.uri)).size !== rows.length
          )
            stale();
          const frozen = EffectArray.map(rows, row => {
            const retained = bindings.get(row.observation.uri);
            if (!retained || observationKey(retained.observation) !== observationKey(row.observation))
              throw SemanticSessionFault.make({reason: 'stale'});
            if (!runtimeSameWindowsSourceEvidence(certificate(retained.capture), certificate(row.capture), true))
              stale();
            return retained;
          });
          prepared.set(outcome, Object.freeze(frozen));
        },
        catch: () => SemanticSessionFault.make({reason: 'stale'}),
      }),
  };
  return {
    port,
    capture,
    poisoned: () => poisoned,
    assertObservation: (observation: Observation) => {
      const row = bindings.get(observation.uri);
      if (!row || observationKey(row.observation) !== observationKey(observation))
        throw SemanticSessionFault.make({reason: 'stale'});
      assertRow(row);
    },
    take: (outcome: QueryOutcome): SemanticPreparedUse => {
      if (poisoned) stale();
      if (outcome.status !== 'ok') return {kind: 'ordinary', outcome};
      const markers = EffectArray.filter(outcome.items, item => isJsonObject(item) && item.kind === 'prepared-edit');
      if (!markers.length) return {kind: 'ordinary', outcome};
      if (outcome.items.length !== 1 || markers.length !== 1) stale();
      const item = markers[0];
      if (!isJsonObject(item) || !EffectArray.isArray(item.files)) stale();
      if (
        item.qualification === 'unsupported-operation-sequence' ||
        item.sourceBasis === 'unqualified-operation-sequence-v1'
      ) {
        if (
          item.qualification !== 'unsupported-operation-sequence' ||
          item.sourceBasis !== 'unqualified-operation-sequence-v1' ||
          item.operation !== 'code-action' ||
          !EffectArray.isArray(item.operations)
        )
          stale();
        return {kind: 'ordinary', outcome};
      }
      if (
        !item.files.length ||
        !['rename', 'code-action'].includes(String(item.operation)) ||
        item.sourceBasis !== 'pre-request-synchronized-text-v1'
      )
        stale();
      for (const file of item.files) {
        if (
          !isJsonObject(file) ||
          !Schema.is(Observation)(file.observation) ||
          file.uri !== file.observation.uri ||
          file.content !== file.observation.content ||
          !['disk', 'overlay'].includes(String(file.source)) ||
          (file.source === 'disk') !== (file.observation.documentVersion === null)
        )
          stale();
      }
      if (EffectArray.some(item.files, file => isJsonObject(file) && file.source === 'overlay'))
        return {kind: 'ordinary', outcome};
      const rows = prepared.get(outcome);
      prepared.delete(outcome);
      if (!rows || rows.length !== item.files.length) stale();
      for (const [index, file] of item.files.entries()) {
        const row = rows[index];
        if (
          !isJsonObject(file) ||
          file.source !== 'disk' ||
          file.uri !== row.observation.uri ||
          file.content !== row.capture.content ||
          !Schema.is(Observation)(file.observation) ||
          observationKey(file.observation) !== observationKey(row.observation)
        )
          stale();
        assertRow(row);
      }
      return {
        kind: 'writer-prepared',
        outcome,
        privateSourceRows: rows,
        privateSourceProof: Object.freeze({
          version: 1 as const,
          platform: 'win32' as const,
          targets: Object.freeze(
            EffectArray.map(rows, (row, ordinal) =>
              Object.freeze({
                ordinal,
                uri: row.observation.uri,
                rawDigest: row.capture.content,
                observationKey: observationKey(row.observation),
                ...(() => {
                  try {
                    return runtimeExportWindowsSourceWitness(certificate(row.capture));
                  } catch {
                    return stale();
                  }
                })(),
              }),
            ),
          ),
        }),
        assertCurrentSync: () => EffectArray.forEach(rows, assertRow),
      };
    },
  } satisfies WindowsSemanticSources;
});

/** Consume the original provider object while it is still inside the coordinator host. */
export function takeSemanticPrepared(
  outcome: QueryOutcome,
  sources: WindowsSemanticSources | undefined,
  active: () => boolean,
): SemanticPreparedUse {
  if (!active()) throw SemanticSessionFault.make({reason: 'stale'});
  if (!sources) return {kind: 'ordinary', outcome};
  const result = sources.take(outcome);
  if (result.kind === 'ordinary') return result;
  return {
    ...result,
    assertCurrentSync: () => {
      if (!active() || sources.poisoned()) throw SemanticSessionFault.make({reason: 'stale'});
      result.assertCurrentSync();
    },
  };
}

export const validateSemanticSource = (sources: WindowsSemanticSources, observation: Observation) =>
  Effect.gen(function* () {
    yield* Effect.try({
      try: () => sources.assertObservation(observation),
      catch: () => SemanticSessionFault.make({reason: 'stale'}),
    });
    yield* sources.port.bind(yield* sources.capture(observation.uri), observation);
  });

/** Source selection owns no session, reservation or publication lifecycle. */
export const makeSemanticSources = (worktree: string, seed: Observation, text: string) =>
  runtimePlatform === 'win32' && seed.view.kind === 'disk'
    ? makeWindowsSemanticSources(worktree, seed, text).pipe(Effect.asSome)
    : Effect.succeedNone;

interface SourceSession {
  readonly sources?: WindowsSemanticSources;
  readonly closing: boolean;
}
/** The coordinator supplies its actual current session lookup; this helper only joins proof.
 * Map ownership, retirement and publication remain with that caller.
 */
export const takeCurrentSemanticPrepared = (
  outcome: QueryOutcome,
  producer: SourceSession,
  current: () => SourceSession | undefined,
) =>
  Effect.try({
    try: () => takeSemanticPrepared(outcome, producer.sources, () => current() === producer && !producer.closing),
    catch: () => SemanticSessionFault.make({reason: 'stale'}),
  });

/** Private historical data only. Issuance remains the original session WeakMap, never this decoder. */
export const WindowsSourceProof = Schema.Struct({
  version: Schema.Literal(1),
  platform: Schema.Literal('win32'),
  targets: Schema.Array(
    Schema.Struct({
      ordinal: Schema.Number.check(Schema.isInt(), Schema.isBetween({minimum: 0, maximum: 999})),
      uri: FileUri,
      rawDigest: Digest,
      observationKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65536)),
      object: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8 * 1024 * 1024)),
      snapshot: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8 * 1024 * 1024)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
});
export type WindowsSourceProof = typeof WindowsSourceProof.Type;
export const WindowsProofClosure = Schema.Union([
  Schema.Struct({kind: Schema.Literal('complete'), proof: WindowsSourceProof}),
  Schema.Struct({kind: Schema.Literal('absent')}),
]);
export type WindowsProofClosure = typeof WindowsProofClosure.Type;
export const windowsProofDigest = (closure: WindowsProofClosure) => {
  let bytes = 0;
  if (closure.kind === 'complete')
    for (const row of closure.proof.targets) {
      bytes +=
        new TextEncoder().encode(row.object).length +
        new TextEncoder().encode(row.snapshot).length +
        new TextEncoder().encode(row.observationKey).length +
        new TextEncoder().encode(row.uri).length;
      if (bytes > 8 * 1024 * 1024) throw SemanticSessionFault.make({reason: 'stale'});
    }
  return sha256HexSync(
    JSON.stringify(
      closure.kind === 'absent'
        ? ['threadnote-windows-source-absent-v2']
        : [
            'threadnote-windows-source-proof-v2',
            EffectArray.map(closure.proof.targets, row => [
              row.ordinal,
              row.uri,
              row.rawDigest,
              row.observationKey,
              row.object,
              row.snapshot,
            ]),
          ],
    ),
  );
};

export function assertWindowsProofTargets(
  proof: WindowsSourceProof,
  proposal: import('@threadnote/semantic/proposals').SemanticProposal,
): void {
  if (proof.targets.length !== proposal.targets.length) throw SemanticSessionFault.make({reason: 'stale'});
  for (const [index, target] of proposal.targets.entries()) {
    const row = proof.targets[index];
    if (
      row.ordinal !== index ||
      row.uri !== target.observation.uri ||
      row.rawDigest !== target.precondition.rawDigest ||
      row.observationKey !== observationKey(target.observation) ||
      target.precondition.sourceKind !== 'disk' ||
      target.observation.documentVersion !== null
    )
      throw SemanticSessionFault.make({reason: 'stale'});
  }
}

/** Immutable native object key for the private registry; compatibility dev/ino never grants Windows ownership. */
export function windowsResourceIdentity(row: WindowsSourceProof['targets'][number]): string {
  const parsed: unknown = JSON.parse(row.object);
  if (
    !EffectArray.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    !/^S-1-/u.test(parsed[0]) ||
    !EffectArray.isArray(parsed[1]) ||
    !parsed[1].length
  )
    throw SemanticSessionFault.make({reason: 'stale'});
  const last: unknown = parsed[1][parsed[1].length - 1];
  if (
    !EffectArray.isArray(last) ||
    last.length !== 8 ||
    typeof last[2] !== 'string' ||
    !/^(0|[1-9][0-9]*)$/u.test(last[2]) ||
    BigInt(last[2]) > 0xffffffffffffffffn ||
    typeof last[3] !== 'string' ||
    EffectString.split(',')(last[3]).length !== 16 ||
    !EffectArray.every(
      EffectString.split(',')(last[3]),
      byte => /^(0|[1-9][0-9]*)$/u.test(byte) && Number(byte) <= 255,
    ) ||
    typeof last[4] !== 'string' ||
    !/^-?[0-9]+$/u.test(last[4])
  )
    throw SemanticSessionFault.make({reason: 'stale'});
  const key = JSON.stringify([parsed[0], last[2], last[3], last[4]]);
  if (!isWindowsResourceIdentity(key)) throw SemanticSessionFault.make({reason: 'stale'});
  return key;
}

export function isWindowsResourceIdentity(value: string): boolean {
  if (value.length > 1024) return false;
  try {
    const fields: unknown = JSON.parse(value);
    if (
      !EffectArray.isArray(fields) ||
      fields.length !== 4 ||
      !EffectArray.every(fields, field => typeof field === 'string')
    )
      return false;
    const [sid, volume, file, birth] = fields;
    return (
      typeof sid === 'string' &&
      /^S-1-[0-9]+(?:-[0-9]+){0,15}$/u.test(sid) &&
      typeof volume === 'string' &&
      /^(0|[1-9][0-9]*)$/u.test(volume) &&
      BigInt(volume) <= 0xffffffffffffffffn &&
      typeof file === 'string' &&
      EffectString.split(',')(file).length === 16 &&
      EffectArray.every(
        EffectString.split(',')(file),
        byte => /^(0|[1-9][0-9]*)$/u.test(byte) && Number(byte) <= 255,
      ) &&
      EffectArray.some(EffectString.split(',')(file), byte => byte !== '0') &&
      typeof birth === 'string' &&
      /^-?(0|[1-9][0-9]*)$/u.test(birth) &&
      BigInt(birth).toString() === birth &&
      BigInt(birth) >= -0x8000000000000000n &&
      BigInt(birth) <= 0x7fffffffffffffffn &&
      JSON.stringify(fields) === value
    );
  } catch {
    return false;
  }
}
