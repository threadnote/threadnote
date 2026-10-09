import React from 'react';
import type {ManagerGraphReconciliationStatus} from '@threadnote/graph/manager/status';

export function GraphReconciliationProgress(props: {
  readonly status: ManagerGraphReconciliationStatus;
}): React.ReactElement {
  const status = props.status;
  if (status.state !== 'observed') {
    return (
      <section aria-label="Indexed view reconciliation" className="graph-build-card" role="status">
        <header>
          <strong>
            {status.state === 'unavailable' ? 'Reconciliation status unavailable' : 'Reconciliation waiting'}
          </strong>
        </header>
        <p>
          {status.state === 'unavailable'
            ? 'Manager could not observe reconciliation status. The next status check will retry.'
            : status.reason === 'active-build'
              ? 'Waiting for active graph builds before checking missing worktree views.'
              : 'Waiting for graph maintenance before checking missing worktree views.'}
        </p>
      </section>
    );
  }
  const blocked = status.pendingRepositories > 0 && status.blockedRepositories === status.pendingRepositories;
  const label =
    status.pendingRepositories === 0
      ? status.unavailableRepositories > 0
        ? 'Reconciliation partially checked'
        : 'Reconciliation checked'
      : blocked
        ? 'Reconciliation blocked'
        : 'Reconciliation pending';
  return (
    <section aria-label="Indexed view reconciliation" className="graph-build-card" role="status">
      <header>
        <strong>{label}</strong>
        <span>
          Last checked <time dateTime={status.checkedAt}>{new Date(status.checkedAt).toLocaleTimeString()}</time>
        </span>
      </header>
      <p>
        {status.repositoryCount.toLocaleString()} {status.repositoryCount === 1 ? 'repository' : 'repositories'}{' '}
        inventoried · {status.pendingRepositories.toLocaleString()}{' '}
        {status.pendingRepositories === 1 ? 'repository' : 'repositories'} pending
        {status.blockedRepositories > 0
          ? ` · ${status.blockedRepositories.toLocaleString()} ${status.blockedRepositories === 1 ? 'needs' : 'need'} a verified local folder`
          : ''}
        {status.unavailableRepositories > 0
          ? ` · ${status.unavailableRepositories.toLocaleString()} could not be checked`
          : ''}
      </p>
      <p>
        {status.viewCleanupAdvanced
          ? 'Worktree cleanup advanced on the last check.'
          : 'No worktree cleanup progress reported on the last check.'}{' '}
        Manager checks a bounded amount of work each poll; pending does not mean a job is running.
      </p>
      {status.blockedRepositories > 0 ? (
        <p className="graph-build-attention">
          Missing folders without a verified surviving checkout are preserved. Automatic removal needs a verified
          surviving checkout.
        </p>
      ) : null}
      {status.viewsTruncated ? <p>Counts cover the first 32 active views per repository.</p> : null}
    </section>
  );
}
