import {Array as EffectArray} from 'effect';
import React from 'react';
import type {
  ManagerDevSkillsIssue,
  ManagerDevSkillsPlan,
  ManagerDevSkillsReadiness,
  ManagerDevSkillsTargetStatus,
} from './contracts.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export function WorkflowCards(): React.ReactElement {
  return (
    <section className="workspace-card" aria-label="Development workflow">
      <header>
        <h3>Specify → Plan → Implement</h3>
      </header>
      <div className="workspace-pad">
        <p>
          Threadnote context, the code graph and verified source inform linked, reviewed artifacts. Implementation
          produces evidence; approved knowledge returns to Threadnote at closeout.
        </p>
        <div className="worksets-member-grid">
          {EffectArray.map(
            [
              ['Specify', 'dev-spec', 'Define behavior, requirements and acceptance scenarios.'],
              ['Plan', 'dev-plan', 'Connect architecture and verifiable implementation phases.'],
              ['Implement', 'dev-cycle', 'Implement, review and validate the approved plan.'],
            ],
            ([label, skill, description]) => (
              <article className="worksets-card" key={skill}>
                <h4>{label}</h4>
                <strong>{skill}</strong>
                <p>{description}</p>
              </article>
            ),
          )}
        </div>
        <p>
          <strong>Support dependency: watch-pr</strong> monitors CI and review feedback and proactively fixes scoped
          issues unless you request monitor-only.
        </p>
        <p>
          These integral workflows are installed during setup and refreshed with Threadnote updates. Installing files
          does not execute development.
        </p>
        <p>
          Choose a workflow in your host’s skill picker. In Codex, documented examples are <code>$dev-spec</code>,{' '}
          <code>$dev-plan</code> and <code>$dev-cycle</code>.
        </p>
      </div>
    </section>
  );
}

export function Issues({issues}: {readonly issues: readonly ManagerDevSkillsIssue[]}): React.ReactElement | null {
  if (!issues.length) return null;
  return (
    <ul>
      {EffectArray.map(issues, (issue, index) => (
        <li key={`${issue.code}:${index}`}>
          <strong>{issue.code}</strong>: {issue.message}
          {issue.path ? (
            <>
              {' '}
              <code>{issue.path}</code>
            </>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function Readiness({readiness}: {readonly readiness?: ManagerDevSkillsReadiness}): React.ReactElement {
  return (
    <section aria-label="Workflow readiness">
      <h4>Workflow readiness</h4>
      <p>File installation and operation prerequisites are assessed separately.</p>
      {EffectArray.map(['planning', 'publication', 'watch'] as const, operation => (
        <div key={operation}>
          <strong>
            {Effect.pipe(operation, __effectPipeInput => {
              const __effectPipeStage0 = Effect.pipe(
                __effectPipeInput,
                EffectString.charAt(0),
                Effect.Option.getOrElse(() => ''),
              );
              const __effectPipeStage1 = Effect.pipe(__effectPipeStage0, EffectString.toUpperCase);
              return __effectPipeStage1;
            }) + Effect.pipe(operation, EffectString.slice(1))}
            : {readiness?.[operation].state ?? 'unchecked'}
          </strong>
          <Issues issues={readiness?.[operation].reasons ?? []} />
        </div>
      ))}
    </section>
  );
}

export function TargetDetails({status}: {readonly status: ManagerDevSkillsTargetStatus}): React.ReactElement {
  return (
    <section className="workspace-card" aria-label="Selected target status">
      <header>
        <h3>Installation and enrollment</h3>
      </header>
      <div className="workspace-pad">
        <dl>
          <dt>Physical installation</dt>
          <dd>{status.installationState}</dd>
          <dt>Enrollment</dt>
          <dd>
            {status.enrollmentState} · {status.enabled ? 'enabled' : 'disabled'}
          </dd>
          <dt>Exact skill root</dt>
          <dd>
            <code>{status.target.skillRoot}</code>
          </dd>
          <dt>Layout</dt>
          <dd>{status.target.layout}</dd>
          <dt>Installed release</dt>
          <dd>{status.installed?.releaseVersion ?? 'No recorded release'}</dd>
          <dt>Installed digest</dt>
          <dd>
            <code>{status.installed?.digest ?? status.installedDigest ?? 'None'}</code>
          </dd>
        </dl>
        <Issues issues={status.issues} />
        {status.lastRefresh ? (
          <div role="status">
            <strong>Last refresh: {status.lastRefresh.state}</strong>
            <p>
              Requested {status.lastRefresh.requestedReleaseVersion} · {status.lastRefresh.attemptedAt}
            </p>
            <code>{status.lastRefresh.requestedBundleDigest}</code>
            <Issues issues={status.lastRefresh.issues} />
          </div>
        ) : (
          <p>No recorded automatic refresh.</p>
        )}
        <Consumers consumers={status.consumers} />
        <Readiness readiness={status.readiness} />
      </div>
    </section>
  );
}

function Consumers({consumers}: {readonly consumers: ManagerDevSkillsPlan['consumers']}): React.ReactElement {
  return (
    <section aria-label="Shared consumers">
      <h4>Shared consumers ({consumers.length})</h4>
      {consumers.length ? (
        <ul>
          {EffectArray.map(consumers, (consumer, index) => (
            <li key={index}>
              {consumer.target.surfaceId} · {consumer.target.profile} · <code>{consumer.home}</code> · installation{' '}
              <code>{consumer.installationRoot}</code>
            </li>
          ))}
        </ul>
      ) : (
        <p>No recorded consumers.</p>
      )}
    </section>
  );
}

export function PreviewDetails({plan}: {readonly plan: ManagerDevSkillsPlan}): React.ReactElement {
  return (
    <section className="workspace-card" aria-label="Mutation preview">
      <header>
        <h3>Preview {plan.action}</h3>
      </header>
      <div className="workspace-pad">
        <p>
          Exact root: <code>{plan.target.skillRoot}</code> · {plan.target.layout} layout
        </p>
        <p>
          Bundle digest: <code>{plan.bundleDigest}</code>
        </p>
        <p>
          Preview digest: <code>{plan.previewDigest}</code>
        </p>
        <Issues issues={plan.issues} />
        <Consumers consumers={plan.consumers} />
        {plan.changes.length ? (
          <div className="worksets-evidence-list">
            {EffectArray.map(plan.changes, change => (
              <details className="worksets-receipt" key={change.path}>
                <summary>
                  <code>{change.path}</code>
                </summary>
                <dl>
                  <dt>Before hash</dt>
                  <dd>
                    <code>{change.beforeHash ?? 'Absent'}</code>
                  </dd>
                  <dt>After hash</dt>
                  <dd>
                    <code>{change.afterHash ?? 'Removed'}</code>
                  </dd>
                </dl>
              </details>
            ))}
          </div>
        ) : (
          <p>No file changes planned.</p>
        )}
        {!plan.canApply ? (
          <p role="alert">This preview cannot be applied. Resolve the reported issues and preview again.</p>
        ) : null}
      </div>
    </section>
  );
}
