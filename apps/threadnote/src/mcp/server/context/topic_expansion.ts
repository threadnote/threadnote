import {Array as EffectArray, Effect, Path, Result, Schema} from 'effect';
import {EffectMcpServerAdapter, McpInput} from '../../../effect/ai/mcp.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {argumentError} from '../common.js';
import {runTopicExpansionSurface, topicExpansionSurfaceFailure} from '../../../manager/topic_expansion.js';

class InvalidExpansionSelection extends Schema.TaggedError<
  InvalidExpansionSelection,
  {readonly brand: unique symbol}
>()('InvalidExpansionSelection', {}) {}

const topicExpansionActions = ['inspect', 'discover', 'preview', 'apply', 'restart'] as const;
type TopicExpansionAction = (typeof topicExpansionActions)[number];
type TopicExpansionToolInput = {
  readonly action?: string;
  readonly uri?: string;
  readonly project?: string;
  readonly callerCwd?: string;
  readonly inputJson?: string;
  readonly revision?: string;
  readonly approvalDigest?: string;
  readonly approved?: boolean;
};

function isTopicExpansionAction(action: string | undefined): action is TopicExpansionAction {
  return action !== undefined && EffectArray.some(topicExpansionActions, candidate => candidate === action);
}

/** The handler core is separately testable so invalid raw calls exercise its fail-closed branch. */
export function handleTopicDependencyExpansionTool(config: RuntimeConfig, input: TopicExpansionToolInput) {
  return Effect.gen(function* () {
    const action = input.action;
    if (
      !isTopicExpansionAction(action) ||
      typeof input.uri !== 'string' ||
      input.uri.length > 4096 ||
      typeof input.project !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.project) ||
      typeof input.callerCwd !== 'string' ||
      !(yield* Path.Path).isAbsolute(input.callerCwd)
    )
      return argumentError('Select an exact action, private code topic, project and local checkout.');
    if (
      (action === 'apply' || action === 'restart') &&
      (input.approved !== true ||
        !/^[a-f0-9]{64}$/u.test(input.revision ?? '') ||
        !/^[a-f0-9]{64}$/u.test(input.approvalDigest ?? ''))
    )
      return argumentError('Approve the exact selected additions, revision and full preview digest.');
    let selection: unknown;
    if (action !== 'inspect') {
      const inputJson = input.inputJson;
      if (typeof inputJson !== 'string' || new TextEncoder().encode(inputJson).byteLength > 32 * 1024)
        return argumentError('Supply a bounded explicit dependency selection.');
      const parsed = yield* Effect.try({
        try: (): unknown => JSON.parse(inputJson),
        catch: () => InvalidExpansionSelection.make({}),
      }).pipe(Effect.result);
      if (Result.isFailure(parsed)) return argumentError('Dependency selection must be valid JSON.');
      selection = parsed.success;
    }
    const result = yield* runTopicExpansionSurface(config, {
      action,
      uri: input.uri,
      project: input.project,
      callerCwd: input.callerCwd,
      selection,
      revision: input.revision,
      approvalDigest: input.approvalDigest,
      approved: input.approved,
    }).pipe(Effect.result);
    if (Result.isFailure(result)) {
      const failure = topicExpansionSurfaceFailure(result.failure);
      return {isError: true, content: [{type: 'text' as const, text: failure.error}], structuredContent: failure};
    }
    return {
      content: [{type: 'text' as const, text: JSON.stringify(result.success)}],
      structuredContent: result.success,
    };
  });
}

type TopicDependencyExpansionToolRegistrar = Pick<EffectMcpServerAdapter, 'registerTool'>;

export function registerTopicDependencyExpansionTools(
  server: TopicDependencyExpansionToolRegistrar,
  config: RuntimeConfig,
): void {
  server.registerTool(
    'context_topic_dependency_expansion',
    {
      annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: false},
      description:
        'Inspect enrolled private code scope, explicitly discover one-hop source choices, preview exact selected additions, approve that exact revision/digest, or explicitly restart an expired unwritten approval for separate fresh preview review. Never starts indexing or selects suggestions automatically.',
      inputSchema: {
        action: McpInput.literals(topicExpansionActions, 'Explicit dependency scope action'),
        uri: McpInput.string('Exact enrolled private durable code memory URI'),
        project: McpInput.string('Exact configured graph project'),
        callerCwd: McpInput.string('Absolute selected local checkout'),
        inputJson: McpInput.string(
          'Closed explicit selection JSON, excluding server-resolved root/project, within 32 KiB',
        ),
        revision: McpInput.string('Exact approved preview revision for apply or explicit restart'),
        approvalDigest: McpInput.string('Exact approved full-memory preview digest'),
        approved: McpInput.boolean(
          'Explicit apply approval, or approval to replace an expired intent and review a fresh preview separately',
        ),
      },
    },
    input => handleTopicDependencyExpansionTool(config, input),
  );
}
