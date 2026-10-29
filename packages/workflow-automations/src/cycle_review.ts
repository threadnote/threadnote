import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
import {Schema} from 'effect';
import {WorkflowAutomationError} from './contracts.js';
import {nativeCycleHasControl} from './cycle.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

const id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u));
const text = (maximum = 4096) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));
const gitObject = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u));
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const fail = (message: string): never => {
  throw WorkflowAutomationError.make({code: 'invalid-cycle-review', message});
};

export const NativeCycleSnapshotSchema = Schema.Struct({
  format: Schema.Literal('threadnote-native-cycle-snapshot'),
  version: Schema.Literal(1),
  snapshotId: id,
  phaseId: id,
  phaseHash: digest,
  repo: text(),
  head: gitObject,
  baseTree: gitObject,
  scopeBase: gitObject,
  declaredBaseHead: gitObject,
  scopeFiles: Schema.Array(text()).check(Schema.isMaxLength(8192)),
  tree: gitObject,
  previous: Schema.optionalKey(id),
  supersedes: Schema.optionalKey(id),
  previousTree: Schema.optionalKey(gitObject),
  acceptedHead: Schema.optionalKey(gitObject),
  files: Schema.Array(text()).check(Schema.isMaxLength(8192)),
  pinnedRef: text(),
});
export type NativeCycleSnapshot = typeof NativeCycleSnapshotSchema.Type;

const findingSchema = Schema.Struct({
  id,
  file: text(),
  line: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0)),
  body: text(8192),
  trigger: text(),
  impact: text(),
  evidence: text(),
  severity: Schema.Literals(['critical', 'important', 'minor', 'informational']),
  category: Schema.Literals([
    'security',
    'performance',
    'architecture',
    'quality',
    'flaky-test',
    'devex',
    'correctness',
  ]),
  confidence: Schema.Finite.check(Schema.isInt(), Schema.isBetween({minimum: 0, maximum: 100})),
  state: Schema.Literals(['new', 'carried', 'resolved', 'rejected']),
  reason: Schema.optionalKey(text()),
});
export const NativeCycleReviewSchema = Schema.Struct({
  snapshotId: id,
  phaseHash: digest,
  snapshotTree: gitObject,
  status: Schema.Literal('complete'),
  mode: Schema.Literals(['full', 'incremental']),
  selected: Schema.Array(id).check(Schema.isBetweenLength(1, 16)),
  lanes: Schema.Array(Schema.Struct({name: id, status: Schema.Literal('complete')})).check(
    Schema.isBetweenLength(1, 16),
  ),
  findings: Schema.Array(findingSchema).check(Schema.isMaxLength(512)),
});
export type NativeCycleReview = typeof NativeCycleReviewSchema.Type;
const blocking = (finding: NativeCycleReview['findings'][number]) =>
  ['critical', 'important'].includes(finding.severity) && ['new', 'carried'].includes(finding.state);
const safePath = (value: string) =>
  value.length > 0 &&
  !/[\\:]/u.test(value) &&
  !nativeCycleHasControl(value) &&
  !Effect.pipe(value, EffectString.startsWith('/')) &&
  EffectArray.every(Effect.pipe(value, EffectString.split('/')), part => part !== '' && part !== '.' && part !== '..');

export const nativeCycleOrchestratorLane = 'orchestrator';

export function validateNativeCycleReview(
  snapshot: NativeCycleSnapshot,
  input: unknown,
  previous?: {readonly snapshot: NativeCycleSnapshot; readonly review: NativeCycleReview},
) {
  const result = validateNativeCycleReviewHistory(snapshot, input, previous);
  if (!result.review.selected.includes('simplicity'))
    fail('Select the required simplicity review lane and include its complete report.');
  return result;
}

/** Revalidate stored evidence without applying later submission requirements to its immutable history. */
export function validateNativeCycleReviewHistory(
  snapshot: NativeCycleSnapshot,
  input: unknown,
  previous?: {readonly snapshot: NativeCycleSnapshot; readonly review: NativeCycleReview},
) {
  let review: NativeCycleReview;
  try {
    review = Schema.decodeUnknownSync(NativeCycleReviewSchema, {onExcessProperty: 'error'})(input);
  } catch {
    return fail('Every selected review lane and finding must have a complete valid report.');
  }
  if (
    review.snapshotId !== snapshot.snapshotId ||
    review.phaseHash !== snapshot.phaseHash ||
    review.snapshotTree !== snapshot.tree ||
    review.mode !== (snapshot.previous ? 'incremental' : 'full')
  )
    fail('Review source or mode does not match its immutable snapshot.');
  const selected = new Set(review.selected),
    lanes = new Set(EffectArray.map(review.lanes, lane => lane.name));
  if (!selected.has(nativeCycleOrchestratorLane))
    fail('Select the required orchestrator review lane and include its complete report.');
  if (
    selected.size !== review.selected.length ||
    lanes.size !== review.lanes.length ||
    selected.size !== lanes.size ||
    EffectArray.some([...selected], name => !lanes.has(name))
  )
    fail('Selected and completed review lanes differ.');
  if ((snapshot.previous || snapshot.supersedes) && !previous) fail('Prior review evidence is required.');
  if (snapshot.previous && snapshot.supersedes) fail('A snapshot has one source predecessor.');
  if (
    previous &&
    ((snapshot.previous ?? snapshot.supersedes) !== previous.snapshot.snapshotId ||
      (snapshot.previous && snapshot.previousTree !== previous.snapshot.tree) ||
      snapshot.phaseId !== previous.snapshot.phaseId ||
      (snapshot.previous
        ? snapshot.phaseHash !== previous.snapshot.phaseHash
        : snapshot.phaseHash === previous.snapshot.phaseHash) ||
      snapshot.baseTree !== previous.snapshot.baseTree ||
      snapshot.repo !== previous.snapshot.repo ||
      (snapshot.head !== previous.snapshot.head && snapshot.acceptedHead !== snapshot.head))
  )
    fail('Review history does not match the source predecessor.');
  const prior = new Map(
    EffectOption.getOrUndefined(
      EffectOption.map(EffectOption.fromNullishOr(previous?.review.findings), __effectArrayReceiver =>
        EffectArray.map(__effectArrayReceiver, finding => [finding.id, finding]),
      ),
    ) ?? [],
  );
  const seen = new Set<string>();
  for (const finding of review.findings) {
    if (
      seen.has(finding.id) ||
      !safePath(finding.file) ||
      EffectArray.some(
        [finding.body, finding.trigger, finding.impact, finding.evidence],
        value => !Effect.pipe(value, EffectString.trim),
      )
    )
      fail('Findings require unique IDs, relative locations and concrete evidence.');
    seen.add(finding.id);
    const old = prior.get(finding.id);
    if (
      (['resolved', 'rejected'].includes(finding.state) || (old && blocking(old) && !blocking(finding))) &&
      !Effect.pipe(finding.reason, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
      )
    )
      fail('Resolving, rejecting or downgrading a finding requires evidence.');
    if ((['resolved', 'carried'].includes(finding.state) && !old) || (finding.state === 'new' && old))
      fail('Prior findings must retain their identity and disposition.');
  }
  for (const finding of prior.values())
    if (blocking(finding) && !seen.has(finding.id)) fail('A prior blocker disappeared without a disposition.');
  const active = EffectArrayPipe(review.findings, __effectArrayValues =>
    EffectArray.filter(
      __effectArrayValues,
      (finding, __effectArrayIndex) =>
        __effectArrayIndex in __effectArrayValues && ['new', 'carried'].includes(finding.state),
    ),
  );
  return {
    review,
    summary: {
      snapshotId: snapshot.snapshotId,
      snapshotTree: snapshot.tree,
      phaseHash: snapshot.phaseHash,
      blockingIssueCount: EffectArray.filter(active, blocking).length,
      counts: EffectRecord.fromEntries(
        EffectArray.map(['critical', 'important', 'minor', 'informational'], severity => [
          severity,
          EffectArray.filter(active, finding => finding.severity === severity).length,
        ]),
      ),
      resolved: EffectArray.map(
        EffectArray.filter(review.findings, finding => finding.state === 'resolved'),
        finding => finding.id,
      ),
    },
  };
}
