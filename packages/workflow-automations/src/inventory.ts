/** Native replacement checklist for shipped workflow helper files. */
export const workflowInventoryVersion = 2 as const;

export type WorkflowOwner = 'spec' | 'plan' | 'cycle' | 'watch-pr';

export interface WorkflowFileContract {
  readonly path: `config/agent-skills/${string}/scripts/${string}.py`;
  readonly owner: WorkflowOwner;
  /** CLI subcommands declared by the file; imported helper modules use an empty list. */
  readonly commands: readonly string[];
  /** Local mutable state or outputs native workflow code must account for. */
  readonly mutableLocalState: readonly string[];
  /** Destination route in the native workflow package. */
  readonly nativeRoute: string;
}

const entry = (
  path: WorkflowFileContract['path'],
  owner: WorkflowOwner,
  commands: readonly string[],
  mutableLocalState: readonly string[],
  nativeRoute: string,
): WorkflowFileContract =>
  Object.freeze({
    path,
    owner,
    commands: Object.freeze([...commands]),
    mutableLocalState: Object.freeze([...mutableLocalState]),
    nativeRoute,
  });

export const workflowInventory: readonly WorkflowFileContract[] = Object.freeze([
  entry(
    'config/agent-skills/dev-spec/scripts/dev_spec.py',
    'spec',
    [
      'init',
      'inspect',
      'pin',
      'validate',
      'render',
      'review-packet',
      'acceptance-packet',
      'confirm',
      'save',
      'load',
      'export-plan',
      'diff',
    ],
    ['caller-selected spec drafts, generated artifacts, saved state, receipts, and workflow context'],
    'spec workflow commands',
  ),
  entry(
    'config/agent-skills/dev-spec/scripts/portable_lock.py',
    'spec',
    [],
    ['lock files used by spec helper operations'],
    'spec persistence',
  ),
  entry(
    'config/agent-skills/dev-spec/scripts/spec_closeout.py',
    'spec',
    [],
    ['closeout state and generated outputs'],
    'spec closeout',
  ),
  entry(
    'config/agent-skills/dev-spec/scripts/support.py',
    'spec',
    [],
    ['caller-selected outputs, saved spec state, receipts, workflow context'],
    'shared spec persistence',
  ),
  entry(
    'config/agent-skills/dev-spec/scripts/workflow_transport.py',
    'spec',
    [],
    ['private workflow context and transport state'],
    'shared workflow context',
  ),
  entry(
    'config/agent-skills/dev-plan/scripts/archive_transport.py',
    'plan',
    [],
    ['archive input files'],
    'archive import',
  ),
  entry(
    'config/agent-skills/dev-plan/scripts/closeout.py',
    'plan',
    [],
    ['plan closeout state and outputs'],
    'plan closeout',
  ),
  entry(
    'config/agent-skills/dev-plan/scripts/cloud_closeout.py',
    'plan',
    [],
    ['cloud-publication.json written by preview, approve, and finish flows'],
    'cloud publication workflow',
  ),
  entry(
    'config/agent-skills/dev-plan/scripts/dev_plan.py',
    'plan',
    [
      'inspect',
      'init',
      'pin',
      'from-spec',
      'validate',
      'render',
      'review-packet',
      'save',
      'recover',
      'load',
      'diff',
      'export-dev-cycle',
      'closeout-input',
    ],
    [
      'plan state and receipts; recover rewrites receipt state; load writes imported draft and receipts; caller-selected outputs',
    ],
    'plan workflow commands',
  ),
  entry(
    'config/agent-skills/dev-plan/scripts/portable_lock.py',
    'plan',
    [],
    ['lock files used by plan helper operations'],
    'plan persistence',
  ),
  entry(
    'config/agent-skills/dev-plan/scripts/workflow.py',
    'plan',
    ['validation-input', 'prepare', 'publication-preview', 'publication-approve', 'finish'],
    ['workflow-receipts.json; preparation outputs; final cycle-plan rewrite; cloud publication state'],
    'plan-cycle orchestration',
  ),
  entry(
    'config/agent-skills/dev-plan/scripts/workflow_transport.py',
    'plan',
    [],
    ['private workflow context and transport state'],
    'shared workflow context',
  ),
  entry(
    'config/agent-skills/dev-cycle/scripts/dev_cycle.py',
    'cycle',
    ['snapshot', 'check', 'validate-review'],
    ['snapshot directory, review artifacts, and summary.json'],
    'cycle snapshot and review',
  ),
  entry(
    'config/agent-skills/dev-cycle/scripts/phase_state.py',
    'cycle',
    [
      'validate-plan',
      'next',
      'packet',
      'check-phase',
      'ready',
      'invalidate',
      'record-delivery',
      'learning-packet',
      'publication-ready',
      'closeout-packet',
    ],
    ['plan.json; phase packets; delivery and closeout receipts'],
    'phase state machine',
  ),
  entry(
    'config/agent-skills/watch-pr/scripts/portable_lock.py',
    'watch-pr',
    [],
    ['lock files used by watcher operations'],
    'watcher persistence',
  ),
  entry(
    'config/agent-skills/watch-pr/scripts/watch_pr.py',
    'watch-pr',
    ['start', 'watch', 'drain', 'wait', 'relay', 'ack', 'stop'],
    ['state.json, events.jsonl, inbox and delivery records, satellite.log, and stop marker'],
    'pull request watcher',
  ),
]);
