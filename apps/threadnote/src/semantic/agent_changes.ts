import type {SemanticPreparedUse} from './provider.js';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {Digest as EffectDigest, SecureRandom} from 'effect/crypto';
import {Array as EffectArray, Clock, Effect, FileSystem, Option, Path, Schema, String as EffectString} from 'effect';
import {canonicalFileUri, Observation, observationKey, type QueryOutcome} from '@threadnote/semantic/contracts';
import {createSemanticProposal, proposalPage, type SemanticProposal} from '@threadnote/semantic/proposals';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {semanticAgentQueryHost, type SemanticAgentQueryHost} from './agent_queries.js';
import {
  SemanticHostProfile,
  semanticHostProfileName,
  readSemanticHostProfile,
  readSemanticPrivateProfile,
} from './host_profile.js';
import {semanticHostSelection} from './host_catalog.js';
import {SemanticLanguage, SemanticRange, type SemanticSession} from './provider.js';
import * as Native from '@threadnote/platform/system';
import {SystemInfo} from '@threadnote/platform/system';
import {makeSemanticActionChoices, SemanticActionChoice} from './action_choices.js';
import {LspFault} from './lsp_transport.js';
import {readBounded} from './fingerprint.js';
import {makeSemanticProposalStore} from './proposal_store.js';
import {
  runSemanticWriterRequestWith,
  runSemanticWriterAdmissionWith,
  runSemanticWriterRetirementWith,
} from './writer.js';
import {
  SemanticAgentChangeRequest,
  SemanticWriterRequest,
  semanticAgentChangeLimits,
  type SemanticAgentEndpointChange,
  changeRefusal,
  changeTimeoutRefusal,
  type SemanticChangeTimeoutObservation,
} from './agent_change_protocol.js';

type HostTimeoutPhase = Extract<SemanticChangeTimeoutObservation, {origin: 'host'}>['phase'];
type ServiceTimeoutPhase = Extract<SemanticChangeTimeoutObservation, {origin: 'service'}>['phase'];
type TimeoutMeasurement = Omit<SemanticChangeTimeoutObservation, 'origin' | 'phase'>;
/** Only the emitting process's last-entered phase is known; IPC wait never implies a provider phase. */
const observeChangeTimeout =
  <Phase extends HostTimeoutPhase | ServiceTimeoutPhase>(
    initial: Phase,
    refuse: (phase: Phase, measurement: TimeoutMeasurement) => ReturnType<typeof changeTimeoutRefusal>,
  ) =>
  <A, E, R>(milliseconds: number, program: (enter: (phase: Phase) => Effect.Effect<void>) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const started = yield* Clock.monotonicTimeNanos;
      let phase = initial;
      let phaseStarted = started;
      const enter = (next: Phase) =>
        Clock.monotonicTimeNanos.pipe(
          Effect.map(now => {
            phase = next;
            phaseStarted = now;
          }),
        );
      const result = yield* program(enter).pipe(Effect.timeoutOption(milliseconds));
      if (result._tag === 'Some') return result.value;
      const now = yield* Clock.monotonicTimeNanos;
      const elapsed = (since: bigint) =>
        Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number((now - since) / 1_000_000n)));
      const elapsedMilliseconds = elapsed(started);
      return refuse(phase, {
        elapsedMilliseconds,
        phaseElapsedMilliseconds: elapsed(phaseStarted),
        budgetMilliseconds: milliseconds,
        remainingMilliseconds: Math.max(0, milliseconds - elapsedMilliseconds),
        terminal: 'timeout',
        // Neither wrapper owns an aggregate group/admission drain receipt.
        cleanup: 'unobserved',
      });
    });

const observeHostTimeout = observeChangeTimeout<HostTimeoutPhase>('validate-request', (phase, measurement) =>
  changeTimeoutRefusal({origin: 'host', phase, ...measurement}),
);
const observeServiceTimeout = observeChangeTimeout<ServiceTimeoutPhase>('scope-check', (phase, measurement) =>
  changeTimeoutRefusal({origin: 'service', phase, ...measurement}),
);

/** Public JSON supplies a request, never the host read scope or a writer grant. */
export const runSemanticAgentChangeWith = <R>(
  services: SemanticAgentQueryHost<R>,
  config: RuntimeConfig,
  input: unknown,
) =>
  Schema.is(SemanticWriterRequest)(input)
    ? runSemanticWriterRequestWith(services, config, input)
    : observeHostTimeout(
        Schema.is(SemanticAgentChangeRequest)(input)
          ? (input.milliseconds ?? semanticAgentChangeLimits.defaultMilliseconds)
          : semanticAgentChangeLimits.defaultMilliseconds,
        enter =>
          Effect.gen(function* () {
            const bytes = yield* Effect.try({
              try: () => new TextEncoder().encode(JSON.stringify(input)).length,
              catch: () => LspFault.make({code: 'protocol'}),
            });
            if (bytes > semanticAgentChangeLimits.maxRequestBytes)
              return changeRefusal('invalid-request', 'Request is too large');
            const request = yield* Schema.decodeUnknownEffect(SemanticAgentChangeRequest, {onExcessProperty: 'error'})(
              input,
            ).pipe(Effect.mapError(() => LspFault.make({code: 'protocol'})));
            if ('writer' in request) return yield* runSemanticWriterRequestWith(services, config, request);
            yield* enter('host-scope');
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            if (!path.isAbsolute(request.callerCwd))
              return changeRefusal('invalid-request', 'An absolute worktree is required');
            const root = yield* fs.realPath(request.callerCwd);
            const worktree = canonicalFileUri((yield* path.toFileUrl(root)).href);
            const selected = yield* readSemanticHostProfile(config, worktree);
            const runtimeIdentity = yield* services.runtimeIdentity;
            yield* enter('source-scope');
            let scope;
            if (request.action === 'prepare') {
              if (
                request.operation === 'rename' &&
                (!request.position ||
                  !request.newName ||
                  request.choiceHandle ||
                  request.range ||
                  request.only ||
                  request.diagnosticIds)
              )
                return changeRefusal('invalid-request', 'Rename requires newName and no action query');
              if (request.operation === 'code-action' && (request.newName || !request.range))
                return changeRefusal('invalid-request', 'Code-action requires range and no newName');
              if (
                request.operation === 'code-action' &&
                request.position &&
                request.range &&
                (request.position.line !== request.range.start.line ||
                  request.position.character !== request.range.start.character)
              )
                return changeRefusal('invalid-request', 'Action position must equal range start');
              if (!Schema.is(SemanticLanguage)(request.language))
                return changeRefusal('unsupported', 'Language is unqualified');
              if (!selected.profile.catalog[semanticHostSelection[request.language].slot])
                return changeRefusal('unavailable', 'Provider is not configured');
              const project = path.resolve(root, request.project ?? '.');
              const file = EffectString.startsWith('file:')(request.file)
                ? yield* path.fromFileUrl(new URL(request.file))
                : path.resolve(project, request.file);
              if (
                !(project === root || EffectString.startsWith(root + path.sep)(project)) ||
                !EffectString.startsWith(project + path.sep)(file) ||
                EffectString.split(path.sep)(file).includes('.git') ||
                (yield* fs.realPath(project)) !== project ||
                (yield* fs.realPath(file)) !== file
              )
                return changeRefusal('invalid-request', 'Source must remain in the authorized canonical project');
              scope = {
                project: canonicalFileUri((yield* path.toFileUrl(project)).href),
                uri: canonicalFileUri((yield* path.toFileUrl(file)).href),
                language: request.language,
                operation: request.operation,
                position: request.position ?? request.range!.start,
                ...(request.newName ? {newName: request.newName} : {}),
                ...(request.range ? {range: request.range} : {}),
                ...(request.diagnosticIds ? {diagnosticIds: request.diagnosticIds} : {}),
                ...(request.only ? {only: request.only} : {}),
                ...(request.choiceHandle ? {choiceHandle: request.choiceHandle} : {}),
                ...(request.environment ? {environment: request.environment} : {}),
                ...(typeof request.view === 'object' ? {view: request.view} : {}),
              };
            } else scope = {handle: request.handle, ...(request.offset !== undefined ? {offset: request.offset} : {})};
            yield* enter('endpoint-connect');
            const endpoint = yield* services.connect({
              enabled: true,
              dataHome: selected.home,
              worktree,
              runtimeIdentity,
              ...selected.profile.catalog,
            });
            yield* enter('endpoint-request');
            const result = yield* endpoint.request({
              operation: 'agent-change',
              request: {
                version: 1,
                worktree,
                profile: selected.digest,
                principal: EffectString.slice(0, -5)(semanticHostProfileName(config, worktree)),
                action: request.action,
                ...scope,
                maxBytes: request.maxBytes ?? semanticAgentChangeLimits.defaultPageBytes,
                milliseconds: request.milliseconds ?? semanticAgentChangeLimits.defaultMilliseconds,
              },
            });
            yield* enter('host-publication');
            const current = yield* readSemanticHostProfile(config, worktree);
            if (current.digest !== selected.digest)
              return changeRefusal('stale', 'Host read scope changed before publication');
            return result;
          }),
      ).pipe(
        Effect.catch(error =>
          Effect.succeed(
            changeRefusal(
              Schema.is(LspFault)(error) && error.code === 'protocol'
                ? 'invalid-request'
                : Schema.is(LspFault)(error) && error.code === 'capacity'
                  ? 'budget-exceeded'
                  : 'unavailable',
              'Proposal source, scope or prerequisites are unavailable',
            ),
          ),
        ),
      );
export const runSemanticAgentChange = (config: RuntimeConfig, input: unknown) =>
  runSemanticAgentChangeWith(semanticAgentQueryHost, config, input);
/** Dedicated local command entrypoint; never dispatched by an endpoint or registered MCP tool. */
export const runSemanticLocalWriterAdmission = (config: RuntimeConfig, input: unknown) =>
  runSemanticWriterAdmissionWith(semanticAgentQueryHost, config, input);
export const runSemanticLocalWriterRetirement = (config: RuntimeConfig, input: unknown) =>
  runSemanticWriterRetirementWith(config, input);

type ChangeContext =
  EffectDigest.Digest | FileSystem.FileSystem | Path.Path | SecureRandom.SecureRandom | ChildEnvironmentPolicy;
interface ChangeCoordinator {
  readonly attach: (
    observation: Observation,
    text: string,
    language: SemanticLanguage,
    environment?: string,
  ) => Effect.Effect<{observation: Observation}, unknown, ChangeContext>;
  readonly use: <A, E>(
    observation: Observation,
    milliseconds: number,
    f: (api: SemanticSession) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, unknown, ChangeContext>;
  readonly usePrepared?: <E>(
    observation: Observation,
    milliseconds: number,
    f: (api: SemanticSession) => Effect.Effect<QueryOutcome, E>,
  ) => Effect.Effect<SemanticPreparedUse, unknown, ChangeContext>;
  readonly observe: (
    observation: Observation,
    milliseconds: number,
  ) => Effect.Effect<Observation | undefined, unknown, ChangeContext>;
}
const Prepared = Schema.Struct({
  kind: Schema.Literal('prepared-edit'),
  operation: Schema.Literals(['rename', 'code-action']),
  sourceBasis: Schema.Literals([
    'pre-request-synchronized-text-v1',
    'immutable-provider-input-v1',
    'unqualified-operation-sequence-v1',
  ]),
  qualification: Schema.optionalKey(Schema.Literals(['qualified-text-only', 'unsupported-operation-sequence'])),
  operations: Schema.optionalKey(Schema.Array(Schema.Json)),
  changeAnnotations: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  files: Schema.Array(
    Schema.Struct({
      observation: Observation,
      beforeText: Schema.String,
      providerDocumentVersion: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
      edits: Schema.Array(
        Schema.Struct({range: SemanticRange, newText: Schema.String, annotationId: Schema.optionalKey(Schema.String)}),
      ),
      precondition: Schema.Struct({
        sourceKind: Schema.Literals(['disk', 'overlay']),
        rawDigest: Schema.String,
        encoding: Schema.Literal('utf-8'),
        physicalIdentity: Schema.NullOr(Schema.String),
        owner: Schema.String,
        documentVersion: Schema.NullOr(Schema.Finite),
      }),
    }),
  ),
});
/** Authenticated coordinator seam; only qualified adapters can provide source-before-request evidence. */
export const makeSemanticAgentChanges = Effect.fn('semantic.agentChanges')(function* (
  coordinator: ChangeCoordinator,
  options: {directory: string; profileHome: string; worktree: string; runtimeIdentity: string},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const system = yield* SystemInfo;
  const choices = yield* makeSemanticActionChoices();
  const namespace = sha256HexSync(yield* random.randomBytes(32));
  const store = yield* makeSemanticProposalStore({directory: path.join(options.directory, 'proposals'), namespace});
  const root = yield* path.fromFileUrl(new URL(options.worktree));
  const binding = (profile: string, principal: string) =>
    sha256HexSync(JSON.stringify([options.worktree, principal, profile, options.runtimeIdentity]));
  // The RPC carries only a host-derived profile identity. Validate the actual protected profile again in the worker.
  const verifyScope = (request: SemanticAgentEndpointChange) =>
    Effect.gen(function* () {
      if (!/^[a-f0-9]{64}$/u.test(request.principal)) return yield* LspFault.make({code: 'rejected'});
      if (Native.runtimePlatform === 'win32') {
        const selected = yield* readSemanticPrivateProfile(options.profileHome, request.principal, options.worktree);
        if (selected.digest !== request.profile) return yield* LspFault.make({code: 'rejected'});
        return;
      }
      const directory = path.join(options.profileHome, 'semantic', 'profiles');
      const profileFile = path.join(directory, request.principal + '.json');
      const verify = Effect.gen(function* () {
        for (const folder of [options.profileHome, path.join(options.profileHome, 'semantic'), directory]) {
          const info = yield* fs.stat(folder);
          if (
            info.type !== 'Directory' ||
            (yield* fs.realPath(folder)) !== path.resolve(folder) ||
            Option.isSome(yield* fs.readLink(folder).pipe(Effect.option)) ||
            (info.mode & (folder === options.profileHome ? 0o022 : 0o077)) !== 0 ||
            (system.userId !== undefined && Option.isSome(info.uid) && info.uid.value !== system.userId)
          )
            return yield* LspFault.make({code: 'rejected'});
        }
        const info = yield* fs.stat(profileFile);
        if (
          info.type !== 'File' ||
          (info.mode & 0o077) !== 0 ||
          Number(info.size) > 16384 ||
          (yield* fs.realPath(profileFile)) !== profileFile ||
          Option.isSome(yield* fs.readLink(profileFile).pipe(Effect.option)) ||
          (system.userId !== undefined && Option.isSome(info.uid) && info.uid.value !== system.userId)
        )
          return yield* LspFault.make({code: 'rejected'});
      });
      yield* verify;
      const bytes = yield* readBounded(profileFile, 16384);
      const raw = yield* Effect.try({
        try: () => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)),
        catch: () => LspFault.make({code: 'rejected'}),
      });
      const profile = yield* Schema.decodeUnknownEffect(SemanticHostProfile, {onExcessProperty: 'error'})(raw).pipe(
        Effect.mapError(() => LspFault.make({code: 'rejected'})),
      );
      yield* verify;
      if (!profile.enabled || profile.worktree !== options.worktree || sha256HexSync(bytes) !== request.profile)
        return yield* LspFault.make({code: 'rejected'});
    });
  const pageResult = (base: object, proposal: SemanticProposal, maxBytes: number, offset?: number) =>
    Effect.try({
      try: () => ({
        ...base,
        page: proposalPage(proposal, {
          offset,
          maxBytes: maxBytes - new TextEncoder().encode(JSON.stringify(base)).length - 16,
        }),
      }),
      catch: () => LspFault.make({code: 'capacity'}),
    });
  const execute = (
    request: SemanticAgentEndpointChange,
    buffer: Observation | undefined,
    enter: (phase: ServiceTimeoutPhase) => Effect.Effect<void>,
    publication: {published: boolean; expected?: unknown; assertCurrentSync?: () => void},
  ) =>
    Effect.gen(function* () {
      if (request.worktree !== options.worktree) return changeRefusal('conflict', 'Different authenticated worktree');
      yield* verifyScope(request);
      if (request.action === 'prepare') {
        if (
          !request.project ||
          !request.uri ||
          !request.language ||
          !request.position ||
          !request.operation ||
          (request.operation === 'rename' ? !request.newName : !request.range)
        )
          return changeRefusal('invalid-request', 'A complete rename request is required');
        const file = yield* path.fromFileUrl(new URL(request.uri));
        const project = yield* path.fromFileUrl(new URL(request.project));
        if (
          !(project === root || EffectString.startsWith(root + path.sep)(project)) ||
          !EffectString.startsWith(project + path.sep)(file) ||
          EffectString.split(path.sep)(file).includes('.git') ||
          (yield* fs.realPath(file)) !== file ||
          (yield* fs.realPath(project)) !== project
        )
          return changeRefusal('conflict', 'Source escaped the authorized project');
        yield* enter('source-attach');
        let observed = buffer;
        if (!observed) {
          const bytes = yield* readBounded(file, semanticAgentChangeLimits.maxSourceBytes);
          const text = yield* Effect.try({
            try: () => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes),
            catch: () => LspFault.make({code: 'protocol'}),
          });
          const seed: Observation = {
            version: 1,
            repository: sha256HexSync(options.worktree),
            worktree: options.worktree,
            project: request.project,
            configuration: EffectString.repeat(64)('0'),
            toolchain: EffectString.repeat(64)('0'),
            provider: {id: semanticHostSelection[request.language].provider, version: 'host-unbound', generation: 0},
            view: {
              kind: 'disk',
              id: sha256HexSync(JSON.stringify([request.project, request.language])),
              owner: 'agent-change:' + namespace,
              epoch: 0,
            },
            uri: request.uri,
            content: sha256HexSync(bytes),
            documentVersion: null,
            projectEpoch: 0,
          };
          observed = (yield* coordinator.attach(seed, text, request.language, request.environment)).observation;
        }
        yield* enter('choice-binding');
        const choiceBinding = sha256HexSync(
          JSON.stringify([
            binding(request.profile, request.principal),
            request.project,
            request.uri,
            request.language,
            request.environment ?? null,
            request.view ?? 'disk',
            request.range ?? null,
            request.only ?? null,
            request.diagnosticIds ?? null,
          ]),
        );
        const selected = request.choiceHandle
          ? yield* choices.get(request.choiceHandle, choiceBinding, observed)
          : undefined;
        if (request.choiceHandle && !selected)
          return changeRefusal('stale', 'Choice expired or source/query/host binding changed');
        yield* enter('provider-use');
        const usePrepared =
          coordinator.usePrepared ??
          ((
            observation: Observation,
            milliseconds: number,
            f: (api: SemanticSession) => Effect.Effect<QueryOutcome, unknown>,
          ) =>
            coordinator
              .use(observation, milliseconds, f)
              .pipe(Effect.map(outcome => ({kind: 'ordinary' as const, outcome}))));
        const hostResult = yield* usePrepared(observed, request.milliseconds, api =>
          request.operation === 'code-action'
            ? api.actions
              ? api.actions(
                  observed,
                  {
                    range: request.range!,
                    ...(request.only ? {only: request.only} : {}),
                    ...(request.diagnosticIds ? {diagnosticIds: request.diagnosticIds} : {}),
                  },
                  request.milliseconds,
                  selected ? {selector: selected.selector, queryDigest: selected.queryDigest} : undefined,
                )
              : Effect.succeed<QueryOutcome>({
                  version: 1,
                  status: 'unsupported',
                  reason: 'Provider action family unqualified',
                  evidence: null,
                })
            : api.prepare
              ? api.prepare('rename', observed, request.position!, request.newName, request.milliseconds)
              : Effect.succeed<QueryOutcome>({
                  version: 1,
                  status: 'unsupported',
                  reason: 'Provider preparation unavailable',
                  evidence: null,
                }),
        );
        const outcome = hostResult.outcome;
        if (request.choiceHandle && !(yield* choices.get(request.choiceHandle, choiceBinding, observed)))
          return changeRefusal('stale', 'Selected action capability expired during preparation');
        if (outcome.status !== 'ok') return outcome;
        const first = outcome.items[0];
        const preparedItem =
          first &&
          typeof first === 'object' &&
          !EffectArray.isArray(first) &&
          'kind' in first &&
          first.kind === 'prepared-edit';
        if (request.operation === 'code-action' && !preparedItem) {
          const actionResult =
            first &&
            typeof first === 'object' &&
            !EffectArray.isArray(first) &&
            'kind' in first &&
            first.kind === 'action-result'
              ? yield* Schema.decodeUnknownEffect(
                  Schema.Struct({status: Schema.String, reason: Schema.optionalKey(Schema.String)}),
                )(first)
              : undefined;
          const listingItems = actionResult ? EffectArray.drop(outcome.items, 1) : outcome.items;
          const listing = yield* Schema.decodeUnknownEffect(Schema.Array(SemanticActionChoice))(listingItems);
          if (!listing.length)
            return {
              ...changeRefusal(actionResult?.status ?? 'no-match', actionResult?.reason ?? 'No matching code actions'),
              evidence: outcome.evidence,
              choices: [],
            };
          yield* enter('source-currentness');
          const current = yield* coordinator.observe(outcome.evidence.observation, request.milliseconds);
          if (!current || observationKey(current) !== observationKey(outcome.evidence.observation))
            return changeRefusal('stale', 'Source changed before action list publication');
          yield* enter('retain-result');
          let published = false;
          return yield* Effect.acquireUseRelease(
            choices.retain(listing, choiceBinding, outcome.evidence.observation),
            retained =>
              Effect.gen(function* () {
                const result = {
                  ...changeRefusal(
                    actionResult?.status ?? 'choices',
                    actionResult?.reason ?? 'Explicit choice required',
                  ),
                  evidence: outcome.evidence,
                  observation: outcome.evidence.observation,
                  ...retained,
                  supportedAlternatives: {
                    readOnly: ['definition', 'references', 'hover', 'symbols'],
                    qualifiedInline: EffectArray.filter(
                      retained.choices,
                      choice => choice.qualified && !choice.command && !choice.disabled,
                    ),
                  },
                };
                if (new TextEncoder().encode(JSON.stringify(result)).length > request.maxBytes)
                  return changeRefusal('budget-exceeded', 'Complete action listing exceeds requested byte budget');
                yield* enter('publication');
                yield* verifyScope(request);
                const final = yield* coordinator.observe(outcome.evidence.observation, request.milliseconds);
                if (!final || observationKey(final) !== observationKey(outcome.evidence.observation))
                  return changeRefusal('stale', 'Source changed before action list publication');
                const now = yield* Clock.currentTimeMillis;
                if (now >= retained.expiresAt || now < retained.createdAt)
                  return changeRefusal('stale', 'Action choices expired before publication');
                yield* verifyScope(request);
                if (request.choiceHandle && !(yield* choices.get(request.choiceHandle, choiceBinding, observed)))
                  return changeRefusal('stale', 'Selected action capability expired before publication');
                published = true;
                return result;
              }),
            retained =>
              published
                ? Effect.void
                : choices.discard(
                    EffectArray.map(retained.choices, choice => choice.choiceHandle),
                    choiceBinding,
                  ),
          );
        }
        if (request.operation === 'code-action' && !selected)
          return changeRefusal('unsupported', 'Provider cannot substitute a proposal for explicit action selection');
        if (outcome.items.length !== 1)
          return changeRefusal('unsupported', 'Provider did not return a complete qualified source basis');
        const prepared = yield* Schema.decodeUnknownEffect(Prepared)(outcome.items[0]).pipe(
          Effect.mapError(() => LspFault.make({code: 'protocol'})),
        );
        if (
          prepared.operation !== request.operation ||
          (prepared.sourceBasis === 'unqualified-operation-sequence-v1') !==
            (prepared.qualification === 'unsupported-operation-sequence') ||
          (request.operation === 'rename' && prepared.sourceBasis === 'unqualified-operation-sequence-v1')
        )
          return changeRefusal('unsupported', 'Provider source qualification does not match the whole operation');
        yield* enter('retain-result');
        const proposal = yield* Effect.try({
          try: () =>
            createSemanticProposal(
              {
                ...(request.operation === 'code-action'
                  ? {
                      version: 2,
                      operation: 'code-action',
                      qualification: prepared.qualification ?? 'qualified-text-only',
                      operations: prepared.operations,
                      ...(prepared.changeAnnotations ? {changeAnnotations: prepared.changeAnnotations} : {}),
                    }
                  : {version: 1, operation: 'rename'}),
                evidence: outcome.evidence,
                targets: EffectArray.map(prepared.files, file => ({
                  observation: file.observation,
                  beforeText: file.beforeText,
                  ...(request.operation === 'code-action' && file.providerDocumentVersion !== undefined
                    ? {providerDocumentVersion: file.providerDocumentVersion}
                    : {}),
                  edits: file.edits,
                  precondition: file.precondition,
                })),
              },
              sha256HexSync,
            ),
          catch: () => LspFault.make({code: 'capacity'}),
        });
        if (hostResult.kind === 'writer-prepared') {
          if (Native.runtimePlatform === 'win32' && !hostResult.privateSourceProof)
            return changeRefusal('stale', 'Complete FIRST native proof is required');
          if (hostResult.privateSourceRows.length !== proposal.targets.length)
            return changeRefusal('stale', 'Private source basis does not cover the complete proposal');
          for (const [index, target] of proposal.targets.entries()) {
            const row = hostResult.privateSourceRows[index];
            if (
              !row ||
              row.capture.uri !== target.observation.uri ||
              row.capture.content !== target.precondition.rawDigest ||
              observationKey(row.observation) !== observationKey(target.observation)
            )
              return changeRefusal('stale', 'Private source basis does not match the complete proposal');
          }
        }
        if (proposal.version === 2) {
          for (const operation of proposal.operations) {
            const uris = operation.kind === 'rename' ? [operation.oldUri, operation.newUri] : [operation.uri];
            for (const uri of uris) {
              const file = yield* path.fromFileUrl(new URL(uri));
              if (
                !EffectString.startsWith(project + path.sep)(file) ||
                EffectString.split(path.sep)(file).includes('.git')
              )
                return changeRefusal('conflict', 'A complete action target escaped the authorized project');
              const parent = path.dirname(file);
              if ((yield* fs.realPath(parent)) !== parent || (yield* fs.stat(parent)).type !== 'Directory')
                return changeRefusal('conflict', 'Action destination parent is not canonical');
              if (yield* fs.exists(file)) {
                const stat = yield* fs.stat(file);
                if (
                  (yield* fs.realPath(file)) !== file ||
                  stat.type !== 'File' ||
                  Option.isNone(stat.nlink) ||
                  stat.nlink.value !== 1n
                )
                  return changeRefusal('conflict', 'Action resource is symlinked, aliased or not a file');
              }
            }
          }
        }
        const retained = yield* Effect.acquireRelease(
          store.retain(
            proposal,
            binding(request.profile, request.principal),
            hostResult.kind === 'writer-prepared' ? hostResult.privateSourceProof : undefined,
          ),
          retained =>
            publication.published
              ? Effect.void
              : store.discard(retained.handle, binding(request.profile, request.principal)).pipe(Effect.ignore),
        );
        const result = yield* pageResult(
          {
            version: 1,
            status:
              proposal.version === 2 && proposal.qualification === 'unsupported-operation-sequence'
                ? 'unsupported'
                : 'ok',
            ...(proposal.version === 2
              ? {qualification: proposal.qualification, operationCount: proposal.operations.length}
              : {}),
            applicable: false,
            writerAuthorityRequired: true,
            ...retained,
            evidence: proposal.evidence,
            targetCount: proposal.targets.length,
            complete: 'all-provider-returned-edits',
            observation: outcome.evidence.observation,
          },
          proposal,
          request.maxBytes,
        );
        yield* enter('publication');
        const current = yield* coordinator
          .observe(proposal.evidence.observation, request.milliseconds)
          .pipe(Effect.orElseSucceed(() => undefined));
        if (!current || observationKey(current) !== observationKey(proposal.evidence.observation))
          return changeRefusal('stale', 'Initiating view changed before publication');
        const publicationTime = yield* Clock.currentTimeMillis;
        if (publicationTime >= retained.expiresAt || publicationTime < retained.createdAt)
          return changeRefusal('stale', 'Proposal lifetime expired before publication');
        yield* verifyScope(request);
        if (request.choiceHandle && !(yield* choices.get(request.choiceHandle, choiceBinding, observed)))
          return changeRefusal('stale', 'Selected action capability expired before publication');
        publication.expected = result;
        publication.assertCurrentSync =
          hostResult.kind === 'writer-prepared' ? hostResult.assertCurrentSync : undefined;
        return result;
      }
      if (!request.handle) return changeRefusal('invalid-request', 'Proposal read capability required');
      yield* enter('retained-proposal-check');
      const retained = yield* store.get(request.handle, binding(request.profile, request.principal));
      if (request.action === 'invalidate-for-writer') {
        // This read capability can invalidate only its retained observations; it never grants a source write.
        yield* verifyScope(request);
        return {
          version: 1,
          status: 'writer-invalidation',
          observations: EffectArray.map(retained.proposal.targets, target => target.observation),
        };
      }
      const unsupportedSequence =
        retained.proposal.version === 2 && retained.proposal.qualification === 'unsupported-operation-sequence';
      const conflicts: {uri: string; reason: string}[] = unsupportedSequence
        ? [{uri: retained.proposal.evidence.observation.uri, reason: 'unsupported-operation-sequence'}]
        : [];
      {
        for (const target of retained.proposal.targets) {
          const uri = target.observation.uri;
          const checked = yield* Effect.gen(function* () {
            if (target.precondition.sourceKind === 'disk') {
              const file = yield* path.fromFileUrl(new URL(uri));
              if (
                !EffectString.startsWith(root + path.sep)(file) ||
                EffectString.split(path.sep)(file).includes('.git') ||
                (yield* fs.realPath(file)) !== file
              )
                return 'path-conflict';
              const stat = yield* fs.stat(file);
              if (
                stat.type !== 'File' ||
                Option.isNone(stat.ino) ||
                Option.isNone(stat.nlink) ||
                stat.nlink.value !== 1n
              )
                return 'physical-identity-conflict';
              if (target.precondition.physicalIdentity !== JSON.stringify([String(stat.dev), String(stat.ino.value)]))
                return 'physical-identity-conflict';
              if (Native.runtimePlatform !== 'win32' && request.action === 'preflight' && (stat.mode & 0o222) === 0)
                return 'readonly';
              if (
                sha256HexSync(yield* readBounded(file, semanticAgentChangeLimits.maxSourceBytes)) !==
                target.precondition.rawDigest
              )
                return 'source-changed';
            }
            const current = yield* coordinator.observe(target.observation, request.milliseconds);
            return !current || observationKey(current) !== observationKey(target.observation) ? 'view-stale' : null;
          }).pipe(Effect.orElseSucceed(() => 'source-unavailable'));
          if (checked) conflicts.push({uri, reason: checked});
        }
      }
      const finalView = yield* coordinator
        .observe(retained.proposal.evidence.observation, request.milliseconds)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (!finalView || observationKey(finalView) !== observationKey(retained.proposal.evidence.observation))
        conflicts.push({uri: retained.proposal.evidence.observation.uri, reason: 'view-stale'});
      const publicationTime = yield* Clock.currentTimeMillis;
      if (publicationTime >= retained.expiresAt || publicationTime < retained.createdAt)
        return changeRefusal('stale', 'Proposal lifetime expired before publication');
      const base = {
        version: 1,
        status: unsupportedSequence
          ? 'unsupported'
          : conflicts.length
            ? request.action === 'preflight'
              ? 'conflict'
              : 'stale'
            : retained.stale
              ? 'stale'
              : 'ok',
        applicable: false,
        writerAuthorityRequired: true,
        stale: retained.stale || conflicts.length > 0,
        id: request.handle.id,
        digest: request.handle.digest,
        createdAt: retained.createdAt,
        expiresAt: retained.expiresAt,
        checkedAt: yield* Clock.currentTimeMillis,
        conflicts,
        reason: conflicts.length ? 'Whole preflight rejected' : 'Read-only preview; writer authority is required',
      };
      if (request.action === 'resolve-for-writer') {
        if (unsupportedSequence)
          return changeRefusal('unsupported', 'The complete operation sequence has no qualified writer');
        if (base.status !== 'ok' || retained.stale || unsupportedSequence)
          return changeRefusal('stale', 'A current complete qualified proposal is required');
        if (Native.runtimePlatform === 'win32' && retained.windows?.proof.kind !== 'complete')
          return changeRefusal('stale', 'Historical preview has no complete native writer proof');
        const processStartIdentity = system.canonicalProcessStartIdentity
          ? yield* system.canonicalProcessStartIdentity(system.processId)
          : undefined;
        if (!processStartIdentity) return changeRefusal('unavailable', 'Coordinator process identity is unavailable');
        yield* verifyScope(request);
        const result = {
          version: Native.runtimePlatform === 'win32' ? 2 : 1,
          ...(Native.runtimePlatform === 'win32' ? {windows: retained.windows} : {}),
          status: 'writer-proposal',
          proposal: retained.proposal,
          worktree: options.worktree,
          principal: request.principal,
          profile: request.profile,
          expiresAt: retained.expiresAt,
          session: {
            processId: system.processId,
            processStartIdentity,
            boot: namespace,
            runtimeIdentity: options.runtimeIdentity,
          },
        };
        if (new TextEncoder().encode(JSON.stringify(result)).length > request.maxBytes)
          return changeRefusal('budget-exceeded', 'Complete proposal exceeds the private handoff budget');
        return result;
      }
      return request.action === 'status'
        ? yield* pageResult(base, retained.proposal, request.maxBytes, request.offset)
        : base;
    });
  return {
    execute: (request: SemanticAgentEndpointChange, buffer?: Observation) =>
      Effect.scoped(
        Effect.gen(function* () {
          const publication: {published: boolean; expected?: unknown; assertCurrentSync?: () => void} = {
            published: false,
          };
          return yield* observeServiceTimeout(request.milliseconds, enter =>
            execute(request, buffer, enter, publication).pipe(
              Effect.tap(() => enter('publication').pipe(Effect.andThen(verifyScope(request)))),
            ),
          ).pipe(
            Effect.flatMap(result => {
              if (new TextEncoder().encode(JSON.stringify(result)).length > request.maxBytes)
                return Effect.succeed(
                  changeRefusal('budget-exceeded', 'Result metadata exceeds the requested byte budget'),
                );
              return Effect.try({
                try: () => {
                  if (result === publication.expected) {
                    publication.assertCurrentSync?.();
                    publication.published = true;
                  }
                  return result;
                },
                catch: () => LspFault.make({code: 'rejected'}),
              });
            }),
            Effect.catch(error =>
              Effect.succeed(
                Schema.is(LspFault)(error) && error.code === 'capacity'
                  ? changeRefusal('budget-exceeded', 'Whole proposal or next chunk exceeds capacity')
                  : changeRefusal('stale', 'Proposal capability, source or scope is unavailable'),
              ),
            ),
          );
        }),
      ),
  };
});
