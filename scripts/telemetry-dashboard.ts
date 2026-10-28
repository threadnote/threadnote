import {Effect, Schema} from 'effect';
class ScriptError extends Schema.TaggedError<ScriptError>()('ScriptError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

class GrafanaHttpError extends Schema.TaggedError<GrafanaHttpError>()('GrafanaHttpError', {
  status: Schema.Finite,
}) {
  override get message(): string {
    return this.status === 401
      ? 'Grafana API request failed with HTTP 401; the service-account token is invalid or expired.'
      : `Grafana API request failed with HTTP ${this.status}.`;
  }

  static of(status: number): GrafanaHttpError {
    return GrafanaHttpError.make({status});
  }
}

class GrafanaTransportError extends Schema.TaggedError<GrafanaTransportError>()('GrafanaTransportError', {
  message: Schema.String.pipe(
    Schema.withConstructorDefault(Effect.succeed('Grafana API request failed before receiving a response.')),
  ),
}) {
  static of(): GrafanaTransportError {
    return GrafanaTransportError.make({});
  }
}

export const telemetryDashboardSourcePath = 'infra/telemetry-gateway/threadnote-anonymous-telemetry-dashboard.json';
export const telemetryDashboardArtifactPath = 'infra/telemetry-dashboard/threadnote-telemetry.artifact';
export const telemetryDashboardDatasourceUid = 'grafanacloud-traces';
export const telemetryDashboardFolderUid = 'threadnote-telemetry-private';
export const telemetryDashboardFolderTitle = 'Threadnote private telemetry';
export const telemetryDashboardUid = 'threadnote-telemetry';
export const telemetryDashboardQueryLengthLimit = 1024;
export const telemetryDashboardSyntheticCanaryExclusion = 'resource.service.version != "0.0.0-canary"';
export const telemetryDashboardUnexpectedFullBuildExpression = '$A / ($B + ($B == 0)) * 100';

type JsonPrimitive = boolean | null | number | string;
interface JsonArray extends ReadonlyArray<JsonValue> {
  readonly [index: number]: JsonValue;
}
interface JsonObject {
  readonly [key: string]: JsonValue;
}
export type JsonValue = JsonArray | JsonObject | JsonPrimitive;

export type DashboardArtifact = Readonly<{
  dashboardUid: typeof telemetryDashboardUid;
  folderUid: typeof telemetryDashboardFolderUid;
  spec: Readonly<Record<string, JsonValue>>;
}>;

export type DashboardDeploymentDecision = 'noop' | 'update';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const datasourcePlaceholder = '${DS_TEMPO}';
const serverOwnedDashboardKeys = new Set(['id', 'iteration', 'schemaVersion', 'uid', 'version']);
const migrationEmptyFieldConfigPanelIds = new Set([14, 15, 16, 17, 18, 19]);
const migrationEmptyMappingsPanelIds = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 21, 22, 23, 24, 25]);
const migrationEmptyOverridesPanelIds = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 21, 22, 23, 24, 25]);
const grafanaDefaultRefreshIntervals = ['5s', '10s', '30s', '1m', '5m', '15m', '30m', '1h', '2h', '1d'];
const grafanaCloudNamespacePattern = /^stacks-[1-9][0-9]*$/u;
const gitCommitPattern = /^[0-9a-f]{40}$/u;
const dashboardApiVersion = 'dashboard.grafana.app/v1';
const folderApiVersion = 'folder.grafana.app/v1';
const grafanaSharedWithMeFolderScope = 'folders:uid:sharedwithme';

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw ScriptError.make({message: `${path} must be an object.`});
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined) return {};
  return record(value, path);
}

export function validateGrafanaCloudNamespace(value: string): string {
  if (value.length > 63 || !grafanaCloudNamespacePattern.test(value)) {
    throw ScriptError.make({
      message: 'THREADNOTE_TELEMETRY_GRAFANA_NAMESPACE must use the stacks-<numeric-stack-id> format.',
    });
  }
  return value;
}

export function validateGitCommit(value: string, variableName: string): string {
  if (!gitCommitPattern.test(value))
    throw ScriptError.make({message: `${variableName} must be a full lowercase Git commit SHA.`});
  return value;
}

function cloneResolvingDatasource(value: unknown, path: string, replacements: {count: number}): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (value === datasourcePlaceholder) {
      replacements.count += 1;
      return telemetryDashboardDatasourceUid;
    }
    if (value.includes(datasourcePlaceholder)) {
      throw ScriptError.make({message: `${path} embeds the Tempo data-source placeholder in an unsupported string.`});
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => cloneResolvingDatasource(item, `${path}[${index}]`, replacements));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneResolvingDatasource(item, `${path}.${key}`, replacements)]),
    );
  }
  throw ScriptError.make({message: `${path} contains a value that JSON cannot represent.`});
}

function cloneJson(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => cloneJson(item, `${path}[${index}]`));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item, `${path}.${key}`)]));
  }
  throw ScriptError.make({message: `${path} contains a value that JSON cannot represent.`});
}

function sortedJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortedJson(item)]),
    );
  }
  return value;
}

export function canonicalJson(value: JsonValue): string {
  return `${JSON.stringify(sortedJson(value), null, 2)}\n`;
}

function validateImportContract(source: Record<string, unknown>): void {
  if (source.uid !== telemetryDashboardUid)
    throw ScriptError.make({message: `Dashboard uid must remain ${telemetryDashboardUid}.`});
  const inputs = source.__inputs;
  if (!Array.isArray(inputs) || inputs.length !== 1) {
    throw ScriptError.make({message: 'Dashboard import source must declare exactly one Tempo input.'});
  }
  const input = record(inputs[0], 'dashboard.__inputs[0]');
  if (input.name !== 'DS_TEMPO' || input.pluginId !== 'tempo' || input.type !== 'datasource') {
    throw ScriptError.make({message: 'Dashboard import source must declare the DS_TEMPO Tempo data-source input.'});
  }
}

export function renderDashboardArtifact(source: unknown): DashboardArtifact {
  const sourceRecord = record(source, 'dashboard');
  validateImportContract(sourceRecord);
  const replacements = {count: 0};
  const resolved = record(cloneResolvingDatasource(sourceRecord, 'dashboard', replacements), 'dashboard');
  if (replacements.count === 0)
    throw ScriptError.make({message: 'Dashboard import source does not use the DS_TEMPO placeholder.'});
  for (const key of ['__inputs', '__requires', ...serverOwnedDashboardKeys]) delete resolved[key];

  const artifact: DashboardArtifact = {
    dashboardUid: telemetryDashboardUid,
    folderUid: telemetryDashboardFolderUid,
    spec: resolved as Readonly<Record<string, JsonValue>>,
  };
  validateDashboardArtifact(artifact);
  return artifact;
}

type TempoQuery = Readonly<{
  panelId: number;
  query: string;
  target: Readonly<Record<string, JsonValue>>;
  targetIndex: number;
}>;

export function collectTempoQueries(resource: DashboardArtifact): readonly TempoQuery[] {
  const panels = resource.spec.panels;
  if (!Array.isArray(panels) || panels.length === 0)
    throw ScriptError.make({message: 'Dashboard artifact has no panels.'});
  const queries: TempoQuery[] = [];
  for (const [panelIndex, panelValue] of panels.entries()) {
    const panel = record(panelValue, `dashboard.panels[${panelIndex}]`);
    if (!Number.isInteger(panel.id))
      throw ScriptError.make({message: `dashboard.panels[${panelIndex}].id must be an integer.`});
    const panelId = panel.id as number;
    const panelDatasource = record(panel.datasource, `dashboard.panels[${panelIndex}].datasource`);
    if (panelDatasource.type !== 'tempo' || panelDatasource.uid !== telemetryDashboardDatasourceUid) {
      throw ScriptError.make({message: `Dashboard panel ${panelId} must use the production Tempo data source.`});
    }
    if (!Array.isArray(panel.targets) || panel.targets.length === 0) {
      throw ScriptError.make({message: `Dashboard panel ${panelId} has no query targets.`});
    }
    for (const [targetIndex, targetValue] of panel.targets.entries()) {
      const target = record(targetValue, `dashboard.panels[${panelIndex}].targets[${targetIndex}]`);
      const datasource = record(
        target.datasource,
        `dashboard.panels[${panelIndex}].targets[${targetIndex}].datasource`,
      );
      if (datasource.type === '__expr__') continue;
      if (datasource.type !== 'tempo' || datasource.uid !== telemetryDashboardDatasourceUid) {
        throw ScriptError.make({
          message: `Dashboard panel ${panelId} target ${targetIndex} uses an unexpected data source.`,
        });
      }
      if (target.queryType !== 'traceql' || typeof target.query !== 'string' || target.query.length === 0) {
        throw ScriptError.make({
          message: `Dashboard panel ${panelId} target ${targetIndex} must contain a TraceQL query.`,
        });
      }
      if (target.query.length > telemetryDashboardQueryLengthLimit) {
        throw ScriptError.make({
          message: `Dashboard panel ${panelId} target ${targetIndex} exceeds the ${telemetryDashboardQueryLengthLimit}-character Tempo query limit.`,
        });
      }
      if (!target.query.includes(telemetryDashboardSyntheticCanaryExclusion)) {
        throw ScriptError.make({
          message: `Dashboard panel ${panelId} target ${targetIndex} does not exclude synthetic canaries.`,
        });
      }
      queries.push({panelId, query: target.query, target: target as Readonly<Record<string, JsonValue>>, targetIndex});
    }
  }
  if (queries.length === 0) throw ScriptError.make({message: 'Dashboard artifact has no Tempo queries.'});
  return queries;
}

function unexpectedFullBuildExpressionTarget(resource: DashboardArtifact): Readonly<Record<string, JsonValue>> {
  const panels = resource.spec.panels;
  if (!Array.isArray(panels)) throw ScriptError.make({message: 'Dashboard artifact has no panels.'});
  const matches = panels.filter(panelValue => isObject(panelValue) && panelValue.id === 13);
  if (matches.length !== 1)
    throw ScriptError.make({message: 'Dashboard must contain exactly one unexpected-full percentage panel.'});
  const panel = record(matches[0], 'dashboard panel 13');
  if (!Array.isArray(panel.targets) || panel.targets.length !== 3) {
    throw ScriptError.make({message: 'Dashboard panel 13 must contain numerator, denominator, and math targets.'});
  }
  const [numeratorValue, denominatorValue, expressionValue] = panel.targets;
  const numerator = record(numeratorValue, 'dashboard panel 13 numerator');
  const denominator = record(denominatorValue, 'dashboard panel 13 denominator');
  const expression = record(expressionValue, 'dashboard panel 13 expression');
  if (
    numerator.refId !== 'A' ||
    numerator.metricsQueryType !== 'range' ||
    numerator.hide !== true ||
    denominator.refId !== 'B' ||
    denominator.metricsQueryType !== 'range' ||
    denominator.hide !== true ||
    expression.refId !== 'C' ||
    expression.type !== 'math' ||
    expression.expression !== telemetryDashboardUnexpectedFullBuildExpression ||
    !isDatasource(expression.datasource, '__expr__', '__expr__')
  ) {
    throw ScriptError.make({message: 'Dashboard panel 13 must use the guarded executable A/B percentage expression.'});
  }
  return expression as Readonly<Record<string, JsonValue>>;
}

function validateGraphQueryStageTargets(resource: DashboardArtifact): void {
  const panels = resource.spec.panels;
  if (!Array.isArray(panels)) throw ScriptError.make({message: 'Dashboard artifact has no panels.'});
  const matches = panels.filter(panelValue => isObject(panelValue) && panelValue.id === 23);
  if (matches.length !== 1)
    throw ScriptError.make({message: 'Dashboard must contain exactly one graph-query stage panel.'});
  const panel = record(matches[0], 'dashboard panel 23');
  if (!Array.isArray(panel.targets) || panel.targets.length !== 2) {
    throw ScriptError.make({message: 'Dashboard panel 23 must contain separate outer-phase and fine-stage targets.'});
  }
  const [phaseValue, stageValue] = panel.targets;
  const phase = record(phaseValue, 'dashboard panel 23 phase target');
  const stage = record(stageValue, 'dashboard panel 23 stage target');
  if (
    phase.refId !== 'A' ||
    phase.metricsQueryType !== 'instant' ||
    typeof phase.query !== 'string' ||
    !phase.query.includes('span.threadnote.phase =~ "graph.query.*"') ||
    !phase.query.includes('span.threadnote.stage = nil') ||
    !phase.query.includes('by (span.threadnote.graph.request_kind, span.threadnote.phase)') ||
    stage.refId !== 'B' ||
    stage.metricsQueryType !== 'instant' ||
    typeof stage.query !== 'string' ||
    !stage.query.includes('span.threadnote.phase =~ "graph.query.*"') ||
    !stage.query.includes('span.threadnote.stage =~ "query-.*"') ||
    !stage.query.includes('by (span.threadnote.graph.request_kind, span.threadnote.stage, span.threadnote.subphase)')
  ) {
    throw ScriptError.make({
      message: 'Dashboard panel 23 must keep outer phases separate and group fine stages by closed labels.',
    });
  }
}

export function validateDashboardArtifact(value: unknown): DashboardArtifact {
  const artifact = validateHistoricalDashboardArtifact(value);
  const artifactRecord = artifact as Readonly<Record<string, JsonValue>>;
  const spec = artifact.spec;
  const rendered = canonicalJson(cloneJson(artifactRecord, 'dashboard artifact'));
  if (rendered.includes(datasourcePlaceholder)) {
    throw ScriptError.make({message: 'Dashboard artifact still contains an unresolved Tempo data-source placeholder.'});
  }
  for (const key of ['__inputs', '__requires', ...serverOwnedDashboardKeys]) {
    if (Object.hasOwn(spec, key))
      throw ScriptError.make({message: `Dashboard artifact retains server-owned field ${key}.`});
  }
  collectTempoQueries(artifact);
  unexpectedFullBuildExpressionTarget(artifact);
  validateGraphQueryStageTargets(artifact);
  return artifact;
}

export function validateHistoricalDashboardArtifact(value: unknown): DashboardArtifact {
  const artifactRecord = record(value, 'dashboard artifact');
  record(artifactRecord.spec, 'dashboard artifact.spec');
  if (
    artifactRecord.dashboardUid !== telemetryDashboardUid ||
    artifactRecord.folderUid !== telemetryDashboardFolderUid ||
    Object.keys(artifactRecord).length !== 3 ||
    Object.keys(artifactRecord).some(key => !['dashboardUid', 'folderUid', 'spec'].includes(key))
  ) {
    throw ScriptError.make({message: 'Dashboard artifact must retain its exact dashboard and folder identity.'});
  }
  cloneJson(artifactRecord, 'dashboard artifact');
  return value as DashboardArtifact;
}

function isMigrationEmptyFieldConfig(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const fieldConfig = value as Record<string, unknown>;
  const defaults = fieldConfig.defaults;
  return (
    Object.keys(fieldConfig).length === 2 &&
    defaults !== null &&
    typeof defaults === 'object' &&
    !Array.isArray(defaults) &&
    Object.keys(defaults).length === 0 &&
    Array.isArray(fieldConfig.overrides) &&
    fieldConfig.overrides.length === 0
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isExactStringArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index])
  );
}

function isDatasource(value: unknown, type: string, uid: string): boolean {
  return isObject(value) && Object.keys(value).length === 2 && value.type === type && value.uid === uid;
}

function exactTempoDatasourceUid(value: unknown): string | undefined {
  if (
    !isObject(value) ||
    Object.keys(value).length !== 2 ||
    value.type !== 'tempo' ||
    typeof value.uid !== 'string' ||
    value.uid.length === 0
  ) {
    return undefined;
  }
  return value.uid;
}

function mixedTempoExpressionTargetDatasourceUid(panel: Record<string, unknown>): string | undefined {
  if (panel.id !== 13 || !Array.isArray(panel.targets) || panel.targets.length !== 3) return undefined;
  const [left, right, expression] = panel.targets;
  if (!isObject(left) || !isObject(right) || !isObject(expression)) return undefined;
  const leftDatasourceUid = exactTempoDatasourceUid(left.datasource);
  const rightDatasourceUid = exactTempoDatasourceUid(right.datasource);
  if (
    left.refId !== 'A' ||
    right.refId !== 'B' ||
    expression.refId !== 'C' ||
    leftDatasourceUid === undefined ||
    leftDatasourceUid !== rightDatasourceUid ||
    !isDatasource(expression.datasource, '__expr__', '__expr__')
  ) {
    return undefined;
  }
  return leftDatasourceUid;
}

function normalizePanelMigrationNoise(panel: Record<string, unknown>): void {
  if (panel.pluginVersion === '') delete panel.pluginVersion;
  if (typeof panel.id !== 'number') return;
  const targetDatasourceUid = mixedTempoExpressionTargetDatasourceUid(panel);
  if (
    targetDatasourceUid !== undefined &&
    (isDatasource(panel.datasource, 'tempo', targetDatasourceUid) ||
      isDatasource(panel.datasource, 'mixed', '-- Mixed --'))
  ) {
    delete panel.datasource;
  }
  if (migrationEmptyFieldConfigPanelIds.has(panel.id) && isMigrationEmptyFieldConfig(panel.fieldConfig)) {
    delete panel.fieldConfig;
    return;
  }
  if (!isObject(panel.fieldConfig)) return;
  const fieldConfig = panel.fieldConfig;
  if (isObject(fieldConfig.defaults)) {
    if (
      migrationEmptyMappingsPanelIds.has(panel.id) &&
      Array.isArray(fieldConfig.defaults.mappings) &&
      fieldConfig.defaults.mappings.length === 0
    ) {
      delete fieldConfig.defaults.mappings;
    }
    if (panel.id === 20 && Object.keys(fieldConfig.defaults).length === 0) delete fieldConfig.defaults;
  }
  if (
    migrationEmptyOverridesPanelIds.has(panel.id) &&
    Array.isArray(fieldConfig.overrides) &&
    fieldConfig.overrides.length === 0
  ) {
    delete fieldConfig.overrides;
  }
}

export function canonicalDashboardSemantics(value: unknown): string {
  const dashboard = record(cloneJson(value, 'dashboard spec'), 'dashboard spec');
  for (const key of serverOwnedDashboardKeys) delete dashboard[key];
  if (dashboard.preload === false) delete dashboard.preload;
  if (dashboard.weekStart === '') delete dashboard.weekStart;
  if (
    isObject(dashboard.templating) &&
    Object.keys(dashboard.templating).length === 1 &&
    Array.isArray(dashboard.templating.list) &&
    dashboard.templating.list.length === 0
  ) {
    delete dashboard.templating;
  }
  if (
    isObject(dashboard.timepicker) &&
    isExactStringArray(dashboard.timepicker.refresh_intervals, grafanaDefaultRefreshIntervals)
  ) {
    delete dashboard.timepicker.refresh_intervals;
  }
  if (Array.isArray(dashboard.panels)) {
    dashboard.panels = dashboard.panels.map((panelValue, index) => {
      const panel = record(panelValue, `dashboard spec.panels[${index}]`);
      normalizePanelMigrationNoise(panel);
      return panel;
    });
  }
  return canonicalJson(dashboard as JsonObject);
}

export function assessDashboardThreeWay(
  options: Readonly<{
    current: string;
    historical: readonly string[];
    live: string;
  }>,
): DashboardDeploymentDecision {
  if (options.live === options.current) return 'noop';
  if (options.historical.includes(options.live)) return 'update';
  throw ScriptError.make({
    message: 'Live Grafana dashboard drifted from the current and trusted historical canonical artifacts.',
  });
}

export function buildTempoQueryRequests(resource: DashboardArtifact, now = Date.now()): readonly JsonValue[] {
  const tempoQueries: JsonObject[] = [];
  const expressionQueries: JsonObject[] = [];
  for (const {panelId, target, targetIndex} of collectTempoQueries(resource)) {
    const query: JsonObject = {
      ...target,
      datasource: {type: 'tempo', uid: telemetryDashboardDatasourceUid},
      ...(panelId === 13 ? {hide: false} : {}),
      intervalMs: 300_000,
      limit: 1,
      maxDataPoints: 1,
      refId: `P${panelId}T${targetIndex}`,
      spanLimit: 1,
    };
    (panelId === 13 ? expressionQueries : tempoQueries).push(query);
  }
  const expression = unexpectedFullBuildExpressionTarget(resource);
  // Grafana routes every query sharing a request with __expr__ through expression evaluation. Keep that request to
  // panel 13's time-series operands so spans-table targets in the pure Tempo request retain their native response path.
  expressionQueries.push({
    ...expression,
    datasource: {type: '__expr__', uid: '__expr__'},
    expression: telemetryDashboardUnexpectedFullBuildExpression.replaceAll('$A', '$P13T0').replaceAll('$B', '$P13T1'),
    refId: 'P13T2',
  });
  const from = String(now - 5 * 60_000);
  const to = String(now);
  return [
    {from, queries: tempoQueries, to},
    {from, queries: expressionQueries, to},
  ];
}

function grafanaUrl(baseUrl: string, path: string): URL {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw ScriptError.make({message: 'THREADNOTE_TELEMETRY_GRAFANA_URL must be an absolute HTTPS URL.'});
  }
  const labels = base.hostname.split('.');
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.port ||
    base.pathname !== '/' ||
    base.search ||
    base.hash ||
    base.hostname === 'grafana.net' ||
    !base.hostname.endsWith('.grafana.net') ||
    labels.some(label => label.length === 0)
  ) {
    throw ScriptError.make({
      message: 'THREADNOTE_TELEMETRY_GRAFANA_URL must be an uncredentialed Grafana Cloud HTTPS origin.',
    });
  }
  return new URL(path, `${base.origin}/`);
}

async function fetchResponse(
  fetcher: FetchLike,
  url: URL,
  token: string,
  init?: RequestInit,
  expectedStatus?: number,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init?.body === undefined ? {} : {'Content-Type': 'application/json'}),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw GrafanaTransportError.of();
  }
  if (expectedStatus === undefined ? !response.ok : response.status !== expectedStatus) {
    throw GrafanaHttpError.of(response.status);
  }
  return response;
}

async function fetchJson(
  fetcher: FetchLike,
  url: URL,
  token: string,
  init?: RequestInit,
  expectedStatus?: number,
): Promise<unknown> {
  const response = await fetchResponse(fetcher, url, token, init, expectedStatus);
  try {
    return await response.json();
  } catch {
    throw ScriptError.make({message: 'Grafana API returned malformed JSON.'});
  }
}

type LiveDashboard = Readonly<{
  annotations: JsonObject;
  internalUid: string;
  labels: JsonObject;
  namespace: string;
  resourceVersion: string;
  schemaVersion: number;
  spec: Record<string, unknown>;
}>;

function annotationsFromMetadata(metadata: Record<string, unknown>, path: string): Record<string, unknown> {
  return optionalRecord(metadata.annotations, `${path}.annotations`);
}

function rejectManagedResource(metadata: Record<string, unknown>): void {
  const annotations = annotationsFromMetadata(metadata, 'Grafana resource metadata');
  const labels = optionalRecord(metadata.labels, 'Grafana resource metadata.labels');
  const isReservedProvenanceKey = (key: string): boolean =>
    key.startsWith('grafana.app/managed') ||
    key.startsWith('grafana.app/manager') ||
    key.startsWith('grafana.app/repo') ||
    key.startsWith('grafana.app/source') ||
    key.startsWith('provisioning.grafana.app/');
  if ([...Object.keys(annotations), ...Object.keys(labels)].some(isReservedProvenanceKey)) {
    throw ScriptError.make({
      message: 'Direct dashboard provisioning refuses a managed or provisioned Grafana resource.',
    });
  }
}

function parseLiveDashboard(value: unknown, namespace: string): LiveDashboard {
  const resource = record(value, 'Grafana dashboard response');
  const metadata = record(resource.metadata, 'Grafana dashboard response.metadata');
  const annotations = annotationsFromMetadata(metadata, 'Grafana dashboard response.metadata');
  const spec = record(resource.spec, 'Grafana dashboard response.spec');
  rejectManagedResource(metadata);
  if (
    resource.apiVersion !== dashboardApiVersion ||
    resource.kind !== 'Dashboard' ||
    metadata.name !== telemetryDashboardUid ||
    metadata.namespace !== namespace ||
    annotations['grafana.app/folder'] !== telemetryDashboardFolderUid
  ) {
    throw ScriptError.make({
      message: 'Grafana dashboard identity or folder does not match the fixed deployment target.',
    });
  }
  if (typeof metadata.resourceVersion !== 'string' || metadata.resourceVersion.length === 0) {
    throw ScriptError.make({message: 'Grafana dashboard response is missing metadata.resourceVersion.'});
  }
  if (typeof metadata.uid !== 'string' || metadata.uid.length === 0) {
    throw ScriptError.make({message: 'Grafana dashboard response is missing its immutable metadata.uid.'});
  }
  if (!Number.isInteger(spec.schemaVersion) || (spec.schemaVersion as number) < 1) {
    throw ScriptError.make({message: 'Grafana dashboard response is missing a valid server schemaVersion.'});
  }
  return {
    annotations: cloneJson(annotations, 'Grafana dashboard response.metadata.annotations') as JsonObject,
    internalUid: metadata.uid,
    labels: cloneJson(
      optionalRecord(metadata.labels, 'Grafana dashboard response.metadata.labels'),
      'Grafana dashboard response.metadata.labels',
    ) as JsonObject,
    namespace,
    resourceVersion: metadata.resourceVersion,
    schemaVersion: spec.schemaVersion as number,
    spec,
  };
}

function validateLiveFolder(value: unknown, namespace: string): void {
  const resource = record(value, 'Grafana folder response');
  const metadata = record(resource.metadata, 'Grafana folder response.metadata');
  const annotations = annotationsFromMetadata(metadata, 'Grafana folder response.metadata');
  const spec = record(resource.spec, 'Grafana folder response.spec');
  rejectManagedResource(metadata);
  if (
    resource.apiVersion !== folderApiVersion ||
    resource.kind !== 'Folder' ||
    metadata.name !== telemetryDashboardFolderUid ||
    metadata.namespace !== namespace ||
    spec.title !== telemetryDashboardFolderTitle ||
    Object.hasOwn(annotations, 'grafana.app/folder')
  ) {
    throw ScriptError.make({
      message: 'Grafana private folder identity or title does not match the fixed deployment target.',
    });
  }
}

function validatePrivateFolderPermissions(value: unknown): void {
  if (!Array.isArray(value)) throw ScriptError.make({message: 'Grafana folder permissions response must be an array.'});
  for (const [index, item] of value.entries()) {
    const permission = record(item, `Grafana folder permissions response[${index}]`);
    const role = typeof permission.role === 'string' ? permission.role.toLowerCase() : '';
    if (role === 'viewer' || role === 'editor' || permission.folderId === -1 || permission.dashboardId === -1) {
      throw ScriptError.make({message: 'Grafana private folder still grants broad default Viewer or Editor access.'});
    }
  }
}

function validateExactPermissions(
  value: unknown,
  actor: 'reader' | 'writer',
  exactScopes: Readonly<Record<string, readonly string[]>>,
): void {
  const permissions = record(value, 'Grafana effective permissions response');
  for (const [action, scopesValue] of Object.entries(permissions)) {
    if (!Array.isArray(scopesValue) || scopesValue.some(scope => typeof scope !== 'string')) {
      throw ScriptError.make({message: 'Grafana effective permissions response has an invalid scope list.'});
    }
    const scopes = scopesValue as string[];
    if (!Object.hasOwn(exactScopes, action) || scopes.some(scope => scope === '*' || scope.endsWith(':*'))) {
      throw ScriptError.make({message: `Grafana dashboard ${actor} has a forbidden permission action or scope.`});
    }
    const expectedScopes = exactScopes[action];
    if (
      expectedScopes === undefined ||
      scopes.length !== expectedScopes.length ||
      new Set(scopes).size !== scopes.length ||
      expectedScopes.some(scope => !scopes.includes(scope))
    ) {
      throw ScriptError.make({message: `Grafana dashboard ${actor} is not restricted to the exact allowed targets.`});
    }
  }
  for (const [action, expectedScopes] of Object.entries(exactScopes)) {
    const scopes = permissions[action];
    if (
      !Array.isArray(scopes) ||
      scopes.some(scope => typeof scope !== 'string') ||
      scopes.length !== expectedScopes.length ||
      new Set(scopes).size !== scopes.length ||
      expectedScopes.some(scope => !scopes.includes(scope))
    ) {
      throw ScriptError.make({message: `Grafana dashboard ${actor} is missing a required exact-target permission.`});
    }
  }
}

export function validateWriterPermissions(value: unknown): void {
  validateExactPermissions(value, 'writer', {
    'dashboards:read': [`dashboards:uid:${telemetryDashboardUid}`],
    'dashboards:write': [`dashboards:uid:${telemetryDashboardUid}`],
    'folders.permissions:read': [`folders:uid:${telemetryDashboardFolderUid}`],
    'folders:read': [`folders:uid:${telemetryDashboardFolderUid}`, grafanaSharedWithMeFolderScope],
  });
}

export function validateReaderPermissions(value: unknown): void {
  validateExactPermissions(value, 'reader', {
    'dashboards:read': [`dashboards:uid:${telemetryDashboardUid}`],
    'datasources:query': [`datasources:uid:${telemetryDashboardDatasourceUid}`],
    'datasources:read': [`datasources:uid:${telemetryDashboardDatasourceUid}`],
    'folders.permissions:read': [`folders:uid:${telemetryDashboardFolderUid}`],
    'folders:read': [`folders:uid:${telemetryDashboardFolderUid}`, grafanaSharedWithMeFolderScope],
  });
}

function queryErrors(value: unknown, expectedReferenceIds: readonly string[]): readonly string[] {
  const response = record(value, 'Grafana query response');
  const results = record(response.results, 'Grafana query response.results');
  const errors: string[] = [];
  for (const referenceId of expectedReferenceIds) {
    if (!Object.hasOwn(results, referenceId)) {
      errors.push(`${referenceId}:missing`);
      continue;
    }
    const result = record(results[referenceId], `Grafana query response.results.${referenceId}`);
    if (typeof result.error === 'string' && result.error.length > 0) errors.push(`${referenceId}:error`);
    const status = typeof result.status === 'string' || typeof result.status === 'number' ? Number(result.status) : 200;
    if (!Number.isFinite(status) || status >= 400) errors.push(`${referenceId}:status`);
    if (!Array.isArray(result.frames)) errors.push(`${referenceId}:frames`);
  }
  return errors;
}

function dashboardUrl(baseUrl: string, namespace: string): URL {
  return grafanaUrl(
    baseUrl,
    `/apis/dashboard.grafana.app/v1/namespaces/${namespace}/dashboards/${telemetryDashboardUid}`,
  );
}

function folderUrl(baseUrl: string, namespace: string): URL {
  return grafanaUrl(
    baseUrl,
    `/apis/folder.grafana.app/v1/namespaces/${namespace}/folders/${telemetryDashboardFolderUid}`,
  );
}

async function readAndValidateFolder(
  fetcher: FetchLike,
  baseUrl: string,
  namespace: string,
  token: string,
): Promise<void> {
  validateLiveFolder(await fetchJson(fetcher, folderUrl(baseUrl, namespace), token, undefined, 200), namespace);
  validatePrivateFolderPermissions(
    await fetchJson(
      fetcher,
      grafanaUrl(baseUrl, `/api/folders/${telemetryDashboardFolderUid}/permissions`),
      token,
      undefined,
      200,
    ),
  );
}

async function verifyTempoQueries(
  fetcher: FetchLike,
  baseUrl: string,
  token: string,
  resource: DashboardArtifact,
): Promise<void> {
  for (const request of buildTempoQueryRequests(resource)) {
    const response = await fetchJson(
      fetcher,
      grafanaUrl(baseUrl, '/api/ds/query'),
      token,
      {body: JSON.stringify(request), method: 'POST'},
      200,
    );
    const requestRecord = record(request, 'Grafana query request');
    const queries = requestRecord.queries as readonly Readonly<Record<string, JsonValue>>[];
    const errors = queryErrors(
      response,
      queries.map(query => query.refId as string),
    );
    if (errors.length > 0) {
      throw ScriptError.make({
        message: `Grafana rejected ${errors.length} bounded dashboard query checks (${errors.join(', ')}).`,
      });
    }
  }
}

export async function verifyLiveDashboard(
  options: Readonly<{
    baseUrl: string;
    fetcher?: FetchLike;
    namespace: string;
    resource: DashboardArtifact;
    token: string;
  }>,
): Promise<void> {
  if (options.token.trim().length === 0) {
    throw ScriptError.make({
      message: 'THREADNOTE_TELEMETRY_GRAFANA_READ_TOKEN is required when live verification is enabled.',
    });
  }
  const namespace = validateGrafanaCloudNamespace(options.namespace);
  const fetcher = options.fetcher ?? fetch;
  validateReaderPermissions(
    await fetchJson(
      fetcher,
      grafanaUrl(options.baseUrl, '/api/access-control/user/permissions'),
      options.token,
      undefined,
      200,
    ),
  );
  const live = parseLiveDashboard(
    await fetchJson(fetcher, dashboardUrl(options.baseUrl, namespace), options.token, undefined, 200),
    namespace,
  );
  if (canonicalDashboardSemantics(live.spec) !== canonicalDashboardSemantics(options.resource.spec)) {
    throw ScriptError.make({message: 'Live Grafana dashboard does not match the canonical dashboard artifact.'});
  }
  await readAndValidateFolder(fetcher, options.baseUrl, namespace, options.token);
  await verifyTempoQueries(fetcher, options.baseUrl, options.token, options.resource);
}

function buildDashboardUpdate(live: LiveDashboard, resource: DashboardArtifact, currentSha: string): JsonObject {
  return {
    apiVersion: dashboardApiVersion,
    kind: 'Dashboard',
    metadata: {
      annotations: {
        ...live.annotations,
        'grafana.app/folder': telemetryDashboardFolderUid,
        'grafana.app/message': `Threadnote telemetry dashboard ${currentSha}`,
      },
      labels: live.labels,
      name: telemetryDashboardUid,
      namespace: live.namespace,
      resourceVersion: live.resourceVersion,
      uid: live.internalUid,
    },
    spec: {...resource.spec, schemaVersion: live.schemaVersion},
  };
}

function validatePostUpdate(previous: LiveDashboard, updated: LiveDashboard, expected: DashboardArtifact): void {
  if (
    updated.internalUid !== previous.internalUid ||
    updated.resourceVersion === previous.resourceVersion ||
    updated.schemaVersion !== previous.schemaVersion ||
    canonicalDashboardSemantics(updated.spec) !== canonicalDashboardSemantics(expected.spec)
  ) {
    throw ScriptError.make({
      message: 'Grafana dashboard post-update state failed its identity, CAS, schema, or semantic check.',
    });
  }
}

export async function deployDashboard(
  options: Readonly<{
    baseUrl: string;
    current: DashboardArtifact;
    currentSha: string;
    fetcher?: FetchLike;
    historical: readonly DashboardArtifact[];
    namespace: string;
    token: string;
  }>,
): Promise<DashboardDeploymentDecision> {
  if (options.token.trim().length === 0) {
    throw ScriptError.make({
      message: 'THREADNOTE_TELEMETRY_GRAFANA_WRITE_TOKEN is required when direct deployment is enabled.',
    });
  }
  const namespace = validateGrafanaCloudNamespace(options.namespace);
  const currentSha = validateGitCommit(options.currentSha, 'THREADNOTE_TELEMETRY_DASHBOARD_CURRENT_SHA');
  const fetcher = options.fetcher ?? fetch;
  validateDashboardArtifact(options.current);
  for (const artifact of options.historical) validateHistoricalDashboardArtifact(artifact);
  validateWriterPermissions(
    await fetchJson(
      fetcher,
      grafanaUrl(options.baseUrl, '/api/access-control/user/permissions'),
      options.token,
      undefined,
      200,
    ),
  );
  await readAndValidateFolder(fetcher, options.baseUrl, namespace, options.token);
  const url = dashboardUrl(options.baseUrl, namespace);
  const live = parseLiveDashboard(await fetchJson(fetcher, url, options.token, undefined, 200), namespace);
  const decision = assessDashboardThreeWay({
    current: canonicalDashboardSemantics(options.current.spec),
    historical: options.historical.map(artifact => canonicalDashboardSemantics(artifact.spec)),
    live: canonicalDashboardSemantics(live.spec),
  });
  if (decision === 'noop') return decision;

  const body = buildDashboardUpdate(live, options.current, currentSha);
  try {
    await fetchResponse(fetcher, url, options.token, {body: JSON.stringify(body), method: 'PUT'}, 200);
  } catch (error) {
    if (!Schema.is(GrafanaTransportError)(error)) throw error;
    const observed = parseLiveDashboard(await fetchJson(fetcher, url, options.token, undefined, 200), namespace);
    try {
      validatePostUpdate(live, observed, options.current);
      return decision;
    } catch {
      throw ScriptError.make({message: 'Grafana dashboard update outcome is indeterminate after a transport failure.'});
    }
  }
  const updated = parseLiveDashboard(await fetchJson(fetcher, url, options.token, undefined, 200), namespace);
  validatePostUpdate(live, updated, options.current);
  return decision;
}

async function loadSource(repositoryRoot: string): Promise<unknown> {
  const source = Bun.file(`${repositoryRoot}/${telemetryDashboardSourcePath}`);
  if (!(await source.exists()))
    throw ScriptError.make({message: `Dashboard source is missing at ${telemetryDashboardSourcePath}.`});
  try {
    return await source.json();
  } catch {
    throw ScriptError.make({message: `Dashboard source at ${telemetryDashboardSourcePath} is not valid JSON.`});
  }
}

async function loadArtifact(repositoryRoot: string): Promise<DashboardArtifact> {
  const artifact = Bun.file(`${repositoryRoot}/${telemetryDashboardArtifactPath}`);
  if (!(await artifact.exists()))
    throw ScriptError.make({message: `Dashboard artifact is missing at ${telemetryDashboardArtifactPath}.`});
  try {
    return validateDashboardArtifact(await artifact.json());
  } catch (error) {
    if (Schema.is(ScriptError)(error)) throw error;
    throw ScriptError.make({message: `Dashboard artifact at ${telemetryDashboardArtifactPath} is not valid JSON.`});
  }
}

type GitReader = (args: readonly string[]) => Promise<string | undefined>;

async function tryRunGit(repositoryRoot: string, args: readonly string[]): Promise<string | undefined> {
  const child = Bun.spawn(['git', ...args], {cwd: repositoryRoot, stderr: 'ignore', stdout: 'pipe'});
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) return undefined;
  return output.trim();
}

async function runGit(repositoryRoot: string, args: readonly string[]): Promise<string> {
  const output = await tryRunGit(repositoryRoot, args);
  if (output === undefined)
    throw ScriptError.make({message: 'Git history does not contain the required deployment baseline.'});
  return output;
}

export async function loadHistoricalArtifacts(
  repositoryRoot: string,
  currentSha: string,
  readGit: GitReader = args => tryRunGit(repositoryRoot, args),
): Promise<readonly DashboardArtifact[]> {
  validateGitCommit(currentSha, 'THREADNOTE_TELEMETRY_DASHBOARD_CURRENT_SHA');
  const history = await readGit([
    'log',
    '--first-parent',
    '--format=%H',
    '--max-count=65',
    currentSha,
    '--',
    telemetryDashboardArtifactPath,
  ]);
  if (history === undefined)
    throw ScriptError.make({message: 'Git history does not contain the required deployment baseline.'});
  const revisions = history
    .split('\n')
    .filter(revision => revision.length > 0 && revision !== currentSha)
    .slice(0, 64);
  const artifacts: DashboardArtifact[] = [];
  for (const revision of revisions) {
    const json = await readGit(['show', `${revision}:${telemetryDashboardArtifactPath}`]);
    if (json === undefined) continue;
    try {
      artifacts.push(validateHistoricalDashboardArtifact(JSON.parse(json)));
    } catch (error) {
      if (Schema.is(ScriptError)(error)) throw error;
      throw ScriptError.make({message: 'A trusted historical dashboard artifact is not valid JSON.'});
    }
  }
  return artifacts;
}

export async function renderTelemetryDashboard(repositoryRoot = process.cwd()): Promise<string> {
  return canonicalJson(renderDashboardArtifact(await loadSource(repositoryRoot)));
}

export async function formatDashboardArtifact(rendered: string): Promise<string> {
  const child = Bun.spawnSync([process.execPath, 'fmt', '--no-script', '--parser', 'json', '--print-width', '120'], {
    stdin: new TextEncoder().encode(rendered),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (child.exitCode !== 0) throw ScriptError.make({message: 'Bun could not format the dashboard artifact.'});
  return new TextDecoder().decode(child.stdout);
}

export function validateDashboardArtifactBytes(actual: string, expected: string): void {
  if (actual !== expected) {
    throw ScriptError.make({message: `Dashboard artifact is stale; run bun scripts/telemetry-dashboard.ts render.`});
  }
}

async function run(command: string | undefined): Promise<void> {
  const repositoryRoot = process.cwd();
  const rendered = await renderTelemetryDashboard(repositoryRoot);
  if (command === 'render') {
    await Bun.write(telemetryDashboardArtifactPath, await formatDashboardArtifact(rendered));
    process.stdout.write(`Rendered ${telemetryDashboardArtifactPath}\n`);
    return;
  }
  const resource = await loadArtifact(repositoryRoot);
  if (canonicalJson(resource) !== canonicalJson(JSON.parse(rendered) as JsonValue)) {
    throw ScriptError.make({message: `Dashboard artifact is stale; run bun scripts/telemetry-dashboard.ts render.`});
  }
  if (command === 'check') {
    validateDashboardArtifactBytes(
      await Bun.file(`${repositoryRoot}/${telemetryDashboardArtifactPath}`).text(),
      await formatDashboardArtifact(rendered),
    );
    process.stdout.write(`Verified ${telemetryDashboardArtifactPath}\n`);
    return;
  }
  const baseUrl = Bun.env.THREADNOTE_TELEMETRY_GRAFANA_URL?.trim() ?? '';
  const namespace = Bun.env.THREADNOTE_TELEMETRY_GRAFANA_NAMESPACE?.trim() ?? '';
  if (command === 'verify-live') {
    const token = Bun.env.THREADNOTE_TELEMETRY_GRAFANA_READ_TOKEN?.trim() ?? '';
    await verifyLiveDashboard({baseUrl, namespace, resource, token});
    process.stdout.write(`Verified Grafana dashboard ${telemetryDashboardUid} and its bounded Tempo queries.\n`);
    return;
  }
  if (command === 'deploy') {
    const currentSha = Bun.env.THREADNOTE_TELEMETRY_DASHBOARD_CURRENT_SHA?.trim() ?? '';
    const token = Bun.env.THREADNOTE_TELEMETRY_GRAFANA_WRITE_TOKEN?.trim() ?? '';
    validateGitCommit(currentSha, 'THREADNOTE_TELEMETRY_DASHBOARD_CURRENT_SHA');
    if ((await runGit(repositoryRoot, ['rev-parse', 'HEAD'])) !== currentSha) {
      throw ScriptError.make({message: 'Checked-out HEAD does not match the requested dashboard deployment commit.'});
    }
    const historical = await loadHistoricalArtifacts(repositoryRoot, currentSha);
    const decision = await deployDashboard({baseUrl, current: resource, currentSha, historical, namespace, token});
    process.stdout.write(
      decision === 'noop'
        ? `Grafana dashboard ${telemetryDashboardUid} already matches the canonical artifact.\n`
        : `Updated Grafana dashboard ${telemetryDashboardUid} with optimistic concurrency.\n`,
    );
    return;
  }
  throw ScriptError.make({message: 'Usage: bun scripts/telemetry-dashboard.ts <render|check|deploy|verify-live>'});
}

if (import.meta.main) {
  run(Bun.argv[2]).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Telemetry dashboard operation failed.'}\n`);
    process.exitCode = 1;
  });
}
