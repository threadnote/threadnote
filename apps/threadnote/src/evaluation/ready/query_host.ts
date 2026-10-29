import {Option as EffectOption} from 'effect';
import {Array as EffectArray} from 'effect';
import {Clock, Effect, FileSystem, String as EffectString, pipe} from 'effect';
import {runtimeHostHardwareInfo} from '@threadnote/platform/system';
import {
  READY_QUERY_CPU_PRESSURE_PERCENT_MAXIMUM,
  READY_QUERY_IO_PRESSURE_PERCENT_MAXIMUM,
  READY_QUERY_LOGICAL_CPU_MINIMUM,
  READY_QUERY_MEMORY_PRESSURE_PERCENT_MAXIMUM,
  type ReadyQueryEvidenceV1,
} from './query_evidence.js';

export interface ReadyQueryLinuxHostSample {
  readonly cpuPressureTotalMicroseconds: number;
  readonly ioPressureTotalMicroseconds: number;
  readonly memoryPressureTotalMicroseconds: number;
  readonly observedAtMilliseconds: number;
  readonly runnableProcesses: number;
  readonly stealTicks: number;
  readonly swapInputPages: number;
  readonly swapOutputPages: number;
}

export const readReadyQueryLinuxHostSample = Effect.fn('readyQueryEvidence.readLinuxHostSample')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const [stat, load, vmstat, cpuPressure, ioPressure, memoryPressure] = yield* Effect.all(
    [
      fs.readFileString('/proc/stat'),
      fs.readFileString('/proc/loadavg'),
      fs.readFileString('/proc/vmstat'),
      fs.readFileString('/proc/pressure/cpu'),
      fs.readFileString('/proc/pressure/io'),
      fs.readFileString('/proc/pressure/memory'),
    ],
    {concurrency: 6},
  );
  return parseReadyQueryLinuxHostSample({
    load,
    observedAtMilliseconds: yield* Clock.currentTimeMillis,
    cpuPressure,
    ioPressure,
    memoryPressure,
    stat,
    vmstat,
  });
});

export function parseReadyQueryLinuxHostSample(input: {
  readonly cpuPressure: string;
  readonly ioPressure: string;
  readonly load: string;
  readonly memoryPressure: string;
  readonly observedAtMilliseconds: number;
  readonly stat: string;
  readonly vmstat: string;
}): ReadyQueryLinuxHostSample {
  const cpu = EffectOption.getOrUndefined(
    EffectOption.map(EffectOption.fromNullishOr(/^cpu\s(.+)$/m.exec(input.stat)?.[1]), line =>
      pipe(line, EffectString.trim, EffectString.split(/\s+/), EffectArray.map(Number)),
    ),
  );
  const loadFields = pipe(input.load, EffectString.trim, EffectString.split(/\s+/));
  const runnable = Number.parseInt(EffectString.split('/')(loadFields[3] ?? '')[0], 10);
  const cpuPressure = pressureTotal(input.cpuPressure);
  const ioPressure = pressureTotal(input.ioPressure);
  const memoryPressure = pressureTotal(input.memoryPressure);
  const swapInput = /(?:^|\n)pswpin\s+(\d+)(?:\s|$)/.exec(input.vmstat)?.[1];
  const swapOutput = /(?:^|\n)pswpout\s+(\d+)(?:\s|$)/.exec(input.vmstat)?.[1];
  const values = [cpu?.[7], runnable, cpuPressure, ioPressure, memoryPressure, Number(swapInput), Number(swapOutput)];
  if (
    !Number.isFinite(input.observedAtMilliseconds) ||
    input.observedAtMilliseconds < 0 ||
    EffectArray.some(values, value => value === undefined || !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new Error('Linux host contention counters are unavailable or malformed.');
  }
  return {
    cpuPressureTotalMicroseconds: cpuPressure,
    ioPressureTotalMicroseconds: ioPressure,
    memoryPressureTotalMicroseconds: memoryPressure,
    observedAtMilliseconds: input.observedAtMilliseconds,
    runnableProcesses: runnable,
    stealTicks: cpu![7],
    swapInputPages: Number(swapInput),
    swapOutputPages: Number(swapOutput),
  };
}

export function readyQueryHostEvidence(
  samples: readonly ReadyQueryLinuxHostSample[],
  logicalCpuCount = runtimeHostHardwareInfo().logicalCpuCount,
): ReadyQueryEvidenceV1['host'] {
  if (
    samples.length < 2 ||
    !Number.isSafeInteger(logicalCpuCount) ||
    logicalCpuCount < READY_QUERY_LOGICAL_CPU_MINIMUM
  ) {
    throw new Error('Ready-query host contention evidence requires at least two Linux observations.');
  }
  const ordered = [...samples].sort((left, right) => left.observedAtMilliseconds - right.observedAtMilliseconds);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const cpuPressurePercentMaximum = pressurePercentMaximum(ordered, sample => sample.cpuPressureTotalMicroseconds);
  const ioPressurePercentMaximum = pressurePercentMaximum(ordered, sample => sample.ioPressureTotalMicroseconds);
  const memoryPressurePercentMaximum = pressurePercentMaximum(
    ordered,
    sample => sample.memoryPressureTotalMicroseconds,
  );
  const stealTicksDelta = monotonicDelta(first.stealTicks, last.stealTicks);
  const swapInputPagesDelta = monotonicDelta(first.swapInputPages, last.swapInputPages);
  const swapOutputPagesDelta = monotonicDelta(first.swapOutputPages, last.swapOutputPages);
  const maxRunnableProcesses = Math.max(...EffectArray.map(ordered, sample => sample.runnableProcesses));
  const reasons = [
    ...(cpuPressurePercentMaximum > READY_QUERY_CPU_PRESSURE_PERCENT_MAXIMUM ? (['cpu-pressure'] as const) : []),
    ...(stealTicksDelta > 0 ? (['cpu-steal'] as const) : []),
    ...(ioPressurePercentMaximum > READY_QUERY_IO_PRESSURE_PERCENT_MAXIMUM ? (['io-pressure'] as const) : []),
    ...(memoryPressurePercentMaximum > READY_QUERY_MEMORY_PRESSURE_PERCENT_MAXIMUM
      ? (['memory-pressure'] as const)
      : []),
    ...(maxRunnableProcesses > logicalCpuCount ? (['run-queue'] as const) : []),
    ...(swapInputPagesDelta > 0 || swapOutputPagesDelta > 0 ? (['swap-activity'] as const) : []),
  ];
  if (reasons.length > 0) {
    throw new Error(`Host contention invalidates ready-query evidence: ${EffectArray.join(reasons, ', ')}.`);
  }
  return {
    available: true,
    contended: false,
    cpuPressurePercentMaximum,
    ioPressurePercentMaximum,
    logicalCpuCount,
    maxRunnableProcesses,
    memoryPressurePercentMaximum,
    observations: ordered.length,
    policy: 'linux-proc-v1',
    reasons: [],
    stealTicksDelta,
    swapInputPagesDelta,
    swapOutputPagesDelta,
  };
}

function pressureTotal(value: string): number {
  return Number(/(?:^|\n)some\s[^\n]*\btotal=(\d+)(?:\s|$)/.exec(value)?.[1]);
}

function pressurePercentMaximum(
  samples: readonly ReadyQueryLinuxHostSample[],
  select: (sample: ReadyQueryLinuxHostSample) => number,
): number {
  let maximum = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const elapsedMicroseconds = (current.observedAtMilliseconds - previous.observedAtMilliseconds) * 1_000;
    const pressureMicroseconds = select(current) - select(previous);
    if (elapsedMicroseconds < 0 || pressureMicroseconds < 0) {
      throw new Error('Linux host contention counters were not monotonic.');
    }
    if (elapsedMicroseconds === 0) {
      if (pressureMicroseconds > 0) throw new Error('Linux host contention counters were not monotonic.');
      continue;
    }
    maximum = Math.max(maximum, Math.min(100, (pressureMicroseconds / elapsedMicroseconds) * 100));
  }
  return maximum;
}

function monotonicDelta(first: number, last: number): number {
  if (last < first) throw new Error('Linux host contention counters were not monotonic.');
  return last - first;
}
