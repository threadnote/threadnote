import {Schema} from 'effect';
import React, {useMemo} from 'react';
import {trimTrailingCharacters} from '@threadnote/platform/string-boundaries';
import {ManagerAutocompleteInput} from '@threadnote/manager/dialog';
import type {
  GraphAnalysis,
  GraphAdministrationAction,
  GraphCatalogPage,
  GraphNodeDetail,
  GraphQueryVisualization,
  GraphVisualization,
  GraphViewPage,
} from '@threadnote/manager/graph';
import type {ManagerGraphVisualizationLimits} from '@threadnote/graph/visualization/limits';
import type {BulkItemResult, PanelName, ShareSummary, TreeNode} from '@threadnote/manager/ui/contracts';

const token = typeof window === 'undefined' ? '' : (new URLSearchParams(window.location.search).get('token') ?? '');
export const GRAPH_CATALOG_REQUEST_TIMEOUT_MILLISECONDS = 10_000;
export const isAgentClient = Schema.is(Schema.Literals(['claude', 'codex', 'copilot', 'cursor', 'effect-ai']));
export const isMemoryKind = Schema.is(Schema.Literals(['durable', 'handoff', 'incident', 'preference', 'smoke']));
export const isMemoryStatus = Schema.is(Schema.Literals(['active', 'archived', 'expired', 'superseded']));
export const GRAPH_DETAIL_REQUEST_TIMEOUT_MILLISECONDS = 30_000;
export const SIDEBAR_WIDTH_DEFAULT = 300;
export const SIDEBAR_WIDTH_KEY = 'threadnote.manager.sidebarWidth';
export const SIDEBAR_WIDTH_MAX = 440;
export const SIDEBAR_WIDTH_MIN = 260;

export function canPublishMemoryFromManager(
  uri: string | undefined,
  metadata: {readonly kind?: string; readonly status?: string} | undefined,
): boolean {
  if (!uri || !/^threadnote:\/\/user\/[^/]+\/memories\/durable\/projects\/.+\.md$/u.test(uri)) return false;
  return metadata?.kind === 'durable' && metadata.status === 'active';
}

export function canPublishSelectedMemoriesFromManager(tree: TreeNode | undefined, uris: readonly string[]): boolean {
  if (!tree || uris.length === 0) return false;
  const selected = new Set(uris);
  let eligibleCount = 0;
  const visit = (node: TreeNode): boolean => {
    if (selected.has(node.uri)) {
      if (node.isDir || node.isShared || !canPublishMemoryFromManager(node.uri, node.metadata)) return false;
      eligibleCount += 1;
    }
    for (const child of node.children ?? []) {
      if (!visit(child)) return false;
    }
    return true;
  };
  return visit(tree) && eligibleCount === selected.size;
}

export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)));
}

export function loadSidebarWidth(): number {
  const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(stored) && stored > 0 ? clampSidebarWidth(stored) : SIDEBAR_WIDTH_DEFAULT;
}

function SharesPanel(props: {
  readonly createShare: () => void;
  readonly keepShareFiles: boolean;
  readonly loadShares: () => void;
  readonly preserveShare: boolean;
  readonly removeShare: () => void;
  readonly renameShare: () => void;
  readonly renameShareTo: string;
  readonly selectedShare: string;
  readonly setKeepShareFiles: (value: boolean) => void;
  readonly setPreserveShare: (value: boolean) => void;
  readonly setRenameShareTo: (value: string) => void;
  readonly setSelectedShare: (value: string) => void;
  readonly setShareNewUrl: (value: string) => void;
  readonly setShareRemote: (value: string) => void;
  readonly setShareTeam: (value: string) => void;
  readonly setShareUrl: () => void;
  readonly shareNewUrl: string;
  readonly shareRemote: string;
  readonly shares: readonly ShareSummary[];
  readonly shareTeam: string;
  readonly syncShare: () => void;
}): React.ReactElement {
  const teamOptions = useMemo(
    () => uniqueSelectorValues(['default', ...props.shares.map(share => share.name)]),
    [props.shares],
  );
  return (
    <section className="panel is-active">
      <div className="split">
        <section>
          <div className="pane-head">
            <h2>Team Shares</h2>
            <button onClick={props.loadShares}>Refresh</button>
          </div>
          <div className="list">
            {props.shares.map(share => (
              <button
                className={`list-item ${props.selectedShare === share.name ? 'is-selected' : ''}`}
                key={share.name}
                onClick={() => props.setSelectedShare(share.name)}
              >
                <strong>
                  {share.name}
                  {share.default ? ' · default' : ''}
                </strong>
                <span className={`badge ${share.dirty ? 'warn' : 'ok'}`}>{share.dirty ? 'dirty' : 'clean'}</span>
                {share.behind ? <span className="badge warn">behind {share.behind}</span> : null}
                {share.ahead ? <span className="badge warn">ahead {share.ahead}</span> : null}
                <p>{share.remote}</p>
                <p className="muted">{share.worktree}</p>
                {share.warning ? <p className="danger-text">{share.warning}</p> : null}
              </button>
            ))}
          </div>
        </section>
        <aside className="form-pane">
          <h3>Create Share</h3>
          <ManagerAutocompleteInput
            allowCreate
            onChange={props.setShareTeam}
            options={teamOptions}
            placeholder="team name"
            value={props.shareTeam}
          />
          <input
            value={props.shareRemote}
            onChange={event => props.setShareRemote(event.target.value)}
            placeholder="git remote URL"
          />
          <button onClick={props.createShare}>Create</button>
          <h3>Selected Share</h3>
          <ManagerAutocompleteInput
            onChange={props.setSelectedShare}
            options={teamOptions}
            placeholder="team"
            value={props.selectedShare}
          />
          <ManagerAutocompleteInput
            allowCreate
            onChange={props.setRenameShareTo}
            options={teamOptions}
            placeholder="new team name"
            value={props.renameShareTo}
          />
          <button onClick={props.renameShare}>Rename</button>
          <input
            value={props.shareNewUrl}
            onChange={event => props.setShareNewUrl(event.target.value)}
            placeholder="new git remote URL"
          />
          <button onClick={props.setShareUrl}>Set URL</button>
          <label className="check-row">
            <input
              checked={props.preserveShare}
              onChange={event => props.setPreserveShare(event.target.checked)}
              type="checkbox"
            />
            <span>Preserve local copies</span>
          </label>
          <label className="check-row">
            <input
              checked={props.keepShareFiles}
              onChange={event => props.setKeepShareFiles(event.target.checked)}
              type="checkbox"
            />
            <span>Keep files</span>
          </label>
          <button onClick={props.syncShare}>Sync</button>
          <button className="danger" onClick={props.removeShare}>
            Remove
          </button>
        </aside>
      </div>
    </section>
  );
}

export class ManagerApiError extends Schema.TaggedError<ManagerApiError>()('ManagerApiError', {
  code: Schema.optionalKey(Schema.String),
  message: Schema.String,
  retryAfterMilliseconds: Schema.optionalKey(Schema.Finite),
  status: Schema.Finite,
}) {
  static of(message: string, status: number, code?: string, retryAfterMilliseconds?: number): ManagerApiError {
    return ManagerApiError.make({
      message,
      status,
      ...(code === undefined ? {} : {code}),
      ...(retryAfterMilliseconds === undefined ? {} : {retryAfterMilliseconds}),
    });
  }
}

async function api<T>(
  path: string,
  body?: Record<string, unknown>,
  options: {readonly signal?: AbortSignal; readonly timeoutMilliseconds?: number} = {},
): Promise<T> {
  const controller = options.timeoutMilliseconds === undefined ? undefined : new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller?.abort(options.signal?.reason);
  if (controller && options.signal) {
    if (options.signal.aborted) abortFromCaller();
    else options.signal.addEventListener('abort', abortFromCaller, {once: true});
  }
  const timeout =
    controller && options.timeoutMilliseconds !== undefined
      ? window.setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, options.timeoutMilliseconds)
      : undefined;
  try {
    const response = await fetch(path, {
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: body ? 'POST' : 'GET',
      signal: controller?.signal ?? options.signal,
    });
    const data = (await response.json()) as {
      readonly code?: string;
      readonly error?: string;
      readonly reason?: string;
      readonly retryAfterMilliseconds?: number;
    };
    if (!response.ok) {
      throw ManagerApiError.of(
        data.error ?? data.reason ?? `HTTP ${response.status}`,
        response.status,
        data.code,
        data.retryAfterMilliseconds,
      );
    }
    return data as T;
  } catch (cause) {
    if (timedOut) {
      throw new Error(`Manager request timed out after ${options.timeoutMilliseconds} ms. Retry the operation.`, {
        cause,
      });
    }
    throw cause;
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export function graphAdministrationActionLabel(action: GraphAdministrationAction): string {
  switch (action.action) {
    case 'compact':
      return action.dryRun ? 'Compaction preview' : 'Graph compaction';
    case 'index':
      return action.full ? 'Graph reindex' : 'Graph index';
    case 'index-cwd':
      return action.full ? 'Workspace graph reindex' : 'Workspace graph index';
    case 'index-project':
      return action.full ? 'Configured project reindex' : 'Configured project index';
    case 'purge':
      return action.dryRun ? 'Graph purge preview' : 'Graph purge';
    case 'purge-all':
      return action.dryRun ? 'All-graph purge preview' : 'All-graph purge';
    case 'purge-obsolete':
      return action.dryRun ? 'Obsolete-store preview' : 'Obsolete-store purge';
    case 'remove-view':
      return action.dryRun ? 'View removal preview' : 'View removal';
    case 'repair':
      return action.dryRun ? 'Graph repair preview' : action.deep ? 'Deep graph repair' : 'Graph repair';
  }
}

function loadManagerGraph(
  repositoryId: string,
  snapshotId: string,
  projectId: string,
  limits: ManagerGraphVisualizationLimits,
  signal: AbortSignal,
): Promise<GraphVisualization> {
  return api<GraphVisualization>(
    `/api/graph?repository=${encodeURIComponent(repositoryId)}&snapshot=${encodeURIComponent(snapshotId)}&project=${encodeURIComponent(projectId)}&nodeLimit=${limits.nodeLimit}&edgeLimit=${limits.edgeLimit}`,
    undefined,
    {signal, timeoutMilliseconds: GRAPH_DETAIL_REQUEST_TIMEOUT_MILLISECONDS},
  );
}

function loadManagerGraphCatalogPage(
  repositoryId: string,
  snapshotId: string,
  projectOffset: number,
  workspaceOffset: number,
  query: string,
  signal: AbortSignal,
): Promise<GraphCatalogPage> {
  return api<GraphCatalogPage>(
    `/api/graphs/page?repository=${encodeURIComponent(repositoryId)}&snapshot=${encodeURIComponent(snapshotId)}&offset=${projectOffset}&workspaceOffset=${workspaceOffset}${query ? `&query=${encodeURIComponent(query)}` : ''}`,
    undefined,
    {signal, timeoutMilliseconds: GRAPH_CATALOG_REQUEST_TIMEOUT_MILLISECONDS},
  );
}

function loadManagerGraphViewsPage(
  repositoryId: string,
  offset: number,
  query: string,
  scopeIds: readonly string[],
  signal: AbortSignal,
): Promise<GraphViewPage> {
  const scopeQuery = scopeIds.map(scopeId => `&scope=${encodeURIComponent(scopeId)}`).join('');
  return api<GraphViewPage>(
    `/api/graphs/views?repository=${encodeURIComponent(repositoryId)}&offset=${offset}${query ? `&query=${encodeURIComponent(query)}` : ''}${scopeQuery}`,
    undefined,
    {signal, timeoutMilliseconds: GRAPH_CATALOG_REQUEST_TIMEOUT_MILLISECONDS},
  );
}

function loadManagerGraphAnalysis(
  repositoryId: string,
  snapshotId: string,
  signal: AbortSignal,
): Promise<GraphAnalysis> {
  return api<GraphAnalysis>(
    `/api/graph/analysis?repository=${encodeURIComponent(repositoryId)}&snapshot=${encodeURIComponent(snapshotId)}`,
    undefined,
    {signal, timeoutMilliseconds: GRAPH_DETAIL_REQUEST_TIMEOUT_MILLISECONDS},
  );
}

function loadManagerGraphNodeDetail(
  repositoryId: string,
  snapshotId: string,
  nodeId: string,
  signal: AbortSignal,
): Promise<GraphNodeDetail> {
  return api<GraphNodeDetail>(
    `/api/graph/node?repository=${encodeURIComponent(repositoryId)}&snapshot=${encodeURIComponent(snapshotId)}&node=${encodeURIComponent(nodeId)}`,
    undefined,
    {signal, timeoutMilliseconds: GRAPH_DETAIL_REQUEST_TIMEOUT_MILLISECONDS},
  );
}

function loadManagerGraphQuery(
  repositoryId: string,
  snapshotId: string,
  query: string,
  limits: ManagerGraphVisualizationLimits,
  signal: AbortSignal,
): Promise<GraphQueryVisualization> {
  return api<GraphQueryVisualization>(
    `/api/graph/query?repository=${encodeURIComponent(repositoryId)}&snapshot=${encodeURIComponent(snapshotId)}&query=${encodeURIComponent(query)}&nodeLimit=${limits.nodeLimit}&edgeLimit=${limits.edgeLimit}`,
    undefined,
    {signal, timeoutMilliseconds: GRAPH_DETAIL_REQUEST_TIMEOUT_MILLISECONDS},
  );
}

function findNode(node: TreeNode, uri: string): TreeNode | undefined {
  if (node.uri === uri) {
    return node;
  }
  for (const child of node.children ?? []) {
    const found = findNode(child, uri);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function findNodeInTrees(trees: readonly (TreeNode | undefined)[], uri: string): TreeNode | undefined {
  for (const tree of trees) {
    const node = tree ? findNode(tree, uri) : undefined;
    if (node) {
      return node;
    }
  }
  return undefined;
}

export function managerProjectOptions(tree: TreeNode | undefined): readonly string[] {
  const projects: string[] = [];
  const visit = (node: TreeNode): void => {
    if (node.metadata?.project) projects.push(node.metadata.project);
    for (const child of node.children ?? []) visit(child);
  };
  if (tree) visit(tree);
  return uniqueSelectorValues(projects);
}

function uniqueSelectorValues(values: readonly string[]): readonly string[] {
  const unique = new Map<string, string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const normalized = trimmed.toLocaleLowerCase();
    if (!unique.has(normalized)) unique.set(normalized, trimmed);
  }
  return [...unique.values()].sort((left, right) => left.localeCompare(right));
}

function treeItemClass(active: boolean, readOnly: boolean, base?: string): string | undefined {
  const classes = [base, active ? 'is-active' : undefined, readOnly ? 'is-readonly' : undefined].filter(
    (value): value is string => typeof value === 'string',
  );
  return classes.length > 0 ? classes.join(' ') : undefined;
}

function countFiles(node: TreeNode): number {
  if (!node.isDir) {
    return 1;
  }
  return (node.children ?? []).reduce((total, child) => total + countFiles(child), 0);
}

export function selectableMemoryUris(
  node: TreeNode,
  options: {readonly filter: string; readonly showSystem: boolean},
): readonly string[] {
  if (!options.showSystem && node.isSystem) {
    return [];
  }
  if (options.filter && !nodeMatches(node, options.filter)) {
    return [];
  }
  if (!node.isDir) {
    return [node.uri];
  }
  return (node.children ?? []).flatMap(child => selectableMemoryUris(child, options));
}

export function pruneSelectedMemoryUris(
  selectedUris: ReadonlySet<string>,
  tree: TreeNode | undefined,
  options: {readonly filter: string; readonly showSystem: boolean},
): ReadonlySet<string> {
  if (!tree || selectedUris.size === 0) {
    return selectedUris;
  }
  const selectableUris = new Set(selectableMemoryUris(tree, options));
  let changed = false;
  const next = new Set<string>();
  for (const uri of selectedUris) {
    if (selectableUris.has(uri)) {
      next.add(uri);
    } else {
      changed = true;
    }
  }
  return changed ? next : selectedUris;
}

function isMarkdownNode(node: TreeNode): boolean {
  return !node.isDir && isMarkdownUri(node.name);
}

function isMarkdownUri(uri: string): boolean {
  return uri.toLowerCase().endsWith('.md');
}

function isResourceUri(uri: string): boolean {
  return uri === 'threadnote://resources' || uri.startsWith('threadnote://resources/');
}

function markdownBodyForPreview(content: string): string {
  if (!content.startsWith('MEMORY\n') && !content.startsWith('HANDOFF\n')) {
    return content;
  }
  const separatorIndex = content.indexOf('\n\n');
  return separatorIndex === -1 ? '' : content.slice(separatorIndex + 2).trimStart();
}

function nodeMatches(node: TreeNode, filter: string): boolean {
  const needle = filter.toLowerCase();
  if (node.name.toLowerCase().includes(needle) || node.uri.toLowerCase().includes(needle)) {
    return true;
  }
  return (node.children ?? []).some(child => nodeMatches(child, filter));
}

function resourceUrisFromText(text: string): readonly string[] {
  const matches = text.match(/threadnote:\/\/[^\s)"'<>`\]]+/g) ?? [];
  return [...new Set(matches.map(uri => trimTrailingCharacters(uri, '.,;:')))];
}

function formatBulkResults(action: string, results: readonly BulkItemResult[]): string {
  const succeeded = results.filter(result => result.ok);
  const failed = results.filter(result => !result.ok);
  return [
    `Bulk ${action} complete: ${succeeded.length} succeeded, ${failed.length} failed.`,
    '',
    ...results.map(result => `${result.ok ? 'OK' : 'FAIL'} ${result.uri}${result.error ? ` (${result.error})` : ''}`),
  ].join('\n');
}

function bulkActionLabel(action: 'archive' | 'forget' | 'publish'): string {
  switch (action) {
    case 'archive':
      return 'Archive';
    case 'forget':
      return 'Forget';
    case 'publish':
      return 'Publish';
  }
}

function actionProgressLabel(action: 'archive' | 'forget' | 'publish'): string {
  switch (action) {
    case 'archive':
      return 'Archiving';
    case 'forget':
      return 'Forgetting';
    case 'publish':
      return 'Publishing';
  }
}

function tabTitle(name: PanelName): string {
  switch (name) {
    case 'context':
      return 'Context';
    case 'context-health':
      return 'Context Health';
    case 'doctor':
      return 'Health';
    case 'graph':
      return 'Graph';
    case 'home':
      return 'Home';
    case 'memory':
      return 'Library';
    case 'processes':
      return 'Processes';
    case 'reviews':
      return 'Reviews';
    case 'shares':
      return 'Sharing';
    case 'tools':
      return 'Tools';
    case 'worksets':
      return 'Worksets';
  }
}

function panelIcon(name: PanelName): string {
  switch (name) {
    case 'context':
      return '◎';
    case 'context-health':
      return '♡';
    case 'doctor':
      return '✓';
    case 'graph':
      return '◉';
    case 'home':
      return '⌂';
    case 'memory':
      return '◇';
    case 'processes':
      return '▣';
    case 'reviews':
      return '☷';
    case 'shares':
      return '⇄';
    case 'tools':
      return '··';
    case 'worksets':
      return '⌘';
  }
}

function panelNavDescription(name: PanelName): string {
  switch (name) {
    case 'context':
      return 'Briefs and recall';
    case 'context-health':
      return 'Memory quality findings';
    case 'doctor':
      return 'Runtime diagnostics';
    case 'graph':
      return 'Explore architecture';
    case 'home':
      return 'Project attention and next steps';
    case 'memory':
      return 'Memories and resources';
    case 'processes':
      return 'Verified runtimes';
    case 'reviews':
      return 'Knowledge awaiting review';
    case 'shares':
      return 'Team repositories';
    case 'tools':
      return 'Recall and maintenance';
    case 'worksets':
      return 'Cross-repository work';
  }
}

function panelDescription(name: PanelName): string {
  switch (name) {
    case 'context':
      return 'Compose Context Briefs and read ranked memory';
    case 'context-health':
      return 'Inspect actionable quality findings for project context';
    case 'doctor':
      return 'Diagnostics and runtime repair';
    case 'graph':
      return 'Repository architecture explorer';
    case 'home':
      return 'Review project attention and continue local work';
    case 'memory':
      return 'Browse, edit, and consolidate context';
    case 'processes':
      return 'Inspect and safely terminate registered Threadnote runtimes';
    case 'reviews':
      return 'Inspect proposed memories that need a decision';
    case 'shares':
      return 'Manage synchronized team context';
    case 'tools':
      return 'Recall, compact, import, export, and seed';
    case 'worksets':
      return 'Manage and search published cross-repository worksets';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export {
  SharesPanel,
  actionProgressLabel,
  api,
  bulkActionLabel,
  countFiles,
  errorMessage,
  findNode,
  findNodeInTrees,
  formatBulkResults,
  isMarkdownNode,
  isMarkdownUri,
  isResourceUri,
  loadManagerGraph,
  loadManagerGraphAnalysis,
  loadManagerGraphCatalogPage,
  loadManagerGraphNodeDetail,
  loadManagerGraphQuery,
  loadManagerGraphViewsPage,
  markdownBodyForPreview,
  nodeMatches,
  panelDescription,
  panelIcon,
  panelNavDescription,
  resourceUrisFromText,
  tabTitle,
  treeItemClass,
  uniqueSelectorValues,
};
