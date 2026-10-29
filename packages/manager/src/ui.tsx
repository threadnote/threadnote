import {LibraryReaderHeader, LibraryScopeControls, LibraryContentTabs} from './library_controls.js';
import {
  isCheckssharesResponse,
  isCodeGraphLocalDiagnosticsReport,
  isGraphCatalog,
  isGraphIndexActionResponse,
  isJobResponse2,
  isManagerGraphViewRemovalResponse,
  isMemoryResponse,
  isOutputResponse2,
  isReadResponse,
  isResultsResponse,
  isSharesResponse,
  isStateResponse,
  isTreeResponse,
} from './api/response_guards.js';
import {mountManagerApp} from './mount.js';
import {Option as EffectOption} from 'effect';
import {Array as EffectArray} from 'effect';
import {requestGraphAdministrationAction} from './graph/index_action.js';
import {useManualSupportEdit} from './attention/manual_edit.js';
import {ConsolidationPanel} from './consolidation_review.js';
import {
  MAX_CONSOLIDATION_SOURCES,
  type ConsolidationReview,
  type ConsolidationSource,
} from '@threadnote/memory/consolidation';
import {MemorySelectionBar} from './memory_selection_bar.js';
import {SharingPanel} from './sharing_view.js';
import {IntegrationsPanel} from './integrations_view.js';
import type {IntegrationRegistration} from './integration_registration.js';
import {RuntimeHealthPanel} from './runtime_health_view.js';
import '@mdxeditor/editor/style.css';
import {ArrowLeft, Check, ChevronRight, ListChecks, Pencil, Plus, RefreshCw, Search, Settings2} from 'lucide-react';
import {DetailModal} from './detail_modal.js';
import {LibraryArticle} from './library_article.js';
import React, {useEffect, useMemo, useReducer, useRef, useState} from 'react';

import type {CodeGraphLocalDiagnosticsReport} from '@threadnote/graph/diagnostics';
import {ContextPanel} from './context/view.js';
import {useManagerDialogs} from '@threadnote/manager/dialog';
import {DevSkillsPanel} from './dev_skills/view.js';
import {WorksetsPanel} from '@threadnote/manager/worksets_view';
import {ProcessesPanel} from './processes_view.js';

import {useGraphLiveStatus, useManagerRuntimeConnection} from './ui/live.js';
import {ManagerOperationsFooter} from './operations_footer.js';
import {ManagerHomePanel} from './home_view.js';
import {ContextHealthPanel, ReviewsPanel} from './attention_view.js';
import {
  ManagerNavigation,
  NavigationToggle,
  sidebarWidthForKey,
  useContextHealthDecisionCount,
  useNavigationCollapse,
} from './navigation.js';
import {libraryItemActions} from './library_actions.js';
import {MemoryEditor} from './memory_editor.js';
import {WorkspaceUtilities} from './workspace_utilities.js';
import {
  descendantMemoryUris,
  libraryScopeTree,
  reconcileMemorySelection,
  toggleMemorySelection,
  type LibraryScope,
} from './library_model.js';
import {LibraryExplorer, LibraryHistoryControls} from './library_explorer.js';
import {librarySearchInputValue, useLibrarySearch} from './library_search.js';
import {canonicalizeLibraryHistory, emptyLibraryHistory, isMemoryLink, visitLibraryUri} from './library_navigation.js';
import {useLibraryNavigatorResize} from './library_layout.js';
import {settleManagerRefreshTasks} from '@threadnote/manager/refresh';
import {Metadata, TargetFields} from '@threadnote/manager/ui/controls';
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
  graphAdministrationBusyLabel,
  type GraphAdministrationAction,
  type GraphCatalog,
} from '@threadnote/manager/graph';
import {
  GRAPH_CATALOG_REQUEST_TIMEOUT_MILLISECONDS,
  actionProgressLabel,
  api,
  clampSidebarWidth,
  bulkActionLabel,
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
  SIDEBAR_WIDTH_KEY,
  loadManagerGraph,
  loadManagerGraphAnalysis,
  loadManagerGraphCatalogPage,
  loadManagerGraphNodeDetail,
  loadManagerGraphQuery,
  loadManagerGraphViewsPage,
  managerProjectOptions,
  markdownBodyForPreview,
  panelDescription,
  resourceUrisFromText,
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
  ConsolidationJobResponse as ConsolidationJob,
  AgentClient,
  StateResponse,
  TreeResponse,
  DoctorCheck,
  MemoryResponse,
  ReadResponse,
  BulkItemResult,
  PanelName,
  SelectId,
  ShareSummary,
  TargetForm,
  TreeNode,
} from '@threadnote/manager/ui/contracts';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

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

type MemoryViewMode = 'edit' | 'preview';

const EMPTY_SELECTED_URIS: ReadonlySet<string> = new Set();
function App({
  integrations,
  onAccount,
}: {
  readonly integrations: readonly IntegrationRegistration[];
  readonly onAccount: (account: string) => void;
}): React.ReactElement {
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
  const [libraryHistory, setLibraryHistory] = useState(emptyLibraryHistory);
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
  const [libraryScope, setLibraryScope] = useState<LibraryScope>('local');
  const [savingMemory, setSavingMemory] = useState(false);
  const saveOwned = useRef(false);
  const manualEdit = useManualSupportEdit({
    onOpenMemory: uri => void selectTreeUri(uri),
    selectedUri,
    onError: toastMessage,
    onApplied: uri => {
      draftRef.current = undefined;
      memoryUpdateVerified(uri, 'Memory edit saved and verified');
    },
  });
  function memoryUpdateVerified(uri: string, message: string): void {
    void reloadSelected(uri);
    void refreshTreeOnly();
    setAttentionRefreshGeneration(generation => generation + 1);
    toastMessage(message);
  }
  const [libraryActionBusy, setLibraryActionBusy] = useState(false);
  const [bulkCount, setBulkCount] = useState(0);
  const [libraryDialog, setLibraryDialog] = useState<'details' | 'consolidate'>();
  const [creatingMemory, setCreatingMemory] = useState(false);
  const [editorRevision, setEditorRevision] = useState(0);
  const scopedTree = useMemo(() => libraryScopeTree(tree, libraryScope), [tree, libraryScope]);
  const [showSystem, setShowSystem] = useState(false);
  const [navTreeTab, setNavTreeTab] = useState<NavTreeTab>('memories');
  const librarySearchUri = Effect.pipe(filter, EffectString.trim);
  const librarySearchIsUri = isMemoryLink(librarySearchUri);
  const librarySearch = useLibrarySearch(filter, libraryScope, panel === 'memory' && navTreeTab === 'memories', tree);
  const [toast, setToast] = useState('');
  const [output, setOutput] = useState('');
  const [workspaceProject, setWorkspaceProject] = useState('');
  const [target, setTarget] = useState<TargetForm>({
    kind: 'durable',
    project: '',
    status: 'active',
    team: '',
    topic: '',
  });
  const [agent, setAgent] = useState<AgentClient>('codex');
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState<string | undefined>();
  const [consolidationTopic, setConsolidationTopic] = useState('');
  const [consolidationProject, setConsolidationProject] = useState<string | undefined>();
  const [jobId, setJobId] = useState<string | undefined>();
  const [draftingConsolidation, setDraftingConsolidation] = useState(false);
  const [applyingConsolidation, setApplyingConsolidation] = useState(false);
  const [consolidationSources, setConsolidationSources] = useState<readonly ConsolidationSource[]>([]);
  const [consolidationReviews, setConsolidationReviews] = useState<readonly ConsolidationReview[]>([]);
  const [consolidationSourceUris, setConsolidationSourceUris] = useState<readonly string[]>([]);
  const [bulkAction, setBulkAction] = useState<'archive' | 'forget' | 'publish' | 'unpublish' | undefined>();
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [sidebarCollapsed, toggleSidebar] = useNavigationCollapse();
  const libraryNavigator = useLibraryNavigatorResize();
  const [attentionRefreshGeneration, setAttentionRefreshGeneration] = useState(0);
  const [contextHealthDecisionCount, onHealthDecisionCountChange] = useContextHealthDecisionCount();
  const [libraryError, setLibraryError] = useState('');
  useEffect(() => {
    void refreshAll();
  }, []);
  useManagerRuntimeConnection({
    runtime: availability.runtime,
    onLost: () => dispatchAvailability('runtime-lost'),
    onReady: () => dispatchAvailability('runtime-ready'),
    onRecovery: () => void refreshAll(),
  });
  useEffect(() => {
    if (panel === 'doctor') {
      void loadDoctor(false);
    }
    if (panel === 'graph' && !graphDiagnostics) {
      void refreshGraphDiagnostics({analyze: false, deep: false}, false);
    }
  }, [panel]);
  useGraphLiveStatus({
    enabled: panel === 'graph',
    catalog: graphCatalogRef,
    authoritative: graphCatalogAuthoritativeRef,
    diagnosticsRevision: graphDiagnosticsCatalogRevisionRef,
    setCatalog: setGraphCatalog,
    setError: setGraphCatalogError,
    refreshDiagnostics: (revision, signal) =>
      refreshGraphDiagnostics({analyze: false, deep: false}, false, true, revision, signal),
  });
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (draftRef.current || (creatingMemory && Effect.pipe(content, EffectString.trim))) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [creatingMemory, content]);
  useEffect(() => {
    setSelectedUris(current => reconcileMemorySelection(current, scopedTree));
  }, [scopedTree]);
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
          setLibraryHistory(current => canonicalizeLibraryHistory(current, requestedUri, resolvedUri));
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
      EffectOption.getOrUndefined(
        EffectOption.map(EffectOption.fromNullishOr(state), __effectFindState =>
          EffectOption.getOrUndefined(
            EffectOption.map(EffectOption.fromNullishOr(__effectFindState.agents), __effectFindAgents =>
              EffectOption.getOrUndefined(
                EffectArray.findFirst(__effectFindAgents, item => item.available && item.id === 'local-ai'),
              ),
            ),
          ),
        ),
      ) ??
      EffectOption.getOrUndefined(
        EffectOption.map(EffectOption.fromNullishOr(state), __effectFindState1 =>
          EffectOption.getOrUndefined(
            EffectArray.findFirst(
              __effectFindState1.agents,
              item => item.available && ['codex', 'claude', 'effect-ai'].includes(item.id),
            ),
          ),
        ),
      );
    if (firstAvailable) {
      setAgent(firstAvailable.id);
    }
  }, [state]);
  const selectedNode = useMemo(
    () =>
      selectedUri && selectedUri === loadedUri && memory?.node.uri === selectedUri
        ? memory.node
        : selectedUri
          ? findNodeInTrees([tree, resourceTree], selectedUri)
          : undefined,
    [loadedUri, memory, resourceTree, selectedUri, tree],
  );
  const visibleSelectedUris = useMemo(
    () => (navTreeTab === 'memories' ? reconcileMemorySelection(selectedUris, scopedTree) : EMPTY_SELECTED_URIS),
    [navTreeTab, selectedUris, scopedTree],
  );
  const selectedList = useMemo(() => [...visibleSelectedUris], [visibleSelectedUris]);
  const canBulkPublish = useMemo(() => canPublishSelectedMemoriesFromManager(tree, selectedList), [tree, selectedList]);
  const projectOptions = useMemo(
    () =>
      uniqueSelectorValues([
        ...managerProjectOptions(tree),
        ...EffectArray.map(graphCatalog?.configuredProjects ?? [], project => project.name),
      ]),
    [graphCatalog?.configuredProjects, tree],
  );
  useEffect(() => {
    if (!workspaceProject || projectOptions.includes(workspaceProject)) return;
    setWorkspaceProject('');
  }, [projectOptions, workspaceProject]);
  const teamOptions = useMemo(
    () => uniqueSelectorValues(['default', ...EffectArray.map(shares, share => share.name), target.team]),
    [shares, target.team],
  );
  async function refreshAll(): Promise<void> {
    let nextTree: TreeResponse | undefined;
    const failures = await settleManagerRefreshTasks([
      {
        label: 'Graph indexes',
        run: async () => {
          try {
            const catalog = await api<GraphCatalog>(
              '/api/graphs',
              undefined,
              {
                timeoutMilliseconds: GRAPH_CATALOG_REQUEST_TIMEOUT_MILLISECONDS,
              },
              isGraphCatalog,
            );
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
            const next = await api<StateResponse>('/api/state', undefined, undefined, isStateResponse);
            setState(next);
            onAccount(next.config.account);
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
            nextTree = await api<TreeResponse>('/api/tree', undefined, undefined, isTreeResponse);
            setLibraryError('');
          } catch (cause) {
            setLibraryError(errorMessage(cause));
            throw cause;
          }
        },
      },
      {
        label: 'Shares',
        run: async () =>
          setShares(
            (await api<{shares: readonly ShareSummary[]}>('/api/shares', undefined, undefined, isSharesResponse))
              .shares,
          ),
      },
    ]);
    if (nextTree) {
      setTree(nextTree.tree);
      setResourceTree(nextTree.resourcesTree);
    }
    setAttentionRefreshGeneration(generation => generation + 1);
    toastMessage(failures.length === 0 ? 'Refreshed' : `Refresh incomplete · ${EffectArray.join(failures, ' · ')}`);
  }

  async function refreshGraphCatalog(notify = true): Promise<void> {
    try {
      const next = await api<GraphCatalog>(
        '/api/graphs',
        undefined,
        {
          timeoutMilliseconds: GRAPH_CATALOG_REQUEST_TIMEOUT_MILLISECONDS,
        },
        isGraphCatalog,
      );
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
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!background) {
      setGraphAdministrationBusy(
        options.deep ? 'Deep-checking graphs' : options.analyze ? 'Analyzing graphs' : 'Diagnosing graphs',
      );
    }
    try {
      const report = await api<CodeGraphLocalDiagnosticsReport>(
        `/api/graphs/diagnostics?analyze=${options.analyze}&deep=${options.deep}`,
        undefined,
        {signal},
        isCodeGraphLocalDiagnosticsReport,
      );
      if (signal?.aborted) return false;
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
        const preview = await api<ManagerGraphViewRemovalResponse>(
          '/api/graphs/action',
          {
            ...action,
            dryRun: true,
          },
          undefined,
          isManagerGraphViewRemovalResponse,
        );
        const approvalDialog = graphViewRemovalApprovalDialog(preview);
        if (approvalDialog && !(await dialogs.confirm(approvalDialog))) {
          setGraphAdministrationOutput(preview.output);
          return;
        }
        const removal = approvalDialog
          ? await api<ManagerGraphViewRemovalResponse>(
              '/api/graphs/action',
              {
                ...action,
                approvalDigest: preview.approvalDigest,
                confirm: true,
              },
              undefined,
              isManagerGraphViewRemovalResponse,
            )
          : preview;
        result = removal;
        removedViewConfirmed = graphViewRemovalTargetIsAbsent(removal);
        if (removedViewConfirmed) projectRemovedGraphView(action);
      } else {
        const response = await requestGraphAdministrationAction(
          action,
          (path, body) => api(path, body, undefined, isGraphIndexActionResponse),
          dialogs,
        );
        if (!response) return;
        result = response;
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
    const next = await api<MemoryResponse>(
      `/api/memory?uri=${encodeURIComponent(uri)}`,
      undefined,
      undefined,
      isMemoryResponse,
    );
    if (!accept()) return undefined;
    showMemory(next);
    return next.node.uri;
  }
  function showMemory(next: MemoryResponse): void {
    setCreatingMemory(false);
    setLibraryScope(next.node.sharedTeam ? `team:${next.node.sharedTeam}` : 'local');
    setMemory(next);
    setEditorRevision(value => value + 1);
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
    const result = await api<ReadResponse>('/api/read', {uri}, undefined, isReadResponse);
    if (!accept()) return undefined;
    setMemory(undefined);
    setLoadedUri(uri);
    setContent(result.content || result.output);
    setOutput(result.output || result.content);
    setMemoryViewMode(isMarkdownUri(uri) ? 'preview' : 'edit');
    setTarget({kind: 'durable', project: '', status: 'active', team: '', topic: ''});
    return uri;
  }
  function toastMessage(message: string): void {
    setToast(message);
    window.setTimeout(() => setToast(current => (current === message ? '' : current)), 3000);
  }
  async function runAction(label: string, action: () => Promise<{readonly output?: string}>): Promise<void> {
    if (libraryActionBusy) return;
    setLibraryActionBusy(true);
    try {
      const result = await action();
      if (result.output) {
        setOutput(result.output);
      }
      toastMessage(label);
      const nextTree = await refreshTreeOnly();
      if (selectedUri) {
        if (findNodeInTrees([nextTree.tree, nextTree.resourcesTree], selectedUri)) await reloadSelected(selectedUri);
        else {
          if (draftRef.current?.uri === selectedUri) draftRef.current = undefined;
          setSelectedUri(undefined);
          setMemory(undefined);
          setContent('');
        }
      }
    } catch (err) {
      toastMessage(errorMessage(err));
    } finally {
      setLibraryActionBusy(false);
    }
  }
  async function runDoctorAction(
    label: string,
    busyLabel: string,
    action: () => Promise<{readonly output?: string}>,
  ): Promise<boolean> {
    if (doctorAction) {
      return false;
    }
    setDoctorAction(busyLabel);
    try {
      const result = await action();
      setDoctorOutput(result.output ?? '');
      toastMessage(label);
      await loadDoctorChecks();
      return true;
    } catch (err) {
      toastMessage(errorMessage(err));
      return false;
    } finally {
      setDoctorAction(undefined);
    }
  }
  async function refreshTreeOnly(): Promise<TreeResponse> {
    const next = await api<TreeResponse>('/api/tree', undefined, undefined, isTreeResponse);
    setLibraryError('');
    setTree(next.tree);
    setResourceTree(next.resourcesTree);
    return next;
  }

  async function reloadSelected(uri: string): Promise<void> {
    if (isResourceUri(uri)) {
      await loadResource(uri).catch(() => undefined);
    } else {
      await loadMemory(uri).catch(() => undefined);
    }
  }

  async function saveCurrent(): Promise<void> {
    if (saveOwned.current || manualEdit.pending) return;
    saveOwned.current = true;
    setSavingMemory(true);
    if (await manualEdit.preview(memory, content, target.project)) {
      saveOwned.current = false;
      setSavingMemory(false);
      return;
    }
    await runAction('Saved memory', () =>
      api<{readonly output?: string}>(
        '/api/memory/save',
        {
          kind: target.kind,
          project: target.project,
          expectedContent: memory?.content,
          replaceUri: memory?.node.uri,
          status: target.status,
          text: content,
          topic: target.topic,
        },
        undefined,
        isOutputResponse2,
      ).then(result => {
        draftRef.current = undefined;
        return result;
      }),
    );
    setSavingMemory(false);
    saveOwned.current = false;
  }

  async function newMemory(): Promise<void> {
    if (!(await confirmDiscardDraft())) return;
    draftRef.current = undefined;
    setPendingCanonical(undefined);
    setPanel('memory');
    setCreatingMemory(true);
    setNavTreeTab('memories');
    setLibraryScope('local');
    setSelectedUris(new Set());
    setEditorRevision(value => value + 1);
    setSelectedUri(undefined);
    setMemory(undefined);
    setContent('');
    setMemoryViewMode('edit');
    setTarget({kind: 'durable', project: workspaceProject, status: 'active', team: '', topic: ''});
    toastMessage('New local memory · written by you');
  }

  async function saveNew(): Promise<void> {
    if (savingMemory || !Effect.pipe(content, EffectString.trim) || !Effect.pipe(target.topic, EffectString.trim))
      return;
    setSavingMemory(true);
    try {
      const result = await api<{readonly output?: string}>(
        '/api/memory/save',
        {
          kind: target.kind,
          project: target.project,
          status: target.status,
          text: content,
          topic: target.topic,
          sourceAgentClient: 'user',
        },
        undefined,
        isOutputResponse2,
      );
      draftRef.current = undefined;
      setOutput(result.output ?? '');
      await refreshTreeOnly();
      const uri = EffectOption.getOrUndefined(
        EffectArray.findFirst(resourceUrisFromText(result.output ?? ''), value =>
          Effect.pipe(value, EffectString.endsWith('.md')),
        ),
      );
      if (uri) setSelectedUri(uri);
      else {
        setContent('');
        setTarget(current => ({...current, topic: ''}));
        setEditorRevision(value => value + 1);
      }
      toastMessage('Saved local memory');
    } catch (cause) {
      toastMessage(errorMessage(cause));
    } finally {
      setSavingMemory(false);
    }
  }

  async function archiveCurrent(uri = selectedUri): Promise<void> {
    if (!uri) return;
    const confirmed = await dialogs.confirm({
      confirmLabel: 'Archive memory',
      detail: uri,
      message: 'The memory stays available in the archive and can be restored later.',
      title: 'Archive this memory?',
    });
    if (!confirmed) return;
    await runAction('Archived memory', () =>
      api('/api/memory/archive', {confirm: true, uri}, undefined, isOutputResponse2),
    );
  }

  async function forgetCurrent(uri = selectedUri): Promise<void> {
    if (!uri) return;
    const forgottenUri = uri;
    const confirmed = await dialogs.confirm({
      confirmLabel: 'Forget memory',
      detail: forgottenUri,
      message: 'This permanently removes the memory from local context.',
      title: 'Forget this memory?',
      tone: 'danger',
    });
    if (!confirmed) return;
    setLibraryActionBusy(true);
    try {
      await api('/api/memory/forget', {confirm: true, uri: forgottenUri});
      if (draftRef.current?.uri === forgottenUri) draftRef.current = undefined;
      setPendingCanonical(current => (current?.node.uri === forgottenUri ? undefined : current));
      if (selectedUri === forgottenUri) {
        setSelectedUri(undefined);
        setMemory(undefined);
        setContent('');
        setTarget({kind: 'durable', project: '', status: 'active', team: '', topic: ''});
      }
      await refreshTreeOnly();
      toastMessage('Forgot memory');
    } catch (cause) {
      toastMessage(errorMessage(cause));
    } finally {
      setLibraryActionBusy(false);
    }
  }

  async function removeFolderCurrent(node = selectedNode): Promise<void> {
    if (!node?.isDir) {
      return;
    }
    if (!node.relativePath) {
      toastMessage('The root memories folder cannot be removed');
      return;
    }
    if (node.isShared) {
      toastMessage('Use Sharing to remove shared folders');
      return;
    }
    const fileCount = countFiles(node);
    const confirmed = await dialogs.confirm({
      confirmLabel: 'Remove folder',
      detail: EffectArray.join([node.uri, ...descendantMemoryUris(node)], '\n'),
      message: `This permanently removes ${fileCount} memory file${fileCount === 1 ? '' : 's'} from local context.`,
      title: 'Remove folder and forget its memories?',
      tone: 'danger',
    });
    if (!confirmed) return;
    setLibraryActionBusy(true);
    try {
      const result = await api<{readonly output?: string}>(
        '/api/folder/remove',
        {
          confirm: true,
          uri: node.uri,
        },
        undefined,
        isOutputResponse2,
      );
      if (result.output) {
        setOutput(result.output);
      }
      if (
        selectedUri === node.uri ||
        Effect.pipe(selectedUri, effectOptionalString =>
          effectOptionalString == null
            ? undefined
            : Effect.pipe(effectOptionalString, EffectString.startsWith(node.uri + '/')),
        )
      ) {
        draftRef.current = undefined;
        setPendingCanonical(undefined);
        setSelectedUri(undefined);
        setMemory(undefined);
        setContent('');
      }
      await refreshTreeOnly();
      toastMessage('Removed folder');
    } catch (err) {
      toastMessage(errorMessage(err));
    } finally {
      setLibraryActionBusy(false);
    }
  }

  async function publishCurrent(uri = selectedUri): Promise<void> {
    if (!uri) return;
    const values = await dialogs.prompt({
      confirmLabel: 'Publish memory',
      detail: uri,
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
      api('/api/memory/publish', {confirm: true, team: values.team, uri}, undefined, isOutputResponse2),
    );
  }

  async function unpublishCurrent(uri = selectedUri, team = target.team): Promise<void> {
    if (!uri) return;
    const confirmed = await dialogs.confirm({
      confirmLabel: 'Unpublish memory',
      detail: uri,
      message: 'Remove this memory from its shared repository projection.',
      title: 'Unpublish this memory?',
      tone: 'danger',
    });
    if (!confirmed) return;
    await runAction('Unpublished memory', () =>
      api('/api/memory/unpublish', {confirm: true, team, uri}, undefined, isOutputResponse2),
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
      api(
        '/api/memory/move',
        {
          confirm: true,
          kind: target.kind,
          project: values.project,
          status: target.status,
          team: values.team,
          topic: values.topic,
          uri: selectedUri,
        },
        undefined,
        isOutputResponse2,
      ),
    );
  }

  async function bulk(
    action: 'archive' | 'forget' | 'publish' | 'unpublish',
    uris: readonly string[] = selectedList,
  ): Promise<void> {
    if (bulkAction || uris.length === 0) return;
    const title = `${bulkActionLabel(action)} ${uris.length} selected ${uris.length === 1 ? 'memory' : 'memories'}?`;
    const values = await dialogs.prompt({
      confirmLabel: bulkActionLabel(action),
      fields:
        action === 'publish'
          ? [{id: 'team', initialValue: 'default', label: 'Team', options: teamOptions, required: true}]
          : undefined,
      message:
        action === 'forget'
          ? 'This permanently removes every selected memory from local context.'
          : action === 'unpublish'
            ? 'Remove every selected memory from its shared repository projection.'
            : 'Only the currently selected memories will be changed.',
      detail: EffectArray.join(uris, '\n'),
      title,
      tone: action === 'forget' || action === 'unpublish' ? 'danger' : 'default',
    });
    if (!values) return;
    const team =
      action === 'publish'
        ? values.team
        : action === 'unpublish' && libraryScope !== 'local'
          ? Effect.pipe(libraryScope, EffectString.slice(5))
          : undefined;
    const currentSelectedUri = selectedUri;
    setBulkCount(uris.length);
    setBulkAction(action);
    try {
      const result = await api<{readonly results: readonly BulkItemResult[]}>(
        '/api/bulk',
        {
          action,
          confirm: true,
          team,
          uris,
        },
        undefined,
        isResultsResponse,
      );
      setOutput(formatBulkResults(action, result.results));
      const failedUris = EffectArray.map(
        EffectArray.filter(result.results, item => !item.ok),
        item => item.uri,
      );
      setSelectedUris(new Set(failedUris));
      if (currentSelectedUri && uris.includes(currentSelectedUri)) {
        if (failedUris.includes(currentSelectedUri)) {
          await reloadSelected(currentSelectedUri);
        } else {
          if (draftRef.current?.uri === currentSelectedUri) draftRef.current = undefined;
          setPendingCanonical(undefined);
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

  async function loadDoctorChecks(showToast = false): Promise<void> {
    const next = await api<{checks: readonly DoctorCheck[]; shares: readonly ShareSummary[]}>(
      '/api/doctor',
      undefined,
      undefined,
      isCheckssharesResponse,
    );
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

  function clearConsolidationDraft(uris: readonly string[] = []): void {
    setJobId(undefined);
    setDraft('');
    setDraftError(undefined);
    setConsolidationSources([]);
    setConsolidationReviews([]);
    setConsolidationSourceUris(uris);
  }

  function openConsolidation(): void {
    if (consolidationBusy) return;
    if (
      consolidationSourceUris.length !== selectedList.length ||
      EffectArray.some(consolidationSourceUris, uri => !visibleSelectedUris.has(uri))
    ) {
      clearConsolidationDraft(selectedList);
      setConsolidationTopic('');
      setConsolidationProject(workspaceProject);
    }
    setLibraryDialog('consolidate');
  }

  async function draftConsolidation(model: string): Promise<void> {
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
    clearConsolidationDraft(uris);
    try {
      const result = await api<{job: ConsolidationJob}>(
        '/api/consolidations',
        {
          agent,
          model,
          kind: 'durable',
          project: consolidationProject ?? target.project,
          status: 'active',
          topic: consolidationTopic,
          uris,
        },
        undefined,
        isJobResponse2,
      );
      if (result.job.status === 'completed') {
        setJobId(result.job.id);
        setDraft(result.job.draft ?? '');
        setConsolidationSourceUris(result.job.sourceUris);
        setConsolidationSources(result.job.sources ?? []);
        toastMessage('Draft ready');
      } else {
        setConsolidationSourceUris([]);
        setDraftError(result.job.error ?? 'The agent did not produce a draft.');
        toastMessage('Draft failed');
      }
    } catch (err) {
      setConsolidationSourceUris([]);
      setDraftError(errorMessage(err));
      toastMessage(errorMessage(err));
    } finally {
      setDraftingConsolidation(false);
    }
  }

  async function resumeConsolidationCleanup(): Promise<void> {
    const receipt = memory?.record?.metadata.consolidation;
    if (!receipt || !memory?.record || applyingConsolidation) return;
    const confirmed = await dialogs.confirm({
      confirmLabel: 'Resume cleanup',
      title: 'Resume saved source cleanup?',
      message: `Verify the saved result and resume its approved ${receipt.cleanup} cleanup. Changed source revisions will be preserved.`,
    });
    if (!confirmed) return;
    setApplyingConsolidation(true);
    try {
      const result = await api<{readonly output?: string}>(
        `/api/consolidations/${receipt.operationId}/apply`,
        {
          confirm: true,
          resultUri: memory.record.uri,
        },
        undefined,
        isOutputResponse2,
      );
      if (result.output) setOutput(result.output);
      await refreshAll();
      toastMessage('Saved consolidation cleanup verified');
    } catch (err) {
      toastMessage(errorMessage(err));
    } finally {
      setApplyingConsolidation(false);
    }
  }

  async function applyConsolidation(): Promise<void> {
    if (draftingConsolidation || applyingConsolidation || !jobId || !draft) return;
    const confirmed = await dialogs.confirm({
      confirmLabel: 'Save and archive sources',
      message: `Save the new memory and archive eligible personal sources from ${consolidationSourceUris.length} selected memories.`,
      title: 'Save this consolidated memory?',
    });
    if (!confirmed) return;
    const sourceUris = consolidationSourceUris;
    const currentSelectedUri = selectedUri;
    setApplyingConsolidation(true);
    try {
      const result = await api<{readonly output?: string}>(
        `/api/consolidations/${jobId}/apply`,
        {
          cleanup: 'archive',
          confirm: true,
          draft,
          reviews: consolidationReviews,
          kind: 'durable',
          project: consolidationProject ?? target.project,
          status: 'active',
          topic: consolidationTopic,
        },
        undefined,
        isOutputResponse2,
      );
      if (result.output) {
        setOutput(result.output);
      }
      clearConsolidationDraft();
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
      toastMessage('Consolidated memory saved');
    } catch (err) {
      toastMessage(errorMessage(err));
    } finally {
      setApplyingConsolidation(false);
    }
  }

  async function repairThreadnote(): Promise<void> {
    const confirmed = await dialogs.confirm({
      confirmLabel: 'Run repair',
      message: 'Run Threadnote repair now and write the approved maintenance changes.',
      title: 'Repair Threadnote?',
    });
    if (!confirmed) return;
    await runDoctorAction('Repair complete', 'Running repair', () =>
      api('/api/doctor/repair', {confirm: true}, undefined, isOutputResponse2),
    );
  }

  async function confirmDiscardDraft(): Promise<boolean> {
    if (!draftRef.current && (!creatingMemory || !Effect.pipe(content, EffectString.trim))) return true;
    return dialogs.confirm({
      title: 'Discard unsaved changes?',
      message: 'Save your memory before leaving to keep these changes.',
      confirmLabel: 'Discard changes',
      tone: 'danger',
    });
  }

  async function selectTreeUri(uri: string, historyIndex?: number): Promise<void> {
    if (uri !== selectedUri && !(await confirmDiscardDraft())) return;
    if (uri !== selectedUri) draftRef.current = undefined;
    setCreatingMemory(false);
    setLibraryDialog(undefined);
    setLibraryHistory(current =>
      historyIndex === undefined ? visitLibraryUri(current, uri) : {...current, index: historyIndex},
    );
    if (uri !== selectedUri) setMemoryViewMode('preview');
    setSelectedUri(uri);
    setPanel('memory');
    setNavTreeTab(isResourceUri(uri) ? 'resources' : 'memories');
    const node = uri === selectedUri ? selectedNode : findNodeInTrees([tree], uri);
    if (!isResourceUri(uri)) setLibraryScope(node?.sharedTeam ? `team:${node.sharedTeam}` : 'local');
  }

  function navigateLibraryHistory(direction: -1 | 1): void {
    const index = libraryHistory.index + direction;
    const uri = libraryHistory.entries[index];
    if (uri) void selectTreeUri(uri, index);
  }

  async function switchLibrary(tab: NavTreeTab, scope = libraryScope): Promise<void> {
    if (!(await confirmDiscardDraft())) return;
    draftRef.current = undefined;
    setPendingCanonical(undefined);
    setLibraryDialog(undefined);
    setCreatingMemory(false);
    setSelectedUri(undefined);
    setContent('');
    setNavTreeTab(tab);
    setLibraryScope(scope);
    setSelectedUris(new Set());
  }

  async function removeResource(node: TreeNode): Promise<void> {
    if (node.isDir || !isResourceUri(node.uri)) return;
    if (
      !(await dialogs.confirm({
        title: 'Remove indexed copy?',
        confirmLabel: 'Remove indexed copy',
        message:
          'Remove this resource from Threadnote. The original source file stays untouched; a later source sync may import it again.',
        detail: node.uri,
        tone: 'danger',
      }))
    )
      return;
    await runAction('Removed indexed resource', () =>
      api('/api/memory/forget', {confirm: true, uri: node.uri}, undefined, isOutputResponse2),
    );
    if (selectedUri === node.uri) {
      setSelectedUri(undefined);
      setContent('');
    }
  }

  const itemActions = (node: TreeNode) =>
    libraryItemActions(node, {
      tree,
      scope: libraryScope,
      open: selectTreeUri,
      select: node => setSelectedUris(current => toggleMemorySelection(current, node, true)),
      removeResource,
      removeFolder: removeFolderCurrent,
      bulk,
      unpublish: unpublishCurrent,
      publish: publishCurrent,
      archive: archiveCurrent,
      forget: forgetCurrent,
    });

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
    const next = sidebarWidthForKey(event.key, sidebarWidth, event.shiftKey);
    if (next !== undefined) {
      event.preventDefault();
      updateSidebarWidth(next);
    }
  }

  const selectedIsDir = selectedNode?.isDir === true;
  const selectedIsResource = selectedUri ? isResourceUri(selectedUri) : false;
  const selectedIsReadable = selectedUri === loadedUri && managerSelectionIsReadable(availability);
  const selectedIsMarkdown = Boolean(selectedNode && isMarkdownNode(selectedNode));
  const markdownPreview = markdownBodyForPreview(content);
  const canMutate = Boolean(selectedUri && selectedIsReadable && !selectedIsDir && !selectedIsResource);
  const consolidationBusy = draftingConsolidation || applyingConsolidation;
  const canDraftConsolidation = selectedList.length >= 2 && selectedList.length <= MAX_CONSOLIDATION_SOURCES;
  const doctorBusy = doctorAction !== undefined;
  const selectedHasPendingCanonical = pendingCanonical !== undefined && pendingCanonical.node.uri === selectedUri;
  const controlsBlocked =
    manualEdit.pending ||
    bulkAction !== undefined ||
    savingMemory ||
    libraryActionBusy ||
    selectedHasPendingCanonical ||
    !managerActionsAreAvailable(availability) ||
    Boolean(selectedUri && !selectedIsDir && !selectedIsReadable);
  const historyBlocked =
    manualEdit.pending ||
    bulkAction !== undefined ||
    savingMemory ||
    libraryActionBusy ||
    selectedHasPendingCanonical ||
    availability.runtime !== 'connected';
  const busyOverlayMessage = bulkAction
    ? `${actionProgressLabel(bulkAction)} ${bulkCount} selected ${bulkCount === 1 ? 'memory' : 'memories'}...`
    : '';
  const metadataFieldsDisabled = Boolean(
    memory || selectedIsDir || selectedIsResource || (selectedUri && !selectedIsReadable),
  );
  const appStyle: React.CSSProperties & {'--sidebar-width': string} = {'--sidebar-width': `${sidebarWidth}px`};
  const updateIndicator = state ? managerUpdateIndicator(state) : undefined;

  const authoringMemory =
    creatingMemory ||
    (memoryViewMode === 'edit' &&
      selectedIsReadable &&
      !!selectedUri &&
      !selectedIsDir &&
      !selectedIsResource &&
      !selectedNode?.isSystem);
  const libraryDialogTitle =
    libraryDialog === 'consolidate' ? 'Consolidate memories' : selectedIsResource ? 'Source details' : 'Memory details';
  const consolidationPanel = (standalone = false) => (
    <ConsolidationPanel
      standalone={standalone}
      disabled={consolidationBusy || controlsBlocked}
      busy={consolidationBusy}
      canResume={!standalone && !!memory?.record?.metadata.consolidation}
      error={standalone ? undefined : memory?.record?.metadata.consolidationError}
      draftError={draftError}
      topic={consolidationTopic}
      project={consolidationProject ?? target.project}
      onTopicChange={setConsolidationTopic}
      onProjectChange={setConsolidationProject}
      agents={state?.agents ?? []}
      agent={agent}
      onAgentChange={value => void (isAgentClient(value) && setAgent(value))}
      openSelect={openSelect}
      setOpenSelect={setOpenSelect}
      canDraft={canDraftConsolidation}
      drafting={draftingConsolidation}
      applying={applyingConsolidation}
      draft={draft}
      sources={consolidationSources}
      reviews={consolidationReviews}
      onDraftChange={setDraft}
      onReviewChange={setConsolidationReviews}
      hasJob={!!jobId}
      onDraft={model => void draftConsolidation(model)}
      onApply={() => void applyConsolidation()}
      onResume={() => void resumeConsolidationCleanup()}
    />
  );
  const libraryDetails = (
    <aside className="inspector">
      <h3>{selectedIsResource ? 'Source details' : memory ? 'Memory details' : 'Properties'}</h3>
      {selectedUri && !selectedIsReadable && !selectedIsDir ? (
        <p className="muted">Metadata unavailable until the selected record loads.</p>
      ) : (
        <>
          {!metadataFieldsDisabled && creatingMemory ? (
            <TargetFields
              disabled={metadataFieldsDisabled}
              hideTopic
              onChange={setTarget}
              openSelect={openSelect}
              projectOptions={projectOptions}
              setOpenSelect={setOpenSelect}
              target={target}
            />
          ) : null}
          {!selectedUri && creatingMemory ? (
            <p className="muted">Written by you · saved locally. Publish separately to share with a team.</p>
          ) : selectedIsResource ? (
            <p className="muted">Indexed source content. This view does not edit the original file.</p>
          ) : null}
          <Metadata metadata={memory?.record?.metadata} node={memory?.node ?? selectedNode} />
        </>
      )}
      {!selectedIsResource && !creatingMemory ? consolidationPanel() : null}
    </aside>
  );
  const app = (
    <div className={`app${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}`} style={appStyle}>
      <ManagerNavigation
        project={workspaceProject}
        refreshGeneration={attentionRefreshGeneration}
        panel={panel}
        disabled={controlsBlocked}
        connected={!!state}
        contextHealthDecisionCount={contextHealthDecisionCount}
        onSelect={setPanel}
        width={sidebarWidth}
        onResizeKeyDown={resizeSidebarWithKeyboard}
        onResizePointerDown={startSidebarResize}
        updateIndicator={updateIndicator}
      />

      <main className="main">
        <div className="workspace-bar">
          <NavigationToggle collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
          <nav className="workspace-breadcrumb" aria-label="Breadcrumb">
            <span>Manager</span>
            <ChevronRight aria-hidden="true" />
            <span aria-current="page">{tabTitle(panel)}</span>
          </nav>
          <div className="workspace-bar-actions">
            {['home', 'memory', 'reviews', 'context-health'].includes(panel) ? (
              <select
                aria-label={panel === 'memory' ? 'Default project for new memories' : 'Workspace project'}
                title={panel === 'memory' ? 'Default project for new memories' : 'Workspace project'}
                value={workspaceProject}
                onChange={event => setWorkspaceProject(event.target.value)}
              >
                <option value="">All</option>
                {EffectArray.map(projectOptions, project => (
                  <option key={project} value={project}>
                    {project}
                  </option>
                ))}
              </select>
            ) : (
              <span className="muted">Local workspace</span>
            )}
            <button
              aria-label="Refresh manager"
              className="quiet-icon"
              disabled={bulkAction !== undefined || savingMemory || libraryActionBusy}
              onClick={() => void refreshAll()}
              title="Refresh manager"
              type="button"
            >
              <RefreshCw aria-hidden="true" />
            </button>
          </div>
        </div>
        <header className="topbar">
          <div className="page-title">
            <span>
              {panel === 'memory' && authoringMemory
                ? creatingMemory
                  ? 'New memory'
                  : 'Edit memory'
                : tabTitle(panel)}
            </span>
            <small>
              {panel === 'memory' && authoringMemory ? 'Write knowledge in your own words.' : panelDescription(panel)}
            </small>
          </div>
          <div className="action-row" id="manager-page-actions">
            {panel === 'memory' && authoringMemory ? (
              <button
                className="primary"
                disabled={
                  controlsBlocked ||
                  (creatingMemory &&
                    (!Effect.pipe(content, EffectString.trim) || !Effect.pipe(target.topic, EffectString.trim)))
                }
                onClick={() => void (creatingMemory ? saveNew() : saveCurrent())}
              >
                <Check aria-hidden="true" />
                {savingMemory ? 'Saving…' : creatingMemory ? 'Save memory' : 'Save'}
              </button>
            ) : panel === 'home' || panel === 'memory' ? (
              <button className="primary" disabled={controlsBlocked} onClick={() => void newMemory()}>
                <Plus aria-hidden="true" />
                New memory
              </button>
            ) : null}
            {panel === 'doctor' ? (
              <button disabled={doctorBusy} onClick={() => void loadDoctor()}>
                <RefreshCw aria-hidden="true" />
                {doctorBusy ? 'Running…' : 'Run diagnostics'}
              </button>
            ) : null}
            {panel !== 'memory' ? (
              <WorkspaceUtilities
                panel={panel}
                project={workspaceProject}
                projects={projectOptions}
                onChanged={refreshAll}
              />
            ) : null}
          </div>
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

        <div className="manager-content">
          {panel === 'graph' ? (
            <section className="panel graph-panel is-active">
              <GraphWorkspace
                administration={graphDiagnostics}
                administrationBusy={graphAdministrationBusyLabel(graphAdministrationBusy, graphCatalog)}
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
              showProjectSelector={false}
              onNewMemory={() => void newMemory()}
              onOpen={target => setPanel(target)}
              onOpenMemory={uri => {
                void selectTreeUri(uri);
              }}
              onProjectChange={setWorkspaceProject}
              project={workspaceProject}
              projects={projectOptions}
            />
          ) : null}

          {panel === 'reviews' ? (
            <ReviewsPanel
              onOpenLibrary={uri => {
                if (uri) void selectTreeUri(uri);
                else setPanel('memory');
              }}
              onProjectChange={setWorkspaceProject}
              project={workspaceProject}
              projects={projectOptions}
              refreshGeneration={attentionRefreshGeneration}
            />
          ) : null}

          {panel === 'context-health' ? (
            <ContextHealthPanel
              onDecisionCountChange={onHealthDecisionCountChange}
              onOpenLibrary={uri => {
                if (uri) void selectTreeUri(uri);
                else setPanel('memory');
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

          {['dev-skills', 'worksets', 'processes'].includes(panel) ? (
            <section className="panel is-active">
              {panel === 'dev-skills' ? <DevSkillsPanel /> : null}
              {panel === 'worksets' ? <WorksetsPanel /> : null}
              {panel === 'processes' ? <ProcessesPanel /> : null}
            </section>
          ) : null}

          {panel === 'memory' ? (
            <section className={`panel library-panel is-active${authoringMemory ? ' is-authoring' : ''}`}>
              {!authoringMemory ? (
                <>
                  <LibraryContentTabs
                    navTreeTab={navTreeTab}
                    controlsBlocked={controlsBlocked}
                    onTab={tab => void switchLibrary(tab)}
                  />
                  <div className="library-toolbar">
                    <LibraryHistoryControls
                      backDisabled={historyBlocked || libraryHistory.index <= 0}
                      forwardDisabled={historyBlocked || libraryHistory.index >= libraryHistory.entries.length - 1}
                      onNavigate={navigateLibraryHistory}
                    />
                    <LibraryScopeControls
                      navTreeTab={navTreeTab}
                      controlsBlocked={controlsBlocked}
                      libraryScope={libraryScope}
                      shares={shares}
                      onScope={scope => void switchLibrary('memories', scope)}
                    />
                    <label className="library-search">
                      <Search aria-hidden="true" />
                      <input
                        type="search"
                        aria-label="Search Library"
                        placeholder={navTreeTab === 'memories' ? 'Search memories or URI' : 'Filter resources'}
                        maxLength={4096}
                        value={filter}
                        disabled={historyBlocked}
                        onChange={event => setFilter(librarySearchInputValue(event.target.value))}
                        onKeyDown={event => {
                          if (event.nativeEvent.isComposing || event.key !== 'Enter' || !librarySearchIsUri) return;
                          event.preventDefault();
                          void selectTreeUri(librarySearchUri);
                        }}
                      />
                    </label>
                    <WorkspaceUtilities
                      panel="memory"
                      project={workspaceProject}
                      projects={projectOptions}
                      onChanged={refreshAll}
                      extraActions={[
                        {
                          label: showSystem ? 'Hide system files' : 'Show system files',
                          icon: <Settings2 />,
                          onSelect: () => setShowSystem(value => !value),
                        },
                        {
                          label: 'Consolidate memories…',
                          icon: <ListChecks />,
                          disabled: navTreeTab !== 'memories' || consolidationBusy || controlsBlocked,
                          onSelect: openConsolidation,
                        },
                      ]}
                    />
                  </div>
                  <MemorySelectionBar
                    count={selectedList.length}
                    disabled={controlsBlocked || consolidationBusy}
                    canConsolidate={canDraftConsolidation && navTreeTab === 'memories'}
                    canPublish={canBulkPublish}
                    scope={libraryScope}
                    onConsolidate={openConsolidation}
                    onBulkAction={action => void bulk(action)}
                    onClear={() => setSelectedUris(new Set())}
                  />
                </>
              ) : (
                <div className="library-editor-navigation">
                  <button
                    className="quiet-button"
                    onClick={() => {
                      if (memory) setMemoryViewMode('preview');
                      else void switchLibrary('memories');
                    }}
                  >
                    <ArrowLeft aria-hidden="true" />
                    Back to Library
                  </button>
                  <span>
                    <Pencil aria-hidden="true" />
                    Written by you
                  </span>
                </div>
              )}
              <div
                className={`library-workspace${libraryNavigator.resizing ? ' is-resizing' : ''}`}
                ref={libraryNavigator.workspaceRef}
                style={libraryNavigator.style}
              >
                {selectedUri && !selectedIsDir && !selectedIsReadable ? (
                  <div className="library-record-status" role="status">
                    {availability.selection === 'failed'
                      ? 'Could not load record. Refresh to retry.'
                      : 'Loading memory…'}
                  </div>
                ) : null}
                {!authoringMemory ? (
                  <LibraryExplorer
                    scopeLabel={libraryScope === 'local' ? 'Local' : Effect.pipe(libraryScope, EffectString.slice(5))}
                    busy={bulkAction !== undefined}
                    controlsBlocked={controlsBlocked}
                    filter={librarySearchIsUri ? '' : filter}
                    recalledUris={navTreeTab === 'memories' ? librarySearch.result?.uris : undefined}
                    searchStatus={
                      navTreeTab === 'memories' && Effect.pipe(filter, EffectString.trim)
                        ? librarySearchIsUri
                          ? 'Press Enter to open this memory.'
                          : librarySearch.pending
                            ? 'Searching memories…'
                            : librarySearch.error
                              ? 'Search unavailable. Showing title and path matches.'
                              : librarySearch.result?.semantic !== 'available'
                                ? 'Showing content, title and path matches. Semantic search is unavailable.'
                                : 'Showing matches by meaning, content, title and path.'
                        : undefined
                    }
                    navTreeTab={navTreeTab}
                    onFilter={setFilter}
                    onRefresh={() => void refreshAll()}
                    onSelect={uri => void selectTreeUri(uri)}
                    actions={itemActions}
                    onShowSystem={setShowSystem}
                    onTab={setNavTreeTab}
                    onToggleSelection={(node, checked) =>
                      setSelectedUris(current => toggleMemorySelection(current, node, checked))
                    }
                    resourceTree={resourceTree}
                    selectedUri={selectedUri}
                    selectedUris={selectedUris}
                    showSystem={showSystem}
                    tree={scopedTree}
                  />
                ) : null}
                {!authoringMemory ? libraryNavigator.resizer : null}
                <div className="content-grid">
                  <section className="editor-pane">
                    <LibraryReaderHeader
                      authoringMemory={authoringMemory}
                      creatingMemory={creatingMemory}
                      selectedNode={selectedNode}
                      selectedUri={selectedUri}
                      selectedIsDir={selectedIsDir}
                      selectedIsResource={selectedIsResource}
                      selectedIsReadable={selectedIsReadable}
                      controlsBlocked={controlsBlocked}
                      canMutate={canMutate}
                      itemActions={itemActions}
                      onToggleView={() => setMemoryViewMode(memoryViewMode === 'preview' ? 'edit' : 'preview')}
                      onDetails={() => setLibraryDialog('details')}
                      onMove={() => void moveCurrent()}
                    />
                    {pendingCanonical && selectedUri === pendingCanonical.node.uri ? (
                      <div className="manager-draft-reconcile" role="alert">
                        <p>The saved record changed. Your unsaved draft is preserved.</p>
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
                    ) : !selectedUri && !creatingMemory ? (
                      <div className="library-empty">
                        <h3>
                          {navTreeTab === 'resources'
                            ? 'Browse your source material'
                            : libraryScope === 'local'
                              ? 'Your private memory library'
                              : 'Shared team knowledge'}
                        </h3>
                        <p>
                          {navTreeTab === 'resources'
                            ? 'Choose a resource in the explorer to inspect its indexed content.'
                            : 'Choose a memory to read, or capture something new.'}
                        </p>
                        {navTreeTab === 'memories' ? (
                          <button onClick={() => void newMemory()}>New memory</button>
                        ) : null}
                      </div>
                    ) : memoryViewMode === 'preview' && selectedIsMarkdown && !selectedIsDir ? (
                      <LibraryArticle
                        node={selectedNode!}
                        metadata={memory?.record?.metadata}
                        markdown={markdownPreview}
                        resource={selectedIsResource}
                        onOpenMemory={uri => void selectTreeUri(uri)}
                        onChanged={() => void refreshAll()}
                        onVerifiedUpdate={() =>
                          memoryUpdateVerified(selectedNode!.uri, 'Memory update saved and verified')
                        }
                        onPrepareGraph={() => setPanel('graph')}
                      />
                    ) : selectedIsDir ? (
                      <div className="library-empty">
                        <h3>{selectedNode?.name}</h3>
                        <p>
                          {selectedNode ? countFiles(selectedNode) : 0} files in this folder. Select its checkbox to
                          include all descendant memories.
                        </p>
                      </div>
                    ) : selectedIsResource ? (
                      <pre className="resource-content">{content}</pre>
                    ) : (
                      <>
                        {!memory ? (
                          <label className="memory-title-field">
                            Title
                            <input
                              aria-label="Memory title"
                              placeholder="Give this memory a name"
                              value={target.topic}
                              disabled={controlsBlocked}
                              onChange={event => setTarget(current => ({...current, topic: event.target.value}))}
                            />
                          </label>
                        ) : null}
                        <MemoryEditor
                          key={`${selectedUri ?? 'new'}:${editorRevision}`}
                          content={content}
                          disabled={controlsBlocked}
                          onChange={next => {
                            if (selectedUri && memory)
                              draftRef.current = {base: memory.content, text: next, uri: selectedUri};
                            setContent(next);
                          }}
                        />
                      </>
                    )}
                  </section>

                  {creatingMemory ? libraryDetails : null}
                  {libraryDialog ? (
                    <DetailModal title={libraryDialogTitle} onClose={() => setLibraryDialog(undefined)}>
                      {libraryDialog === 'consolidate' ? (
                        consolidationPanel(true)
                      ) : (
                        <>
                          {libraryDetails}
                          <p className="uri-line">{selectedUri}</p>
                        </>
                      )}
                    </DetailModal>
                  ) : null}
                </div>
              </div>
              {output ? (
                <details className="library-result">
                  <summary>Last operation</summary>
                  <pre className="output">{output}</pre>
                </details>
              ) : null}
            </section>
          ) : null}

          {panel === 'integrations' ? (
            <IntegrationsPanel
              integrations={integrations}
              onChanged={refreshAll}
              onReviews={() => setPanel('reviews')}
            />
          ) : null}
          {panel === 'shares' ? (
            <SharingPanel
              shares={shares}
              onChanged={refreshAll}
              onBrowse={team => {
                void switchLibrary('memories', `team:${team}`).then(() => setPanel('memory'));
              }}
            />
          ) : null}

          {panel === 'doctor' ? (
            <RuntimeHealthPanel
              checks={doctor}
              busy={doctorAction}
              output={doctorOutput}
              onVerify={() =>
                void runDoctorAction('Runtime ready', 'Checking runtime', () =>
                  api('/api/doctor/start', {}, undefined, isOutputResponse2),
                )
              }
              onPreviewRepair={() =>
                runDoctorAction('Repair preview complete', 'Preparing repair preview', () =>
                  api('/api/doctor/repair-dry-run', {}, undefined, isOutputResponse2),
                )
              }
              onRepair={() => void repairThreadnote()}
              onRefresh={() => void refreshAll()}
            />
          ) : null}
        </div>
        <footer className="workspace-footer">
          <ManagerOperationsFooter onOpen={() => setPanel('processes')} />
          <div className="workspace-footer-meta">
            <span>Threadnote Manager · Local workspace</span>
            <span>{state ? `v${state.version}` : 'Connecting…'}</span>
          </div>
        </footer>
      </main>
      {busyOverlayMessage ? (
        <div aria-live="polite" className="busy-overlay" role="status">
          <div className="busy-panel">{busyOverlayMessage}</div>
        </div>
      ) : null}
      {toast ? <div className="toast">{toast}</div> : null}
      {manualEdit.dialog}
    </div>
  );
  return app;
}

export function mountManager(options: {readonly integrations: readonly IntegrationRegistration[]}): void {
  mountManagerApp(App, options);
}
