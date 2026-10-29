import {Array as EffectArray, Predicate} from 'effect';
import {Schema} from 'effect';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const LEGACY_PROCEDURE_MANIFEST_VERSION = 1;
const PROCEDURE_MANIFEST_VERSION = 2;
const PROCEDURE_RECEIPT_VERSION = 1;

const MAX_ARGUMENTS = 16;
const MAX_CAPABILITIES = 32;
const MAX_COMMANDS = 32;
const MAX_DEPENDENCIES = 64;
const MAX_DURABLE_MEMORY_IDS = 64;
const MAX_FIXTURES = 32;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_OPAQUE_VALUE_LENGTH = 256;
const MAX_SUMMARY_LENGTH = 512;
const MAX_TASK_KEYWORDS = 32;
const MAX_ARGUMENT_LENGTH = 512;
const MAX_SEMANTIC_VERSION_LENGTH = 128;

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._:/-]*$/;
const MEMORY_ID_PATTERN = /^tn_[a-z0-9]{1,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SEMANTIC_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export class ProcedureContractError extends Schema.TaggedError<
  ProcedureContractError,
  {readonly brand: unique symbol}
>()('ProcedureContractError', {
  message: Schema.String,
}) {}

export interface ProcedureArtifactIdentity {
  readonly id: string;
  readonly semanticVersion: string;
  readonly sha256: string;
}

export interface ProcedureDependency {
  readonly artifactId: string;
  readonly semanticVersion: string;
}

export interface ProcedureFixtureDescriptor {
  readonly id: string;
  readonly sha256: string;
}

export interface ProcedureCommandDescriptor {
  readonly argv: readonly string[];
  readonly id: string;
}

interface ProcedureManifestBase {
  readonly artifact: ProcedureArtifactIdentity;
  readonly compatible: {
    readonly capabilities: readonly string[];
    readonly surfaceIds: readonly string[];
  };
  readonly dependencies: readonly ProcedureDependency[];
  readonly owner: string;
  readonly relatedDurableMemoryIds: readonly string[];
  readonly reviewedOn: string;
  readonly verification: {
    readonly commands: readonly ProcedureCommandDescriptor[];
    readonly fixtures: readonly ProcedureFixtureDescriptor[];
  };
}

export interface ProcedureRollout {
  readonly channel: 'preview' | 'stable';
  readonly percentage: number;
}

export interface ProcedureManifestV1 extends ProcedureManifestBase {
  readonly schemaVersion: typeof LEGACY_PROCEDURE_MANIFEST_VERSION;
}

export interface ProcedureManifestV2 extends ProcedureManifestBase {
  readonly presentation: {
    readonly summary: string;
    readonly taskKeywords: readonly string[];
  };
  readonly rollout: ProcedureRollout;
  readonly schemaVersion: typeof PROCEDURE_MANIFEST_VERSION;
}

export type ProcedureManifest = ProcedureManifestV1 | ProcedureManifestV2;

export interface ProcedureVerificationReceipt {
  readonly artifact: ProcedureArtifactIdentity;
  readonly commandIds: readonly string[];
  readonly fixtureDigests: readonly ProcedureFixtureDescriptor[];
  readonly hostVersion: string;
  readonly manifestSha256: string;
  readonly schemaVersion: typeof PROCEDURE_RECEIPT_VERSION;
  readonly threadnoteVersion: string;
  readonly verifiedAt: string;
  readonly verifier: string;
}

export type ProcedureStatus = 'current' | 'incompatible' | 'locally-modified' | 'unverified' | 'update-available';

export interface ProcedureStatusInput {
  readonly availableArtifact?: ProcedureArtifactIdentity;
  readonly capabilities: readonly string[];
  readonly localArtifactSha256?: string;
  readonly receipt?: unknown;
  readonly surfaceIds: readonly string[];
}

export function parseProcedureManifest(value: unknown): ProcedureManifest {
  const source = object(value, 'procedure manifest');
  const schemaVersion = source.schemaVersion;
  if (schemaVersion !== LEGACY_PROCEDURE_MANIFEST_VERSION && schemaVersion !== PROCEDURE_MANIFEST_VERSION) {
    fail('procedure manifest schemaVersion must be 1 or 2');
  }
  exactKeys(
    source,
    [
      'artifact',
      'compatible',
      'dependencies',
      'owner',
      ...(schemaVersion === PROCEDURE_MANIFEST_VERSION ? ['presentation'] : []),
      'relatedDurableMemoryIds',
      'reviewedOn',
      ...(schemaVersion === PROCEDURE_MANIFEST_VERSION ? ['rollout'] : []),
      'schemaVersion',
      'verification',
    ],
    'procedure manifest',
  );
  const compatible = object(source.compatible, 'compatible');
  exactKeys(compatible, ['capabilities', 'surfaceIds'], 'compatible');
  const verification = object(source.verification, 'verification');
  exactKeys(verification, ['commands', 'fixtures'], 'verification');
  const artifact = parseArtifact(source.artifact, 'artifact');
  const parsedCompatible = {
    capabilities: sortedIdentifiers(
      sourceArray(compatible.capabilities, 'compatible.capabilities'),
      MAX_CAPABILITIES,
      'compatible.capabilities',
    ),
    surfaceIds: sortedIdentifiers(
      sourceArray(compatible.surfaceIds, 'compatible.surfaceIds'),
      MAX_CAPABILITIES,
      'compatible.surfaceIds',
    ),
  };
  const dependencies = sortedDependencies(sourceArray(source.dependencies, 'dependencies'));
  const owner = opaque(source.owner, 'owner');
  const relatedDurableMemoryIds = sortedMemoryIds(
    sourceArray(source.relatedDurableMemoryIds, 'relatedDurableMemoryIds'),
  );
  const reviewedOn = calendarDate(source.reviewedOn, 'reviewedOn');
  const parsedVerification = {
    commands: orderedCommands(sourceArray(verification.commands, 'verification.commands')),
    fixtures: sortedFixtures(sourceArray(verification.fixtures, 'verification.fixtures')),
  };
  if (schemaVersion === LEGACY_PROCEDURE_MANIFEST_VERSION) {
    return {
      artifact,
      compatible: parsedCompatible,
      dependencies,
      owner,
      relatedDurableMemoryIds,
      reviewedOn,
      schemaVersion: LEGACY_PROCEDURE_MANIFEST_VERSION,
      verification: parsedVerification,
    };
  }
  const presentation = object(source.presentation, 'presentation');
  exactKeys(presentation, ['summary', 'taskKeywords'], 'presentation');
  const rollout = object(source.rollout, 'rollout');
  exactKeys(rollout, ['channel', 'percentage'], 'rollout');
  const channel = rolloutChannel(rollout.channel);
  if (channel === 'stable' && Effect.pipe(artifact.semanticVersion, EffectString.includes('-'))) {
    fail('stable procedure rollout requires a stable semantic version');
  }
  return {
    artifact,
    compatible: parsedCompatible,
    dependencies,
    owner,
    presentation: {
      summary: boundedText(presentation.summary, 'presentation.summary', MAX_SUMMARY_LENGTH),
      taskKeywords: sortedIdentifiers(
        sourceArray(presentation.taskKeywords, 'presentation.taskKeywords'),
        MAX_TASK_KEYWORDS,
        'presentation.taskKeywords',
      ),
    },
    relatedDurableMemoryIds,
    reviewedOn,
    rollout: {channel, percentage: rolloutPercentage(rollout.percentage)},
    schemaVersion: PROCEDURE_MANIFEST_VERSION,
    verification: parsedVerification,
  };
}

export function isPublishableProcedureManifest(manifest: ProcedureManifest): manifest is ProcedureManifestV2 {
  return manifest.schemaVersion === PROCEDURE_MANIFEST_VERSION;
}

export function parseProcedureVerificationReceipt(value: unknown): ProcedureVerificationReceipt {
  const source = object(value, 'procedure verification receipt');
  exactKeys(
    source,
    [
      'artifact',
      'commandIds',
      'fixtureDigests',
      'hostVersion',
      'manifestSha256',
      'schemaVersion',
      'threadnoteVersion',
      'verifiedAt',
      'verifier',
    ],
    'procedure verification receipt',
  );
  if (source.schemaVersion !== PROCEDURE_RECEIPT_VERSION) {
    fail('procedure verification receipt schemaVersion must be 1');
  }
  return {
    artifact: parseArtifact(source.artifact, 'receipt.artifact'),
    commandIds: orderedIdentifiers(
      sourceArray(source.commandIds, 'receipt.commandIds'),
      MAX_COMMANDS,
      'receipt.commandIds',
    ),
    fixtureDigests: sortedFixtures(sourceArray(source.fixtureDigests, 'receipt.fixtureDigests')),
    hostVersion: opaque(source.hostVersion, 'hostVersion'),
    manifestSha256: sha256(source.manifestSha256, 'manifestSha256'),
    schemaVersion: PROCEDURE_RECEIPT_VERSION,
    threadnoteVersion: opaque(source.threadnoteVersion, 'threadnoteVersion'),
    verifiedAt: instant(source.verifiedAt, 'verifiedAt'),
    verifier: opaque(source.verifier, 'verifier'),
  };
}

export function canonicalProcedureManifest(manifest: ProcedureManifest): string {
  return `${JSON.stringify(parseProcedureManifest(manifest))}\n`;
}

export function canonicalProcedureVerificationReceipt(receipt: ProcedureVerificationReceipt): string {
  return `${JSON.stringify(parseProcedureVerificationReceipt(receipt))}\n`;
}

export function procedureManifestSha256(manifest: ProcedureManifest): string {
  return new Bun.CryptoHasher('sha256').update(canonicalProcedureManifest(manifest)).digest('hex');
}

export function createProcedureVerificationReceipt(
  manifest: ProcedureManifest,
  input: Pick<ProcedureVerificationReceipt, 'hostVersion' | 'threadnoteVersion' | 'verifiedAt' | 'verifier'>,
): ProcedureVerificationReceipt {
  const parsed = parseProcedureManifest(manifest);
  return parseProcedureVerificationReceipt({
    artifact: parsed.artifact,
    commandIds: EffectArray.map(parsed.verification.commands, command => command.id),
    fixtureDigests: parsed.verification.fixtures,
    hostVersion: input.hostVersion,
    manifestSha256: procedureManifestSha256(parsed),
    schemaVersion: PROCEDURE_RECEIPT_VERSION,
    threadnoteVersion: input.threadnoteVersion,
    verifiedAt: input.verifiedAt,
    verifier: input.verifier,
  });
}

/** Calculates status only; command descriptors are never executed by this module. */
export function procedureStatus(manifest: ProcedureManifest, input: ProcedureStatusInput): ProcedureStatus {
  const parsed = parseProcedureManifest(manifest);
  if (!requirementsSatisfied(parsed, input)) return 'incompatible';
  if (input.localArtifactSha256 !== undefined && input.localArtifactSha256 !== parsed.artifact.sha256) {
    return 'locally-modified';
  }
  if (input.availableArtifact !== undefined && isNewerArtifact(parsed.artifact, input.availableArtifact)) {
    return 'update-available';
  }
  try {
    return receiptMatches(parsed, parseProcedureVerificationReceipt(input.receipt)) ? 'current' : 'unverified';
  } catch (error) {
    if (Schema.is(ProcedureContractError)(error)) return 'unverified';
    throw error;
  }
}

function parseArtifact(value: unknown, label: string): ProcedureArtifactIdentity {
  const source = object(value, label);
  exactKeys(source, ['id', 'semanticVersion', 'sha256'], label);
  return {
    id: identifier(source.id, `${label}.id`),
    semanticVersion: semanticVersion(source.semanticVersion, `${label}.semanticVersion`),
    sha256: sha256(source.sha256, `${label}.sha256`),
  };
}

function sortedDependencies(values: readonly unknown[]): readonly ProcedureDependency[] {
  bounded(values, MAX_DEPENDENCIES, 'dependencies');
  const dependencies = EffectArray.map(values, (value, index) => {
    const source = object(value, `dependencies[${index}]`);
    exactKeys(source, ['artifactId', 'semanticVersion'], `dependencies[${index}]`);
    return {
      artifactId: identifier(source.artifactId, `dependencies[${index}].artifactId`),
      semanticVersion: semanticVersion(source.semanticVersion, `dependencies[${index}].semanticVersion`),
    };
  });
  return sortedUnique(
    dependencies,
    dependency => `${dependency.artifactId}\u0000${dependency.semanticVersion}`,
    'dependencies',
  );
}

function sortedFixtures(values: readonly unknown[]): readonly ProcedureFixtureDescriptor[] {
  bounded(values, MAX_FIXTURES, 'verification.fixtures');
  const fixtures = EffectArray.map(values, (value, index) => {
    const source = object(value, `verification.fixtures[${index}]`);
    exactKeys(source, ['id', 'sha256'], `verification.fixtures[${index}]`);
    return {
      id: identifier(source.id, `verification.fixtures[${index}].id`),
      sha256: sha256(source.sha256, `verification.fixtures[${index}].sha256`),
    };
  });
  return sortedUnique(fixtures, fixture => fixture.id, 'verification.fixtures');
}

function orderedCommands(values: readonly unknown[]): readonly ProcedureCommandDescriptor[] {
  bounded(values, MAX_COMMANDS, 'verification.commands');
  const commands = EffectArray.map(values, (value, index) => {
    const source = object(value, `verification.commands[${index}]`);
    exactKeys(source, ['argv', 'id'], `verification.commands[${index}]`);
    const argv = sourceArray(source.argv, `verification.commands[${index}].argv`);
    if (argv.length === 0 || argv.length > MAX_ARGUMENTS)
      fail(`verification.commands[${index}].argv must contain 1 to ${MAX_ARGUMENTS} arguments`);
    return {
      argv: EffectArray.map(argv, (argument, argumentIndex) =>
        commandArgument(argument, `verification.commands[${index}].argv[${argumentIndex}]`),
      ),
      id: identifier(source.id, `verification.commands[${index}].id`),
    };
  });
  const seen = new Set<string>();
  for (const command of commands) {
    if (seen.has(command.id)) fail('verification.commands contains a duplicate');
    seen.add(command.id);
  }
  return commands;
}

function orderedIdentifiers(values: readonly unknown[], maximum: number, label: string): readonly string[] {
  bounded(values, maximum, label);
  const identifiers = EffectArray.map(values, (value, index) => identifier(value, `${label}[${index}]`));
  if (new Set(identifiers).size !== identifiers.length) fail(`${label} must not contain duplicate entries`);
  return identifiers;
}

function sortedIdentifiers(values: readonly unknown[], maximum: number, label: string): readonly string[] {
  bounded(values, maximum, label);
  return sortedUnique(
    EffectArray.map(values, (value, index) => identifier(value, `${label}[${index}]`)),
    value => value,
    label,
  );
}

function sortedMemoryIds(values: readonly unknown[]): readonly string[] {
  bounded(values, MAX_DURABLE_MEMORY_IDS, 'relatedDurableMemoryIds');
  return sortedUnique(
    EffectArray.map(values, (value, index) => {
      if (typeof value !== 'string' || !MEMORY_ID_PATTERN.test(value))
        fail(`relatedDurableMemoryIds[${index}] must be a stable tn_ memory ID`);
      return value;
    }),
    value => value,
    'relatedDurableMemoryIds',
  );
}

function receiptMatches(manifest: ProcedureManifest, receipt: ProcedureVerificationReceipt): boolean {
  return (
    artifactEquals(manifest.artifact, receipt.artifact) &&
    receipt.manifestSha256 === procedureManifestSha256(manifest) &&
    arraysEqual(
      EffectArray.map(manifest.verification.commands, command => command.id),
      receipt.commandIds,
    ) &&
    arraysEqual(
      EffectArray.map(manifest.verification.fixtures, fixture => `${fixture.id}\u0000${fixture.sha256}`),
      EffectArray.map(receipt.fixtureDigests, fixture => `${fixture.id}\u0000${fixture.sha256}`),
    )
  );
}

function requirementsSatisfied(manifest: ProcedureManifest, input: ProcedureStatusInput): boolean {
  const capabilities = new Set(input.capabilities);
  const surfaceIds = new Set(input.surfaceIds);
  return (
    EffectArray.every(manifest.compatible.capabilities, capability => capabilities.has(capability)) &&
    EffectArray.every(manifest.compatible.surfaceIds, surfaceId => surfaceIds.has(surfaceId))
  );
}

function isNewerArtifact(current: ProcedureArtifactIdentity, available: ProcedureArtifactIdentity): boolean {
  return current.id === available.id && compareSemanticVersions(available.semanticVersion, current.semanticVersion) > 0;
}

export function compareSemanticVersions(left: string, right: string): number {
  const parsedLeft = semanticVersionParts(left);
  const parsedRight = semanticVersionParts(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = compareNumericIdentifiers(parsedLeft.numbers[index], parsedRight.numbers[index]);
    if (difference !== 0) return difference;
  }
  if (parsedLeft.prerelease === undefined) return parsedRight.prerelease === undefined ? 0 : 1;
  if (parsedRight.prerelease === undefined) return -1;
  const leftParts = Effect.pipe(parsedLeft.prerelease, EffectString.split('.'));
  const rightParts = Effect.pipe(parsedRight.prerelease, EffectString.split('.'));
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/.test(leftPart);
    const rightNumber = /^\d+$/.test(rightPart);
    if (leftNumber && rightNumber) return compareNumericIdentifiers(leftPart, rightPart);
    if (leftNumber) return -1;
    if (rightNumber) return 1;
    return compareStrings(leftPart, rightPart);
  }
  return 0;
}

function rolloutChannel(value: unknown): ProcedureRollout['channel'] {
  if (value !== 'preview' && value !== 'stable') fail('rollout.channel must be preview or stable');
  return value;
}

function rolloutPercentage(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 100) {
    fail('rollout.percentage must be an integer from 0 to 100');
  }
  return value;
}

function semanticVersionParts(value: string): {readonly numbers: readonly string[]; readonly prerelease?: string} {
  const match = SEMANTIC_VERSION_PATTERN.exec(value);
  if (!match) fail('invalid semantic version');
  return {numbers: [match[1], match[2], match[3]], prerelease: match[4]};
}

function artifactEquals(left: ProcedureArtifactIdentity, right: ProcedureArtifactIdentity): boolean {
  return left.id === right.id && left.semanticVersion === right.semanticVersion && left.sha256 === right.sha256;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && EffectArray.every(left, (value, index) => value === right[index]);
}

function sortedUnique<A>(values: readonly A[], key: (value: A) => string, label: string): readonly A[] {
  const ordered = [...values].sort((left, right) => compareStrings(key(left), key(right)));
  for (let index = 1; index < ordered.length; index += 1) {
    if (key(ordered[index - 1]) === key(ordered[index])) fail(`${label} must not contain duplicate entries`);
  }
  return ordered;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) fail(`${label} must be an object`);
  return value;
}

function sourceArray(value: unknown, label: string): readonly unknown[] {
  if (!EffectArray.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = EffectRecord.keys(value).sort(compareStrings);
  const orderedExpected = [...expected].sort(compareStrings);
  if (!arraysEqual(actual, orderedExpected)) fail(`${label} has unknown or missing fields`);
}

function bounded(values: readonly unknown[], maximum: number, label: string): void {
  if (values.length > maximum) fail(`${label} must contain at most ${maximum} entries`);
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    fail(`${label} must be a lowercase identifier`);
  }
  return value;
}

function opaque(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_OPAQUE_VALUE_LENGTH ||
    Effect.pipe(value, EffectString.trim) !== value ||
    containsControlCharacter(value)
  ) {
    fail(`${label} must be a non-empty opaque value`);
  }
  return value;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    Effect.pipe(value, EffectString.trim) !== value ||
    containsControlCharacter(value)
  ) {
    fail(`${label} must be non-empty bounded text`);
  }
  return value;
}

function commandArgument(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ARGUMENT_LENGTH ||
    containsControlCharacter(value)
  ) {
    fail(`${label} must be a bounded non-control string`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) fail(`${label} must be a lowercase SHA-256 hex digest`);
  return value;
}

function semanticVersion(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length > MAX_SEMANTIC_VERSION_LENGTH ||
    !SEMANTIC_VERSION_PATTERN.test(value)
  ) {
    fail(`${label} must be a bounded semantic version`);
  }
  return value;
}

function calendarDate(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} must be an ISO calendar date`);
  const match = DATE_PATTERN.exec(value);
  if (!match || Effect.pipe(new Date(`${value}T00:00:00.000Z`).toISOString(), EffectString.slice(0, 10)) !== value) {
    fail(`${label} must be an ISO calendar date`);
  }
  return value;
}

function instant(value: unknown, label: string): string {
  if (typeof value !== 'string' || !INSTANT_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    fail(`${label} must be an ISO UTC instant`);
  }
  const canonical = new Date(value).toISOString();
  if (value !== canonical && value !== Effect.pipe(canonical, EffectString.replace('.000Z', 'Z')))
    fail(`${label} must be an ISO UTC instant`);
  return value;
}

function compareNumericIdentifiers(left: string, right: string): number {
  return left.length === right.length ? compareStrings(left, right) : left.length < right.length ? -1 : 1;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = Effect.pipe(
      character,
      EffectString.charCodeAt(0),
      Effect.Option.getOrElse(() => NaN),
    );
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function fail(message: string): never {
  throw ProcedureContractError.make({message});
}
