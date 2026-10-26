import {Schema} from 'effect';
import {WorkflowAutomationError} from './contracts.js';
import {
  decodeNativeCycleState,
  nativeCycleAbsolutePath,
  nativeCycleHasControl,
  type NativeCycleState,
} from './cycle.js';

const text = (maximum: number) =>
  Schema.String.check(
    Schema.makeFilter(value =>
      !value.trim() || new TextEncoder().encode(value).byteLength > maximum || nativeCycleHasControl(value)
        ? 'Expected bounded single-line text.'
        : undefined,
    ),
  );
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const gitObject = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u));
const fail = (message: string): never => {
  throw WorkflowAutomationError.make({code: 'invalid-cycle-packet', message});
};
const capacitySchema = Schema.Struct({
  model: text(128),
  effort: text(32),
  selection: Schema.Literals(['main-agent', 'least-sufficient', 'risk', 'user-override', 'escalation']),
  risk: Schema.Literals(['settled', 'unresolved', 'high']),
  reason: text(512),
  catalogEvidence: text(512),
  trigger: Schema.optionalKey(text(512)),
  escalationCause: Schema.optionalKey(Schema.Literals(['reasoning-limit', 'new-complexity', 'user-request'])),
  userAuthority: Schema.optionalKey(text(512)),
  nearestSupportedEffort: Schema.optionalKey(text(256)),
});

export function validateNativeCycleCapacityRecord(input: unknown) {
  let record: typeof capacitySchema.Type;
  try {
    record = Schema.decodeUnknownSync(capacitySchema, {onExcessProperty: 'error'})(input);
  } catch {
    return fail('Record the selected model, effort, capability evidence and concrete selection reason.');
  }
  if (
    record.selection === 'least-sufficient' &&
    record.risk === 'settled' &&
    record.effort !== 'low' &&
    !record.nearestSupportedEffort
  )
    fail('A settled slice starts at low effort or records the nearest supported effort.');
  if (record.selection === 'user-override' && !record.userAuthority) fail('Preserve the explicit model override.');
  if (record.selection === 'escalation' && (!record.trigger || !record.escalationCause))
    fail('Capability escalation requires observed reasoning limits, new complexity or user instruction.');
  if (record.risk !== 'settled' && record.selection === 'least-sufficient')
    fail('Resolve the design gap or record a justified risk selection before routine dispatch.');
  return record;
}

export function validateNativeCycleFeaturePublication(
  input: unknown,
  expected: {readonly currentHead: string; readonly team: string},
) {
  const exemption = Schema.Struct({exemption: Schema.Literals(['small-fix', 'maintenance']), reason: text(512)});
  if (Schema.is(exemption)(input)) {
    Schema.decodeSync(exemption, {onExcessProperty: 'error'})(input);
    return true;
  }
  const published = Schema.Struct({
    state: Schema.Literal('published'),
    team: text(128),
    uri: text(4096),
    revision: digest,
    currentHead: gitObject,
    remoteCommit: gitObject,
    evidence: text(4096),
  });
  let receipt: typeof published.Type;
  try {
    receipt = Schema.decodeUnknownSync(published, {onExcessProperty: 'error'})(input);
  } catch {
    return fail('Publication needs a current shared receipt or an explicit small-fix exemption.');
  }
  if (
    receipt.currentHead !== expected.currentHead ||
    receipt.team !== expected.team ||
    !receipt.uri.startsWith('threadnote://') ||
    !receipt.uri.includes(`/memories/shared/${encodeURIComponent(expected.team)}/`)
  )
    fail('Publication does not match the exact source head and selected team.');
  return true;
}

const graphSchema = Schema.Struct({
  state: Schema.Literal('ready'),
  head: gitObject,
  tree: gitObject,
  dirty: Schema.Boolean,
  snapshotId: text(128),
  graphContentId: text(128),
  repositoryRoot: text(4096),
});
const anchorSchema = Schema.Struct({path: text(4096), sha256: digest, pattern: text(256)});
export const NativeCyclePacketOptionsSchema = Schema.Struct({
  capacity: capacitySchema,
  graphProof: graphSchema,
  anchors: Schema.Array(anchorSchema).check(Schema.isBetweenLength(1, 128)),
  ownership: Schema.Array(text(4096)).check(Schema.isBetweenLength(1, 128)),
  checks: Schema.Array(text(1024)).check(Schema.isBetweenLength(1, 32)),
  budgetBytes: Schema.optionalKey(
    Schema.Finite.check(Schema.isInt(), Schema.isBetween({minimum: 1024, maximum: 65_536})),
  ),
  detailRefs: Schema.optionalKey(Schema.Array(text(4096)).check(Schema.isMaxLength(16))),
});
export type NativeCyclePacketOptions = typeof NativeCyclePacketOptionsSchema.Type;

export function nativeCyclePacket(
  value: NativeCycleState,
  phaseId: string,
  input: unknown,
): Readonly<Record<string, unknown>> {
  const state = decodeNativeCycleState(value),
    phase = state.plan.phases.find(item => item.id === phaseId);
  if (!phase) return fail('Unknown phase.');
  let options: NativeCyclePacketOptions;
  try {
    options = Schema.decodeUnknownSync(NativeCyclePacketOptionsSchema, {onExcessProperty: 'error'})(input);
  } catch {
    return {available: false, reason: 'graph-or-anchor-proof-unavailable'};
  }
  if (
    !nativeCycleAbsolutePath(options.graphProof.repositoryRoot) ||
    options.anchors.some(
      anchor =>
        anchor.path.startsWith('/') ||
        /[\\:]/u.test(anchor.path) ||
        nativeCycleHasControl(anchor.path) ||
        anchor.path.split('/').some(part => !part || part === '.' || part === '..'),
    )
  )
    return {available: false, reason: 'graph-or-anchor-proof-unavailable'};
  const packet = {
    phaseId,
    phaseHash: state.phases[phaseId].phaseHash,
    objective: state.plan.objective,
    delivery: state.plan.delivery,
    source: state.plan.source,
    dependsOn: phase.dependsOn,
    dependencies: phase.dependsOn.map(id => ({
      phaseId: id,
      phaseHash: state.phases[id].phaseHash,
      head: state.phases[id].head,
      tree: state.phases[id].tree,
      status: state.phases[id].status,
    })),
    allowedPaths: phase.allowedPaths,
    acceptanceCriteria: phase.acceptanceCriteria,
    acceptanceRefs: phase.acceptanceRefs,
    capacity: validateNativeCycleCapacityRecord(options.capacity),
    graphProof: options.graphProof,
    anchors: options.anchors,
    ownership: options.ownership,
    checks: options.checks,
    detailRefs: options.detailRefs ?? [],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(packet)).byteLength;
  if (bytes > (options.budgetBytes ?? 12_288))
    return {
      available: false,
      reason: 'packet-budget-exceeded',
      phaseId,
      phaseHash: packet.phaseHash,
      requiredBytes: bytes,
      detailRefs: options.detailRefs ?? [],
      continuation: 'Read the exact phase acceptance and ownership, then create a bounded implementation slice.',
    };
  return {available: true, ...packet};
}
