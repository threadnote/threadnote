/** Frozen scenario coverage catalog. These are contracts, not execution results. */
export const workflowScenarioCatalogVersion = 1 as const;

export type WorkflowScenarioCategory = 'context' | 'capacity' | 'autonomy' | 'design-challenger' | 'watcher';

export interface WorkflowScenario {
  readonly id: string;
  readonly category: WorkflowScenarioCategory;
  readonly description: string;
  readonly expectedInvariants: readonly string[];
  readonly measurements: readonly string[];
}

const scenario = (
  id: string,
  category: WorkflowScenarioCategory,
  description: string,
  expectedInvariants: readonly string[],
  measurements: readonly string[],
): WorkflowScenario =>
  Object.freeze({
    id,
    category,
    description,
    expectedInvariants: Object.freeze([...expectedInvariants]),
    measurements: Object.freeze([...measurements]),
  });

export const workflowScenarios: readonly WorkflowScenario[] = Object.freeze([
  scenario(
    'context-stale-readiness',
    'context',
    'Resume with stale context evidence and verify readiness is recomputed before work proceeds.',
    ['stale evidence cannot satisfy readiness', 'resume preserves bound workflow identity'],
    ['readiness outcome', 'context evidence age class'],
  ),
  scenario(
    'capacity-constrained-context',
    'capacity',
    'Run a bounded task with a constrained context/capacity budget.',
    ['required contract evidence remains available', 'capacity pressure does not silently widen scope'],
    ['context use', 'capacity boundary events'],
  ),
  scenario(
    'autonomy-mechanical-edit',
    'autonomy',
    'Apply a mechanical edit anchored to an exact source location.',
    ['edit stays within declared scope', 'mechanical transformation is reproducible'],
    ['scope adherence', 'rework events'],
  ),
  scenario(
    'autonomy-bounded-edit',
    'autonomy',
    'Complete a bounded multi-file edit with explicit acceptance conditions.',
    ['all accepted paths are declared', 'completion requires acceptance evidence'],
    ['scope adherence', 'acceptance coverage'],
  ),
  scenario(
    'autonomy-high-risk',
    'autonomy',
    'Handle a high-risk change using autonomous implementation authority while applying stronger, justified capacity and quality gates.',
    [
      'authorized implementation can proceed autonomously',
      'only genuinely unauthorized actions block',
      'risk gates cite a concrete capacity or quality concern',
    ],
    ['gate invocation', 'decision path', 'capacity and quality evidence'],
  ),
  scenario(
    'autonomy-infrastructure-failure',
    'autonomy',
    'A tool or CI infrastructure failure interrupts an otherwise authorized implementation.',
    [
      'failure is surfaced with its evidence',
      'infrastructure-only failure does not trigger approval escalation',
      'failed checks do not become success receipts',
    ],
    ['failure classification', 'recovery path', 'unnecessary escalation'],
  ),
  scenario(
    'autonomy-resume',
    'autonomy',
    'Resume after interruption and reconcile existing phase evidence.',
    ['resume is idempotent for unchanged evidence', 'stale receipts are invalidated'],
    ['resume transitions', 'receipt reconciliation'],
  ),
  scenario(
    'autonomy-phase-pr-watch-handoff',
    'autonomy',
    'Carry a phase through PR delivery into watcher handoff.',
    ['phase receipt and PR identity stay bound', 'watch handoff has an explicit owner'],
    ['handoff completeness', 'state transitions'],
  ),
  scenario(
    'challenger-routine-skip',
    'design-challenger',
    'Skip a challenger when the proposed design is routine and no material uncertainty is present.',
    ['routine work does not require a performative alternative', 'skip reason is recorded briefly'],
    ['challenger invocation rate', 'skip rationale presence'],
  ),
  scenario(
    'challenger-material-alternative-wins',
    'design-challenger',
    'Compare a material alternative and choose it when it better satisfies the stated constraints.',
    ['comparison uses the same constraints', 'selected alternative and tradeoff are explicit'],
    ['alternative comparison completeness', 'constraint fit'],
  ),
  scenario(
    'challenger-no-better-alternative',
    'design-challenger',
    'Consider a material alternative but retain the current design when no better option is supported.',
    ['current design is retained with evidence', 'absence of a better alternative is not claimed without comparison'],
    ['comparison completeness', 'decision trace'],
  ),
  scenario(
    'challenger-out-of-scope-rejected',
    'design-challenger',
    'Reject an attractive suggestion that exceeds the authorized scope.',
    ['scope boundary is preserved', 'suggestion is recorded as deferred or rejected'],
    ['scope deviations', 'suggestion disposition'],
  ),
  scenario(
    'challenger-evidence-unavailable',
    'design-challenger',
    'Identify evidence needed for a design comparison that is unavailable.',
    ['missing evidence is stated plainly', 'no invented comparison result is recorded'],
    ['evidence availability', 'decision confidence basis'],
  ),
  scenario(
    'challenger-design-change-invalidates-review',
    'design-challenger',
    'Accept a design change after review and invalidate review evidence tied to the prior design.',
    ['accepted change invalidates stale review', 'new review binds to changed design'],
    ['review invalidations', 're-review completion'],
  ),
  scenario(
    'context-ready-graph-both-workflows',
    'context',
    'Use ready graph evidence to ground both dev-plan and dev-cycle work before investigating unfamiliar relationships.',
    [
      'ready graph is used for both dev-plan and dev-cycle work',
      'unfamiliar discovery waits for ready evidence',
      'fallback is reported only when graph evidence is unavailable',
    ],
    ['graph readiness observed', 'fallback reason'],
  ),
  scenario(
    'context-bounded-first-slice-inspection',
    'context',
    'Inspect only the bounded first slice needed to establish the requested contract.',
    ['inspection stays within initial slice', 'expansion follows an identified evidence gap'],
    ['files inspected', 'scope expansion reason'],
  ),
  scenario(
    'capacity-least-sufficient-model-effort',
    'capacity',
    'Choose the least sufficient model and reasoning effort for the task risk and complexity.',
    ['selection is tied to task needs', 'no automatic escalation without an evidenced need'],
    ['model and effort selection', 'escalation rationale'],
  ),
  scenario(
    'watcher-bootstrap-unresolved-commented-review',
    'watcher',
    'Bootstrap watcher state with an unresolved COMMENTED review thread.',
    ['unresolved review remains visible', 'bootstrap does not acknowledge unseen work'],
    ['bootstrap coverage', 'unresolved thread count'],
  ),
  scenario(
    'watcher-thread-changes-pagination',
    'watcher',
    'Observe review thread changes across paginated source results.',
    ['all pages are consumed', 'thread changes preserve stable identity'],
    ['page traversal', 'thread change detection'],
  ),
  scenario(
    'watcher-crash-replay-ack',
    'watcher',
    'Crash between event capture and acknowledgement, then replay safely.',
    ['unacknowledged events replay', 'acknowledgement is idempotent'],
    ['replay count', 'ack transition'],
  ),
  scenario(
    'watcher-consumer-loss',
    'watcher',
    'Lose a consumer while pending events exist.',
    ['events remain recoverable', 'consumer loss does not erase delivery state'],
    ['pending event retention', 'consumer recovery'],
  ),
  scenario(
    'watcher-rate-limit',
    'watcher',
    'Receive a source rate limit during polling.',
    ['backoff respects source response', 'state remains resumable'],
    ['retry schedule', 'rate limit recovery'],
  ),
  scenario(
    'watcher-head-race',
    'watcher',
    'Observe a source head change while processing a prior head.',
    ['events bind to the observed head', 'new head is not mislabeled as prior result'],
    ['head race handling', 'stale result rejection'],
  ),
  scenario(
    'watcher-unchanged-waits',
    'watcher',
    'Wait across repeated unchanged source snapshots.',
    ['unchanged snapshots do not emit duplicate changes', 'wait remains bounded by requested timeout'],
    ['unchanged wait count', 'duplicate event count'],
  ),
]);
