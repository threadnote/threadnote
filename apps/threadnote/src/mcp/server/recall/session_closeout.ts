import {Array as EffectArray} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {applyScrubber} from '../../../share/index.js';
import {errorMessage} from '@threadnote/platform/errors';
import {type SessionCloseoutInput, structuredCloseoutFromInput} from '@threadnote/memory/candidate';
import {McpServerOperationError} from '../common.js';

export function sessionCloseoutHasCandidateMaterial(input: SessionCloseoutInput): boolean {
  return (
    EffectArray.some(
      [input.decisions, input.handoff, input.invariants, input.preferences],
      items => (items?.length ?? 0) > 0,
    ) || structuredCloseoutFromInput(input) !== undefined
  );
}

export function sessionCloseoutHasEvidence(input: SessionCloseoutInput): boolean {
  return (
    (input.codeCitations?.length ?? 0) > 0 ||
    (input.evidence?.length ?? 0) > 0 ||
    input.sourceSessionId !== undefined ||
    input.sourceCommit !== undefined
  );
}

export function parseCandidatePolicy(value: string | undefined): 'handoff-only' | 'off' | 'suggest' {
  const normalized =
    Effect2.pipe(value, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ) || 'suggest';
  if (normalized === 'suggest' || normalized === 'handoff-only' || normalized === 'off') {
    return normalized;
  }
  throw McpServerOperationError.make({
    message: `Invalid THREADNOTE_CANDIDATE_POLICY=${normalized}. Expected suggest, handoff-only, or off.`,
  });
}

export function scrubSessionCloseout(
  input: SessionCloseoutInput,
): {readonly input: SessionCloseoutInput; readonly ok: true} | {readonly error: string; readonly ok: false} {
  const scrubText = (value: string): {readonly blocker?: string; readonly cleaned: string} =>
    applyScrubber(value, {redact: true});
  const scalarValues = [
    ['task', input.task],
    ['outcome', input.outcome],
    ['project', input.project],
    ['topic', input.topic],
    ['sourceAgentClient', input.sourceAgentClient],
    ['sourceCommit', input.sourceCommit],
    ['sourceSessionId', input.sourceSessionId],
    ['rationale', input.rationale],
  ] as const;
  const scrubbedScalars = new Map<string, string | undefined>();
  for (const [key, value] of scalarValues) {
    if (value === undefined) {
      scrubbedScalars.set(key, undefined);
      continue;
    }
    const scrubbed = scrubText(value);
    if (scrubbed.blocker) {
      return {error: `Refusing session review: ${key} may contain ${scrubbed.blocker}.`, ok: false};
    }
    scrubbedScalars.set(key, scrubbed.cleaned);
  }
  const scrubList = (key: string, values: readonly string[] | undefined): readonly string[] | undefined => {
    if (!values) {
      return undefined;
    }
    const result: string[] = [];
    for (const value of values) {
      const scrubbed = scrubText(value);
      if (scrubbed.blocker) {
        throw McpServerOperationError.make({message: `${key} may contain ${scrubbed.blocker}`});
      }
      result.push(scrubbed.cleaned);
    }
    return result;
  };
  try {
    const outcome = scrubbedScalars.get('outcome');
    const project = scrubbedScalars.get('project');
    const sourceAgentClient = scrubbedScalars.get('sourceAgentClient');
    const rationale = scrubbedScalars.get('rationale');
    const task = scrubbedScalars.get('task');
    const topic = scrubbedScalars.get('topic');
    if (!outcome || !project || !sourceAgentClient || !task || !topic) {
      return {error: 'Refusing session review: a required scalar was unexpectedly absent after scrubbing.', ok: false};
    }
    return {
      input: {
        codeCitations: input.codeCitations,
        ...(rationale === undefined ? {} : {rationale}),
        constraints: scrubList('constraints', input.constraints),
        decisions: scrubList('decisions', input.decisions),
        evidence: scrubList('evidence', input.evidence),
        handoff: scrubList('handoff', input.handoff),
        invariants: scrubList('invariants', input.invariants),
        knowledgeInvalidated: scrubList('knowledgeInvalidated', input.knowledgeInvalidated),
        outcome,
        preferences: scrubList('preferences', input.preferences),
        project,
        sourceAgentClient,
        sourceCommit: scrubbedScalars.get('sourceCommit'),
        sourceSessionId: scrubbedScalars.get('sourceSessionId'),
        task,
        topic,
        unresolvedRisks: scrubList('unresolvedRisks', input.unresolvedRisks),
        verificationPerformed: scrubList('verificationPerformed', input.verificationPerformed),
      },
      ok: true,
    };
  } catch (cause: unknown) {
    return {error: `Refusing session review: ${errorMessage(cause)}.`, ok: false};
  }
}
