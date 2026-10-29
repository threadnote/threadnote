import {Schema} from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import {BunFileSystem} from '@effect/platform-bun';
import {describe, expect, it} from '@effect/vitest';
import {Effect, FileSystem} from 'effect';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

type Target = Readonly<{
  datasource: Readonly<{type: string; uid: string}>;
  expression?: string;
  metricsQueryType?: string;
  query?: string;
  queryType?: string;
  tableType?: string;
  type?: string;
}>;

type FieldOverride = Readonly<{
  matcher: Readonly<{id: string; options: string}>;
  properties: ReadonlyArray<Readonly<{id: string; value: unknown}>>;
}>;

type Transformation = Readonly<{
  id: string;
  options: Readonly<{
    regex?: string;
    renamePattern?: string;
    [key: string]: unknown;
  }>;
}>;

type Panel = Readonly<{
  datasource: Readonly<{type: string; uid: string}>;
  description?: string;
  fieldConfig: Readonly<{
    overrides: ReadonlyArray<FieldOverride>;
  }>;
  id: number;
  targets: ReadonlyArray<Target>;
  title: string;
  transformations?: ReadonlyArray<Transformation>;
  type: string;
}>;

type Dashboard = Readonly<{
  __inputs: ReadonlyArray<Readonly<{name: string; pluginId: string; type: string}>>;
  panels: ReadonlyArray<Panel>;
  schemaVersion: number;
  uid: string;
}>;
const TargetSchema = Schema.Struct({
  datasource: Schema.Struct({type: Schema.String, uid: Schema.String}),
  expression: Schema.optionalKey(Schema.String),
  metricsQueryType: Schema.optionalKey(Schema.String),
  query: Schema.optionalKey(Schema.String),
  queryType: Schema.optionalKey(Schema.String),
  tableType: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
});
const FieldOverrideSchema = Schema.Struct({
  matcher: Schema.Struct({id: Schema.String, options: Schema.String}),
  properties: Schema.Array(Schema.Struct({id: Schema.String, value: Schema.Unknown})),
});
const TransformationSchema = Schema.Struct({
  id: Schema.String,
  options: Schema.StructWithRest(
    Schema.Struct({regex: Schema.optionalKey(Schema.String), renamePattern: Schema.optionalKey(Schema.String)}),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
});
const PanelSchema = Schema.Struct({
  datasource: Schema.Struct({type: Schema.String, uid: Schema.String}),
  description: Schema.optionalKey(Schema.String),
  fieldConfig: Schema.Struct({overrides: Schema.Array(FieldOverrideSchema)}),
  id: Schema.Finite,
  targets: Schema.Array(TargetSchema),
  title: Schema.String,
  transformations: Schema.optionalKey(Schema.Array(TransformationSchema)),
  type: Schema.String,
});
const DashboardSchema = Schema.Struct({
  __inputs: Schema.Array(Schema.Struct({name: Schema.String, pluginId: Schema.String, type: Schema.String})),
  panels: Schema.Array(PanelSchema),
  schemaVersion: Schema.Finite,
  uid: Schema.String,
});

const basePredicates = ['resource.service.name = "threadnote"', 'span:name = "threadnote.anonymous-diagnostic"'];
const canaryExclusionPredicate = 'resource.service.version != "0.0.0-canary"';
const graphSchemaPredicate =
  '(resource.threadnote.telemetry.schema_version = 2 || resource.threadnote.telemetry.schema_version = 3 || resource.threadnote.telemetry.schema_version = 4 || resource.threadnote.telemetry.schema_version = 5 || resource.threadnote.telemetry.schema_version = 6)';
const boundedGraphSchemaPredicate =
  'resource.threadnote.telemetry.schema_version >= 2 && resource.threadnote.telemetry.schema_version <= 6';

const graphLifecyclePredicates = [
  canaryExclusionPredicate,
  graphSchemaPredicate,
  'span.threadnote.event = "lifecycle"',
  'span.threadnote.operation = "graph-build"',
  'span.threadnote.outcome = "success"',
];

const genericSchemaPredicate =
  '(resource.threadnote.telemetry.schema_version = 1 || resource.threadnote.telemetry.schema_version = 2 || resource.threadnote.telemetry.schema_version = 3 || resource.threadnote.telemetry.schema_version = 4 || resource.threadnote.telemetry.schema_version = 5 || resource.threadnote.telemetry.schema_version = 6)';
const autoUpdateSchemaPredicate =
  '(resource.threadnote.telemetry.schema_version = 3 || resource.threadnote.telemetry.schema_version = 4 || resource.threadnote.telemetry.schema_version = 5 || resource.threadnote.telemetry.schema_version = 6)';
const querySchemaPredicate =
  '(resource.threadnote.telemetry.schema_version = 4 || resource.threadnote.telemetry.schema_version = 5 || resource.threadnote.telemetry.schema_version = 6)';
const contextBriefSchemaPredicate =
  '(resource.threadnote.telemetry.schema_version = 5 || resource.threadnote.telemetry.schema_version = 6)';
const schemaV6Predicate = 'resource.threadnote.telemetry.schema_version = 6';
const contextBriefOperationPredicate =
  '(span.threadnote.operation = "context_brief" || span.threadnote.operation = "context.brief")';
const finalizationPhasePredicate = 'span.threadnote.phase = "memory.code-anchor-finalization"';

const tempoQueryLengthLimit = 1024;
const inefficientGraphBuildPredicate = 'span.threadnote.graph.efficiency_class =~ "(small|high|critical).*full"';

const terminalGraphAttributes = [
  'threadnote.graph.build_kind',
  'threadnote.graph.materialization_mode',
  'threadnote.graph.fallback_reason',
  'threadnote.graph.resolution_closure',
  'threadnote.graph.efficiency_class',
  'threadnote.graph.changed_files_bucket',
  'threadnote.graph.deleted_files_bucket',
  'threadnote.graph.delta_files_bucket',
  'threadnote.graph.extracted_files_bucket',
  'threadnote.graph.reused_files_bucket',
  'threadnote.graph.staged_files_bucket',
  'threadnote.graph.total_files_bucket',
  'threadnote.graph.cached_fact_replay_bytes_bucket',
  'threadnote.graph.changed_fact_bytes_bucket',
  'threadnote.graph.final_fact_bytes_bucket',
  'threadnote.graph.rewrite_amplification_bucket',
  'threadnote.graph.fact_replay_amplification_bucket',
] as const;

const dashboardGraphAttributes = EffectArray.filter(
  terminalGraphAttributes,
  attribute =>
    attribute !== 'threadnote.graph.deleted_files_bucket' &&
    attribute !== 'threadnote.graph.extracted_files_bucket' &&
    attribute !== 'threadnote.graph.reused_files_bucket' &&
    attribute !== 'threadnote.graph.final_fact_bytes_bucket',
);

const metricRenames = new Map<number, Readonly<{raw: string; rendered: string}>>([
  [
    1,
    {
      raw: '{span.threadnote.component="cli", span.threadnote.outcome="failure"}',
      rendered: 'cli: failure',
    },
  ],
  [
    3,
    {
      raw: '{span.threadnote.operation="graph.index", span.threadnote.outcome="success"}',
      rendered: 'graph.index: success',
    },
  ],
  [
    4,
    {
      raw: '{span.threadnote.operation="graph.index", span.threadnote.outcome="failure"}',
      rendered: 'graph.index: failure',
    },
  ],
  [
    5,
    {
      raw: '{p=0.95, span.threadnote.operation="graph.index"}',
      rendered: 'graph.index: p0.95',
    },
  ],
  [
    6,
    {
      raw: '{p=0.95, span.threadnote.phase="graph.resolving"}',
      rendered: 'graph.resolving: p0.95',
    },
  ],
  [
    7,
    {
      raw: '{span.threadnote.phase="recall.shared-sync", span.threadnote.phase.outcome="success"}',
      rendered: 'recall.shared-sync: success',
    },
  ],
  [
    22,
    {
      raw: '{p=0.95, span.threadnote.graph.request_kind="inspect.query"}',
      rendered: 'inspect.query: p0.95',
    },
  ],
  [
    23,
    {
      raw: '{p=0.95, span.threadnote.graph.request_kind="inspect.query", span.threadnote.phase="graph.query.execute"}',
      rendered: 'inspect.query / graph.query.execute: p0.95',
    },
  ],
  [
    24,
    {
      raw: '{p=0.95, span.threadnote.graph.request_kind="inspect.query", span.threadnote.graph.snapshot_files_bucket="2^12"}',
      rendered: 'inspect.query / files 2^12: p0.95',
    },
  ],
  [
    25,
    {
      raw: '{span.threadnote.graph.snapshot_selection="active", span.threadnote.graph.snapshot_freshness="current"}',
      rendered: 'active: current',
    },
  ],
  [
    27,
    {
      raw: '{p=0.95, span.threadnote.context_brief.scope="workset"}',
      rendered: 'workset: p0.95',
    },
  ],
  [
    28,
    {
      raw: '{p=0.95, span.threadnote.context_brief.scope="workset", span.threadnote.context_brief.citations_bucket="2^6"}',
      rendered: 'workset / citations 2^6: p0.95',
    },
  ],
]);

describe('Threadnote Grafana dashboard', () => {
  it.layer(BunFileSystem.layer)(layerIt => {
    layerIt.effect('is reusable, privacy-scoped, and aligned with the gateway allowlist', () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const dashboard: Dashboard = yield* Schema.decodeUnknownEffect(DashboardSchema)(
          JSON.parse(
            yield* fileSystem.readFileString(
              `${process.cwd()}/infra/telemetry-gateway/threadnote-anonymous-telemetry-dashboard.json`,
            ),
          ),
        );
        const collector = yield* fileSystem.readFileString(`${process.cwd()}/infra/telemetry-gateway/collector.yaml`);
        const panels = dashboard.panels;
        const targets = EffectArray.flatMap(panels, panel => panel.targets);
        const traceTargets = EffectArray.filter(targets, target => target.datasource.type === 'tempo');
        const queries = EffectArray.map(traceTargets, target => target.query!);

        expect(dashboard.schemaVersion).toBeGreaterThanOrEqual(39);
        expect(dashboard.uid).toBe('threadnote-telemetry');
        expect(dashboard.__inputs).toEqual([
          expect.objectContaining({name: 'DS_TEMPO', pluginId: 'tempo', type: 'datasource'}),
        ]);
        expect(new Set(EffectArray.map(panels, panel => panel.id)).size).toBe(panels.length);
        expect(panels.length).toBeGreaterThanOrEqual(10);
        for (const panel of panels) {
          expect(panel.datasource).toEqual({type: 'tempo', uid: '${DS_TEMPO}'});
          expect(panel.targets.length).toBeGreaterThan(0);
          for (const target of panel.targets) {
            if (target.datasource.type === '__expr__') {
              expect(panel.id).toBe(13);
              expect(target.datasource.uid).toBe('__expr__');
              expect(target.type).toBe('math');
              continue;
            }
            expect(target.datasource).toEqual({type: 'tempo', uid: '${DS_TEMPO}'});
            expect(target.queryType).toBe('traceql');
          }
        }
        for (const query of queries) {
          const isGraphQueryTelemetry = Effect2.pipe(
            query,
            EffectString.includes('span.threadnote.graph.request_kind'),
          );
          const isContextBriefTelemetry = Effect2.pipe(query, EffectString.includes(contextBriefOperationPredicate));
          const isV6ContextBriefTelemetry =
            isContextBriefTelemetry &&
            EffectArray.some(
              [
                'span.threadnote.context_brief.contract',
                'span.threadnote.context_brief.mode',
                'span.threadnote.context_brief.code_anchor_coverage',
                'span.threadnote.context_brief.returned_lane',
              ],
              attribute => Effect2.pipe(query, EffectString.includes(attribute)),
            );
          const isCodeAnchorFinalizationTelemetry = Effect2.pipe(
            query,
            EffectString.includes(finalizationPhasePredicate),
          );
          expect(query.length).toBeLessThanOrEqual(tempoQueryLengthLimit);
          expect(Effect2.pipe(query, EffectString.split(canaryExclusionPredicate))).toHaveLength(2);
          if (Effect2.pipe(query, EffectString.includes(inefficientGraphBuildPredicate))) {
            expect(query).toContain(basePredicates[0]);
            expect(query).toContain(boundedGraphSchemaPredicate);
            expect(query).toContain(canaryExclusionPredicate);
            expect(query).not.toContain('resource.threadnote.telemetry.schema_version = 1');
          } else {
            for (const predicate of basePredicates) expect(query).toContain(predicate);
          }
          if (Effect2.pipe(query, EffectString.includes('span.threadnote.operation = "graph-build"'))) {
            for (const predicate of graphLifecyclePredicates) expect(query).toContain(predicate);
            expect(query).not.toContain('resource.threadnote.telemetry.schema_version = 1');
          } else if (isGraphQueryTelemetry) {
            expect(query).toContain(querySchemaPredicate);
            expect(query).not.toContain('resource.threadnote.telemetry.schema_version = 1');
            expect(query).not.toContain('resource.threadnote.telemetry.schema_version = 2');
          } else if (Effect2.pipe(query, EffectString.includes('span.threadnote.operation = "auto-update-worker"'))) {
            expect(query).toContain(autoUpdateSchemaPredicate);
            expect(query).toContain(canaryExclusionPredicate);
          } else if (isContextBriefTelemetry) {
            expect(query).toContain(isV6ContextBriefTelemetry ? schemaV6Predicate : contextBriefSchemaPredicate);
            expect(query).not.toContain('resource.threadnote.telemetry.schema_version = 4');
          } else if (isCodeAnchorFinalizationTelemetry) {
            expect(query).toContain(schemaV6Predicate);
          } else if (!Effect2.pipe(query, EffectString.includes(inefficientGraphBuildPredicate))) {
            expect(query).toContain(genericSchemaPredicate);
          }
          expect(query).not.toContain('span:status');
          expect(query).not.toContain('span:duration');
          expect(query).not.toContain('trace:duration');
        }
        const combined = EffectArray.join(queries, '\n');
        for (const attribute of [
          'resource.service.version',
          'span.threadnote.component',
          'span.threadnote.operation',
          'span.threadnote.outcome',
          'span.threadnote.duration_ms',
          'span.threadnote.phase',
          'span.threadnote.phase.outcome',
          'span.error.type',
          'span.threadnote.memory.rss.end_bucket',
          'span.threadnote.memory.heap.end_bucket',
          'span.threadnote.memory.peak_rss.end_bucket',
        ]) {
          expect(combined).toContain(attribute);
        }
        expect(combined).toContain('quantile_over_time(span.threadnote.duration_ms, .5, .95, .99)');
        expect(combined).toContain('span.threadnote.event = "checkpoint"');

        const operationDuration = EffectOption.getOrUndefined(EffectArray.findFirst(panels, panel => panel.id === 5));
        expect(operationDuration?.type).toBe('bargauge');
        expect(operationDuration?.targets[0]?.metricsQueryType).toBe('instant');
        expect(operationDuration?.targets[0]?.query).toContain('by (span.threadnote.operation)');
        expect(operationDuration?.targets[0]?.query).not.toContain('by (span.threadnote.component)');
        expect(operationDuration?.targets[0]?.query).toContain('span.threadnote.operation != "mcp-server"');
        expect(operationDuration?.targets[0]?.query).toContain('span.threadnote.operation != "mcp-broker"');
        expect(operationDuration?.targets[0]?.query).toContain('span.threadnote.operation != "manage"');

        const phaseElapsed = EffectOption.getOrUndefined(EffectArray.findFirst(panels, panel => panel.id === 6));
        expect(phaseElapsed?.type).toBe('bargauge');
        expect(phaseElapsed?.targets[0]?.metricsQueryType).toBe('instant');
        expect(phaseElapsed?.targets[0]?.query).toContain('by (span.threadnote.phase)');

        const queryPanels = EffectArray.filter(panels, panel => panel.id >= 22 && panel.id <= 25);
        expect(EffectArray.map(queryPanels, panel => panel.title)).toEqual([
          'Graph request duration quantiles',
          'Graph query stage quantiles',
          'Graph request latency by snapshot size',
          'Graph snapshot selection and freshness',
        ]);
        for (const panel of queryPanels) {
          expect(
            Effect2.pipe(panel.description, effectOptionalString =>
              effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.toLowerCase),
            ),
          ).toContain('schemas v4, v5, and v6 only');
          expect(
            Effect2.pipe(panel.description, effectOptionalString =>
              effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.toLowerCase),
            ),
          ).not.toContain('schema v3 only');
        }
        const graphRequestDuration = EffectOption.getOrUndefined(
          EffectArray.findFirst(panels, panel => panel.id === 22),
        );
        expect(graphRequestDuration?.type).toBe('bargauge');
        expect(graphRequestDuration?.targets[0]?.metricsQueryType).toBe('instant');
        expect(graphRequestDuration?.targets[0]?.query).toContain(
          'quantile_over_time(span.threadnote.duration_ms, .5, .95, .99)',
        );
        expect(graphRequestDuration?.targets[0]?.query).toContain('by (span.threadnote.graph.request_kind)');

        const graphQueryStages = EffectOption.getOrUndefined(EffectArray.findFirst(panels, panel => panel.id === 23));
        expect(graphQueryStages?.type).toBe('bargauge');
        expect(graphQueryStages?.targets).toHaveLength(2);
        expect(graphQueryStages?.targets[0]?.metricsQueryType).toBe('instant');
        expect(graphQueryStages?.targets[0]?.query).toContain(
          'quantile_over_time(span.threadnote.phase.elapsed_ms, .5, .95)',
        );
        expect(graphQueryStages?.targets[0]?.query).toContain(
          'by (span.threadnote.graph.request_kind, span.threadnote.phase)',
        );
        expect(graphQueryStages?.targets[0]?.query).toContain('span.threadnote.phase =~ "graph.query.*"');
        expect(graphQueryStages?.targets[0]?.query).toContain('span.threadnote.stage = nil');
        expect(graphQueryStages?.targets[1]?.metricsQueryType).toBe('instant');
        expect(graphQueryStages?.targets[1]?.query).toContain('span.threadnote.stage =~ "query-.*"');
        expect(graphQueryStages?.targets[1]?.query).toContain(
          'by (span.threadnote.graph.request_kind, span.threadnote.stage, span.threadnote.subphase)',
        );

        const graphLatencyBySize = EffectOption.getOrUndefined(EffectArray.findFirst(panels, panel => panel.id === 24));
        expect(graphLatencyBySize?.type).toBe('bargauge');
        expect(graphLatencyBySize?.targets[0]?.query).toContain(
          'by (span.threadnote.graph.request_kind, span.threadnote.graph.snapshot_files_bucket)',
        );

        const graphSnapshotCounts = EffectOption.getOrUndefined(
          EffectArray.findFirst(panels, panel => panel.id === 25),
        );
        expect(graphSnapshotCounts?.type).toBe('timeseries');
        expect(graphSnapshotCounts?.targets[0]?.metricsQueryType).toBe('range');
        expect(graphSnapshotCounts?.targets[0]?.query).toContain(
          'by (span.threadnote.graph.snapshot_selection, span.threadnote.graph.snapshot_freshness)',
        );
        const queryTelemetryText = EffectArray.join(
          EffectArray.map(
            EffectArray.map(
              EffectArray.flatMap(queryPanels, panel => panel.targets),
              target => target.query,
            ),
            item => (item === null || item === undefined ? '' : String(item)),
          ),
          '\n',
        );
        for (const attribute of [
          'span.threadnote.graph.request_kind',
          'span.threadnote.graph.snapshot_files_bucket',
          'span.threadnote.graph.snapshot_selection',
          'span.threadnote.graph.snapshot_freshness',
        ]) {
          expect(queryTelemetryText).toContain(attribute);
        }
        for (const excludedField of [
          'session.id',
          'invocation.id',
          'repository',
          'commit',
          'file_path',
          'symbol_name',
          'query_text',
        ]) {
          expect(queryTelemetryText).not.toContain(excludedField);
        }

        const contextBriefPanels = EffectArray.filter(panels, panel => panel.id >= 26 && panel.id <= 38);
        expect(EffectArray.map(contextBriefPanels, panel => panel.title)).toEqual([
          'Context Brief outcomes',
          'Context Brief duration quantiles',
          'Citation validation duration quantiles',
          'Citation coverage and result',
          'Citation unknown reasons',
          'Citation status and work buckets',
          'Context Brief output truncation',
          'Context Brief version cohorts',
          'Recent Context Brief failures',
          'Context Brief contract and mode',
          'Code-anchor coverage and recovery',
          'Context Brief returned lanes',
          'Code-anchor work buckets',
        ]);
        for (const panel of EffectArray.filter(contextBriefPanels, candidate => candidate.id <= 34))
          expect(
            Effect2.pipe(panel.description, effectOptionalString =>
              effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.toLowerCase),
            ),
          ).toContain('schemas v5 and v6 only');
        for (const panel of EffectArray.filter(contextBriefPanels, candidate => candidate.id >= 35))
          expect(
            Effect2.pipe(panel.description, effectOptionalString =>
              effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.toLowerCase),
            ),
          ).toContain('schema v6 only');
        const contextBriefQueries = EffectArray.map(
          EffectArray.flatMap(contextBriefPanels, panel => panel.targets),
          target => target.query!,
        );
        const contextBriefQueryText = EffectArray.join(contextBriefQueries, '\n');
        for (const query of contextBriefQueries) expect(query).toContain(contextBriefOperationPredicate);
        expect(contextBriefQueryText).toContain('span.threadnote.operation = "context_brief"');
        expect(contextBriefQueryText).toContain('span.threadnote.operation = "context.brief"');
        for (const attribute of [
          'span.threadnote.context_brief.scope',
          'span.threadnote.context_brief.citation_coverage',
          'span.threadnote.context_brief.citation_result',
          'span.threadnote.context_brief.citation_unknown_reason',
          'span.threadnote.context_brief.cited_memories_bucket',
          'span.threadnote.context_brief.citations_bucket',
          'span.threadnote.context_brief.exact_citations_bucket',
          'span.threadnote.context_brief.relocated_citations_bucket',
          'span.threadnote.context_brief.stale_citations_bucket',
          'span.threadnote.context_brief.unknown_citations_bucket',
          'span.threadnote.context_brief.repositories_validated_bucket',
          'span.threadnote.context_brief.cache_hits_bucket',
          'span.threadnote.context_brief.output_truncated',
          'span.threadnote.context_brief.contract',
          'span.threadnote.context_brief.mode',
          'span.threadnote.context_brief.code_anchor_coverage',
          'span.threadnote.context_brief.code_anchor_gap',
          'span.threadnote.context_brief.gap_class',
          'span.threadnote.context_brief.recovery_present',
          'span.threadnote.context_brief.returned_lane',
          'span.threadnote.context_brief.code_anchors_requested_bucket',
          'span.threadnote.context_brief.code_anchors_resolved_bucket',
          'span.threadnote.context_brief.code_anchors_matched_memories_bucket',
        ]) {
          expect(contextBriefQueryText).toContain(attribute);
        }
        for (const privateAttribute of [
          'session.id',
          'invocation.id',
          'repository_id',
          'repository_name',
          'repository_path',
          'workset_name',
          'memory_uri',
          'citation_uri',
          'commit_hash',
          'snapshot_id',
          'task_text',
          'query_text',
          'error.message',
        ]) {
          expect(contextBriefQueryText).not.toContain(privateAttribute);
        }
        const contextBriefResultAttributes = [
          'citation_coverage',
          'citation_result',
          'citation_unknown_reason',
          'cited_memories_bucket',
          'citations_bucket',
          'exact_citations_bucket',
          'relocated_citations_bucket',
          'stale_citations_bucket',
          'unknown_citations_bucket',
          'repositories_validated_bucket',
          'cache_hits_bucket',
          'output_truncated',
          'code_anchor_coverage',
          'code_anchor_gap',
          'gap_class',
          'recovery_present',
          'returned_lane',
          'code_anchors_requested_bucket',
          'code_anchors_resolved_bucket',
          'code_anchors_matched_memories_bucket',
        ];
        for (const query of EffectArray.filter(contextBriefQueries, candidate =>
          EffectArray.some(contextBriefResultAttributes, attribute =>
            Effect2.pipe(candidate, EffectString.includes(attribute)),
          ),
        )) {
          expect(query).toMatch(/span\.threadnote\.(?:phase\.)?outcome = "success"/u);
        }
        expect(
          EffectOption.getOrUndefined(EffectArray.findFirst(panels, panel => panel.id === 29))?.description,
        ).toContain('do not prove correctness');
        const contextBriefFailures = EffectOption.getOrUndefined(
          EffectArray.findFirst(panels, panel => panel.id === 34),
        );
        expect(contextBriefFailures?.type).toBe('timeseries');
        expect(contextBriefFailures?.targets).toHaveLength(2);
        expect(contextBriefFailures?.targets[0]?.query).toContain('count_over_time()');
        expect(contextBriefFailures?.targets[0]?.query).not.toContain('with (most_recent=true)');
        expect(contextBriefFailures?.targets[0]?.query).toContain('span.threadnote.context_brief.scope != nil');
        expect(contextBriefFailures?.targets[1]?.query).toContain('span.threadnote.context_brief.scope = nil');

        const codeAnchorCoverage = EffectOption.getOrUndefined(EffectArray.findFirst(panels, panel => panel.id === 36));
        expect(codeAnchorCoverage?.targets[0]?.query).toContain('span.threadnote.context_brief.code_anchor_gap');
        expect(codeAnchorCoverage?.targets[0]?.query).toContain('span.threadnote.context_brief.recovery_present');
        const returnedLanes = EffectOption.getOrUndefined(EffectArray.findFirst(panels, panel => panel.id === 37));
        expect(returnedLanes?.targets[0]?.query).toContain('span.threadnote.context_brief.returned_lane');

        const finalizationPanels = EffectArray.filter(panels, panel => panel.id >= 39 && panel.id <= 40);
        expect(EffectArray.map(finalizationPanels, panel => panel.title)).toEqual([
          'Code-anchor finalization outcomes',
          'Code-anchor finalization work buckets',
        ]);
        for (const panel of finalizationPanels) {
          expect(
            Effect2.pipe(panel.description, effectOptionalString =>
              effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.toLowerCase),
            ),
          ).toContain('schema v6 only');
          for (const query of EffectArray.map(panel.targets, target => target.query!)) {
            expect(query).toContain(finalizationPhasePredicate);
            expect(query).toContain(schemaV6Predicate);
            expect(query).not.toContain('session.id');
            expect(query).not.toContain('invocation.id');
            for (const privateAttribute of ['memory_uri', 'repository', 'path', 'citation', 'pending_intent', 'uri']) {
              expect(query).not.toContain(privateAttribute);
            }
          }
        }
        const finalizationQueryText = EffectArray.join(
          EffectArray.map(
            EffectArray.map(
              EffectArray.flatMap(finalizationPanels, panel => panel.targets),
              target => target.query,
            ),
            item => (item === null || item === undefined ? '' : String(item)),
          ),
          '\n',
        );
        for (const attribute of [
          'span.threadnote.code_anchor_finalization.trigger',
          'span.threadnote.code_anchor_finalization.result',
          'span.threadnote.code_anchor_finalization.scanned_bucket',
          'span.threadnote.code_anchor_finalization.matched_bucket',
          'span.threadnote.code_anchor_finalization.finalized_bucket',
          'span.threadnote.code_anchor_finalization.pending_bucket',
          'span.threadnote.code_anchor_finalization.conflict_bucket',
          'span.threadnote.code_anchor_finalization.failed_bucket',
          'span.threadnote.code_anchor_finalization.latency_ms_bucket',
        ]) {
          expect(finalizationQueryText).toContain(attribute);
        }

        for (const panel of EffectArray.filter(panels, candidate => candidate.type !== 'table')) {
          const metricQueries = EffectArray.join(
            EffectArray.map(
              EffectArray.map(panel.targets, target => target.query),
              item => (item === null || item === undefined ? '' : String(item)),
            ),
            '\n',
          );
          expect(metricQueries).not.toContain('session.id');
          expect(metricQueries).not.toContain('invocation.id');
          const rename = metricRenames.get(panel.id);
          if (rename === undefined) {
            expect(panel.transformations ?? []).toEqual([]);
            continue;
          }
          const expectedTransformationCount = panel.id === 23 ? 6 : panel.type === 'bargauge' ? 4 : 1;
          expect(panel.transformations).toHaveLength(expectedTransformationCount);
          const transformation = panel.transformations?.[0];
          expect(transformation?.id).toBe('renameByRegex');
          expect(typeof transformation?.options.regex).toBe('string');
          expect(typeof transformation?.options.renamePattern).toBe('string');
          expect(
            Effect2.pipe(
              rename.raw,
              EffectString.replace(
                new RegExp(transformation!.options.regex!, 'u'),
                transformation!.options.renamePattern!,
              ),
            ),
          ).toBe(rename.rendered);
        }
        expect(metricRenames.size).toBe(12);
        const descendingGaugeTransforms = [
          {
            id: 'reduce',
            options: {includeTimeField: false, mode: 'seriesToRows', reducers: ['lastNotNull']},
          },
          {
            id: 'sortBy',
            options: {fields: {}, sort: [{desc: true, field: 'Last *'}]},
          },
          {
            id: 'rowsToFields',
            options: {
              mappings: [
                {fieldName: 'Field', handlerKey: 'field.name'},
                {fieldName: 'Last *', handlerKey: 'field.value'},
              ],
            },
          },
        ];
        for (const panel of [
          operationDuration,
          phaseElapsed,
          graphRequestDuration,
          graphLatencyBySize,
          EffectOption.getOrUndefined(EffectArray.findFirst(panels, panel => panel.id === 27)),
          EffectOption.getOrUndefined(EffectArray.findFirst(panels, panel => panel.id === 28)),
        ]) {
          expect(panel?.transformations?.slice(1)).toEqual(descendingGaugeTransforms);
        }
        expect(graphQueryStages?.transformations?.slice(3)).toEqual(descendingGaugeTransforms);
        const stageWithSubphaseRename = graphQueryStages?.transformations?.[1];
        expect(
          Effect2.pipe(
            '{p=0.95, span.threadnote.graph.request_kind="inspect.query", span.threadnote.stage="query-worktree-observation", span.threadnote.subphase="skipped"}',
            EffectString.replace(
              new RegExp(stageWithSubphaseRename!.options.regex!, 'u'),
              stageWithSubphaseRename!.options.renamePattern!,
            ),
          ),
        ).toBe('inspect.query / query-worktree-observation / skipped: p0.95');
        const stageRename = graphQueryStages?.transformations?.[2];
        expect(
          Effect2.pipe(
            '{p=0.95, span.threadnote.graph.request_kind="inspect.query", span.threadnote.stage="query-serialization"}',
            EffectString.replace(new RegExp(stageRename!.options.regex!, 'u'), stageRename!.options.renamePattern!),
          ),
        ).toBe('inspect.query / query-serialization: p0.95');
        const tables = EffectArray.filter(panels, panel => panel.type === 'table');
        expect(tables).not.toHaveLength(0);
        for (const panel of tables) {
          for (const target of panel.targets) {
            expect(target.query!).toContain('with (most_recent=true)');
            expect(target.tableType).toBe('spans');
          }
        }
        const recentFailures = EffectOption.getOrUndefined(EffectArray.findFirst(panels, panel => panel.id === 12));
        expect(recentFailures?.title).toBe('Recent operational failures');
        expect(recentFailures?.targets).toHaveLength(1);
        expect(recentFailures?.targets[0]?.query).toContain('span.threadnote.outcome != "success"');
        expect(recentFailures?.targets[0]?.query).toContain('span.threadnote.outcome != "interrupted"');
        const failureTableDisplayNames = EffectRecord.fromEntries(
          EffectArray.map(recentFailures?.fieldConfig.overrides ?? [], override => [
            override.matcher.options,
            EffectOption.getOrUndefined(
              EffectArray.findFirst(override.properties, property => property.id === 'displayName'),
            )?.value,
          ]),
        );
        expect(failureTableDisplayNames).toEqual({
          'error.type': 'Error type',
          'service.version': 'App version',
          'session.id': 'Session',
          'threadnote.component': 'Component',
          'threadnote.duration_ms': 'Duration',
          'threadnote.failure.code': 'Failure code',
          'threadnote.failure.domain': 'Failure domain',
          'threadnote.failure.recovery': 'Recovery',
          'threadnote.invocation.id': 'Invocation',
          'threadnote.operation': 'Operation',
          'threadnote.outcome': 'Outcome',
          'threadnote.session.scope': 'Session scope',
        });

        const unexpectedFull = EffectOption.getOrUndefined(EffectArray.findFirst(panels, panel => panel.id === 13));
        expect(unexpectedFull?.title).toBe('Unexpected full-build percentage');
        expect(unexpectedFull?.description).toContain('zero-count buckets render as 0%');
        expect(unexpectedFull?.description).toContain('datasource-wide NoData remains visible');
        expect(unexpectedFull?.targets).toHaveLength(3);
        expect(unexpectedFull?.targets[0]?.query).toContain('small-delta-full');
        expect(unexpectedFull?.targets[0]?.query).toContain('high-amplification-full');
        expect(unexpectedFull?.targets[0]?.query).toContain('critical-amplification-full');
        expect(unexpectedFull?.targets[0]?.query).toContain('span.threadnote.graph.build_kind = "dirty"');
        expect(unexpectedFull?.targets[1]?.query).toContain('span.threadnote.graph.build_kind = "dirty"');
        expect(unexpectedFull?.targets[1]?.query).not.toContain('span.threadnote.graph.efficiency_class');
        expect(unexpectedFull?.targets[2]).toEqual(
          expect.objectContaining({
            datasource: {type: '__expr__', uid: '__expr__'},
            expression: '$A / ($B + ($B == 0)) * 100',
            type: 'math',
          }),
        );
        expect(unexpectedFull?.targets[0]?.query).toContain(canaryExclusionPredicate);
        expect(unexpectedFull?.targets[1]?.query).toContain(canaryExclusionPredicate);

        const graphPanels = EffectArray.filter(panels, panel => panel.id >= 13 && panel.id <= 20);
        expect(EffectArray.map(graphPanels, panel => panel.title)).toEqual([
          'Unexpected full-build percentage',
          'Graph builds by app version',
          'Graph builds by mode and efficiency',
          'Full-build fallback reasons',
          'Rewrite amplification buckets',
          'Cached fact replay bytes buckets',
          'Fact replay amplification buckets',
          'Recent inefficient graph materializations',
        ]);
        const graphQueries = EffectArray.map(
          EffectArray.filter(
            EffectArray.flatMap(graphPanels, panel => panel.targets),
            target => target.datasource.type === 'tempo',
          ),
          target => target.query!,
        );
        const graphQueryText = EffectArray.join(graphQueries, '\n');
        for (const attribute of [
          'resource.service.version',
          ...EffectArray.map(dashboardGraphAttributes, attribute => `span.${attribute}`),
        ]) {
          expect(graphQueryText).toContain(attribute);
        }
        expect(
          EffectOption.getOrUndefined(EffectArray.findFirst(panels, panel => panel.id === 17))?.targets[0]?.query,
        ).toContain('span.threadnote.graph.delta_files_bucket != "0"');
        expect(
          EffectOption.getOrUndefined(EffectArray.findFirst(panels, panel => panel.id === 18))?.targets[0]?.query,
        ).toContain('span.threadnote.graph.delta_files_bucket != "0"');
        expect(
          EffectOption.getOrUndefined(EffectArray.findFirst(panels, panel => panel.id === 19))?.targets[0]?.query,
        ).toContain('span.threadnote.graph.changed_fact_bytes_bucket != "0"');
        for (const id of [17, 18, 19]) {
          expect(
            EffectOption.getOrUndefined(EffectArray.findFirst(panels, panel => panel.id === id))?.targets[0]?.query,
          ).toContain('span.threadnote.graph.build_kind = "dirty"');
        }
        expect(graphQueryText).not.toContain('session.id');
        expect(graphQueryText).not.toContain('invocation.id');
        expect(graphQueryText).not.toContain('repository');
        expect(graphQueryText).not.toContain('commit');
        expect(graphQueryText).not.toContain('path');
        expect(
          EffectArray.every(graphQueries, query =>
            Effect2.pipe(query, EffectString.includes(canaryExclusionPredicate)),
          ),
        ).toBe(true);

        const recentInefficient = EffectOption.getOrUndefined(EffectArray.findFirst(panels, panel => panel.id === 20));
        expect(recentInefficient?.type).toBe('table');
        expect(recentInefficient?.targets).toHaveLength(1);
        const inefficientQuery = recentInefficient?.targets[0]?.query;
        expect(inefficientQuery).toContain(inefficientGraphBuildPredicate);
        expect(inefficientQuery?.length).toBeLessThanOrEqual(tempoQueryLengthLimit);
        for (const attribute of [
          'resource.service.version',
          ...EffectArray.map(dashboardGraphAttributes, attribute => `span.${attribute}`),
          'span.threadnote.duration_ms',
        ]) {
          expect(inefficientQuery).toContain(attribute);
        }
        expect(inefficientQuery).toContain('span.threadnote.graph.build_kind');
        expect(inefficientQuery).toContain('span.threadnote.graph.materialization_mode');
        expect(inefficientQuery).not.toContain('session.id');
        expect(inefficientQuery).not.toContain('invocation.id');
        expect(inefficientQuery).toContain('with (most_recent=true)');

        const automaticUpdates = EffectOption.getOrUndefined(EffectArray.findFirst(panels, panel => panel.id === 21));
        expect(automaticUpdates?.title).toBe('Automatic update results');
        expect(automaticUpdates?.type).toBe('timeseries');
        expect(automaticUpdates?.targets).toHaveLength(1);
        expect(automaticUpdates?.transformations).toBeUndefined();
        const automaticUpdateQuery = automaticUpdates?.targets[0]?.query;
        expect(automaticUpdateQuery).toContain(autoUpdateSchemaPredicate);
        expect(automaticUpdateQuery).toContain(canaryExclusionPredicate);
        expect(automaticUpdateQuery).toContain('span.threadnote.operation = "auto-update-worker"');
        expect(automaticUpdateQuery).toContain('span.threadnote.auto_update.result != nil');
        expect(automaticUpdateQuery).toContain(
          'by (span.threadnote.auto_update.result, span.threadnote.auto_update.repair_required)',
        );

        const scopedAttribute = /(?:resource|span)\.([A-Za-z_][A-Za-z0-9_.]*)/gu;
        const attributes = new Set(
          EffectArray.flatMap(queries, query =>
            Array.from(Effect2.pipe(query, EffectString.matchAll(scopedAttribute)), match => match[1]),
          ),
        );
        expect(attributes.size).toBeGreaterThan(10);
        for (const attribute of attributes) expect(collector).toContain(`"${attribute}"`);
      }),
    );

    layerIt.effect('keeps the production consent documentation aligned with the operated destination', () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const [commands, telemetryDocs, websiteDocs, gatewayReadme, productionRunbook] = yield* Effect.all(
          [
            fileSystem.readFileString(`${process.cwd()}/apps/threadnote/src/telemetry/commands.ts`),
            fileSystem.readFileString(`${process.cwd()}/docs/telemetry.md`),
            fileSystem.readFileString(`${process.cwd()}/apps/website/src/content/docsTelemetry.ts`),
            fileSystem.readFileString(`${process.cwd()}/infra/telemetry-gateway/README.md`),
            fileSystem.readFileString(`${process.cwd()}/docs/operations/telemetry-production.md`),
          ],
          {concurrency: 'unbounded'},
        );

        for (const source of [commands, telemetryDocs, websiteDocs]) {
          expect(source).toContain('14-day');
          expect(source).toContain('Grafana Cloud EU');
          expect(source).toMatch(/source IP|IP addresses/u);
        }
        for (const source of [commands, telemetryDocs, websiteDocs]) {
          for (const lifecycleTerm of ['successful', 'failed', 'interrupt', 'outcome']) {
            expect(Effect2.pipe(source, EffectString.toLowerCase)).toContain(lifecycleTerm);
          }
          for (const graphTerm of [
            'build',
            'materialization',
            'fallback',
            'closure',
            'efficiency',
            'file-count',
            'fact-byte',
            'amplification',
          ]) {
            expect(Effect2.pipe(source, EffectString.toLowerCase)).toContain(graphTerm);
          }
          for (const excludedIdentity of ['path', 'repository', 'commit']) {
            expect(Effect2.pipe(source, EffectString.toLowerCase)).toContain(excludedIdentity);
          }
        }
        for (const source of [commands, telemetryDocs, websiteDocs]) expect(source).toContain('delta');
        expect(telemetryDocs).toContain('https://telemetry.threadnote.io/v1/traces');
        expect(telemetryDocs).toContain('requires consent version 6');
        expect(telemetryDocs).toMatch(
          /version 1, version 2, version 3, version 4, or version 5\s+opt-in fails closed/u,
        );
        for (const excludedQueryDetail of ['query text', 'symbol names', 'exact file/symbol/edge counts']) {
          expect(telemetryDocs).toContain(excludedQueryDetail);
        }
        expect(gatewayReadme).toContain('Existing operation panels admit schema versions 1, 2, 3, 4, 5, and 6');
        expect(gatewayReadme).toContain('Graph-build panels admit versions 2, 3, 4, 5, and 6');
        expect(gatewayReadme).toContain('Graph-query panels admit versions 4, 5, and 6');
        expect(gatewayReadme).toContain('before sending sixteen traces');
        expect(productionRunbook).toContain('gateway, sixteen-trace/six-version canary, and dashboard gates');
        expect(productionRunbook).toContain('until all sixteen stored protobufs');
        expect(productionRunbook).toMatch(/consent-v1\/v2\/v3\/v4\/v5 configurations\s+must fail closed/u);
        expect(commands).toContain('endpoint === DEFAULT_TELEMETRY_ENDPOINT');
      }),
    );
  });
});
