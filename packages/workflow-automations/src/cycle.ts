import {Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {WorkflowAutomationError} from './contracts.js';

const id = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  Schema.makeFilter(value =>
    value.includes('..') || ['constructor', 'prototype', '__proto__'].includes(value)
      ? 'Reserved identifier.'
      : undefined,
  ),
);
export const nativeCycleHasControl = (value: string, allowLineFeed = false): boolean =>
  [...value].some(character => {
    const code = character.charCodeAt(0);
    return (code < 32 && !(allowLineFeed && code === 10)) || (code >= 127 && code <= 159);
  });
const text = (max = 4096) =>
  Schema.String.check(
    Schema.makeFilter(value =>
      !value.trim() || new TextEncoder().encode(value).byteLength > max || nativeCycleHasControl(value, true)
        ? 'Use nonblank bounded text without control characters.'
        : undefined,
    ),
  );
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const gitObject = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u));
const isGitObject = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
export const nativeCycleAbsolutePath = (value: string): boolean =>
  !nativeCycleHasControl(value) &&
  (value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u.test(value));
const memoryUri = text().check(Schema.isPattern(/^threadnote:\/\/[^\s]+$/u));
const root = Schema.Struct({
  uri: memoryUri,
  memoryId: text(128).check(Schema.isPattern(/^tn_[A-Za-z0-9_-]+$/u)),
  revision: digest,
});
const binding = Schema.Struct({
  bindingId: digest,
  runId: id,
  generation: text(),
  profile: Schema.Literals(['desktop', 'codex-cloud-personal', 'cursor-cloud-personal']),
  team: Schema.optionalKey(id),
});
const refs = Schema.Array(id).check(Schema.isMaxLength(128));
const acceptanceRef = Schema.Struct({id, criterion: text(), requirements: refs, specScenarios: refs});
const phaseSchema = Schema.Struct({
  id,
  definitionHash: digest,
  title: text(256),
  dependsOn: refs,
  allowedPaths: Schema.Array(text()).check(Schema.isBetweenLength(1, 128)),
  acceptanceCriteria: Schema.Array(text()).check(Schema.isBetweenLength(1, 128)),
  safeToMergeReason: text(),
  branch: text(256),
  baseBranch: text(256),
  status: Schema.Literal('pending'),
  acceptanceRefs: Schema.Array(acceptanceRef).check(Schema.isBetweenLength(1, 128)),
});
export const NativeCyclePlanSchema = Schema.Struct({
  format: Schema.Literal('threadnote-native-cycle-plan'),
  version: Schema.Literal(1),
  featureId: id,
  project: id,
  objective: text(),
  delivery: Schema.Literals(['local', 'commit', 'pr']),
  source: Schema.Struct({root, binding, documentHash: digest}),
  spec: Schema.optionalKey(Schema.Unknown),
  decisions: Schema.optionalKey(Schema.Unknown),
  completion: Schema.Unknown,
  phases: Schema.Array(phaseSchema).check(Schema.isBetweenLength(1, 128)),
});
export type NativeCyclePlan = typeof NativeCyclePlanSchema.Type;
const validationSchema = Schema.Struct({
  snapshotTree: gitObject,
  status: Schema.Literal('passed'),
  productState: Schema.Literal('working'),
  checks: Schema.Array(Schema.Struct({command: text(), result: Schema.Literal('passed'), evidence: text()})).check(
    Schema.isBetweenLength(1, 64),
  ),
  acceptance: Schema.Array(
    Schema.Struct({criterion: text(), result: Schema.Literal('passed'), evidence: text()}),
  ).check(Schema.isBetweenLength(1, 128)),
  reviewTree: Schema.optionalKey(gitObject),
  head: Schema.optionalKey(gitObject),
});
export const NativeCycleValidationSchema = validationSchema;
export type NativeCycleValidation = typeof validationSchema.Type;
const watchSchema = Schema.Struct({
  prUrl: text(2048),
  headSha: gitObject,
  state: Schema.Literal('active'),
  stateDir: text(2048),
  consumerKind: Schema.Literals(['worker', 'heartbeat', 'orchestrator']),
  consumerId: text(256),
  evidence: text(),
});
const prSchema = Schema.Struct({
  url: text(2048),
  headSha: gitObject,
  branch: text(256),
  baseBranch: text(256),
  state: Schema.Literals(['open', 'merged']),
});
const deliverySchema = Schema.Struct({
  phaseId: id,
  phaseHash: digest,
  delivery: Schema.Literals(['local', 'commit', 'pr']),
  headSha: gitObject,
  validatedTree: gitObject,
  commitEvidence: Schema.optionalKey(text()),
  pr: Schema.optionalKey(prSchema),
  watch: Schema.optionalKey(watchSchema),
});
const historySchema = Schema.Struct({
  phaseHash: digest,
  head: gitObject,
  tree: gitObject,
  validation: validationSchema,
  delivery: Schema.optionalKey(deliverySchema),
});
const phaseStateSchema = Schema.Struct({
  status: Schema.Literals(['pending', 'active', 'validated', 'published', 'merged', 'stale', 'blocked']),
  phaseHash: digest,
  validation: Schema.optionalKey(validationSchema),
  head: Schema.optionalKey(gitObject),
  tree: Schema.optionalKey(gitObject),
  delivery: Schema.optionalKey(deliverySchema),
  reason: Schema.optionalKey(text()),
  history: Schema.optionalKey(Schema.Array(historySchema).check(Schema.isMaxLength(64))),
});
export const NativeCycleStateSchema = Schema.Struct({
  format: Schema.Literal('threadnote-native-cycle'),
  version: Schema.Literal(1),
  plan: NativeCyclePlanSchema,
  phases: Schema.Record(id, phaseStateSchema),
});
export type NativeCycleState = typeof NativeCycleStateSchema.Type;
function err(message: string): never {
  throw WorkflowAutomationError.make({code: 'invalid-cycle', message});
}
function canonical(v: unknown): string {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.entries(v as Record<string, unknown>)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(',')}}`;
  return err('Value is not canonical JSON.');
}
function isJson(v: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.length <= 4096 && v.every(x => isJson(x, depth + 1));
  if (v && typeof v === 'object')
    return (
      Object.getPrototypeOf(v) === Object.prototype &&
      Object.entries(v).length <= 4096 &&
      Object.values(v).every(x => x === undefined || isJson(x, depth + 1))
    );
  return false;
}
function decode<A>(schema: Schema.ConstraintDecoder<A>, v: unknown, message: string): A {
  try {
    return Schema.decodeUnknownSync(schema, {onExcessProperty: 'error'})(v);
  } catch {
    return err(message);
  }
}
function safePath(p: string): boolean {
  return (
    p.length > 0 &&
    new TextEncoder().encode(p).byteLength <= 4096 &&
    !/[\\:]/u.test(p) &&
    !nativeCycleHasControl(p) &&
    !p.startsWith('/') &&
    !/^[A-Za-z]:/u.test(p) &&
    p.split('/').every((part, i, all) => part !== '.' && part !== '..' && (part !== '' || i === all.length - 1))
  );
}
function validatePlan(p: NativeCyclePlan): void {
  if (
    (p.spec !== undefined && !isJson(p.spec)) ||
    (p.decisions !== undefined && !isJson(p.decisions)) ||
    !isJson(p.completion)
  )
    err('Plan contains non-JSON metadata.');
  if (new TextEncoder().encode(canonical(p)).length > 1_000_000) err('Plan exceeds its canonical byte limit.');
  const ids = new Set(p.phases.map(x => x.id));
  if (ids.size !== p.phases.length) err('Duplicate phase IDs.');
  const acceptanceIds = new Set<string>();
  for (const ph of p.phases) {
    if (new Set(ph.dependsOn).size !== ph.dependsOn.length || ph.dependsOn.some(x => !ids.has(x) || x === ph.id))
      err('Invalid phase dependency.');
    if (ph.allowedPaths.some(x => !safePath(x))) err('Unsafe relative path.');
    if (
      new Set(ph.acceptanceCriteria).size !== ph.acceptanceCriteria.length ||
      ph.acceptanceRefs.length !== ph.acceptanceCriteria.length
    )
      err('Acceptance refs must cover each criterion exactly once.');
    const criteria = new Set<string>();
    for (const ref of ph.acceptanceRefs) {
      if (
        acceptanceIds.has(ref.id) ||
        criteria.has(ref.criterion) ||
        !ph.acceptanceCriteria.includes(ref.criterion) ||
        new Set(ref.requirements).size !== ref.requirements.length ||
        new Set(ref.specScenarios).size !== ref.specScenarios.length
      )
        err('Invalid acceptance references.');
      acceptanceIds.add(ref.id);
      criteria.add(ref.criterion);
    }
  }
  const visiting = new Set<string>(),
    done = new Set<string>();
  const visit = (x: string): void => {
    if (visiting.has(x)) err('Dependency cycle.');
    if (done.has(x)) return;
    visiting.add(x);
    nativeCycleEffectiveParents(p, x).forEach(visit);
    visiting.delete(x);
    done.add(x);
  };
  p.phases.forEach(x => visit(x.id));
}
export function decodeNativeCyclePlan(value: unknown): NativeCyclePlan {
  const p = decode(NativeCyclePlanSchema, value, 'Unsupported or malformed native cycle plan.');
  validatePlan(p);
  return p;
}
export function decodeNativeCycleState(value: unknown): NativeCycleState {
  const omitUndefined = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(omitUndefined)
      : input && typeof input === 'object'
        ? Object.fromEntries(
            Object.entries(input)
              .filter(([, item]) => item !== undefined)
              .map(([key, item]) => [key, omitUndefined(item)]),
          )
        : input;
  const s = decode(NativeCycleStateSchema, omitUndefined(value), 'Malformed native cycle state.');
  validatePlan(s.plan);
  if (canonical(Object.keys(s.phases).sort()) !== canonical(s.plan.phases.map(p => p.id).sort()))
    err('State phase keyset does not match plan.');
  for (const p of s.plan.phases) {
    const r = s.phases[p.id];
    if (r.phaseHash !== nativeCyclePhaseHash(s.plan, p.id)) err('State phase hash is inconsistent.');
    if (
      ['validated', 'published', 'merged'].includes(r.status) &&
      (!r.validation ||
        !r.head ||
        !r.tree ||
        r.validation.snapshotTree !== r.tree ||
        (r.validation.head && r.validation.head !== r.head))
    )
      err('State proof fields are inconsistent.');
    if (r.validation) {
      if (!['validated', 'published', 'merged'].includes(r.status)) err('Inactive phase carries current validation.');
      const criteria = r.validation.acceptance.map(item => item.criterion);
      if (
        new Set(criteria).size !== criteria.length ||
        criteria.length !== p.acceptanceCriteria.length ||
        p.acceptanceCriteria.some(item => !criteria.includes(item))
      )
        err('State acceptance proof is inconsistent.');
    }
    if (
      r.delivery &&
      (!r.validation ||
        r.delivery.phaseId !== p.id ||
        r.delivery.phaseHash !== r.phaseHash ||
        r.delivery.headSha !== r.head ||
        r.delivery.validatedTree !== r.tree)
    )
      err('Delivery receipt is inconsistent.');
    if (r.status === 'merged' && r.delivery?.delivery === 'pr' && r.delivery.pr?.state !== 'merged')
      err('Merged state lacks merge evidence.');
    if (r.delivery && r.delivery.delivery !== s.plan.delivery) err('Delivery mode does not match plan.');
    if (r.delivery?.delivery === 'local' && (r.delivery.pr || r.delivery.watch || r.delivery.commitEvidence))
      err('Local delivery carries unrelated publication fields.');
    if (r.delivery?.delivery === 'commit' && (!r.delivery.commitEvidence?.trim() || r.delivery.pr || r.delivery.watch))
      err('Commit delivery lacks its exact commit evidence.');
    if (r.delivery?.delivery === 'pr') {
      const pr = r.delivery.pr;
      if (!r.delivery.commitEvidence?.trim()) err('PR delivery lacks commit evidence.');
      if (
        !pr ||
        !/^https:\/\//u.test(pr.url) ||
        pr.headSha !== r.delivery.headSha ||
        pr.branch !== p.branch ||
        pr.baseBranch !== p.baseBranch
      )
        err('PR receipt does not match plan metadata.');
      if (
        pr.state === 'open' &&
        (!r.delivery.watch ||
          r.delivery.watch.prUrl !== pr.url ||
          r.delivery.watch.headSha !== pr.headSha ||
          !nativeCycleAbsolutePath(r.delivery.watch.stateDir) ||
          !r.delivery.commitEvidence?.trim())
      )
        err('Open PR receipt lacks matching watch evidence.');
      if (pr.state === 'merged' && r.status !== 'merged') err('Merged receipt has an inconsistent phase status.');
      if (pr.state === 'open' && r.status !== 'published') err('Open PR has an inconsistent phase status.');
    }
    if (r.status === 'merged' && (!r.delivery || s.plan.delivery !== 'pr'))
      err('Merged state requires a merged PR receipt.');
    if (r.status === 'published' && !r.delivery) err('Published state requires a delivery receipt.');
    if (r.status === 'pending' && (r.validation || r.delivery)) err('Pending state carries current proof.');
  }
  return s;
}
export function nativeCyclePhaseHash(plan: NativeCyclePlan, phaseId: string): string {
  const p = plan.phases.find(x => x.id === phaseId);
  if (!p) return err('Unknown phase.');
  const {
    id: key,
    title,
    dependsOn,
    allowedPaths,
    acceptanceCriteria,
    acceptanceRefs,
    safeToMergeReason,
    definitionHash,
  } = p;
  return sha256HexSync(
    `threadnote.native-cycle.phase.v1\n${canonical({objective: plan.objective, delivery: plan.delivery, featureId: plan.featureId, project: plan.project, spec: plan.spec, phase: {id: key, title, dependsOn, allowedPaths, acceptanceCriteria, acceptanceRefs, safeToMergeReason, definitionHash}})}`,
  );
}
export function initializeNativeCycle(value: NativeCyclePlan): NativeCycleState {
  const plan = decodeNativeCyclePlan(value);
  return {
    format: 'threadnote-native-cycle',
    version: 1,
    plan,
    phases: Object.fromEntries(
      plan.phases.map(p => [p.id, {status: 'pending', phaseHash: nativeCyclePhaseHash(plan, p.id)}]),
    ),
  };
}
export type NativeCycleAction = {
  readonly action: 'deliver' | 'implement' | 'complete' | 'blocked';
  readonly phaseId?: string;
  readonly reason?: string;
};
/** Exact branch bindings add stack parents without changing authored material intent. */
export function nativeCycleEffectiveParents(plan: NativeCyclePlan, idValue: string): readonly string[] {
  const selected = plan.phases.find(p => p.id === idValue);
  if (!selected) err('Unknown phase.');
  return plan.phases
    .filter(
      p =>
        selected.dependsOn.includes(p.id) ||
        (p.id !== selected.id && selected.branch !== selected.baseBranch && p.branch === selected.baseBranch),
    )
    .map(p => p.id);
}
export function nativeCycleParentsReady(s: NativeCycleState, idValue: string): boolean {
  // The plan is an admitted bounded DAG. Memoization is confined to this traversal.
  const accepted = new Map<string, boolean>();
  const ready = (id: string): boolean => {
    const cached = accepted.get(id);
    if (cached !== undefined) return cached;
    const phase = s.phases[id];
    const result =
      ['validated', 'published', 'merged'].includes(phase.status) &&
      (s.plan.delivery === 'local' || phase.delivery !== undefined) &&
      nativeCycleEffectiveParents(s.plan, id).every(ready);
    accepted.set(id, result);
    return result;
  };
  return nativeCycleEffectiveParents(s.plan, idValue).every(ready);
}
export function nextNativeCycle(value: NativeCycleState): NativeCycleAction {
  const s = decodeNativeCycleState(value),
    ps = s.plan.phases;
  for (const p of ps)
    if (
      s.phases[p.id].status === 'validated' &&
      s.plan.delivery !== 'local' &&
      !s.phases[p.id].delivery &&
      nativeCycleParentsReady(s, p.id)
    )
      return {action: 'deliver', phaseId: p.id};
  const ready = ps.find(p => ['pending', 'active'].includes(s.phases[p.id].status) && nativeCycleParentsReady(s, p.id));
  if (ready) return {action: 'implement', phaseId: ready.id};
  const stuck = ps.find(p => ['stale', 'blocked'].includes(s.phases[p.id].status));
  if (stuck)
    return {action: 'blocked', phaseId: stuck.id, reason: s.phases[stuck.id].reason ?? 'A phase is stale or blocked.'};
  if (ps.every(p => ['validated', 'published', 'merged'].includes(s.phases[p.id].status))) return {action: 'complete'};
  return {action: 'blocked', reason: 'No eligible phase is available.'};
}
export interface CycleSnapshot {
  readonly head: string;
  readonly tree: string;
  readonly files: readonly string[];
}
export function checkNativeCycleScope(phase: NativeCyclePlan['phases'][number], files: readonly string[]): boolean {
  return files.every(
    f =>
      safePath(f) &&
      phase.allowedPaths.some(a => {
        if (!a.includes('*')) return a.endsWith('/') ? f.startsWith(a) : f === a;
        const regex = new RegExp(
          `^${a
            .split('*')
            .map(x => x.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
            .join('.*')}$`,
          'u',
        );
        return regex.test(f);
      }),
  );
}
export function validateNativeCyclePhase(
  value: NativeCycleState,
  idValue: string,
  snapshot: CycleSnapshot,
  evidence: NativeCycleValidation,
): NativeCycleState {
  const s = decodeNativeCycleState(value),
    r = s.phases[idValue],
    p = s.plan.phases.find(x => x.id === idValue);
  if (!r || !p) err('Unknown phase.');
  if (r.status === 'merged') err('Merged history cannot be rewritten.');
  if (!nativeCycleParentsReady(s, idValue)) err('Reconcile unvalidated dependencies before accepting this phase.');
  const pending = nextNativeCycle(s);
  if (pending.action === 'deliver' && pending.phaseId !== idValue) err('Finish the prior phase delivery first.');
  const v = decode(validationSchema, evidence, 'Invalid validation evidence.');
  if (
    !isGitObject(snapshot.head) ||
    !isGitObject(snapshot.tree) ||
    v.snapshotTree !== snapshot.tree ||
    (v.head && v.head !== snapshot.head) ||
    (v.reviewTree && v.reviewTree !== snapshot.tree) ||
    r.phaseHash !== nativeCyclePhaseHash(s.plan, idValue)
  )
    err('Validation does not match snapshot.');
  if (!checkNativeCycleScope(p, snapshot.files)) err('Changed paths exceed allowed scope.');
  const covered = v.acceptance.map(x => x.criterion);
  if (
    new Set(covered).size !== covered.length ||
    covered.length !== p.acceptanceCriteria.length ||
    p.acceptanceCriteria.some(x => !covered.includes(x))
  )
    err('Acceptance criteria coverage is incomplete.');
  if (r.head === snapshot.head && r.tree === snapshot.tree && canonical(r.validation ?? null) === canonical(v))
    return s;
  return {
    ...s,
    phases: {
      ...s.phases,
      [idValue]: {
        ...r,
        status: 'validated',
        history: withHistory(r),
        validation: v,
        head: snapshot.head,
        tree: snapshot.tree,
        delivery: undefined,
        reason: undefined,
      },
    },
  };
}
export function recordNativeCycleDelivery(value: NativeCycleState, idValue: string, input: unknown): NativeCycleState {
  const s = decodeNativeCycleState(value),
    r = s.phases[idValue];
  if (
    !r ||
    !['validated', 'published', 'merged'].includes(r.status) ||
    !r.validation ||
    r.phaseHash !== nativeCyclePhaseHash(s.plan, idValue)
  )
    err('Phase has no current validation.');
  const d = decode(deliverySchema, input, 'Invalid delivery receipt.');
  if (r.status === 'merged') {
    if (canonical(r.delivery) === canonical(d)) return s;
    err('Merged delivery history cannot be rewritten.');
  }
  if (!nativeCycleParentsReady(s, idValue)) err('Reconcile and deliver effective parents before phase delivery.');
  const pending = nextNativeCycle(s);
  if (pending.action === 'deliver' && pending.phaseId !== idValue) err('Finish the prior phase delivery first.');
  if (
    d.phaseId !== idValue ||
    d.phaseHash !== r.phaseHash ||
    d.delivery !== s.plan.delivery ||
    d.headSha !== r.head ||
    d.validatedTree !== r.tree
  )
    err('Delivery receipt does not match validation.');
  let status: 'published' | 'merged' = 'published';
  if (d.delivery === 'local') {
    if (d.pr || d.watch || d.commitEvidence) err('Unexpected local delivery evidence.');
  } else if (d.delivery === 'commit') {
    if (!d.commitEvidence?.trim() || d.pr || d.watch) err('Commit evidence is required.');
  } else {
    const pr = d.pr,
      p = s.plan.phases.find(x => x.id === idValue)!;
    if (!d.commitEvidence?.trim()) err('PR delivery requires verified commit evidence.');
    if (
      !pr ||
      !/^https:\/\//u.test(pr.url) ||
      pr.headSha !== d.headSha ||
      pr.branch !== p.branch ||
      pr.baseBranch !== p.baseBranch
    )
      err('PR receipt does not match delivery metadata.');
    if (pr.state === 'open') {
      const w = d.watch;
      if (
        !w ||
        w.prUrl !== pr.url ||
        w.headSha !== d.headSha ||
        !nativeCycleAbsolutePath(w.stateDir) ||
        !w.consumerId.trim() ||
        !w.evidence.trim()
      )
        err('Open PR requires a matching watch.');
    } else status = 'merged';
  }
  return {...s, phases: {...s.phases, [idValue]: {...r, status, delivery: d}}};
}
function descendants(plans: readonly NativeCyclePlan[], seeds: readonly string[]) {
  const found = new Set(seeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const plan of plans)
      for (const p of plan.phases)
        if (!found.has(p.id) && nativeCycleEffectiveParents(plan, p.id).some(id => found.has(id))) {
          found.add(p.id);
          changed = true;
        }
  }
  return found;
}
function withHistory(r: NativeCycleState['phases'][string]) {
  if (r.validation && r.head && r.tree) {
    const history = [
      ...(r.history ?? []),
      {
        phaseHash: r.phaseHash,
        head: r.head,
        tree: r.tree,
        validation: r.validation,
        ...(r.delivery ? {delivery: r.delivery} : {}),
      },
    ];
    if (history.length > 64) err('Historical proof capacity is exhausted.');
    return history;
  }
  return r.history;
}
export function invalidateNativeCycle(value: NativeCycleState, idValue: string, reason: string): NativeCycleState {
  const s = decodeNativeCycleState(value);
  if (!reason.trim()) err('Record the concrete invalidation reason.');
  if (!s.phases[idValue]) err('Unknown phase.');
  const affected = descendants([s.plan], [idValue]);
  for (const k of affected) if (s.phases[k].status === 'merged') err('Merged history cannot be rewritten.');
  const phases = {...s.phases};
  for (const k of affected) {
    const old = phases[k];
    phases[k] = {
      ...old,
      status: 'stale',
      history: withHistory(old),
      validation: undefined,
      delivery: undefined,
      reason,
    };
  }
  return {...s, phases};
}
export function reconcileNativeCyclePlan(
  value: NativeCycleState,
  newValue: NativeCyclePlan,
  reason: string,
): {readonly state: NativeCycleState; readonly affected: readonly string[]} {
  const s = decodeNativeCycleState(value),
    plan = decodeNativeCyclePlan(newValue),
    old = s.plan;
  if (
    plan.featureId !== old.featureId ||
    plan.project !== old.project ||
    plan.delivery !== old.delivery ||
    canonical(plan.spec ?? null) !== canonical(old.spec ?? null)
  )
    err('Plan reconciliation changes identity or spec.');
  for (const p of old.phases)
    if (!plan.phases.some(x => x.id === p.id) && s.phases[p.id].status !== 'pending')
      err('Cannot remove evidence-bearing phases.');
  const seeds = old.phases.filter(p => !plan.phases.some(x => x.id === p.id)).map(p => p.id);
  for (const p of plan.phases) {
    const before = old.phases.find(x => x.id === p.id);
    if (!before || nativeCyclePhaseHash(old, p.id) !== nativeCyclePhaseHash(plan, p.id)) seeds.push(p.id);
  }
  const affected = descendants([old, plan], seeds);
  for (const k of affected) if (s.phases[k]?.status === 'merged') err('Merged history cannot be rewritten.');
  const phases: Record<string, NativeCycleState['phases'][string]> = {};
  for (const p of plan.phases) {
    const prior = s.phases[p.id],
      phaseHash = nativeCyclePhaseHash(plan, p.id);
    if (!prior || affected.has(p.id))
      phases[p.id] = {status: 'stale', phaseHash, reason, ...(prior ? {history: withHistory(prior)} : {})};
    else {
      const before = old.phases.find(x => x.id === p.id)!,
        metadataChanged = before.branch !== p.branch || before.baseBranch !== p.baseBranch;
      if (metadataChanged && prior.status === 'merged') err('Merged delivery metadata cannot change.');
      phases[p.id] = {
        ...prior,
        phaseHash,
        ...(metadataChanged && prior.delivery
          ? {
              history: withHistory(prior),
              delivery: undefined,
              status: prior.status === 'merged' ? ('merged' as const) : ('validated' as const),
            }
          : {}),
      };
    }
  }
  return {state: {...s, plan, phases}, affected: [...affected]};
}
