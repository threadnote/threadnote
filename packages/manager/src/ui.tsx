import React, {useEffect, useMemo, useReducer, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {CodeGraphLocalDiagnosticsReport} from '@threadnote/graph/diagnostics';
import {ContextPanel} from './context/view.js';
import {ManagerAutocompleteInput, ManagerDialogProvider, useManagerDialogs} from '@threadnote/manager/dialog';
import {WorksetsPanel} from '@threadnote/manager/worksets_view';
import {ProcessesPanel} from './processes_view.js';
import {ManagerHomePanel} from './home_view.js';
import {ContextHealthPanel, ReviewsPanel} from './attention_view.js';
import {LibraryExplorer} from './library_explorer.js';
import {settleManagerRefreshTasks} from '@threadnote/manager/refresh';
import {DropdownSelect, MarkdownViewer, Metadata, TargetFields} from '@threadnote/manager/ui/controls';
import {
  initialManagerAvailability,
  managerActionsAreAvailable,
  managerAvailabilityTransition,
  managerSelectionIsReadable,
  reconcileManagerDraft,
  type ManagerDraft,
} from '@threadnote/manager/connection';
import {managerUpdateIndicator} from '@threadnote/manager/update_indicator';
import {
  graphViewRemovalApprovalDialog,
  graphViewRemovalTargetIsAbsent,
  type ManagerGraphViewRemovalResponse,
  withoutRemovedGraphCatalogView,
  withoutRemovedGraphDiagnosticsView,
} from '@threadnote/manager/graph/removal';
import {
  GraphWorkspace,
  graphBuildIsActive,
  graphCatalogRequiresAuthoritativeRefresh,
  graphCompletedBuildResultIdentity,
  graphDiagnosticsRequiresCatalogRefresh,
  graphMaintenanceStatusLabel,
  graphStatusPollDelay,
  graphStatusRequiresCatalogRefresh,
  mergeGraphCatalogStatus,
  type GraphAdministrationAction,
  type GraphCatalog,
} from '@threadnote/manager/graph';
import {
  GRAPH_CATALOG_REQUEST_TIMEOUT_MILLISECONDS,
  SharesPanel,
  actionProgressLabel,
  api,
  clampSidebarWidth,
  bulkActionLabel,
  canPublishMemoryFromManager,
  canPublishSelectedMemoriesFromManager,
  countFiles,
  errorMessage,
  findNodeInTrees,
  formatBulkResults,
  graphAdministrationActionLabel,
  isAgentClient,
  isMarkdownNode,
  isMarkdownUri,
  isResourceUri,
  loadSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  loadManagerGraph,
  loadManagerGraphAnalysis,
  loadManagerGraphCatalogPage,
  loadManagerGraphNodeDetail,
  loadManagerGraphQuery,
  loadManagerGraphViewsPage,
  managerProjectOptions,
  markdownBodyForPreview,
  panelDescription,
  panelIcon,
  panelNavDescription,
  pruneSelectedMemoryUris,
  resourceUrisFromText,
  selectableMemoryUris,
  tabTitle,
  uniqueSelectorValues,
} from '@threadnote/manager/ui/support';

export {
  graphAdministrationActionLabel,
  managerProjectOptions,
  pruneSelectedMemoryUris,
  selectableMemoryUris,
} from '@threadnote/manager/ui/support';

import type {
  BulkItemResult,
  MemoryMetadata,
  PanelName,
  SelectId,
  ShareSummary,
  TargetForm,
  TreeNode,
} from '@threadnote/manager/ui/contracts';
export type {
  BulkItemResult,
  MemoryMetadata,
  PanelName,
  SelectId,
  ShareSummary,
  TargetForm,
  TreeNode,
} from '@threadnote/manager/ui/contracts';

type NavTreeTab = 'memories' | 'resources';
type CheckStatus = 'fail' | 'ok' | 'warn';
type AgentClient = 'claude' | 'codex' | 'copilot' | 'cursor' | 'effect-ai';
type MemoryViewMode = 'edit' | 'preview';

interface MemoryResponse {
  readonly content: string;
  readonly node: TreeNode;
  readonly record?: {
    readonly body: string;
    readonly content: string;
    readonly metadata: MemoryMetadata;
    readonly uri: string;
  };
}
interface ReadResponse {
  readonly content: string;
  readonly localMemory?: MemoryResponse;
  readonly output: string;
}

interface TreeResponse {
  readonly resourcesTree: TreeNode;
  readonly tree: TreeNode;
}

interface AgentOption {
  readonly available: boolean;
  readonly command?: string;
  readonly id: AgentClient;
  readonly label: string;
}

interface StateResponse {
  readonly agents: readonly AgentOption[];
  readonly autoUpdate: {
    readonly effectivePolicy: 'automatic' | 'notify';
    readonly lastFailure?: {readonly attempt: number; readonly failedAt: string; readonly summary: string};
    readonly lastSuccess?: {
      readonly completedAt: string;
      readonly fromVersion: string;
      readonly repairRequired: boolean;
      readonly toVersion: string;
    };
    readonly running?: {readonly attempt: number; readonly fromVersion: string; readonly startedAt: string};
  };
  readonly config: {
    readonly account: string;
    readonly agentContextHome: string;
    readonly user: string;
  };
  readonly latestVersion?: string;
  readonly updateAvailable: boolean;
  readonly version: string;
}

interface DoctorCheck {
  readonly detail: string;
  readonly name: string;
  readonly status: CheckStatus;
}

interface ConsolidationJob {
  readonly agent: AgentClient;
  readonly draft?: string;
  readonly error?: string;
  readonly id: string;
  readonly sourceUris: readonly string[];
  readonly status: 'completed' | 'failed' | 'running';
}

const EMPTY_SELECTED_URIS: ReadonlySet<string> = new Set();

function App(): React.ReactElement {
  const dialogs = useManagerDialogs();
  const [panel, setPanel] = useState<PanelName>('home');
  const [state, setState] = useState<StateResponse | undefined>();
  const [graphCatalog, setGraphCatalog] = useState<GraphCatalog | undefined>();
  const [graphCatalogError, setGraphCatalogError] = useState('');
  const graphCatalogRef = useRef<GraphCatalog | undefined>(undefined);
  const graphCatalogAuthoritativeRef = useRef(false);
  const [graphDiagnostics, setGraphDiagnostics] = useState<CodeGraphLocalDiagnosticsReport | undefined>();
  const graphDiagnosticsCatalogRevisionRef = useRef<string | undefined>(undefined);
  const [graphAdministrationBusy, setGraphAdministrationBusy] = useState<string | undefined>();
  const [graphAdministrationOutput, setGraphAdministrationOutput] = useState('');
  const [tree, setTree] = useState<TreeNode | undefined>();
  const [resourceTree, setResourceTree] = useState<TreeNode | undefined>();
  const [shares, setShares] = useState<readonly ShareSummary[]>([]);
  const [doctor, setDoctor] = useState<readonly DoctorCheck[]>([]);
  const [doctorOutput, setDoctorOutput] = useState('');
  const [doctorAction, setDoctorAction] = useState<string | undefined>();
  const [selectedUri, setSelectedUri] = useState<string | undefined>();
  const [selectedUris, setSelectedUris] = useState<ReadonlySet<string>>(new Set());
  const [memory, setMemory] = useState<MemoryResponse | undefined>();
  const [loadedUri, setLoadedUri] = useState<string | undefined>();
  const canonicalizedSelectionRef = useRef<string | undefined>(undefined);
  const draftRef = useRef<ManagerDraft | undefined>(undefined);
  const [pendingCanonical, setPendingCanonical] = useState<MemoryResponse | undefined>();
  const [availability, dispatchAvailability] = useReducer(managerAvailabilityTransition, initialManagerAvailability);
  const [content, setContent] = useState('');
  const [memoryViewMode, setMemoryViewMode] = useState<MemoryViewMode>('edit');
  const [openSelect, setOpenSelect] = useState<SelectId | undefined>();
  const [filter, setFilter] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const [navTreeTab, setNavTreeTab] = useState<NavTreeTab>('memories');
  const [toast, setToast] = useState('');
  const [output, setOutput] = useState('');
  const [recallQuery, setRecallQuery] = useState('');
  const [recallProject, setRecallProject] = useState('');
  const [readUri, setReadUri] = useState('');
  const [compactProject, setCompactProject] = useState('');
  const [workspaceProject, setWorkspaceProject] = useState('');
  const [compactTopic, setCompactTopic] = useState('');
  const [packPath, setPackPath] = useState('');
  const [selectedShare, setSelectedShare] = useState('');
  const [shareTeam, setShareTeam] = useState('');
  const [shareRemote, setShareRemote] = useState('');
  const [renameShareTo, setRenameShareTo] = useState('');
  const [shareNewUrl, setShareNewUrl] = useState('');
  const [preserveShare, setPreserveShare] = useState(true);
  const [keepShareFiles, setKeepShareFiles] = useState(false);
  const [target, setTarget] = useState<TargetForm>({
    kind: 'durable',
    project: '',
    status: 'active',
    team: '',
    topic: '',
  });
  const [agent, setAgent] = useState<AgentClient>('codex');
  const [draft, setDraft] = useState('');
  const [jobId, setJobId] = useState<string | undefined>();
  const [draftingConsolidation, setDraftingConsolidation] = useState(false);
  const [applyingConsolidation, setApplyingConsolidation] = useState(false);
  const [consolidationSourceUris, setConsolidationSourceUris] = useState<readonly string[]>([]);
  const [bulkAction, setBulkAction] = useState<'archive' | 'forget' | 'publish' | undefined>();
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [attentionRefreshGeneration, setAttentionRefreshGeneration] = useState(0);
  const [libraryError, setLibraryError] = useState('');

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void api<{readonly status: 'ok'}>('/api/health').then(
        () => {
          if (availability.runtime === 'disconnected') void refreshAll();
        },
        () => dispatchAvailability('runtime-lost'),
      );
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [availability.runtime]);

  useEffect(() => {
    if (panel === 'doctor') {
      void loadDoctor(false);
    }
    if (panel === 'graph' && !graphDiagnostics) {
      void refreshGraphDiagnostics({analyze: false, deep: false}, false);
    }
  }, [panel]);

  useEffect(() => {
    if (panel !== 'graph') return;
    let cancelled = false;
    let timer: number | undefined;
    let observedActiveBuild = false;
    let observedActiveMaintenance = false;
    const acknowledgedCompletedResults = new Set<string>();
    const poll = async (): Promise<void> => {
      try {
        const status = await api<
          Pick<
            GraphCatalog,
            | 'automaticCompaction'
            | 'builds'
            | 'catalogRevision'
            | 'lifecyclePending'
            | 'maintenance'
            | 'waiterCount'
            | 'waiters'
          >
        >('/api/graphs/status', undefined, {timeoutMilliseconds: GRAPH_CATALOG_REQUEST_TIMEOUT_MILLISECONDS});
        if (cancelled) return;
        const active = status.builds.some(graphBuildIsActive);
        const activeMaintenance = status.maintenance !== undefined;
        const refreshCatalog =
          graphCatalogRequiresAuthoritativeRefresh(graphCatalogAuthoritativeRef.current, status.maintenance) ||
          (!activeMaintenance &&
            ((observedActiveBuild && !active) ||
              (observedActiveMaintenance && !activeMaintenance) ||
              graphStatusRequiresCatalogRefresh(
                graphCatalogRef.current,
                status.builds,
                acknowledgedCompletedResults,
                status.catalogRevision,
              )));
        if (refreshCatalog) {
          const refreshed = await api<GraphCatalog>('/api/graphs', undefined, {
            timeoutMilliseconds: GRAPH_CATALOG_REQUEST_TIMEOUT_MILLISECONDS,
          });
          if (cancelled) return;
          const refreshedWithStatus = mergeGraphCatalogStatus(refreshed, status);
          graphCatalogAuthoritativeRef.current = true;
          graphCatalogRef.current = refreshedWithStatus;
          setGraphCatalog(refreshedWithStatus);
          setGraphCatalogError('');
          for (const build of status.builds) {
            const identity = graphCompletedBuildResultIdentity(build);
            if (identity) acknowledgedCompletedResults.add(identity);
          }
        } else {
          const merged = mergeGraphCatalogStatus(graphCatalogRef.current, status);
          graphCatalogRef.current = merged;
          setGraphCatalog(merged);
        }
        if (
          graphDiagnosticsRequiresCatalogRefresh(
            graphDiagnosticsCatalogRevisionRef.current,
            status.catalogRevision,
            status.maintenance,
          )
        ) {
          await refreshGraphDiagnostics({analyze: false, deep: false}, false, true, status.catalogRevision);
          if (cancelled) return;
        }
        observedActiveBuild = active;
        observedActiveMaintenance = activeMaintenance;
        timer = window.setTimeout(
          () => void poll(),
          graphStatusPollDelay(status.builds, status.maintenance, status.lifecyclePending, status.automaticCompaction),
        );
      } catch {
        if (!cancelled) timer = window.setTimeout(() => void poll(), 15_000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [panel]);

  useEffect(() => {
    setSelectedUris(current => pruneSelectedMemoryUris(current, tree, {filter, showSystem}));
  }, [filter, showSystem, tree]);

  useEffect(() => {
    if (!selectedUri) {
      dispatchAvailability('selection-cleared');
      setMemory(undefined);
      setLoadedUri(undefined);
      setMemoryViewMode('edit');
      return;
    }
    const node = findNodeInTrees([tree, resourceTree], selectedUri);
    if (node?.isDir) {
      dispatchAvailability('selection-cleared');
      setMemory(undefined);
      setLoadedUri(undefined);
      setContent('');
      setMemoryViewMode('preview');
      setTarget({kind: 'durable', project: '', status: 'active', team: node.sharedTeam ?? '', topic: ''});
      return;
    }
    if (
      canonicalizedSelectionRef.current === selectedUri &&
      selectedUri === loadedUri &&
      memory?.node.uri === selectedUri
    ) {
      canonicalizedSelectionRef.current = undefined;
      dispatchAvailability('selection-ready');
      return;
    }
    canonicalizedSelectionRef.current = undefined;
    let cancelled = false;
    const requestedUri = selectedUri;
    dispatchAvailability('selection-started');
    setMemory(undefined);
    setLoadedUri(undefined);
    if (draftRef.current?.uri !== selectedUri) setContent('');
    void (
      isResourceUri(selectedUri)
        ? loadResource(selectedUri, () => !cancelled)
        : loadMemory(selectedUri, () => !cancelled)
    )
      .then(resolvedUri => {
        if (cancelled) return;
        if (resolvedUri && resolvedUri !== requestedUri) {
          canonicalizedSelectionRef.current = resolvedUri;
          setSelectedUri(resolvedUri);
        }
        dispatchAvailability('selection-ready');
      })
      .catch(() => {
        if (!cancelled) dispatchAvailability('selection-failed');
      });
    return () => {
      cancelled = true;
    };
  }, [resourceTree, selectedUri, tree]);

  useEffect(() => {
    const firstAvailable =
      state?.agents.find(item => item.available && (item.id === 'codex' || item.id === 'claude')) ??
      state?.agents.find(item => item.available);
    if (firstAvailable) {
      setAgent(firstAvailable.id);
    }
  }, [state]);

  const selectedNode = useMemo(
    () => (selectedUri ? findNodeInTrees([tree, resourceTree], selectedUri) : undefined),
    [resourceTree, selectedUri, tree],
  );
  const visibleSelectedUris = useMemo(
    () =>
      navTreeTab === 'memories'
        ? pruneSelectedMemoryUris(selectedUris, tree, {filter, showSystem})
        : EMPTY_SELECTED_URIS,
    [filter, navTreeTab, selectedUris, showSystem, tree],
  );
  const selectedList = useMemo(() => [...visibleSelectedUris], [visibleSelectedUris]);
  const canBulkPublish = useMemo(() => canPublishSelectedMemoriesFromManager(tree, selectedList), [tree, selectedList]);
  const outputUris = useMemo(() => resourceUrisFromText(output), [output]);
  const projectOptions = useMemo(
    () =>
      uniqueSelectorValues([
        ...managerProjectOptions(tree),
        ...(graphCatalog?.configuredProjects ?? []).map(project => project.name),
      ]),
    [graphCatalog?.configuredProjects, tree],
  );
  useEffect(() => {
    if (projectOptions.includes(workspaceProject)) return;
    setWorkspaceProject(projectOptions[0] ?? '');
  }, [projectOptions, workspaceProject]);
  const teamOptions = useMemo(
    () => uniqueSelectorValues(['default', ...shares.map(share => share.name), target.team]),
    [shares, target.team],
  );

  async function refreshAll(): Promise<void> {
    let nextTree: TreeResponse | undefined;
    const failures = await settleManagerRefreshTasks([
      {
        label: 'Graph indexes',
        run: async () => {
          try {
            const catalog = await api<GraphCatalog>('/api/graphs', undefined, {
              timeoutMilliseconds: GRAPH_CATALOG_REQUEST_TIMEOUT_MILLISECONDS,
            });
            graphCatalogAuthoritativeRef.current = true;
            graphCatalogRef.current = catalog;
            setGraphCatalog(catalog);
            setGraphCatalogError('');
          } catch (cause) {
            setGraphCatalogError(errorMessage(cause));
            throw cause;
          }
        },
      },
      {
        label: 'Runtime',
        run: async () => {
          try {
            setState(await api<StateResponse>('/api/state'));
            dispatchAvailability('runtime-ready');
          } catch (cause) {
            dispatchAvailability('runtime-lost');
            throw cause;
          }
        },
      },
      {
        label: 'Memory library',
        run: async () => {
          try {
            nextTree = await api<TreeResponse>('/api/tree');
            setLibraryError('');
          } catch (cause) {
            setLibraryError(errorMessage(cause));
            throw cause;
          }
        },
      },
      {
        label: 'Shares',
        run: async () => setShares((await api<{shares: readonly ShareSummary[]}>('/api/shares')).shares),
      },
    ]);
    if (nextTree) {
      setTree(nextTree.tree);
      setResourceTree(nextTree.resourcesTree);
    }
    setAttentionRefreshGeneration(generation => generation + 1);
    toastMessage(failures.length === 0 ? 'Refreshed' : `Refresh incomplete · ${failures.join(' · ')}`);
  }

  async function refreshGraphCatalog(notify = true): Promise<void> {
    try {
      const next = await api<GraphCatalog>('/api/graphs', undefined, {
        timeoutMilliseconds: GRAPH_CATALOG_REQUEST_TIMEOUT_MILLISECONDS,
      });
      graphCatalogAuthoritativeRef.current = true;
      graphCatalogRef.current = next;
      setGraphCatalog(next);
      setGraphCatalogError('');
      if (notify) toastMessage('Graph indexes refreshed');
    } catch (cause) {
      const message = errorMessage(cause);
      setGraphCatalogError(message);
      toastMessage(message);
    }
  }

  async function refreshGraphDiagnostics(
    options: {readonly analyze: boolean; readonly deep: boolean},
    notify = true,
    background = false,
    catalogRevision = graphCatalogRef.current?.catalogRevision,
  ): Promise<boolean> {
    if (!background) {
      setGraphAdministrationBusy(
        options.deep ? 'Deep-checking graphs' : options.analyze ? 'Analyzing graphs' : 'Diagnosing graphs',
      );
    }
    try {
      const report = await api<CodeGraphLocalDiagnosticsReport>(
        `/api/graphs/diagnostics?analyze=${options.analyze}&deep=${options.deep}`,
      );
      setGraphDiagnostics(report);
      graphDiagnosticsCatalogRevisionRef.current = catalogRevision;
      if (!background) setGraphAdministrationOutput('');
      if (notify) toastMessage('Graph diagnostics refreshed');
      return true;
    } catch (cause) {
      if (background) return false;
      const message = errorMessage(cause);
      setGraphAdministrationOutput(message);
      toastMessage(message);
      return false;
    } finally {
      if (!background) setGraphAdministrationBusy(undefined);
    }
  }

  async function runGraphAdministration(action: GraphAdministrationAction): Promise<void> {
    const label = graphAdministrationActionLabel(action);
    setGraphAdministrationBusy(label);
    try {
      let result: {readonly output: string};
      let removedViewConfirmed = false;
      if (action.action === 'remove-view' && action.dryRun !== true) {
        const preview = await api<ManagerGraphViewRemovalResponse>('/api/graphs/action', {
          ...action,
          dryRun: true,
        });
        const approvalDialog = graphViewRemovalApprovalDialog(preview);
        if (approvalDialog && !(await dialogs.confirm(approvalDialog))) {
          setGraphAdministrationOutput(preview.output);
          return;
        }
        const removal = approvalDialog
          ? await api<ManagerGraphViewRemovalResponse>('/api/graphs/action', {
              ...action,
              approvalDigest: preview.approvalDigest,
              confirm: true,
            })
          : preview;
        result = removal;
        removedViewConfirmed = graphViewRemovalTargetIsAbsent(removal);
        if (removedViewConfirmed) projectRemovedGraphView(action);
      } else {
        result = await api<{readonly output: string}>('/api/graphs/action', {
          ...action,
          confirm: !('dryRun' in action) || action.dryRun !== true,
        });
      }
      await refreshGraphCatalog(false);
      await refreshGraphDiagnostics({analyze: false, deep: false}, false);
      if (removedViewConfirmed && action.action === 'remove-view') projectRemovedGraphView(action);
      setGraphAdministrationOutput(result.output);
      toastMessage(`${label} complete`);
    } catch (cause) {
      const message = errorMessage(cause);
      setGraphAdministrationOutput(message);
      toastMessage(message);
    } finally {
      setGraphAdministrationBusy(undefined);
    }
  }

  function projectRemovedGraphView(target: Extract<GraphAdministrationAction, {readonly action: 'remove-view'}>): void {
    const nextCatalog = withoutRemovedGraphCatalogView(graphCatalogRef.current, target);
    graphCatalogRef.current = nextCatalog;
    setGraphCatalog(nextCatalog);
    setGraphDiagnostics(current => withoutRemovedGraphDiagnosticsView(current, target));
  }

  async function loadMemory(uri: string, accept: () => boolean = () => true): Promise<string | undefined> {
    const next = await api<MemoryResponse>(`/api/memory?uri=${encodeURIComponent(uri)}`);
    if (!accept()) return undefined;
    showMemory(next);
    return next.node.uri;
  }

  function showMemory(next: MemoryResponse): void {
    setMemory(next);
    setLoadedUri(next.node.uri);
    const reconciled = reconcileManagerDraft(draftRef.current, {content: next.content, uri: next.node.uri});
    setContent(reconciled.content);
    setPendingCanonical(reconciled.needsReview ? next : undefined);
    setMemoryViewMode(isMarkdownNode(next.node) ? 'preview' : 'edit');
    setTarget({
      kind: next.record?.metadata.kind ?? 'durable',
      project: next.record?.metadata.project ?? '',
      status: next.record?.metadata.status ?? 'active',
      team: next.node.sharedTeam ?? '',
      topic: next.record?.metadata.topic ?? '',
    });
  }

  async function loadResource(uri: string, accept: () => boolean = () => true): Promise<string | undefined> {
    const result = await api<ReadResponse>('/api/read', {uri});
    if (!accept()) return undefined;
    setMemory(undefined);
    setLoadedUri(uri);
    setContent(result.content || result.output);
    setOutput(result.output || result.content);
    setReadUri(uri);
    setMemoryViewMode(isMarkdownUri(uri) ? 'preview' : 'edit');
    setTarget({kind: 'durable', project: '', status: 'active', team: '', topic: ''});
    return uri;
  }

  async function readContext(uri: string): Promise<void> {
    const trimmed = uri.trim();
    if (!trimmed) {
      toastMessage('Provide a Threadnote URI');
      return;
    }
    try {
      const result = await api<ReadResponse>('/api/read', {uri: trimmed});
      setOutput(result.output || result.content);
      setReadUri(trimmed);
      if (result.localMemory) {
        setSelectedUri(result.localMemory.node.uri);
        showMemory(result.localMemory);
      }
      toastMessage('Read complete');
    } catch (err) {
      toastMessage(errorMessage(err));
    }
  }

  function toastMessage(message: string): void {
    setToast(message);
    window.setTimeout(() => setToast(current => (current === message ? '' : current)), 3000);
  }

  async function runAction(label: string, action: () => Promise<{readonly output?: string}>): Promise<void> {
    try {
      const result = await action();
      if (result.output) {
        setOutput(result.output);
      }
      toastMessage(label);
      await refreshTreeOnly();
      if (selectedUri) {
        await reloadSelected(selectedUri);
      }
    } catch (err) {
      toastMessage(errorMessage(err));
    }
  }

  async function runDoctorAction(
    label: string,
    busyLabel: string,
    action: () => Promise<{readonly output?: string}>,
  ): Promise<void> {
    if (doctorAction) {
      return;
    }
    setDoctorAction(busyLabel);
    try {
      const result = await action();
      setDoctorOutput(result.output ?? '');
      toastMessage(label);
      await loadDoctorChecks();
    } catch (err) {
      toastMessage(errorMessage(err));
    } finally {
      setDoctorAction(undefined);
    }
  }

  async function refreshTreeOnly(): Promise<void> {
    const next = await api<TreeResponse>('/api/tree');
    setLibraryError('');
    setTree(next.tree);
    setResourceTree(next.resourcesTree);
  }

  async function reloadSelected(uri: string): Promise<void> {
    if (isResourceUri(uri)) {
      await loadResource(uri).catch(() => undefined);
    } else {
      await loadMemory(uri).catch(() => undefined);
    }
  }

  async function saveCurrent(): Promise<void> {
    await runAction('Saved memory', () =>
      api<{readonly output?: string}>('/api/memory/save', {
        kind: target.kind,
        project: target.project,
        expectedContent: memory?.content,
        replaceUri: memory?.node.uri,
        status: target.status,
        text: content,
        topic: target.topic,
      }).then(result => {
        draftRef.current = undefined;
        return result;
      }),
    );
  }

  async function newMemory(): Promise<void> {
    setSelectedUri(undefined);
    setMemory(undefined);
    setContent('');
    setMemoryViewMode('edit');
    setTarget({kind: 'durable', project: '', status: 'active', team: '', topic: ''});
    toastMessage('New memory draft');
  }

  async function saveNew(): Promise<void> {
    await runAction('Stored memory', () =>
      api('/api/memory/save', {
        kind: target.kind,
        project: target.project,
        status: target.status,
        text: content,
        topic: target.topic,
      }),
    );
  }

  async function archiveCurrent(): Promise<void> {
    if (!selectedUri) return;
    const confirmed = await dialogs.confirm({
      confirmLabel: 'Archive memory',
      detail: selectedUri,
      message: 'The memory stays available in the archive and can be restored later.',
      title: 'Archive this memory?',
    });
    if (!confirmed) return;
    await runAction('Archived memory', () => api('/api/memory/archive', {confirm: true, uri: selectedUri}));
  }

  async function forgetCurrent(): Promise<void> {
    if (!selectedUri) return;
    const forgottenUri = selectedUri;
    const confirmed = await dialogs.confirm({
      confirmLabel: 'Forget memory',
      detail: forgottenUri,
      message: 'This permanently removes the memory from local context.',
      title: 'Forget this memory?',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      await api('/api/memory/forget', {confirm: true, uri: forgottenUri});
      if (draftRef.current?.uri === forgottenUri) draftRef.current = undefined;
      setPendingCanonical(current => (current?.node.uri === forgottenUri ? undefined : current));
      setSelectedUri(undefined);
      setMemory(undefined);
      setContent('');
      setTarget({kind: 'durable', project: '', status: 'active', team: '', topic: ''});
      await refreshTreeOnly();
      toastMessage('Forgot memory');
    } catch (cause) {
      toastMessage(errorMessage(cause));
    }
  }

  async function removeFolderCurrent(): Promise<void> {
    if (!selectedNode?.isDir) {
      return;
    }
    if (!selectedNode.relativePath) {
      toastMessage('The root memories folder cannot be removed');
      return;
    }
    if (selectedNode.isShared) {
      toastMessage('Use Sharing to remove shared folders');
      return;
    }
    const fileCount = countFiles(selectedNode);
    const confirmed = await dialogs.confirm({
      confirmLabel: 'Remove folder',
      detail: selectedNode.uri,
      message: `This permanently removes ${fileCount} memory file${fileCount === 1 ? '' : 's'} from local context.`,
      title: 'Remove this folder?',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      const result = await api<{readonly output?: string}>('/api/folder/remove', {
        confirm: true,
        uri: selectedNode.uri,
      });
      if (result.output) {
        setOutput(result.output);
      }
      setSelectedUri(undefined);
      setSelectedUris(new Set());
      setMemory(undefined);
      setContent('');
      await refreshTreeOnly();
      toastMessage('Removed folder');
    } catch (err) {
      toastMessage(errorMessage(err));
    }
  }

  async function publishCurrent(): Promise<void> {
    if (!selectedUri) return;
    const values = await dialogs.prompt({
      confirmLabel: 'Publish memory',
      detail: selectedUri,
      fields: [
        {
          id: 'team',
          initialValue: target.team || 'default',
          label: 'Team',
          options: teamOptions,
          required: true,
        },
      ],
      message: 'Publish this personal durable memory to a configured shared repository.',
      title: 'Publish memory',
    });
    if (!values) return;
    await runAction('Published memory', () =>
      api('/api/memory/publish', {confirm: true, team: values.team, uri: selectedUri}),
    );
  }

  async function unpublishCurrent(): Promise<void> {
    if (!selectedUri) return;
    const confirmed = await dialogs.confirm({
      confirmLabel: 'Unpublish memory',
      detail: selectedUri,
      message: 'Remove this memory from its shared repository projection.',
      title: 'Unpublish this memory?',
      tone: 'danger',
    });
    if (!confirmed) return;
    await runAction('Unpublished memory', () =>
      api('/api/memory/unpublish', {confirm: true, team: target.team, uri: selectedUri}),
    );
  }

  async function moveCurrent(): Promise<void> {
    if (!selectedUri) return;
    const values = await dialogs.prompt({
      confirmLabel: 'Move memory',
      detail: selectedUri,
      fields: [
        {
          allowCreate: true,
          id: 'project',
          initialValue: target.project,
          label: 'Project',
          options: projectOptions,
          required: true,
        },
        {id: 'topic', initialValue: target.topic, label: 'Topic', required: true},
        {
          description: 'Leave blank to move it to personal memory.',
          id: 'team',
          initialValue: target.team,
          label: 'Shared team',
          options: teamOptions,
        },
      ],
      message: 'Review the destination before moving this memory.',
      title: 'Move memory',
    });
    if (!values) return;
    await runAction('Moved memory', () =>
      api('/api/memory/move', {
        confirm: true,
        kind: target.kind,
        project: values.project,
        status: target.status,
        team: values.team,
        topic: values.topic,
        uri: selectedUri,
      }),
    );
  }

  async function bulk(action: 'archive' | 'forget' | 'publish'): Promise<void> {
    if (bulkAction || selectedList.length === 0) return;
    const title = `${bulkActionLabel(action)} ${selectedList.length} selected ${selectedList.length === 1 ? 'memory' : 'memories'}?`;
    const values = await dialogs.prompt({
      confirmLabel: bulkActionLabel(action),
      fields:
        action === 'publish'
          ? [{id: 'team', initialValue: 'default', label: 'Team', options: teamOptions, required: true}]
          : undefined,
      message:
        action === 'forget'
          ? 'This permanently removes every selected memory from local context.'
          : 'Only the currently selected memories will be changed.',
      title,
      tone: action === 'forget' ? 'danger' : 'default',
    });
    if (!values) return;
    const team = action === 'publish' ? values.team : undefined;
    const currentSelectedUri = selectedUri;
    setBulkAction(action);
    try {
      const result = await api<{readonly results: readonly BulkItemResult[]}>('/api/bulk', {
        action,
        confirm: true,
        team,
        uris: selectedList,
      });
      setOutput(formatBulkResults(action, result.results));
      const failedUris = result.results.filter(item => !item.ok).map(item => item.uri);
      setSelectedUris(new Set(failedUris));
      if (currentSelectedUri && selectedList.includes(currentSelectedUri)) {
        if (failedUris.includes(currentSelectedUri)) {
          await reloadSelected(currentSelectedUri);
        } else {
          setSelectedUri(undefined);
          setMemory(undefined);
          setContent('');
          setMemoryViewMode('edit');
        }
      } else if (currentSelectedUri) {
        await reloadSelected(currentSelectedUri);
      }
      await refreshTreeOnly();
      toastMessage(failedUris.length === 0 ? 'Bulk action complete' : 'Bulk action completed with failures');
    } catch (err) {
      toastMessage(errorMessage(err));
    } finally {
      setBulkAction(undefined);
    }
  }

  async function loadShares(): Promise<void> {
    const next = await api<{shares: readonly ShareSummary[]}>('/api/shares');
    setShares(next.shares);
    toastMessage('Shares refreshed');
  }

  async function loadDoctorChecks(showToast = false): Promise<void> {
    const next = await api<{checks: readonly DoctorCheck[]; shares: readonly ShareSummary[]}>('/api/doctor');
    setDoctor(next.checks);
    setShares(next.shares);
    if (showToast) {
      toastMessage('Doctor complete');
    }
  }

  async function loadDoctor(showToast = true): Promise<void> {
    if (doctorAction) {
      return;
    }
    setDoctorAction('Running doctor');
    try {
      await loadDoctorChecks(showToast);
    } catch (err) {
      toastMessage(errorMessage(err));
    } finally {
      setDoctorAction(undefined);
    }
  }

  async function draftConsolidation(): Promise<void> {
    if (draftingConsolidation || applyingConsolidation) {
      return;
    }
    const uris =
      selectedList.length > 0 ? selectedList : selectedUri && !isResourceUri(selectedUri) ? [selectedUri] : [];
    if (uris.length < 2) {
      toastMessage('Select at least two memories');
      return;
    }
    setDraftingConsolidation(true);
    setJobId(undefined);
    setDraft('');
    setConsolidationSourceUris(uris);
    try {
      const result = await api<{job: ConsolidationJob}>('/api/consolidations', {
        agent,
        kind: target.kind,
        project: target.project,
        status: target.status,
        topic: target.topic,
        uris,
      });
      if (result.job.status === 'completed') {
        setJobId(result.job.id);
        setDraft(result.job.draft ?? '');
        setConsolidationSourceUris(result.job.sourceUris);
        toastMessage('Draft ready');
      } else {
        setConsolidationSourceUris([]);
        setDraft(result.job.error ?? 'Draft failed');
        toastMessage('Draft failed');
      }
    } catch (err) {
      setConsolidationSourceUris([]);
      setDraft(errorMessage(err));
      toastMessage(errorMessage(err));
    } finally {
      setDraftingConsolidation(false);
    }
  }

  async function applyConsolidation(): Promise<void> {
    if (draftingConsolidation || applyingConsolidation || !jobId || !draft) return;
    const confirmed = await dialogs.confirm({
      confirmLabel: 'Apply consolidation',
      message: `Store the consolidated memory and archive ${consolidationSourceUris.length} personal source${consolidationSourceUris.length === 1 ? '' : 's'}.`,
      title: 'Apply this consolidation?',
    });
    if (!confirmed) return;
    const sourceUris = consolidationSourceUris;
    const currentSelectedUri = selectedUri;
    setApplyingConsolidation(true);
    try {
      const result = await api<{readonly output?: string}>(`/api/consolidations/${jobId}/apply`, {
        cleanup: 'archive',
        confirm: true,
        draft,
        kind: target.kind,
        project: target.project,
        status: target.status,
        topic: target.topic,
      });
      if (result.output) {
        setOutput(result.output);
      }
      setDraft('');
      setJobId(undefined);
      setConsolidationSourceUris([]);
      setSelectedUris(new Set());
      if (currentSelectedUri && sourceUris.includes(currentSelectedUri)) {
        setSelectedUri(undefined);
        setMemory(undefined);
        setContent('');
        setMemoryViewMode('edit');
      } else if (currentSelectedUri) {
        await reloadSelected(currentSelectedUri);
      }
      await refreshTreeOnly();
      toastMessage('Applied consolidation');
    } catch (err) {
      toastMessage(errorMessage(err));
    } finally {
      setApplyingConsolidation(false);
    }
  }

  async function removeSelectedShare(): Promise<void> {
    if (!selectedShare) return;
    const confirmed = await dialogs.confirm({
      confirmLabel: 'Remove share',
      detail: selectedShare,
      message: keepShareFiles
        ? 'Disconnect this shared repository and keep its local files.'
        : 'Disconnect this shared repository and remove its managed local files.',
      title: 'Remove this share?',
      tone: 'danger',
    });
    if (!confirmed) return;
    await runAction('Removed share', () =>
      api('/api/shares/remove', {
        confirm: true,
        keepFiles: keepShareFiles,
        preserveLocal: preserveShare,
        team: selectedShare,
      }),
    );
    await loadShares();
  }

  async function repairThreadnote(): Promise<void> {
    const confirmed = await dialogs.confirm({
      confirmLabel: 'Run repair',
      message: 'Run Threadnote repair now and write the approved maintenance changes.',
      title: 'Repair Threadnote?',
    });
    if (!confirmed) return;
    await runDoctorAction('Repair complete', 'Running repair', () => api('/api/doctor/repair', {confirm: true}));
  }

  async function applyCompactPlan(): Promise<void> {
    const confirmed = await dialogs.confirm({
      confirmLabel: 'Apply compact plan',
      message: 'Apply the current memory compaction plan and write its changes.',
      title: 'Compact memories?',
    });
    if (!confirmed) return;
    await runAction('Compact applied', () =>
      api('/api/compact', {
        apply: true,
        confirm: true,
        project: compactProject,
        topic: compactTopic,
      }),
    );
  }

  async function importPack(): Promise<void> {
    const confirmed = await dialogs.confirm({
      confirmLabel: 'Import pack',
      detail: packPath || 'No path entered',
      message: 'Import memories and resources from this pack into local Threadnote storage.',
      title: 'Import this pack?',
    });
    if (!confirmed) return;
    await runAction('Import complete', () => api('/api/import-pack', {confirm: true, path: packPath}));
  }

  async function seedThreadnote(skills: boolean): Promise<void> {
    const confirmed = await dialogs.confirm({
      confirmLabel: skills ? 'Seed skills' : 'Seed resources',
      message: skills
        ? 'Write the configured Threadnote skills into their managed destinations.'
        : 'Write the configured Threadnote resources into local storage.',
      title: skills ? 'Run seed-skills?' : 'Run seed?',
    });
    if (!confirmed) return;
    await runAction(skills ? 'Seed skills complete' : 'Seed complete', () =>
      api('/api/seed', {confirm: true, ...(skills ? {skills: true} : {})}),
    );
  }

  function selectTreeUri(uri: string): void {
    setSelectedUri(uri);
    setPanel('memory');
  }

  function updateSidebarWidth(width: number): void {
    const next = clampSidebarWidth(width);
    setSidebarWidth(next);
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
  }

  function startSidebarResize(event: React.PointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const pointerId = event.pointerId;
    const handle = event.currentTarget;
    handle.setPointerCapture(pointerId);
    document.body.classList.add('is-resizing-sidebar');

    const onPointerMove = (moveEvent: PointerEvent) => {
      updateSidebarWidth(startWidth + moveEvent.clientX - startX);
    };
    const stopResize = () => {
      if (handle.hasPointerCapture(pointerId)) {
        handle.releasePointerCapture(pointerId);
      }
      document.body.classList.remove('is-resizing-sidebar');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
  }

  function resizeSidebarWithKeyboard(event: React.KeyboardEvent<HTMLDivElement>): void {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      updateSidebarWidth(sidebarWidth - step);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      updateSidebarWidth(sidebarWidth + step);
    } else if (event.key === 'Home') {
      event.preventDefault();
      updateSidebarWidth(SIDEBAR_WIDTH_MIN);
    } else if (event.key === 'End') {
      event.preventDefault();
      updateSidebarWidth(SIDEBAR_WIDTH_MAX);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      updateSidebarWidth(SIDEBAR_WIDTH_DEFAULT);
    }
  }

  const selectedIsDir = selectedNode?.isDir === true;
  const selectedIsResource = selectedUri ? isResourceUri(selectedUri) : false;
  const selectedIsReadable = selectedUri === loadedUri && managerSelectionIsReadable(availability);
  const selectedIsMarkdown = Boolean(selectedNode && isMarkdownNode(selectedNode));
  const markdownPreview = markdownBodyForPreview(content);
  const canMutate = Boolean(selectedUri && selectedIsReadable && !selectedIsDir && !selectedIsResource);
  const canRemoveFolder = Boolean(
    selectedNode?.isDir && selectedNode.relativePath && !selectedNode.isShared && !selectedIsResource,
  );
  const consolidationBusy = draftingConsolidation || applyingConsolidation;
  const canDraftConsolidation = selectedList.length > 0 || !selectedIsResource;
  const doctorBusy = doctorAction !== undefined;
  const selectedHasPendingCanonical = pendingCanonical !== undefined && pendingCanonical.node.uri === selectedUri;
  const controlsBlocked =
    bulkAction !== undefined ||
    selectedHasPendingCanonical ||
    !managerActionsAreAvailable(availability) ||
    Boolean(selectedUri && !selectedIsDir && !selectedIsReadable);
  const busyOverlayMessage = bulkAction
    ? `${actionProgressLabel(bulkAction)} ${selectedList.length} selected ${selectedList.length === 1 ? 'memory' : 'memories'}...`
    : '';
  const doctorBusyMessage = doctorAction ? `${doctorAction}...` : '';
  const metadataFieldsDisabled = Boolean(
    memory || selectedIsDir || selectedIsResource || (selectedUri && !selectedIsReadable),
  );
  const appStyle: React.CSSProperties & {'--sidebar-width': string} = {'--sidebar-width': `${sidebarWidth}px`};
  const updateIndicator = state ? managerUpdateIndicator(state) : undefined;

  return (
    <div className="app" style={appStyle}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-title">
            <img alt="" className="brand-logo" src="/threadnote-logo.svg" />
            <div>
              <h1>Threadnote</h1>
              <p>{state ? `${state.config.user} · ${state.config.account}` : 'Loading manager'}</p>
            </div>
          </div>
        </div>
        <p className="sidebar-label">Workspace</p>
        <nav className="primary-nav" aria-label="Manager sections">
          {(
            [
              'home',
              'reviews',
              'context-health',
              'graph',
              'context',
              'worksets',
              'memory',
              'shares',
              'processes',
              'doctor',
              'tools',
            ] as const
          ).map(name => (
            <button
              aria-current={panel === name ? 'page' : undefined}
              className={panel === name ? 'is-active' : undefined}
              disabled={controlsBlocked}
              key={name}
              onClick={() => setPanel(name)}
              type="button"
            >
              <span aria-hidden="true" className="nav-icon">
                {panelIcon(name)}
              </span>
              <span>
                <strong>{tabTitle(name)}</strong>
                <small>{panelNavDescription(name)}</small>
              </span>
            </button>
          ))}
        </nav>

        <div className="sidebar-product-note">
          <span className="status-pulse" />
          <div>
            <strong>Local runtime</strong>
            <p>{state ? `v${state.version} · private by default` : 'Connecting…'}</p>
          </div>
        </div>
        {updateIndicator ? (
          <div className="sidebar-update">
            <span>{updateIndicator.label}</span>
            <strong>{updateIndicator.detail}</strong>
          </div>
        ) : null}
      </aside>
      <div
        aria-label="Resize navigation panel"
        aria-orientation="vertical"
        aria-valuemax={SIDEBAR_WIDTH_MAX}
        aria-valuemin={SIDEBAR_WIDTH_MIN}
        aria-valuenow={sidebarWidth}
        className="sidebar-resizer"
        onKeyDown={resizeSidebarWithKeyboard}
        onPointerDown={startSidebarResize}
        role="separator"
        tabIndex={0}
        title="Drag to resize navigation"
      />

      <main className="main">
        <header className="topbar">
          <div className="page-title">
            <span>{tabTitle(panel)}</span>
            <small>{panelDescription(panel)}</small>
          </div>
          {panel === 'memory' && selectedList.length > 0 ? (
            <div className="selection-bar">
              <span>{selectedList.length} selected</span>
              <button disabled={controlsBlocked} onClick={() => void bulk('archive')}>
                {bulkAction === 'archive' ? 'Archiving...' : 'Archive'}
              </button>
              <button disabled={controlsBlocked || !canBulkPublish} onClick={() => void bulk('publish')}>
                {bulkAction === 'publish' ? 'Publishing...' : 'Publish'}
              </button>
              <button className="danger" disabled={controlsBlocked} onClick={() => void bulk('forget')}>
                {bulkAction === 'forget' ? 'Forgetting...' : 'Forget'}
              </button>
            </div>
          ) : (
            <button
              aria-label="Refresh manager"
              className="topbar-refresh"
              disabled={bulkAction !== undefined}
              onClick={() => void refreshAll()}
              title="Refresh manager"
              type="button"
            >
              ↻
            </button>
          )}
          {availability.runtime !== 'connected' ? (
            <div className="manager-connection-alert" role="alert">
              {availability.runtime === 'disconnected'
                ? 'Manager disconnected. Memory contents and write actions are unavailable. Restart the Manager, then refresh this page.'
                : 'Connecting to Manager. Memory contents and write actions are unavailable.'}
            </div>
          ) : null}
          {libraryError ? (
            <div className="manager-connection-alert" role="alert">
              Memory library unavailable: {libraryError}. Refresh to retry.
            </div>
          ) : null}
        </header>

        {panel === 'graph' ? (
          <section className="panel graph-panel is-active">
            <GraphWorkspace
              administration={graphDiagnostics}
              administrationBusy={
                graphAdministrationBusy ??
                (graphCatalog?.maintenance
                  ? graphMaintenanceStatusLabel(graphCatalog.maintenance)
                  : graphCatalog?.lifecyclePending
                    ? 'Reconciling indexed views'
                    : undefined)
              }
              administrationOutput={graphAdministrationOutput}
              catalog={graphCatalog}
              catalogError={graphCatalogError}
              loadAnalysis={loadManagerGraphAnalysis}
              loadCatalogPage={loadManagerGraphCatalogPage}
              loadGraph={loadManagerGraph}
              loadNodeDetail={loadManagerGraphNodeDetail}
              loadQuery={loadManagerGraphQuery}
              loadViewsPage={loadManagerGraphViewsPage}
              onAdministrationAction={action => void runGraphAdministration(action)}
              onDiagnostics={options => void refreshGraphDiagnostics(options)}
              onRefresh={() => void refreshGraphCatalog(true)}
            />
          </section>
        ) : null}

        {panel === 'home' ? (
          <ManagerHomePanel
            onOpen={target => setPanel(target)}
            onOpenMemory={uri => {
              setPanel('memory');
              setSelectedUri(uri);
            }}
            onProjectChange={setWorkspaceProject}
            project={workspaceProject}
            projects={projectOptions}
          />
        ) : null}

        {panel === 'reviews' ? (
          <ReviewsPanel
            onOpenLibrary={uri => {
              setPanel('memory');
              if (uri) setSelectedUri(uri);
            }}
            onProjectChange={setWorkspaceProject}
            project={workspaceProject}
            projects={projectOptions}
            refreshGeneration={attentionRefreshGeneration}
          />
        ) : null}

        {panel === 'context-health' ? (
          <ContextHealthPanel
            onOpenLibrary={uri => {
              setPanel('memory');
              if (uri) setSelectedUri(uri);
            }}
            onProjectChange={setWorkspaceProject}
            project={workspaceProject}
            projects={projectOptions}
            refreshGeneration={attentionRefreshGeneration}
          />
        ) : null}

        {panel === 'context' ? (
          <section className="panel context-panel is-active">
            <ContextPanel projectOptions={projectOptions} refreshGeneration={attentionRefreshGeneration} />
          </section>
        ) : null}

        {panel === 'worksets' ? (
          <section className="panel is-active">
            <WorksetsPanel />
          </section>
        ) : null}

        {panel === 'processes' ? (
          <section className="panel is-active">
            <ProcessesPanel />
          </section>
        ) : null}

        {panel === 'memory' ? (
          <section className="panel library-panel is-active">
            <div className="library-workspace">
              {selectedUri && !selectedIsReadable ? (
                <div className="library-record-status" role="status">
                  {availability.selection === 'failed' ? 'Could not load record. Refresh to retry.' : 'Loading memory…'}
                </div>
              ) : null}
              <LibraryExplorer
                busy={bulkAction !== undefined}
                controlsBlocked={controlsBlocked}
                filter={filter}
                navTreeTab={navTreeTab}
                onFilter={setFilter}
                onRefresh={() => void refreshAll()}
                onSelect={selectTreeUri}
                onShowSystem={setShowSystem}
                onTab={setNavTreeTab}
                onToggleSelection={(node, checked) =>
                  setSelectedUris(current => {
                    const next = new Set(current);
                    for (const uri of selectableMemoryUris(node, {filter, showSystem})) {
                      if (checked) next.add(uri);
                      else next.delete(uri);
                    }
                    return next;
                  })
                }
                resourceTree={resourceTree}
                selectedUri={selectedUri}
                selectedUris={selectedUris}
                showSystem={showSystem}
                tree={tree}
              />
              <div className="content-grid">
                <section className="editor-pane">
                  <div className="pane-head">
                    <div>
                      <h2>{selectedNode?.name ?? 'New memory'}</h2>
                      <p className="uri-line">{selectedUri ?? 'No URI until saved'}</p>
                    </div>
                    <div className="action-row">
                      <div className="segmented-control" aria-label="Memory view mode">
                        <button
                          className={memoryViewMode === 'preview' ? 'is-active' : undefined}
                          disabled={!selectedIsMarkdown || selectedIsDir || controlsBlocked}
                          onClick={() => setMemoryViewMode('preview')}
                        >
                          Preview
                        </button>
                        <button
                          className={memoryViewMode === 'edit' ? 'is-active' : undefined}
                          disabled={selectedIsDir || selectedIsResource || controlsBlocked}
                          onClick={() => setMemoryViewMode('edit')}
                        >
                          Edit
                        </button>
                      </div>
                      <button disabled={controlsBlocked} onClick={() => void newMemory()}>
                        New
                      </button>
                      <button
                        disabled={selectedIsDir || selectedIsResource || controlsBlocked}
                        onClick={() => void (memory ? saveCurrent() : saveNew())}
                      >
                        Save
                      </button>
                      <button disabled={!canMutate || controlsBlocked} onClick={() => void archiveCurrent()}>
                        Archive
                      </button>
                      <button
                        disabled={
                          !canMutate ||
                          selectedNode?.isShared === true ||
                          !canPublishMemoryFromManager(selectedUri, memory?.record?.metadata) ||
                          controlsBlocked
                        }
                        onClick={() => void publishCurrent()}
                      >
                        Publish
                      </button>
                      <button
                        disabled={!canMutate || selectedNode?.isShared !== true || controlsBlocked}
                        onClick={() => void unpublishCurrent()}
                      >
                        Unpublish
                      </button>
                      <button disabled={!canMutate || controlsBlocked} onClick={() => void moveCurrent()}>
                        Move
                      </button>
                      <button
                        className="danger"
                        disabled={!canRemoveFolder || controlsBlocked}
                        onClick={() => void removeFolderCurrent()}
                        title={selectedNode?.isShared ? 'Use Sharing to remove shared folders' : undefined}
                      >
                        Remove Folder
                      </button>
                      <button
                        className="danger"
                        disabled={!canMutate || controlsBlocked}
                        onClick={() => void forgetCurrent()}
                      >
                        Forget
                      </button>
                    </div>
                  </div>
                  {pendingCanonical && selectedUri === pendingCanonical.node.uri ? (
                    <div className="manager-draft-reconcile" role="alert">
                      <p>The record changed while Manager was disconnected. Your unsaved draft is preserved.</p>
                      <details>
                        <summary>Review the reloaded record</summary>
                        <pre>{pendingCanonical.content}</pre>
                      </details>
                      <div className="action-row">
                        <button
                          onClick={() => {
                            draftRef.current = {...draftRef.current!, base: pendingCanonical.content};
                            setPendingCanonical(undefined);
                          }}
                        >
                          Keep my draft
                        </button>
                        <button
                          onClick={() => {
                            draftRef.current = undefined;
                            showMemory(pendingCanonical);
                          }}
                        >
                          Load reloaded record
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {selectedUri && !selectedIsDir && !selectedIsReadable ? (
                    <div className="manager-record-unavailable" role="status">
                      Record unavailable until it loads.
                    </div>
                  ) : memoryViewMode === 'preview' && selectedIsMarkdown && !selectedIsDir ? (
                    <MarkdownViewer markdown={markdownPreview} />
                  ) : (
                    <textarea
                      disabled={selectedIsDir || selectedIsResource || controlsBlocked}
                      onChange={event => {
                        const next = event.target.value;
                        if (selectedUri && memory)
                          draftRef.current = {base: memory.content, text: next, uri: selectedUri};
                        setContent(next);
                      }}
                      placeholder={
                        selectedIsDir ? 'Folder selected' : selectedIsResource ? 'Resource content' : 'Memory content'
                      }
                      spellCheck={false}
                      value={content}
                    />
                  )}
                </section>

                <aside className="inspector">
                  <h3>Metadata</h3>
                  {selectedUri && !selectedIsReadable && !selectedIsDir ? (
                    <p className="muted">Metadata unavailable until the selected record loads.</p>
                  ) : (
                    <>
                      <TargetFields
                        disabled={metadataFieldsDisabled}
                        onChange={setTarget}
                        openSelect={openSelect}
                        projectOptions={projectOptions}
                        setOpenSelect={setOpenSelect}
                        target={target}
                      />
                      {metadataFieldsDisabled ? (
                        <p className="muted">Metadata is read-only for existing entries.</p>
                      ) : null}
                      <Metadata metadata={memory?.record?.metadata} node={memory?.node ?? selectedNode} />
                    </>
                  )}
                  <h3>Consolidate</h3>
                  <div className="field-row select-row">
                    <DropdownSelect
                      id="agent"
                      label="Agent"
                      onChange={value => void (isAgentClient(value) && setAgent(value))}
                      openSelect={openSelect}
                      options={(state?.agents ?? []).map(item => ({
                        disabled: !item.available || (item.id !== 'codex' && item.id !== 'claude'),
                        label: `${item.label}${item.available ? '' : ' unavailable'}`,
                        value: item.id,
                      }))}
                      setOpenSelect={setOpenSelect}
                      value={agent}
                    />
                    <button
                      disabled={consolidationBusy || controlsBlocked || !canDraftConsolidation}
                      onClick={() => void draftConsolidation()}
                    >
                      {draftingConsolidation ? 'Drafting...' : 'Draft'}
                    </button>
                  </div>
                  <textarea
                    aria-busy={consolidationBusy}
                    placeholder={draftingConsolidation ? 'Generating draft...' : 'Draft preview'}
                    readOnly={consolidationBusy || controlsBlocked}
                    value={draft}
                    onChange={event => setDraft(event.target.value)}
                    spellCheck={false}
                  />
                  <button
                    disabled={consolidationBusy || controlsBlocked || !jobId || !draft}
                    onClick={() => void applyConsolidation()}
                  >
                    {applyingConsolidation ? 'Applying...' : 'Apply draft'}
                  </button>
                </aside>
              </div>
            </div>
          </section>
        ) : null}

        {panel === 'shares' ? (
          <SharesPanel
            createShare={() =>
              void runAction('Created share', () =>
                api('/api/shares/init', {confirm: true, remoteUrl: shareRemote, team: shareTeam}),
              ).then(loadShares)
            }
            keepShareFiles={keepShareFiles}
            loadShares={() => void loadShares()}
            preserveShare={preserveShare}
            removeShare={() => void removeSelectedShare()}
            renameShare={() =>
              void runAction('Renamed share', () =>
                api('/api/shares/rename', {confirm: true, team: selectedShare, to: renameShareTo}),
              ).then(loadShares)
            }
            renameShareTo={renameShareTo}
            selectedShare={selectedShare}
            setKeepShareFiles={setKeepShareFiles}
            setPreserveShare={setPreserveShare}
            setRenameShareTo={setRenameShareTo}
            setSelectedShare={setSelectedShare}
            setShareNewUrl={setShareNewUrl}
            setShareRemote={setShareRemote}
            setShareTeam={setShareTeam}
            shareNewUrl={shareNewUrl}
            shareRemote={shareRemote}
            shares={shares}
            shareTeam={shareTeam}
            setShareUrl={() =>
              void runAction('Updated share URL', () =>
                api('/api/shares/set-url', {confirm: true, remoteUrl: shareNewUrl, team: selectedShare}),
              ).then(loadShares)
            }
            syncShare={() =>
              void runAction('Synced share', () => api('/api/shares/sync', {team: selectedShare})).then(loadShares)
            }
          />
        ) : null}

        {panel === 'doctor' ? (
          <section aria-busy={doctorBusy} className="panel is-active health-panel">
            <div className="pane-head">
              <h2>Health and Doctor</h2>
              <div className="action-row">
                <button disabled={doctorBusy} onClick={() => void loadDoctor()}>
                  {doctorAction === 'Running doctor' ? 'Running...' : 'Run Doctor'}
                </button>
                <button
                  disabled={doctorBusy}
                  onClick={() =>
                    void runDoctorAction('Runtime ready', 'Checking runtime', () => api('/api/doctor/start', {}))
                  }
                >
                  Verify Runtime
                </button>
                <button
                  disabled={doctorBusy}
                  onClick={() =>
                    void runDoctorAction('Repair dry run complete', 'Running repair dry run', () =>
                      api('/api/doctor/repair-dry-run', {}),
                    )
                  }
                >
                  Repair Dry Run
                </button>
                <button disabled={doctorBusy} onClick={() => void repairThreadnote()}>
                  Repair
                </button>
              </div>
            </div>
            {doctorBusyMessage ? (
              <div aria-live="polite" className="loading-row" role="status">
                <span className="spinner" aria-hidden="true" />
                <span>{doctorBusyMessage}</span>
              </div>
            ) : null}
            {doctorOutput ? <pre className="output doctor-output">{doctorOutput}</pre> : null}
            <div className="checks">
              {doctor.map(check => (
                <div className="check-item" key={check.name}>
                  <span className={`badge ${check.status}`}>{check.status.toUpperCase()}</span>
                  <strong>{check.name}</strong>
                  <p>{check.detail}</p>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {panel === 'tools' ? (
          <section className="panel is-active">
            <div className="split">
              <section>
                <h2>Recall</h2>
                <div className="field-row">
                  <input
                    value={recallQuery}
                    onChange={event => setRecallQuery(event.target.value)}
                    placeholder="Search memories and seeded resources"
                  />
                  <ManagerAutocompleteInput
                    allowCreate={false}
                    onChange={setRecallProject}
                    options={projectOptions}
                    value={recallProject}
                    placeholder="project scope (blank = all)"
                  />
                  <button
                    onClick={() =>
                      void runAction('Recall complete', () =>
                        api<{readonly output: string}>('/api/recall', {
                          query: recallQuery,
                          ...(recallProject.trim() ? {project: recallProject.trim()} : {}),
                        }),
                      )
                    }
                  >
                    Search
                  </button>
                </div>
                <h3>Read URI</h3>
                <div className="field-row">
                  <input
                    value={readUri}
                    onChange={event => setReadUri(event.target.value)}
                    placeholder="threadnote://..."
                  />
                  <button disabled={!readUri.trim()} onClick={() => void readContext(readUri)}>
                    Read
                  </button>
                </div>
                {outputUris.length > 0 ? (
                  <div className="uri-list">
                    <h3>URIs in Output</h3>
                    {outputUris.map(uri => (
                      <button className="uri-button" key={uri} onClick={() => void readContext(uri)} title={uri}>
                        {uri}
                      </button>
                    ))}
                  </div>
                ) : null}
                <pre className="output">{output}</pre>
              </section>
              <aside className="form-pane">
                <section className="form-section">
                  <h3>Hygiene</h3>
                  <ManagerAutocompleteInput
                    allowCreate={false}
                    onChange={setCompactProject}
                    options={projectOptions}
                    value={compactProject}
                    placeholder="project"
                  />
                  <input
                    value={compactTopic}
                    onChange={event => setCompactTopic(event.target.value)}
                    placeholder="topic"
                  />
                  <div className="button-row">
                    <button
                      onClick={() =>
                        void runAction('Compact dry run complete', () =>
                          api<{readonly output: string}>('/api/compact', {
                            project: compactProject,
                            topic: compactTopic,
                          }),
                        )
                      }
                    >
                      Dry Run
                    </button>
                    <button onClick={() => void applyCompactPlan()}>Apply</button>
                  </div>
                </section>
                <section className="form-section">
                  <h3>Import / Export</h3>
                  <input
                    value={packPath}
                    onChange={event => setPackPath(event.target.value)}
                    placeholder=".ovpack path"
                  />
                  <div className="button-row">
                    <button
                      onClick={() => void runAction('Export complete', () => api('/api/export-pack', {path: packPath}))}
                    >
                      Export
                    </button>
                    <button onClick={() => void importPack()}>Import</button>
                  </div>
                </section>
                <section className="form-section">
                  <h3>Seed</h3>
                  <div className="button-row">
                    <button onClick={() => void seedThreadnote(false)}>Seed</button>
                    <button onClick={() => void seedThreadnote(true)}>Seed Skills</button>
                  </div>
                </section>
              </aside>
            </div>
          </section>
        ) : null}
      </main>
      {busyOverlayMessage ? (
        <div aria-live="polite" className="busy-overlay" role="status">
          <div className="busy-panel">{busyOverlayMessage}</div>
        </div>
      ) : null}
      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}

if (typeof document !== 'undefined') {
  const root = document.getElementById('root');
  if (!root) {
    throw new Error('Missing #root');
  }
  createRoot(root).render(
    <ManagerDialogProvider>
      <App />
    </ManagerDialogProvider>,
  );
}
