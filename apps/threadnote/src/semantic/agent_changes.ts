import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {Digest as EffectDigest, SecureRandom} from 'effect/crypto';
import {Array as EffectArray, Clock, Effect, FileSystem, Option, Path, Schema, String as EffectString} from 'effect';
import {canonicalFileUri, Observation, observationKey, type QueryOutcome} from '@threadnote/semantic/contracts';
import {createSemanticProposal, proposalPage, type SemanticProposal} from '@threadnote/semantic/proposals';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {semanticAgentQueryHost, type SemanticAgentQueryHost} from './agent_queries.js';
import {readSemanticHostProfile} from './host_profile.js';
import {semanticHostSelection} from './host_catalog.js';
import {SemanticLanguage, SemanticRange, type SemanticSession} from './provider.js';
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
      if (request.operation !== 'rename')
        return changeRefusal('unsupported', 'Code-action list/select and resolution families remain unqualified');
      if (!request.newName || request.choiceHandle)
        return changeRefusal('invalid-request', 'Rename requires newName and no action choice');
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
        position: request.position,
        newName: request.newName,
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
  operation: Schema.Literal('rename'),
  sourceBasis: Schema.Literal('pre-request-synchronized-text-v1'),
  files: Schema.Array(
    Schema.Struct({
      observation: Observation,
      beforeText: Schema.String,
      edits: Schema.Array(Schema.Struct({range: SemanticRange, newText: Schema.String})),
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
  options: {directory: string; worktree: string; runtimeIdentity: string},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const namespace = sha256HexSync(yield* random.randomBytes(32));
  const store = yield* makeSemanticProposalStore({directory: path.join(options.directory, 'proposals'), namespace});
  const root = yield* path.fromFileUrl(new URL(options.worktree));
  const binding = (profile: string) =>
    sha256HexSync(JSON.stringify([options.worktree, profile, options.runtimeIdentity]));
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
      if (request.action === 'prepare') {
        if (
          !request.project ||
          !request.uri ||
          !request.language ||
          !request.position ||
          !request.newName ||
          request.operation !== 'rename'
        )
          return changeRefusal('invalid-request', 'A complete rename request is required');
        if (!['typescript', 'typescriptreact', 'javascript', 'javascriptreact'].includes(request.language))
          return changeRefusal('unsupported', 'Provider edit source basis is unqualified');
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
        const outcome: QueryOutcome = yield* coordinator.use(observed, request.milliseconds, api =>
          api.prepare
            ? api.prepare('rename', observed, request.position!, request.newName, request.milliseconds)
            : Effect.succeed<QueryOutcome>({
                version: 1,
                status: 'unsupported',
                reason: 'Provider preparation unavailable',
                evidence: null,
              }),
        );
        if (outcome.status !== 'ok') return outcome;
        if (outcome.items.length !== 1)
          return changeRefusal('unsupported', 'Provider did not return a complete qualified source basis');
        const prepared = yield* Schema.decodeUnknownEffect(Prepared)(outcome.items[0]).pipe(
          Effect.mapError(() => LspFault.make({code: 'protocol'})),
        );
        const proposal = yield* Effect.try({
          try: () =>
            createSemanticProposal(
              {
                version: 1,
                operation: 'rename',
                evidence: outcome.evidence,
                targets: EffectArray.map(prepared.files, file => ({
                  observation: file.observation,
                  beforeText: file.beforeText,
                  edits: file.edits,
                  precondition: file.precondition,
                })),
              },
              sha256HexSync,
            ),
          catch: () => LspFault.make({code: 'capacity'}),
        });
        let published = false;
        return yield* Effect.acquireUseRelease(
          store.retain(proposal, binding(request.profile)),
          retained =>
            Effect.gen(function* () {
              const result = yield* pageResult(
                {
                  version: 1,
                  status: 'ok',
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
              published = true;
              return result;
            }),
          retained =>
            published ? Effect.void : store.discard(retained.handle, binding(request.profile)).pipe(Effect.ignore),
        );
      }
      if (!request.handle) return changeRefusal('invalid-request', 'Proposal read capability required');
      const retained = yield* store.get(request.handle, binding(request.profile));
      const conflicts: {uri: string; reason: string}[] = [];
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
        status: conflicts.length
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
