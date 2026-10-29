import {isInspection, isPreview, isTopicEnrollmentApplied} from '../api/response_guards.js';
import {Array as EffectArray} from 'effect';
import React, {useEffect, useRef, useState} from 'react';
import type {TopicMaintenanceParagraphInput} from '@threadnote/memory/topic-maintenance';
import {api, errorMessage} from '../ui/support.js';
import {MemoryExcerpt, ReviewBadge} from '../review_presentation.js';

interface Inspection {
  readonly status: 'enrolled' | 'not-enrolled';
  readonly sourceKind: 'obsidian';
  readonly targetUri: string;
  readonly project: string;
  readonly contentHash: string;
  readonly body: string;
  readonly paragraphs: readonly string[];
  readonly citation: {readonly id: string; readonly relativePath: string};
}
interface Applied {
  readonly status: 'enrolled' | 'already-enrolled';
  readonly targetUri: string;
}
interface Preview {
  readonly expectedContentHash: string;
  readonly revision: string;
  readonly body: string;
}
interface Decision {
  readonly role: TopicMaintenanceParagraphInput['role'] | '';
  readonly support: TopicMaintenanceParagraphInput['support'] | '';
}
function isDecisionRole(value: string): value is Decision['role'] {
  return value === '' || value === 'descriptive' || value === 'normative' || value === 'historical';
}

function isDecisionSupport(value: string): value is Decision['support'] {
  return value === '' || value === 'direct' || value === 'contextual' || value === 'unresolved';
}

/** Explicit author annotations; no inferred claim roles or automatic enrollment. */
export function TopicEnrollmentPanel({
  uri,
  onChanged,
}: {
  readonly uri: string;
  readonly onChanged?: () => void;
}): React.ReactElement {
  const [opened, setOpened] = useState(false);
  const [inspection, setInspection] = useState<Inspection>();
  const [decisions, setDecisions] = useState<readonly Decision[]>([]);
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [enrolled, setEnrolled] = useState(false);
  const epoch = useRef(0);
  const inFlight = useRef(false);
  useEffect(
    () => () => {
      epoch.current += 1;
    },
    [],
  );
  async function inspect() {
    if (inFlight.current) return;
    const token = ++epoch.current;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setInspection(undefined);
    setPreview(undefined);
    setDecisions([]);
    try {
      const result = await api<Inspection>(
        `/api/attention/topic-enrollment?uri=${encodeURIComponent(uri)}`,
        undefined,
        undefined,
        isInspection,
      );
      if (epoch.current !== token) return;
      if (result.targetUri !== uri || result.sourceKind !== 'obsidian')
        throw new Error('The selected memory changed. Refresh it.');
      setInspection(result);
      setDecisions(EffectArray.map(result.paragraphs, () => ({role: '', support: ''})));
      setEnrolled(result.status === 'enrolled');
    } catch (cause) {
      if (epoch.current === token) setError(errorMessage(cause));
    } finally {
      if (epoch.current === token) {
        setBusy(false);
        inFlight.current = false;
      }
    }
  }
  async function submit(apply: boolean) {
    if (
      !inspection ||
      inFlight.current ||
      (apply && !preview) ||
      EffectArray.some(decisions, item => !item.role || !item.support)
    )
      return;
    const token = ++epoch.current;
    inFlight.current = true;
    setBusy(true);
    setError('');
    const input = {
      paragraphs: EffectArray.map(decisions, item => ({
        role: item.role,
        support: item.support,
        citationIds: item.support === 'unresolved' ? [] : [inspection.citation.id],
      })),
    };
    try {
      const request = {
        action: apply ? 'apply' : 'preview',
        uri: inspection.targetUri,
        project: inspection.project,
        input,
        ...(apply
          ? {approved: true, expectedContentHash: preview!.expectedContentHash, revision: preview!.revision}
          : {}),
      };
      if (apply) {
        await api<Applied>('/api/attention/topic-enrollment', request, undefined, isTopicEnrollmentApplied);
        if (epoch.current !== token) return;
        setEnrolled(true);
        setPreview(undefined);
        onChanged?.();
      } else {
        const result = await api<Preview>('/api/attention/topic-enrollment', request, undefined, isPreview);
        if (epoch.current !== token) return;
        setPreview(result);
      }
    } catch (cause) {
      if (epoch.current === token) {
        setInspection(undefined);
        setDecisions([]);
        setPreview(undefined);
        setError(errorMessage(cause));
      }
    } finally {
      if (epoch.current === token) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <details
      className="review-disclosure"
      onToggle={event => {
        if (event.currentTarget.open && !opened) {
          setOpened(true);
          void inspect();
        }
      }}
    >
      <summary>Topic updates from an Obsidian note</summary>
      <p>
        Enroll an existing private note memory to review future source changes. Choose each paragraph’s role and source
        support.
      </p>
      {busy ? <p role="status">Checking topic enrollment…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {inspection ? (
        <button type="button" disabled={busy} onClick={() => void inspect()}>
          Refresh source access
        </button>
      ) : null}
      {!inspection && !busy ? (
        <button type="button" onClick={() => void inspect()}>
          Check source access
        </button>
      ) : null}
      {enrolled ? (
        <p role="status">This topic is enrolled. Review source changes in Attention.</p>
      ) : inspection ? (
        <>
          <ReviewBadge tone="protected">Private Obsidian note · {inspection.citation.relativePath}</ReviewBadge>
          {EffectArray.map(inspection.paragraphs, (text, ordinal) => (
            <section key={ordinal}>
              <MemoryExcerpt label={`Paragraph ${ordinal + 1}`}>{text}</MemoryExcerpt>
              <label>
                Paragraph role{' '}
                <select
                  aria-label={`Role for paragraph ${ordinal + 1}`}
                  disabled={busy}
                  value={decisions[ordinal]?.role ?? ''}
                  onChange={event => {
                    const role = event.target.value;
                    if (busy || inFlight.current || !isDecisionRole(role)) return;
                    setPreview(undefined);
                    setDecisions(items =>
                      EffectArray.map(items, (item, index) => (index === ordinal ? {...item, role} : item)),
                    );
                  }}
                >
                  <option value="">Choose a role</option>
                  <option value="descriptive">Observed behavior</option>
                  <option value="normative">Policy requirement</option>
                  <option value="historical">Historical decision</option>
                </select>
              </label>
              <label>
                Source support{' '}
                <select
                  aria-label={`Source support for paragraph ${ordinal + 1}`}
                  disabled={busy}
                  value={decisions[ordinal]?.support ?? ''}
                  onChange={event => {
                    const support = event.target.value;
                    if (busy || inFlight.current || !isDecisionSupport(support)) return;
                    setPreview(undefined);
                    setDecisions(items =>
                      EffectArray.map(items, (item, index) => (index === ordinal ? {...item, support} : item)),
                    );
                  }}
                >
                  <option value="">Choose source support</option>
                  <option value="direct">Directly supported</option>
                  <option value="contextual">Context only</option>
                  <option value="unresolved">Needs review</option>
                </select>
              </label>
            </section>
          ))}
          {preview ? (
            <>
              <MemoryExcerpt label="Topic to enroll">{preview.body}</MemoryExcerpt>
              <p>
                Policy and historical paragraphs stay protected. Future updates require a separate review and approval.
              </p>
              <button type="button" disabled={busy} onClick={() => void submit(true)}>
                Approve topic enrollment
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy || !decisions.length || EffectArray.some(decisions, item => !item.role || !item.support)}
              onClick={() => void submit(false)}
            >
              Preview topic enrollment
            </button>
          )}
        </>
      ) : null}
    </details>
  );
}
