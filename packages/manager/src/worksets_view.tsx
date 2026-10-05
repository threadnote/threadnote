import {Schema} from 'effect';
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {CONTEXT_BRIEF_MODES} from '@threadnote/context/types';
import type {ProjectedContextBriefV1, ContextBriefMode} from '@threadnote/context/types';
import type {CodeGraphWorksetTopologyResultV1} from '@threadnote/graph/cross_repository/runtime';
import type {CodeGraphCrossRepositoryTraversalResultV1} from '@threadnote/graph/cross_repository/traversal';
import {renderCodeGraphWorksetPrepareProgress} from '@threadnote/graph/workset_catalog/progress_render';
import type {CodeGraphWorksetStatusResultV1} from '@threadnote/graph/workset_catalog/workset';
import type {ProjectedCodeGraphWorksetEvidenceV1} from '@threadnote/graph/workset/evidence';
import {useManagerDialogs} from '@threadnote/manager/dialog';
import {ManifestProjectsPanel} from './manifest_projects_view.js';
import {ManagerApiError, api, errorMessage} from '@threadnote/manager/ui/support';
import type {
  ManagerWorksetCatalog,
  ManagerWorksetDefinition,
  ManagerWorksetDefinitionMutationResult,
  ManagerWorksetPrepareJob,
  ManagerWorksetPrepareJobSummary,
  ManagerWorksetProjectSummary,
} from '@threadnote/manager/workset/contracts';

type WorksetOperation = 'brief' | 'query' | 'topology' | 'traversal';
type TraversalMode = 'impact' | 'path';
type ManifestManagementView = 'projects' | 'worksets';

interface DefinitionDraft {
  readonly description: string;
  readonly mode: 'create' | 'edit';
  readonly name: string;
  readonly originalName?: string;
  readonly projects: ReadonlySet<string>;
}

const JOB_POLL_MILLISECONDS = 1_000;
const JOB_PROGRESS_CLOCK_MILLISECONDS = 1_000;
const JOB_RECEIPTS_VISIBLE_MAXIMUM = 250;
const PROJECT_PICKER_VISIBLE_MAXIMUM = 250;
const WORKSET_OPERATIONS = ['query', 'traversal', 'topology', 'brief'] as const;

export function WorksetsPanel(): React.ReactElement {
  const dialogs = useManagerDialogs();
  const [catalog, setCatalog] = useState<ManagerWorksetCatalog>();
  const [catalogError, setCatalogError] = useState('');
  const [managementView, setManagementView] = useState<ManifestManagementView>('worksets');
  const [selectedName, setSelectedName] = useState('');
  const [selectedDefinition, setSelectedDefinition] = useState<ManagerWorksetDefinition>();
  const [status, setStatus] = useState<CodeGraphWorksetStatusResultV1>();
  const [statusError, setStatusError] = useState('');
  const [statusLoading, setStatusLoading] = useState(false);
  const [job, setJob] = useState<ManagerWorksetPrepareJob>();
  const [definitionDraft, setDefinitionDraft] = useState<DefinitionDraft>();
  const [definitionBusy, setDefinitionBusy] = useState(false);
  const [definitionFilter, setDefinitionFilter] = useState('');
  const [definitionProjectPage, setDefinitionProjectPage] = useState(0);
  const [definitionSelectedOnly, setDefinitionSelectedOnly] = useState(false);
  const [notice, setNotice] = useState('');
  const [operation, setOperation] = useState<WorksetOperation>('query');
  const [operationBusy, setOperationBusy] = useState(false);
  const [operationError, setOperationError] = useState('');
  const [query, setQuery] = useState('');
  const [queryBudget, setQueryBudget] = useState(1_250);
  const [includeHeuristic, setIncludeHeuristic] = useState(false);
  const [includeModelAssociations, setIncludeModelAssociations] = useState(false);
  const [queryPages, setQueryPages] = useState<readonly ProjectedCodeGraphWorksetEvidenceV1[]>([]);
  const [traversalMode, setTraversalMode] = useState<TraversalMode>('path');
  const [pathFrom, setPathFrom] = useState('');
  const [pathTo, setPathTo] = useState('');
  const [impactQuery, setImpactQuery] = useState('');
  const [traversalResult, setTraversalResult] = useState<CodeGraphCrossRepositoryTraversalResultV1>();
  const [topologyResult, setTopologyResult] = useState<CodeGraphWorksetTopologyResultV1>();
  const [briefTask, setBriefTask] = useState('');
  const [briefMode, setBriefMode] = useState<ContextBriefMode>('brief');
  const [briefBudget, setBriefBudget] = useState(1_250);
  const [briefResult, setBriefResult] = useState<ProjectedContextBriefV1>();
  const catalogRequestRef = useRef<AbortController | undefined>(undefined);
  const definitionRequestRef = useRef<AbortController | undefined>(undefined);
  const definitionSequenceRef = useRef(0);
  const statusRequestRef = useRef<AbortController | undefined>(undefined);
  const statusSequenceRef = useRef(0);
  const operationRequestRef = useRef<AbortController | undefined>(undefined);
  const operationSequenceRef = useRef(0);
  const catalogSequenceRef = useRef(0);
  const selectedNameRef = useRef(selectedName);
  selectedNameRef.current = selectedName;

  const selected = useMemo(
    () => catalog?.definitions.find(definition => definition.name === selectedName),
    [catalog, selectedName],
  );
  const projectPicker = useMemo(() => {
    if (!definitionDraft || !catalog) return {items: [], page: 0, pageCount: 0, total: 0};
    const normalized = definitionFilter.trim().toLowerCase();
    const projects = new Map(catalog.projects.map(project => [project.name.toLowerCase(), project]));
    for (const project of definitionDraft.projects) {
      const key = project.toLowerCase();
      if (!projects.has(key)) {
        projects.set(key, {
          branchState: 'missing',
          folder: 'Unresolved manifest project',
          name: project,
          path: 'Not configured in the seed manifest',
          worksets: [],
          worksetCount: 0,
        });
      }
    }
    const candidates = [...projects.values()]
      .filter(project => !definitionSelectedOnly || hasProjectSelection(definitionDraft.projects, project.name))
      .filter(project => !normalized || managerWorksetProjectSearchText(project).includes(normalized))
      .sort(
        (left, right) => managerWorksetProjectRank(left, normalized) - managerWorksetProjectRank(right, normalized),
      );
    const pageCount = Math.ceil(candidates.length / PROJECT_PICKER_VISIBLE_MAXIMUM);
    const page = Math.min(definitionProjectPage, Math.max(0, pageCount - 1));
    return {
      items: candidates.slice(page * PROJECT_PICKER_VISIBLE_MAXIMUM, (page + 1) * PROJECT_PICKER_VISIBLE_MAXIMUM),
      page,
      pageCount,
      total: candidates.length,
    };
  }, [catalog, definitionDraft, definitionFilter, definitionProjectPage, definitionSelectedOnly]);

  useEffect(() => {
    void loadCatalog();
    void loadJobs();
    return () => {
      catalogRequestRef.current?.abort();
      definitionRequestRef.current?.abort();
      statusRequestRef.current?.abort();
      operationRequestRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (catalog?.projects.length === 0) setManagementView('projects');
  }, [catalog?.projects.length]);

  useEffect(() => {
    operationRequestRef.current?.abort();
    operationRequestRef.current = undefined;
    operationSequenceRef.current += 1;
    setOperationBusy(false);
    setStatus(undefined);
    setStatusError('');
    clearOperationResults();
    setSelectedDefinition(undefined);
    if (selectedName) {
      void loadDefinition(selectedName);
      void loadStatus(selectedName);
    }
  }, [selectedName]);

  useEffect(() => {
    if (!job || (job.status !== 'running' && job.status !== 'cancelling')) return;
    let cancelled = false;
    let jobTimer: number | undefined;
    const pollJob = async (): Promise<void> => {
      try {
        const next = await api<{readonly job: ManagerWorksetPrepareJob}>(`/api/worksets/jobs/${job.id}`);
        if (cancelled) return;
        setJob(next.job);
        if (next.job.status === 'running' || next.job.status === 'cancelling') {
          jobTimer = window.setTimeout(() => void pollJob(), JOB_POLL_MILLISECONDS);
        } else if (next.job.workset === selectedName) {
          if (next.job.status === 'completed') {
            cancelOperation();
            clearOperationResults();
          }
          await loadStatus(next.job.workset, false);
        }
      } catch (cause) {
        if (!cancelled) setOperationError(errorMessage(cause));
      }
    };
    jobTimer = window.setTimeout(() => void pollJob(), JOB_POLL_MILLISECONDS);
    return () => {
      cancelled = true;
      if (jobTimer !== undefined) window.clearTimeout(jobTimer);
    };
  }, [job?.id, job?.status, selectedName]);

  async function loadCatalog(): Promise<void> {
    catalogRequestRef.current?.abort();
    const controller = new AbortController();
    catalogRequestRef.current = controller;
    const sequence = catalogSequenceRef.current + 1;
    catalogSequenceRef.current = sequence;
    try {
      const next = await api<ManagerWorksetCatalog>('/api/worksets', undefined, {signal: controller.signal});
      if (sequence !== catalogSequenceRef.current) return;
      setCatalog(next);
      setCatalogError('');
      const currentName = selectedNameRef.current;
      const nextName = next.definitions.some(definition => definition.name === currentName)
        ? currentName
        : (next.definitions[0]?.name ?? '');
      setSelectedName(nextName);
      if (nextName && nextName === currentName) {
        setSelectedDefinition(undefined);
        setStatus(undefined);
        cancelOperation();
        clearOperationResults();
        await Promise.all([loadDefinition(nextName), loadStatus(nextName)]);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setCatalogError(errorMessage(cause));
    }
  }

  async function loadJobs(): Promise<void> {
    try {
      const response = await api<{readonly jobs: readonly ManagerWorksetPrepareJobSummary[]}>('/api/worksets/jobs');
      const active = response.jobs.find(item => item.status === 'running' || item.status === 'cancelling');
      const selectedJob = active ?? response.jobs[0];
      if (!selectedJob) return;
      const detail = await api<{readonly job: ManagerWorksetPrepareJob}>(`/api/worksets/jobs/${selectedJob.id}`);
      setJob(detail.job);
    } catch {
      // Definitions and read-only search remain useful if job history is unavailable.
    }
  }

  async function loadDefinition(name: string): Promise<void> {
    definitionRequestRef.current?.abort();
    const controller = new AbortController();
    definitionRequestRef.current = controller;
    const sequence = definitionSequenceRef.current + 1;
    definitionSequenceRef.current = sequence;
    try {
      const next = await api<ManagerWorksetDefinition>(
        `/api/worksets/definition?workset=${encodeURIComponent(name)}`,
        undefined,
        {signal: controller.signal},
      );
      if (sequence === definitionSequenceRef.current) setSelectedDefinition(next);
    } catch (cause) {
      if (!controller.signal.aborted && sequence === definitionSequenceRef.current) setNotice(errorMessage(cause));
    }
  }

  async function loadStatus(name: string, showLoading = true): Promise<void> {
    statusRequestRef.current?.abort();
    const controller = new AbortController();
    statusRequestRef.current = controller;
    const sequence = statusSequenceRef.current + 1;
    statusSequenceRef.current = sequence;
    setStatus(undefined);
    if (showLoading) setStatusLoading(true);
    try {
      const next = await api<CodeGraphWorksetStatusResultV1>(
        `/api/worksets/status?workset=${encodeURIComponent(name)}`,
        undefined,
        {signal: controller.signal},
      );
      if (sequence !== statusSequenceRef.current) return;
      setStatus(next);
      setStatusError('');
    } catch (cause) {
      if (!controller.signal.aborted && sequence === statusSequenceRef.current) {
        setStatus(undefined);
        setStatusError(
          Schema.is(ManagerApiError)(cause) && cause.code === 'maintenance-busy'
            ? 'Readiness is temporarily unavailable while graph maintenance is active. Manifest definitions remain available.'
            : errorMessage(cause),
        );
      }
    } finally {
      if (sequence === statusSequenceRef.current) setStatusLoading(false);
    }
  }

  function openCreateDefinition(): void {
    setDefinitionFilter('');
    setDefinitionProjectPage(0);
    setDefinitionSelectedOnly(false);
    setDefinitionDraft({description: '', mode: 'create', name: '', projects: new Set()});
  }

  function openEditDefinition(definition: ManagerWorksetDefinition): void {
    setDefinitionFilter('');
    setDefinitionProjectPage(0);
    setDefinitionSelectedOnly(false);
    setDefinitionDraft({
      description: definition.description ?? '',
      mode: 'edit',
      name: definition.name,
      originalName: definition.name,
      projects: new Set(definition.members.map(member => member.project)),
    });
  }

  async function saveDefinition(): Promise<void> {
    if (!definitionDraft || !catalog || definitionDraft.projects.size === 0) return;
    setDefinitionBusy(true);
    setNotice('');
    try {
      const result = await api<ManagerWorksetDefinitionMutationResult>('/api/worksets/definitions', {
        description: definitionDraft.description,
        expectedRevision: catalog.revision,
        name: definitionDraft.name,
        operation: definitionDraft.mode === 'create' ? 'create' : 'update',
        projects: [...definitionDraft.projects],
        ...(definitionDraft.originalName === undefined ? {} : {workset: definitionDraft.originalName}),
      });
      acceptAuthoritativeCatalog(result.catalog);
      cancelOperation();
      clearOperationResults();
      const savedName =
        result.catalog.definitions.find(
          definition => definition.name.toLowerCase() === definitionDraft.name.trim().toLowerCase(),
        )?.name ?? definitionDraft.name.trim();
      setSelectedName(savedName);
      setSelectedDefinition(undefined);
      await Promise.all([loadDefinition(savedName), loadStatus(savedName)]);
      setDefinitionDraft(undefined);
      setNotice(result.warnings.join(' ') || (result.changed ? 'Workset definition saved.' : 'No definition change.'));
    } catch (cause) {
      if (Schema.is(ManagerApiError)(cause) && cause.code === 'revision-conflict') {
        setNotice('The manifest changed. Definitions were refreshed; your draft is preserved for review and retry.');
        await loadCatalog();
      } else {
        setNotice(errorMessage(cause));
      }
    } finally {
      setDefinitionBusy(false);
    }
  }

  async function deleteDefinition(definition: {readonly name: string}): Promise<void> {
    if (!catalog) return;
    const confirmed = await dialogs.confirm({
      cancelLabel: 'Keep workset',
      confirmLabel: 'Delete definition',
      detail: definition.name,
      message: 'This removes the manifest definition. Repository graphs are not deleted.',
      title: 'Delete workset definition?',
      tone: 'danger',
    });
    if (!confirmed) return;
    setDefinitionBusy(true);
    try {
      const result = await api<ManagerWorksetDefinitionMutationResult>('/api/worksets/definitions', {
        confirm: true,
        expectedRevision: catalog.revision,
        operation: 'delete',
        workset: definition.name,
      });
      acceptAuthoritativeCatalog(result.catalog);
      cancelOperation();
      clearOperationResults();
      setSelectedName(result.catalog.definitions[0]?.name ?? '');
      setSelectedDefinition(undefined);
      setNotice(result.warnings.join(' ') || 'Workset definition deleted.');
    } catch (cause) {
      setNotice(errorMessage(cause));
      await loadCatalog();
    } finally {
      setDefinitionBusy(false);
    }
  }

  async function startPrepare(): Promise<void> {
    if (!selected) return;
    setOperationError('');
    try {
      const result = await api<{readonly job: ManagerWorksetPrepareJob}>('/api/worksets/prepare', {
        concurrency: 2,
        workset: selected.name,
      });
      setJob(result.job);
    } catch (cause) {
      setOperationError(errorMessage(cause));
    }
  }

  async function cancelPrepare(): Promise<void> {
    if (!job) return;
    try {
      const result = await api<{readonly job: ManagerWorksetPrepareJob}>('/api/worksets/jobs/cancel', {id: job.id});
      setJob(result.job);
    } catch (cause) {
      setOperationError(errorMessage(cause));
    }
  }

  async function runOperation<T>(
    request: (signal: AbortSignal) => Promise<T>,
    onResult: (result: T) => void,
  ): Promise<void> {
    operationRequestRef.current?.abort();
    const controller = new AbortController();
    operationRequestRef.current = controller;
    const sequence = operationSequenceRef.current + 1;
    operationSequenceRef.current = sequence;
    setOperationBusy(true);
    setOperationError('');
    try {
      const result = await request(controller.signal);
      if (!controller.signal.aborted && sequence === operationSequenceRef.current) onResult(result);
    } catch (cause) {
      if (!controller.signal.aborted && sequence === operationSequenceRef.current)
        setOperationError(errorMessage(cause));
    } finally {
      if (sequence === operationSequenceRef.current && operationRequestRef.current === controller) {
        operationRequestRef.current = undefined;
        setOperationBusy(false);
      }
    }
  }

  function cancelOperation(): void {
    operationSequenceRef.current += 1;
    operationRequestRef.current?.abort();
    operationRequestRef.current = undefined;
    setOperationBusy(false);
  }

  function clearOperationResults(): void {
    setQueryPages([]);
    setTraversalResult(undefined);
    setTopologyResult(undefined);
    setBriefResult(undefined);
  }

  function useTraversalReference(reference: string, target: 'from' | 'impact' | 'to'): void {
    setOperation('traversal');
    if (target === 'impact') {
      setTraversalMode('impact');
      setImpactQuery(reference);
    } else {
      setTraversalMode('path');
      if (target === 'from') setPathFrom(reference);
      else setPathTo(reference);
    }
    window.requestAnimationFrame(() => document.getElementById(`worksets-traversal-${target}`)?.focus());
  }

  function selectOperationFromKeyboard(event: React.KeyboardEvent<HTMLButtonElement>, current: WorksetOperation): void {
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    const currentIndex = WORKSET_OPERATIONS.indexOf(current);
    const next = WORKSET_OPERATIONS[(currentIndex + direction + WORKSET_OPERATIONS.length) % WORKSET_OPERATIONS.length];
    setOperation(next);
    window.requestAnimationFrame(() => document.getElementById(`worksets-tab-${next}`)?.focus());
  }

  function selectManagementViewFromKeyboard(
    event: React.KeyboardEvent<HTMLButtonElement>,
    current: ManifestManagementView,
  ): void {
    const views = ['projects', 'worksets'] as const;
    const next =
      event.key === 'Home'
        ? views[0]
        : event.key === 'End'
          ? views[1]
          : event.key === 'ArrowLeft' || event.key === 'ArrowRight'
            ? views[(views.indexOf(current) + 1) % views.length]
            : undefined;
    if (next === undefined) return;
    event.preventDefault();
    if (next === 'worksets') showWorksets();
    else setManagementView('projects');
    window.requestAnimationFrame(() => document.getElementById(`manifest-management-tab-${next}`)?.focus());
  }

  function runQuery(): void {
    if (!selected || !query.trim()) return;
    setQueryPages([]);
    void runOperation(
      signal =>
        api<ProjectedCodeGraphWorksetEvidenceV1>(
          '/api/worksets/query',
          {
            budgetTokens: queryBudget,
            includeHeuristic,
            includeModelAssociations,
            query,
            workset: selected.name,
          },
          {signal},
        ),
      result => setQueryPages([result]),
    );
  }

  function continueQuery(): void {
    const cursor = queryPages.at(-1)?.structuredContent.continuation?.cursor;
    if (!cursor) return;
    void runOperation(
      signal =>
        api<ProjectedCodeGraphWorksetEvidenceV1>(
          '/api/worksets/continue',
          {budgetTokens: queryBudget, cursor},
          {signal},
        ),
      result => setQueryPages(current => [...current, result]),
    );
  }

  function runTraversal(): void {
    if (!selected) return;
    const body =
      traversalMode === 'path'
        ? {from: pathFrom, maxDepth: 8, maxEdges: 500, to: pathTo, workset: selected.name}
        : {maxDepth: 8, maxEdges: 500, query: impactQuery, workset: selected.name};
    void runOperation(
      signal => api<CodeGraphCrossRepositoryTraversalResultV1>(`/api/worksets/${traversalMode}`, body, {signal}),
      setTraversalResult,
    );
  }

  function runTopology(): void {
    if (!selected) return;
    void runOperation(
      signal =>
        api<CodeGraphWorksetTopologyResultV1>(
          '/api/worksets/topology',
          {
            maxEdges: 256,
            maxEvidence: 128,
            maxNodes: 128,
            workset: selected.name,
          },
          {signal},
        ),
      setTopologyResult,
    );
  }

  function runBrief(): void {
    if (!selected || !briefTask.trim()) return;
    void runOperation(
      signal =>
        api<ProjectedContextBriefV1>(
          '/api/worksets/context-brief',
          {
            budgetTokens: briefBudget,
            mode: briefMode,
            task: briefTask,
            workset: selected.name,
          },
          {signal},
        ),
      setBriefResult,
    );
  }

  function acceptAuthoritativeCatalog(next: ManagerWorksetCatalog): void {
    catalogRequestRef.current?.abort();
    catalogRequestRef.current = undefined;
    catalogSequenceRef.current += 1;
    setCatalog(next);
    const currentName = selectedNameRef.current;
    setSelectedName(next.definitions.some(definition => definition.name === currentName) ? currentName : '');
    setSelectedDefinition(undefined);
    setStatus(undefined);
    cancelOperation();
    clearOperationResults();
  }

  function showWorksets(): void {
    setManagementView('worksets');
    cancelOperation();
    clearOperationResults();
    const currentName = selectedNameRef.current;
    if (currentName) {
      void loadDefinition(currentName);
      void loadStatus(currentName);
    }
  }

  return (
    <div className="worksets-management">
      <div aria-label="Seed manifest management" className="worksets-management-tabs" role="tablist">
        <button
          aria-controls="manifest-management-panel-projects"
          aria-selected={managementView === 'projects'}
          className={managementView === 'projects' ? 'is-active' : undefined}
          id="manifest-management-tab-projects"
          onClick={() => setManagementView('projects')}
          onKeyDown={event => selectManagementViewFromKeyboard(event, 'projects')}
          role="tab"
          tabIndex={managementView === 'projects' ? 0 : -1}
          type="button"
        >
          Projects
          <span>{catalog?.projects.length ?? 0}</span>
        </button>
        <button
          aria-controls="manifest-management-panel-worksets"
          aria-selected={managementView === 'worksets'}
          className={managementView === 'worksets' ? 'is-active' : undefined}
          id="manifest-management-tab-worksets"
          onClick={showWorksets}
          onKeyDown={event => selectManagementViewFromKeyboard(event, 'worksets')}
          role="tab"
          tabIndex={managementView === 'worksets' ? 0 : -1}
          type="button"
        >
          Worksets
          <span>{catalog?.definitions.length ?? 0}</span>
        </button>
      </div>
      {managementView === 'projects' ? (
        <ManifestProjectsPanel
          catalog={catalog}
          catalogError={catalogError}
          onCatalog={acceptAuthoritativeCatalog}
          onRefreshCatalog={loadCatalog}
          onSwitchToWorksets={showWorksets}
        />
      ) : (
        <div
          aria-labelledby="manifest-management-tab-worksets"
          className="worksets-workspace"
          id="manifest-management-panel-worksets"
          role="tabpanel"
        >
          <aside
            aria-hidden={definitionDraft ? true : undefined}
            aria-label="Workset definitions"
            className="worksets-catalog"
            inert={definitionDraft ? true : undefined}
          >
            <div className="worksets-section-head">
              <div>
                <p className="eyebrow">Seed manifest</p>
                <h2>Worksets</h2>
              </div>
              <button
                aria-label="Create workset"
                disabled={!catalog || catalog.readOnly || catalog.projects.length === 0}
                onClick={openCreateDefinition}
                title="Create workset"
                type="button"
              >
                +
              </button>
            </div>
            <p className="worksets-boundary">
              {catalog?.readOnly
                ? catalog.editability.reason === 'manifest-symlink'
                  ? 'This manifest is a symbolic link, so definitions are read-only in Manager.'
                  : 'These definitions use YAML aliases or shapes that Manager will preserve but cannot edit safely.'
                : 'Definitions are edited atomically in the authoritative seed manifest.'}
            </p>
            {catalogError ? <p className="worksets-error">{catalogError}</p> : null}
            <div className="worksets-definition-list">
              {catalog?.definitions.map(definition => (
                <button
                  aria-current={selectedName === definition.name ? 'true' : undefined}
                  className={selectedName === definition.name ? 'is-selected' : undefined}
                  key={definition.name}
                  onClick={() => setSelectedName(definition.name)}
                  type="button"
                >
                  <strong>{definition.name}</strong>
                  <span>
                    {definition.memberCount} {definition.memberCount === 1 ? 'member' : 'members'}
                  </span>
                </button>
              ))}
              {catalog && catalog.definitions.length === 0 ? <p>No worksets yet. Create one to start.</p> : null}
            </div>
            <button className="quiet-button" onClick={() => void loadCatalog()} type="button">
              Refresh definitions
            </button>
          </aside>

          <section
            aria-hidden={definitionDraft ? true : undefined}
            className="worksets-main"
            inert={definitionDraft ? true : undefined}
          >
            {selected ? (
              <>
                <header className="worksets-header">
                  <div>
                    <p className="eyebrow">Cross-repository workspace</p>
                    <h2>{selected.name}</h2>
                    <p>{selected.description || 'No description'}</p>
                  </div>
                  <div className="button-row">
                    <button
                      disabled={catalog?.readOnly || !selectedDefinition}
                      onClick={() => selectedDefinition && openEditDefinition(selectedDefinition)}
                      type="button"
                    >
                      Edit
                    </button>
                    <button
                      className="danger"
                      disabled={definitionBusy || catalog?.readOnly}
                      onClick={() => void deleteDefinition(selected)}
                      type="button"
                    >
                      Delete
                    </button>
                    <button
                      disabled={job?.status === 'running' || job?.status === 'cancelling'}
                      onClick={() => void startPrepare()}
                      type="button"
                    >
                      Prepare
                    </button>
                  </div>
                </header>
                {notice ? (
                  <p className="worksets-notice" role="status">
                    {notice}
                  </p>
                ) : null}
                {operationError ? (
                  <p className="worksets-error" role="alert">
                    {operationError}
                  </p>
                ) : null}
                <WorksetStatusPanel
                  definition={selectedDefinition}
                  loading={statusLoading}
                  onRefresh={() => void loadStatus(selected.name)}
                  status={status}
                  statusError={statusError}
                />
                {job ? (
                  <PrepareJobPanel
                    definition={job.workset === selectedDefinition?.name ? selectedDefinition : undefined}
                    job={job}
                    onCancel={() => void cancelPrepare()}
                  />
                ) : null}
                <div className="worksets-operation-tabs" role="tablist" aria-label="Workset operations">
                  {WORKSET_OPERATIONS.map(value => (
                    <button
                      aria-controls={`worksets-panel-${value}`}
                      aria-selected={operation === value}
                      className={operation === value ? 'is-active' : undefined}
                      id={`worksets-tab-${value}`}
                      key={value}
                      onClick={() => setOperation(value)}
                      onKeyDown={event => selectOperationFromKeyboard(event, value)}
                      role="tab"
                      tabIndex={operation === value ? 0 : -1}
                      type="button"
                    >
                      {value === 'brief' ? 'Context brief' : value[0].toUpperCase() + value.slice(1)}
                    </button>
                  ))}
                </div>
                {operation === 'query' ? (
                  <QueryPanel
                    budget={queryBudget}
                    busy={operationBusy}
                    includeHeuristic={includeHeuristic}
                    includeModelAssociations={includeModelAssociations}
                    onBudget={setQueryBudget}
                    onCancel={cancelOperation}
                    onContinue={continueQuery}
                    onHeuristic={setIncludeHeuristic}
                    onModelAssociations={setIncludeModelAssociations}
                    onQuery={setQuery}
                    onRun={runQuery}
                    onUseReference={useTraversalReference}
                    pages={queryPages}
                    query={query}
                    repositoryLabel={repositoryKey => managerWorksetRepositoryLabel(repositoryKey, selectedDefinition)}
                  />
                ) : null}
                {operation === 'traversal' ? (
                  <TraversalPanel
                    busy={operationBusy}
                    from={pathFrom}
                    impactQuery={impactQuery}
                    mode={traversalMode}
                    onFrom={setPathFrom}
                    onImpactQuery={setImpactQuery}
                    onMode={setTraversalMode}
                    onRun={runTraversal}
                    onTo={setPathTo}
                    result={traversalResult}
                    repositoryLabel={repositoryKey => managerWorksetRepositoryLabel(repositoryKey, selectedDefinition)}
                    to={pathTo}
                  />
                ) : null}
                {operation === 'topology' ? (
                  <TopologyPanel
                    busy={operationBusy}
                    onRun={runTopology}
                    repositoryLabel={repositoryKey => managerWorksetRepositoryLabel(repositoryKey, selectedDefinition)}
                    result={topologyResult}
                  />
                ) : null}
                {operation === 'brief' ? (
                  <ContextBriefPanel
                    budget={briefBudget}
                    busy={operationBusy}
                    mode={briefMode}
                    onBudget={setBriefBudget}
                    onMode={setBriefMode}
                    onRun={runBrief}
                    onTask={setBriefTask}
                    result={briefResult}
                    repositoryLabel={repositoryKey => managerWorksetRepositoryLabel(repositoryKey, selectedDefinition)}
                    task={briefTask}
                  />
                ) : null}
              </>
            ) : (
              <div className="worksets-empty">
                <h2>No workset selected</h2>
                <p>
                  {catalog?.projects.length === 0
                    ? 'Add a manifest project before creating a Workset.'
                    : 'Create a named set of manifest projects, then prepare it explicitly.'}
                </p>
                <button
                  disabled={!catalog || (catalog.projects.length === 0 ? catalog.projectsReadOnly : catalog.readOnly)}
                  onClick={catalog?.projects.length === 0 ? () => setManagementView('projects') : openCreateDefinition}
                  type="button"
                >
                  {catalog?.projects.length === 0 ? 'Add first project' : 'Create workset'}
                </button>
              </div>
            )}
          </section>

          {definitionDraft && catalog ? (
            <DefinitionEditor
              busy={definitionBusy}
              draft={definitionDraft}
              filter={definitionFilter}
              onCancel={() => setDefinitionDraft(undefined)}
              onChange={setDefinitionDraft}
              onFilter={value => {
                setDefinitionFilter(value);
                setDefinitionProjectPage(0);
              }}
              onPage={setDefinitionProjectPage}
              onSave={() => void saveDefinition()}
              onSelectedOnly={value => {
                setDefinitionSelectedOnly(value);
                setDefinitionProjectPage(0);
              }}
              page={projectPicker.page}
              pageCount={projectPicker.pageCount}
              projects={projectPicker.items}
              selectedOnly={definitionSelectedOnly}
              totalProjects={projectPicker.total}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function WorksetStatusPanel(props: {
  readonly definition?: ManagerWorksetDefinition;
  readonly loading: boolean;
  readonly onRefresh: () => void;
  readonly status?: CodeGraphWorksetStatusResultV1;
  readonly statusError: string;
}): React.ReactElement {
  const status = props.status;
  return (
    <section className="worksets-card" aria-label="Workset readiness">
      <div className="worksets-section-head">
        <div>
          <p className="eyebrow">Published generation</p>
          <h3>Readiness and coverage</h3>
        </div>
        <button disabled={props.loading} onClick={props.onRefresh} type="button">
          {props.loading ? 'Checking…' : 'Refresh'}
        </button>
      </div>
      {props.statusError ? <p className="worksets-error">{props.statusError}</p> : null}
      {status ? (
        <>
          <div className="worksets-metrics">
            <Metric label="Catalog" value={status.catalog.state} />
            <Metric label="Current members" value={`${status.coverage.current}/${status.coverage.requested}`} />
            <Metric label="Bridge coverage" value={status.bridges?.coverage.state ?? 'unavailable'} />
            <Metric label="Exact bridges" value={String(status.bridges?.bridgeCount ?? 0)} />
          </div>
          {status.warnings.map(warning => (
            <p className="worksets-warning" key={warning}>
              {warning}
            </p>
          ))}
          <div className="worksets-member-grid">
            {status.members.map(member => {
              const definitionMember = findDefinitionMember(props.definition, member.project);
              return (
                <article key={member.project}>
                  <strong>{member.project}</strong>
                  <span className={`worksets-state is-${statusTone(member.state)}`}>{member.state}</span>
                  <small>{managerWorksetMemberLocation(definitionMember)}</small>
                  <small>
                    {member.reason ?? 'ready snapshot verified'}
                    {member.detail ? ` · code: ${member.detail.code}` : ''}
                    {member.detail?.recovery ? ` · recovery: ${member.detail.recovery}` : ''}
                    {member.detail ? ` · ${member.detail.retryable ? 'retryable' : 'not retryable'}` : ''}
                  </small>
                </article>
              );
            })}
          </div>
          {status.bridges ? (
            <p className="worksets-receipt">
              Resolver v{status.bridges.resolverVersion} · {status.bridges.coverage.repositoriesRead}/
              {status.bridges.coverage.repositoryCount} repositories read · {status.bridges.coverage.rejectionCount}{' '}
              rejected candidates
            </p>
          ) : null}
        </>
      ) : (
        <p className="worksets-muted">
          Select or refresh this workset to inspect readiness. Status never starts a build.
        </p>
      )}
    </section>
  );
}

export function PrepareJobPanel(props: {
  readonly definition?: ManagerWorksetDefinition;
  readonly job: ManagerWorksetPrepareJob;
  readonly onCancel: () => void;
}): React.ReactElement {
  const active = props.job.status === 'running' || props.job.status === 'cancelling';
  const [nowMilliseconds, setNowMilliseconds] = useState(() => Date.now());
  const elapsedProjection = useRef({jobId: props.job.id, milliseconds: 0});
  if (elapsedProjection.current.jobId !== props.job.id) {
    elapsedProjection.current = {jobId: props.job.id, milliseconds: 0};
  }
  const elapsedMilliseconds = managerWorksetJobElapsedMilliseconds(
    props.job,
    nowMilliseconds,
    elapsedProjection.current.milliseconds,
  );
  elapsedProjection.current.milliseconds = elapsedMilliseconds;
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNowMilliseconds(Date.now()), JOB_PROGRESS_CLOCK_MILLISECONDS);
    return () => window.clearInterval(timer);
  }, [active, props.job.id]);
  const allReceipts = props.job.result?.members ?? [];
  const receipts = [...allReceipts]
    .sort((left, right) => Number(left.state === 'ready') - Number(right.state === 'ready'))
    .slice(0, JOB_RECEIPTS_VISIBLE_MAXIMUM);
  return (
    <section className="worksets-job" aria-live="polite">
      <div>
        {active ? <span className="spinner" aria-hidden="true" /> : null}
        <strong>
          {props.job.workset} · {props.job.progress.phase}
        </strong>
        <span aria-live="off">{managerWorksetJobProgressMessage(props.job, nowMilliseconds, elapsedMilliseconds)}</span>
      </div>
      <progress
        aria-label={`${props.job.workset} preparation progress`}
        max={Math.max(1, props.job.progress.total)}
        value={Math.min(props.job.progress.total, props.job.progress.completed ?? 0)}
      />
      <span>
        {props.job.progress.completed ?? 0}/{props.job.progress.total} members complete
      </span>
      {active ? (
        <button disabled={props.job.status === 'cancelling'} onClick={props.onCancel} type="button">
          Stop preparation
        </button>
      ) : null}
      {props.job.error ? <p className="worksets-error">{props.job.error}</p> : null}
      {props.job.warning ? <p className="worksets-warning">{props.job.warning}</p> : null}
      {receipts.length > 0 ? (
        <div className="worksets-job-receipts">
          {receipts.map(member => (
            <article key={member.project}>
              <strong>{member.project}</strong>
              <span className={`worksets-state is-${statusTone(member.state)}`}>{member.state}</span>
              <small>{managerWorksetMemberLocation(findDefinitionMember(props.definition, member.project))}</small>
              <small>
                {member.state === 'failed'
                  ? `${member.reason} · ${member.detail.code} · ${member.detail.summary}`
                  : 'reason' in member
                    ? member.reason
                    : `${member.symbolCount} symbols projected`}
              </small>
            </article>
          ))}
          {allReceipts.length > receipts.length ? (
            <p className="worksets-muted">
              {allReceipts.length - receipts.length} additional member receipts are summarized above.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function managerWorksetJobElapsedMilliseconds(
  job: ManagerWorksetPrepareJob,
  nowMilliseconds: number,
  previousMilliseconds = 0,
): number {
  const createdAtMilliseconds = Date.parse(job.createdAt);
  const wallElapsed = Number.isFinite(createdAtMilliseconds) ? Math.max(0, nowMilliseconds - createdAtMilliseconds) : 0;
  return Math.max(0, previousMilliseconds, job.progress.elapsedMilliseconds ?? 0, wallElapsed);
}

export function managerWorksetJobProgressMessage(
  job: ManagerWorksetPrepareJob,
  nowMilliseconds: number,
  previousMilliseconds = 0,
): string {
  if (job.status !== 'running' || job.progress.phase === 'cancelled' || job.progress.phase === 'cancelling')
    return job.progress.message;
  return renderCodeGraphWorksetPrepareProgress({
    completed: job.progress.completed ?? 0,
    elapsedMilliseconds: managerWorksetJobElapsedMilliseconds(job, nowMilliseconds, previousMilliseconds),
    phase: job.progress.phase,
    total: job.progress.total,
    type: 'code-graph-workset-progress',
    version: 1,
    workset: job.workset,
    ...(job.progress.activity === undefined ? {} : {activity: job.progress.activity}),
    ...(job.progress.attempt === undefined ? {} : {attempt: job.progress.attempt}),
    ...(job.progress.maxAttempts === undefined ? {} : {maxAttempts: job.progress.maxAttempts}),
    ...(job.progress.project === undefined ? {} : {project: job.progress.project}),
  });
}

function QueryPanel(props: {
  readonly budget: number;
  readonly busy: boolean;
  readonly includeHeuristic: boolean;
  readonly includeModelAssociations: boolean;
  readonly onBudget: (value: number) => void;
  readonly onCancel: () => void;
  readonly onContinue: () => void;
  readonly onHeuristic: (value: boolean) => void;
  readonly onModelAssociations: (value: boolean) => void;
  readonly onQuery: (value: string) => void;
  readonly onRun: () => void;
  readonly onUseReference: (reference: string, target: 'from' | 'impact' | 'to') => void;
  readonly pages: readonly ProjectedCodeGraphWorksetEvidenceV1[];
  readonly query: string;
  readonly repositoryLabel: (repositoryKey: string) => string;
}): React.ReactElement {
  const latest = props.pages.at(-1)?.structuredContent;
  return (
    <section
      aria-labelledby="worksets-tab-query"
      className="worksets-card worksets-operation"
      id="worksets-panel-query"
      role="tabpanel"
    >
      <div className="worksets-form-row">
        <label>
          Concept or symbol
          <input
            onChange={event => props.onQuery(event.target.value)}
            placeholder="checkout ownership or parseManifest"
            value={props.query}
          />
        </label>
        <BudgetInput onChange={props.onBudget} value={props.budget} />
      </div>
      <div className="worksets-checks">
        <Check checked={props.includeHeuristic} label="Include heuristic support" onChange={props.onHeuristic} />
        <Check
          checked={props.includeModelAssociations}
          label="Include model associations"
          onChange={props.onModelAssociations}
        />
      </div>
      <div className="button-row">
        <button disabled={props.busy || !props.query.trim()} onClick={props.onRun} type="button">
          Search published workset
        </button>
        {props.busy ? (
          <button onClick={props.onCancel} type="button">
            Cancel request
          </button>
        ) : null}
      </div>
      {latest ? (
        <p className="worksets-receipt">
          {latest.coverage.deepQueriedRepositories}/{latest.coverage.requestedRepositories} repositories deep queried ·
          stop: {latest.coverage.stopReason} · {latest.coverage.complete ? 'complete coverage' : 'partial coverage'} ·{' '}
          {latest.output.totalCards} evidence cards{latest.output.truncated ? ' · response truncated' : ''}
        </p>
      ) : null}
      {latest?.warnings.map(warning => (
        <p className="worksets-warning" key={warning}>
          {warning}
        </p>
      ))}
      <div className="worksets-evidence-list">
        {props.pages.flatMap((page, pageIndex) =>
          page.structuredContent.cards.map(card => (
            <article key={`${pageIndex}:${card.id}`}>
              <header>
                <strong>{card.symbol.qualifiedName}</strong>
                <span>{props.repositoryLabel(card.repositoryKey)}</span>
              </header>
              <code>
                {card.symbol.path}:{card.symbol.span.line}
              </code>
              <p>{card.reason.summary}</p>
              <details className="worksets-reference-actions">
                <summary>Graph reference and traversal actions</summary>
                <code>{card.ref}</code>
                <div className="button-row">
                  <button
                    aria-label={`Use ${card.symbol.qualifiedName} as path start`}
                    onClick={() => props.onUseReference(card.ref, 'from')}
                    type="button"
                  >
                    Use as From
                  </button>
                  <button
                    aria-label={`Use ${card.symbol.qualifiedName} as path destination`}
                    onClick={() => props.onUseReference(card.ref, 'to')}
                    type="button"
                  >
                    Use as To
                  </button>
                  <button
                    aria-label={`Trace reverse impact from ${card.symbol.qualifiedName}`}
                    onClick={() => props.onUseReference(card.ref, 'impact')}
                    type="button"
                  >
                    Trace impact
                  </button>
                </div>
              </details>
              {card.relationships.map((relationship, index) => (
                <small key={`${relationship.source.ref}:${index}`}>
                  {props.repositoryLabel(relationship.source.repositoryKey)} → {relationship.relation} →{' '}
                  {props.repositoryLabel(relationship.target.repositoryKey)} · {relationship.authority} ·{' '}
                  {relationship.provenance} {Math.round(relationship.confidence * 100)}%
                </small>
              ))}
            </article>
          )),
        )}
      </div>
      {latest?.continuation ? (
        <button disabled={props.busy} onClick={props.onContinue} type="button">
          Continue · about {latest.continuation.remainingEstimate} remaining
        </button>
      ) : null}
    </section>
  );
}

function TraversalPanel(props: {
  readonly busy: boolean;
  readonly from: string;
  readonly impactQuery: string;
  readonly mode: TraversalMode;
  readonly onFrom: (value: string) => void;
  readonly onImpactQuery: (value: string) => void;
  readonly onMode: (value: TraversalMode) => void;
  readonly onRun: () => void;
  readonly onTo: (value: string) => void;
  readonly repositoryLabel: (repositoryKey: string) => string;
  readonly result?: CodeGraphCrossRepositoryTraversalResultV1;
  readonly to: string;
}): React.ReactElement {
  return (
    <section
      aria-labelledby="worksets-tab-traversal"
      className="worksets-card worksets-operation"
      id="worksets-panel-traversal"
      role="tabpanel"
    >
      <div className="segmented-control" aria-label="Traversal mode">
        <button
          className={props.mode === 'path' ? 'is-active' : undefined}
          onClick={() => props.onMode('path')}
          type="button"
        >
          Exact path
        </button>
        <button
          className={props.mode === 'impact' ? 'is-active' : undefined}
          onClick={() => props.onMode('impact')}
          type="button"
        >
          Reverse impact
        </button>
      </div>
      {props.mode === 'path' ? (
        <div className="worksets-form-row">
          <label>
            From
            <input
              id="worksets-traversal-from"
              onChange={event => props.onFrom(event.target.value)}
              placeholder="cgr_… or repository:cgp_…"
              value={props.from}
            />
          </label>
          <label>
            To
            <input
              id="worksets-traversal-to"
              onChange={event => props.onTo(event.target.value)}
              placeholder="cgr_… or repository:cgp_…"
              value={props.to}
            />
          </label>
        </div>
      ) : (
        <label>
          Starting reference
          <input
            id="worksets-traversal-impact"
            onChange={event => props.onImpactQuery(event.target.value)}
            placeholder="cgr_… or repository:cgp_…"
            value={props.impactQuery}
          />
        </label>
      )}
      <button
        disabled={props.busy || (props.mode === 'path' ? !props.from || !props.to : !props.impactQuery)}
        onClick={props.onRun}
        type="button"
      >
        {props.mode === 'path' ? 'Find authoritative path' : 'Trace reverse impact'}
      </button>
      {props.result ? (
        <>
          <div className="worksets-metrics">
            <Metric label="Stop" value={props.result.stop.reason} />
            <Metric label="Complete" value={props.result.stop.complete ? 'yes' : 'no'} />
            <Metric label="Visited" value={String(props.result.coverage.endpointsVisited)} />
            <Metric label="Scanned edges" value={String(props.result.coverage.scannedEdges)} />
          </div>
          <div className="worksets-edge-list">
            {props.result.edges.map(edge => (
              <article key={edge.id}>
                <strong>
                  {props.repositoryLabel(edge.source.repositoryKey)} →{' '}
                  {props.repositoryLabel(edge.target.repositoryKey)}
                </strong>
                <span>{edge.relation}</span>
                <small>
                  {edge.provenance.kind === 'bridge'
                    ? `exact bridge · ${edge.provenance.reason}`
                    : `${edge.provenance.relationProvenance} local edge`}
                </small>
              </article>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

function TopologyPanel(props: {
  readonly busy: boolean;
  readonly onRun: () => void;
  readonly repositoryLabel: (repositoryKey: string) => string;
  readonly result?: CodeGraphWorksetTopologyResultV1;
}): React.ReactElement {
  const topology = props.result?.topology;
  const nodeLabels = new Map(
    topology?.nodes.map(node => [node.id, topologyNodeLabel(node, props.repositoryLabel)]) ?? [],
  );
  return (
    <section
      aria-labelledby="worksets-tab-topology"
      className="worksets-card worksets-operation"
      id="worksets-panel-topology"
      role="tabpanel"
    >
      <p className="worksets-muted">
        Repository and package-component connections come only from the complete, published exact bridge set.
      </p>
      <button disabled={props.busy} onClick={props.onRun} type="button">
        Load topology
      </button>
      {props.result?.warnings.map(warning => (
        <p className="worksets-warning" key={warning}>
          {warning}
        </p>
      ))}
      {topology ? (
        <>
          <div className="worksets-metrics">
            <Metric label="Repositories" value={String(topology.receipt.repositoryCount)} />
            <Metric label="Exact bridges" value={String(topology.receipt.totalBridges)} />
            <Metric label="Nodes returned" value={String(topology.nodes.length)} />
            <Metric label="Edges returned" value={String(topology.edges.length)} />
          </div>
          <div className="worksets-topology-grid">
            <div>
              <h4>Repositories and components</h4>
              {topology.nodes.map(node => (
                <article key={node.id}>
                  <strong>{props.repositoryLabel(node.repositoryKey)}</strong>
                  <span>
                    {node.kind === 'component'
                      ? node.packageIdentities.join(', ') || 'package component'
                      : 'repository'}
                  </span>
                  <small>{node.incidentBridgeCount} incident bridges</small>
                </article>
              ))}
            </div>
            <div>
              <h4>Cross-repository edges</h4>
              {topology.edges.map(edge => (
                <article key={edge.id}>
                  <strong>
                    {nodeLabels.get(edge.sourceNodeId) ?? 'Unknown source'} →{' '}
                    {nodeLabels.get(edge.targetNodeId) ?? 'Unknown target'}
                  </strong>
                  <span>{edge.relations.map(item => `${item.value} (${item.count})`).join(', ')}</span>
                  <small>
                    {edge.bridgeCount} exact bridges · {edge.evidence.returnedCount}/{edge.evidence.totalCount} evidence
                  </small>
                </article>
              ))}
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}

function ContextBriefPanel(props: {
  readonly budget: number;
  readonly busy: boolean;
  readonly mode: ContextBriefMode;
  readonly onBudget: (value: number) => void;
  readonly onMode: (value: ContextBriefMode) => void;
  readonly onRun: () => void;
  readonly onTask: (value: string) => void;
  readonly repositoryLabel: (repositoryKey: string) => string;
  readonly result?: ProjectedContextBriefV1;
  readonly task: string;
}): React.ReactElement {
  const brief = props.result?.structuredContent;
  return (
    <section
      aria-labelledby="worksets-tab-brief"
      className="worksets-card worksets-operation"
      id="worksets-panel-brief"
      role="tabpanel"
    >
      <div className="worksets-form-row">
        <label>
          Engineering task
          <textarea
            onChange={event => props.onTask(event.target.value)}
            placeholder="Trace the checkout contract and current blockers"
            rows={3}
            value={props.task}
          />
        </label>
        <div>
          <label>
            Mode
            <select onChange={event => props.onMode(event.target.value as ContextBriefMode)} value={props.mode}>
              {CONTEXT_BRIEF_MODES.map(mode => (
                <option key={mode}>{mode}</option>
              ))}
            </select>
          </label>
          <BudgetInput onChange={props.onBudget} value={props.budget} />
        </div>
      </div>
      <button disabled={props.busy || !props.task.trim()} onClick={props.onRun} type="button">
        Compile context brief
      </button>
      {brief ? (
        <>
          <div className="worksets-metrics">
            <Metric label="Scope freshness" value={brief.scope.freshness} />
            <Metric
              label="Ready repositories"
              value={`${brief.scope.readyRepositories}/${brief.scope.requestedRepositories}`}
            />
            <Metric label="Graph cards" value={String(brief.graph.cards.length)} />
            <Metric label="Omitted items" value={String(brief.output.omittedItems)} />
          </div>
          <BriefSection
            title="Graph evidence"
            items={brief.graph.cards.map(
              card =>
                `${props.repositoryLabel(card.repositoryKey)} · ${card.symbol.qualifiedName} · ${card.symbol.path}:${card.symbol.line}`,
            )}
          />
          <BriefSection
            title="Contracts"
            items={brief.graph.contracts.map(
              contract =>
                `${props.repositoryLabel(contract.evidence.repositoryKey)} · ${contract.relation} · ${contract.authority} · ${contract.provenance}`,
            )}
          />
          <BriefSection
            title="Durable decisions"
            items={brief.durableDecisions.map(item => `${item.topic ?? item.uri} · ${item.excerpt}`)}
          />
          <BriefSection
            title="Active handoffs"
            items={brief.activeHandoffs.map(item => `${item.topic ?? item.uri} · ${item.excerpt}`)}
          />
          <BriefSection title="Staleness and conflicts" items={brief.stalenessAndConflicts.map(item => item.summary)} />
          <BriefSection title="Recommended follow-ups" items={brief.recommendedFollowUps.map(item => item.operation)} />
        </>
      ) : null}
    </section>
  );
}

function DefinitionEditor(props: {
  readonly busy: boolean;
  readonly draft: DefinitionDraft;
  readonly filter: string;
  readonly onCancel: () => void;
  readonly onChange: (draft: DefinitionDraft) => void;
  readonly onFilter: (value: string) => void;
  readonly onPage: (value: number) => void;
  readonly onSave: () => void;
  readonly onSelectedOnly: (value: boolean) => void;
  readonly page: number;
  readonly pageCount: number;
  readonly projects: readonly ManagerWorksetProjectSummary[];
  readonly selectedOnly: boolean;
  readonly totalProjects: number;
}): React.ReactElement {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialogRef.current?.querySelector<HTMLElement>('input, button, textarea')?.focus();
    return () => previous?.focus();
  }, []);
  const update = (change: Partial<DefinitionDraft>) => props.onChange({...props.draft, ...change});
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape' && !props.busy) {
      event.preventDefault();
      props.onCancel();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const controls = [
      ...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled)',
      ),
    ];
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="worksets-editor-backdrop" role="presentation">
      <section
        aria-labelledby="workset-definition-title"
        aria-modal="true"
        className="worksets-editor"
        onKeyDown={onKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <header>
          <div>
            <p className="eyebrow">Authoritative manifest</p>
            <h2 id="workset-definition-title">{props.draft.mode === 'create' ? 'Create workset' : 'Edit workset'}</h2>
          </div>
          <button aria-label="Close workset editor" disabled={props.busy} onClick={props.onCancel} type="button">
            ×
          </button>
        </header>
        <label>
          Name
          <input autoFocus onChange={event => update({name: event.target.value})} value={props.draft.name} />
        </label>
        <label>
          Description
          <textarea
            onChange={event => update({description: event.target.value})}
            rows={3}
            value={props.draft.description}
          />
        </label>
        <label>
          Find projects
          <input
            onChange={event => props.onFilter(event.target.value)}
            placeholder="Filter manifest projects"
            type="search"
            value={props.filter}
          />
        </label>
        <p className="worksets-muted">
          {props.draft.projects.size} selected · {props.totalProjects} matching projects
        </p>
        <div className="worksets-project-picker-controls">
          <button onClick={() => props.onSelectedOnly(!props.selectedOnly)} type="button">
            {props.selectedOnly ? 'Show all projects' : 'Show selected only'}
          </button>
          <span>
            Page {props.pageCount === 0 ? 0 : props.page + 1} of {props.pageCount}
          </span>
          <button
            aria-label="Previous projects"
            disabled={props.page === 0}
            onClick={() => props.onPage(props.page - 1)}
            type="button"
          >
            Previous
          </button>
          <button
            aria-label="Next projects"
            disabled={props.page + 1 >= props.pageCount}
            onClick={() => props.onPage(props.page + 1)}
            type="button"
          >
            Next
          </button>
        </div>
        <div className="worksets-project-picker">
          {props.projects.map(project => (
            <label key={project.name}>
              <input
                checked={hasProjectSelection(props.draft.projects, project.name)}
                onChange={event => {
                  const projects = new Set(props.draft.projects);
                  for (const selected of projects) {
                    if (selected.toLowerCase() === project.name.toLowerCase()) projects.delete(selected);
                  }
                  if (event.target.checked) projects.add(project.name);
                  update({projects});
                }}
                type="checkbox"
              />
              <span>
                <strong>{project.name}</strong>
                <small>{managerWorksetProjectLocation(project)}</small>
              </span>
            </label>
          ))}
        </div>
        <footer>
          <button disabled={props.busy} onClick={props.onCancel} type="button">
            Cancel
          </button>
          <button
            disabled={props.busy || !props.draft.name.trim() || props.draft.projects.size === 0}
            onClick={props.onSave}
            type="button"
          >
            {props.busy ? 'Saving…' : 'Save definition'}
          </button>
        </footer>
      </section>
    </div>
  );
}

function BudgetInput(props: {readonly onChange: (value: number) => void; readonly value: number}): React.ReactElement {
  return (
    <label>
      Token budget
      <input
        max={1_500}
        min={1}
        onChange={event => props.onChange(Number(event.target.value))}
        type="number"
        value={props.value}
      />
    </label>
  );
}

function Check(props: {
  readonly checked: boolean;
  readonly label: string;
  readonly onChange: (value: boolean) => void;
}): React.ReactElement {
  return (
    <label>
      <input checked={props.checked} onChange={event => props.onChange(event.target.checked)} type="checkbox" />
      <span>{props.label}</span>
    </label>
  );
}

function Metric(props: {readonly label: string; readonly value: string}): React.ReactElement {
  return (
    <div>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function BriefSection(props: {readonly items: readonly string[]; readonly title: string}): React.ReactElement | null {
  if (props.items.length === 0) return null;
  return (
    <section className="worksets-brief-section">
      <h4>{props.title}</h4>
      {props.items.map((item, index) => (
        <p key={`${index}:${item}`}>{item}</p>
      ))}
    </section>
  );
}

function statusTone(state: string): 'fail' | 'ok' | 'warn' {
  return state === 'current' || state === 'ready' ? 'ok' : state === 'failed' || state === 'missing' ? 'fail' : 'warn';
}

function topologyNodeLabel(
  node: NonNullable<CodeGraphWorksetTopologyResultV1['topology']>['nodes'][number],
  repositoryLabel: (repositoryKey: string) => string,
): string {
  return node.kind === 'repository'
    ? repositoryLabel(node.repositoryKey)
    : `${repositoryLabel(node.repositoryKey)} / ${node.packageIdentities.join(', ') || 'package component'}`;
}

export function managerWorksetRepositoryLabel(repositoryKey: string, definition?: ManagerWorksetDefinition): string {
  const member = findDefinitionMember(definition, repositoryKey);
  return member ? `${member.project} · ${managerWorksetMemberLocation(member)}` : opaqueRepositoryLabel(repositoryKey);
}

function findDefinitionMember(
  definition: ManagerWorksetDefinition | undefined,
  project: string,
): ManagerWorksetDefinition['members'][number] | undefined {
  return definition?.members.find(member => member.project.toLowerCase() === project.toLowerCase());
}

function managerWorksetMemberLocation(member: ManagerWorksetDefinition['members'][number] | undefined): string {
  if (!member) return 'branch and local folder unavailable';
  return managerWorksetLocation(member.branchState, member.branch, member.folder, member.path);
}

function managerWorksetProjectLocation(project: ManagerWorksetProjectSummary): string {
  return managerWorksetLocation(project.branchState, project.branch, project.folder, project.path);
}

function managerWorksetProjectSearchText(project: ManagerWorksetProjectSummary): string {
  return [project.name, project.branch, project.folder, project.path].filter(Boolean).join('\n').toLowerCase();
}

function managerWorksetProjectRank(project: ManagerWorksetProjectSummary, query: string): number {
  if (!query) return 0;
  const name = project.name.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  return 3;
}

function hasProjectSelection(projects: ReadonlySet<string>, project: string): boolean {
  const key = project.toLowerCase();
  return [...projects].some(selected => selected.toLowerCase() === key);
}

function managerWorksetLocation(
  branchState: ManagerWorksetProjectSummary['branchState'],
  branch: string | undefined,
  folder: string | undefined,
  path: string | undefined,
): string {
  const branchLabel =
    branchState === 'current' && branch
      ? `observed branch ${branch}`
      : branchState === 'detached'
        ? 'observed detached checkout'
        : branchState === 'not-observed'
          ? 'branch observation deferred'
          : 'branch observation unavailable';
  return [branchLabel, folder, path]
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join(' · ');
}

function opaqueRepositoryLabel(repositoryKey: string): string {
  const value = repositoryKey.trim();
  return /^(?:[a-f\d]{24,}|(?:checkout|repository|worktree|repo)[_:-][a-z\d_-]{16,})$/iu.test(value)
    ? `Repository ${value.slice(0, 8)}…`
    : value || 'Unknown repository';
}
