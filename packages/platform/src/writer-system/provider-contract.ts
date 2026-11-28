import {writerFail} from './fault.js';
export const ownedProviderTreeBrand: unique symbol = Symbol('owned-provider-tree');
/** Capability minted by this runtime only; a persisted PID is never a replacement. */
export interface RuntimeOwnedProviderTree {
  readonly [ownedProviderTreeBrand]: true;
}
/**
 * The code identity the Darwin kernel must report for a launched image before it runs any instruction: the cdhash of
 * its CodeDirectory (40 lowercase hex) and, for release images, the hardened runtime. The caller derives it from
 * admitted bytes or a compiled-in value, never from the file on disk at launch.
 */
export interface RuntimeOwnedProviderExpectedDarwinImage {
  readonly cdhash: string;
  readonly requireRuntime: boolean;
}
export interface RuntimeOwnedProviderLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  /**
   * Lifetime process cap for one owned Windows Job: an integer from 1 to 4096, default 256. It is bounded by the
   * dispatcher-wide 4096-process total, which is shared and not reserved at admission, so concurrent large caps can
   * still meet that total. POSIX observes the live process group and validates but ignores it.
   */
  readonly maxProcesses?: number;
  /**
   * Darwin only. The child starts suspended; it is resumed only when the kernel reports this image: the exact cdhash,
   * CS_VALID and CS_KILL (plus CS_HARD and CS_RUNTIME when required), no CS_GET_TASK_ALLOW or CS_DEBUGGED, and empty
   * entitlement blobs. Otherwise it is killed while suspended, reaped within a bound, and the launch fails with
   * 'image-mismatch' or 'code-signature-unavailable'. Other platforms refuse the option.
   */
  readonly expectedDarwinImage?: RuntimeOwnedProviderExpectedDarwinImage;
}
/** Validated expected image; refused before any native resource is created. */
export function ownedProviderExpectedDarwinImage(
  value: RuntimeOwnedProviderExpectedDarwinImage | undefined,
  platform: string,
): RuntimeOwnedProviderExpectedDarwinImage | undefined {
  if (value === undefined) return undefined;
  if (platform !== 'darwin') return writerFail('unsupported-platform');
  return typeof value.cdhash === 'string' &&
    /^[0-9a-f]{40}$/u.test(value.cdhash) &&
    typeof value.requireRuntime === 'boolean'
    ? {cdhash: value.cdhash, requireRuntime: value.requireRuntime}
    : writerFail('identity');
}
/** Validated per-launch Windows Job lifetime process cap; refused before any native resource is created. */
export function ownedProviderMaxProcesses(value: number | undefined): number {
  const limit = value ?? 256;
  // 'identity' is the existing refusal for every owned-tree capacity bound (owner, Job and slot limits).
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= 4096 ? limit : writerFail('identity');
}
/** Closed, bounded cause of lost Windows tree ownership; never a PID, handle, path or count. */
export type RuntimeOwnedProviderLossCategory =
  'member-cap' | 'slot-total' | 'thread-ledger' | 'accounting' | 'startup-mismatch' | 'other';
export interface RuntimeOwnedProviderObservation {
  readonly state: 'running' | 'drained' | 'unknown';
  readonly leaderExitCode: number | null;
  readonly stdioClosed: boolean;
  /** Windows only, and only with `state: 'unknown'`: the first recorded cause. POSIX never reports one. */
  readonly lossCategory?: RuntimeOwnedProviderLossCategory;
}
/** Process counters do not attest a complete historical POSIX descendant census. */
export type RuntimeOwnedProviderResourceObservation =
  | {readonly state: 'unknown'}
  | {
      readonly state: 'known';
      readonly coverage: 'original-process' | 'complete-captured-tree';
      readonly currentRssBytes: number;
      /** Sum of retained kernel process peaks: a conservative bound, not simultaneous sampled RSS. */
      readonly peakRssUpperBoundBytes: number;
      readonly capturedProcesses: number;
    };

/** Internal accounting only. Native backends supply authenticated process objects, never caller PIDs. */
export class OwnedProviderResourceLedger {
  private readonly members = new Map<object, {current: number; peak: number; terminal: boolean}>();
  private unknown = false;
  constructor(private readonly maximumMembers: number) {
    if (!Number.isSafeInteger(maximumMembers) || maximumMembers < 1 || maximumMembers > 4096) this.invalidate();
  }
  invalidate(): void {
    this.unknown = true;
  }
  capture(member: object, current: number, peak: number, terminal = false): void {
    const previous = this.members.get(member);
    if (
      this.unknown ||
      !Number.isSafeInteger(current) ||
      !Number.isSafeInteger(peak) ||
      current < 0 ||
      peak < current ||
      (terminal && current !== 0) ||
      (previous !== undefined &&
        (peak < previous.peak || (previous.terminal && (!terminal || peak !== previous.peak)))) ||
      (previous === undefined && this.members.size >= this.maximumMembers)
    ) {
      this.invalidate();
      return;
    }
    this.members.set(member, {current, peak, terminal});
  }
  observe(coverage: 'original-process' | 'complete-captured-tree'): RuntimeOwnedProviderResourceObservation {
    if (this.unknown || this.members.size === 0) return {state: 'unknown'};
    let currentRssBytes = 0,
      peakRssUpperBoundBytes = 0;
    for (const member of this.members.values()) {
      currentRssBytes += member.current;
      peakRssUpperBoundBytes += member.peak;
      if (!Number.isSafeInteger(currentRssBytes) || !Number.isSafeInteger(peakRssUpperBoundBytes)) {
        this.invalidate();
        return {state: 'unknown'};
      }
    }
    return {
      state: 'known',
      coverage,
      currentRssBytes,
      peakRssUpperBoundBytes,
      capturedProcesses: this.members.size,
    };
  }
}
export interface RuntimeOwnedProviderProcess {
  readonly handle: RuntimeOwnedProviderTree;
  readonly pid: number;
  readonly identity: string;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly write: (bytes: Uint8Array, signal?: AbortSignal) => Promise<void>;
  readonly closeInput: () => Promise<void>;
}
export interface OwnedProviderBackend extends Omit<RuntimeOwnedProviderProcess, 'handle'> {
  readonly observe: () => RuntimeOwnedProviderObservation;
  readonly observeResources: () => RuntimeOwnedProviderResourceObservation;
  readonly terminate: (mode: 'terminate' | 'kill') => void;
  readonly close: () => void;
}
