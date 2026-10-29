import {Array as EffectArray} from 'effect';
import {Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {WorkflowAutomationError} from './contracts.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

const invalid = (message: string) => WorkflowAutomationError.make({code: 'invalid-document', message});
const AUTHORING_CONTROL_CHARACTER = /[^\u0020-\u007e\u00a0-\u{10ffff}]/u;
const AUTHORING_TEXT_CONTROL_CHARACTER = /(?!\n)[^\u0020-\u007e\u00a0-\u{10ffff}]/u;
const boundedText = (maximum: number, nonblank = false, singleLine = false) =>
  Schema.String.check(
    Schema.makeFilter(value => {
      if (new TextEncoder().encode(value).byteLength > maximum) return `Text exceeds ${maximum} UTF-8 bytes.`;
      if (nonblank && Effect.pipe(value, EffectString.trim).length === 0) return 'Text must not be blank.';
      if (AUTHORING_TEXT_CONTROL_CHARACTER.test(value)) return 'Text contains a control character.';
      if (singleLine && /[\r\n]/u.test(value)) return 'Text must be a single line.';
      return undefined;
    }),
  );
const portableId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  Schema.makeFilter(value =>
    Effect.pipe(value, EffectString.includes('..')) ||
    value === 'constructor' ||
    value === 'prototype' ||
    value === '__proto__'
      ? 'Reserved identifiers are not allowed.'
      : undefined,
  ),
);
const featureId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u),
  Schema.makeFilter(value =>
    Effect.pipe(value, EffectString.includes('..'))
      ? 'Feature identifiers cannot contain traversal markers.'
      : undefined,
  ),
);
const relativePath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4096),
  Schema.makeFilter(value => {
    if (
      new TextEncoder().encode(value).byteLength > 4096 ||
      Effect.pipe(value, EffectString.startsWith('/')) ||
      Effect.pipe(value, EffectString.includes('\\')) ||
      Effect.pipe(value, EffectString.includes(':')) ||
      AUTHORING_CONTROL_CHARACTER.test(value) ||
      EffectArray.some(
        Effect.pipe(value, EffectString.split('/')),
        segment => segment.length === 0 || segment === '.' || segment === '..',
      )
    )
      return 'Paths must be canonical relative paths without traversal or platform-specific roots.';
    return undefined;
  }),
);
const revision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const memoryId = Schema.String.check(Schema.isPattern(/^tn_[A-Za-z0-9_-]{1,128}$/u));
const memoryUri = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4096),
  Schema.isPattern(/^threadnote:\/\/[^\s]+$/u),
);
const prose = boundedText(8192, true);
const shortText = boundedText(4096, true);
const proseList = (min: number, max: number) => Schema.Array(prose).check(Schema.isBetweenLength(min, max));
const idList = (min: number, max: number) => Schema.Array(portableId).check(Schema.isBetweenLength(min, max));
const revisionFile = Schema.Struct({path: relativePath, sha256: revision});
const source = Schema.Struct({
  head: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u)),
  files: Schema.Array(revisionFile).check(Schema.isBetweenLength(1, 128)),
});
const evidenceReference = Schema.Struct({uri: memoryUri, memoryId, revision});
const context = Schema.Struct({
  codeRefs: Schema.Array(relativePath).check(Schema.isMaxLength(8)),
  evidenceRefs: Schema.Array(evidenceReference).check(Schema.isMaxLength(16)),
  note: boundedText(4096),
});
const requirement = Schema.Struct({id: portableId, behavior: prose});
const scenario = Schema.Struct({
  id: portableId,
  requirementIds: idList(1, 128),
  given: prose,
  when: prose,
  then: prose,
});
const assumption = Schema.Struct({
  statement: prose,
  basis: prose,
  authority: Schema.Literals(['user', 'evidence', 'agent']),
});
const question = Schema.Struct({
  id: portableId,
  question: prose,
  impact: prose,
  disposition: Schema.Literals(['open', 'deferred-to-plan']),
});
const artifactSection = Schema.Struct({heading: boundedText(256, true, true), body: prose});
const specArtifact = Schema.Struct({
  id: portableId,
  kind: Schema.Literals(['domain', 'workflow', 'contract', 'capability']),
  title: boundedText(256, true, true),
  summary: prose,
  diagram: Schema.optionalKey(prose),
  sections: Schema.Array(artifactSection).check(Schema.isMaxLength(16)),
});
const review = Schema.Struct({required: Schema.Boolean, reason: prose});
const common = {
  format: Schema.Literal('threadnote-native-authoring'),
  schemaVersion: Schema.Literal(1),
  id: featureId,
  project: portableId,
  title: boundedText(256, true, true),
  objective: shortText,
  requirements: Schema.Array(requirement).check(Schema.isBetweenLength(1, 128)),
  context,
  source: Schema.NullOr(source),
  sourceFreeReason: Schema.optionalKey(shortText),
} as const;

const nativeSpecSchema = Schema.Struct({
  ...common,
  kind: Schema.Literal('spec'),
  actors: proseList(1, 32),
  inScope: proseList(1, 64),
  outOfScope: Schema.Array(prose).check(Schema.isMaxLength(64)),
  constraints: Schema.Array(prose).check(Schema.isMaxLength(64)),
  observations: Schema.Array(prose).check(Schema.isMaxLength(128)),
  scenarios: Schema.Array(scenario).check(Schema.isBetweenLength(1, 256)),
  assumptions: Schema.Array(assumption).check(Schema.isMaxLength(64)),
  questions: Schema.Array(question).check(Schema.isMaxLength(64)),
  artifacts: Schema.Array(specArtifact).check(Schema.isMaxLength(32)),
  review,
});

const architecture = Schema.Struct({
  summary: prose,
  components: proseList(1, 128),
  contracts: Schema.Array(prose).check(Schema.isMaxLength(128)),
  diagram: prose,
});
const acceptance = Schema.Struct({
  id: portableId,
  criterion: prose,
  verification: prose,
  requirementIds: idList(1, 128),
  scenarioIds: Schema.optionalKey(idList(0, 256)),
});
const phase = Schema.Struct({
  id: portableId,
  title: boundedText(256, true, true),
  outcome: prose,
  dependsOn: idList(0, 128),
  affectedPaths: Schema.Array(relativePath).check(Schema.isMaxLength(128)),
  newPaths: Schema.Array(relativePath).check(Schema.isMaxLength(128)),
  contracts: Schema.Array(prose).check(Schema.isMaxLength(128)),
  acceptance: Schema.Array(acceptance).check(Schema.isBetweenLength(1, 128)),
  safeBoundary: prose,
});
const alternative = Schema.Struct({id: portableId, design: prose, tradeoffs: prose});
const decision = Schema.Struct({
  id: portableId,
  question: prose,
  selection: Schema.Literals(['retain', 'adapt', 'no-better-alternative']),
  selected: prose,
  alternatives: Schema.Array(alternative).check(Schema.isMaxLength(2)),
  rationale: prose,
  affectedPhases: idList(0, 128),
  authority: Schema.Literal('orchestrator'),
});
const specBinding = Schema.Struct({
  bindingId: revision,
  runId: portableId,
  generation: shortText,
  profile: Schema.Literals(['desktop', 'codex-cloud-personal', 'cursor-cloud-personal']),
  team: Schema.optionalKey(portableId),
});
const linkedSpec = Schema.Struct({
  root: Schema.Struct({uri: memoryUri, memoryId, revision}),
  binding: specBinding,
  documentHash: revision,
  intentHash: revision,
  requirements: Schema.Array(requirement).check(Schema.isBetweenLength(1, 128)),
  scenarios: Schema.Array(scenario).check(Schema.isBetweenLength(1, 256)),
});
const nativePlanSchema = Schema.Struct({
  ...common,
  kind: Schema.Literal('plan'),
  current: architecture,
  target: architecture,
  phases: Schema.Array(phase).check(Schema.isBetweenLength(1, 128)),
  decisions: Schema.Array(decision).check(Schema.isMaxLength(64)),
  openQuestions: Schema.Array(prose).check(Schema.isMaxLength(64)),
  review,
  spec: Schema.optionalKey(linkedSpec),
});

export const NativeAuthoringSpecDocumentSchema = nativeSpecSchema;
export const NativeAuthoringPlanDocumentSchema = nativePlanSchema;
export const NativeAuthoringDocumentSchema = Schema.Union([nativeSpecSchema, nativePlanSchema]);
export type NativeAuthoringDocument = typeof NativeAuthoringDocumentSchema.Type;

export function decodeNativeAuthoringDocument(input: unknown): NativeAuthoringDocument {
  let document: NativeAuthoringDocument;
  try {
    document = Schema.decodeUnknownSync(NativeAuthoringDocumentSchema, {onExcessProperty: 'error'})(input);
  } catch {
    throw invalid('The native authoring document is malformed or contains unsupported fields.');
  }
  if (new TextEncoder().encode(canonicalAuthoringJson(document)).byteLength > 1_000_000)
    throw invalid('The native authoring document exceeds 1000000 canonical UTF-8 bytes.');
  return document;
}

export function canonicalAuthoringJson(value: unknown): string {
  const serialized = JSON.stringify(sortJson(value, new Set()));
  if (serialized === undefined) throw invalid('The native authoring value is not JSON serializable.');
  return serialized;
}

export function nativeAuthoringDigest(document: NativeAuthoringDocument): string {
  const decoded = decodeNativeAuthoringDocument(document);
  return sha256HexSync(`threadnote.native-authoring.document.v1\n${canonicalAuthoringJson(decoded)}`);
}

export function nativeSpecIntentDigest(document: NativeAuthoringDocument): string {
  const decoded = decodeNativeAuthoringDocument(document);
  if (decoded.kind === 'plan') return nativeAuthoringDigest(decoded);
  const intent = {
    kind: decoded.kind,
    schemaVersion: decoded.schemaVersion,
    format: decoded.format,
    id: decoded.id,
    project: decoded.project,
    title: decoded.title,
    objective: decoded.objective,
    requirements: decoded.requirements,
    actors: decoded.actors,
    inScope: decoded.inScope,
    outOfScope: decoded.outOfScope,
    constraints: decoded.constraints,
    scenarios: decoded.scenarios,
    assumptions: decoded.assumptions,
    questions: decoded.questions,
    artifacts: decoded.artifacts,
  };
  return sha256HexSync(`threadnote.native-authoring.spec-intent.v1\n${canonicalAuthoringJson(intent)}`);
}

export interface NativeAuthoringIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}
export interface NativeAuthoringValidationOptions {
  readonly ready?: boolean;
  readonly confirmation?: {readonly intentHash: string; readonly decision: 'approved'; readonly response: string};
  readonly review?: {
    readonly documentHash: string;
    readonly outcome: 'accepted' | 'changes-requested';
    readonly blockingIssueCount: number;
  };
}
export interface NativeAuthoringValidation {
  readonly documentHash: string;
  readonly intentHash: string;
  readonly ready: boolean;
  readonly issues: readonly NativeAuthoringIssue[];
}

export function validateNativeAuthoring(
  document: NativeAuthoringDocument,
  options: NativeAuthoringValidationOptions = {},
): NativeAuthoringValidation {
  const decoded = decodeNativeAuthoringDocument(document);
  const issues: NativeAuthoringIssue[] = [];
  const add = (code: string, path: string, message: string) => issues.push({code, path, message});
  const sourcePaths = new Set(
    EffectOption.getOrUndefined(
      EffectOption.map(EffectOption.fromNullishOr(decoded.source?.files), __effectArrayReceiver =>
        EffectArray.map(__effectArrayReceiver, file => file.path),
      ),
    ) ?? [],
  );
  if (
    !decoded.source &&
    !Effect.pipe(decoded.sourceFreeReason, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
    )
  )
    add('source-required', 'sourceFreeReason', 'A native document without a source snapshot needs a concrete reason.');
  EffectArray.forEach(decoded.context.codeRefs, (codeRef, index) => {
    if (!sourcePaths.has(codeRef))
      add(
        'code-ref-out-of-snapshot',
        `context.codeRefs[${index}]`,
        'Code references must name an inspected source path.',
      );
  });
  const sourceFilePaths =
    EffectOption.getOrUndefined(
      EffectOption.map(EffectOption.fromNullishOr(decoded.source?.files), __effectArrayReceiver =>
        EffectArray.map(__effectArrayReceiver, file => file.path),
      ),
    ) ?? [];
  EffectArray.forEach(duplicates(sourceFilePaths), path =>
    add('duplicate-source-path', 'source.files', `Source path ${path} appears more than once.`),
  );

  const requirementIds = new Set(EffectArray.map(decoded.requirements, item => item.id));
  reportDuplicates(
    EffectArray.map(decoded.requirements, item => item.id),
    'requirements',
    add,
  );
  if (decoded.kind === 'spec') {
    reportDuplicates(
      EffectArray.map(decoded.scenarios, item => item.id),
      'scenarios',
      add,
    );
    reportDuplicates(
      EffectArray.map(decoded.questions, item => item.id),
      'questions',
      add,
    );
    reportDuplicates(
      EffectArray.map(decoded.artifacts, item => item.id),
      'artifacts',
      add,
    );
    EffectArray.forEach(decoded.scenarios, (item, index) => {
      reportReferences(item.requirementIds, requirementIds, `scenarios[${index}].requirementIds`, add);
      if (new Set(item.requirementIds).size !== item.requirementIds.length)
        add(
          'duplicate-reference',
          `scenarios[${index}].requirementIds`,
          'Scenario requirement references must be unique.',
        );
    });
    const covered = new Set(EffectArray.flatMap(decoded.scenarios, item => item.requirementIds));
    EffectArray.forEach(decoded.requirements, (item, index) => {
      if (!covered.has(item.id))
        add('requirement-uncovered', `requirements[${index}]`, `Requirement ${item.id} is not covered by a scenario.`);
    });
    EffectArray.forEach(decoded.artifacts, (item, index) => {
      if (
        (item.kind === 'domain' || item.kind === 'workflow') &&
        !Effect.pipe(item.diagram, effectOptionalString =>
          effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
        )
      )
        add(
          'artifact-diagram-required',
          `artifacts[${index}].diagram`,
          'Domain and workflow artifacts need a diagram.',
        );
    });
  } else {
    reportDuplicates(
      EffectArray.map(decoded.phases, item => item.id),
      'phases',
      add,
    );
    reportDuplicates(
      EffectArray.map(decoded.decisions, item => item.id),
      'decisions',
      add,
    );
    const allAcceptanceIds = EffectArray.flatMap(decoded.phases, item =>
      EffectArray.map(item.acceptance, entry => entry.id),
    );
    reportDuplicates(allAcceptanceIds, 'phases.acceptance', add);
    const phaseIds = new Set(EffectArray.map(decoded.phases, item => item.id));
    const planRequirementIds = new Set(EffectArray.map(decoded.requirements, item => item.id));
    const coveredPlanRequirements = new Set<string>();
    EffectArray.forEach(decoded.phases, (item, index) => {
      reportReferences(item.dependsOn, phaseIds, `phases[${index}].dependsOn`, add);
      if (item.dependsOn.includes(item.id))
        add('phase-self-dependency', `phases[${index}].dependsOn`, 'A phase cannot depend on itself.');
      reportDuplicates(
        EffectArray.map(item.acceptance, entry => entry.id),
        `phases[${index}].acceptance`,
        add,
      );
      EffectArray.forEach(item.acceptance, (entry, acceptanceIndex) => {
        reportReferences(
          entry.requirementIds,
          planRequirementIds,
          `phases[${index}].acceptance[${acceptanceIndex}].requirementIds`,
          add,
        );
        EffectArray.forEach(entry.requirementIds, id => coveredPlanRequirements.add(id));
        if (new Set(entry.requirementIds).size !== entry.requirementIds.length)
          add(
            'duplicate-reference',
            `phases[${index}].acceptance[${acceptanceIndex}].requirementIds`,
            'Acceptance requirement references must be unique.',
          );
        if (entry.scenarioIds && new Set(entry.scenarioIds).size !== entry.scenarioIds.length)
          add(
            'duplicate-reference',
            `phases[${index}].acceptance[${acceptanceIndex}].scenarioIds`,
            'Acceptance scenario references must be unique.',
          );
      });
    });
    EffectArray.forEach(decoded.decisions, (item, index) =>
      reportDuplicates(
        EffectArray.map(item.alternatives, alternative => alternative.id),
        `decisions[${index}].alternatives`,
        add,
      ),
    );
    EffectArray.forEach(decoded.requirements, (item, index) => {
      if (!coveredPlanRequirements.has(item.id))
        add(
          'requirement-uncovered',
          `requirements[${index}]`,
          `Requirement ${item.id} is not covered by a phase acceptance.`,
        );
    });
    EffectArray.forEach(decoded.decisions, (item, index) =>
      reportReferences(item.affectedPhases, phaseIds, `decisions[${index}].affectedPhases`, add),
    );
    if (hasDependencyCycle(decoded.phases))
      add('phase-dependency-cycle', 'phases', 'Phase dependencies must form an acyclic graph.');

    if (decoded.spec) {
      const linkedRequirements = new Set(EffectArray.map(decoded.spec.requirements, item => item.id));
      const linkedScenarios = new Set(EffectArray.map(decoded.spec.scenarios, item => item.id));
      reportDuplicates(
        EffectArray.map(decoded.spec.requirements, item => item.id),
        'spec.requirements',
        add,
      );
      reportDuplicates(
        EffectArray.map(decoded.spec.scenarios, item => item.id),
        'spec.scenarios',
        add,
      );
      if (!sameRequirements(decoded.requirements, decoded.spec.requirements))
        add(
          'linked-spec-requirements-changed',
          'requirements',
          'The plan requirement IDs and behavior must exactly match its linked specification snapshot.',
        );
      EffectArray.forEach(decoded.spec.scenarios, (item, index) =>
        reportReferences(item.requirementIds, linkedRequirements, `spec.scenarios[${index}].requirementIds`, add),
      );
      const referencedRequirements = new Set<string>();
      const referencedScenarios = new Set<string>();
      EffectArray.forEach(decoded.phases, (item, phaseIndex) =>
        EffectArray.forEach(item.acceptance, (entry, acceptanceIndex) => {
          reportReferences(
            entry.requirementIds,
            linkedRequirements,
            `phases[${phaseIndex}].acceptance[${acceptanceIndex}].requirementIds`,
            add,
          );
          EffectArray.forEach(entry.requirementIds, id => referencedRequirements.add(id));
          EffectOption.getOrUndefined(
            EffectOption.map(EffectOption.fromNullishOr(entry.scenarioIds), __effectArrayReceiver =>
              EffectArray.forEach(__effectArrayReceiver, (id, scenarioIndex) => {
                if (!linkedScenarios.has(id))
                  add(
                    'unknown-scenario-reference',
                    `phases[${phaseIndex}].acceptance[${acceptanceIndex}].scenarioIds[${scenarioIndex}]`,
                    `Scenario ${id} is not present in the linked specification.`,
                  );
                referencedScenarios.add(id);
              }),
            ),
          );
        }),
      );
      EffectArray.forEach(decoded.spec.requirements, (item, index) => {
        if (!referencedRequirements.has(item.id))
          add(
            'requirement-uncovered',
            `spec.requirements[${index}]`,
            `Linked requirement ${item.id} is not covered by a phase.`,
          );
      });
      EffectArray.forEach(decoded.spec.scenarios, (item, index) => {
        if (!referencedScenarios.has(item.id))
          add(
            'scenario-uncovered',
            `spec.scenarios[${index}]`,
            `Linked scenario ${item.id} is not covered by a phase.`,
          );
      });
    } else {
      EffectArray.forEach(decoded.phases, (item, phaseIndex) =>
        EffectArray.forEach(item.acceptance, (entry, acceptanceIndex) => {
          EffectOption.getOrUndefined(
            EffectOption.map(EffectOption.fromNullishOr(entry.scenarioIds), __effectArrayReceiver =>
              EffectArray.forEach(__effectArrayReceiver, (id, scenarioIndex) =>
                add(
                  'unknown-scenario-reference',
                  `phases[${phaseIndex}].acceptance[${acceptanceIndex}].scenarioIds[${scenarioIndex}]`,
                  `Scenario ${id} cannot be referenced without a linked specification.`,
                ),
              ),
            ),
          );
        }),
      );
    }
  }

  const documentHash = nativeAuthoringDigest(decoded);
  const intentHash = nativeSpecIntentDigest(decoded);
  if (options.ready) {
    if (decoded.kind === 'spec') {
      EffectArray.forEach(decoded.questions, (item, index) => {
        if (item.disposition === 'open')
          add('open-question', `questions[${index}]`, 'Open behavioral questions must be resolved before readiness.');
      });
    } else {
      EffectArray.forEach(decoded.openQuestions, (_, index) =>
        add('open-question', `openQuestions[${index}]`, 'Open plan questions must be resolved before readiness.'),
      );
      if (decoded.decisions.length === 0)
        add(
          'decision-required',
          'decisions',
          'A ready plan needs an orchestrator decision, including a justified no-better-alternative when applicable.',
        );
      for (const [label, diagram] of [
        ['current.diagram', decoded.current.diagram],
        ['target.diagram', decoded.target.diagram],
      ] as const) {
        if (!validMermaid(diagram))
          add(
            'diagram-invalid',
            label,
            'Ready architecture diagrams need a supported raw Mermaid declaration without fences.',
          );
      }
    }
    if (
      decoded.kind === 'spec' &&
      (typeof options.confirmation?.response !== 'string' ||
        Effect.pipe(options.confirmation.response, EffectString.trim).length === 0 ||
        options.confirmation.decision !== 'approved' ||
        options.confirmation.intentHash !== intentHash)
    )
      add(
        'confirmation-required',
        'confirmation',
        'Readiness needs an explicit nonblank approval for the exact authoring intent.',
      );
    if (decoded.review.required) {
      if (
        options.review?.documentHash !== documentHash ||
        options.review.outcome !== 'accepted' ||
        options.review.blockingIssueCount !== 0
      )
        add(
          'review-required',
          'review',
          'Readiness needs an accepted review of this exact document with no blocking issues.',
        );
    }
  }
  return {documentHash, intentHash, ready: options.ready === true && issues.length === 0, issues};
}

function sortJson(value: unknown, ancestors: Set<object>): unknown {
  if (EffectArray.isArray(value)) {
    if (ancestors.has(value)) throw invalid('Canonical authoring JSON cannot contain cycles.');
    const next = new Set(ancestors).add(value);
    return EffectArray.map(value, item => sortJson(item, next));
  }
  if (value !== null && typeof value === 'object') {
    if (ancestors.has(value)) throw invalid('Canonical authoring JSON cannot contain cycles.');
    const next = new Set(ancestors).add(value);
    return EffectRecord.fromEntries(
      EffectArray.map(
        EffectArray.filter(EffectRecord.toEntries(value), ([, item]) => item !== undefined).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
        ([key, item]) => [key, sortJson(item, next)],
      ),
    );
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol')
    throw invalid('Canonical authoring JSON contains a non-JSON value.');
  return value;
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

function sameRequirements(
  left: readonly {readonly id: string; readonly behavior: string}[],
  right: readonly {readonly id: string; readonly behavior: string}[],
): boolean {
  if (left.length !== right.length) return false;
  const leftById = new Map(EffectArray.map(left, item => [item.id, item.behavior]));
  const rightById = new Map(EffectArray.map(right, item => [item.id, item.behavior]));
  return (
    leftById.size === rightById.size &&
    EffectArray.every([...leftById], ([id, behavior]) => rightById.get(id) === behavior)
  );
}

function reportDuplicates(
  values: readonly string[],
  path: string,
  add: (code: string, path: string, message: string) => void,
) {
  for (const id of duplicates(values)) add('duplicate-id', path, `Stable identifier ${id} is duplicated.`);
}

function reportReferences(
  values: readonly string[],
  known: ReadonlySet<string>,
  path: string,
  add: (code: string, path: string, message: string) => void,
) {
  EffectArray.forEach(values, (id, index) => {
    if (!known.has(id)) add('unknown-reference', `${path}[${index}]`, `Referenced identifier ${id} does not exist.`);
  });
}

function hasDependencyCycle(phases: readonly {readonly id: string; readonly dependsOn: readonly string[]}[]): boolean {
  const graph = new Map(EffectArray.map(phases, item => [item.id, item.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) {
      if (graph.has(dependency) && visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return EffectArray.some([...graph.keys()], visit);
}

function validMermaid(diagram: string): boolean {
  const firstLine =
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
    Effect.pipe(Effect.pipe(diagram, EffectString.trimStart).split(/\r?\n/u, 1)[0], effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
    ) ?? '';
  if (Effect.pipe(diagram, EffectString.trimStart, EffectString.startsWith('```'))) return false;
  return /^(?:graph|flowchart|sequenceDiagram|stateDiagram(?:-v2)?|classDiagram|erDiagram)(?:\s|$)/u.test(firstLine);
}
