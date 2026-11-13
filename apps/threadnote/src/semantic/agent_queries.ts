import {Array as EffectArray, Clock, Effect, FileSystem, Path, Schema, String as EffectString} from 'effect';
import {canonicalFileUri, Observation, observationKey, type Evidence} from '@threadnote/semantic/contracts';
import {AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN} from '@threadnote/protocol/agent-response';
import type {
  SemanticContextKnowledgeV1,
  SemanticContextSymbolTarget,
  SemanticContextDefinitionGap,
  ContextBriefRequestV1,
} from '@threadnote/context/types';
import {compactSemanticContextKnowledge} from '@threadnote/context/compiler';
import {compileSemanticContextKnowledge} from '../context_brief/index.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {ensureSemanticEndpoint} from './coordinator.js';
import {LspFault} from './lsp_transport.js';
import {semanticCompiledRuntimeIdentity} from './readiness_jobs.js';
import {SemanticLanguage, SemanticSessionFault} from './provider.js';
import {readSemanticHostProfile, SemanticHostProfileFault} from './host_profile.js';
import {
  SemanticAgentQuery,
  SemanticAgentViewRequest,
  SemanticAgentViewSuccess,
  semanticAgentBufferLimits,
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
const EndpointRefusal = Schema.Struct({status: Schema.Literal('unavailable'), reason: Schema.String});
const endpointFailure = (cause: string) =>
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
  );

const compiledRuntimeIdentity = semanticCompiledRuntimeIdentity;

/** Host-only injectable ports. Public JSON cannot supply these dependencies or their authority. */
export interface SemanticAgentQueryHost<ContextR = never> {
  readonly runtimeIdentity: typeof compiledRuntimeIdentity;
  readonly knowledgeAuthorized?: boolean;
  readonly connect: typeof ensureSemanticEndpoint;
  readonly context?: (
    config: RuntimeConfig,
    input: ContextBriefRequestV1,
    evidence: Evidence,
    target: SemanticContextSymbolTarget | null,
  ) => Effect.Effect<SemanticContextKnowledgeV1, unknown, ContextR>;
}
export const semanticAgentQueryHost = {
  runtimeIdentity: compiledRuntimeIdentity,
  connect: (...args: Parameters<typeof ensureSemanticEndpoint>) => ensureSemanticEndpoint(...args),
  context: compileSemanticContextKnowledge,
};

const executeSemanticAgentQueryWith = Effect.fn('semantic.agentQueryWith')(function* <ContextR>(
  services: SemanticAgentQueryHost<ContextR>,
  config: RuntimeConfig,
  input: unknown,
) {
  const startedAt = yield* Clock.currentTimeMillis;
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
  const contextQuery = request.operation === 'context';
  if (contextQuery && (!request.task || !request.position || request.cursor))
    return fail('invalid-request', 'Context requires task and position; start a new request without a cursor');
  if (!contextQuery && (request.task !== undefined || request.budgetTokens !== undefined))
    return fail('invalid-request', 'Task and context budget apply only to the context operation');
  if (!Schema.is(SemanticLanguage)(request.language))
    return fail(
      'unsupported',
      request.language === 'kotlin' ? 'Kotlin remains deferred' : 'No semantic provider is selected for this language',
    );
  if (!contextQuery && !Schema.is(SemanticAgentReadOperation)(request.operation))
    return fail(
      'unsupported',
      'This surface supports saved-disk navigation, document diagnostics and context; changes remain pending',
    );
  const language = request.language;
  const operation = contextQuery ? 'hover' : request.operation;
  if (!Schema.is(SemanticAgentReadOperation)(operation)) return invalid();
  const limit = contextQuery
    ? Math.min(request.maxBytes ?? 8192, (request.budgetTokens ?? 1500) * AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN)
    : (request.maxBytes ?? 3200);
  const remaining = Effect.gen(function* () {
    return Math.max(1, (request.milliseconds ?? 10000) - ((yield* Clock.currentTimeMillis) - startedAt));
  });
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
    ...(typeof request.view === 'object' ? {view: request.view} : {}),
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
      ...(typeof request.view === 'object' ? {view: request.view} : {}),
      maxItems: request.maxItems ?? 20,
      maxBytes: limit,
      milliseconds: yield* remaining,
      ...(request.cursor ? {cursor: request.cursor} : {}),
    },
  });
  let result = yield* Schema.decodeUnknownEffect(SemanticAgentQueryResult)(raw).pipe(
    Effect.catch(() => {
      if (!Schema.is(EndpointRefusal)(raw)) return Effect.fail(LspFault.make({code: 'protocol'}));
      return Effect.succeed(endpointFailure(raw.reason));
    }),
  );
  if (result.evidence) {
    const observed = result.evidence.observation;
    if (
      observed.worktree !== worktree ||
      observed.project !== project ||
      observed.uri !== uri ||
      (typeof request.view === 'object'
        ? observed.view.kind !== 'overlay' ||
          observed.view.id !== request.view.handle.id ||
          observed.documentVersion !== request.view.documentVersion
        : observed.view.kind !== 'disk') ||
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
      new TextEncoder().encode(JSON.stringify(result)).length > limit
    )
      return fail('budget-exceeded', 'Coordinator response exceeds the requested page limits');
  } else if (new TextEncoder().encode(JSON.stringify(result)).length > limit) {
    return fail(
      result.status,
      'Operation returned ' + result.status + '; source metadata omitted because it exceeds the requested budget',
    );
  }
  if (contextQuery && result.status === 'ok') {
    if (result.next !== null || (!services.context && typeof request.view !== 'object'))
      return fail('unavailable', 'Complete document evidence and context composition are required');
    // A second, bounded compiler query identifies the actual reference target. Never use
    // the hover payload or lexical caret container as symbol identity.
    const definitionRequest = {
      worktree,
      project,
      uri,
      language,
      operation: 'definition' as const,
      ...(request.position ? {position: request.position} : {}),
      ...(request.environment ? {environment: request.environment} : {}),
      ...(typeof request.view === 'object' ? {view: request.view} : {}),
    };
    const definition =
      typeof request.view === 'object'
        ? {_tag: 'Failure' as const, failure: null}
        : yield* endpoint
            .request({
              operation: 'agent-query',
              request: {
                ...definitionRequest,
                profile: selected.digest,
                query: semanticAgentQueryKey(runtimeIdentity, selected.digest, definitionRequest),
                maxItems: 2,
                maxBytes: limit,
                milliseconds: yield* remaining,
              },
            })
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(SemanticAgentQueryResult)), Effect.result);
    let target: SemanticContextSymbolTarget | null = null;
    let definitionGap: SemanticContextDefinitionGap | undefined;
    if (definition._tag === 'Failure') {
      definitionGap =
        Schema.is(LspFault)(definition.failure) && definition.failure.code === 'timeout'
          ? 'semantic-symbol-definition-timeout'
          : 'semantic-symbol-definition-failed';
    } else {
      const value = definition.success;
      if (value.status !== 'ok') {
        definitionGap =
          value.status === 'unsupported'
            ? 'semantic-symbol-definition-unsupported'
            : value.status === 'timeout'
              ? 'semantic-symbol-definition-timeout'
              : value.status === 'stale'
                ? 'semantic-symbol-definition-stale'
                : 'semantic-symbol-definition-failed';
      } else if (
        value.offset !== 0 ||
        value.next !== null ||
        value.remaining !== 0 ||
        value.items.length > 2 ||
        new TextEncoder().encode(JSON.stringify(value)).length > limit
      ) {
        definitionGap = 'semantic-symbol-definition-incomplete';
      } else if (
        value.evidence.basis !== 'semantic' ||
        observationKey(value.evidence.observation) !== observationKey(result.evidence.observation)
      ) {
        definitionGap = 'semantic-symbol-definition-observation-mismatch';
      } else if (value.items.length === 0) {
        definitionGap = 'semantic-symbol-definition-unresolved';
      } else if (value.items.length > 1) {
        definitionGap = 'semantic-symbol-definition-ambiguous';
      } else {
        const item = value.items[0];
        // Navigation ranges are checked against independently re-read observed bytes in
        // the graph/source boundary, including providers that only schema-decode them.
        const range = Schema.Struct({
          start: Schema.Struct({line: Schema.Int, character: Schema.Int}),
          end: Schema.Struct({line: Schema.Int, character: Schema.Int}),
        });
        const link = Schema.Struct({targetUri: Schema.String, targetRange: range, targetSelectionRange: range});
        const location = Schema.Struct({uri: Schema.String, range});
        if (Schema.is(link)(item)) {
          if (item.targetUri === uri)
            target = {
              evidence: value.evidence,
              uri,
              range: item.targetRange,
              selectionRange: item.targetSelectionRange,
            };
          else definitionGap = 'semantic-symbol-definition-external-target';
        } else if (Schema.is(location)(item)) {
          if (item.uri === uri) target = {evidence: value.evidence, uri, range: item.range};
          else definitionGap = 'semantic-symbol-definition-external-target';
        } else definitionGap = 'semantic-symbol-definition-target-unsupported';
      }
    }
    const budgetTokens = Math.max(
      800,
      Math.min(
        1500,
        Math.floor(
          (limit - new TextEncoder().encode(JSON.stringify(result)).length - 768) /
            AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN,
        ),
      ),
    );
    let knowledge: SemanticContextKnowledgeV1 =
      typeof request.view === 'object'
        ? {
            scope: 'document',
            binding: null,
            brief: null,
            memorySelection: null,
            gaps: [
              'semantic-graph-source-unbound',
              ...(services.knowledgeAuthorized === false ? ['knowledge-not-authorized'] : []),
            ],
          }
        : yield* services.context!(
            config,
            {
              task: request.task!,
              scope: {kind: 'repository', callerCwd: worktreePath},
              codeRefs: [EffectArray.join(EffectString.split(path.sep)(path.relative(worktreePath, filePath)), '/')],
              mode: 'explain',
              budgetTokens,
            },
            result.evidence,
            target,
          ).pipe(
            Effect.orElseSucceed((): SemanticContextKnowledgeV1 => ({
              scope: 'document',
              binding: null,
              brief: null,
              gaps: ['knowledge-unavailable'],
            })),
          );
    if (typeof request.view !== 'object' && definitionGap && !knowledge.gaps.includes('knowledge-not-authorized')) {
      knowledge = {...knowledge, memorySelection: null, gaps: [...new Set([...knowledge.gaps, definitionGap])]};
    }
    const closing = yield* endpoint
      .request({
        operation: 'agent-observe',
        ...(typeof request.view === 'object' ? {handle: request.view.handle} : {}),
        observation: result.evidence.observation,
        milliseconds: yield* remaining,
      })
      .pipe(Effect.result);
    if (closing._tag === 'Failure')
      return Schema.is(LspFault)(closing.failure) && closing.failure.code === 'timeout'
        ? endpointFailure('timeout')
        : endpointFailure('provider');
    if (Schema.is(EndpointRefusal)(closing.success)) return endpointFailure(closing.success.reason);
    const verified = yield* Schema.decodeUnknownEffect(Observation)(closing.success).pipe(Effect.result);
    if (verified._tag === 'Failure') return endpointFailure('provider');
    if (observationKey(verified.success) !== observationKey(result.evidence.observation))
      return fail('stale', 'Semantic source or configuration changed during context composition');
    const facts = result.items;
    const page = () => ({
      ...result,
      items: [{kind: 'context', semantic: facts, knowledge}],
      offset: 0,
      remaining: 0,
      next: null,
    });
    if (new TextEncoder().encode(JSON.stringify(page())).length > limit)
      knowledge = compactSemanticContextKnowledge(knowledge);
    if (new TextEncoder().encode(JSON.stringify(page())).length > limit)
      knowledge = compactSemanticContextKnowledge(knowledge, {omitFollowUps: true});
    if (new TextEncoder().encode(JSON.stringify(page())).length > limit) {
      knowledge = {
        ...knowledge,
        brief: null,
        gaps: [...new Set([...knowledge.gaps, 'knowledge-output-budget-exhausted'])],
      };
    }
    result = yield* Schema.decodeUnknownEffect(SemanticAgentQueryResult)(page());
    if (new TextEncoder().encode(JSON.stringify(result)).length > limit)
      return fail('budget-exceeded', 'Mandatory context evidence exceeds the requested output budget');
  }
  const current = yield* readSemanticHostProfile(config, worktree);
  return current.digest === selected.digest
    ? result
    : fail('stale', 'Host configuration changed before query publication');
});

/** One normalized application flow, with narrow host ports for focused boundary tests. */
export const runSemanticAgentQueryWith = <ContextR = never>(
  services: SemanticAgentQueryHost<ContextR>,
  config: RuntimeConfig,
  input: unknown,
) =>
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
export const runSemanticAgentQuery = (config: RuntimeConfig, input: unknown, knowledgeAuthorized = true) =>
  runSemanticAgentQueryWith(
    knowledgeAuthorized
      ? semanticAgentQueryHost
      : {
          ...semanticAgentQueryHost,
          knowledgeAuthorized: false,
          context: () =>
            Effect.succeed<SemanticContextKnowledgeV1>({
              scope: 'document',
              binding: null,
              brief: null,
              gaps: ['knowledge-not-authorized'],
            }),
        },
    config,
    input,
  );

/** Volatile owned-view lifecycle shared by CLI and MCP. Source and capabilities stay in the authorized request channel. */
export const runSemanticAgentViewWith = <ContextR = never>(
  services: SemanticAgentQueryHost<ContextR>,
  config: RuntimeConfig,
  input: unknown,
) =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => new TextEncoder().encode(JSON.stringify(input)).length,
      catch: () => LspFault.make({code: 'protocol'}),
    }).pipe(
      Effect.flatMap(bytes =>
        bytes <= semanticAgentBufferLimits.maxRequestBytes
          ? Schema.decodeUnknownEffect(SemanticAgentViewRequest, {onExcessProperty: 'error'})(input).pipe(
              Effect.mapError(() => LspFault.make({code: 'protocol'})),
            )
          : Effect.fail(LspFault.make({code: 'capacity'})),
      ),
    );
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!path.isAbsolute(parsed.callerCwd))
      return fail('invalid-request', 'callerCwd must identify an absolute worktree root');
    const root = yield* fs.realPath(parsed.callerCwd);
    const worktree = canonicalFileUri((yield* path.toFileUrl(root)).href);
    const selected = yield* readSemanticHostProfile(config, worktree);
    const runtimeIdentity = yield* services.runtimeIdentity;
    let scope: {project?: string; uri?: string; language?: SemanticLanguage; environment?: string} = {};
    if (parsed.action === 'open') {
      if (!Schema.is(SemanticLanguage)(parsed.language))
        return fail('unsupported', 'No semantic provider is selected for this language');
      if (!selected.profile.catalog[semanticHostSelection[parsed.language].slot])
        return fail('unavailable', 'The selected provider is not configured');
      const project = path.resolve(root, parsed.project ?? '.');
      const file = EffectString.startsWith('file:')(parsed.file)
        ? yield* Effect.try({try: () => new URL(parsed.file), catch: () => LspFault.make({code: 'protocol'})}).pipe(
            Effect.flatMap(url => path.fromFileUrl(url)),
          )
        : path.resolve(project, parsed.file);
      if (
        !(project === root || EffectString.startsWith(root + path.sep)(project)) ||
        !EffectString.startsWith(project + path.sep)(file) ||
        EffectString.split(path.sep)(file).includes('.git') ||
        (yield* fs.realPath(project)) !== project ||
        (yield* fs.realPath(file)) !== file ||
        (yield* fs.stat(file)).type !== 'File'
      )
        return fail('invalid-request', 'Source must remain inside the canonical project');
      scope = {
        project: canonicalFileUri((yield* path.toFileUrl(project)).href),
        uri: canonicalFileUri((yield* path.toFileUrl(file)).href),
        language: parsed.language,
        ...(parsed.environment ? {environment: parsed.environment} : {}),
      };
    }
    const endpoint = yield* services.connect({
      enabled: true,
      dataHome: selected.home,
      worktree,
      runtimeIdentity,
      ...selected.profile.catalog,
    });
    const result = yield* endpoint.request({
      operation: 'agent-view',
      request: {
        worktree,
        profile: selected.digest,
        action: parsed.action,
        ...scope,
        ...('text' in parsed ? {text: parsed.text} : {}),
        ...('handle' in parsed ? {handle: parsed.handle} : {}),
        ...('expectedVersion' in parsed ? {expectedVersion: parsed.expectedVersion} : {}),
        milliseconds: parsed.milliseconds ?? 10000,
      },
    });
    if (Schema.is(EndpointRefusal)(result)) return endpointFailure(result.reason);
    const current = yield* readSemanticHostProfile(config, worktree);
    if (current.digest !== selected.digest) return fail('stale', 'Host configuration changed before view publication');
    const success = yield* Schema.decodeUnknownEffect(SemanticAgentViewSuccess)(result);
    if (success.action !== parsed.action)
      return fail('conflict', 'Coordinator returned a different view lifecycle result');
    if (
      'observation' in success &&
      (success.observation.worktree !== worktree ||
        success.observation.view.kind !== 'overlay' ||
        (parsed.action === 'open'
          ? success.observation.project !== scope.project ||
            success.observation.uri !== scope.uri ||
            success.observation.documentVersion !== 1
          : parsed.action === 'update' &&
            (success.observation.view.id !== parsed.handle.id ||
              success.observation.documentVersion !== parsed.expectedVersion + 1)))
    )
      return fail('conflict', 'Coordinator returned a different owned source view');
    if (success.action === 'open' && success.handle.id !== success.observation.view.id)
      return fail('conflict', 'Coordinator returned an incompatible view handle');
    return success;
  }).pipe(
    Effect.timeoutOption(Schema.is(SemanticAgentViewRequest)(input) ? (input.milliseconds ?? 10000) : 45000),
    Effect.map(result => (result._tag === 'Some' ? result.value : fail('timeout', 'Semantic view deadline expired'))),
    Effect.catch(error =>
      Effect.succeed(
        Schema.is(SemanticSessionFault)(error)
          ? endpointFailure(error.reason)
          : Schema.is(SemanticHostProfileFault)(error)
            ? endpointFailure('prerequisite')
            : Schema.is(LspFault)(error)
              ? error.code === 'protocol'
                ? fail('invalid-request', 'Provide a bounded owned-view lifecycle request')
                : endpointFailure(error.code)
              : fail('invalid-request', 'Provide a bounded owned-view lifecycle request'),
      ),
    ),
  );
export const runSemanticAgentView = (config: RuntimeConfig, input: unknown) =>
  runSemanticAgentViewWith(semanticAgentQueryHost, config, input);
