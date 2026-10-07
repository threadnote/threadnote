import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  CONTEXT_BRIEF_MODES,
  CONTEXT_BRIEF_MAXIMUM_CODE_REFS,
  CONTEXT_BRIEF_MAXIMUM_ESTIMATED_TOKENS,
  CONTEXT_BRIEF_MINIMUM_ESTIMATED_TOKENS,
  parseContextBriefCodeRefs,
} from '@threadnote/context/types';
import type {
  ContextBriefFollowUpV1,
  ContextBriefDetail,
  ContextBriefMemoryEvidenceV1,
  ContextBriefMode,
  ContextBriefV1,
  ProjectedContextBriefV1,
} from '@threadnote/context/types';
import type {
  ManagerContextConnectionsResponse,
  ManagerContextReadResponse,
  ManagerRecallFeedbackResponse,
  ManagerRecallResponse,
  ManagerRecallResult,
} from '@threadnote/manager/context/contracts';
import type {RecallFeedbackAction} from '@threadnote/recall/feedback';
import type {ManagerMemoryRelationsResponse} from '@threadnote/manager/memory/contracts';
import type {MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import {MEMORY_RELATION_TYPES, type MemoryRelation} from '@threadnote/memory/document';
import {MANAGER_CONTEXT_RECALL_PAGE_SIZE_DEFAULT, projectManagerRecallPage} from '@threadnote/manager/context/paging';
import {api, errorMessage} from '@threadnote/manager/ui/support';
import type {ManagerWorksetCatalog, ManagerWorksetPrepareJob} from '@threadnote/manager/workset/contracts';
import {ValuePanel} from '../value_view.js';

type ContextWorkspaceView = 'brief' | 'recall' | 'value';
type ContextScopeKind = 'repository' | 'workset';
const CONTEXT_WORKSET_RECOVERY_POLL_MILLISECONDS = 750;
const CONTEXT_WORKSET_RECOVERY_MAXIMUM_POLLS = 800;

interface BriefRunOverrides {
  readonly codeRefs?: readonly string[];
  readonly mode?: ContextBriefMode;
  readonly task?: string;
  readonly workset?: string;
}

interface BriefRequestSnapshot {
  readonly body: {
    readonly budgetTokens: number;
    readonly callerCwd?: string;
    readonly codeRefs: readonly string[];
    readonly detail?: ContextBriefDetail;
    readonly mode: ContextBriefMode;
    readonly project?: string;
    readonly task: string;
    readonly workset?: string;
  };
  readonly scope:
    {readonly callerCwd: string; readonly kind: 'repository'} | {readonly kind: 'workset'; readonly workset: string};
}

interface ContextPanelProps {
  readonly projectOptions?: readonly string[];
  readonly refreshGeneration?: number;
}

export function ContextPanel(props: ContextPanelProps): React.ReactElement {
  const [view, setView] = useState<ContextWorkspaceView>('brief');
  const [scopeKind, setScopeKind] = useState<ContextScopeKind>('repository');
  const [callerCwd, setCallerCwd] = useState('');
  const [workset, setWorkset] = useState('');
  const [project, setProject] = useState('');
  const [catalog, setCatalog] = useState<ManagerWorksetCatalog>();
  const [catalogError, setCatalogError] = useState('');
  const [task, setTask] = useState('');
  const [mode, setMode] = useState<ContextBriefMode>('brief');
  const [detail, setDetail] = useState<ContextBriefDetail>('compact');
  const [budgetTokens, setBudgetTokens] = useState(1_250);
  const [codeRefsText, setCodeRefsText] = useState('');
  const [brief, setBrief] = useState<ProjectedContextBriefV1>();
  const [briefRequestSnapshot, setBriefRequestSnapshot] = useState<BriefRequestSnapshot>();
  const [briefBusy, setBriefBusy] = useState(false);
  const [briefError, setBriefError] = useState('');
  const [graphRecoveryBusy, setGraphRecoveryBusy] = useState(false);
  const [graphRecoveryError, setGraphRecoveryError] = useState('');
  const [graphRecoveryNotice, setGraphRecoveryNotice] = useState('');
  const [recallQuery, setRecallQuery] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [recall, setRecall] = useState<ManagerRecallResponse>();
  const [recallPage, setRecallPage] = useState(0);
  const [recallBusy, setRecallBusy] = useState(false);
  const [recallError, setRecallError] = useState('');
  const [feedbackByUri, setFeedbackByUri] = useState<Readonly<Record<string, RecallFeedbackAction>>>({});
  const [feedbackBusy, setFeedbackBusy] = useState('');
  const [feedbackError, setFeedbackError] = useState('');
  const [readResult, setReadResult] = useState<ManagerContextReadResponse>();
  const [readBusy, setReadBusy] = useState(false);
  const [readError, setReadError] = useState('');
  const [readerView, setReaderView] = useState<'connections' | 'content'>('content');
  const [connections, setConnections] = useState<ManagerContextConnectionsResponse>();
  const [connectionsBusy, setConnectionsBusy] = useState(false);
  const [connectionsError, setConnectionsError] = useState('');
  const [relationsBusy, setRelationsBusy] = useState(false);
  const [relationsError, setRelationsError] = useState('');
  const briefRequest = useRef<AbortController>(undefined);
  const graphRecoveryRequest = useRef<AbortController>(undefined);
  const recallRequest = useRef<AbortController>(undefined);
  const feedbackRequest = useRef<AbortController>(undefined);
  const readRequest = useRef<AbortController>(undefined);
  const connectionsRequest = useRef<AbortController>(undefined);
  const relationsRequest = useRef<AbortController>(undefined);
  const readerNavigationRevision = useRef(0);
  const codeRefs = useMemo(() => parseCodeRefs(codeRefsText), [codeRefsText]);
  const tooManyCodeRefs = codeRefs.length > CONTEXT_BRIEF_MAXIMUM_CODE_REFS;
  const codeRefsError = useMemo(() => {
    try {
      parseContextBriefCodeRefs(codeRefs);
      return '';
    } catch (cause) {
      return errorMessage(cause);
    }
  }, [codeRefs]);
  const invalidBudget =
    !Number.isSafeInteger(budgetTokens) ||
    budgetTokens < CONTEXT_BRIEF_MINIMUM_ESTIMATED_TOKENS ||
    budgetTokens > CONTEXT_BRIEF_MAXIMUM_ESTIMATED_TOKENS;
  const memoryProjectOptions = useMemo(
    () => [...new Set([...(props.projectOptions ?? []), ...(catalog?.projects.map(item => item.name) ?? [])])],
    [catalog?.projects, props.projectOptions],
  );

  useEffect(
    () => () => {
      briefRequest.current?.abort();
      graphRecoveryRequest.current?.abort();
      recallRequest.current?.abort();
      feedbackRequest.current?.abort();
      readRequest.current?.abort();
      connectionsRequest.current?.abort();
      relationsRequest.current?.abort();
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    void api<ManagerWorksetCatalog>('/api/worksets', undefined, {signal: controller.signal})
      .then(next => {
        if (controller.signal.aborted) return;
        setCatalog(next);
        setCatalogError('');
      })
      .catch(cause => {
        if (!controller.signal.aborted) setCatalogError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [props.refreshGeneration]);

  useEffect(() => {
    if (!catalog) return;
    const repositoryAvailable = !callerCwd || catalog.projects.some(item => item.path === callerCwd);
    const worksetAvailable = !workset || catalog.definitions.some(item => item.name === workset);
    if (!repositoryAvailable) setCallerCwd('');
    if (!worksetAvailable) setWorkset('');
    if (scopeKind === 'repository' ? !repositoryAvailable : !worksetAvailable) setScope(scopeKind);
  }, [callerCwd, catalog, scopeKind, workset]);

  async function runBrief(overrides: BriefRunOverrides = {}): Promise<void> {
    const nextTask = overrides.task ?? task;
    const nextMode = overrides.mode ?? mode;
    const nextCodeRefs = overrides.codeRefs ?? codeRefs;
    const nextWorkset = overrides.workset ?? workset;
    const nextScopeKind = overrides.workset === undefined ? scopeKind : 'workset';
    if (
      !nextTask.trim() ||
      invalidBudget ||
      parseCodeRefs(nextCodeRefs.join('\n')).length > CONTEXT_BRIEF_MAXIMUM_CODE_REFS ||
      (nextScopeKind === 'repository' ? !callerCwd.trim() : !nextWorkset.trim())
    )
      return;
    graphRecoveryRequest.current?.abort();
    graphRecoveryRequest.current = undefined;
    setGraphRecoveryBusy(false);
    setGraphRecoveryError('');
    setGraphRecoveryNotice('');
    if (overrides.task !== undefined) setTask(overrides.task);
    if (overrides.mode !== undefined) setMode(overrides.mode);
    if (overrides.codeRefs !== undefined) setCodeRefsText(overrides.codeRefs.join('\n'));
    if (overrides.workset !== undefined) {
      invalidateRecall();
      setScopeKind('workset');
      setWorkset(overrides.workset);
    }
    const snapshot: BriefRequestSnapshot = {
      body: {
        budgetTokens,
        codeRefs: nextCodeRefs,
        ...(detail === 'compact' ? {} : {detail}),
        mode: nextMode,
        ...(project.trim() ? {project: project.trim()} : {}),
        task: nextTask.trim(),
        ...(nextScopeKind === 'repository' ? {callerCwd: callerCwd.trim()} : {workset: nextWorkset.trim()}),
      },
      scope:
        nextScopeKind === 'repository'
          ? {callerCwd: callerCwd.trim(), kind: 'repository'}
          : {kind: 'workset', workset: nextWorkset.trim()},
    };
    await executeBrief(snapshot);
  }

  async function executeBrief(snapshot: BriefRequestSnapshot): Promise<boolean> {
    briefRequest.current?.abort();
    const controller = new AbortController();
    briefRequest.current = controller;
    setBriefBusy(true);
    setBriefError('');
    try {
      const result = await api<ProjectedContextBriefV1>('/api/context/brief', snapshot.body, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return false;
      setBrief(result);
      setBriefRequestSnapshot(snapshot);
      return true;
    } catch (cause) {
      if (!controller.signal.aborted) setBriefError(errorMessage(cause));
      return false;
    } finally {
      if (!controller.signal.aborted) setBriefBusy(false);
    }
  }

  async function recoverGraph(scope: 'repository' | 'workset'): Promise<void> {
    const snapshot = briefRequestSnapshot;
    const currentScopeMatches =
      snapshot?.scope.kind === 'repository'
        ? scopeKind === 'repository' && snapshot.scope.callerCwd === callerCwd.trim()
        : snapshot?.scope.kind === 'workset'
          ? scopeKind === 'workset' && snapshot.scope.workset === workset.trim()
          : false;
    if (
      !snapshot ||
      snapshot.scope.kind !== scope ||
      !currentScopeMatches ||
      snapshot.body.task !== task.trim() ||
      snapshot.body.mode !== mode ||
      (snapshot.body.detail ?? 'compact') !== detail ||
      snapshot.body.budgetTokens !== budgetTokens ||
      (snapshot.body.project ?? '') !== project.trim() ||
      snapshot.body.codeRefs.join('\n') !== codeRefs.join('\n')
    ) {
      setGraphRecoveryError('The Context Brief inputs changed. Rerun the brief before preparing its graph scope.');
      return;
    }
    graphRecoveryRequest.current?.abort();
    const controller = new AbortController();
    graphRecoveryRequest.current = controller;
    setGraphRecoveryBusy(true);
    setGraphRecoveryError('');
    setGraphRecoveryNotice('');
    try {
      const recoveryOutput =
        snapshot.scope.kind === 'repository'
          ? (
              await api<{readonly output: string}>(
                '/api/graphs/action',
                {action: 'index-cwd', cwd: snapshot.scope.callerCwd},
                {signal: controller.signal},
              )
            ).output
          : await prepareWorksetForContext(snapshot.scope.workset, controller.signal);
      if (controller.signal.aborted) return;
      setGraphRecoveryNotice(`${recoveryOutput} Recompiling the Context Brief…`);
      const recompiled = await executeBrief(snapshot);
      if (!controller.signal.aborted) {
        setGraphRecoveryNotice(
          recompiled
            ? `${recoveryOutput} Context Brief recompiled with the refreshed graph.`
            : `${recoveryOutput} Graph recovery completed; retry the Context Brief compile.`,
        );
      }
    } catch (cause) {
      if (!controller.signal.aborted) setGraphRecoveryError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setGraphRecoveryBusy(false);
    }
  }

  async function runRecall(): Promise<void> {
    if (!recallQuery.trim()) return;
    recallRequest.current?.abort();
    const controller = new AbortController();
    recallRequest.current = controller;
    setRecallBusy(true);
    setRecallError('');
    try {
      const result = await api<ManagerRecallResponse>(
        '/api/context/recall',
        {
          includeArchived,
          ...(callerCwd.trim() && scopeKind === 'repository' ? {callerCwd: callerCwd.trim()} : {}),
          ...(project.trim() ? {project: project.trim()} : {}),
          query: recallQuery.trim(),
          ...(workset.trim() && scopeKind === 'workset' ? {workset: workset.trim()} : {}),
        },
        {signal: controller.signal},
      );
      if (!controller.signal.aborted) {
        setRecall(result);
        setRecallPage(0);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setRecallError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setRecallBusy(false);
    }
  }

  async function recordFeedback(result: ManagerRecallResult, action: RecallFeedbackAction): Promise<void> {
    const response = recall;
    if (!response) return;
    feedbackRequest.current?.abort();
    const controller = new AbortController();
    feedbackRequest.current = controller;
    const key = `${result.canonicalUri}:${action}`;
    setFeedbackBusy(key);
    setFeedbackError('');
    try {
      const feedbackProject =
        action === 'pin'
          ? (response.effectiveProject ?? response.request.project ?? result.metadata?.project)
          : response.effectiveProject;
      const feedback = await api<ManagerRecallFeedbackResponse>(
        '/api/context/feedback',
        {
          action,
          ...(feedbackProject ? {project: feedbackProject} : {}),
          query: response.request.query,
          uri: result.canonicalUri,
        },
        {signal: controller.signal},
      );
      if (!controller.signal.aborted) {
        setFeedbackByUri(current => ({...current, [feedback.uri]: feedback.action}));
      }
    } catch (cause) {
      if (!controller.signal.aborted) setFeedbackError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setFeedbackBusy('');
    }
  }

  async function readContext(uri: string, page = 0, trackNavigation = true): Promise<void> {
    if (trackNavigation) readerNavigationRevision.current += 1;
    readRequest.current?.abort();
    const controller = new AbortController();
    readRequest.current = controller;
    setReadBusy(true);
    setReadError('');
    if (page === 0 && readResult?.canonicalUri !== uri) {
      connectionsRequest.current?.abort();
      relationsRequest.current?.abort();
      setReaderView('content');
      setConnections(undefined);
      setConnectionsBusy(false);
      setConnectionsError('');
      setRelationsBusy(false);
      setRelationsError('');
      setReadResult(undefined);
    }
    try {
      const result = await api<ManagerContextReadResponse>(
        '/api/context/read',
        {page, uri},
        {signal: controller.signal},
      );
      if (!controller.signal.aborted) setReadResult(result);
    } catch (cause) {
      if (!controller.signal.aborted) setReadError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setReadBusy(false);
    }
  }

  async function readConnections(uri: string): Promise<void> {
    connectionsRequest.current?.abort();
    const controller = new AbortController();
    connectionsRequest.current = controller;
    setConnectionsBusy(true);
    setConnectionsError('');
    try {
      const result = await api<ManagerContextConnectionsResponse>(
        '/api/context/connections',
        {includeHistorical: includeArchived, uri},
        {signal: controller.signal},
      );
      if (!controller.signal.aborted) setConnections(result);
    } catch (cause) {
      if (!controller.signal.aborted) setConnectionsError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setConnectionsBusy(false);
    }
  }

  async function saveRelations(relations: readonly MemoryRelation[]): Promise<void> {
    const editor = connections?.editor;
    if (!editor) return;
    const navigationRevision = readerNavigationRevision.current;
    relationsRequest.current?.abort();
    const controller = new AbortController();
    relationsRequest.current = controller;
    setRelationsBusy(true);
    setRelationsError('');
    try {
      const updated = await api<ManagerMemoryRelationsResponse>(
        '/api/memory/relations',
        {expectedContent: editor.expectedContent, relations, uri: editor.uri},
        {signal: controller.signal},
      );
      if (controller.signal.aborted || readerNavigationRevision.current !== navigationRevision) return;
      setConnections(current =>
        current?.editor
          ? {
              ...current,
              editor: {
                expectedContent: updated.content,
                relations: updated.relations,
                uri: updated.uri,
              },
            }
          : current,
      );
      await readContext(updated.uri, 0, false);
      if (controller.signal.aborted || readerNavigationRevision.current !== navigationRevision) return;
      await readConnections(updated.uri);
    } catch (cause) {
      if (!controller.signal.aborted) setRelationsError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setRelationsBusy(false);
    }
  }

  function inspectConnectionCitation(citation: MemoryCodeCitationV1): void {
    const codeRef = citation.target.kind === 'symbol' ? citation.target.nodeId : citation.path;
    setView('brief');
    void runBrief({
      codeRefs: [codeRef],
      mode: 'explain',
      task: `Explain the code evidence connected to ${citation.path}.`,
    });
  }

  function setScope(next: ContextScopeKind): void {
    briefRequest.current?.abort();
    graphRecoveryRequest.current?.abort();
    setGraphRecoveryBusy(false);
    invalidateRecall();
    setScopeKind(next);
    setBriefBusy(false);
    setBrief(undefined);
    setBriefRequestSnapshot(undefined);
    setBriefError('');
  }

  function invalidateRecall(): void {
    recallRequest.current?.abort();
    feedbackRequest.current?.abort();
    recallRequest.current = undefined;
    setRecallBusy(false);
    setRecall(undefined);
    setRecallPage(0);
    setRecallError('');
    setFeedbackByUri({});
    setFeedbackBusy('');
    setFeedbackError('');
  }

  function cancelBrief(): void {
    briefRequest.current?.abort();
    briefRequest.current = undefined;
    setBriefBusy(false);
  }

  const scopeControls = (
    <section className="context-scope-card" aria-label="Context scope">
      <div className="context-scope-kind">
        <span>Scope</span>
        <div className="segmented-control">
          <button
            className={scopeKind === 'repository' ? 'is-active' : undefined}
            disabled={graphRecoveryBusy}
            onClick={() => setScope('repository')}
            type="button"
          >
            Repository
          </button>
          <button
            className={scopeKind === 'workset' ? 'is-active' : undefined}
            disabled={graphRecoveryBusy}
            onClick={() => setScope('workset')}
            type="button"
          >
            Workset
          </button>
        </div>
      </div>
      <label>
        {scopeKind === 'repository' ? 'Repository' : 'Prepared Workset'}
        <select
          disabled={graphRecoveryBusy}
          onChange={event => {
            invalidateRecall();
            if (scopeKind === 'repository') {
              setCallerCwd(event.target.value);
            } else setWorkset(event.target.value);
          }}
          value={scopeKind === 'repository' ? callerCwd : workset}
        >
          <option value="">{scopeKind === 'repository' ? 'Select repository' : 'Select Workset'}</option>
          {scopeKind === 'repository'
            ? catalog?.projects.map(item => (
                <option key={item.name} value={item.path}>
                  {item.name} — {item.path}
                </option>
              ))
            : catalog?.definitions.map(item => (
                <option key={item.name} value={item.name}>
                  {item.name} · {item.memberCount} projects
                </option>
              ))}
        </select>
      </label>
      <label>
        Memory project
        <select
          disabled={graphRecoveryBusy}
          onChange={event => {
            invalidateRecall();
            setProject(event.target.value);
          }}
          value={project}
        >
          <option value="">Infer from repository / search all</option>
          {memoryProjectOptions.map(item => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
          {project && !memoryProjectOptions.includes(project) ? <option>{project}</option> : null}
        </select>
        {catalogError ? <small>Configured choices are unavailable. Refresh Manager to retry.</small> : null}
      </label>
    </section>
  );

  return (
    <div className="context-workspace">
      <div aria-label="Context workspace view" className="workspace-tabs" role="tablist">
        {(['brief', 'recall', 'value'] as const).map(next => (
          <button
            aria-selected={view === next}
            className={view === next ? 'is-active' : undefined}
            disabled={graphRecoveryBusy}
            key={next}
            onClick={() => setView(next)}
            role="tab"
            type="button"
          >
            {next === 'brief' ? 'Brief' : next === 'recall' ? 'Recall' : 'Value'}
          </button>
        ))}
      </div>

      {view === 'brief' ? (
        <section aria-busy={briefBusy || graphRecoveryBusy} className="context-compose" role="tabpanel">
          <div className="workspace-card context-composer-card">
            <header>
              <h3>What are you working on?</h3>
            </header>
            <div className="context-compose-form">
              <label className="context-task-field">
                Task
                <textarea
                  disabled={graphRecoveryBusy}
                  onChange={event => setTask(event.target.value)}
                  placeholder="Explain the contract around this code and surface current decisions"
                  rows={4}
                  value={task}
                />
              </label>
              {scopeControls}
              <label>
                Mode
                <select
                  disabled={graphRecoveryBusy}
                  onChange={event => setMode(event.target.value as ContextBriefMode)}
                  value={mode}
                >
                  {CONTEXT_BRIEF_MODES.map(value => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <details className="context-advanced">
                <summary>Evidence and budget</summary>
                <label>
                  Evidence detail
                  <select
                    disabled={graphRecoveryBusy}
                    onChange={event => setDetail(event.target.value as ContextBriefDetail)}
                    value={detail}
                  >
                    <option value="compact">Compact evidence</option>
                    <option value="source">Include source excerpts</option>
                  </select>
                </label>
                <label>
                  Budget
                  <input
                    disabled={graphRecoveryBusy}
                    max={1_500}
                    min={CONTEXT_BRIEF_MINIMUM_ESTIMATED_TOKENS}
                    onChange={event => setBudgetTokens(Number(event.target.value))}
                    type="number"
                    value={budgetTokens}
                  />
                </label>
                <label className="context-code-refs">
                  Code anchors
                  <span className={tooManyCodeRefs ? 'is-warning' : undefined}>
                    {codeRefs.length}/{CONTEXT_BRIEF_MAXIMUM_CODE_REFS}
                  </span>
                  <textarea
                    disabled={graphRecoveryBusy}
                    onChange={event => setCodeRefsText(event.target.value)}
                    placeholder={'apps/threadnote/src/manager/context.ts\ncgs_…'}
                    rows={3}
                    value={codeRefsText}
                  />
                  {codeRefsError ? <small role="alert">{codeRefsError}</small> : null}
                </label>
              </details>
              <div className="context-form-actions">
                <button
                  disabled={
                    briefBusy ||
                    graphRecoveryBusy ||
                    Boolean(codeRefsError) ||
                    invalidBudget ||
                    !task.trim() ||
                    (scopeKind === 'repository' ? !callerCwd.trim() : !workset.trim())
                  }
                  onClick={() => void runBrief()}
                  type="button"
                >
                  {briefBusy ? 'Building…' : brief ? 'Rebuild brief' : 'Build brief'}
                </button>
                {briefBusy ? (
                  <button onClick={cancelBrief} type="button">
                    Cancel
                  </button>
                ) : null}
              </div>
            </div>
          </div>
          <div className="workspace-card context-evidence-card">
            <header>
              <h3>Evidence</h3>
            </header>
            <div className="workspace-pad">
              <ContextStatus
                error={briefError}
                loading={briefBusy}
                loadingText="Compiling bounded graph and memory evidence…"
              />
              <ContextStatus
                error={graphRecoveryError}
                loading={graphRecoveryBusy}
                loadingText="Preparing graph evidence and recompiling this Context Brief…"
              />
              {graphRecoveryNotice && !graphRecoveryBusy ? (
                <p aria-live="polite" className="context-status is-success" role="status">
                  {graphRecoveryNotice}
                </p>
              ) : null}
              {brief ? (
                <ContextBriefResult
                  brief={brief.structuredContent}
                  onOpenMemory={uri => void readContext(uri)}
                  onRecoverGraph={scope => void recoverGraph(scope)}
                  recoveryBusy={graphRecoveryBusy}
                  onRerun={overrides => void runBrief(overrides)}
                />
              ) : !briefBusy && !briefError ? (
                <ContextEmpty
                  title="No brief compiled yet"
                  text="Choose a repository or prepared Workset, describe the task, and optionally add exact file or graph anchors."
                />
              ) : null}
            </div>
          </div>
        </section>
      ) : view === 'recall' ? (
        <section aria-busy={recallBusy} className="context-recall" role="tabpanel">
          {scopeControls}
          <div className="context-recall-form">
            <label>
              Recall query
              <input
                onChange={event => {
                  invalidateRecall();
                  setRecallQuery(event.target.value);
                }}
                onKeyDown={event => {
                  if (event.key === 'Enter') void runRecall();
                }}
                placeholder="Context Brief Manager decisions and current handoff"
                value={recallQuery}
              />
            </label>
            <label className="context-check">
              <input
                checked={includeArchived}
                onChange={event => {
                  invalidateRecall();
                  setIncludeArchived(event.target.checked);
                }}
                type="checkbox"
              />
              Include inactive memory
            </label>
            <button disabled={recallBusy || !recallQuery.trim()} onClick={() => void runRecall()} type="button">
              {recallBusy ? 'Searching…' : 'Recall context'}
            </button>
          </div>
          <ContextStatus error={recallError} loading={recallBusy} loadingText="Ranking bounded memory pointers…" />
          {recall ? (
            <RecallResults
              feedbackBusy={feedbackBusy}
              feedbackByUri={feedbackByUri}
              onFeedback={(result, action) => void recordFeedback(result, action)}
              onOpen={uri => void readContext(uri)}
              onPage={setRecallPage}
              page={recallPage}
              response={recall}
            />
          ) : !recallBusy && !recallError ? (
            <ContextEmpty
              title="Recall returns pointers, not evidence"
              text="Search by decision, contract, handoff, or implementation concept. Open a result to read its canonical source."
            />
          ) : null}
          <ContextStatus error={feedbackError} loading={false} loadingText="" />
        </section>
      ) : (
        <ValuePanel {...(project.trim() ? {project: project.trim()} : {})} />
      )}

      {readBusy || readResult || readError ? (
        <ContextReader
          busy={readBusy}
          error={readError}
          onClose={() => {
            readRequest.current?.abort();
            connectionsRequest.current?.abort();
            relationsRequest.current?.abort();
            setReadBusy(false);
            setConnectionsBusy(false);
            setRelationsBusy(false);
            setReadResult(undefined);
            setConnections(undefined);
            setReadError('');
            setConnectionsError('');
            setRelationsError('');
            setReaderView('content');
          }}
          connections={connections}
          connectionsBusy={connectionsBusy}
          connectionsError={connectionsError}
          onInspectCode={inspectConnectionCitation}
          onLoadConnections={uri => void readConnections(uri)}
          onOpen={uri => void readContext(uri)}
          onPage={(uri, page) => void readContext(uri, page)}
          onSaveRelations={relations => void saveRelations(relations)}
          onView={nextView => {
            if (nextView === 'content') {
              connectionsRequest.current?.abort();
              setConnectionsBusy(false);
              setConnectionsError('');
            }
            setReaderView(nextView);
          }}
          relationsBusy={relationsBusy}
          relationsError={relationsError}
          result={readResult}
          view={readerView}
        />
      ) : null}
    </div>
  );
}

export function ContextBriefResult(props: {
  readonly brief: ContextBriefV1;
  readonly onOpenMemory: (uri: string) => void;
  readonly onRecoverGraph: (scope: 'repository' | 'workset') => void;
  readonly onRerun: (overrides: BriefRunOverrides) => void;
  readonly recoveryBusy: boolean;
}): React.ReactElement {
  const brief = props.brief;
  const anchors = brief.coverage.memory.codeAnchors;
  const continuationRef = brief.recommendedFollowUps.find(followUp => followUp.operation === 'inspect-node')?.ref;
  const continuationCodeRefs = continuationRef === undefined ? undefined : contextBriefRerunCodeRefs(continuationRef);
  const continuationRecovery =
    brief.scope.freshness === 'stale' && anchors?.complete === false
      ? brief.recommendedFollowUps.find(followUp => followUp.operation === 'graph-status')
      : undefined;
  return (
    <div className="context-brief-result" aria-label="Context Brief result">
      <div className="context-metrics">
        <Metric
          label="Freshness"
          value={brief.scope.freshness}
          tone={brief.scope.freshness === 'fresh' ? 'ok' : 'warn'}
        />
        <Metric
          label="Repositories"
          value={`${brief.scope.readyRepositories}/${brief.scope.requestedRepositories} ready`}
          tone={brief.coverage.graph.complete ? 'ok' : 'warn'}
        />
        <Metric
          label="Memory"
          value={`${brief.durableDecisions.length} decisions · ${brief.activeHandoffs.length} handoffs · ${brief.coverage.memory.consideredCandidates} considered`}
        />
        <Metric
          label="Code anchors"
          value={
            anchors ? `${anchors.resolved}/${anchors.requested} resolved · ${anchors.matchedMemories} memories` : 'none'
          }
          tone={anchors && !anchors.complete ? 'warn' : 'ok'}
        />
        <Metric
          label="Output"
          value={`${brief.output.returnedItems} items${brief.output.truncated ? ` · ${brief.output.omittedItems} omitted` : ''}`}
          tone={brief.output.truncated ? 'warn' : 'ok'}
        />
      </div>

      {brief.coverage.gaps.length > 0 ? (
        <section className="context-notices" aria-label="Coverage gaps">
          <h3>Coverage gaps</h3>
          {brief.coverage.gaps.map(gap => (
            <p key={gap}>{gap}</p>
          ))}
        </section>
      ) : null}

      <div className="context-evidence-grid">
        <section className="context-evidence-column">
          <SectionHeading count={brief.graph.cards.length} title="Graph evidence" />
          {brief.graph.cards.length === 0 ? (
            <SmallEmpty text="No graph cards survived the bounded projection." />
          ) : null}
          {brief.graph.cards.map(card => (
            <GraphEvidenceCard card={card} key={card.id} onRerun={props.onRerun} />
          ))}
          {brief.graph.continuation ? (
            <div className="context-continuation">
              <strong>More graph evidence is available</strong>
              <span>
                {continuationRecovery?.operation === 'graph-status'
                  ? 'The graph is stale; refresh it before retrieving omitted cards.'
                  : brief.graph.continuation.state === 'available'
                    ? `${brief.graph.continuation.remainingEstimate} estimated cards remain.`
                    : `${brief.graph.continuation.omittedCards} cards were omitted; narrow the task and rerun.`}
              </span>
              {continuationRecovery?.operation === 'graph-status' ? (
                <button
                  disabled={props.recoveryBusy}
                  onClick={() => props.onRecoverGraph(continuationRecovery.scope)}
                  type="button"
                >
                  {props.recoveryBusy
                    ? 'Preparing graph…'
                    : continuationRecovery.scope === 'repository'
                      ? 'Index graph and rerun'
                      : 'Prepare Workset and rerun'}
                </button>
              ) : continuationCodeRefs ? (
                <button
                  onClick={() =>
                    props.onRerun({
                      codeRefs: continuationCodeRefs,
                      mode: 'explain',
                      task: `Explain the current code and memory evidence for ${continuationCodeRefs[0]}.`,
                    })
                  }
                  type="button"
                >
                  Rerun from exact ref
                </button>
              ) : (
                <span>Inspect the returned graph reference directly to recover omitted cards.</span>
              )}
            </div>
          ) : null}
        </section>

        <section className="context-evidence-column">
          <SectionHeading count={brief.durableDecisions.length + brief.activeHandoffs.length} title="Memory evidence" />
          {[...brief.durableDecisions, ...brief.activeHandoffs].length === 0 ? (
            <SmallEmpty text="No active durable memory or handoff survived this brief." />
          ) : null}
          {brief.durableDecisions.map(memory => (
            <MemoryEvidenceCard key={memory.uri} memory={memory} onOpen={props.onOpenMemory} />
          ))}
          {brief.activeHandoffs.map(memory => (
            <MemoryEvidenceCard key={memory.uri} memory={memory} onOpen={props.onOpenMemory} />
          ))}
        </section>
      </div>

      {brief.graph.contracts.length > 0 ? (
        <section className="context-contracts">
          <SectionHeading count={brief.graph.contracts.length} title="Relationships" />
          <div>
            {brief.graph.contracts.map(contract => (
              <article key={contract.id}>
                <strong>{contract.relation}</strong>
                <code>{contract.sourceRef}</code>
                <span>→</span>
                <code>{contract.targetRef}</code>
                <small>
                  {contract.authority} · {contract.provenance} · {contract.evidence.path}:{contract.evidence.line}
                </small>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {brief.stalenessAndConflicts.length > 0 ? (
        <section className="context-notices is-warning">
          <h3>Staleness and conflicts</h3>
          {brief.stalenessAndConflicts.map(issue => (
            <article key={issue.id}>
              <strong>{issue.kind}</strong>
              <p>{issue.summary}</p>
              {issue.uris.map(uri => (
                <button key={uri} onClick={() => props.onOpenMemory(uri)} type="button">
                  Read affected memory
                </button>
              ))}
            </article>
          ))}
        </section>
      ) : null}

      {brief.recommendedFollowUps.length > 0 ? (
        <section className="context-followups">
          <SectionHeading count={brief.recommendedFollowUps.length} title="Recommended follow-ups" />
          {brief.recommendedFollowUps.map(followUp => (
            <FollowUpAction
              followUp={followUp}
              key={followUp.id}
              onOpenMemory={props.onOpenMemory}
              onRecoverGraph={props.onRecoverGraph}
              onRerun={props.onRerun}
              recoveryBusy={props.recoveryBusy}
            />
          ))}
        </section>
      ) : null}
    </div>
  );
}

function GraphEvidenceCard(props: {
  readonly card: ContextBriefV1['graph']['cards'][number];
  readonly onRerun: (overrides: BriefRunOverrides) => void;
}): React.ReactElement {
  const card = props.card;
  const codeRefs = contextBriefRerunCodeRefs(card.ref);
  return (
    <article className="context-graph-card">
      <header>
        <span>{card.symbol.kind}</span>
        <strong>{card.symbol.qualifiedName}</strong>
      </header>
      <code>
        {card.symbol.path}:{card.symbol.line}
      </code>
      <p>{card.reason}</p>
      <footer>
        <span>{card.repositoryKey}</span>
        <button
          onClick={() =>
            props.onRerun({
              ...(codeRefs === undefined ? {} : {codeRefs}),
              mode: 'explain',
              task:
                codeRefs === undefined
                  ? `Narrow the Workset to ${card.symbol.qualifiedName} and explain its current contract and related memory.`
                  : `Explain the current contract and related memory for ${card.symbol.qualifiedName}.`,
            })
          }
          type="button"
        >
          {codeRefs === undefined ? 'Narrow Workset and rerun' : 'Rerun from this ref'}
        </button>
      </footer>
    </article>
  );
}

function RecallResults(props: {
  readonly feedbackBusy: string;
  readonly feedbackByUri: Readonly<Record<string, RecallFeedbackAction>>;
  readonly onFeedback: (result: ManagerRecallResult, action: RecallFeedbackAction) => void;
  readonly onOpen: (uri: string) => void;
  readonly onPage: (page: number) => void;
  readonly page: number;
  readonly response: ManagerRecallResponse;
}): React.ReactElement {
  const response = props.response;
  const page = projectManagerRecallPage(response.results, props.page, MANAGER_CONTEXT_RECALL_PAGE_SIZE_DEFAULT);
  return (
    <div className="context-recall-results" aria-label="Ranked recall results">
      <header>
        <div>
          <h3>
            {response.results.length === 0
              ? 'No ranked pointers'
              : `${response.resultSet.availableResults} ranked pointers`}
          </h3>
          <p>
            {response.confidence
              ? `${response.confidence.level.replaceAll('_', ' ')} confidence · ${response.confidence.reason}`
              : 'Open a pointer before using it as evidence.'}
          </p>
          {response.resultSet.truncated ? (
            <p>
              Showing the top {response.resultSet.availableResults} of {response.resultSet.totalRanked} ranked matches.
            </p>
          ) : null}
        </div>
        <span>
          Page {page.index + 1} of {page.pageCount} · {response.trust.replaceAll('-', ' ')}
        </span>
      </header>
      {response.results.length === 0 ? (
        <ContextEmpty
          title="No active match"
          text="Try a more specific contract, decision, component, or handoff term."
        />
      ) : (
        <div className="context-recall-list" role="list">
          {page.results.map(result => (
            <RecallResultCard
              busy={props.feedbackBusy}
              feedback={props.feedbackByUri[result.canonicalUri]}
              key={`${result.rank}:${result.canonicalUri}`}
              onFeedback={props.onFeedback}
              onOpen={props.onOpen}
              pinAvailable={Boolean(response.effectiveProject ?? response.request.project ?? result.metadata?.project)}
              result={result}
            />
          ))}
        </div>
      )}
      {response.queryExpansions.length > 0 ? (
        <div className="context-query-expansions">
          <strong>Evaluated query expansions</strong>
          {response.queryExpansions.map(expansion => (
            <span key={expansion}>{expansion}</span>
          ))}
        </div>
      ) : null}
      {response.warnings.length > 0 ? (
        <div className="context-notices is-warning" aria-label="Recall warnings">
          <h3>Recall may be incomplete</h3>
          {response.warnings.map(warning => (
            <p key={warning.code}>
              {warning.message} {warning.remediation}
            </p>
          ))}
        </div>
      ) : null}
      {page.hasPrevious || page.hasNext ? (
        <div className="context-page-actions">
          <button disabled={!page.hasPrevious} onClick={() => props.onPage(page.index - 1)} type="button">
            Previous
          </button>
          <button disabled={!page.hasNext} onClick={() => props.onPage(page.index + 1)} type="button">
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}

function RecallResultCard(props: {
  readonly busy: string;
  readonly feedback?: RecallFeedbackAction;
  readonly onFeedback: (result: ManagerRecallResult, action: RecallFeedbackAction) => void;
  readonly onOpen: (uri: string) => void;
  readonly pinAvailable: boolean;
  readonly result: ManagerRecallResult;
}): React.ReactElement {
  const result = props.result;
  return (
    <article className="context-recall-card" role="listitem">
      <button className="context-recall-open" onClick={() => props.onOpen(result.canonicalUri)} type="button">
        <span className="context-rank">#{result.rank}</span>
        <span className="context-recall-card-main">
          <strong>{result.metadata?.topic ?? result.canonicalUri.split('/').at(-1)}</strong>
          <small>
            {result.readState} · {result.category} · {result.metadata?.kind ?? result.contextType}
            {result.metadata?.project ? ` · ${result.metadata.project}` : ''}
            {result.confidence === undefined ? '' : ` · ${Math.round(result.confidence * 100)}%`}
          </small>
          <span>{result.snippet || result.reason}</span>
          {result.snippet && result.reason !== result.snippet ? (
            <span className="context-recall-reason">Why: {result.reason}</span>
          ) : null}
          <code>{result.canonicalUri}</code>
          {result.requestedUri !== result.canonicalUri ? <em>Relocated from the recalled URI</em> : null}
          {result.warnings.map(warning => (
            <em className="is-warning" key={warning}>
              {warning}
            </em>
          ))}
        </span>
        <span aria-hidden="true">→</span>
      </button>
      <footer className="context-recall-feedback" aria-label={`Feedback for result ${result.rank}`}>
        <span>{props.feedback ? `Recorded: ${props.feedback}` : 'Was this context useful?'}</span>
        {(['useful', 'wrong', 'pin', 'dismiss', 'applied'] as const).map(action => {
          const key = `${result.canonicalUri}:${action}`;
          return (
            <button
              aria-pressed={props.feedback === action}
              disabled={Boolean(props.busy) || (action === 'pin' && !props.pinAvailable)}
              key={action}
              onClick={() => props.onFeedback(result, action)}
              title={action === 'applied' ? 'This context materially informed a plan or change' : undefined}
              type="button"
            >
              {props.busy === key ? 'Saving…' : action[0]?.toUpperCase() + action.slice(1)}
            </button>
          );
        })}
      </footer>
    </article>
  );
}

function ContextReader(props: {
  readonly busy: boolean;
  readonly connections?: ManagerContextConnectionsResponse;
  readonly connectionsBusy: boolean;
  readonly connectionsError: string;
  readonly error: string;
  readonly onClose: () => void;
  readonly onInspectCode: (citation: MemoryCodeCitationV1) => void;
  readonly onLoadConnections: (uri: string) => void;
  readonly onOpen: (uri: string) => void;
  readonly onPage: (uri: string, page: number) => void;
  readonly onSaveRelations: (relations: readonly MemoryRelation[]) => void;
  readonly onView: (view: 'connections' | 'content') => void;
  readonly relationsBusy: boolean;
  readonly relationsError: string;
  readonly result?: ManagerContextReadResponse;
  readonly view: 'connections' | 'content';
}): React.ReactElement {
  const result = props.result;
  return (
    <aside aria-label="Canonical context reader" className="context-reader">
      <header>
        <div>
          <p className="eyebrow">Canonical source</p>
          <h3>{result?.title ?? 'Reading context…'}</h3>
          <code>{result?.canonicalUri ?? ''}</code>
        </div>
        <button aria-label="Close context reader" onClick={props.onClose} type="button">
          Close
        </button>
      </header>
      {result && result.requestedUri !== result.canonicalUri ? (
        <p className="context-reader-relocation">Resolved the requested pointer to its canonical memory.</p>
      ) : null}
      {result?.metadata ? (
        <div className="context-reader-metadata">
          <span>{result.metadata.kind}</span>
          <span>{result.metadata.status}</span>
          {result.metadata.project ? <span>{result.metadata.project}</span> : null}
          {result.metadata.trust ? <span>{result.metadata.trust}</span> : null}
        </div>
      ) : null}
      {result?.metadata ? (
        <div aria-label="Context reader view" className="segmented-control context-reader-tabs" role="tablist">
          <button
            aria-selected={props.view === 'content'}
            className={props.view === 'content' ? 'is-active' : undefined}
            onClick={() => props.onView('content')}
            role="tab"
            type="button"
          >
            Content
          </button>
          <button
            aria-selected={props.view === 'connections'}
            className={props.view === 'connections' ? 'is-active' : undefined}
            onClick={() => {
              props.onView('connections');
              if (!props.connections || props.connections.requestedUri !== result.requestedUri) {
                props.onLoadConnections(result.requestedUri);
              }
            }}
            role="tab"
            type="button"
          >
            Connections
          </button>
        </div>
      ) : null}
      {props.busy ? <ContextStatus loading loadingText="Reading canonical context…" error="" /> : null}
      {props.error ? <ContextStatus error={props.error} loading={false} loadingText="" /> : null}
      {props.view === 'content' && result ? <pre>{result.content}</pre> : null}
      {props.view === 'connections' ? (
        <ContextConnections
          busy={props.connectionsBusy}
          error={props.connectionsError}
          onInspectCode={props.onInspectCode}
          onOpen={props.onOpen}
          onSaveRelations={props.onSaveRelations}
          relationsBusy={props.relationsBusy}
          relationsError={props.relationsError}
          result={props.connections}
        />
      ) : null}
      {props.view === 'content' && result && result.page.total > 1 ? (
        <footer>
          <button
            disabled={result.page.previous === undefined || props.busy}
            onClick={() => props.onPage(result.requestedUri, result.page.previous!)}
            type="button"
          >
            Previous page
          </button>
          <span>
            Page {result.page.index + 1}/{result.page.total}
          </span>
          <button
            disabled={result.page.next === undefined || props.busy}
            onClick={() => props.onPage(result.requestedUri, result.page.next!)}
            type="button"
          >
            Next page
          </button>
        </footer>
      ) : null}
    </aside>
  );
}

function ContextConnections(props: {
  readonly busy: boolean;
  readonly error: string;
  readonly onInspectCode: (citation: MemoryCodeCitationV1) => void;
  readonly onOpen: (uri: string) => void;
  readonly onSaveRelations: (relations: readonly MemoryRelation[]) => void;
  readonly relationsBusy: boolean;
  readonly relationsError: string;
  readonly result?: ManagerContextConnectionsResponse;
}): React.ReactElement {
  if (props.busy) return <ContextStatus error="" loading loadingText="Verifying direct memory connections…" />;
  if (props.error) return <ContextStatus error={props.error} loading={false} loadingText="" />;
  if (!props.result)
    return <ContextEmpty title="Connections not loaded" text="Open this tab to verify direct links." />;
  const result = props.result;
  const nodes = new Map(result.nodes.map(node => [node.memoryId, node]));
  const groups = [
    {
      connections: result.connections.filter(connection => connection.resolution === 'unresolved'),
      title: 'Unresolved authored links',
    },
    {
      connections: result.connections.filter(
        connection => connection.direction === 'incoming' && connection.resolution !== 'unresolved',
      ),
      title: 'Incoming',
    },
    {
      connections: result.connections.filter(
        connection => connection.direction === 'outgoing' && connection.resolution !== 'unresolved',
      ),
      title: 'Outgoing',
    },
  ];
  return (
    <div className="context-connections" aria-label="Verified memory connections">
      <div className="context-connection-summary">
        <strong>{result.coverage.resultCount} direct neighbor(s)</strong>
        <span>{result.trust.replaceAll('-', ' ')}</span>
        {result.coverage.truncated ? <em>Bounded result is truncated.</em> : null}
      </div>
      <div className="context-premises">
        {result.premises.map(premise => (
          <span className={`is-${premise.state}`} key={`${premise.requestedOrdinal}:${premise.requestedRef}`}>
            Premise {premise.requestedOrdinal + 1}: {premise.state}
          </span>
        ))}
      </div>
      {groups.map(group => (
        <section className="context-connection-group" key={group.title}>
          <SectionHeading count={group.connections.length} title={group.title} />
          {group.connections.length === 0 ? (
            <SmallEmpty text={`No ${group.title.toLowerCase()} in this bounded view.`} />
          ) : null}
          {group.connections.map((connection, index) => {
            const node = connection.neighborMemoryId ? nodes.get(connection.neighborMemoryId) : undefined;
            return (
              <article
                className="context-connection-card"
                key={`${connection.requestedOrdinal}:${connection.direction}:${connection.relationType}:${connection.neighborMemoryId ?? 'unresolved'}:${index}`}
              >
                <header>
                  <strong>{connection.relationType}</strong>
                  <span>{connection.direction}</span>
                  <em className={`is-${connection.currentness}`}>{connection.currentness}</em>
                </header>
                <code>{connection.neighborUri ?? 'Unresolved legacy target (locator withheld)'}</code>
                <small>
                  {connection.origin} · distance {connection.distance} · {connection.resolution}
                  {node ? ` · ${node.metadata.status}${node.metadata.trust ? ` · ${node.metadata.trust}` : ''}` : ''}
                </small>
                <footer>
                  {connection.neighborUri ? (
                    <button onClick={() => props.onOpen(connection.neighborUri!)} type="button">
                      Open neighbor
                    </button>
                  ) : null}
                  {node?.codeCitations.map(citation => (
                    <button key={citation.id} onClick={() => props.onInspectCode(citation)} type="button">
                      Inspect {citation.target.kind === 'symbol' ? citation.target.name : citation.path}
                    </button>
                  ))}
                </footer>
              </article>
            );
          })}
        </section>
      ))}
      {result.editor ? (
        <RelationEditor
          busy={props.relationsBusy}
          editor={result.editor}
          error={props.relationsError}
          onSave={props.onSaveRelations}
        />
      ) : (
        <SmallEmpty text="Relation editing is available only for an active identity-bearing memory." />
      )}
    </div>
  );
}

function RelationEditor(props: {
  readonly busy: boolean;
  readonly editor: NonNullable<ManagerContextConnectionsResponse['editor']>;
  readonly error: string;
  readonly onSave: (relations: readonly MemoryRelation[]) => void;
}): React.ReactElement {
  const [relations, setRelations] = useState<readonly MemoryRelation[]>(props.editor.relations);
  useEffect(() => setRelations(props.editor.relations), [props.editor.expectedContent, props.editor.relations]);
  const invalid = relations.some(relation => !relation.uri.trim());
  return (
    <section className="context-relation-editor" aria-busy={props.busy}>
      <SectionHeading count={relations.length} title="Structured relations" />
      <p>Targets are resolved to stable identities and checked again during the write.</p>
      {relations.map((relation, index) => (
        <div className="context-relation-row" key={`${index}:${relation.type}`}>
          <label>
            Type
            <select
              disabled={props.busy}
              onChange={event =>
                setRelations(current =>
                  current.map((item, itemIndex) =>
                    itemIndex === index ? {...item, type: event.target.value as MemoryRelation['type']} : item,
                  ),
                )
              }
              value={relation.type}
            >
              {MEMORY_RELATION_TYPES.map(type => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label>
            Target memory
            <input
              disabled={props.busy}
              onChange={event =>
                setRelations(current =>
                  current.map((item, itemIndex) => (itemIndex === index ? {...item, uri: event.target.value} : item)),
                )
              }
              placeholder="threadnote://memory/tn_…"
              value={relation.uri}
            />
          </label>
          <button
            disabled={props.busy}
            onClick={() => setRelations(current => current.filter((_item, itemIndex) => itemIndex !== index))}
            type="button"
          >
            Remove
          </button>
        </div>
      ))}
      {props.error ? <p role="alert">{props.error}</p> : null}
      <div className="context-form-actions">
        <button
          disabled={props.busy || relations.length >= 16}
          onClick={() => setRelations(current => [...current, {type: 'related_to', uri: ''}])}
          type="button"
        >
          Add relation
        </button>
        <button disabled={props.busy || invalid} onClick={() => props.onSave(relations)} type="button">
          {props.busy ? 'Saving relations…' : 'Save relations'}
        </button>
      </div>
    </section>
  );
}

function MemoryEvidenceCard(props: {
  readonly memory: ContextBriefMemoryEvidenceV1;
  readonly onOpen: (uri: string) => void;
}): React.ReactElement {
  const memory = props.memory;
  return (
    <article className="context-memory-card">
      <header>
        <span>{memory.kind}</span>
        <strong>{memory.topic ?? memory.uri.split('/').at(-1)}</strong>
        <em className={`is-${memory.freshness}`}>{memory.preciseStatus ?? memory.freshness}</em>
      </header>
      <p>{memory.excerpt}</p>
      <div className="context-memory-metadata">
        <span>{memory.freshnessBasis}</span>
        {memory.authority ? <span>{memory.authority}</span> : null}
        {memory.selectionBasis ? <span>selected by {memory.selectionBasis}</span> : null}
        {memory.citationSummary ? (
          <span>
            citations: {memory.citationSummary.exact} exact · {memory.citationSummary.relocated} relocated ·{' '}
            {memory.citationSummary.stale} stale · {memory.citationSummary.unknown} unknown
          </span>
        ) : null}
      </div>
      {memory.codeRelations && memory.codeRelations.length > 0 ? (
        <div className="context-memory-relations">
          {memory.codeRelations.map(relation => (
            <span key={`${relation.anchorOrdinal}:${relation.citationId}`}>
              {relation.kind} anchor {relation.anchorOrdinal + 1} · {relation.status}
            </span>
          ))}
        </div>
      ) : null}
      <footer>
        <code>{memory.uri}</code>
        <button onClick={() => props.onOpen(memory.uri)} type="button">
          Open memory
        </button>
      </footer>
    </article>
  );
}

function FollowUpAction(props: {
  readonly followUp: ContextBriefFollowUpV1;
  readonly onOpenMemory: (uri: string) => void;
  readonly onRecoverGraph: (scope: 'repository' | 'workset') => void;
  readonly onRerun: (overrides: BriefRunOverrides) => void;
  readonly recoveryBusy: boolean;
}): React.ReactElement {
  const followUp = props.followUp;
  if (followUp.operation === 'read-memory') {
    return (
      <button onClick={() => props.onOpenMemory(followUp.uri)} type="button">
        Read recommended memory
      </button>
    );
  }
  if (followUp.operation === 'inspect-node') {
    const codeRefs = contextBriefRerunCodeRefs(followUp.ref);
    return (
      <button
        onClick={() =>
          props.onRerun({
            ...(codeRefs === undefined ? {} : {codeRefs}),
            mode: 'explain',
            task:
              codeRefs === undefined
                ? 'Narrow the Workset to this repository-qualified graph result and explain its memory constraints.'
                : `Explain this graph node and the memory constraints that cite it: ${followUp.ref}`,
          })
        }
        type="button"
      >
        {codeRefs === undefined ? 'Narrow Workset and rerun' : 'Inspect node and rerun'}
      </button>
    );
  }
  if (followUp.operation === 'graph-status') {
    return (
      <button disabled={props.recoveryBusy} onClick={() => props.onRecoverGraph(followUp.scope)} type="button">
        {props.recoveryBusy
          ? 'Preparing graph…'
          : followUp.scope === 'repository'
            ? 'Index graph and rerun'
            : 'Prepare Workset and rerun'}
      </button>
    );
  }
  return (
    <button
      onClick={() =>
        props.onRerun({mode: 'locate', task: 'Narrow the Workset query so its remaining evidence can be retrieved.'})
      }
      type="button"
    >
      Narrow before continuing Workset
    </button>
  );
}

async function prepareWorksetForContext(workset: string, signal: AbortSignal): Promise<string> {
  let job = (
    await api<{readonly job: ManagerWorksetPrepareJob}>('/api/worksets/prepare', {concurrency: 2, workset}, {signal})
  ).job;
  let polls = 0;
  while (job.status === 'running' || job.status === 'cancelling') {
    if (polls >= CONTEXT_WORKSET_RECOVERY_MAXIMUM_POLLS) {
      throw new Error('Workset preparation is still running. Monitor it in Worksets, then rerun this Context Brief.');
    }
    await contextRecoveryDelay(signal);
    job = (
      await api<{readonly job: ManagerWorksetPrepareJob}>(
        `/api/worksets/jobs/${encodeURIComponent(job.id)}`,
        undefined,
        {
          signal,
        },
      )
    ).job;
    polls += 1;
  }
  if (job.status !== 'completed' || job.result?.state !== 'ready') {
    throw new Error(job.error ?? `Workset preparation ended with status ${job.status}.`);
  }
  return `Workset ${job.workset} is ready.`;
}

function contextRecoveryDelay(signal: AbortSignal): Promise<void> {
  const {promise, reject, resolve} = Promise.withResolvers<void>();
  if (signal.aborted) {
    reject(new Error('Context graph recovery was cancelled.'));
    return promise;
  }
  const onAbort = () => {
    window.clearTimeout(timer);
    reject(new Error('Context graph recovery was cancelled.'));
  };
  const timer = window.setTimeout(() => {
    signal.removeEventListener('abort', onAbort);
    resolve();
  }, CONTEXT_WORKSET_RECOVERY_POLL_MILLISECONDS);
  signal.addEventListener('abort', onAbort, {once: true});
  return promise;
}

function Metric(props: {
  readonly label: string;
  readonly tone?: 'ok' | 'warn';
  readonly value: string;
}): React.ReactElement {
  return (
    <div className={props.tone ? `is-${props.tone}` : undefined}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function SectionHeading(props: {readonly count: number; readonly title: string}): React.ReactElement {
  return (
    <header className="context-section-heading">
      <h3>{props.title}</h3>
      <span>{props.count}</span>
    </header>
  );
}

function ContextStatus(props: {
  readonly error: string;
  readonly loading: boolean;
  readonly loadingText: string;
}): React.ReactElement | null {
  if (props.loading) {
    return (
      <p aria-live="polite" className="context-status" role="status">
        <span aria-hidden="true" className="spinner" /> {props.loadingText}
      </p>
    );
  }
  if (props.error) {
    return (
      <p aria-live="polite" className="context-status is-error" role="alert">
        {props.error}
      </p>
    );
  }
  return null;
}

function ContextEmpty(props: {readonly text: string; readonly title: string}): React.ReactElement {
  return (
    <div className="context-empty">
      <span aria-hidden="true">◎</span>
      <h3>{props.title}</h3>
      <p>{props.text}</p>
    </div>
  );
}

function SmallEmpty(props: {readonly text: string}): React.ReactElement {
  return <p className="context-small-empty">{props.text}</p>;
}

export function parseCodeRefs(value: string): readonly string[] {
  return [...new Set(value.split(/[\n,]/u).filter(item => item.length > 0))];
}

function contextBriefRerunCodeRefs(ref: string): readonly string[] | undefined {
  try {
    return parseContextBriefCodeRefs([ref]);
  } catch {
    return undefined;
  }
}
