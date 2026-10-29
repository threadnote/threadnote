import {Array as EffectArray} from 'effect';
import {ScriptSystemInfoLayer} from './effect/system-layer.js';
import {provideScriptLayer, scriptError, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Clock, DateTime, Effect, FileSystem, Layer, Option, Predicate} from 'effect';
import * as Schema from 'effect/Schema';
import {
  platformPathFor,
  runtimeLstat,
  runtimePlatform,
  runtimeStat,
  SystemInfo,
  type RuntimeBigIntStats,
} from '@threadnote/platform/system';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const MAX_DARWIN_LSOF_BYTES = 8 * 1024 * 1024;
const DARWIN_OPEN_FILE_SAMPLE_INTERVAL_MILLISECONDS = 1_000;
const MAX_OPEN_FILE_DESCRIPTORS = 65_536;
const MAX_OPEN_FILE_PROCESSES = 4_096;
const hostPath = platformPathFor(runtimePlatform);
const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const withRest = <const S extends Schema.Struct.Fields>(schema: S) =>
  Schema.StructWithRest(Schema.Struct(schema), [JsonRecordSchema]);
const optionalNumber = Schema.optionalKey(Schema.Finite);
const SamplerPhaseSchema = withRest({
  cpuMilliseconds: optionalNumber,
  databasePeakBytes: Schema.Finite,
  ioReadBytes: optionalNumber,
  ioWriteBytes: optionalNumber,
  journalPeakBytes: optionalNumber,
  processPeakCount: optionalNumber,
  processSampleAttempts: optionalNumber,
  processSampleFailures: optionalNumber,
  processSampleGapPeakMilliseconds: optionalNumber,
  processSamples: optionalNumber,
  rssPeakBytes: optionalNumber,
  samples: Schema.Finite,
  shmPeakBytes: Schema.Finite,
  temporaryLinkedPeakBytes: optionalNumber,
  temporaryOpenAttempts: optionalNumber,
  temporaryOpenFailures: optionalNumber,
  temporaryOpenPeakBytes: optionalNumber,
  temporaryOpenSamples: optionalNumber,
  temporaryPeakBytes: Schema.Finite,
  walPeakBytes: Schema.Finite,
});
const ProcessTelemetrySchema = Schema.Union([
  withRest({
    availability: Schema.Literal('available'),
    ioCounters: Schema.optionalKey(Schema.Literal('linux-proc-read-write-bytes')),
    parentIdentityValidation: Schema.Literals(['darwin-ps-lstart', 'linux-proc-starttime']),
    sampleIntervalMilliseconds: optionalNumber,
    scope: Schema.optionalKey(Schema.Literal('recursive-process-tree')),
    source: Schema.Literals(['darwin-ps', 'linux-proc']),
  }),
  withRest({
    availability: Schema.Literal('unavailable'),
    parentIdentityValidation: Schema.Literal('process-liveness-only'),
    reason: Schema.Literals(['parent-inspection-unavailable', 'unsupported-platform']),
    source: Schema.Literal('none'),
  }),
]);
const TemporaryTelemetrySchema = Schema.Union([
  withRest({
    availability: Schema.Literal('available'),
    maximumOpenFileDescriptors: Schema.Finite,
    maximumProcesses: Schema.Finite,
    openFileSampleIntervalMilliseconds: Schema.Finite,
    projectionByteLimit: optionalNumber,
    scope: Schema.Literal('temporary-root-linked-plus-process-tree-open-files'),
    source: Schema.Literals(['darwin-lsof', 'linux-proc-fd']),
  }),
  withRest({
    availability: Schema.Literal('unavailable'),
    reason: Schema.Literals(['open-file-inspection-unavailable', 'unsupported-platform']),
    scope: Schema.Literal('temporary-root-linked-files-only'),
    source: Schema.Literal('directory-walk'),
  }),
]);
const SamplerArtifactSchema = withRest({
  intervalMilliseconds: Schema.Finite,
  phases: Schema.Record(Schema.String, SamplerPhaseSchema),
  platform: Schema.String,
  processTelemetry: ProcessTelemetrySchema,
  samples: Schema.Finite,
  temporaryTelemetry: Schema.optionalKey(TemporaryTelemetrySchema),
  version: Schema.Literals([2, 3, 4]),
});
const SamplerCheckpointSchema = withRest({
  sampler: SamplerArtifactSchema,
  state: Schema.Literals(['aborted', 'complete', 'parent-exited', 'running']),
  updatedAt: Schema.String,
  version: Schema.Literals([2, 3, 4]),
});
function decodeJson<S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown): S['Type'] {
  return Schema.decodeUnknownSync(schema)(value);
}

export interface CodeGraphBenchmarkSamplerPhase {
  readonly cpuMilliseconds?: number;
  readonly databasePeakBytes: number;
  readonly journalPeakBytes?: number;
  readonly ioReadBytes?: number;
  readonly ioWriteBytes?: number;
  readonly processPeakCount?: number;
  readonly processSampleAttempts?: number;
  readonly processSampleFailures?: number;
  readonly processSampleGapPeakMilliseconds?: number;
  readonly processSamples?: number;
  readonly rssPeakBytes?: number;
  readonly samples: number;
  readonly shmPeakBytes: number;
  readonly temporaryPeakBytes: number;
  readonly temporaryOpenAttempts?: number;
  readonly temporaryOpenFailures?: number;
  readonly temporaryLinkedPeakBytes?: number;
  readonly temporaryOpenPeakBytes?: number;
  readonly temporaryOpenSamples?: number;
  readonly walPeakBytes: number;
}

export type CodeGraphBenchmarkSamplerProcessTelemetry =
  | {
      readonly availability: 'available';
      readonly ioCounters?: 'linux-proc-read-write-bytes';
      readonly parentIdentityValidation: 'darwin-ps-lstart' | 'linux-proc-starttime';
      readonly sampleIntervalMilliseconds?: number;
      readonly scope?: 'recursive-process-tree';
      readonly source: 'darwin-ps' | 'linux-proc';
    }
  | {
      readonly availability: 'unavailable';
      readonly parentIdentityValidation: 'process-liveness-only';
      readonly reason: 'parent-inspection-unavailable' | 'unsupported-platform';
      readonly source: 'none';
    };

export type CodeGraphBenchmarkSamplerTemporaryTelemetry =
  | {
      readonly availability: 'available';
      readonly maximumOpenFileDescriptors: number;
      readonly maximumProcesses: number;
      readonly openFileSampleIntervalMilliseconds: number;
      readonly projectionByteLimit?: number;
      readonly scope: 'temporary-root-linked-plus-process-tree-open-files';
      readonly source: 'darwin-lsof' | 'linux-proc-fd';
    }
  | {
      readonly availability: 'unavailable';
      readonly reason: 'open-file-inspection-unavailable' | 'unsupported-platform';
      readonly scope: 'temporary-root-linked-files-only';
      readonly source: 'directory-walk';
    };

/** Exact accounting is limited to entries admitted by this sample, not the entire OS tree. */
export interface BenchmarkRssContributors {
  readonly admittedAccountingComplete: boolean;
  readonly contributors: readonly BenchmarkRssContributor[];
  readonly omittedProcessCount: number;
  readonly omittedRssBytes: number | null;
  readonly processCount: number;
  readonly rssBytes: number;
}

export interface BenchmarkRssContributor {
  readonly token: string;
  readonly parentToken: string | null;
  readonly role: 'root' | 'descendant';
  readonly rssBytes: number;
}

export type BenchmarkRssAcquisition =
  | {readonly provenance: 'cached-initial-unknown'}
  | {
      readonly provenance: 'monotonic-window';
      /** Includes both phase-label observations and the intervening process/storage sampling. */
      readonly startOffsetMicroseconds: number;
      readonly endOffsetMicroseconds: number;
      readonly phaseBefore: string | null;
      readonly phaseAfter: string | null;
      readonly transition: 'observed-between-phase-observations' | 'unknown';
    };

export interface BenchmarkRssPeakDiagnostic extends BenchmarkRssContributors {
  readonly acquisition: BenchmarkRssAcquisition;
}

// Exact allowlist: arbitrary phase-file text (including paths) never enters diagnostics.
const RSS_DIAGNOSTIC_PHASES = new Set([
  'start',
  'preparing-fixture',
  'preparing-runtime',
  'registering:progress',
  'waiting:progress',
  'reclaiming:progress',
  'scanning:progress',
  'materializing:progress',
  'embedding:progress',
  'resolving:references',
  'resolving:complete',
  'sharing:applying-deltas',
  'sharing:building-local-overlay',
  'sharing:discovering-shared-base',
  'sharing:downloading-checkpoint',
  'activating:progress',
  'activating:complete',
  'activating:promoting',
  'activating:structural-ready',
  'activating:summarizing-analysis',
  'activating:validating-input',
  'activating:writing-and-checkpointing',
]);

export function rssDiagnosticPhase(value: string | undefined): string | null {
  return value !== undefined && RSS_DIAGNOSTIC_PHASES.has(value) ? value : null;
}

export function rssDiagnosticAcquisition(
  startOffsetMicroseconds: number,
  endOffsetMicroseconds: number,
  phaseBefore: string | undefined,
  phaseAfter: string | undefined,
): BenchmarkRssAcquisition {
  const before = rssDiagnosticPhase(phaseBefore);
  const after = rssDiagnosticPhase(phaseAfter);
  return {
    provenance: 'monotonic-window',
    startOffsetMicroseconds,
    endOffsetMicroseconds,
    phaseBefore: before,
    phaseAfter: after,
    transition:
      before !== null && after !== null && before !== after ? 'observed-between-phase-observations' : 'unknown',
  };
}

/** Production's single operation peak: first valid sample wins even at zero; ties retain its evidence. */
export function recordRssPeakDiagnostic(
  previous: BenchmarkRssPeakDiagnostic | undefined,
  sample: BenchmarkProcessTreeSample | undefined,
  acquisition: BenchmarkRssAcquisition | undefined,
): BenchmarkRssPeakDiagnostic | undefined {
  const projection = sample?.rssContributors;
  return projection !== undefined &&
    acquisition !== undefined &&
    (previous === undefined || projection.rssBytes > previous.rssBytes)
    ? {...projection, acquisition}
    : previous;
}

/** Stateless per-run correlation, without retaining a process identity registry. */
export function createRssDiagnosticTokenizer(key: Uint8Array): (processId: number, startIdentity: string) => string {
  return (processId, startIdentity) =>
    new Bun.CryptoHasher('sha256', key).update(`${processId}:${startIdentity}`).digest('hex');
}

type RssDiagnosticTokenizer = ReturnType<typeof createRssDiagnosticTokenizer>;

/** Narrow startup seam: disabled execution never requests a secret or reads the diagnostic clock. */
export function createRssDiagnosticRun(
  enabled: boolean,
  sources?: {readonly randomKey: () => Uint8Array; readonly now: () => bigint},
): {readonly tokenize: RssDiagnosticTokenizer; readonly offsetMicroseconds: () => number} | undefined {
  if (!enabled) return undefined;
  const key = sources?.randomKey() ?? crypto.getRandomValues(new Uint8Array(32));
  const now = sources?.now ?? (() => process.hrtime.bigint());
  const origin = now();
  return {
    tokenize: createRssDiagnosticTokenizer(key),
    offsetMicroseconds: () => Number((now() - origin) / 1_000n),
  };
}

export interface CodeGraphBenchmarkSamplerArtifact {
  readonly intervalMilliseconds: number;
  readonly phases: Readonly<Record<string, CodeGraphBenchmarkSamplerPhase>>;
  readonly platform: string;
  readonly processTelemetry: CodeGraphBenchmarkSamplerProcessTelemetry;
  readonly samples: number;
  readonly rssPeakDiagnostic?: BenchmarkRssPeakDiagnostic;
  readonly temporaryTelemetry?: CodeGraphBenchmarkSamplerTemporaryTelemetry;
  readonly version: 2 | 3 | 4;
}

export interface CodeGraphBenchmarkSamplerCheckpoint {
  readonly sampler: CodeGraphBenchmarkSamplerArtifact;
  readonly state: 'aborted' | 'complete' | 'parent-exited' | 'running';
  readonly updatedAt: string;
  readonly version: 2 | 3 | 4;
}

export function parseCodeGraphBenchmarkSamplerArtifact(value: unknown): CodeGraphBenchmarkSamplerArtifact {
  if (typeof value !== 'object' || value === null)
    throw ScriptError.make({message: 'Benchmark sampler artifact must be an object.'});
  if (!Schema.is(SamplerArtifactSchema)(value))
    throw ScriptError.make({message: 'Benchmark sampler artifact is invalid.'});
  const artifact: CodeGraphBenchmarkSamplerArtifact = value;
  if (
    (artifact.version !== 2 && artifact.version !== 3 && artifact.version !== 4) ||
    typeof artifact.intervalMilliseconds !== 'number' ||
    !Number.isSafeInteger(artifact.intervalMilliseconds) ||
    artifact.intervalMilliseconds < 10 ||
    typeof artifact.platform !== 'string' ||
    artifact.platform.length === 0 ||
    !Number.isSafeInteger(artifact.samples) ||
    Number(artifact.samples) < 1 ||
    typeof artifact.phases !== 'object' ||
    artifact.phases === null
  ) {
    throw ScriptError.make({message: 'Benchmark sampler artifact is invalid.'});
  }
  const processTelemetry = parseSamplerProcessTelemetry(artifact.platform, artifact.processTelemetry, artifact.version);
  const temporaryTelemetry = parseSamplerTemporaryTelemetry(
    artifact.platform,
    artifact.temporaryTelemetry,
    artifact.version,
  );
  let phaseSamples = 0;
  for (const [phase, sample] of EffectRecord.toEntries(artifact.phases)) {
    if (!phase || !isSamplerPhase(sample, processTelemetry, temporaryTelemetry, artifact.version)) {
      throw ScriptError.make({message: `Benchmark sampler phase ${phase || '<empty>'} is invalid.`});
    }
    phaseSamples += sample.samples;
    if (!Number.isSafeInteger(phaseSamples))
      throw ScriptError.make({message: 'Benchmark sampler sample total is invalid.'});
  }
  if (phaseSamples !== artifact.samples)
    throw ScriptError.make({message: 'Benchmark sampler phase samples do not match its total.'});
  const phaseValues = EffectRecord.values(artifact.phases);
  if (
    artifact.rssPeakDiagnostic !== undefined &&
    (artifact.version !== 4 ||
      processTelemetry.availability !== 'available' ||
      !isRssPeakDiagnostic(artifact.rssPeakDiagnostic) ||
      artifact.rssPeakDiagnostic.rssBytes !==
        Math.max(...EffectArray.map(EffectRecord.values(artifact.phases), phase => phase.rssPeakBytes ?? 0)) ||
      artifact.rssPeakDiagnostic.processCount >
        Math.max(...EffectArray.map(EffectRecord.values(artifact.phases), phase => phase.processPeakCount ?? 0)) ||
      !EffectArray.some(phaseValues, phase => (phase.processSamples ?? 0) > 0))
  )
    throw ScriptError.make({message: 'Benchmark sampler RSS peak diagnostic is invalid.'});
  return artifact;
}

function exactKeys<const Key extends string>(value: object, keys: readonly Key[]): value is Record<Key, unknown> {
  const observed = EffectRecord.keys(value);
  return observed.length === keys.length && EffectArray.every(observed, key => keys.includes(key));
}

function isRssPeakDiagnostic(value: unknown): value is BenchmarkRssPeakDiagnostic {
  if (
    typeof value !== 'object' ||
    value === null ||
    !exactKeys(value, [
      'admittedAccountingComplete',
      'contributors',
      'omittedProcessCount',
      'omittedRssBytes',
      'processCount',
      'rssBytes',
      'acquisition',
    ])
  )
    return false;
  const peak = value;
  const safeCount = (count: unknown): count is number => Number.isSafeInteger(count) && Number(count) >= 0;
  const token = (candidate: unknown): candidate is string =>
    typeof candidate === 'string' && /^[a-f0-9]{64}$/.test(candidate);
  if (
    !safeCount(peak.processCount) ||
    peak.processCount < 1 ||
    !safeCount(peak.rssBytes) ||
    !safeCount(peak.omittedProcessCount) ||
    !EffectArray.isArray(peak.contributors) ||
    peak.contributors.length !== Math.min(16, peak.processCount) ||
    peak.omittedProcessCount !== peak.processCount - peak.contributors.length
  )
    return false;
  const isContributor = (contributor: unknown): contributor is BenchmarkRssContributor => {
    if (!Predicate.isObject(contributor) || !exactKeys(contributor, ['token', 'parentToken', 'role', 'rssBytes']))
      return false;
    return (
      token(contributor.token) &&
      safeCount(contributor.rssBytes) &&
      (contributor.role === 'root'
        ? contributor.parentToken === null
        : contributor.role === 'descendant' &&
          token(contributor.parentToken) &&
          contributor.parentToken !== contributor.token)
    );
  };
  const seen = new Set<string>();
  const validatedContributors: BenchmarkRssContributor[] = [];
  let retainedBytes = 0n;
  let roots = 0;
  for (const [index, contributor] of peak.contributors.entries()) {
    if (!isContributor(contributor) || seen.has(contributor.token)) return false;
    seen.add(contributor.token);
    validatedContributors.push(contributor);
    if (contributor.role === 'root') roots += 1;
    const before = validatedContributors[index - 1];
    if (before !== undefined && compareRssContributors(before, contributor) > 0) return false;
    retainedBytes += BigInt(contributor.rssBytes);
  }
  if (roots > 1 || (peak.processCount <= 16 && roots !== 1)) return false;
  for (const contributor of validatedContributors) {
    const ancestors = new Set([contributor.token]);
    let parentToken = contributor.parentToken;
    while (parentToken !== null) {
      if (ancestors.has(parentToken)) return false;
      ancestors.add(parentToken);
      const parent = Option.getOrUndefined(
        EffectArray.findFirst(validatedContributors, candidate => candidate.token === parentToken),
      );
      if (parent === undefined) {
        if (peak.omittedProcessCount === 0) return false;
        break;
      }
      parentToken = parent.parentToken;
    }
  }
  const omittedUpperBound = BigInt(validatedContributors.at(-1)!.rssBytes) * BigInt(peak.omittedProcessCount);
  if (peak.admittedAccountingComplete === true) {
    if (
      !safeCount(peak.omittedRssBytes) ||
      retainedBytes + BigInt(peak.omittedRssBytes) !== BigInt(peak.rssBytes) ||
      BigInt(peak.omittedRssBytes) > omittedUpperBound ||
      (peak.omittedProcessCount === 0 && peak.omittedRssBytes !== 0)
    )
      return false;
  } else if (
    peak.admittedAccountingComplete !== false ||
    peak.omittedRssBytes !== null ||
    peak.rssBytes !== Number.MAX_SAFE_INTEGER ||
    retainedBytes + omittedUpperBound <= BigInt(Number.MAX_SAFE_INTEGER)
  )
    return false;
  const acquisition = peak.acquisition;
  if (!Predicate.isObject(acquisition)) return false;
  if (acquisition.provenance === 'cached-initial-unknown') return exactKeys(acquisition, ['provenance']);
  if (
    acquisition.provenance !== 'monotonic-window' ||
    !exactKeys(acquisition, [
      'provenance',
      'startOffsetMicroseconds',
      'endOffsetMicroseconds',
      'phaseBefore',
      'phaseAfter',
      'transition',
    ]) ||
    !safeCount(acquisition.startOffsetMicroseconds) ||
    !safeCount(acquisition.endOffsetMicroseconds) ||
    acquisition.endOffsetMicroseconds < acquisition.startOffsetMicroseconds ||
    !(
      acquisition.phaseBefore === null ||
      (typeof acquisition.phaseBefore === 'string' && RSS_DIAGNOSTIC_PHASES.has(acquisition.phaseBefore))
    ) ||
    !(
      acquisition.phaseAfter === null ||
      (typeof acquisition.phaseAfter === 'string' && RSS_DIAGNOSTIC_PHASES.has(acquisition.phaseAfter))
    )
  )
    return false;
  return (
    acquisition.transition ===
    (acquisition.phaseBefore !== null &&
    acquisition.phaseAfter !== null &&
    acquisition.phaseBefore !== acquisition.phaseAfter
      ? 'observed-between-phase-observations'
      : 'unknown')
  );
}

function compareRssContributors(left: BenchmarkRssContributor, right: BenchmarkRssContributor): number {
  return right.rssBytes - left.rssBytes || (left.token < right.token ? -1 : left.token > right.token ? 1 : 0);
}

export function parseCodeGraphBenchmarkSamplerCheckpoint(value: unknown): CodeGraphBenchmarkSamplerCheckpoint {
  if (typeof value !== 'object' || value === null)
    throw ScriptError.make({message: 'Benchmark sampler checkpoint must be an object.'});
  if (!Schema.is(SamplerCheckpointSchema)(value))
    throw ScriptError.make({message: 'Benchmark sampler checkpoint is invalid.'});
  const checkpoint: CodeGraphBenchmarkSamplerCheckpoint = value;
  if (
    (checkpoint.version !== 2 && checkpoint.version !== 3 && checkpoint.version !== 4) ||
    !['aborted', 'complete', 'parent-exited', 'running'].includes(checkpoint.state ?? '') ||
    typeof checkpoint.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(checkpoint.updatedAt))
  ) {
    throw ScriptError.make({message: 'Benchmark sampler checkpoint is invalid.'});
  }
  const sampler = parseCodeGraphBenchmarkSamplerArtifact(checkpoint.sampler);
  if (sampler.version !== checkpoint.version)
    throw ScriptError.make({message: 'Benchmark sampler checkpoint version is inconsistent.'});
  return checkpoint;
}

function parseSamplerProcessTelemetry(
  platform: string,
  value: unknown,
  version: CodeGraphBenchmarkSamplerArtifact['version'],
): CodeGraphBenchmarkSamplerProcessTelemetry {
  if (typeof value !== 'object' || value === null) {
    throw ScriptError.make({message: 'Benchmark sampler process telemetry must be an object.'});
  }
  let telemetry: CodeGraphBenchmarkSamplerProcessTelemetry;
  try {
    telemetry = decodeJson(ProcessTelemetrySchema, value);
  } catch {
    throw ScriptError.make({message: 'Benchmark sampler process telemetry does not match its platform.'});
  }
  if (telemetry.availability === 'available') {
    const legacyLinux =
      version === 2 &&
      platform === 'linux' &&
      telemetry.parentIdentityValidation === 'linux-proc-starttime' &&
      telemetry.source === 'linux-proc' &&
      telemetry.scope === undefined &&
      telemetry.sampleIntervalMilliseconds === undefined &&
      telemetry.ioCounters === undefined;
    const linuxTree =
      version >= 3 &&
      platform === 'linux' &&
      telemetry.parentIdentityValidation === 'linux-proc-starttime' &&
      telemetry.source === 'linux-proc' &&
      telemetry.scope === 'recursive-process-tree' &&
      telemetry.ioCounters === 'linux-proc-read-write-bytes';
    const darwinTree =
      version >= 3 &&
      platform === 'darwin' &&
      telemetry.parentIdentityValidation === 'darwin-ps-lstart' &&
      telemetry.source === 'darwin-ps' &&
      telemetry.scope === 'recursive-process-tree' &&
      telemetry.ioCounters === undefined;
    if (
      (legacyLinux || linuxTree || darwinTree) &&
      (version === 2 ||
        (Number.isSafeInteger(telemetry.sampleIntervalMilliseconds) &&
          Number(telemetry.sampleIntervalMilliseconds) >= 10))
    ) {
      return telemetry;
    }
  }
  const expectedReason =
    platform === 'linux' || (version >= 3 && platform === 'darwin')
      ? 'parent-inspection-unavailable'
      : 'unsupported-platform';
  if (
    telemetry.availability === 'unavailable' &&
    telemetry.parentIdentityValidation === 'process-liveness-only' &&
    telemetry.reason === expectedReason &&
    telemetry.source === 'none'
  ) {
    return telemetry;
  }
  throw ScriptError.make({message: 'Benchmark sampler process telemetry does not match its platform.'});
}

function parseSamplerTemporaryTelemetry(
  platform: string,
  value: unknown,
  version: CodeGraphBenchmarkSamplerArtifact['version'],
): CodeGraphBenchmarkSamplerTemporaryTelemetry | undefined {
  if (version < 4) {
    if (value !== undefined)
      throw ScriptError.make({message: 'Legacy benchmark sampler temporary telemetry must be omitted.'});
    return undefined;
  }
  if (typeof value !== 'object' || value === null) {
    throw ScriptError.make({message: 'Benchmark sampler temporary telemetry must be an object.'});
  }
  let telemetry: CodeGraphBenchmarkSamplerTemporaryTelemetry;
  try {
    telemetry = decodeJson(TemporaryTelemetrySchema, value);
  } catch {
    throw ScriptError.make({message: 'Benchmark sampler temporary telemetry does not match its platform.'});
  }
  if (
    telemetry.availability === 'available' &&
    telemetry.scope === 'temporary-root-linked-plus-process-tree-open-files' &&
    ((platform === 'linux' && telemetry.source === 'linux-proc-fd') ||
      (platform === 'darwin' && telemetry.source === 'darwin-lsof')) &&
    Number.isSafeInteger(telemetry.openFileSampleIntervalMilliseconds) &&
    Number(telemetry.openFileSampleIntervalMilliseconds) >= 10 &&
    Number.isSafeInteger(telemetry.maximumOpenFileDescriptors) &&
    Number(telemetry.maximumOpenFileDescriptors) >= 1 &&
    Number.isSafeInteger(telemetry.maximumProcesses) &&
    Number(telemetry.maximumProcesses) >= 1 &&
    (telemetry.source === 'darwin-lsof'
      ? Number.isSafeInteger(telemetry.projectionByteLimit) && Number(telemetry.projectionByteLimit) >= 1
      : telemetry.projectionByteLimit === undefined)
  ) {
    return telemetry;
  }
  const expectedReason =
    platform === 'linux' || platform === 'darwin' ? 'open-file-inspection-unavailable' : 'unsupported-platform';
  if (
    telemetry.availability === 'unavailable' &&
    telemetry.reason === expectedReason &&
    telemetry.scope === 'temporary-root-linked-files-only' &&
    telemetry.source === 'directory-walk'
  ) {
    return telemetry;
  }
  throw ScriptError.make({message: 'Benchmark sampler temporary telemetry does not match its platform.'});
}

function isSamplerPhase(
  value: unknown,
  processTelemetry: CodeGraphBenchmarkSamplerProcessTelemetry,
  temporaryTelemetry: CodeGraphBenchmarkSamplerTemporaryTelemetry | undefined,
  version: CodeGraphBenchmarkSamplerArtifact['version'],
): value is CodeGraphBenchmarkSamplerPhase {
  if (typeof value !== 'object' || value === null) return false;
  const sample = value as Partial<CodeGraphBenchmarkSamplerPhase>;
  const byteCounts = [sample.databasePeakBytes, sample.shmPeakBytes, sample.temporaryPeakBytes, sample.walPeakBytes];
  const journalValid =
    sample.journalPeakBytes === undefined ||
    (Number.isSafeInteger(sample.journalPeakBytes) && Number(sample.journalPeakBytes) >= 0);
  const processTelemetryValid =
    processTelemetry.availability === 'available'
      ? typeof sample.cpuMilliseconds === 'number' &&
        Number.isFinite(sample.cpuMilliseconds) &&
        sample.cpuMilliseconds >= 0 &&
        Number.isSafeInteger(sample.rssPeakBytes) &&
        Number(sample.rssPeakBytes) >= 0 &&
        (version === 2 ||
          (Number.isSafeInteger(sample.processPeakCount) &&
            Number(sample.processPeakCount) >= 0 &&
            Number.isSafeInteger(sample.processSamples) &&
            Number(sample.processSamples) >= 0 &&
            (Number(sample.processSamples) === 0 || Number(sample.processPeakCount) >= 1) &&
            (processTelemetry.source === 'linux-proc'
              ? Number.isSafeInteger(sample.ioReadBytes) &&
                Number(sample.ioReadBytes) >= 0 &&
                Number.isSafeInteger(sample.ioWriteBytes) &&
                Number(sample.ioWriteBytes) >= 0
              : sample.ioReadBytes === undefined && sample.ioWriteBytes === undefined)))
      : sample.cpuMilliseconds === undefined &&
        sample.ioReadBytes === undefined &&
        sample.ioWriteBytes === undefined &&
        sample.processPeakCount === undefined &&
        sample.processSamples === undefined &&
        sample.rssPeakBytes === undefined;
  const temporaryTelemetryValid =
    version < 4
      ? sample.temporaryLinkedPeakBytes === undefined &&
        sample.temporaryOpenAttempts === undefined &&
        sample.temporaryOpenFailures === undefined &&
        sample.temporaryOpenPeakBytes === undefined &&
        sample.temporaryOpenSamples === undefined
      : Number.isSafeInteger(sample.temporaryLinkedPeakBytes) &&
        Number(sample.temporaryLinkedPeakBytes) >= 0 &&
        (temporaryTelemetry?.availability === 'available'
          ? Number.isSafeInteger(sample.temporaryOpenAttempts) &&
            Number(sample.temporaryOpenAttempts) >= 0 &&
            Number.isSafeInteger(sample.temporaryOpenFailures) &&
            Number(sample.temporaryOpenFailures) >= 0 &&
            Number.isSafeInteger(sample.temporaryOpenPeakBytes) &&
            Number(sample.temporaryOpenPeakBytes) >= 0 &&
            Number.isSafeInteger(sample.temporaryOpenSamples) &&
            Number(sample.temporaryOpenSamples) >= 0 &&
            Number(sample.temporaryOpenAttempts) ===
              Number(sample.temporaryOpenSamples) + Number(sample.temporaryOpenFailures) &&
            Number(sample.temporaryPeakBytes) >= Number(sample.temporaryLinkedPeakBytes) &&
            Number(sample.temporaryPeakBytes) >= Number(sample.temporaryOpenPeakBytes)
          : sample.temporaryOpenAttempts === undefined &&
            sample.temporaryOpenFailures === undefined &&
            sample.temporaryOpenPeakBytes === undefined &&
            sample.temporaryOpenSamples === undefined);
  const processSampleDiagnostics = [
    sample.processSampleAttempts,
    sample.processSampleFailures,
    sample.processSampleGapPeakMilliseconds,
  ];
  const processSampleDiagnosticsValid =
    EffectArray.every(processSampleDiagnostics, candidate => candidate === undefined) ||
    (processTelemetry.availability === 'available' &&
      EffectArray.every(
        processSampleDiagnostics,
        candidate => Number.isSafeInteger(candidate) && Number(candidate) >= 0,
      ) &&
      Number(sample.processSampleAttempts) === Number(sample.processSamples) + Number(sample.processSampleFailures));
  return (
    processTelemetryValid &&
    processSampleDiagnosticsValid &&
    temporaryTelemetryValid &&
    Number.isSafeInteger(sample.samples) &&
    Number(sample.samples) > 0 &&
    EffectArray.every(byteCounts, candidate => Number.isSafeInteger(candidate) && Number(candidate) >= 0) &&
    journalValid
  );
}

interface MutablePhase {
  cpuMilliseconds: number;
  databasePeakBytes: number;
  ioReadBytes: number;
  ioWriteBytes: number;
  journalPeakBytes: number;
  processPeakCount: number;
  processSampleAttempts: number;
  processSampleFailures: number;
  processSampleGapPeakMilliseconds: number;
  processSamples: number;
  rssPeakBytes: number;
  samples: number;
  shmPeakBytes: number;
  temporaryLinkedPeakBytes: number;
  temporaryOpenAttempts: number;
  temporaryOpenFailures: number;
  temporaryOpenPeakBytes: number;
  temporaryOpenSamples: number;
  temporaryPeakBytes: number;
  walPeakBytes: number;
}

interface SamplerOptions {
  readonly checkpointIntervalMilliseconds: number;
  readonly checkpointPath: string;
  readonly databasePath: string;
  readonly intervalMilliseconds: number;
  readonly outputPath: string;
  readonly phasePath: string;
  readonly processId: number;
  readonly readyPath: string;
  readonly rssPeakDiagnostics?: true;
  readonly stopPath: string;
  readonly temporaryRoot: string;
}

const samplerMain = Effect.gen(function* () {
  const system = yield* SystemInfo;
  const options = parseCodeGraphBenchmarkSamplerArguments(system.processArguments.slice(2));
  const diagnosticRun = createRssDiagnosticRun(options.rssPeakDiagnostics === true);
  const diagnosticTokenizer = diagnosticRun?.tokenize;
  const diagnosticOffset = diagnosticRun?.offsetMicroseconds;
  let rssPeakDiagnostic: BenchmarkRssPeakDiagnostic | undefined;
  const canonicalTemporaryRoot = yield* canonicalDirectory(options.temporaryRoot);
  const clockTicksPerSecond = yield* linuxClockTicksPerSecond();
  const processSampleIntervalMilliseconds = system.platform === 'darwin' ? 250 : options.intervalMilliseconds;
  const openFileSampleIntervalMilliseconds =
    system.platform === 'darwin' ? DARWIN_OPEN_FILE_SAMPLE_INTERVAL_MILLISECONDS : options.intervalMilliseconds;
  const initialUnfilteredProcessSample = yield* readProcessTreeSample(
    options.processId,
    clockTicksPerSecond,
    [],
    diagnosticTokenizer,
  );
  const samplerProcessTreeExclusions = benchmarkSamplerProcessTreeExclusions(
    initialUnfilteredProcessSample,
    system.processId,
  );
  const initialProcessSample =
    samplerProcessTreeExclusions.length === 0
      ? initialUnfilteredProcessSample
      : yield* readProcessTreeSample(
          options.processId,
          clockTicksPerSecond,
          samplerProcessTreeExclusions,
          diagnosticTokenizer,
        );
  const processTelemetry = samplerProcessTelemetryContract(
    system.platform,
    initialProcessSample?.rootStartIdentity,
    processSampleIntervalMilliseconds,
  );
  const parentStartIdentity = initialProcessSample?.rootStartIdentity;
  const initialTemporaryOpenFiles = initialProcessSample
    ? yield* readOpenTemporaryFileSnapshot(initialProcessSample.processIds, canonicalTemporaryRoot)
    : undefined;
  const temporaryTelemetry = samplerTemporaryTelemetryContract(
    system.platform,
    initialTemporaryOpenFiles,
    openFileSampleIntervalMilliseconds,
  );
  const phases = new Map<string, MutablePhase>();
  let previousProcessSample = processTelemetry.availability === 'available' ? initialProcessSample : undefined;
  let pendingInitialProcessSample = previousProcessSample;
  let pendingInitialTemporaryOpenFiles =
    temporaryTelemetry.availability === 'available' ? initialTemporaryOpenFiles : undefined;
  let lastProcessSampleAt = yield* Clock.currentTimeMillis;
  let lastSuccessfulProcessSampleAt = lastProcessSampleAt;
  let lastTemporaryOpenSampleAt = lastProcessSampleAt;
  let samples = 0;
  let lastCheckpointAt = 0;
  let readyPublished = false;
  let stopped: boolean;
  let stopState: CodeGraphBenchmarkSamplerCheckpoint['state'];
  do {
    const diagnosticStartedAt = diagnosticOffset?.();
    const cachedInitial = pendingInitialProcessSample !== undefined;
    const phase =
      Effect2.pipe(yield* readText(options.phasePath), value =>
        value === undefined ? undefined : EffectString.trim(value),
      ) || 'unknown';
    const sampleStartedAt = yield* Clock.currentTimeMillis;
    const processSampleDue =
      pendingInitialProcessSample !== undefined ||
      sampleStartedAt - lastProcessSampleAt >= processSampleIntervalMilliseconds;
    const temporaryOpenSampleDue =
      pendingInitialTemporaryOpenFiles !== undefined ||
      sampleStartedAt - lastTemporaryOpenSampleAt >= openFileSampleIntervalMilliseconds;
    const [databaseBytes, walBytes, shmBytes, journalBytes, temporaryLinkedFiles, observedProcessSample] =
      yield* Effect.all(
        [
          fileBytes(options.databasePath),
          fileBytes(`${options.databasePath}-wal`),
          fileBytes(`${options.databasePath}-shm`),
          fileBytes(`${options.databasePath}-journal`),
          directoryFileSnapshot(canonicalTemporaryRoot),
          processSampleDue
            ? pendingInitialProcessSample !== undefined
              ? Effect.succeed(pendingInitialProcessSample)
              : readProcessTreeSample(
                  options.processId,
                  clockTicksPerSecond,
                  samplerProcessTreeExclusions,
                  diagnosticTokenizer,
                )
            : Effect.void,
        ],
        {concurrency: 'unbounded'},
      );
    const processSample = processSampleDue ? observedProcessSample : undefined;
    if (processSampleDue) {
      pendingInitialProcessSample = undefined;
      lastProcessSampleAt = yield* Clock.currentTimeMillis;
    }
    const processForOpenSample = processSample ?? previousProcessSample;
    const temporaryOpenFiles =
      temporaryTelemetry.availability === 'available' && temporaryOpenSampleDue
        ? pendingInitialTemporaryOpenFiles !== undefined
          ? pendingInitialTemporaryOpenFiles
          : processForOpenSample
            ? yield* readOpenTemporaryFileSnapshot(processForOpenSample.processIds, canonicalTemporaryRoot)
            : undefined
        : undefined;
    if (temporaryOpenSampleDue) {
      pendingInitialTemporaryOpenFiles = undefined;
      lastTemporaryOpenSampleAt = yield* Clock.currentTimeMillis;
    }
    const phaseAfter =
      diagnosticOffset !== undefined && processSampleDue && !cachedInitial
        ? Effect2.pipe(yield* readText(options.phasePath), effectOptionalString2 =>
            effectOptionalString2 == null ? undefined : Effect2.pipe(effectOptionalString2, EffectString.trim),
          )
        : undefined;
    const acquisition =
      diagnosticOffset !== undefined && processSampleDue && !cachedInitial
        ? rssDiagnosticAcquisition(diagnosticStartedAt!, diagnosticOffset(), phase, phaseAfter)
        : undefined;
    const temporaryBytes = mergeTemporaryFileSnapshots(temporaryLinkedFiles, temporaryOpenFiles).bytes;
    const parentExists = system.isProcessRunning(options.processId);
    const parentExited = samplerParentExited(parentStartIdentity, processSample?.rootStartIdentity, parentExists);
    const telemetrySample = processTelemetry.availability === 'available' && !parentExited ? processSample : undefined;
    if (diagnosticTokenizer !== undefined) {
      rssPeakDiagnostic = recordRssPeakDiagnostic(
        rssPeakDiagnostic,
        telemetrySample ?? undefined,
        cachedInitial ? {provenance: 'cached-initial-unknown'} : acquisition,
      );
    }
    const current = phases.get(phase) ?? {
      cpuMilliseconds: 0,
      databasePeakBytes: 0,
      ioReadBytes: 0,
      ioWriteBytes: 0,
      journalPeakBytes: 0,
      processPeakCount: 0,
      processSampleAttempts: 0,
      processSampleFailures: 0,
      processSampleGapPeakMilliseconds: 0,
      processSamples: 0,
      rssPeakBytes: 0,
      samples: 0,
      shmPeakBytes: 0,
      temporaryLinkedPeakBytes: 0,
      temporaryOpenAttempts: 0,
      temporaryOpenFailures: 0,
      temporaryOpenPeakBytes: 0,
      temporaryOpenSamples: 0,
      temporaryPeakBytes: 0,
      walPeakBytes: 0,
    };
    current.databasePeakBytes = Math.max(current.databasePeakBytes, databaseBytes);
    current.journalPeakBytes = Math.max(current.journalPeakBytes, journalBytes);
    current.walPeakBytes = Math.max(current.walPeakBytes, walBytes);
    current.shmPeakBytes = Math.max(current.shmPeakBytes, shmBytes);
    current.temporaryLinkedPeakBytes = Math.max(current.temporaryLinkedPeakBytes, temporaryLinkedFiles.bytes);
    if (temporaryTelemetry.availability === 'available' && temporaryOpenSampleDue) {
      const inspection = observeTemporaryOpenInspection(current, temporaryOpenFiles);
      current.temporaryOpenAttempts = inspection.attempts;
      current.temporaryOpenFailures = inspection.failures;
      current.temporaryOpenPeakBytes = inspection.peakBytes;
      current.temporaryOpenSamples = inspection.samples;
    }
    current.temporaryPeakBytes = Math.max(current.temporaryPeakBytes, temporaryBytes);
    if (processTelemetry.availability === 'available' && processSampleDue) {
      const observedAt = yield* Clock.currentTimeMillis;
      current.processSampleAttempts += 1;
      current.processSampleGapPeakMilliseconds = Math.max(
        current.processSampleGapPeakMilliseconds,
        observedAt - lastSuccessfulProcessSampleAt,
      );
      if (telemetrySample === undefined) current.processSampleFailures += 1;
      else lastSuccessfulProcessSampleAt = observedAt;
    }
    if (telemetrySample) {
      const delta = processTreeDelta(previousProcessSample, telemetrySample);
      current.cpuMilliseconds += delta.cpuMilliseconds;
      current.ioReadBytes = safeAdd(current.ioReadBytes, delta.ioReadBytes);
      current.ioWriteBytes = safeAdd(current.ioWriteBytes, delta.ioWriteBytes);
      current.processPeakCount = Math.max(current.processPeakCount, telemetrySample.processes.size);
      current.processSamples += 1;
      current.rssPeakBytes = Math.max(current.rssPeakBytes, telemetrySample.rssBytes);
      previousProcessSample = telemetrySample;
    }
    current.samples += 1;
    samples += 1;
    phases.set(phase, current);
    const requestedStop = yield* readText(options.stopPath);
    stopped = requestedStop !== undefined || parentExited;
    stopState =
      requestedStop !== undefined ? parseStopState(requestedStop) : parentExited ? 'parent-exited' : 'running';
    const now = yield* Clock.currentTimeMillis;
    if (stopped || samples === 1 || now - lastCheckpointAt >= options.checkpointIntervalMilliseconds) {
      yield* writeCheckpoint(
        options.checkpointPath,
        samplerArtifact(
          options.intervalMilliseconds,
          phases,
          system.platform,
          processTelemetry,
          temporaryTelemetry,
          samples,
          rssPeakDiagnostic,
        ),
        stopState,
      );
      if (!readyPublished) {
        yield* atomicWriteFile(options.readyPath, '{"checkpointVersion":4,"version":1}\n');
        readyPublished = true;
      }
      lastCheckpointAt = now;
    }
    if (!stopped) yield* Effect.sleep(options.intervalMilliseconds);
  } while (!stopped);

  const artifact = samplerArtifact(
    options.intervalMilliseconds,
    phases,
    system.platform,
    processTelemetry,
    temporaryTelemetry,
    samples,
    rssPeakDiagnostic,
  );
  yield* atomicWriteFile(options.outputPath, `${JSON.stringify(artifact)}\n`);
});

export function samplerArtifact(
  intervalMilliseconds: number,
  phases: ReadonlyMap<string, MutablePhase>,
  platform: string,
  processTelemetry: CodeGraphBenchmarkSamplerProcessTelemetry,
  temporaryTelemetry: CodeGraphBenchmarkSamplerTemporaryTelemetry,
  samples: number,
  rssPeakDiagnostic?: BenchmarkRssPeakDiagnostic,
): CodeGraphBenchmarkSamplerArtifact {
  return {
    intervalMilliseconds,
    phases: EffectRecord.fromEntries(
      EffectArray.map(
        [...phases.entries()].sort(([left], [right]) => Effect2.pipe(left, EffectString.localeCompare(right))),
        ([phase, value]) => {
          const process =
            processTelemetry.availability === 'available'
              ? {
                  cpuMilliseconds: value.cpuMilliseconds,
                  ...(processTelemetry.source === 'linux-proc'
                    ? {ioReadBytes: value.ioReadBytes, ioWriteBytes: value.ioWriteBytes}
                    : {}),
                  processPeakCount: value.processPeakCount,
                  processSampleAttempts: value.processSampleAttempts,
                  processSampleFailures: value.processSampleFailures,
                  processSampleGapPeakMilliseconds: value.processSampleGapPeakMilliseconds,
                  processSamples: value.processSamples,
                  rssPeakBytes: value.rssPeakBytes,
                }
              : {};
          const temporary =
            temporaryTelemetry.availability === 'available'
              ? {
                  temporaryLinkedPeakBytes: value.temporaryLinkedPeakBytes,
                  temporaryOpenAttempts: value.temporaryOpenAttempts,
                  temporaryOpenFailures: value.temporaryOpenFailures,
                  temporaryOpenPeakBytes: value.temporaryOpenPeakBytes,
                  temporaryOpenSamples: value.temporaryOpenSamples,
                }
              : {temporaryLinkedPeakBytes: value.temporaryLinkedPeakBytes};
          return [
            phase,
            {
              ...process,
              ...temporary,
              databasePeakBytes: value.databasePeakBytes,
              journalPeakBytes: value.journalPeakBytes,
              samples: value.samples,
              shmPeakBytes: value.shmPeakBytes,
              temporaryPeakBytes: value.temporaryPeakBytes,
              walPeakBytes: value.walPeakBytes,
            },
          ];
        },
      ),
    ),
    platform,
    processTelemetry,
    samples,
    temporaryTelemetry,
    version: 4,
    ...(rssPeakDiagnostic === undefined ? {} : {rssPeakDiagnostic}),
  };
}

const writeCheckpoint = Effect.fn('codeGraphBenchmarkSampler.writeCheckpoint')(function* (
  checkpointPath: string,
  sampler: CodeGraphBenchmarkSamplerArtifact,
  state: CodeGraphBenchmarkSamplerCheckpoint['state'],
) {
  const checkpoint: CodeGraphBenchmarkSamplerCheckpoint = {
    sampler,
    state,
    updatedAt: DateTime.formatIso(yield* DateTime.now),
    version: sampler.version,
  };
  yield* atomicWriteFile(checkpointPath, `${JSON.stringify(checkpoint)}\n`);
});

const atomicWriteFile = Effect.fn('codeGraphBenchmarkSampler.atomicWriteFile')(function* (
  outputPath: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  yield* fs.makeDirectory(hostPath.dirname(outputPath), {recursive: true, mode: 0o700});
  const temporaryPath = `${outputPath}.${system.processId}.tmp`;
  yield* fs.writeFileString(temporaryPath, contents, {mode: 0o600});
  yield* fs.rename(temporaryPath, outputPath);
});

function parseStopState(value: string): 'aborted' | 'complete' {
  return Effect2.pipe(value, EffectString.trim) === 'complete' ? 'complete' : 'aborted';
}

export interface BenchmarkProcessTreeEntry {
  readonly cpuMilliseconds: number;
  readonly ioReadBytes?: number;
  readonly ioWriteBytes?: number;
  readonly parentProcessId: number;
  readonly processId: number;
  readonly rssBytes: number;
  readonly startIdentity: string;
}

interface BenchmarkProcessCounters {
  readonly cpuMilliseconds: number;
  readonly ioReadBytes?: number;
  readonly ioWriteBytes?: number;
}

export interface BenchmarkProcessTreeSample {
  readonly processIds: readonly number[];
  readonly processes: ReadonlyMap<string, BenchmarkProcessCounters>;
  /** Current RSS of the observed root alone, excluding every descendant. */
  readonly rootRssBytes: number;
  readonly rootStartIdentity: string;
  readonly rssBytes: number;
  readonly rssContributors?: BenchmarkRssContributors;
}

export interface BenchmarkProcessTreeDelta {
  readonly cpuMilliseconds: number;
  readonly ioReadBytes: number;
  readonly ioWriteBytes: number;
}

/** Exclude sampler instrumentation only when it is actually inside the observed process tree. */
export function benchmarkSamplerProcessTreeExclusions(
  initialSample: BenchmarkProcessTreeSample | undefined,
  samplerProcessId: number,
): readonly number[] {
  return initialSample?.processIds.includes(samplerProcessId) ? [samplerProcessId] : [];
}

/**
 * Aggregate one root while removing complete instrumentation subtrees. Every
 * excluded PID must be a unique strict descendant in this same snapshot;
 * otherwise no sample is returned.
 */
export function aggregateProcessTree(
  entries: readonly BenchmarkProcessTreeEntry[],
  rootProcessId: number,
  expectedRootStartIdentity?: string,
  excludedDescendantRootProcessIds: readonly number[] = [],
  diagnosticTokenizer?: RssDiagnosticTokenizer,
): BenchmarkProcessTreeSample | undefined {
  if (
    EffectArray.some(
      excludedDescendantRootProcessIds,
      processId => !Number.isSafeInteger(processId) || processId <= 0,
    ) ||
    new Set(excludedDescendantRootProcessIds).size !== excludedDescendantRootProcessIds.length ||
    excludedDescendantRootProcessIds.includes(rootProcessId)
  ) {
    return undefined;
  }
  const byProcessId = new Map<number, BenchmarkProcessTreeEntry>();
  for (const entry of entries) {
    if (
      !Number.isSafeInteger(entry.processId) ||
      entry.processId <= 0 ||
      !Number.isSafeInteger(entry.parentProcessId) ||
      entry.parentProcessId < 0 ||
      byProcessId.has(entry.processId) ||
      !entry.startIdentity ||
      !Number.isFinite(entry.cpuMilliseconds) ||
      entry.cpuMilliseconds < 0 ||
      !Number.isSafeInteger(entry.rssBytes) ||
      entry.rssBytes < 0 ||
      !optionalNonNegativeSafeInteger(entry.ioReadBytes) ||
      !optionalNonNegativeSafeInteger(entry.ioWriteBytes)
    ) {
      return undefined;
    }
    byProcessId.set(entry.processId, entry);
  }
  const root = byProcessId.get(rootProcessId);
  if (!root || (expectedRootStartIdentity !== undefined && root.startIdentity !== expectedRootStartIdentity)) {
    return undefined;
  }
  const children = new Map<number, number[]>();
  for (const entry of entries) {
    const siblings = children.get(entry.parentProcessId) ?? [];
    siblings.push(entry.processId);
    children.set(entry.parentProcessId, siblings);
  }
  const reachableProcessIds = new Set<number>();
  const reachablePending = [rootProcessId];
  while (reachablePending.length > 0) {
    const processId = reachablePending.shift();
    if (processId === undefined || reachableProcessIds.has(processId)) continue;
    reachableProcessIds.add(processId);
    reachablePending.push(...(children.get(processId) ?? []));
  }
  if (EffectArray.some(excludedDescendantRootProcessIds, processId => !reachableProcessIds.has(processId)))
    return undefined;
  const excludedDescendantRoots = new Set(excludedDescendantRootProcessIds);
  const pending = [rootProcessId];
  const visited = new Set<number>();
  const processes = new Map<string, BenchmarkProcessCounters>();
  let rssBytes = 0;
  const contributors: BenchmarkRssContributor[] | undefined = diagnosticTokenizer === undefined ? undefined : [];
  let admittedAccountingComplete = true;
  while (pending.length > 0) {
    const processId = pending.shift();
    if (processId === undefined || visited.has(processId)) continue;
    if (excludedDescendantRoots.has(processId)) continue;
    visited.add(processId);
    const entry = byProcessId.get(processId);
    if (!entry) continue;
    processes.set(`${entry.processId}:${entry.startIdentity}`, {
      cpuMilliseconds: entry.cpuMilliseconds,
      ioReadBytes: entry.ioReadBytes,
      ioWriteBytes: entry.ioWriteBytes,
    });
    if (contributors !== undefined && diagnosticTokenizer !== undefined) {
      if (entry.rssBytes > Number.MAX_SAFE_INTEGER - rssBytes) admittedAccountingComplete = false;
      const parent = byProcessId.get(entry.parentProcessId);
      const contributor: BenchmarkRssContributor = {
        token: diagnosticTokenizer(entry.processId, entry.startIdentity),
        parentToken:
          entry.processId === rootProcessId ? null : diagnosticTokenizer(parent!.processId, parent!.startIdentity),
        role: entry.processId === rootProcessId ? 'root' : 'descendant',
        rssBytes: entry.rssBytes,
      };
      const index = Option.getOrElse(
        EffectArray.findFirstIndex(contributors, current => compareRssContributors(contributor, current) < 0),
        () => -1,
      );
      if (index !== -1) {
        if (contributors.length === 16) contributors.pop();
        contributors.splice(index, 0, contributor);
      } else if (contributors.length < 16) contributors.push(contributor);
    }
    rssBytes = safeAdd(rssBytes, entry.rssBytes);
    pending.push(...(children.get(processId) ?? []));
  }
  return {
    processIds: [...visited],
    processes,
    rootRssBytes: root.rssBytes,
    rootStartIdentity: root.startIdentity,
    rssBytes,
    ...(contributors === undefined
      ? {}
      : {
          rssContributors: {
            admittedAccountingComplete,
            contributors,
            omittedProcessCount: processes.size - contributors.length,
            omittedRssBytes: admittedAccountingComplete
              ? rssBytes - EffectArray.reduce(contributors, 0, (total, contributor) => total + contributor.rssBytes)
              : null,
            processCount: processes.size,
            rssBytes,
          },
        }),
  };
}

export function processTreeDelta(
  previous: BenchmarkProcessTreeSample | undefined,
  current: BenchmarkProcessTreeSample,
): BenchmarkProcessTreeDelta {
  let cpuMilliseconds = 0;
  let ioReadBytes = 0;
  let ioWriteBytes = 0;
  for (const [identity, counters] of current.processes) {
    const before = previous?.processes.get(identity);
    const beforeCpuMilliseconds = before?.cpuMilliseconds ?? (previous === undefined ? counters.cpuMilliseconds : 0);
    cpuMilliseconds = Math.min(
      Number.MAX_SAFE_INTEGER,
      cpuMilliseconds + Math.max(0, counters.cpuMilliseconds - beforeCpuMilliseconds),
    );
    if (counters.ioReadBytes !== undefined) {
      const beforeReadBytes = before?.ioReadBytes ?? (previous === undefined ? counters.ioReadBytes : 0);
      ioReadBytes = safeAdd(ioReadBytes, Math.max(0, counters.ioReadBytes - beforeReadBytes));
    }
    if (counters.ioWriteBytes !== undefined) {
      const beforeWriteBytes = before?.ioWriteBytes ?? (previous === undefined ? counters.ioWriteBytes : 0);
      ioWriteBytes = safeAdd(ioWriteBytes, Math.max(0, counters.ioWriteBytes - beforeWriteBytes));
    }
  }
  return {cpuMilliseconds, ioReadBytes, ioWriteBytes};
}

export const readProcessTreeSample = Effect.fn('codeGraphBenchmarkSampler.readProcessTreeSample')(function* (
  processId: number,
  clockTicksPerSecond: number,
  excludedDescendantRootProcessIds: readonly number[] = [],
  diagnosticTokenizer?: RssDiagnosticTokenizer,
) {
  const system = yield* SystemInfo;
  if (system.platform === 'linux') {
    return yield* readLinuxProcessTreeSample(
      processId,
      clockTicksPerSecond,
      excludedDescendantRootProcessIds,
      diagnosticTokenizer,
    );
  }
  if (system.platform === 'darwin') {
    return yield* readDarwinProcessTreeSample(processId, excludedDescendantRootProcessIds, diagnosticTokenizer);
  }
  return undefined;
});

const readLinuxProcessTreeSample = Effect.fn('codeGraphBenchmarkSampler.readLinuxProcessTreeSample')(function* (
  rootProcessId: number,
  clockTicksPerSecond: number,
  excludedDescendantRootProcessIds: readonly number[],
  diagnosticTokenizer?: RssDiagnosticTokenizer,
) {
  const pending: Array<{readonly expectedParent?: number; readonly processId: number}> = [{processId: rootProcessId}];
  const entries: BenchmarkProcessTreeEntry[] = [];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const next = pending.shift();
    if (!next || visited.has(next.processId)) continue;
    visited.add(next.processId);
    const observed = yield* readLinuxProcessEntry(next.processId, clockTicksPerSecond);
    if (!observed || (next.expectedParent !== undefined && observed.entry.parentProcessId !== next.expectedParent)) {
      continue;
    }
    entries.push(observed.entry);
    pending.push(
      ...EffectArray.map(observed.childProcessIds, processId => ({
        expectedParent: observed.entry.processId,
        processId,
      })),
    );
  }
  return aggregateProcessTree(entries, rootProcessId, undefined, excludedDescendantRootProcessIds, diagnosticTokenizer);
});

const readLinuxProcessEntry = Effect.fn('codeGraphBenchmarkSampler.readLinuxProcessEntry')(function* (
  processId: number,
  clockTicksPerSecond: number,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.gen(function* () {
    const firstStatText = yield* fs.readFileString(`/proc/${processId}/stat`);
    const firstStat = parseLinuxProcessStat(firstStatText);
    if (!firstStat) return undefined;
    const [statusText, ioText, childrenText, validatedStatText] = yield* Effect.all(
      [
        fs.readFileString(`/proc/${processId}/status`),
        readText(`/proc/${processId}/io`),
        readText(`/proc/${processId}/task/${processId}/children`),
        fs.readFileString(`/proc/${processId}/stat`),
      ],
      {concurrency: 'unbounded'},
    );
    const validatedStat = parseLinuxProcessStat(validatedStatText);
    if (!validatedStat || validatedStat.startIdentity !== firstStat.startIdentity) return undefined;
    const rssMatch = /^VmRSS:\s+(\d+)\s+kB$/m.exec(statusText);
    const rssKilobytes = Number(rssMatch?.[1]);
    if (!rssMatch || !Number.isSafeInteger(rssKilobytes) || rssKilobytes < 0) return undefined;
    const io = ioText === undefined ? undefined : parseLinuxProcessIo(ioText);
    return {
      childProcessIds: parseLinuxChildProcessIds(childrenText ?? ''),
      entry: {
        cpuMilliseconds: ((validatedStat.userTicks + validatedStat.systemTicks) * 1_000) / clockTicksPerSecond,
        ioReadBytes: io?.readBytes,
        ioWriteBytes: io?.writeBytes,
        parentProcessId: validatedStat.parentProcessId,
        processId,
        rssBytes: rssKilobytes * 1024,
        startIdentity: validatedStat.startIdentity,
      },
    };
  }).pipe(Effect.option, Effect.map(Option.getOrUndefined));
});

function parseLinuxChildProcessIds(text: string): readonly number[] {
  return EffectArray.filter(
    EffectArray.map(
      EffectArray.filter(Effect2.pipe(text, EffectString.trim, EffectString.split(/\s+/)), Boolean),
      Number,
    ),
    candidate => Number.isSafeInteger(candidate) && candidate > 0,
  );
}

export function parseLinuxProcessIo(
  ioText: string,
): {readonly readBytes: number; readonly writeBytes: number} | undefined {
  const readBytes = Number(/^read_bytes:\s+(\d+)$/m.exec(ioText)?.[1]);
  const writeBytes = Number(/^write_bytes:\s+(\d+)$/m.exec(ioText)?.[1]);
  if (!Number.isSafeInteger(readBytes) || readBytes < 0 || !Number.isSafeInteger(writeBytes) || writeBytes < 0) {
    return undefined;
  }
  return {readBytes, writeBytes};
}

const readDarwinProcessTreeSample = Effect.fn('codeGraphBenchmarkSampler.readDarwinProcessTreeSample')(function* (
  rootProcessId: number,
  excludedDescendantRootProcessIds: readonly number[],
  diagnosticTokenizer?: RssDiagnosticTokenizer,
) {
  return yield* Effect.try({
    try: () => {
      const result = Bun.spawnSync({
        cmd: ['/bin/ps', '-axo', 'pid=,ppid=,lstart=,time=,rss='],
        env: {LC_ALL: 'C'},
        stderr: 'ignore',
      });
      if (result.exitCode !== 0) return undefined;
      return aggregateProcessTree(
        parseDarwinProcessList(new TextDecoder().decode(result.stdout)),
        rootProcessId,
        undefined,
        excludedDescendantRootProcessIds,
        diagnosticTokenizer,
      );
    },
    catch: scriptError,
  }).pipe(Effect.option, Effect.map(Option.getOrUndefined));
});

export function parseDarwinProcessList(output: string): readonly BenchmarkProcessTreeEntry[] {
  return EffectArray.filter(
    EffectArray.map(Effect2.pipe(output, EffectString.split(/\r?\n/)), parseDarwinProcessLine),
    (entry): entry is BenchmarkProcessTreeEntry => entry !== undefined,
  );
}

function parseDarwinProcessLine(line: string): BenchmarkProcessTreeEntry | undefined {
  const fields = Effect2.pipe(line, EffectString.trim, EffectString.split(/\s+/));
  if (fields.length !== 9) return undefined;
  const processId = Number(fields[0]);
  const parentProcessId = Number(fields[1]);
  const cpuMilliseconds = parseProcessCpuTime(fields[7] ?? '');
  const rssKilobytes = Number(fields[8]);
  const startIdentity = EffectArray.join(fields.slice(2, 7), ' ');
  if (
    !Number.isSafeInteger(processId) ||
    processId <= 0 ||
    !Number.isSafeInteger(parentProcessId) ||
    parentProcessId < 0 ||
    cpuMilliseconds === undefined ||
    !Number.isSafeInteger(rssKilobytes) ||
    rssKilobytes < 0 ||
    !/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(startIdentity)
  ) {
    return undefined;
  }
  return {cpuMilliseconds, parentProcessId, processId, rssBytes: rssKilobytes * 1024, startIdentity};
}

export function parseProcessCpuTime(value: string): number | undefined {
  const [dayText, clockText] = Effect2.pipe(value, EffectString.includes('-'))
    ? // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
      value.split('-', 2)
    : [undefined, value];
  const parts =
    Effect2.pipe(clockText, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.split(':')),
    ) ?? [];
  if (parts.length !== 2 && parts.length !== 3) return undefined;
  const days = dayText === undefined ? 0 : Number(dayText);
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  const minutes = Number(parts.at(-2));
  const seconds = Number(parts.at(-1));
  if (
    (dayText !== undefined && parts.length !== 3) ||
    !Number.isSafeInteger(days) ||
    days < 0 ||
    !Number.isSafeInteger(hours) ||
    hours < 0 ||
    !Number.isSafeInteger(minutes) ||
    minutes < 0 ||
    (parts.length === 3 && minutes >= 60) ||
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    seconds >= 60
  ) {
    return undefined;
  }
  const milliseconds = Math.round((((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1_000);
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

export function parseLinuxProcessStat(statText: string):
  | {
      readonly parentProcessId: number;
      readonly startIdentity: string;
      readonly systemTicks: number;
      readonly userTicks: number;
    }
  | undefined {
  const closing = Effect2.pipe(
    statText,
    EffectString.lastIndexOf(')'),
    Effect2.Option.getOrElse(() => -1),
  );
  if (closing < 0) return undefined;
  const fields = Effect2.pipe(statText, EffectString.slice(closing + 2), EffectString.trim, EffectString.split(/\s+/));
  const userTicksText = fields[11];
  const systemTicksText = fields[12];
  const startIdentity = fields[19];
  const parentProcessIdText = fields[1];
  if (
    parentProcessIdText === undefined ||
    !/^\d+$/.test(parentProcessIdText) ||
    userTicksText === undefined ||
    !/^\d+$/.test(userTicksText) ||
    systemTicksText === undefined ||
    !/^\d+$/.test(systemTicksText) ||
    startIdentity === undefined ||
    !/^\d+$/.test(startIdentity)
  ) {
    return undefined;
  }
  const userTicks = Number(userTicksText);
  const systemTicks = Number(systemTicksText);
  const parentProcessId = Number(parentProcessIdText);
  if (
    !Number.isSafeInteger(parentProcessId) ||
    !Number.isSafeInteger(userTicks) ||
    !Number.isSafeInteger(systemTicks)
  ) {
    return undefined;
  }
  return {parentProcessId, startIdentity, systemTicks, userTicks};
}

export function samplerProcessTelemetryContract(
  platform: string,
  parentStartIdentity: string | undefined,
  sampleIntervalMilliseconds = 25,
): CodeGraphBenchmarkSamplerProcessTelemetry {
  if (platform === 'linux' && parentStartIdentity !== undefined) {
    return {
      availability: 'available',
      ioCounters: 'linux-proc-read-write-bytes',
      parentIdentityValidation: 'linux-proc-starttime',
      sampleIntervalMilliseconds,
      scope: 'recursive-process-tree',
      source: 'linux-proc',
    };
  }
  if (platform === 'darwin' && parentStartIdentity !== undefined) {
    return {
      availability: 'available',
      parentIdentityValidation: 'darwin-ps-lstart',
      sampleIntervalMilliseconds,
      scope: 'recursive-process-tree',
      source: 'darwin-ps',
    };
  }
  return {
    availability: 'unavailable',
    parentIdentityValidation: 'process-liveness-only',
    reason: platform === 'linux' || platform === 'darwin' ? 'parent-inspection-unavailable' : 'unsupported-platform',
    source: 'none',
  };
}

export interface BenchmarkTemporaryFileSnapshot {
  readonly bytes: number;
  readonly files: ReadonlyMap<string, number>;
}

export interface BenchmarkTemporaryOpenInspection {
  readonly attempts: number;
  readonly failures: number;
  readonly peakBytes: number;
  readonly samples: number;
}

/** Records every scheduled inspection so missing/capped observations cannot silently pass release evidence. */
export function observeTemporaryOpenInspection(
  previous: {
    readonly temporaryOpenAttempts: number;
    readonly temporaryOpenFailures: number;
    readonly temporaryOpenPeakBytes: number;
    readonly temporaryOpenSamples: number;
  },
  observed: BenchmarkTemporaryFileSnapshot | undefined,
): BenchmarkTemporaryOpenInspection {
  return {
    attempts: previous.temporaryOpenAttempts + 1,
    failures: previous.temporaryOpenFailures + (observed === undefined ? 1 : 0),
    peakBytes: Math.max(previous.temporaryOpenPeakBytes, observed?.bytes ?? 0),
    samples: previous.temporaryOpenSamples + (observed === undefined ? 0 : 1),
  };
}

export function samplerTemporaryTelemetryContract(
  platform: string,
  initialOpenFiles: BenchmarkTemporaryFileSnapshot | undefined,
  sampleIntervalMilliseconds = 25,
): CodeGraphBenchmarkSamplerTemporaryTelemetry {
  if ((platform === 'linux' || platform === 'darwin') && initialOpenFiles !== undefined) {
    return {
      availability: 'available',
      maximumOpenFileDescriptors: MAX_OPEN_FILE_DESCRIPTORS,
      maximumProcesses: MAX_OPEN_FILE_PROCESSES,
      openFileSampleIntervalMilliseconds: sampleIntervalMilliseconds,
      ...(platform === 'darwin' ? {projectionByteLimit: MAX_DARWIN_LSOF_BYTES} : {}),
      scope: 'temporary-root-linked-plus-process-tree-open-files',
      source: platform === 'linux' ? 'linux-proc-fd' : 'darwin-lsof',
    };
  }
  return {
    availability: 'unavailable',
    reason: platform === 'linux' || platform === 'darwin' ? 'open-file-inspection-unavailable' : 'unsupported-platform',
    scope: 'temporary-root-linked-files-only',
    source: 'directory-walk',
  };
}

export function mergeTemporaryFileSnapshots(
  linked: BenchmarkTemporaryFileSnapshot,
  open: BenchmarkTemporaryFileSnapshot | undefined,
): BenchmarkTemporaryFileSnapshot {
  if (open === undefined) return linked;
  const files = new Map(linked.files);
  for (const [identity, bytes] of open.files) files.set(identity, Math.max(files.get(identity) ?? 0, bytes));
  return temporaryFileSnapshot(files);
}

export function isOpenTemporaryFilePath(target: string, canonicalTemporaryRoot: string): boolean {
  const withoutDeletedMarker = Effect2.pipe(target, EffectString.endsWith(' (deleted)'))
    ? Effect2.pipe(target, EffectString.slice(0, -' (deleted)'.length))
    : target;
  if (!hostPath.isAbsolute(withoutDeletedMarker)) return false;
  const candidate = hostPath.resolve(withoutDeletedMarker);
  const relativePath = hostPath.relative(canonicalTemporaryRoot, candidate);
  const belongsToTemporaryRoot =
    relativePath === '' ||
    (relativePath !== '..' &&
      !Effect2.pipe(relativePath, EffectString.startsWith(`..${hostPath.sep}`)) &&
      !hostPath.isAbsolute(relativePath));
  return belongsToTemporaryRoot || /^etilqs_[a-z0-9]+$/i.test(hostPath.basename(candidate));
}

export function parseDarwinOpenFileList(
  output: string,
  processIds: readonly number[],
  rootProcessId: number,
  canonicalTemporaryRoot: string,
): BenchmarkTemporaryFileSnapshot | undefined {
  const expectedProcessIds = new Set(processIds);
  const files = new Map<string, number>();
  let descriptorCount = 0;
  let currentProcessId: number | undefined;
  let observedRoot = false;
  let currentFile:
    | {
        device?: string;
        inode?: string;
        name?: string;
        size?: string;
        type?: string;
      }
    | undefined;
  const finishFile = () => {
    if (
      currentProcessId === undefined ||
      !expectedProcessIds.has(currentProcessId) ||
      currentFile?.type !== 'REG' ||
      currentFile.name === undefined ||
      !isOpenTemporaryFilePath(currentFile.name, canonicalTemporaryRoot)
    ) {
      currentFile = undefined;
      return;
    }
    const size = parseSafeByteCount(currentFile.size);
    const device = parseDarwinDevice(currentFile.device);
    const inode = currentFile.inode;
    if (size === undefined || device === undefined || inode === undefined || !/^\d+$/.test(inode)) {
      currentFile = undefined;
      return;
    }
    const identity = `${device}:${inode}`;
    files.set(identity, Math.max(files.get(identity) ?? 0, size));
    currentFile = undefined;
  };
  for (const rawField of Effect2.pipe(output, EffectString.split('\0'))) {
    const field = Effect2.pipe(rawField, EffectString.replace(/^\n+/, ''));
    if (!field) continue;
    const value = Effect2.pipe(field, EffectString.slice(1));
    switch (field[0]) {
      case 'p': {
        finishFile();
        const processId = Number(value);
        currentProcessId = Number.isSafeInteger(processId) && processId > 0 ? processId : undefined;
        if (currentProcessId === rootProcessId) observedRoot = true;
        break;
      }
      case 'f':
        finishFile();
        if (currentProcessId !== undefined && expectedProcessIds.has(currentProcessId)) {
          descriptorCount += 1;
          if (descriptorCount > MAX_OPEN_FILE_DESCRIPTORS) return undefined;
        }
        currentFile = {};
        break;
      case 't':
        if (currentFile) currentFile.type = value;
        break;
      case 'D':
        if (currentFile) currentFile.device = value;
        break;
      case 's':
        if (currentFile) currentFile.size = value;
        break;
      case 'i':
        if (currentFile) currentFile.inode = value;
        break;
      case 'n':
        if (currentFile) currentFile.name = value;
        break;
    }
  }
  finishFile();
  return observedRoot ? temporaryFileSnapshot(files) : undefined;
}

const readOpenTemporaryFileSnapshot = Effect.fn('codeGraphBenchmarkSampler.readOpenTemporaryFileSnapshot')(function* (
  processIds: readonly number[],
  canonicalTemporaryRoot: string,
) {
  const system = yield* SystemInfo;
  if (system.platform === 'linux') return yield* readLinuxOpenTemporaryFiles(processIds, canonicalTemporaryRoot);
  if (system.platform === 'darwin') return yield* readDarwinOpenTemporaryFiles(processIds, canonicalTemporaryRoot);
  return undefined;
});

const readLinuxOpenTemporaryFiles = Effect.fn('codeGraphBenchmarkSampler.readLinuxOpenTemporaryFiles')(function* (
  processIds: readonly number[],
  canonicalTemporaryRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const rootProcessId = processIds[0];
  if (rootProcessId === undefined || processIds.length > MAX_OPEN_FILE_PROCESSES) return undefined;
  const descriptors: Array<{readonly descriptorPath: string; readonly processId: number}> = [];
  for (const processId of [...new Set(processIds)]) {
    const names = yield* fs.readDirectory(`/proc/${processId}/fd`).pipe(Effect.option);
    if (Option.isNone(names)) {
      if (processId === rootProcessId) return undefined;
      continue;
    }
    for (const name of names.value) {
      if (!/^\d+$/.test(name)) continue;
      if (descriptors.length >= MAX_OPEN_FILE_DESCRIPTORS) return undefined;
      descriptors.push({descriptorPath: `/proc/${processId}/fd/${name}`, processId});
    }
  }
  const files = new Map<string, number>();
  for (let offset = 0; offset < descriptors.length; offset += 32) {
    const observed = yield* Effect.forEach(
      descriptors.slice(offset, offset + 32),
      ({descriptorPath}) => readLinuxOpenTemporaryFile(descriptorPath, canonicalTemporaryRoot),
      {concurrency: 'unbounded'},
    );
    for (const file of observed) {
      if (file) files.set(file.identity, Math.max(files.get(file.identity) ?? 0, file.bytes));
    }
  }
  return temporaryFileSnapshot(files);
});

const readLinuxOpenTemporaryFile = Effect.fn('codeGraphBenchmarkSampler.readLinuxOpenTemporaryFile')(function* (
  descriptorPath: string,
  canonicalTemporaryRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.gen(function* () {
    const [target, info] = yield* Effect.all(
      [fs.readLink(descriptorPath), Effect.tryPromise({try: () => runtimeStat(descriptorPath), catch: scriptError})],
      {concurrency: 2},
    );
    if (!isOpenTemporaryFilePath(target, canonicalTemporaryRoot)) return undefined;
    return temporaryFileObservationFromStats(info);
  }).pipe(Effect.option, Effect.map(Option.getOrUndefined));
});

const readDarwinOpenTemporaryFiles = Effect.fn('codeGraphBenchmarkSampler.readDarwinOpenTemporaryFiles')(function* (
  processIds: readonly number[],
  canonicalTemporaryRoot: string,
) {
  const uniqueProcessIds = EffectArray.filter(
    [...new Set(processIds)],
    processId => Number.isSafeInteger(processId) && processId > 0,
  );
  const rootProcessId = uniqueProcessIds[0];
  if (rootProcessId === undefined || uniqueProcessIds.length > MAX_OPEN_FILE_PROCESSES) return undefined;
  return yield* Effect.try({
    try: () => {
      const result = Bun.spawnSync({
        cmd: [
          '/usr/sbin/lsof',
          '-nP',
          '-a',
          '-p',
          EffectArray.join(
            EffectArray.map(uniqueProcessIds, item => (item === null || item === undefined ? '' : String(item))),
            ',',
          ),
          '-d',
          '0-1048575',
          '-F0pftsiDn',
        ],
        env: {LC_ALL: 'C'},
        maxBuffer: MAX_DARWIN_LSOF_BYTES,
        stderr: 'ignore',
      });
      if (
        (result.signalCode !== undefined && result.signalCode !== null) ||
        ![0, 1].includes(result.exitCode) ||
        result.stdout.byteLength >= MAX_DARWIN_LSOF_BYTES
      ) {
        return undefined;
      }
      return parseDarwinOpenFileList(
        new TextDecoder().decode(result.stdout),
        uniqueProcessIds,
        rootProcessId,
        canonicalTemporaryRoot,
      );
    },
    catch: scriptError,
  }).pipe(Effect.option, Effect.map(Option.getOrUndefined));
});

function parseDarwinDevice(value: string | undefined): string | undefined {
  if (value === undefined || !/^(?:0x[0-9a-f]+|\d+)$/i.test(value)) return undefined;
  try {
    return BigInt(value).toString();
  } catch {
    return undefined;
  }
}

function parseSafeByteCount(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  try {
    return safeBigIntByteCount(BigInt(value));
  } catch {
    return undefined;
  }
}

export function temporaryFileObservationFromStats(
  info: Pick<RuntimeBigIntStats, 'dev' | 'ino' | 'isFile' | 'size'>,
): {readonly bytes: number; readonly identity: string} | undefined {
  if (!info.isFile()) return undefined;
  const bytes = safeBigIntByteCount(info.size);
  return bytes === undefined ? undefined : {bytes, identity: `${info.dev}:${info.ino}`};
}

function safeBigIntByteCount(value: bigint): number | undefined {
  return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
}

function temporaryFileSnapshot(files: ReadonlyMap<string, number>): BenchmarkTemporaryFileSnapshot {
  let bytes = 0;
  for (const size of files.values()) bytes = safeAdd(bytes, size);
  return {bytes, files};
}

function optionalNonNegativeSafeInteger(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

function safeAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

export function samplerParentExited(
  expectedStartIdentity: string | undefined,
  observedStartIdentity: string | undefined,
  processExistsNow: boolean,
): boolean {
  return (
    !processExistsNow ||
    (expectedStartIdentity !== undefined &&
      observedStartIdentity !== undefined &&
      observedStartIdentity !== expectedStartIdentity)
  );
}

export const linuxClockTicksPerSecond = Effect.fn('codeGraphBenchmarkSampler.linuxClockTicksPerSecond')(function* () {
  const system = yield* SystemInfo;
  if (system.platform !== 'linux') return 100;
  return yield* Effect.try({
    try: () => {
      const result = Bun.spawnSync({cmd: ['getconf', 'CLK_TCK'], stderr: 'ignore'});
      const value = Number(Effect2.pipe(new TextDecoder().decode(result.stdout), EffectString.trim));
      return Number.isFinite(value) && value > 0 ? value : 100;
    },
    catch: scriptError,
  }).pipe(Effect.orElseSucceed(() => 100));
});

const canonicalDirectory = Effect.fn('codeGraphBenchmarkSampler.canonicalDirectory')(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.realPath(directory).pipe(Effect.orElseSucceed(() => hostPath.resolve(directory)));
});

const directoryFileSnapshot = Effect.fn('codeGraphBenchmarkSampler.directoryFileSnapshot')(function* (
  directory: string,
) {
  const files = new Map<string, number>();
  yield* collectDirectoryFiles(directory, files);
  return temporaryFileSnapshot(files);
});

function collectDirectoryFiles(
  directory: string,
  files: Map<string, number>,
): Effect.Effect<void, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const names = yield* fs.readDirectory(directory).pipe(Effect.option);
    if (Option.isNone(names)) return;
    for (const name of names.value) {
      const child = hostPath.join(directory, name);
      const info = yield* Effect.tryPromise({try: () => runtimeLstat(child), catch: scriptError}).pipe(Effect.option);
      if (Option.isNone(info)) continue;
      if (info.value.isDirectory()) {
        yield* collectDirectoryFiles(child, files);
        continue;
      }
      const observed = temporaryFileObservationFromStats(info.value);
      if (observed) files.set(observed.identity, Math.max(files.get(observed.identity) ?? 0, observed.bytes));
    }
  });
}

const fileBytes = Effect.fn('codeGraphBenchmarkSampler.fileBytes')(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(file).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== 'File') return 0;
  return safeBigIntByteCount(info.value.size) ?? 0;
});

const readText = Effect.fn('codeGraphBenchmarkSampler.readText')(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(Effect.option, Effect.map(Option.getOrUndefined));
});

export function parseCodeGraphBenchmarkSamplerArguments(args: readonly string[]): SamplerOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      !Effect2.pipe(flag, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.startsWith('--')),
      ) ||
      value === undefined
    )
      throw ScriptError.make({message: `Invalid benchmark sampler argument ${flag}.`});
    values.set(flag, value);
  }
  const required = (flag: string) => {
    const value = values.get(flag);
    if (!value) throw ScriptError.make({message: `Missing benchmark sampler argument ${flag}.`});
    return value;
  };
  const diagnosticFlag = values.get('--rss-peak-diagnostics');
  if (diagnosticFlag !== undefined && diagnosticFlag !== 'true' && diagnosticFlag !== 'false')
    throw ScriptError.make({message: 'Sampler RSS peak diagnostics must be true or false.'});
  const processId = Number(required('--pid'));
  const intervalMilliseconds = Number(required('--interval-ms'));
  const checkpointIntervalMilliseconds = Number(required('--checkpoint-ms'));
  if (!Number.isSafeInteger(processId) || processId <= 0)
    throw ScriptError.make({message: 'Sampler PID must be positive.'});
  if (!Number.isSafeInteger(intervalMilliseconds) || intervalMilliseconds < 10) {
    throw ScriptError.make({message: 'Sampler interval must be at least 10 milliseconds.'});
  }
  if (!Number.isSafeInteger(checkpointIntervalMilliseconds) || checkpointIntervalMilliseconds < intervalMilliseconds) {
    throw ScriptError.make({message: 'Sampler checkpoint interval must be at least the sampling interval.'});
  }
  const outputPath = required('--output');
  const checkpointPath = required('--checkpoint-output');
  const readyPath = required('--ready');
  if (hostPath.dirname(outputPath) === outputPath)
    throw ScriptError.make({message: 'Sampler output path must have a parent directory.'});
  if (hostPath.dirname(checkpointPath) === checkpointPath) {
    throw ScriptError.make({message: 'Sampler checkpoint path must have a parent directory.'});
  }
  if (hostPath.dirname(readyPath) === readyPath)
    throw ScriptError.make({message: 'Sampler ready path must have a parent directory.'});
  if (new Set([checkpointPath, outputPath, readyPath]).size !== 3) {
    throw ScriptError.make({message: 'Sampler checkpoint, output, and ready paths must be distinct.'});
  }
  return {
    checkpointIntervalMilliseconds,
    checkpointPath,
    databasePath: required('--database'),
    intervalMilliseconds,
    outputPath,
    phasePath: required('--phase'),
    processId,
    readyPath,
    ...(diagnosticFlag === 'true' ? {rssPeakDiagnostics: true as const} : {}),
    stopPath: required('--stop'),
    temporaryRoot: required('--temp-root'),
  };
}

const SamplerLayer = ScriptSystemInfoLayer.pipe(Layer.provideMerge(BunServices.layer));

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(samplerMain, SamplerLayer));
