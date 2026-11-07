import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {Digest as EffectDigest, SecureRandom} from 'effect/crypto';
import {Array as EffectArray, Clock, Effect, FileSystem, Option, Path, Schema, String as EffectString} from 'effect';
import {canonicalFileUri, Observation, observationKey, type QueryOutcome} from '@threadnote/semantic/contracts';
import {createSemanticProposal, proposalPage, type SemanticProposal} from '@threadnote/semantic/proposals';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {semanticAgentQueryHost, type SemanticAgentQueryHost} from './agent_queries.js';
import {SemanticHostProfile, semanticHostProfileName, readSemanticHostProfile} from './host_profile.js';
import {semanticHostSelection} from './host_catalog.js';
import {SemanticLanguage, SemanticRange, type SemanticSession} from './provider.js';
import {SystemInfo} from '@threadnote/platform/system';
import {makeSemanticActionChoices, SemanticActionChoice} from './action_choices.js';
import {LspFault} from './lsp_transport.js';
import {readBounded} from './fingerprint.js';
import {makeSemanticProposalStore} from './proposal_store.js';
import {
  SemanticAgentChangeRequest,
  semanticAgentChangeLimits,
  type SemanticAgentEndpointChange,
  changeRefusal,
} from './agent_change_protocol.js';

/** Public JSON supplies a request, never the host read scope or a writer grant. */
export const runSemanticAgentChangeWith = <R>(
  services: SemanticAgentQueryHost<R>,
  config: RuntimeConfig,
  input: unknown,
) =>
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
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!path.isAbsolute(request.callerCwd))
      return changeRefusal('invalid-request', 'An absolute worktree is required');
    const root = yield* fs.realPath(request.callerCwd);
    const worktree = canonicalFileUri((yield* path.toFileUrl(root)).href);
    const selected = yield* readSemanticHostProfile(config, worktree);
    const runtimeIdentity = yield* services.runtimeIdentity;
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
    const endpoint = yield* services.connect({
      enabled: true,
      dataHome: selected.home,
      worktree,
      runtimeIdentity,
      ...selected.profile.catalog,
    });
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
    const current = yield* readSemanticHostProfile(config, worktree);
    if (current.digest !== selected.digest) return changeRefusal('stale', 'Host read scope changed before publication');
    return result;
  }).pipe(
    Effect.timeoutOption(
      Schema.is(SemanticAgentChangeRequest)(input)
        ? (input.milliseconds ?? semanticAgentChangeLimits.defaultMilliseconds)
        : semanticAgentChangeLimits.defaultMilliseconds,
    ),
    Effect.map(result =>
      result._tag === 'Some' ? result.value : changeRefusal('timeout', 'Proposal deadline expired'),
    ),
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
  const execute = (request: SemanticAgentEndpointChange, buffer?: Observation) =>
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
        const outcome: QueryOutcome = yield* coordinator.use(observed, request.milliseconds, api =>
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
          const current = yield* coordinator.observe(outcome.evidence.observation, request.milliseconds);
          if (!current || observationKey(current) !== observationKey(outcome.evidence.observation))
            return changeRefusal('stale', 'Source changed before action list publication');
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
        let published = false;
        return yield* Effect.acquireUseRelease(
          store.retain(proposal, binding(request.profile, request.principal)),
          retained =>
            Effect.gen(function* () {
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
              published = true;
              return result;
            }),
          retained =>
            published
              ? Effect.void
              : store.discard(retained.handle, binding(request.profile, request.principal)).pipe(Effect.ignore),
        );
      }
      if (!request.handle) return changeRefusal('invalid-request', 'Proposal read capability required');
      const retained = yield* store.get(request.handle, binding(request.profile, request.principal));
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
              if (request.action === 'preflight' && (stat.mode & 0o222) === 0) return 'readonly';
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
      return request.action === 'status'
        ? yield* pageResult(base, retained.proposal, request.maxBytes, request.offset)
        : base;
    });
  return {
    execute: (request: SemanticAgentEndpointChange, buffer?: Observation) =>
      execute(request, buffer).pipe(
        Effect.tap(() => verifyScope(request)),
        Effect.timeoutOption(request.milliseconds),
        Effect.map(result =>
          result._tag === 'Some' ? result.value : changeRefusal('timeout', 'Proposal deadline expired'),
        ),
        Effect.map(result =>
          new TextEncoder().encode(JSON.stringify(result)).length <= request.maxBytes
            ? result
            : changeRefusal('budget-exceeded', 'Result metadata exceeds the requested byte budget'),
        ),
        Effect.catch(error =>
          Effect.succeed(
            Schema.is(LspFault)(error) && error.code === 'capacity'
              ? changeRefusal('budget-exceeded', 'Whole proposal or next chunk exceeds capacity')
              : changeRefusal('stale', 'Proposal capability, source or scope is unavailable'),
          ),
        ),
      ),
  };
});
