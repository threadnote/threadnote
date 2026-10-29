import {Array as EffectArray} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {MEMORY_RELATION_TYPES, type MemoryRelation, type MemoryRelationType} from '@threadnote/memory/document';
import {parseResourceId} from '@threadnote/store/resource-id';
import {Predicate} from 'effect';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const MEMORY_CONNECTIONS_BENCH_VERSION = 1 as const;
export const MEMORY_CONNECTIONS_BENCH_ID = 'memory-connections-bench-v1' as const;
export const MEMORY_CONNECTIONS_BENCH_SCOPE = 'authoring-projection' as const;
/** Changing reviewed truth requires an explicit source-reviewed hash update. */
export const MEMORY_CONNECTIONS_BENCH_APPROVED_FIXTURE_HASH =
  'a76e78c68273b6c347d3ae780e7b74aa1b83cd4fd1eed4fe731f3ff1b40613ce' as const;

export const MEMORY_CONNECTIONS_BENCH_ABILITIES = [
  'static-contract',
  'dynamic-state',
  'workflow-knowledge',
  'environment-gotcha',
  'premise-awareness',
] as const;

export const MEMORY_CONNECTIONS_AUTHORING_SCENARIOS = [
  'normalize-canonical',
  'normalize-alias',
  'reject-duplicate',
  'reject-self',
  'reject-inactive',
  'reject-out-of-scope',
] as const;

export const MEMORY_CONNECTIONS_PROJECTION_OPERATIONS = [
  'refresh',
  'target-add',
  'target-id-change',
  'target-delete',
  'target-move',
  'source-replace',
  'source-delete',
  'clean-rebuild',
] as const;

export type MemoryConnectionsBenchAbility = (typeof MEMORY_CONNECTIONS_BENCH_ABILITIES)[number];
export type MemoryConnectionsAuthoringScenario = (typeof MEMORY_CONNECTIONS_AUTHORING_SCENARIOS)[number];
export type MemoryConnectionsProjectionOperationKind = (typeof MEMORY_CONNECTIONS_PROJECTION_OPERATIONS)[number];

export interface MemoryConnectionsBenchDocumentV1 {
  readonly memoryId: string;
  readonly relations: readonly MemoryRelation[];
  readonly status: 'active' | 'archived';
  readonly topic: string;
  readonly user: string;
}

export interface MemoryConnectionsAuthoringCaseV1 {
  readonly ability: MemoryConnectionsBenchAbility;
  readonly allowedScopes: readonly string[];
  readonly expected:
    | {readonly kind: 'success'; readonly relations: readonly MemoryRelation[]}
    | {readonly kind: 'failure'; readonly messageIncludes: string};
  readonly id: string;
  readonly relations: readonly MemoryRelation[];
  readonly scenario: MemoryConnectionsAuthoringScenario;
  readonly sourceMemoryId: string | null;
}

export interface MemoryConnectionsExpectedProjectionRowV1 {
  readonly relationOrdinal: number;
  readonly relationOrigin: 'relation';
  readonly relationType: MemoryRelationType;
  readonly sourceMemoryId: string;
  /** Null is the reviewed unresolved legacy-target state. */
  readonly targetMemoryId: string | null;
  /** Stable identity alias or legacy canonical URI authored in the source. */
  readonly targetRef: string;
}

export type MemoryConnectionsProjectionOperationV1 =
  | {
      readonly expectedRows: readonly MemoryConnectionsExpectedProjectionRowV1[];
      readonly kind: 'refresh' | 'clean-rebuild';
    }
  | {
      readonly document: MemoryConnectionsBenchDocumentV1;
      readonly expectedRows: readonly MemoryConnectionsExpectedProjectionRowV1[];
      readonly kind: 'target-add' | 'target-id-change' | 'source-replace';
    }
  | {
      readonly expectedRows: readonly MemoryConnectionsExpectedProjectionRowV1[];
      readonly kind: 'target-delete' | 'source-delete';
      readonly topic: string;
      readonly user: string;
    }
  | {
      readonly expectedRows: readonly MemoryConnectionsExpectedProjectionRowV1[];
      readonly fromTopic: string;
      readonly kind: 'target-move';
      readonly toTopic: string;
      readonly user: string;
    };

export interface MemoryConnectionsProjectionTraceV1 {
  readonly ability: MemoryConnectionsBenchAbility;
  readonly id: string;
  readonly initialDocuments: readonly MemoryConnectionsBenchDocumentV1[];
  readonly operations: readonly MemoryConnectionsProjectionOperationV1[];
  readonly user: string;
}

export interface MemoryConnectionsBenchFixtureV1 {
  readonly abilities: readonly MemoryConnectionsBenchAbility[];
  readonly authoring: {
    readonly cases: readonly MemoryConnectionsAuthoringCaseV1[];
    readonly documents: readonly MemoryConnectionsBenchDocumentV1[];
  };
  readonly id: typeof MEMORY_CONNECTIONS_BENCH_ID;
  readonly productScope: typeof MEMORY_CONNECTIONS_BENCH_SCOPE;
  readonly projectionTraces: readonly MemoryConnectionsProjectionTraceV1[];
  readonly version: typeof MEMORY_CONNECTIONS_BENCH_VERSION;
}

/** Parse reviewed A+B truth and reject field, scenario, or coverage drift. */
export function parseMemoryConnectionsBenchFixtureV1(value: unknown): MemoryConnectionsBenchFixtureV1 {
  const fixture = record(value, 'fixture');
  exactKeys(fixture, ['abilities', 'authoring', 'id', 'productScope', 'projectionTraces', 'version']);
  if (fixture.version !== MEMORY_CONNECTIONS_BENCH_VERSION) invalid('fixture version must be 1');
  if (fixture.id !== MEMORY_CONNECTIONS_BENCH_ID) invalid(`fixture id must be ${MEMORY_CONNECTIONS_BENCH_ID}`);
  if (fixture.productScope !== MEMORY_CONNECTIONS_BENCH_SCOPE) {
    invalid(`product scope must be ${MEMORY_CONNECTIONS_BENCH_SCOPE}`);
  }
  const abilities = literalArray(fixture.abilities, MEMORY_CONNECTIONS_BENCH_ABILITIES, 'fixture abilities');
  if (!sameSet(abilities, MEMORY_CONNECTIONS_BENCH_ABILITIES)) invalid('fixture must declare all five abilities');

  const authoring = record(fixture.authoring, 'authoring');
  exactKeys(authoring, ['cases', 'documents']);
  if (!EffectArray.isArray(authoring.documents) || authoring.documents.length === 0) {
    invalid('authoring documents must be a non-empty array');
  }
  if (!EffectArray.isArray(authoring.cases) || authoring.cases.length === 0) {
    invalid('authoring cases must be a non-empty array');
  }
  const documents = EffectArray.map(authoring.documents, parseDocument);
  const cases = EffectArray.map(authoring.cases, parseAuthoringCase);
  assertUnique(
    EffectArray.map(cases, testCase => testCase.id),
    'authoring case ids',
  );
  for (const scenario of MEMORY_CONNECTIONS_AUTHORING_SCENARIOS) {
    if (!EffectArray.some(cases, testCase => testCase.scenario === scenario)) {
      invalid(`missing reviewed authoring scenario ${scenario}`);
    }
  }

  if (!EffectArray.isArray(fixture.projectionTraces) || fixture.projectionTraces.length === 0) {
    invalid('projection traces must be a non-empty array');
  }
  const projectionTraces = EffectArray.map(fixture.projectionTraces, parseProjectionTrace);
  assertUnique(
    EffectArray.map(projectionTraces, trace => trace.id),
    'projection trace ids',
  );
  const operationKinds = new Set(
    EffectArray.flatMap(projectionTraces, trace => EffectArray.map(trace.operations, operation => operation.kind)),
  );
  for (const operation of MEMORY_CONNECTIONS_PROJECTION_OPERATIONS) {
    if (!operationKinds.has(operation)) invalid(`missing reviewed projection operation ${operation}`);
  }

  const coveredAbilities = new Set([
    ...EffectArray.map(cases, testCase => testCase.ability),
    ...EffectArray.map(projectionTraces, trace => trace.ability),
  ]);
  for (const ability of MEMORY_CONNECTIONS_BENCH_ABILITIES) {
    if (!coveredAbilities.has(ability)) invalid(`ability ${ability} has no reviewed case`);
  }

  return {
    abilities: [...MEMORY_CONNECTIONS_BENCH_ABILITIES],
    authoring: {
      cases: [...cases].sort((left, right) => compareText(left.id, right.id)),
      documents: [...documents].sort(compareDocument),
    },
    id: MEMORY_CONNECTIONS_BENCH_ID,
    productScope: MEMORY_CONNECTIONS_BENCH_SCOPE,
    projectionTraces: [...projectionTraces].sort((left, right) => compareText(left.id, right.id)),
    version: MEMORY_CONNECTIONS_BENCH_VERSION,
  };
}

/** Canonical reviewed truth preserves operation/relation order and normalizes set-like collections. */
export function serializeMemoryConnectionsBenchFixtureIdentity(input: MemoryConnectionsBenchFixtureV1): string {
  return `${JSON.stringify(parseMemoryConnectionsBenchFixtureV1(input), undefined, 2)}\n`;
}

export function memoryConnectionsBenchFixtureHash(input: MemoryConnectionsBenchFixtureV1): string {
  return sha256HexSync(serializeMemoryConnectionsBenchFixtureIdentity(input));
}

export function assertApprovedMemoryConnectionsBenchFixture(input: MemoryConnectionsBenchFixtureV1): void {
  const actual = memoryConnectionsBenchFixtureHash(input);
  if (actual !== MEMORY_CONNECTIONS_BENCH_APPROVED_FIXTURE_HASH) {
    invalid(
      `fixture hash ${actual} is not the approved ${MEMORY_CONNECTIONS_BENCH_APPROVED_FIXTURE_HASH}; review the complete authoring-projection truth before updating the approved hash`,
    );
  }
}

function parseDocument(value: unknown): MemoryConnectionsBenchDocumentV1 {
  const document = record(value, 'document');
  exactKeys(document, ['memoryId', 'relations', 'status', 'topic', 'user']);
  if (!EffectArray.isArray(document.relations)) invalid('document relations must be an array');
  return {
    memoryId: memoryId(document.memoryId, 'document memory id'),
    relations: EffectArray.map(document.relations, parseRelation),
    status: literal(document.status, ['active', 'archived'] as const, 'document status'),
    topic: slug(document.topic, 'document topic'),
    user: slug(document.user, 'document user'),
  };
}

function parseAuthoringCase(value: unknown): MemoryConnectionsAuthoringCaseV1 {
  const testCase = record(value, 'authoring case');
  exactKeys(testCase, ['ability', 'allowedScopes', 'expected', 'id', 'relations', 'scenario', 'sourceMemoryId']);
  if (!EffectArray.isArray(testCase.relations) || testCase.relations.length === 0 || testCase.relations.length > 16) {
    invalid('authoring case relations must contain between 1 and 16 items');
  }
  const expected = record(testCase.expected, 'authoring expectation');
  let parsedExpected: MemoryConnectionsAuthoringCaseV1['expected'];
  if (expected.kind === 'success') {
    exactKeys(expected, ['kind', 'relations']);
    if (!EffectArray.isArray(expected.relations) || expected.relations.length === 0) {
      invalid('successful authoring expectation needs relations');
    }
    parsedExpected = {kind: 'success', relations: EffectArray.map(expected.relations, parseRelation)};
  } else if (expected.kind === 'failure') {
    exactKeys(expected, ['kind', 'messageIncludes']);
    parsedExpected = {
      kind: 'failure',
      messageIncludes: nonEmptyString(expected.messageIncludes, 'failure message fragment'),
    };
  } else {
    invalid('authoring expectation kind is invalid');
  }
  if (!EffectArray.isArray(testCase.allowedScopes) || testCase.allowedScopes.length === 0) {
    invalid('authoring case allowed scopes must be a non-empty array');
  }
  return {
    ability: literal(testCase.ability, MEMORY_CONNECTIONS_BENCH_ABILITIES, 'authoring ability'),
    allowedScopes: EffectArray.map(testCase.allowedScopes, scope => threadnoteUri(scope, 'allowed scope')),
    expected: parsedExpected,
    id: nonEmptyString(testCase.id, 'authoring case id'),
    relations: EffectArray.map(testCase.relations, parseRelation),
    scenario: literal(testCase.scenario, MEMORY_CONNECTIONS_AUTHORING_SCENARIOS, 'authoring scenario'),
    sourceMemoryId: testCase.sourceMemoryId === null ? null : memoryId(testCase.sourceMemoryId, 'source memory id'),
  };
}

function parseProjectionTrace(value: unknown): MemoryConnectionsProjectionTraceV1 {
  const trace = record(value, 'projection trace');
  exactKeys(trace, ['ability', 'id', 'initialDocuments', 'operations', 'user']);
  if (!EffectArray.isArray(trace.initialDocuments) || trace.initialDocuments.length === 0) {
    invalid('projection trace initial documents must be a non-empty array');
  }
  if (!EffectArray.isArray(trace.operations) || trace.operations.length === 0) {
    invalid('projection trace operations must be a non-empty array');
  }
  return {
    ability: literal(trace.ability, MEMORY_CONNECTIONS_BENCH_ABILITIES, 'projection ability'),
    id: nonEmptyString(trace.id, 'projection trace id'),
    initialDocuments: EffectArray.map(trace.initialDocuments, parseDocument).sort(compareDocument),
    operations: EffectArray.map(trace.operations, parseProjectionOperation),
    user: slug(trace.user, 'projection trace user'),
  };
}

function parseProjectionOperation(value: unknown): MemoryConnectionsProjectionOperationV1 {
  const operation = record(value, 'projection operation');
  const kind = literal(operation.kind, MEMORY_CONNECTIONS_PROJECTION_OPERATIONS, 'projection operation kind');
  const expectedRows = parseExpectedRows(operation.expectedRows);
  if (kind === 'refresh' || kind === 'clean-rebuild') {
    exactKeys(operation, ['expectedRows', 'kind']);
    return {expectedRows, kind};
  }
  if (kind === 'target-add' || kind === 'target-id-change' || kind === 'source-replace') {
    exactKeys(operation, ['document', 'expectedRows', 'kind']);
    return {document: parseDocument(operation.document), expectedRows, kind};
  }
  if (kind === 'target-delete' || kind === 'source-delete') {
    exactKeys(operation, ['expectedRows', 'kind', 'topic', 'user']);
    return {
      expectedRows,
      kind,
      topic: slug(operation.topic, 'deleted topic'),
      user: slug(operation.user, 'deleted user'),
    };
  }
  exactKeys(operation, ['expectedRows', 'fromTopic', 'kind', 'toTopic', 'user']);
  return {
    expectedRows,
    fromTopic: slug(operation.fromTopic, 'move source topic'),
    kind,
    toTopic: slug(operation.toTopic, 'move target topic'),
    user: slug(operation.user, 'move user'),
  };
}

function parseExpectedRows(value: unknown): readonly MemoryConnectionsExpectedProjectionRowV1[] {
  if (!EffectArray.isArray(value)) invalid('expected rows must be an array');
  return EffectArray.map(value, item => {
    const row = record(item, 'expected projection row');
    exactKeys(row, [
      'relationOrdinal',
      'relationOrigin',
      'relationType',
      'sourceMemoryId',
      'targetMemoryId',
      'targetRef',
    ]);
    if (row.relationOrigin !== 'relation') invalid('projection row origin must be relation in the A+B fixture');
    return {
      relationOrdinal: nonNegativeInteger(row.relationOrdinal, 'relation ordinal'),
      relationOrigin: 'relation' as const,
      relationType: literal(row.relationType, MEMORY_RELATION_TYPES, 'projection relation type'),
      sourceMemoryId: memoryId(row.sourceMemoryId, 'projection source memory id'),
      targetMemoryId: row.targetMemoryId === null ? null : memoryId(row.targetMemoryId, 'projection target memory id'),
      targetRef: threadnoteUri(row.targetRef, 'projection target ref'),
    };
  }).sort(compareExpectedRow);
}

function parseRelation(value: unknown): MemoryRelation {
  const relation = record(value, 'relation');
  exactKeys(relation, ['type', 'uri']);
  return {
    type: literal(relation.type, MEMORY_RELATION_TYPES, 'relation type'),
    uri: threadnoteUri(relation.uri, 'relation uri'),
  };
}

function compareDocument(left: MemoryConnectionsBenchDocumentV1, right: MemoryConnectionsBenchDocumentV1): number {
  return compareText(`${left.user}\n${left.topic}`, `${right.user}\n${right.topic}`);
}

function compareExpectedRow(
  left: MemoryConnectionsExpectedProjectionRowV1,
  right: MemoryConnectionsExpectedProjectionRowV1,
): number {
  return compareText(
    `${left.sourceMemoryId}\n${left.relationOrigin}\n${left.relationOrdinal}\n${left.relationType}\n${left.targetRef}`,
    `${right.sourceMemoryId}\n${right.relationOrigin}\n${right.relationOrdinal}\n${right.relationType}\n${right.targetRef}`,
  );
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) invalid(`${label} must be an object`);
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = EffectRecord.keys(value).sort(compareText);
  const wanted = [...expected].sort(compareText);
  if (actual.length !== wanted.length || EffectArray.some(actual, (key, index) => key !== wanted[index])) {
    invalid('object has unsupported or missing fields');
  }
}

function literal<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) invalid(`${label} is invalid`);
  return value;
}

function literalArray<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Array<Values[number]> {
  if (!EffectArray.isArray(value)) invalid(`${label} must be an array`);
  return EffectArray.map(value, item => literal(item, values, label));
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    EffectArray.every(left, value => right.includes(value))
  );
}

function memoryId(value: unknown, label: string): string {
  const parsed = nonEmptyString(value, label);
  if (!/^tn_[A-Za-z0-9_-]{1,128}$/u.test(parsed)) invalid(`${label} is invalid`);
  return parsed;
}

function slug(value: unknown, label: string): string {
  const parsed = nonEmptyString(value, label);
  if (!/^[A-Za-z0-9_-]+$/u.test(parsed)) invalid(`${label} is invalid`);
  return parsed;
}

function threadnoteUri(value: unknown, label: string): string {
  const parsed = nonEmptyString(value, label);
  try {
    return parseResourceId(parsed).canonicalUri;
  } catch {
    return invalid(`${label} must be a canonicalizable threadnote URI`);
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Effect.pipe(value, EffectString.trim))
    invalid(`${label} must be a non-empty string`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${label} must be a non-negative integer`);
  }
  return value;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(message: string): never {
  throw new Error(`Invalid MemoryConnectionsBench v1: ${message}.`);
}
