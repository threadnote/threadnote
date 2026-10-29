import {Array as EffectArray} from 'effect';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

type GraphAgentRecord = Readonly<Record<string, unknown>>;

function isGraphAgentRecord(value: unknown): value is GraphAgentRecord {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}

export function graphAgentRecord(value: unknown): GraphAgentRecord | undefined {
  return isGraphAgentRecord(value) ? value : undefined;
}

export function graphAgentString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function graphAgentNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function graphAgentScope(value: GraphAgentRecord): GraphAgentRecord | undefined {
  const coverage = graphAgentRecord(value.projectCoverage);
  if (coverage !== undefined) {
    const kind = graphAgentString(coverage.kind);
    const completeness = graphAgentString(coverage.completeness);
    const negativeProof = graphAgentString(coverage.negativeProof);
    if (kind === 'project' || completeness !== 'complete' || negativeProof === 'unavailable') {
      const roots = EffectArray.isArray(coverage.configuredRoots)
        ? EffectArray.filter(coverage.configuredRoots, (root): root is string => typeof root === 'string').slice(0, 2)
        : [];
      const omittedRoots =
        (graphAgentNumber(coverage.configuredRootsOmitted) ?? 0) +
        (EffectArray.isArray(coverage.configuredRoots)
          ? Math.max(0, coverage.configuredRoots.length - roots.length)
          : 0);
      return {
        ...(graphAgentString(coverage.project) === undefined ? {} : {project: graphAgentString(coverage.project)}),
        ...(kind === undefined ? {} : {kind}),
        ...(completeness === undefined ? {} : {completeness}),
        ...(negativeProof === undefined ? {} : {negativeProof}),
        ...(roots.length === 0 ? {} : {configuredRoots: roots}),
        ...(omittedRoots > 0 ? {configuredRootsOmitted: omittedRoots} : {}),
      };
    }
  }
  const project = graphAgentString(value.project);
  return project === undefined ? undefined : {project};
}

/**
 * Render only provenance that changes how an agent may use graph evidence.
 * Stable transport/schema identities remain available through explicit dual
 * responses without charging every ordinary model-facing read for them.
 */
export function renderCodeGraphAgentProvenance(value: unknown): string {
  const record = graphAgentRecord(value);
  if (record === undefined) return '';
  const oneLine = (text: string) => {
    let output = '';
    let replacingControl = false;
    for (const character of text) {
      const codePoint =
        Effect.pipe(
          character,
          EffectString.codePointAt(0),
          Effect.Option.getOrElse(() => undefined),
        ) ?? 0;
      const control =
        codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) || codePoint === 0x2028 || codePoint === 0x2029;
      if (!control) output += character;
      else if (!replacingControl) output += ' ';
      replacingControl = control;
    }
    return Effect.pipe(output, EffectString.trim);
  };
  const evidence: Record<string, unknown> = {};
  const freshness = graphAgentString(record.freshness);
  if (freshness !== undefined && freshness !== 'current') evidence.freshness = freshness;
  const snapshot = graphAgentRecord(record.snapshot);
  if (snapshot?.dirty === true) evidence.dirty = true;
  if (EffectRecord.keys(evidence).length > 0) {
    const commit = graphAgentString(snapshot?.commit);
    if (commit !== undefined) evidence.commit = Effect.pipe(commit, EffectString.slice(0, 12));
  }
  const refresh = graphAgentRecord(record.refresh);
  const refreshState = graphAgentString(refresh?.state);
  if (refresh !== undefined && refreshState !== undefined && refreshState !== 'idle') {
    const failure = graphAgentRecord(refresh.failure);
    evidence.refresh = {
      state: refreshState,
      ...(graphAgentNumber(refresh.retryAfterMilliseconds) === undefined
        ? {}
        : {retryAfterMilliseconds: graphAgentNumber(refresh.retryAfterMilliseconds)}),
      ...(failure === undefined
        ? {}
        : {
            failure: {
              ...(graphAgentString(failure.code) === undefined ? {} : {code: graphAgentString(failure.code)}),
              ...(typeof failure.retryable === 'boolean' ? {retryable: failure.retryable} : {}),
              ...(graphAgentString(failure.recovery) === undefined
                ? {}
                : {recovery: graphAgentString(failure.recovery)}),
            },
          }),
    };
  }
  const lines: string[] = [];
  if (EffectRecord.keys(evidence).length > 0) {
    const parts = EffectArray.filter(
      [
        graphAgentString(evidence.freshness) === undefined
          ? undefined
          : `freshness ${oneLine(graphAgentString(evidence.freshness)!)}`,
        evidence.dirty === true ? 'dirty worktree' : undefined,
        graphAgentString(evidence.commit) === undefined
          ? undefined
          : `commit ${oneLine(graphAgentString(evidence.commit)!)}`,
        evidence.refresh === undefined
          ? undefined
          : `refresh ${Effect.pipe(JSON.stringify(evidence.refresh) ?? 'null', EffectString.replaceAll('\u2028', '\\u2028'), EffectString.replaceAll('\u2029', '\\u2029'))}`,
      ],
      (part): part is string => part !== undefined,
    );
    lines.push(`Evidence: ${EffectArray.join(parts, ', ')}.`);
  }
  const scope = graphAgentScope(record);
  if (scope !== undefined) {
    const roots = EffectArray.isArray(scope.configuredRoots)
      ? EffectArray.filter(scope.configuredRoots, (root): root is string => typeof root === 'string')
      : [];
    const parts = EffectArray.filter(
      [
        graphAgentString(scope.project) === undefined ? undefined : oneLine(graphAgentString(scope.project)!),
        graphAgentString(scope.kind) === undefined ? undefined : oneLine(graphAgentString(scope.kind)!),
        graphAgentString(scope.completeness) === undefined ? undefined : oneLine(graphAgentString(scope.completeness)!),
        graphAgentString(scope.negativeProof) === undefined
          ? undefined
          : `negative proof ${oneLine(graphAgentString(scope.negativeProof)!)}`,
        roots.length === 0 ? undefined : `roots ${EffectArray.join(EffectArray.map(roots, oneLine), ', ')}`,
        graphAgentNumber(scope.configuredRootsOmitted) === undefined
          ? undefined
          : `${graphAgentNumber(scope.configuredRootsOmitted)} root(s) omitted`,
      ],
      (part): part is string => part !== undefined,
    );
    lines.push(`Project scope: ${EffectArray.join(parts, ', ')}.`);
  }
  return lines.length === 0 ? '' : `${EffectArray.join(lines, '\n')}\n`;
}
