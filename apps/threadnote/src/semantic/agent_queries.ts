import {Effect, FileSystem, Path, Schema, String as EffectString} from 'effect';
import {canonicalFileUri, observationKey} from '@threadnote/semantic/contracts';
import {sha256FileHex} from '@threadnote/platform/digest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import {getThreadnoteVersion, isStandaloneThreadnoteBuild} from '@threadnote/workspace/runtime-version';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {ensureSemanticEndpoint} from './coordinator.js';
import {LspFault} from './lsp_transport.js';
import {SemanticLanguage, SemanticSessionFault} from './provider.js';
import {readSemanticHostProfile, SemanticHostProfileFault} from './host_profile.js';
import {
  SemanticAgentQuery,
  SemanticAgentQueryResult,
  SemanticAgentReadOperation,
  semanticAgentQueryKey,
} from './agent_query_protocol.js';
import {semanticHostSelection} from './host_catalog.js';

const fail = (status: Exclude<SemanticAgentQueryResult['status'], 'ok'>, reason: string): SemanticAgentQueryResult => ({
  version: 1,
  status,
  reason,
  evidence: null,
});

const compiledRuntimeIdentity = Effect.gen(function* () {
  // The first public binding qualifies standalone bytes. Source-mode protocol generations need a separate source-closure witness.
  if (!isStandaloneThreadnoteBuild()) return yield* SemanticHostProfileFault.make({reason: 'incompatible'});
  const system = yield* SystemInfo;
  const fs = yield* FileSystem.FileSystem;
  const executable = yield* fs.realPath(system.executablePath);
  const stat = yield* fs.stat(executable);
  if (stat.type !== 'File' || Number(stat.size) > 512 * 1024 * 1024)
    return yield* SemanticHostProfileFault.make({reason: 'incompatible'});
  return sha256HexSync(
    JSON.stringify([
      'threadnote-agent-read-v1',
      yield* getThreadnoteVersion(),
      executable,
      yield* sha256FileHex(executable),
    ]),
  );
});

/** Host-only injectable ports. Public JSON cannot supply these dependencies or their authority. */
export interface SemanticAgentQueryHost {
  readonly runtimeIdentity: typeof compiledRuntimeIdentity;
  readonly connect: typeof ensureSemanticEndpoint;
}
const host: SemanticAgentQueryHost = {runtimeIdentity: compiledRuntimeIdentity, connect: ensureSemanticEndpoint};

const executeSemanticAgentQueryWith = Effect.fn('semantic.agentQueryWith')(function* (
  services: SemanticAgentQueryHost,
  config: RuntimeConfig,
  input: unknown,
) {
  const invalid = () =>
    fail(
      'invalid-request',
      'Provide a bounded semantic read request with an explicit worktree, file, language and operation',
    );
  const parsed = yield* Effect.try({
    try: () => new TextEncoder().encode(JSON.stringify(input)).length,
    catch: invalid,
  }).pipe(
    Effect.flatMap(bytes =>
      bytes > 65536
        ? Effect.fail(invalid())
        : Schema.decodeUnknownEffect(SemanticAgentQuery, {onExcessProperty: 'error'})(input).pipe(
            Effect.mapError(invalid),
          ),
    ),
    Effect.result,
  );
  if (parsed._tag === 'Failure') return parsed.failure;
  const request = parsed.success;
  if (!Schema.is(SemanticLanguage)(request.language))
    return fail(
      'unsupported',
      request.language === 'kotlin' ? 'Kotlin remains deferred' : 'No semantic provider is selected for this language',
    );
  if (!Schema.is(SemanticAgentReadOperation)(request.operation))
    return fail(
      'unsupported',
      'This surface supports saved-disk navigation and document diagnostics; public context and changes remain pending',
    );
  const language = request.language;
  const operation = request.operation;
  if (operation === 'diagnostics' && request.position !== undefined)
    return fail('invalid-request', 'Diagnostics reports the attached document; omit position');
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  if (!path.isAbsolute(request.callerCwd))
    return fail('invalid-request', 'callerCwd must identify an absolute worktree root');
  const worktreePath = yield* fs.realPath(request.callerCwd);
  const contained = (root: string, target: string) =>
    target === root || EffectString.startsWith(root + path.sep)(target);
  const requestedProject = path.resolve(worktreePath, request.project ?? '.');
  if (!contained(worktreePath, requestedProject))
    return fail('invalid-request', 'Project must remain inside the selected worktree');
  const projectPath = yield* fs.realPath(requestedProject);
  const resolvedFile = yield* (
    EffectString.startsWith('file:')(request.file)
      ? Effect.try({try: () => new URL(request.file), catch: () => LspFault.make({code: 'protocol'})}).pipe(
          Effect.flatMap(url => path.fromFileUrl(url)),
        )
      : Effect.succeed(path.resolve(projectPath, request.file))
  ).pipe(Effect.result);
  if (resolvedFile._tag === 'Failure')
    return fail('invalid-request', 'File must identify a valid local file URI or project path');
  const filePath = resolvedFile.success;
  if (
    !contained(worktreePath, projectPath) ||
    !contained(projectPath, filePath) ||
    filePath === projectPath ||
    (yield* fs.realPath(filePath)) !== filePath ||
    (yield* fs.stat(filePath)).type !== 'File'
  )
    return fail('invalid-request', 'The file and project must remain inside the selected canonical worktree');
  const worktree = canonicalFileUri((yield* path.toFileUrl(worktreePath)).href);
  const project = canonicalFileUri((yield* path.toFileUrl(projectPath)).href);
  const uri = canonicalFileUri((yield* path.toFileUrl(filePath)).href);
  const selected = yield* readSemanticHostProfile(config, worktree);
  if (!selected.profile.catalog[semanticHostSelection[language].slot])
    return fail('unavailable', 'The selected provider is not configured in this worktree host profile');
  const runtimeIdentity = yield* services.runtimeIdentity;
  const query = semanticAgentQueryKey(runtimeIdentity, selected.digest, {
    worktree,
    project,
    uri,
    language,
    operation,
    ...(request.position ? {position: request.position} : {}),
    ...(request.environment ? {environment: request.environment} : {}),
  });
  if (request.cursor && request.cursor.query !== query)
    return fail('stale', 'Continuation belongs to a different query, configuration or runtime');
  const endpoint = yield* services.connect({
    enabled: true,
    dataHome: selected.home,
    worktree,
    runtimeIdentity,
    ...selected.profile.catalog,
  });
  const raw = yield* endpoint.request({
    operation: 'agent-query',
    request: {
      worktree,
      project,
      uri,
      language,
      operation,
      query,
      profile: selected.digest,
      ...(request.position ? {position: request.position} : {}),
      ...(request.environment ? {environment: request.environment} : {}),
      maxItems: request.maxItems ?? 20,
      maxBytes: request.maxBytes ?? 3200,
      milliseconds: request.milliseconds ?? 10000,
      ...(request.cursor ? {cursor: request.cursor} : {}),
    },
  });
  const result = yield* Schema.decodeUnknownEffect(SemanticAgentQueryResult)(raw).pipe(
    Effect.catch(() => {
      const rejected = Schema.Struct({status: Schema.Literal('unavailable'), reason: Schema.String});
      if (!Schema.is(rejected)(raw)) return Effect.fail(LspFault.make({code: 'protocol'}));
      const cause = raw.reason;
      return Effect.succeed(
        fail(
          cause === 'invalid'
            ? 'invalid-request'
            : cause === 'timeout'
              ? 'timeout'
              : cause === 'stale' || cause === 'rejected'
                ? 'stale'
                : cause === 'conflict'
                  ? 'conflict'
                  : 'unavailable',
          cause === 'invalid'
            ? 'Position or target is invalid for the selected source view'
            : cause === 'timeout'
              ? 'Semantic query deadline expired'
              : cause === 'rejected' || cause === 'stale'
                ? 'Source view or analysis prerequisites changed; start a new query'
                : cause === 'conflict'
                  ? 'Source view ownership conflicts with this query'
                  : 'Semantic provider prerequisites or capacity are unavailable; inspect host setup without running a build or download',
        ),
      );
    }),
  );
  if (result.evidence) {
    const observed = result.evidence.observation;
    if (
      observed.worktree !== worktree ||
      observed.project !== project ||
      observed.uri !== uri ||
      observed.view.kind !== 'disk' ||
      observed.provider.id !== semanticHostSelection[language].provider
    )
      return fail('conflict', 'Coordinator returned evidence for a different source scope');
  }
  if (result.status === 'ok') {
    const next = result.next;
    const observed = observationKey(result.evidence.observation);
    if (
      result.offset !== (request.cursor?.offset ?? 0) ||
      (request.cursor && request.cursor.observation !== observed) ||
      result.remaining > 0 !== (next !== null) ||
      (next &&
        (result.items.length === 0 ||
          next.offset !== result.offset + result.items.length ||
          next.query !== query ||
          next.observation !== observed ||
          (request.cursor && next.snapshot !== request.cursor.snapshot)))
    )
      return fail('stale', 'Coordinator returned an incompatible retained page');
    if (
      result.items.length > (request.maxItems ?? 20) ||
      new TextEncoder().encode(JSON.stringify(result)).length > (request.maxBytes ?? 3200)
    )
      return fail('budget-exceeded', 'Coordinator response exceeds the requested page limits');
  } else if (new TextEncoder().encode(JSON.stringify(result)).length > (request.maxBytes ?? 3200)) {
    return fail(
      result.status,
      'Operation returned ' + result.status + '; source metadata omitted because it exceeds the requested budget',
    );
  }
  const current = yield* readSemanticHostProfile(config, worktree);
  return current.digest === selected.digest
    ? result
    : fail('stale', 'Host configuration changed before query publication');
});

/** One normalized application flow, with narrow host ports for focused boundary tests. */
export const runSemanticAgentQueryWith = (services: SemanticAgentQueryHost, config: RuntimeConfig, input: unknown) =>
  executeSemanticAgentQueryWith(services, config, input).pipe(
    Effect.timeoutOption(Schema.is(SemanticAgentQuery)(input) ? (input.milliseconds ?? 10000) : 45000),
    Effect.map(result => (result._tag === 'None' ? fail('timeout', 'Semantic query deadline expired') : result.value)),
    Effect.catch(error =>
      Effect.succeed(
        fail(
          Schema.is(LspFault)(error) && error.code === 'timeout'
            ? 'timeout'
            : Schema.is(SemanticSessionFault)(error) && error.reason === 'conflict'
              ? 'conflict'
              : 'unavailable',
          Schema.is(SemanticHostProfileFault)(error)
            ? 'Semantic host profile is ' +
                error.reason +
                '; configure an explicit private host profile and use a standalone runtime. Structural graph and memory remain available.'
            : 'Semantic read prerequisites are unavailable; inspect the selected host profile and source view',
        ),
      ),
    ),
  );

/** Production CLI and MCP use exactly the same host binding and outcome semantics. */
export const runSemanticAgentQuery = (config: RuntimeConfig, input: unknown) =>
  runSemanticAgentQueryWith(host, config, input);
