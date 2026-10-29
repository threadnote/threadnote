import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Schema} from 'effect';
import {WorkflowAutomationError} from './contracts.js';
import {decodeNativeCycleState, nextNativeCycle, nativeCycleHasControl, type NativeCycleState} from './cycle.js';
import {
  decodeNativeAuthoringDocument,
  nativeAuthoringDigest,
  nativeSpecIntentDigest,
  type NativeAuthoringDocument,
} from './authoring.js';
import {createNativeDocument} from './templates.js';
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
    /^(?:graph|flowchart|sequenceDiagram|stateDiagram(?:-v2)?|classDiagram|erDiagram)(?:\s|$)/u.test(
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
      Effect.pipe(value, EffectString.trimStart).split(/\r?\n/u, 1)[0] ?? '',
    )
      ? undefined
      : 'Use a supported raw Mermaid declaration without fences.',
  ),
);
export const NativeCloseoutProposalSchema = Schema.Struct({
  architecture: Schema.Struct({
    summary: text(),
    components: texts(1),
    contracts: texts(),
    diagram: mermaid,
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

/** Pure admission only: the application must independently verify roots, Git and publication authority. */
export function prepareNativeCloseout(
  input: NativeCycleState,
  planDocument: NativeAuthoringDocument,
  rawProposal: unknown,
  specDocument?: NativeAuthoringDocument,
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
  const architecture = createNativeDocument({
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
        lines(proposal.architecture.deviations),
      diagram: proposal.architecture.diagram,
      'data-flow': 'Source references\n' + lines(proposal.architecture.codeRefs),
    },
  });
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
        json(phaseEvidence),
      blockers:
        'Unknowns\n' +
        lines(proposal.architecture.unknowns) +
        '\n\nDeviations\n' +
        lines(proposal.architecture.deviations),
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
      documents: {architecture, decisions: decisionDocuments, handoff, ...(behavior ? {behavior} : {})},
    }),
  );
}
export type NativeCloseoutAdmission = ReturnType<typeof prepareNativeCloseout>;
