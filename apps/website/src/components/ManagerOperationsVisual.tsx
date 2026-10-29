import type {CSSProperties} from 'react';
import type {DocsVisualBlock} from '../content/docsTypes.js';

function flowDelayStyle(delay: string): CSSProperties & {readonly '--flow-delay': string} {
  return {'--flow-delay': delay};
}

function stageDelayStyle(delay: string): CSSProperties & {readonly '--stage-delay': string} {
  return {'--stage-delay': delay};
}

export const managerOperationsVisualKinds = [
  'manager-onboarding',
  'manager-project-lifecycle',
  'manager-prepare-query',
] as const satisfies readonly DocsVisualBlock['visual'][];

type ManagerOperationsVisualProps = {
  kind: DocsVisualBlock['visual'];
};

const captions: Record<
  DocsVisualBlock['visual'],
  {
    description: string;
    eyebrow: string;
    title: string;
  }
> = {
  'manager-onboarding': {
    description:
      'An empty project inventory is not a dead end. Add the first manifest project, then create a Workset that includes it.',
    eyebrow: 'Empty manifest to first Workset',
    title: 'Start with the repository inventory',
  },
  'manager-project-lifecycle': {
    description:
      'Rename updates Workset references in the same manifest transaction. Delete leaves those references visibly unresolved while canonical resources and repository graphs remain intact.',
    eyebrow: 'Truthful project lifecycle',
    title: 'Rename and delete without hidden data loss',
  },
  'manager-prepare-query': {
    description:
      'Definition changes update only the manifest. Prepare is the explicit build action; status and queries read the published ready generation without starting a cold build.',
    eyebrow: 'Definition to evidence',
    title: 'Builds are always explicit',
  },
};

function FlowArrow({delay}: {delay: string}) {
  return (
    <span className="docs-manager-flow__arrow" style={flowDelayStyle(delay)}>
      <span>→</span>
    </span>
  );
}

function OnboardingVisual() {
  return (
    <div className="docs-manager-flow docs-manager-flow--onboarding" aria-hidden="true">
      <div className="docs-manager-flow__toolbar">
        <span>Manager / Worksets</span>
        <span className="docs-manager-flow__tabs">
          <b>Projects</b>
          <span>Worksets</span>
        </span>
      </div>
      <div className="docs-manager-flow__track">
        <div className="docs-manager-flow__stage docs-manager-flow__stage--empty" style={stageDelayStyle('0ms')}>
          <small>Projects · 0</small>
          <strong>No projects yet</strong>
          <span className="docs-manager-flow__action">Add first project</span>
        </div>
        <FlowArrow delay="500ms" />
        <div className="docs-manager-flow__stage" style={stageDelayStyle('850ms')}>
          <small>Project</small>
          <strong>checkout-web</strong>
          <span>main · ~/src/checkout-web</span>
          <i>manifest saved</i>
        </div>
        <FlowArrow delay="1.55s" />
        <div className="docs-manager-flow__stage" style={stageDelayStyle('1.9s')}>
          <small>Workset</small>
          <strong>checkout</strong>
          <span className="docs-manager-flow__chip">checkout-web</span>
          <i>definition ready</i>
        </div>
      </div>
      <div className="docs-manager-flow__receipt">
        <span>01 · add repository identity</span>
        <span>02 · group manifest projects</span>
      </div>
    </div>
  );
}

function ProjectLifecycleVisual() {
  return (
    <div className="docs-manager-flow docs-manager-flow--lifecycle" aria-hidden="true">
      <div className="docs-manager-flow__track">
        <div className="docs-manager-flow__stage" style={stageDelayStyle('0ms')}>
          <small>Rename project</small>
          <strong>
            <s>api</s> <span>→ gateway</span>
          </strong>
          <span>Workset · commerce</span>
          <span className="docs-manager-flow__chip">gateway</span>
        </div>
        <FlowArrow delay="850ms" />
        <div className="docs-manager-flow__stage docs-manager-flow__stage--warning" style={stageDelayStyle('1.2s')}>
          <small>Delete project</small>
          <strong>gateway removed</strong>
          <span>Workset · commerce</span>
          <span className="docs-manager-flow__chip docs-manager-flow__chip--unresolved">! gateway · unresolved</span>
        </div>
        <FlowArrow delay="1.95s" />
        <div className="docs-manager-flow__stage docs-manager-flow__stage--retained" style={stageDelayStyle('2.3s')}>
          <small>Not deleted</small>
          <strong>Canonical data retained</strong>
          <span>✓ threadnote:// resource</span>
          <span>✓ repository graph</span>
        </div>
      </div>
      <div className="docs-manager-flow__receipt docs-manager-flow__receipt--warning">
        <span>Manifest references stay reviewable</span>
        <span>Derived and canonical data are separate</span>
      </div>
    </div>
  );
}

function PrepareQueryVisual() {
  return (
    <div className="docs-manager-flow docs-manager-flow--prepare" aria-hidden="true">
      <div className="docs-manager-flow__track">
        <div className="docs-manager-flow__stage" style={stageDelayStyle('0ms')}>
          <small>Definition</small>
          <strong>commerce</strong>
          <span>api · billing</span>
          <i>manifest only</i>
        </div>
        <FlowArrow delay="500ms" />
        <div className="docs-manager-flow__stage" style={stageDelayStyle('850ms')}>
          <small>Explicit action</small>
          <strong>Prepare</strong>
          <span>2 repositories</span>
          <i className="docs-manager-flow__activity">index · route · bridge</i>
        </div>
        <FlowArrow delay="1.55s" />
        <div className="docs-manager-flow__stage" style={stageDelayStyle('1.9s')}>
          <small>Published generation</small>
          <strong>cgwg_…</strong>
          <span>2 / 2 current</span>
          <i>ready snapshot</i>
        </div>
        <FlowArrow delay="2.6s" />
        <div className="docs-manager-flow__stage" style={stageDelayStyle('2.95s')}>
          <small>Read operations</small>
          <strong>Status · Query</strong>
          <span>bounded evidence</span>
          <i>no cold build</i>
        </div>
      </div>
      <div className="docs-manager-flow__receipt">
        <span>Prepare owns indexing</span>
        <span>Readers use published state</span>
      </div>
    </div>
  );
}

export function ManagerOperationsVisual({kind}: ManagerOperationsVisualProps) {
  const caption = captions[kind];
  const captionId = `docs-${kind}-caption`;
  return (
    <figure className={`docs-manager-workflow docs-manager-workflow--${kind}`} aria-labelledby={captionId}>
      {kind === 'manager-onboarding' ? <OnboardingVisual /> : null}
      {kind === 'manager-project-lifecycle' ? <ProjectLifecycleVisual /> : null}
      {kind === 'manager-prepare-query' ? <PrepareQueryVisual /> : null}
      <figcaption id={captionId}>
        <span>{caption.eyebrow}</span>
        <strong>{caption.title}</strong>
        <p>{caption.description}</p>
      </figcaption>
    </figure>
  );
}
