import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Schema} from 'effect';
import {WorkflowAutomationError} from './contracts.js';
import {
  checkNativeCycleScope,
  decodeNativeCycleState,
  nextNativeCycle,
  nativeCycleHasControl,
  type NativeCycleState,
} from './cycle.js';
import type {NativeCycleWaiver} from './cycle_runtime.js';
import {
  decodeNativeAuthoringDocument,
  isNativeMermaidDiagram,
  nativeAuthoringDigest,
  nativeSpecIntentDigest,
  type NativeAuthoringDocument,
} from './authoring.js';
import {createNativeDocument} from './templates.js';
import {nativeDocumentRenderLimitBytes, renderNativeDocument} from './documents.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const fail = (message: string): never => {
  throw WorkflowAutomationError.make({code: 'invalid-closeout', message});
};
const text = (maximum = 8192) =>
  Schema.String.check(
    Schema.makeFilter(value =>
      !Effect.pipe(value, EffectString.trim) ||
      nativeCycleHasControl(value, true) ||
      new TextEncoder().encode(value).byteLength > maximum
        ? 'Use bounded nonblank text without controls.'
        : undefined,
    ),
  );
const id = text(128).check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  Schema.makeFilter(value =>
    Effect.pipe(value, EffectString.includes('..')) || ['constructor', 'prototype', '__proto__'].includes(value)
      ? 'Reserved identifier.'
      : undefined,
  ),
);
const path = text(4096).check(
  Schema.makeFilter(value =>
    Effect.pipe(value, EffectString.startsWith('/')) ||
    Effect.pipe(value, EffectString.includes('\\')) ||
    Effect.pipe(value, EffectString.includes(':')) ||
    nativeCycleHasControl(value) ||
    EffectArray.some(
      Effect.pipe(value, EffectString.split('/')),
      segment => !segment || segment === '.' || segment === '..',
    )
      ? 'Use a canonical relative source path.'
      : undefined,
  ),
);
const texts = (minimum = 0, maximum = 128) => Schema.Array(text()).check(Schema.isBetweenLength(minimum, maximum));
const mermaid = text().check(
  Schema.makeFilter(value =>
    isNativeMermaidDiagram(value) ? undefined : 'Use a supported raw Mermaid declaration without fences.',
  ),
);
export const NativeCloseoutProposalSchema = Schema.Struct({
  architecture: Schema.Struct({
    summary: text(),
    components: texts(1),
    contracts: texts(),
    diagram: Schema.optionalKey(mermaid),
    invariants: texts(),
    unknowns: texts(),
    deviations: texts(),
    codeRefs: Schema.Array(path).check(Schema.isBetweenLength(1, 8)),
  }),
  architectureVerification: text(),
  combinedChecks: Schema.Array(
    Schema.Struct({command: text(4096), result: Schema.Literal('passed'), evidence: text()}),
  ).check(Schema.isBetweenLength(1, 64)),
  phaseEvidence: Schema.Array(
    Schema.Struct({
      id,
      acceptance: Schema.Array(Schema.Struct({criterion: text(), evidence: text()})).check(
        Schema.isBetweenLength(1, 128),
      ),
    }),
  ).check(Schema.isBetweenLength(1, 128)),
  scenarios: Schema.Array(Schema.Struct({id, evidence: text()})).check(Schema.isMaxLength(256)),
  behaviorVerification: Schema.optionalKey(text()),
  watchWork: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        eventId: text(384),
        status: Schema.Literals(['open', 'blocked']),
        reason: text(1024),
        evidence: text(2048),
        event: Schema.Struct({
          sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
          id: text(384),
          source: Schema.Literals(['comments', 'reviews', 'threads', 'checks', 'statuses', 'watch']),
          kind: text(64),
          key: text(256),
          version: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
          url: Schema.optionalKey(text(2048)),
          head: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u))),
          at: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          removed: Schema.Boolean,
          ready: Schema.optionalKey(Schema.Literal(false)),
        }),
        at: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      }),
    ).check(Schema.isMaxLength(128)),
  ),
  decisions: Schema.Array(Schema.Struct({id, implemented: text(), rationale: text()})).check(Schema.isMaxLength(64)),
});
export type NativeCloseoutProposal = typeof NativeCloseoutProposalSchema.Type;
export function decodeNativeCloseoutProposal(value: unknown): NativeCloseoutProposal {
  try {
    const decoded = Schema.decodeUnknownSync(NativeCloseoutProposalSchema, {onExcessProperty: 'error'})(value);
    if (new TextEncoder().encode(JSON.stringify(decoded)).byteLength > 2_000_000)
      return fail('Closeout proposal exceeds its bounded JSON budget.');
    return decoded;
  } catch {
    return fail('Malformed closeout proposal.');
  }
}
function exactMembership(actual: readonly string[], expected: readonly string[], label: string): void {
  if (
    new Set(actual).size !== actual.length ||
    new Set(expected).size !== expected.length ||
    actual.length !== expected.length ||
    EffectArray.some(expected, value => !actual.includes(value))
  )
    fail('Closeout ' + label + ' must match exactly, without duplicates or missing evidence.');
}
function freeze<A>(value: A): A {
  if (value !== null && typeof value === 'object') {
    for (const child of EffectRecord.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const json = (value: unknown) => JSON.stringify(value, null, 2);
const lines = (values: readonly string[]) =>
  values.length
    ? EffectArray.join(
        EffectArray.map(values, value => '- ' + value),
        '\n',
      )
    : 'None recorded.';

/**
 * Each phase's paths as its validated snapshot changed them; the runtime derives it, never the proposal. A bounded
 * row from an earlier admission is valid input too: it lists drift first and counts unlisted paths in `more`.
 */
export interface NativeCloseoutPhaseChanges {
  readonly phaseId: string;
  readonly drift?: readonly string[];
  readonly paths: readonly string[];
  readonly more?: number;
}
const actualChangesBudgetBytes = 8192;
const actualChangesHeading = '\n\nActual changes\n';
const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;
/**
 * Rows whose two-space JSON fits `limitBytes` and the fixed budget, with drift (outside allowedPaths) first. A path
 * that does not fit is counted in `more`, never dropped silently. Bounded rows bound to the same rows again, so a
 * stored admission renders the same document.
 */
const actualChangeRows = (
  state: NativeCycleState,
  changes: readonly NativeCloseoutPhaseChanges[],
  limitBytes: number,
) => {
  const byPhase = new Map(EffectArray.map(changes, change => [change.phaseId, change] as const));
  if (byPhase.size !== changes.length || EffectArray.some(changes, change => !state.phases[change.phaseId]))
    fail('Actual changes must name each cycle phase at most once.');
  const phases = EffectArray.map(state.plan.phases, phase => {
    const change = byPhase.get(phase.id);
    const paths = [...new Set([...(change?.drift ?? []), ...(change?.paths ?? [])])].sort();
    return {phase, paths, more: change?.more ?? 0};
  });
  // Empty rows with their largest possible `more` are the fixed cost; each listed path adds its exact JSON bytes.
  let budget =
    Math.min(actualChangesBudgetBytes, limitBytes) -
    utf8Bytes(
      json(
        EffectArray.map(phases, ({phase, paths, more}) => ({
          phaseId: phase.id,
          drift: [],
          paths: [],
          more: more + paths.length,
        })),
      ),
    );
  return EffectArray.map(phases, ({phase, paths, more}) => {
    const row = {phaseId: phase.id, drift: [] as string[], paths: [] as string[], more};
    const drift: string[] = [];
    const inScope: string[] = [];
    for (const path of paths) (checkNativeCycleScope(phase, [path]) ? inScope : drift).push(path);
    for (const [listed, candidates] of [
      [row.drift, drift],
      [row.paths, inScope],
    ] as const)
      for (const path of candidates) {
        // At indent 6: the quoted path, its indent and separator; the first item also opens the empty brackets.
        const bytes = utf8Bytes(JSON.stringify(path)) + 8 + (listed.length ? 0 : 4);
        if (bytes > budget) row.more++;
        else {
          budget -= bytes;
          listed.push(path);
        }
      }
    return row;
  });
};

/** Pure admission only: the application must independently verify roots, Git and publication authority. */
export function prepareNativeCloseout(
  input: NativeCycleState,
  planDocument: NativeAuthoringDocument,
  rawProposal: unknown,
  specDocument?: NativeAuthoringDocument,
  waivers: readonly NativeCycleWaiver[] = [],
  actualChanges?: readonly NativeCloseoutPhaseChanges[],
) {
  const state = decodeNativeCycleState(input);
  if (nextNativeCycle(state).action !== 'complete')
    return fail('Every cycle phase must reach its delivery completion gate before closeout.');
  const plan = decodeNativeAuthoringDocument(planDocument);
  if (
    plan.kind !== 'plan' ||
    plan.id !== state.plan.featureId ||
    plan.project !== state.plan.project ||
    nativeAuthoringDigest(plan) !== state.plan.source.documentHash
  )
    return fail('Closeout requires the exact pinned plan document.');
  const proposal = decodeNativeCloseoutProposal(rawProposal);
  exactMembership(proposal.architecture.codeRefs, [...new Set(proposal.architecture.codeRefs)], 'source references');
  exactMembership(
    EffectArray.map(plan.phases, phase => phase.id),
    EffectArray.map(state.plan.phases, phase => phase.id),
    'plan phases',
  );
  exactMembership(
    EffectArray.map(proposal.phaseEvidence, phase => phase.id),
    EffectArray.map(state.plan.phases, phase => phase.id),
    'phase evidence',
  );
  const phaseEvidence = EffectArray.map(state.plan.phases, phase => {
    const planned = EffectOption.getOrUndefined(EffectArray.findFirst(plan.phases, item => item.id === phase.id));
    const evidence = EffectOption.getOrUndefined(
      EffectArray.findFirst(proposal.phaseEvidence, item => item.id === phase.id),
    );
    if (!planned || !evidence) return fail('Missing closeout phase.');
    exactMembership(
      EffectArray.map(planned.acceptance, item => item.criterion),
      phase.acceptanceCriteria,
      'pinned acceptance criteria',
    );
    exactMembership(
      EffectArray.map(evidence.acceptance, item => item.criterion),
      phase.acceptanceCriteria,
      'acceptance evidence',
    );
    return {
      ...evidence,
      acceptance: EffectArray.map(phase.acceptanceCriteria, criterion => {
        const item = EffectOption.getOrUndefined(
          EffectArray.findFirst(evidence.acceptance, candidate => candidate.criterion === criterion),
        );
        if (!item) return fail('Missing criterion evidence.');
        return item;
      }),
    };
  });
  exactMembership(
    EffectArray.map(proposal.decisions, item => item.id),
    EffectArray.map(plan.decisions, item => item.id),
    'decisions',
  );
  const decisions = EffectArray.map(plan.decisions, planned => {
    const actual = EffectOption.getOrUndefined(
      EffectArray.findFirst(proposal.decisions, item => item.id === planned.id),
    );
    if (!actual) return fail('Missing implemented decision.');
    return {planned, implemented: actual.implemented, rationale: actual.rationale};
  });
  const spec = specDocument === undefined ? undefined : decodeNativeAuthoringDocument(specDocument);
  if (spec && (spec.kind !== 'spec' || spec.id !== plan.id || spec.project !== plan.project))
    return fail('Behavior evidence requires the matching spec document.');
  if (
    spec &&
    plan.spec &&
    (nativeAuthoringDigest(spec) !== plan.spec.documentHash ||
      nativeSpecIntentDigest(spec) !== plan.spec.intentHash ||
      json(spec.requirements) !== json(plan.spec.requirements) ||
      json(spec.scenarios) !== json(plan.spec.scenarios))
  )
    return fail('Behavior spec differs from the pinned approved spec.');
  if (spec && !proposal.behaviorVerification) return fail('Behavior verification is required with a spec.');
  exactMembership(
    EffectArray.map(proposal.scenarios, item => item.id),
    spec?.kind === 'spec' ? EffectArray.map(spec.scenarios, item => item.id) : [],
    'spec scenarios',
  );
  if (!spec && proposal.behaviorVerification !== undefined)
    return fail('Behavior verification needs its spec document.');
  const scenarios =
    spec?.kind === 'spec'
      ? EffectArray.map(spec.scenarios, scenario => {
          const evidence = EffectOption.getOrUndefined(
            EffectArray.findFirst(proposal.scenarios, item => item.id === scenario.id),
          );
          if (!evidence) return fail('Missing scenario evidence.');
          return {scenario, evidence: evidence.evidence};
        })
      : [];
  const titleFor = (suffix: string) =>
    Effect.pipe(plan.title, EffectString.slice(0, 256 - suffix.length), EffectString.replace(/[\uD800-\uDBFF]$/u, '')) +
    suffix;
  const architectureDocument = (dataFlowSuffix: string) =>
    createNativeDocument({
      kind: 'architecture-current',
      title: titleFor(' — Implemented architecture'),
      sections: {
        summary: proposal.architecture.summary,
        components: lines(proposal.architecture.components),
        contracts: lines(proposal.architecture.contracts),
        constraints:
          'Invariants\n' +
          lines(proposal.architecture.invariants) +
          '\n\nUnknowns\n' +
          lines(proposal.architecture.unknowns) +
          '\n\nDeviations\n' +
          lines(proposal.architecture.deviations) +
          '\n\nRetained unresolved PR watch work\n' +
          json(proposal.watchWork ?? []),
        ...(proposal.architecture.diagram === undefined ? {} : {diagram: proposal.architecture.diagram}),
        'data-flow': 'Source references\n' + lines(proposal.architecture.codeRefs) + dataFlowSuffix,
      },
    });
  // The rows replace the `[]` placeholder, so they may use the room it leaves plus its own 2 bytes.
  const changeRows =
    actualChanges === undefined
      ? undefined
      : actualChangeRows(
          state,
          actualChanges,
          nativeDocumentRenderLimitBytes +
            2 -
            utf8Bytes(renderNativeDocument(architectureDocument(actualChangesHeading + '[]'))),
        );
  const architecture = architectureDocument(changeRows ? actualChangesHeading + json(changeRows) : '');
  // Separate documents preserve complete original decisions; any individual overflow rejects before mutation.
  const decisionDocuments = EffectArray.map(decisions, item =>
    createNativeDocument({
      kind: 'decisions',
      title: titleFor(' — Decision ' + item.planned.id),
      sections: {
        decision:
          'Question: ' +
          item.planned.question +
          '\n\nOriginal selection: ' +
          item.planned.selection +
          '\n\nOriginally selected design: ' +
          item.planned.selected +
          '\n\nActual implemented choice: ' +
          item.implemented,
        alternatives: json(item.planned.alternatives),
        rationale:
          'Full original rationale\n' +
          item.planned.rationale +
          '\n\nActual choice / deviation explanation\n' +
          item.rationale,
        consequences:
          'Affected phases\n' +
          lines(item.planned.affectedPhases) +
          '\n\nOriginal decision authority: ' +
          item.planned.authority,
      },
    }),
  );
  const behavior =
    spec?.kind === 'spec'
      ? createNativeDocument({
          kind: 'spec',
          title: titleFor(' — Verified behavior'),
          sections: {
            summary: proposal.behaviorVerification ?? '',
            problem: spec.objective,
            requirements: json(spec.requirements),
            acceptance: json(scenarios),
          },
        })
      : undefined;
  const handoff = createNativeDocument({
    kind: 'handoff',
    title: titleFor(' — Closeout handoff'),
    sections: {
      task:
        'Feature: ' +
        plan.title +
        '\n\n' +
        plan.objective +
        '\n\nPlan document hash: ' +
        state.plan.source.documentHash,
      verification:
        'Architecture verification\n' +
        proposal.architectureVerification +
        '\n\nCombined checks\n' +
        json(proposal.combinedChecks) +
        '\n\nPhase acceptance evidence\n' +
        json(phaseEvidence) +
        (waivers.length
          ? '\n\nAudited waivers\n' +
            json(
              EffectArray.map(waivers, ({id, gate, phaseId, tree, reason, userAuthority}) => ({
                gate,
                phaseId,
                tree,
                reason,
                userAuthority,
                coversDeliveredTree: state.phases[phaseId]?.validation?.waiverId === id,
              })),
            )
          : ''),
      blockers:
        'Unknowns\n' +
        lines(proposal.architecture.unknowns) +
        '\n\nDeviations\n' +
        lines(proposal.architecture.deviations) +
        '\n\nRetained unresolved PR watch work\n' +
        json(proposal.watchWork ?? []),
      'next-step':
        'Application must verify current source and ready roots, then publish the admitted documents and retire only owned working artifacts.',
    },
  });
  return freeze(
    structuredClone({
      format: 'threadnote-native-closeout-admission' as const,
      version: 1 as const,
      featureId: plan.id,
      project: plan.project,
      planDocumentHash: state.plan.source.documentHash,
      ...(spec ? {specDocumentHash: nativeAuthoringDigest(spec)} : {}),
      architecture: proposal.architecture,
      architectureVerification: proposal.architectureVerification,
      combinedChecks: proposal.combinedChecks,
      phaseEvidence,
      decisions,
      scenarios,
      ...(proposal.behaviorVerification === undefined ? {} : {behaviorVerification: proposal.behaviorVerification}),
      watchWork: proposal.watchWork ?? [],
      ...(changeRows ? {actualChanges: changeRows} : {}),
      documents: {architecture, decisions: decisionDocuments, handoff, ...(behavior ? {behavior} : {})},
    }),
  );
}
export type NativeCloseoutAdmission = ReturnType<typeof prepareNativeCloseout>;
