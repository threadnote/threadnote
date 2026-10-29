import {
  isManagerTopicExpansionInspection,
  isManagerTopicExpansionInspectionOrManagerTopicExpansionPreviewOrManagerTopicExpansionApplied,
} from '../api/response_guards.js';
import {Array as EffectArray} from 'effect';
import React, {useEffect, useRef, useState} from 'react';
import {Schema} from 'effect';
import {
  TOPIC_EXPANSION_KINDS,
  TOPIC_EXPANSION_PROVENANCES,
  topicExpansionPath,
} from '@threadnote/memory/topic-maintenance-expansion';
import {api, errorMessage, ManagerApiError} from '../ui/support.js';
import {MemoryBody} from '../detail_modal.js';
import {MemoryExcerpt, ReviewBadge, ReviewNotice} from '../review_presentation.js';
import {isManagerTopicExpansionRecovery} from './topic_expansion_contracts.js';
import type {
  ManagerTopicExpansionRecovery,
  ManagerTopicExpansionApplied,
  ManagerTopicExpansionInspection,
  ManagerTopicExpansionPreview,
  ManagerTopicExpansionSelection,
} from './topic_expansion_contracts.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

export function TopicExpansionPanel({
  uri,
  project,
  onChanged,
  onPrepareGraph,
}: {
  readonly uri: string;
  readonly project: string;
  readonly onChanged?: () => void;
  readonly onPrepareGraph?: () => void;
}): React.ReactElement {
  const [opened, setOpened] = useState(false);
  const [inspection, setInspection] = useState<ManagerTopicExpansionInspection>();
  const [discovery, setDiscovery] = useState<ManagerTopicExpansionInspection>();
  const [seeds, setSeeds] = useState<readonly string[]>([]);
  const [direction, setDirection] = useState<'outgoing' | 'incoming' | 'both'>('outgoing');
  const [kinds, setKinds] = useState<ManagerTopicExpansionSelection['kinds']>(['imports', 'depends_on', 'configures']);
  const [provenances, setProvenances] = useState<ManagerTopicExpansionSelection['provenances']>([
    'declared',
    'resolved',
  ]);
  const [minConfidence, setMinConfidence] = useState(0.8);
  const [nodeLimit, setNodeLimit] = useState(32);
  const [edgeLimit, setEdgeLimit] = useState(64);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [configurationChoices, setConfigurationChoices] = useState<readonly string[]>([]);
  const [configurationPaths, setConfigurationPaths] = useState<readonly string[]>([]);
  const [configurationPath, setConfigurationPath] = useState('');
  const [preview, setPreview] = useState<ManagerTopicExpansionPreview>();
  const [approved, setApproved] = useState(false);
  const [recovery, setRecovery] = useState<
    ManagerTopicExpansionRecovery & {readonly selection: ManagerTopicExpansionSelection}
  >();
  const [restartApproved, setRestartApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const epoch = useRef(0);
  const inFlight = useRef<number | undefined>(undefined);
  useEffect(() => {
    epoch.current += 1;
    inFlight.current = undefined;
    setInspection(undefined);
    setDiscovery(undefined);
    setSeeds([]);
    setSelected([]);
    setConfigurationChoices([]);
    setConfigurationPaths([]);
    setPreview(undefined);
    setApproved(false);
    setError('');
    setNotice('');
    setBusy(false);
    setOpened(false);
    setRecovery(undefined);
    setRestartApproved(false);
    return () => {
      epoch.current += 1;
    };
  }, [uri, project]);
  const current = inspection?.targetUri === uri && inspection.project === project ? inspection : undefined;
  const exactPreview = preview?.targetUri === uri && preview.project === project ? preview : undefined;
  const validBounds =
    Number.isInteger(nodeLimit) &&
    nodeLimit >= 1 &&
    nodeLimit <= 64 &&
    Number.isInteger(edgeLimit) &&
    edgeLimit >= 1 &&
    edgeLimit <= 128 &&
    minConfidence >= 0 &&
    minConfidence <= 1 &&
    kinds.length > 0 &&
    provenances.length > 0;
  const selection = (): ManagerTopicExpansionSelection => ({
    version: 1,
    depth: 1,
    configDigest: current!.configDigest,
    seeds: [...seeds].sort(),
    direction,
    kinds: [...kinds].sort(),
    provenances: [...provenances].sort(),
    minConfidence,
    nodeLimit,
    edgeLimit,
    selectedNodeIds: [...selected].sort(),
    configurationPaths: [...configurationPaths].sort(),
  });
  function invalidate(neighborhood = false) {
    epoch.current += 1;
    setPreview(undefined);
    setApproved(false);
    setNotice('');
    setError('');
    setRecovery(undefined);
    setRestartApproved(false);
    if (neighborhood) {
      setDiscovery(undefined);
      setSelected([]);
    }
  }
  function choose<Value extends string>(values: readonly Value[], id: Value, checked: boolean): Value[] {
    return checked ? [...new Set([...values, id])] : EffectArray.filter(values, value => value !== id);
  }
  async function request(action: 'inspect' | 'discover' | 'preview' | 'apply' | 'restart') {
    if (
      inFlight.current !== undefined ||
      (action !== 'inspect' && (!current || !validBounds)) ||
      (action === 'apply' && (!exactPreview || !approved)) ||
      (action === 'restart' && (!recovery || !restartApproved))
    )
      return;
    if (action === 'preview' && !selected.length && !configurationPaths.length) return;
    const token = ++epoch.current;
    inFlight.current = token;
    setBusy(true);
    setError('');
    setNotice('');
    setApproved(false);
    setRestartApproved(false);
    if (action !== 'restart') setRecovery(undefined);
    if (action !== 'apply') setPreview(undefined);
    try {
      const result =
        action === 'inspect'
          ? await api<ManagerTopicExpansionInspection>(
              `/api/attention/topic-expansion?uri=${encodeURIComponent(uri)}&project=${encodeURIComponent(project)}`,
              undefined,
              undefined,
              isManagerTopicExpansionInspection,
            )
          : await api<ManagerTopicExpansionInspection | ManagerTopicExpansionPreview | ManagerTopicExpansionApplied>(
              '/api/attention/topic-expansion',
              {
                action,
                uri,
                project,
                selection: action === 'restart' ? recovery!.selection : selection(),
                ...(action === 'apply'
                  ? {revision: exactPreview!.revision, approvalDigest: exactPreview!.approvalDigest, approved: true}
                  : action === 'restart'
                    ? {revision: recovery!.revision, approvalDigest: recovery!.approvalDigest, approved: true}
                    : {}),
              },
              undefined,
              isManagerTopicExpansionInspectionOrManagerTopicExpansionPreviewOrManagerTopicExpansionApplied,
            );
      if (epoch.current !== token) return;
      if (result.targetUri !== uri || ('project' in result && result.project !== project))
        throw new Error('The selected topic or project changed. Inspect it again.');
      if (result.status === 'ready') {
        if (action === 'inspect') {
          setInspection(result);
          setDiscovery(undefined);
          setSeeds([]);
          setSelected([]);
          setConfigurationChoices([]);
          setConfigurationPaths([]);
        } else {
          setDiscovery(result);
          setSelected([]);
        }
      } else if (result.status === 'preview') {
        setPreview(result);
        setRecovery(undefined);
      } else {
        setPreview(undefined);
        setInspection(undefined);
        setDiscovery(undefined);
        setSelected([]);
        setRecovery(undefined);
        setNotice(
          result.status === 'already-expanded'
            ? 'This exact dependency selection was already saved.'
            : 'The reviewed dependency scope was saved. Topic text and protected paragraphs are preserved.',
        );
        onChanged?.();
      }
    } catch (cause) {
      if (epoch.current === token) {
        setError(errorMessage(cause));
        setPreview(undefined);
        setApproved(false);
        setRestartApproved(false);
        if (
          action === 'apply' &&
          exactPreview &&
          Schema.is(ManagerApiError)(cause) &&
          isManagerTopicExpansionRecovery(cause.recovery) &&
          cause.recovery.targetUri === uri &&
          cause.recovery.project === project &&
          cause.recovery.revision === exactPreview.revision &&
          cause.recovery.approvalDigest === exactPreview.approvalDigest
        )
          setRecovery({...cause.recovery, selection: exactPreview.selection});
        if (action === 'discover') {
          setDiscovery(undefined);
          setSelected([]);
        }
      }
    } finally {
      if (inFlight.current === token) inFlight.current = undefined;
      if (epoch.current === token) setBusy(false);
    }
  }
  return (
    <details
      className="review-disclosure"
      onToggle={event => {
        if (event.currentTarget.open && !opened) {
          setOpened(true);
          void request('inspect');
        }
      }}
    >
      <summary>Review code dependency scope</summary>
      <p>
        Add only the source dependencies or configuration files you explicitly review. Topic text, policy and historical
        paragraphs stay protected.
      </p>
      {busy ? <p role="status">Checking selected source scope…</p> : null}
      {notice ? (
        <ReviewNotice tone="proposal" title="Dependency scope saved">
          {notice}
        </ReviewNotice>
      ) : null}
      {error ? (
        <ReviewNotice
          tone="warning"
          role="alert"
          title={recovery ? 'Dependency approval expired' : 'Source scope unavailable'}
        >
          {error}
        </ReviewNotice>
      ) : null}
      {recovery ? (
        <section aria-label="Expired dependency approval recovery">
          <p>
            The expired approval can be replaced with a fresh review. Nothing is applied until you approve the new full
            preview.
          </p>
          <label className="review-confirmation">
            <input
              type="checkbox"
              checked={restartApproved}
              disabled={busy}
              onChange={event => {
                if (inFlight.current === undefined) setRestartApproved(event.target.checked);
              }}
            />
            Replace the expired approval with a fresh dependency review.
          </label>
          <button type="button" disabled={busy || !restartApproved} onClick={() => void request('restart')}>
            Start fresh dependency review
          </button>
        </section>
      ) : null}
      {onPrepareGraph ? (
        <button type="button" disabled={busy} onClick={onPrepareGraph}>
          Open project graph controls
        </button>
      ) : null}
      <button type="button" disabled={busy} onClick={() => void request('inspect')}>
        {current ? 'Inspect scope again' : 'Inspect prepared project scope'}
      </button>
      {current ? (
        <>
          <div className="review-badge-row">
            <ReviewBadge tone="info">Code sources · {project}</ReviewBadge>
            <ReviewBadge tone="warning">One-hop scope only</ReviewBadge>
            <ReviewBadge tone="protected">Policy &amp; history protected</ReviewBadge>
          </div>
          <p>{current.warning}</p>
          <p>{current.currentScope.length} additional sources are already declared.</p>
          <fieldset disabled={busy}>
            <legend>Start from declared sources</legend>
            {EffectArray.map(current.seeds, seed => (
              <label key={seed.id} className="review-confirmation">
                <input
                  type="checkbox"
                  checked={seeds.includes(seed.id)}
                  onChange={event => {
                    if (inFlight.current !== undefined) return;
                    invalidate(true);
                    setSeeds(choose(seeds, seed.id, event.target.checked));
                  }}
                />
                <span>
                  {seed.label} <small>{seed.path}</small>
                </span>
                <ReviewBadge>{seed.kind}</ReviewBadge>
              </label>
            ))}
            {!current.seeds.length ? (
              <p>No exact declared graph seeds are available. You can select configuration files explicitly.</p>
            ) : null}
          </fieldset>
          <details className="review-disclosure">
            <summary>Neighborhood filters and limits</summary>
            <label>
              Direction{' '}
              <select
                aria-label="Dependency direction"
                disabled={busy}
                value={direction}
                onChange={event => {
                  if (inFlight.current !== undefined) return;
                  const selectedDirection = event.target.value;
                  if (
                    selectedDirection !== 'outgoing' &&
                    selectedDirection !== 'incoming' &&
                    selectedDirection !== 'both'
                  )
                    return;
                  invalidate(true);
                  setDirection(selectedDirection);
                }}
              >
                <option value="outgoing">Dependencies used by the source</option>
                <option value="incoming">Sources that depend on it</option>
                <option value="both">Both directions</option>
              </select>
            </label>
            <fieldset disabled={busy}>
              <legend>Relationships to inspect</legend>
              {EffectArray.map(TOPIC_EXPANSION_KINDS, kind => (
                <label key={kind} className="review-confirmation">
                  <input
                    type="checkbox"
                    checked={kinds.includes(kind)}
                    onChange={event => {
                      if (inFlight.current !== undefined) return;
                      invalidate(true);
                      setKinds(choose(kinds, kind, event.target.checked));
                    }}
                  />
                  {Effect.pipe(kind, EffectString.replaceAll('_', ' '))}
                </label>
              ))}
            </fieldset>
            <fieldset disabled={busy}>
              <legend>Evidence types</legend>
              {EffectArray.map(TOPIC_EXPANSION_PROVENANCES, provenance => (
                <label key={provenance} className="review-confirmation">
                  <input
                    type="checkbox"
                    checked={provenances.includes(provenance)}
                    onChange={event => {
                      if (inFlight.current !== undefined) return;
                      invalidate(true);
                      setProvenances(choose(provenances, provenance, event.target.checked));
                    }}
                  />
                  {provenance}
                  {!['declared', 'resolved'].includes(provenance) ? ' · suggestions only' : ''}
                </label>
              ))}
            </fieldset>
            <p>
              Only declared or resolved relationships can support a dependency addition. Other links remain advisory.
            </p>
            <label>
              Minimum confidence{' '}
              <input
                aria-label="Dependency minimum confidence"
                type="number"
                min={0}
                max={1}
                step={0.05}
                disabled={busy}
                value={minConfidence}
                onChange={event => {
                  if (inFlight.current !== undefined) return;
                  invalidate(true);
                  setMinConfidence(Number(event.target.value));
                }}
              />
            </label>
            <label>
              Source limit{' '}
              <input
                aria-label="Dependency source limit"
                type="number"
                min={1}
                max={64}
                disabled={busy}
                value={nodeLimit}
                onChange={event => {
                  if (inFlight.current !== undefined) return;
                  invalidate(true);
                  setNodeLimit(Number(event.target.value));
                }}
              />
            </label>
            <label>
              Relationship limit{' '}
              <input
                aria-label="Dependency relationship limit"
                type="number"
                min={1}
                max={128}
                disabled={busy}
                value={edgeLimit}
                onChange={event => {
                  if (inFlight.current !== undefined) return;
                  invalidate(true);
                  setEdgeLimit(Number(event.target.value));
                }}
              />
            </label>
          </details>
          <button
            type="button"
            disabled={busy || !seeds.length || !validBounds}
            onClick={() => void request('discover')}
          >
            Find one-hop sources
          </button>
          {discovery?.choices ? (
            <section className="topic-source-evidence" aria-label="Dependency choices">
              <h4>Choose additions to this topic</h4>
              <ReviewBadge tone="info">Requested one-hop neighborhood evaluated</ReviewBadge>
              <p>
                {EffectOption.getOrUndefined(
                  EffectOption.map(EffectOption.fromNullishOr(discovery.coverage), __effectArrayReceiver =>
                    EffectArray.reduce(__effectArrayReceiver, 0, (sum, read) => sum + read.visitedNodes),
                  ),
                ) ?? 0}{' '}
                sources and{' '}
                {EffectOption.getOrUndefined(
                  EffectOption.map(EffectOption.fromNullishOr(discovery.coverage), __effectArrayReceiver =>
                    EffectArray.reduce(__effectArrayReceiver, 0, (sum, read) => sum + read.inspectedEdges),
                  ),
                ) ?? 0}{' '}
                relationships evaluated completely within the requested limits.
              </p>
              {EffectArray.map(discovery.choices.eligible, choice => (
                <label key={choice.id} className="review-confirmation">
                  <input
                    type="checkbox"
                    checked={selected.includes(choice.id)}
                    disabled={busy}
                    onChange={event => {
                      if (inFlight.current !== undefined) return;
                      invalidate();
                      setSelected(choose(selected, choice.id, event.target.checked));
                    }}
                  />
                  <span>{choice.path}</span>
                  <ReviewBadge tone={selected.includes(choice.id) ? 'proposal' : 'neutral'}>
                    {selected.includes(choice.id) ? 'Selected addition' : 'Not selected'}
                  </ReviewBadge>
                </label>
              ))}
              {!discovery.choices.eligible.length ? (
                <p>No eligible dependency additions were found in this exact scope.</p>
              ) : null}
              <p>{discovery.choices.omissions.length} relationships or choices were omitted from this selection.</p>
            </section>
          ) : null}
          <fieldset disabled={busy}>
            <legend>Explicit configuration files</legend>
            <p>Use exact repository-relative file paths. Configuration selections do not imply graph relationships.</p>
            <label>
              Configuration file{' '}
              <input
                aria-label="Configuration file path"
                placeholder="config/app.json"
                value={configurationPath}
                onChange={event => {
                  if (inFlight.current !== undefined) return;
                  invalidate();
                  setConfigurationPath(event.target.value);
                }}
              />
            </label>
            <button
              type="button"
              disabled={!topicExpansionPath(configurationPath) || busy}
              onClick={() => {
                if (inFlight.current !== undefined || !topicExpansionPath(configurationPath)) return;
                invalidate();
                setConfigurationChoices([...new Set([...configurationChoices, configurationPath])]);
                setConfigurationPath('');
              }}
            >
              Add file choice
            </button>
            {EffectArray.map(configurationChoices, path => (
              <label key={path} className="review-confirmation">
                <input
                  type="checkbox"
                  checked={configurationPaths.includes(path)}
                  onChange={event => {
                    if (inFlight.current !== undefined) return;
                    invalidate();
                    setConfigurationPaths(choose(configurationPaths, path, event.target.checked));
                  }}
                />
                <span>{path}</span>
                <ReviewBadge tone="protected">Configuration</ReviewBadge>
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            disabled={busy || !!error || !validBounds || (!selected.length && !configurationPaths.length)}
            onClick={() => void request('preview')}
          >
            Preview selected additions
          </button>
          {exactPreview ? (
            <section className="review-final-document" aria-label="Exact dependency expansion preview">
              <h4>Review the selected additions</h4>
              {exactPreview.operation ? (
                <ReviewNotice tone="proposal" title="Fresh dependency review">
                  The expired approval was replaced. Review this full preview and approve it separately.
                </ReviewNotice>
              ) : null}
              <ReviewBadge tone="proposal">{exactPreview.additions.length} explicit additions</ReviewBadge>
              {EffectArray.map(exactPreview.additions, addition => (
                <p key={`${addition.kind}:${addition.ref}`}>
                  <ReviewBadge tone={addition.kind === 'configuration' ? 'protected' : 'proposal'}>
                    {addition.kind}
                  </ReviewBadge>{' '}
                  {addition.path}
                </p>
              ))}
              <MemoryExcerpt label="Topic text preserved">{exactPreview.body}</MemoryExcerpt>
              <details className="review-disclosure">
                <summary>Full proposed memory and metadata</summary>
                <MemoryBody content={exactPreview.content} />
                <ul>
                  {EffectArray.map(exactPreview.metadataDiff, diff => (
                    <li key={diff.field}>
                      {Effect.pipe(diff.field, EffectString.startsWith('code_citation:'))
                        ? 'Retained source citation added'
                        : diff.field === 'topic_maintenance'
                          ? 'Declared source scope updated'
                          : 'Provenance updated'}
                    </li>
                  ))}
                </ul>
              </details>
              <label className="review-confirmation">
                <input
                  type="checkbox"
                  checked={approved}
                  disabled={busy}
                  onChange={event => {
                    if (inFlight.current === undefined) setApproved(event.target.checked);
                  }}
                />
                I reviewed these exact additions and the full proposed memory.
              </label>
              <button type="button" disabled={busy || !approved} onClick={() => void request('apply')}>
                Approve dependency scope
              </button>
              <details className="review-disclosure">
                <summary>Selection identifiers and verification</summary>
                <p>Revision: {exactPreview.revision}</p>
                <p>Approval checksum: {exactPreview.approvalDigest}</p>
                {EffectArray.map(exactPreview.additions, addition => (
                  <p key={addition.ref}>
                    {addition.ref} · {addition.citationId}
                  </p>
                ))}
                {EffectArray.map(exactPreview.omissions, (omission, index) => (
                  <p key={index}>
                    {omission.kind}: {omission.id}
                  </p>
                ))}
              </details>
            </section>
          ) : null}
        </>
      ) : null}
    </details>
  );
}
