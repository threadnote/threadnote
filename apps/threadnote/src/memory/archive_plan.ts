import {Array as EffectArray} from 'effect';
import {Context, DateTime, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {withMemoryUriLocks} from '@threadnote/memory/lock';
import {
  assertMemoryDocumentSchemaWritable,
  formatMemoryDocument,
  memoryArchiveBody,
  memoryArchiveMetadata,
  parseMemoryDocument,
} from '@threadnote/memory/document';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {sha256FileHex} from '@threadnote/platform/digest';
import {SystemInfo} from '@threadnote/platform/system';
import {ResourceStore} from '@threadnote/store/resource-store';
import {parseResourceId} from '@threadnote/store/resource-id';
import {uriSegment} from '@threadnote/store/resource-segment';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {isStandaloneThreadnoteBuild} from '@threadnote/workspace/runtime-version';
import {storeMemory} from './commands.js';
import {localMemoryPathForUri, memoryDirectoryUri, resourceStoreLocation} from './migrations.js';
import {discardDeferredCodeAnchorIntent} from './deferred/code_anchor.js';
import {refreshRecallDerivedIndexesAfterCanonicalMutation} from '@threadnote/recall/mcp/refresh';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const bytes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const resource = Schema.Struct({uri: Schema.String, sha256: digest, bytes});
export const MemoryArchivePlanSchema = Schema.Struct({
  version: Schema.Literal(1),
  timestamp: Schema.String.check(Schema.isPattern(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u)),
  archiveKey: digest,
  source: resource,
  destination: resource,
  runtime: Schema.Struct({executablePath: Schema.String, sha256: digest}),
  config: Schema.Struct({
    agentContextHome: Schema.String,
    realHome: Schema.String,
    manifestPath: Schema.String,
    manifestRealPath: Schema.String,
    manifestSha256: digest,
    account: Schema.String,
    user: Schema.String,
    agentId: Schema.String,
  }),
  planId: digest,
});
export type MemoryArchivePlan = typeof MemoryArchivePlanSchema.Type;
export class MemoryArchivePlanError extends Schema.TaggedError<
  MemoryArchivePlanError,
  {readonly brand: unique symbol}
>()('MemoryArchivePlanError', {
  code: Schema.Literals(['invalid-request', 'unsupported-runtime', 'plan-changed', 'archive-conflict']),
  message: Schema.String,
}) {}

/** Synthetic standalone identity for tests; the production CLI never supplies an override. */
export class MemoryArchiveExecutable extends Context.Service<MemoryArchiveExecutable, {readonly path: string}>()(
  '@threadnote/threadnote/memory/archive_plan/MemoryArchiveExecutable',
) {}
const fail = (code: MemoryArchivePlanError['code'], message: string) => MemoryArchivePlanError.make({code, message});
const canonical = (value: unknown): string => {
  if (EffectArray.isArray(value)) return `[${EffectArray.join(EffectArray.map(value, canonical), ',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${EffectArray.join(
      EffectArray.map(
        EffectRecord.toEntries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        ([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`,
      ),
      ',',
    )}}`;
  return JSON.stringify(value) ?? 'null';
};
const hash = (value: unknown) => sha256HexSync(canonical(value));
const describe = (uri: string, content: string) => ({
  uri,
  sha256: sha256HexSync(content),
  bytes: new TextEncoder().encode(content).length,
});

const identity = Effect.fn('memoryArchive.identity')(function* (config: RuntimeConfig) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const override = yield* Effect.serviceOption(MemoryArchiveExecutable);
  if (Option.isNone(override) && !isStandaloneThreadnoteBuild())
    return yield* fail(
      'unsupported-runtime',
      'Exact archive plans require a self-contained standalone executable; source mode is unsupported.',
    );
  const executablePath = yield* fs.realPath(
    Option.isSome(override) ? override.value.path : (yield* SystemInfo).executablePath,
  );
  const manifestRealPath = yield* fs.realPath(config.manifestPath);
  return {
    runtime: {executablePath, sha256: yield* sha256FileHex(executablePath)},
    config: {
      agentContextHome: path.resolve(config.agentContextHome),
      realHome: yield* fs.realPath(config.agentContextHome),
      manifestPath: path.resolve(config.manifestPath),
      manifestRealPath,
      manifestSha256: yield* sha256FileHex(manifestRealPath),
      account: config.account,
      user: config.user,
      agentId: config.agentId,
    },
  };
});

const assertSource = (config: RuntimeConfig, uri: string) =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => parseResourceId(uri),
      catch: () => fail('invalid-request', 'Select one canonical personal memory URI belonging to the effective user.'),
    });
    if (
      parsed.canonicalUri !== uri ||
      parsed.anchor ||
      parsed.namespace !== 'user' ||
      parsed.segments[0] !== uriSegment(config.user) ||
      parsed.segments[1] !== 'memories' ||
      !['durable', 'handoffs', 'incidents', 'preferences', 'smoke'].includes(parsed.segments[2] ?? '')
    )
      return yield* fail(
        'invalid-request',
        'Select one canonical personal memory URI belonging to the effective user.',
      );
  });

const build = (
  config: RuntimeConfig,
  uri: string,
  raw: string,
  timestamp: string,
  pinned: Effect.Success<ReturnType<typeof identity>>,
) =>
  Effect.gen(function* () {
    yield* assertSource(config, uri);
    yield* Effect.try({
      try: () => assertMemoryDocumentSchemaWritable(raw),
      catch: () => fail('invalid-request', 'The source schema or metadata requires repair before archiving.'),
    });
    const record = parseMemoryDocument(uri, raw);
    if (!record) return yield* fail('invalid-request', 'The selected source is not a supported native memory.');
    if (record.metadata.citationErrors?.length)
      return yield* fail(
        'invalid-request',
        'Malformed code citation metadata must be repaired or recaptured before archiving.',
      );
    const archive = yield* Effect.try({
      try: () => {
        // Refuse a rewrite that would silently discard an unsupported legacy header.
        // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
        const roundTrip = formatMemoryDocument(record.headerTitle, record.metadata, record.body).split('\n\n', 1)[0];
        if (
          EffectArray.some(
            Effect2.pipe(
              Effect2.pipe(raw, EffectString.trim)
                // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
                .split(/\r?\n\r?\n/u, 1)[0],
              EffectString.split(/\r?\n/u),
            ).slice(1),
            line => !Effect2.pipe(roundTrip, EffectString.split('\n')).includes(line),
          )
        )
          throw fail(
            'invalid-request',
            'The source contains unsupported header metadata; no archive plan was created.',
          );
        const metadata = memoryArchiveMetadata(record.metadata, {
          archivedFrom: uri,
          kind: record.metadata.kind ?? 'handoff',
          sourceAgentClient: 'threadnote',
          timestamp,
        });
        const body = memoryArchiveBody(record.body);
        return {metadata, body, content: formatMemoryDocument('MEMORY', metadata, body)};
      },
      catch: error =>
        Schema.is(MemoryArchivePlanError)(error)
          ? error
          : fail('invalid-request', 'The source metadata cannot be archived without repair.'),
    });
    const source = describe(uri, raw);
    const archiveKey = hash({version: 1, source, timestamp, ...pinned});
    const destination = describe(
      `${memoryDirectoryUri(config, archive.metadata)}/consolidation-${archiveKey}.md`,
      archive.content,
    );
    const payload = {version: 1 as const, timestamp, archiveKey, source, destination, ...pinned};
    return {plan: {...payload, planId: hash(payload)}, archive};
  });

const readOptional = (config: RuntimeConfig, uri: string) =>
  Effect.gen(function* () {
    const store = yield* ResourceStore;
    const content = yield* store
      .read(resourceStoreLocation(config), uri, {existingOnly: true})
      .pipe(Effect.catchTag('ResourceNotFound', () => Effect.void));
    if (content === undefined) return;
    const local = yield* localMemoryPathForUri(config, uri);
    const fs = yield* FileSystem.FileSystem;
    if (
      !local ||
      (yield* sha256FileHex(local)) !== sha256HexSync(content) ||
      Number((yield* fs.stat(local)).size) !== new TextEncoder().encode(content).length
    )
      return yield* fail('plan-changed', 'Canonical bytes changed or are not losslessly readable UTF-8.');
    return content;
  });
const assertCopy = (config: RuntimeConfig, plan: MemoryArchivePlan, required: boolean) =>
  Effect.gen(function* () {
    const content = yield* readOptional(config, plan.destination.uri);
    if (content === undefined && !required) return;
    if (content === undefined || canonical(describe(plan.destination.uri, content)) !== canonical(plan.destination))
      return yield* fail(
        'archive-conflict',
        'The exact planned archive copy is missing or changed; source cleanup was refused.',
      );
    const copy = parseMemoryDocument(plan.destination.uri, content);
    if (
      !copy ||
      copy.metadata.archivedFrom !== plan.source.uri ||
      copy.metadata.status !== 'archived' ||
      copy.metadata.visibility !== 'personal' ||
      `${memoryDirectoryUri(config, copy.metadata)}/consolidation-${plan.archiveKey}.md` !== plan.destination.uri
    )
      return yield* fail('archive-conflict', 'The copy is not the planned personal archive.');
  });
const decodePlan = (input: unknown) =>
  Schema.decodeUnknownEffect(MemoryArchivePlanSchema)(input, {onExcessProperty: 'error'}).pipe(
    Effect.mapError(() => fail('invalid-request', 'Provide a closed version 1 archive plan.')),
  );

const inspect = Effect.fn('memoryArchive.inspect')(function* (config: RuntimeConfig, input: unknown) {
  const plan = yield* decodePlan(input);
  const {planId, ...payload} = plan;
  if (planId !== hash(payload)) return yield* fail('plan-changed', 'The archive plan checksum changed.');
  yield* assertSource(config, plan.source.uri);
  const pinned = yield* identity(config);
  if (canonical(pinned) !== canonical({runtime: plan.runtime, config: plan.config}))
    return yield* fail('plan-changed', 'The archive executable or effective configuration changed.');
  if (plan.archiveKey !== hash({version: 1, source: plan.source, timestamp: plan.timestamp, ...pinned}))
    return yield* fail('plan-changed', 'The deterministic archive identity changed.');
  yield* assertSource(config, plan.destination.uri);
  const source = yield* readOptional(config, plan.source.uri);
  if (source === undefined) {
    yield* assertCopy(config, plan, true);
    return {plan, source, archive: undefined};
  }
  const rebuilt = yield* build(config, plan.source.uri, source, plan.timestamp, pinned);
  if (canonical(rebuilt.plan) !== canonical(plan))
    return yield* fail('plan-changed', 'The full source revision or planned destination changed.');
  yield* assertCopy(config, plan, false);
  return {plan, source, archive: rebuilt.archive};
});
const result = (plan: MemoryArchivePlan, status: 'ready' | 'archived' | 'already-archived') => ({
  version: 1 as const,
  planId: plan.planId,
  sourceUri: plan.source.uri,
  destinationUri: plan.destination.uri,
  status,
});

export const planMemoryArchive = Effect.fn('memoryArchive.plan')(function* (config: RuntimeConfig, uri: string) {
  yield* assertSource(config, uri);
  const pinned = yield* identity(config);
  const source = yield* readOptional(config, uri);
  if (source === undefined) return yield* fail('invalid-request', 'The selected canonical memory is missing.');
  const {plan} = yield* build(config, uri, source, DateTime.formatIso(yield* DateTime.now), pinned);
  yield* assertCopy(config, plan, false);
  // Read again: a plan never combines observations from changing source/config/executable bytes.
  yield* inspect(config, plan);
  return plan;
});
export const checkMemoryArchivePlan = Effect.fn('memoryArchive.check')(function* (
  config: RuntimeConfig,
  input: unknown,
) {
  const state = yield* inspect(config, input);
  return result(state.plan, state.source === undefined ? 'already-archived' : 'ready');
});
export const commitMemoryArchive = Effect.fn('memoryArchive.commit')(function* (config: RuntimeConfig, input: unknown) {
  const plan = yield* decodePlan(input);
  const fs = yield* FileSystem.FileSystem;
  yield* assertSource(config, plan.source.uri);
  let refresh = false;
  return yield* withMemoryUriLocks(
    fs,
    config.agentContextHome,
    [plan.source.uri],
    Effect.gen(function* () {
      const state = yield* inspect(config, plan);
      refresh = true;
      if (state.source !== undefined && state.archive !== undefined) {
        const uri = yield* storeMemory(config, {
          title: 'MEMORY',
          dryRun: false,
          metadata: state.archive.metadata,
          bodyText: state.archive.body,
          consolidationArchiveKey: plan.archiveKey,
          deferRecallIndexRefresh: true,
          skipMemoryIdentityLock: true,
        });
        if (uri !== plan.destination.uri) return yield* fail('archive-conflict', 'The archive destination changed.');
        const store = yield* ResourceStore;
        // Existing account mutation lock protects the verified destination and source CAS together.
        yield* store.mutateChecked(
          resourceStoreLocation(config),
          [{type: 'remove', uri: plan.source.uri, options: {expectedFingerprint: plan.source.sha256}}],
          inspect(config, plan).pipe(Effect.andThen(assertCopy(config, plan, true)), Effect.asVoid),
        );
      }
      yield* discardDeferredCodeAnchorIntent(config, plan.source.uri);
      return result(plan, state.source === undefined ? 'already-archived' : 'archived');
    }),
  ).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        refresh
          ? refreshRecallDerivedIndexesAfterCanonicalMutation(config, [plan.source.uri, plan.destination.uri]).pipe(
              Effect.asVoid,
            )
          : Effect.void,
      ),
    ),
  );
});
