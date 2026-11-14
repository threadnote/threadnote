import {providerOutputSource} from './provider-output-source.js';
import {dlopen, ptr} from 'bun:ffi';
import {Array as EffectArray, Record as EffectRecord, String as EffectString, Option} from 'effect';
import {retainNativeArguments} from './native-arguments.js';
import {randomUuidV4} from '../uuid.js';
import {writerFail as fail} from './fault.js';
import {
  windowsAddress,
  windowsHandle,
  windowsKernel,
  windowsProcessIdentity,
  windowsTokenPrincipal,
  windowsWide,
  windowsInvalidHandle,
  windowsWellFormed,
  windowsSystemLibrary,
} from './windows-native.js';
import type {OwnedProviderBackend, RuntimeOwnedProviderLaunch} from './provider-contract.js';

/** Microsoft CRT argv quoting. CreateProcess receives a separate exact application path; no shell participates. */
export function windowsProviderCommandLine(command: string, args: readonly string[]): string {
  const quoted = EffectArray.map([command, ...args], value => {
    windowsWide(value);
    let result = '"',
      slashes = 0;
    for (const char of value) {
      if (char === '\\') {
        slashes++;
        continue;
      }
      result += EffectString.repeat(char === '"' ? slashes * 2 + 1 : slashes)('\\') + char;
      slashes = 0;
    }
    return result + EffectString.repeat(slashes * 2)('\\') + '"';
  });
  const line = EffectArray.join(quoted, ' ');
  if (line.length > 32766) fail('io');
  return line;
}
function environmentBlock(environment: NodeJS.ProcessEnv): Uint16Array {
  const entries = EffectArray.filter(
    EffectRecord.toEntries(environment),
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  const seen = new Set<string>();
  for (const [key, value] of entries) {
    if (!key || !/^[\x20-\x7e]+$/u.test(key) || EffectString.includes('=')(key) || EffectString.includes('\0')(value))
      fail('identity');
    const canonical = EffectString.toUpperCase(key);
    if (seen.has(canonical)) fail('identity');
    seen.add(canonical);
  }
  const sorted = EffectArray.sort(
    entries,
    (leftEntry: readonly [string, string], rightEntry: readonly [string, string]) => {
      const left = leftEntry[0],
        right = rightEntry[0];
      const a = EffectString.toUpperCase(left),
        b = EffectString.toUpperCase(right);
      return a < b ? -1 : a > b ? 1 : 0;
    },
  );
  const body =
    EffectArray.join(
      EffectArray.map(sorted, ([key, value]) => `${key}=${value}`),
      '\0',
    ) + '\0';
  // The environment contains separators by design, so encode each code unit without the string-input NUL guard.
  if (body.length > 32766 || !windowsWellFormed(body)) fail('identity');
  const result = new Uint16Array(body.length + 1);
  for (let index = 0; index < body.length; index++)
    result[index] = Option.getOrElse(EffectString.charCodeAt(index)(body), () => fail('identity'));
  return result;
}

function kernel() {
  return dlopen('kernel32.dll', {
    CloseHandle: {args: ['u64'], returns: 'i32'},
    GetLastError: {args: [], returns: 'u32'},
    CreateJobObjectW: {args: ['ptr', 'ptr'], returns: 'u64'},
    SetInformationJobObject: {args: ['u64', 'u32', 'buffer', 'u32'], returns: 'i32'},
    QueryInformationJobObject: {args: ['u64', 'u32', 'buffer', 'u32', 'buffer'], returns: 'i32'},
    TerminateJobObject: {args: ['u64', 'u32'], returns: 'i32'},
    InitializeProcThreadAttributeList: {args: ['ptr', 'u32', 'u32', 'buffer'], returns: 'i32'},
    UpdateProcThreadAttribute: {args: ['buffer', 'u32', 'u64', 'buffer', 'u64', 'ptr', 'ptr'], returns: 'i32'},
    DeleteProcThreadAttributeList: {args: ['buffer'], returns: 'void'},
    CreateProcessW: {
      args: ['buffer', 'buffer', 'ptr', 'ptr', 'i32', 'u32', 'buffer', 'buffer', 'buffer', 'buffer'],
      returns: 'i32',
    },
    CreateNamedPipeW: {args: ['buffer', 'u32', 'u32', 'u32', 'u32', 'u32', 'u32', 'buffer'], returns: 'u64'},
    CreateFileW: {args: ['buffer', 'u32', 'u32', 'buffer', 'u32', 'u32', 'u64'], returns: 'u64'},
    ConnectNamedPipe: {args: ['u64', 'buffer'], returns: 'i32'},
    CreateEventW: {args: ['ptr', 'i32', 'i32', 'ptr'], returns: 'u64'},
    ResetEvent: {args: ['u64'], returns: 'i32'},
    ReadFile: {args: ['u64', 'buffer', 'u32', 'ptr', 'buffer'], returns: 'i32'},
    WriteFile: {args: ['u64', 'buffer', 'u32', 'ptr', 'buffer'], returns: 'i32'},
    GetOverlappedResult: {args: ['u64', 'buffer', 'buffer', 'i32'], returns: 'i32'},
    CancelIoEx: {args: ['u64', 'buffer'], returns: 'i32'},
    GetExitCodeProcess: {args: ['u64', 'buffer'], returns: 'i32'},
    WaitForSingleObject: {args: ['u64', 'u32'], returns: 'u32'},
    IsProcessInJob: {args: ['u64', 'u64', 'buffer'], returns: 'i32'},
    GetCurrentThreadId: {args: [], returns: 'u32'},
    GetCurrentProcess: {args: [], returns: 'u64'},
    DuplicateHandle: {args: ['u64', 'u64', 'u64', 'buffer', 'u32', 'i32', 'u32'], returns: 'i32'},
    GetThreadId: {args: ['u64'], returns: 'u32'},
    GetProcessIdOfThread: {args: ['u64'], returns: 'u32'},
    WaitForDebugEvent: {args: ['buffer', 'u32'], returns: 'i32'},
    ContinueDebugEvent: {args: ['u32', 'u32', 'u32'], returns: 'i32'},
    DebugSetProcessKillOnExit: {args: ['i32'], returns: 'i32'},
    ResumeThread: {args: ['u64'], returns: 'u32'},
  });
}
/** CompareObjectHandles is documented in Kernelbase, pinned to the native system directory. */
function objectComparison() {
  const loader = dlopen('kernel32.dll', {
    GetSystemDirectoryW: {args: ['buffer', 'u32'], returns: 'u32'},
    LoadLibraryExW: {args: ['buffer', 'u64', 'u32'], returns: 'u64'},
    FreeLibrary: {args: ['u64'], returns: 'i32'},
  });
  let module = 0n,
    releaseLibrary: (() => void) | undefined,
    state: 'owned' | 'closed' | 'unknown' = 'owned';
  const close = () => {
    if (state === 'closed') return;
    if (state === 'unknown') return fail('io');
    state = 'unknown';
    releaseLibrary?.();
    if (module !== 0n && loader.symbols.FreeLibrary(module) === 0) return fail('io');
    loader.close();
    state = 'closed';
  };
  try {
    const directory = new Uint16Array(32768),
      length = loader.symbols.GetSystemDirectoryW(directory, directory.length);
    if (length < 3 || length >= directory.length) fail('unsupported-platform');
    let path = '';
    for (const unit of directory.subarray(0, length)) path += String.fromCharCode(unit);
    if (!/^[A-Za-z]:\\/u.test(path) || /[\p{Cc}]/u.test(path)) fail('unsupported-platform');
    const absolute = `${path}\\kernelbase.dll`;
    module = windowsHandle(loader.symbols.LoadLibraryExW(windowsWide(absolute), 0n, 0x00000800));
    const library = dlopen(absolute, {CompareObjectHandles: {args: ['u64', 'u64'], returns: 'i32'}});
    releaseLibrary = () => library.close();
    return {symbols: library.symbols, close};
  } catch (error) {
    close();
    throw error;
  }
}
type Kernel = ReturnType<typeof kernel>;
interface Pipe {
  readonly parent: bigint;
  readonly child: bigint;
  readonly event: bigint;
  readonly overlapped: BigUint64Array;
  closed: boolean;
  busy: boolean;
  childOpen: boolean;
  connectionPending: boolean;
  uncertain: boolean;
  retainedBytes?: Uint8Array;
}
function close(kernel: Kernel, handle: bigint): void {
  if (kernel.symbols.CloseHandle(handle) === 0) fail('io');
}

/** Data-only accounting. Call exit transitions only AFTER successful native continuation. */
export class WindowsDebugThreadLedger {
  private readonly entries = new Map<object, Set<number>>();
  private primaryReserved = true;
  private piReserved = true;
  private count = 1;
  constructor(
    private readonly shared: {threads: number; pi: number},
    private readonly jobLimit = 1024,
    private readonly sharedLimit = 8192,
    private readonly piLimit = 64,
  ) {
    if (jobLimit < 1 || shared.threads >= sharedLimit || shared.pi >= piLimit) fail('identity');
    shared.threads++;
    shared.pi++;
  }
  get live(): number {
    return this.count;
  }
  create(member: object, tid: number, primary = false): void {
    const prior = this.entries.get(member);
    if (!Number.isSafeInteger(tid) || tid <= 0 || tid > 0xffffffff || prior?.has(tid)) fail('identity');
    if (primary ? !this.primaryReserved : this.count >= this.jobLimit || this.shared.threads >= this.sharedLimit)
      fail('identity');
    if (primary) this.primaryReserved = false;
    else {
      this.count++;
      this.shared.threads++;
    }
    const threads = prior ?? new Set<number>();
    threads.add(tid);
    this.entries.set(member, threads);
  }
  has(member: object, tid: number): boolean {
    return this.entries.get(member)?.has(tid) === true;
  }
  exitThread(member: object, tid: number): void {
    const threads = this.entries.get(member);
    if (!threads?.has(tid) || this.count < 1 || this.shared.threads < 1) return fail('identity');
    threads.delete(tid);
    this.count--;
    this.shared.threads--;
    if (threads.size === 0) this.entries.delete(member);
  }
  exitProcess(member: object): void {
    const threads = this.entries.get(member);
    if (!threads || threads.size > this.count || threads.size > this.shared.threads) return fail('identity');
    this.count -= threads.size;
    this.shared.threads -= threads.size;
    this.entries.delete(member);
  }
  releasePi(): void {
    if (!this.piReserved || this.shared.pi < 1) fail('identity');
    this.piReserved = false;
    this.shared.pi--;
  }
  cancelUnattempted(): void {
    if (!this.primaryReserved || this.entries.size !== 0 || this.count !== 1) fail('identity');
    this.primaryReserved = false;
    this.count--;
    this.shared.threads--;
    this.releasePi();
  }
}
interface DebugMember {
  readonly pid: number;
  readonly identity: string;
  readonly completion: bigint; // owned duplicate, never the borrowed debug-event handle
  readonly primaryTid: number;
  created: boolean;
  startup: boolean;
  exitContinued: boolean;
  exitCode: number | null;
}
interface DebugJob {
  readonly lib: Kernel;
  readonly handle: bigint;
  readonly sid: string;
  readonly pipes: readonly Pipe[];
  usable: boolean;
  readonly threads: WindowsDebugThreadLedger;
  readonly members: DebugMember[];
  readonly live: Map<number, DebugMember>;
  readonly pi: BigUint64Array;
  root?: DebugMember;
  piProcess: bigint;
  piThread: bigint;
  attempted: boolean;
  launchAllowed: boolean;
  state: 'active' | 'closing' | 'quarantined' | 'closed';
  unknown: boolean;
  deadline: number;
  total: number;
  generation: number;
  quarantineEvents: number;
}
let debugDispatcher: WindowsDebugDispatcher | undefined;
/** One creator-thread queue; never poll a separate debugger queue for each Job. */
class WindowsDebugDispatcher {
  readonly lib = kernel();
  private readonly objects: ReturnType<typeof objectComparison>;
  private readonly creator = this.lib.symbols.GetCurrentThreadId();
  private readonly jobs = new Set<DebugJob>();
  private readonly resources = {threads: 0, pi: 0};
  private readonly event = new Uint8Array(176 + 32);
  private readonly view = new DataView(this.event.buffer);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending = false;
  private pumping = false;
  private poisoned = false;
  private processSlots = 0;
  private quarantineEvents = 0;
  constructor() {
    try {
      if (!this.creator || (process.arch !== 'x64' && process.arch !== 'arm64')) fail('unsupported-platform');
      this.objects = objectComparison();
    } catch (error) {
      this.lib.close();
      throw error;
    }
  }
  private affinity(): void {
    if (this.lib.symbols.GetCurrentThreadId() !== this.creator) {
      this.poison();
      fail('identity');
    }
  }
  private poison(): void {
    if (this.poisoned) return;
    this.poisoned = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // Stop capabilities remain valid even when evidence of completion is lost.
    for (const job of this.jobs) {
      job.unknown = true;
      if (job.usable) job.lib.symbols.TerminateJobObject(job.handle, 1);
    }
  }
  reserve(lib: Kernel, handle: bigint, sid: string, pipes: readonly Pipe[]): DebugJob {
    // A poisoned singleton may retain a library whose close result is uncertain.
    if (this.poisoned) return fail('identity');
    this.affinity();
    if (
      this.pending ||
      this.jobs.size >= 64 ||
      this.processSlots >= 4096 ||
      EffectArray.some([...this.jobs], job => job.unknown || job.state === 'quarantined')
    )
      fail('identity');
    const job: DebugJob = {
      lib,
      handle,
      sid,
      pipes,
      usable: true,
      threads: new WindowsDebugThreadLedger(this.resources),
      members: [],
      live: new Map(),
      pi: new BigUint64Array(3),
      piProcess: 0n,
      piThread: 0n,
      attempted: false,
      launchAllowed: false,
      state: 'active',
      unknown: false,
      deadline: 0,
      total: 0,
      generation: 0,
      quarantineEvents: 0,
    };
    this.processSlots++;
    this.jobs.add(job);
    return job;
  }
  beforeCreate(job: DebugJob): void {
    this.affinity();
    job.attempted = true;
  }
  private duplicate(handle: bigint): bigint {
    const current = this.lib.symbols.GetCurrentProcess(),
      output = new BigUint64Array(1);
    // Only SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION; never inheritable.
    if (this.lib.symbols.DuplicateHandle(current, handle, current, output, 0x00101000, 0, 0) === 0) fail('identity');
    return windowsHandle(output[0]);
  }
  registerRoot(job: DebugJob): DebugMember {
    // Retain actual PI output and ownership BEFORE any fallible identity helper or yield.
    job.piProcess = windowsHandle(job.pi[0]);
    job.piThread = windowsHandle(job.pi[1]);
    const pid = new DataView(job.pi.buffer).getUint32(16, true),
      tid = new DataView(job.pi.buffer).getUint32(20, true),
      completion = this.duplicate(job.piProcess);
    const member: DebugMember = {
      pid,
      primaryTid: tid,
      completion,
      identity: '',
      created: false,
      startup: true,
      exitContinued: false,
      exitCode: null,
    };
    job.members.push(member);
    job.root = member;
    // Registration retains the duplicate even if the following native authentication refuses.
    const identity = windowsProcessIdentity(completion, pid);
    this.authenticate(job, completion, pid);
    if (
      !tid ||
      this.lib.symbols.GetThreadId(job.piThread) !== tid ||
      this.lib.symbols.GetProcessIdOfThread(job.piThread) !== pid
    )
      fail('identity');
    const authenticated = {...member, identity};
    job.members[0] = authenticated;
    job.root = authenticated;
    job.live.set(pid, authenticated);
    this.affinity();
    this.schedule();
    return authenticated;
  }
  start(job: DebugJob): void {
    this.affinity();
    if (this.poisoned || !job.root || job.launchAllowed || job.unknown || job.state !== 'active' || job.piThread === 0n)
      return fail('identity');
    // PI, completion duplicate, Job and primary-thread reservation are already authenticated/retained.
    // Release only CREATE_SUSPENDED here: DEBUG_PROCESS still stops at CREATE before target user code.
    // Waiting to Resume inside CREATE can leave startup waiting on the very thread we kept suspended.
    job.launchAllowed = true;
    if (this.lib.symbols.ResumeThread(job.piThread) !== 1) fail('identity');
    this.affinity();
    // Keep both PI roles until the genuine CREATE authenticates actual system-handle aliases.
  }
  private authenticate(job: DebugJob, process: bigint, pid: number): string {
    const member = new Int32Array(1);
    if (
      job.lib.symbols.IsProcessInJob(process, job.handle, member) === 0 ||
      member[0] !== 1 ||
      windowsTokenPrincipal(process).sid !== job.sid
    )
      fail('identity');
    return windowsProcessIdentity(process, pid);
  }
  failed(job: DebugJob): void {
    job.launchAllowed = false;
    job.unknown = true;
    job.state = 'closing';
    job.deadline = performance.now() + 2000;
    if (!job.usable || job.lib.symbols.TerminateJobObject(job.handle, 1) === 0) this.poison();
    this.schedule();
  }
  stop(job: DebugJob, final: boolean): void {
    this.affinity();
    if (job.state === 'closed') return;
    if (!job.usable || job.lib.symbols.TerminateJobObject(job.handle, 1) === 0) {
      job.unknown = true;
      fail('identity');
    }
    if (job.state === 'active') job.state = 'closing';
    // The caller's final-kill window is 2s; repeated stops do not restart it.
    if (final && job.deadline === 0) job.deadline = performance.now() + 2000;
    this.schedule();
  }
  quarantine(job: DebugJob): void {
    job.unknown = true;
    job.state = 'quarantined';
    this.schedule();
  }
  private expire(): void {
    for (const job of this.jobs)
      if (job.state === 'closing' && job.deadline > 0 && performance.now() >= job.deadline) {
        job.state = 'quarantined';
        job.unknown = true;
      }
  }
  private schedule(): void {
    this.expire();
    if (this.poisoned || !EffectArray.some([...this.jobs], job => job.state === 'active' || job.state === 'closing')) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
      this.schedule();
    }, 1);
  }
  private hasDebugLifetimes(): boolean {
    return EffectArray.some(
      [...this.jobs],
      job =>
        job.attempted && (job.members.length === 0 || EffectArray.some(job.members, member => !member.exitContinued)),
    );
  }
  pump(): void {
    if (this.poisoned || this.pumping) return;
    this.expire();
    if (!EffectArray.some([...this.jobs], job => job.state === 'active' || job.state === 'closing')) return;
    this.pumping = true;
    try {
      this.affinity();
      const start = performance.now();
      for (let count = 0; count < 32 && performance.now() - start < 2 && this.hasDebugLifetimes(); count++) {
        if (
          this.quarantineEvents >= 16384 ||
          EffectArray.some([...this.jobs], job => job.state === 'quarantined' && job.quarantineEvents >= 4096)
        )
          fail('identity');
        this.event.fill(0xa5);
        if (this.lib.symbols.WaitForDebugEvent(this.event.subarray(0, 176), 0) === 0) {
          const error = this.lib.symbols.GetLastError();
          // ABI-specific qualification must establish this exact zero-poll result; no generic false-as-empty.
          if (error !== 121) fail('identity');
          break;
        }
        this.pending = true;
        this.affinity();
        if (!this.event.subarray(176).every(value => value === 0xa5)) fail('identity');
        this.dispatch();
      }
    } catch {
      this.poison();
    } finally {
      this.pumping = false;
    }
  }
  private dispatch(): void {
    const kind = this.view.getUint32(0, true),
      pid = this.view.getUint32(4, true),
      tid = this.view.getUint32(8, true);
    if (!pid || !tid || kind < 1 || kind > 8) fail('identity');
    let job: DebugJob | undefined, member: DebugMember | undefined;
    if (kind === 3) {
      const borrowed = windowsHandle(this.view.getBigUint64(24, true));
      // Actual HANDLE membership, never an OpenProcess of an event-supplied PID.
      for (const candidate of this.jobs) {
        if (!candidate.usable) continue;
        const result = new Int32Array(1);
        if (candidate.lib.symbols.IsProcessInJob(borrowed, candidate.handle, result) === 0) fail('identity');
        if (result[0] === 1) {
          if (job) fail('identity');
          job = candidate;
        }
      }
      if (!job) return fail('identity');
      const identity = this.authenticate(job, borrowed, pid),
        root = job.root;
      if (root?.pid === pid && !root.created) {
        if (
          identity !== root.identity ||
          tid !== root.primaryTid ||
          this.objects.symbols.CompareObjectHandles(borrowed, root.completion) !== 1 ||
          this.objects.symbols.CompareObjectHandles(borrowed, job.piProcess) !== 1
        )
          fail('identity');
        member = root;
      } else {
        if (
          job.live.has(pid) ||
          job.members.length >= 256 ||
          this.processSlots >= 4096 ||
          EffectArray.some(job.members, prior => prior.pid === pid && prior.identity === identity)
        )
          fail('identity');
        const completion = this.duplicate(borrowed);
        member = {
          pid,
          identity,
          completion,
          primaryTid: tid,
          created: false,
          startup: true,
          exitContinued: false,
          exitCode: null,
        };
        job.members.push(member);
        this.processSlots++;
        if (
          windowsProcessIdentity(completion, pid) !== identity ||
          this.objects.symbols.CompareObjectHandles(borrowed, completion) !== 1
        )
          fail('identity');
        job.live.set(pid, member);
      }
      const borrowedThread = windowsHandle(this.view.getBigUint64(32, true));
      if (
        this.lib.symbols.GetThreadId(borrowedThread) !== tid ||
        this.lib.symbols.GetProcessIdOfThread(borrowedThread) !== pid
      )
        fail('identity');
      job.threads.create(member, tid, member === root);
      member.created = true;
      if (member === root) {
        // A same-value PI role transfers to system lifetime. Distinct PI roles are explicitly closed once.
        if (job.piProcess !== borrowed) close(job.lib, job.piProcess);
        job.piProcess = 0n;
        if (
          (!job.launchAllowed || job.unknown || job.state !== 'active') &&
          job.lib.symbols.TerminateJobObject(job.handle, 1) === 0
        )
          fail('identity');
        if (job.piThread !== borrowedThread) close(job.lib, job.piThread);
        job.piThread = 0n;
        job.threads.releasePi();
      }
      if (this.lib.symbols.DebugSetProcessKillOnExit(1) === 0) fail('identity');
      this.closeImage(job);
    } else {
      for (const candidate of this.jobs) {
        const found = candidate.live.get(pid);
        if (found) {
          if (job || !found.created || found.exitContinued) fail('identity');
          job = candidate;
          member = found;
        }
      }
      if (!job || !member || !job.threads.has(member, tid)) {
        // CREATE_THREAD introduces a new TID, authenticated below from its actual borrowed thread handle.
        if (kind !== 2 || !job || !member) fail('identity');
      }
    }
    if (!job || !member) return fail('identity');
    if (job.state === 'quarantined') {
      if (job.quarantineEvents >= 4096 || this.quarantineEvents >= 16384) fail('identity');
      job.quarantineEvents++;
      this.quarantineEvents++;
      if (job.lib.symbols.TerminateJobObject(job.handle, 1) === 0) fail('identity');
    }
    let status = 0x00010002;
    if (kind === 1) {
      const exception = this.view.getUint32(16, true),
        first = this.view.getUint32(168, true);
      if (first !== 0 && first !== 1) fail('identity');
      if (member.startup) {
        if (exception !== 0x80000003 || first !== 1 || tid !== member.primaryTid) fail('identity');
        member.startup = false;
      } else status = 0x80010001; // genuine exceptions are never swallowed
    } else if (kind === 2) {
      const borrowed = windowsHandle(this.view.getBigUint64(16, true));
      if (this.lib.symbols.GetThreadId(borrowed) !== tid || this.lib.symbols.GetProcessIdOfThread(borrowed) !== pid)
        fail('identity');
      job.threads.create(member, tid);
    } else if (kind === 6) this.closeImage(job);
    else if (kind === 5) member.exitCode = this.view.getUint32(16, true);
    this.affinity();
    if (this.lib.symbols.ContinueDebugEvent(pid, tid, status) === 0) fail('identity');
    this.pending = false;
    this.affinity();
    // Only successful continuation retires borrowed system handles/bookkeeping.
    if (kind === 4) job.threads.exitThread(member, tid);
    if (kind === 5) {
      member.exitContinued = true;
      job.threads.exitProcess(member);
      job.live.delete(pid);
    }
    job.generation++;
  }
  private closeImage(job: DebugJob): void {
    const image = this.view.getBigUint64(16, true);
    if (image !== 0n) close(job.lib, windowsHandle(image));
  }
  private accounting(job: DebugJob): {active: number; total: number} {
    const bytes = new Uint8Array(48 + 32),
      length = new Uint32Array(1);
    bytes.fill(0xa5);
    if (
      job.lib.symbols.QueryInformationJobObject(job.handle, 1, bytes.subarray(0, 48), 48, length) === 0 ||
      length[0] !== 48 ||
      !bytes.subarray(48).every(value => value === 0xa5)
    )
      fail('identity');
    const view = new DataView(bytes.buffer),
      total = view.getUint32(36, true),
      active = view.getUint32(40, true);
    if (total < job.total || total > 256 || active > total) fail('identity');
    job.total = total;
    return {active, total};
  }
  proof(job: DebugJob): 'running' | 'drained' | 'unknown' {
    if (this.poisoned || job.unknown || job.state === 'quarantined') return 'unknown';
    this.pump();
    if (this.poisoned || job.unknown) return 'unknown';
    try {
      this.affinity();
      const first = this.accounting(job),
        generation = job.generation;
      if (first.active !== 0) return 'running';
      if (
        first.total !== job.members.length ||
        !job.root ||
        this.pending ||
        job.piProcess !== 0n ||
        job.piThread !== 0n ||
        job.threads.live !== 0 ||
        EffectArray.some(job.members, member => !member.created || !member.exitContinued)
      ) {
        // Queued CREATE/EXIT may still fill a real capture gap. Counts alone can never repair it.
        if (!this.hasDebugLifetimes()) this.quarantine(job);
        return job.unknown ? 'unknown' : 'running';
      }
      for (const member of job.members) {
        if (windowsProcessIdentity(member.completion, member.pid) !== member.identity) fail('identity');
        const wait = job.lib.symbols.WaitForSingleObject(member.completion, 0);
        if (wait === 258) return 'running';
        if (wait !== 0) fail('identity');
      }
      const second = this.accounting(job);
      return second.active === 0 && second.total === first.total && generation === job.generation
        ? 'drained'
        : 'running';
    } catch {
      this.quarantine(job);
      return 'unknown';
    }
  }
  abandonUnattempted(job: DebugJob): void {
    if (job.attempted) fail('identity');
    job.threads.cancelUnattempted();
    this.processSlots--;
    this.jobs.delete(job);
    this.disposeIdle();
  }
  released(job: DebugJob): void {
    job.state = 'closed';
    this.processSlots -= job.members.length;
    this.jobs.delete(job);
    this.schedule();
    this.disposeIdle();
  }
  private disposeIdle(): void {
    if (this.jobs.size || this.pending || this.poisoned) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    try {
      this.objects.close();
      this.lib.close();
      debugDispatcher = undefined;
    } catch {
      this.poison();
      fail('io');
    }
  }
}
function dispatcher(): WindowsDebugDispatcher {
  return (debugDispatcher ??= new WindowsDebugDispatcher());
}

/** Atomic Job assignment and restricted inheritance precede all debuggee user execution. */
export function spawnWindowsProvider(options: RuntimeOwnedProviderLaunch): OwnedProviderBackend {
  const debug = dispatcher();
  const principal = windowsTokenPrincipal();
  const lib = kernel();
  const security = windowsSystemLibrary('advapi32.dll', {
    ConvertStringSecurityDescriptorToSecurityDescriptorW: {args: ['buffer', 'u32', 'buffer', 'buffer'], returns: 'i32'},
  });
  const base = windowsKernel();
  let descriptor = 0n,
    job = 0n,
    attributesReady = false,
    transferred = false,
    temporaryReleased = false;
  let debugJob: DebugJob | undefined;
  const pipes: Pipe[] = [];
  const creationBuffers: ArrayBufferView[] = [];
  const releaseArguments = retainNativeArguments(creationBuffers);
  const attributeSize = new BigUint64Array(1);
  let attributes = new Uint8Array(0);
  const releaseTemporary = () => {
    // A failed release has uncertain ownership: attempt each resource only once.
    temporaryReleased = true;
    let failed = false,
      failure: unknown;
    for (const release of [
      () => {
        if (attributesReady) lib.symbols.DeleteProcThreadAttributeList(attributes);
      },
      releaseArguments,
      () => {
        if (descriptor !== 0n) base.symbols.LocalFree(descriptor);
      },
      () => security.close(),
      () => base.close(),
    ]) {
      try {
        release();
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
    if (failed) throw failure;
  };
  try {
    if (!/^[A-Za-z]:\\/u.test(options.command) || !/^[A-Za-z]:\\/u.test(options.cwd) || options.args.length > 4096)
      fail('path');
    const sd = new BigUint64Array(1),
      sdLength = new Uint32Array(1);
    if (
      security.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorW(
        windowsWide(`O:${principal.sid}D:P(A;;GA;;;${principal.sid})`),
        1,
        sd,
        sdLength,
      ) === 0
    )
      fail('identity');
    descriptor = windowsHandle(sd[0]);
    const parentSecurity = new BigUint64Array(3),
      childSecurity = new BigUint64Array(3);
    for (const [bytes, inherit] of [
      [parentSecurity, 0],
      [childSecurity, 1],
    ] as const) {
      const view = new DataView(bytes.buffer);
      view.setUint32(0, 24, true);
      view.setBigUint64(8, descriptor, true);
      view.setUint32(16, inherit, true);
    }
    job = windowsHandle(lib.symbols.CreateJobObjectW(null, null));
    debugJob = debug.reserve(lib, job, principal.sid, pipes);
    const limits = new BigUint64Array(18);
    new DataView(limits.buffer).setUint32(16, 0x00002000, true); // KILL_ON_JOB_CLOSE, no breakaway flags.
    if (lib.symbols.SetInformationJobObject(job, 9, limits, 144) === 0) fail('unsupported-platform');
    for (let index = 0; index < 3; index++) pipes.push(createPipe(lib, index === 0, parentSecurity, childSecurity));
    if (
      lib.symbols.InitializeProcThreadAttributeList(null, 2, 0, attributeSize) !== 0 ||
      lib.symbols.GetLastError() !== 122 ||
      attributeSize[0] === 0n ||
      attributeSize[0] > 65536n
    )
      fail('unsupported-platform');
    attributes = new Uint8Array(Number(attributeSize[0]));
    if (lib.symbols.InitializeProcThreadAttributeList(ptr(attributes), 2, 0, attributeSize) === 0)
      fail('unsupported-platform');
    attributesReady = true;
    const jobList = new BigUint64Array([job]),
      handles = new BigUint64Array(EffectArray.map(pipes, pipe => pipe.child));
    creationBuffers.push(jobList, handles, attributes);
    if (
      lib.symbols.UpdateProcThreadAttribute(attributes, 0, 0x0002000dn, jobList, 8n, null, null) === 0 ||
      lib.symbols.UpdateProcThreadAttribute(attributes, 0, 0x00020002n, handles, 24n, null, null) === 0
    )
      fail('unsupported-platform');
    const startup = new BigUint64Array(14),
      view = new DataView(startup.buffer);
    view.setUint32(0, 112, true);
    view.setUint32(60, 0x100, true);
    view.setBigUint64(80, pipes[0].child, true);
    view.setBigUint64(88, pipes[1].child, true);
    view.setBigUint64(96, pipes[2].child, true);
    view.setBigUint64(104, windowsAddress(attributes), true);
    const output = debugJob.pi;
    debug.beforeCreate(debugJob);
    if (
      lib.symbols.CreateProcessW(
        windowsWide(options.command),
        windowsWide(windowsProviderCommandLine(options.command, options.args)),
        null,
        null,
        1,
        0x00080000 | 0x00000400 | 0x08000000 | 0x00000001 | 0x00000004,
        environmentBlock(options.environment),
        windowsWide(options.cwd),
        startup,
        output,
      ) === 0
    )
      fail('io');
    const root = debug.registerRoot(debugJob);
    for (const pipe of pipes) {
      close(lib, pipe.child);
      pipe.childOpen = false;
    }
    const owned = makeOwnedWindows({lib, job, pid: root.pid, identity: root.identity, pipes, debug, debugJob});
    // No fallible temporary release may abort the return after launch ownership transfers.
    releaseTemporary();
    debug.start(debugJob);
    transferred = true;
    return owned;
  } catch (error) {
    if (!temporaryReleased) {
      try {
        releaseTemporary();
      } catch {
        // Preserve the launch failure; the outer finally still contains its original Job.
      }
    }
    throw error;
  } finally {
    if (!transferred) {
      if (debugJob?.attempted) {
        // No count-zero cleanup after a creation attempt. Retain PI backing, pipes and DLL references.
        // A failed suspended launch is stopped through its exact Job; never resume it into user code.
        debug.failed(debugJob);
      } else {
        let settled = true;
        for (const pipe of pipes) {
          if (pipe.connectionPending) {
            const count = new Uint32Array(1);
            lib.symbols.CancelIoEx(pipe.parent, pipe.overlapped);
            if (lib.symbols.GetOverlappedResult(pipe.parent, pipe.overlapped, count, 0) === 0) {
              const error = lib.symbols.GetLastError();
              if (error !== 995 && error !== 109 && error !== 232) settled = false;
            }
          }
        }
        if (!settled) {
          // Keep hidden failed pipe ownership in the same bounded native domain.
          debugJob ??= debug.reserve(lib, job, principal.sid, pipes);
          debug.failed(debugJob);
        } else {
          try {
            for (const pipe of pipes) {
              if (pipe.childOpen) {
                pipe.childOpen = false;
                close(lib, pipe.child);
              }
              if (!pipe.closed) {
                pipe.closed = true;
                close(lib, pipe.parent);
              }
              close(lib, pipe.event);
            }
            if (job !== 0n) {
              if (debugJob) debugJob.usable = false;
              close(lib, job);
            }
            if (debugJob) debug.abandonUnattempted(debugJob);
            lib.close();
          } catch {
            if (debugJob) debug.failed(debugJob);
          }
        }
      }
    }
  }
}
function createPipe(lib: Kernel, input: boolean, parentSecurity: BigUint64Array, childSecurity: BigUint64Array): Pipe {
  const name = windowsWide(`\\\\.\\pipe\\threadnote-provider-${randomUuidV4()}`);
  let parent = 0n,
    child = 0n,
    event = 0n;
  try {
    parent = windowsHandle(
      lib.symbols.CreateNamedPipeW(
        name,
        (input ? 2 : 1) | 0x40000000 | 0x00080000,
        8,
        1,
        65536,
        65536,
        0,
        parentSecurity,
      ),
    );
    event = windowsHandle(lib.symbols.CreateEventW(null, 1, 0, null));
    const overlapped = new BigUint64Array(4);
    overlapped[3] = event;
    child = windowsHandle(
      lib.symbols.CreateFileW(name, input ? 0x80000000 : 0x40000000, 0, childSecurity, 3, 0x80, 0n),
    );
    let connectionPending = false;
    if (lib.symbols.ConnectNamedPipe(parent, overlapped) === 0) {
      const error = lib.symbols.GetLastError();
      if (error === 997) connectionPending = true;
      else if (error !== 535) fail('io');
    }
    // ERROR_PIPE_CONNECTED proves the client connected before ConnectNamedPipe. No pending connection IO remains.
    return {
      parent,
      child,
      event,
      overlapped,
      closed: false,
      busy: false,
      childOpen: true,
      connectionPending,
      uncertain: false,
    };
  } catch (error) {
    if (child !== 0n && child !== windowsInvalidHandle) lib.symbols.CloseHandle(child);
    if (parent !== 0n && parent !== windowsInvalidHandle) lib.symbols.CloseHandle(parent);
    if (event !== 0n) lib.symbols.CloseHandle(event);
    throw error;
  }
}

async function pipeOperation(
  lib: Kernel,
  pipe: Pipe,
  bytes: Uint8Array,
  write: boolean,
  signal?: AbortSignal,
): Promise<number | 'eof'> {
  if (pipe.closed || pipe.busy || pipe.uncertain) throw new Error('Provider pipe unavailable');
  if (signal?.aborted) throw signal.reason ?? new Error('Provider write aborted');
  pipe.busy = true;
  const transferred = new Uint32Array(1);
  let pending = false,
    cancelled = false;
  const cancel = () => {
    cancelled = true;
    if (pending) lib.symbols.CancelIoEx(pipe.parent, pipe.overlapped);
  };
  signal?.addEventListener('abort', cancel, {once: true});
  try {
    if (pipe.connectionPending) {
      while (lib.symbols.GetOverlappedResult(pipe.parent, pipe.overlapped, transferred, 0) === 0) {
        if (lib.symbols.GetLastError() !== 996) throw new Error('Provider pipe connection unknown');
        await Bun.sleep(5);
      }
      pipe.connectionPending = false;
    }
    pipe.overlapped.fill(0n);
    pipe.overlapped[3] = pipe.event;
    if (lib.symbols.ResetEvent(pipe.event) === 0) throw new Error('Provider pipe event failed');
    if (cancelled) throw signal?.reason ?? new Error('Provider write aborted');
    const started = write
      ? lib.symbols.WriteFile(pipe.parent, bytes, bytes.length, null, pipe.overlapped)
      : lib.symbols.ReadFile(pipe.parent, bytes, bytes.length, null, pipe.overlapped);
    if (started === 0) {
      const error = lib.symbols.GetLastError();
      if (!write && (error === 109 || error === 232)) return 'eof';
      if (error !== 997) {
        pipe.uncertain = error !== 109 && error !== 232;
        throw new Error('Provider pipe operation failed');
      }
    }
    pending = true;
    if (cancelled) lib.symbols.CancelIoEx(pipe.parent, pipe.overlapped);
    while (true) {
      if (lib.symbols.GetOverlappedResult(pipe.parent, pipe.overlapped, transferred, 0) !== 0) {
        pending = false;
        break;
      }
      const error = lib.symbols.GetLastError();
      if (error === 996) {
        await Bun.sleep(5);
        continue;
      }
      if (!write && (error === 109 || error === 232)) {
        pending = false;
        return 'eof';
      }
      if (error === 995 && cancelled) {
        pending = false;
        throw signal?.reason ?? new Error('Provider write aborted');
      }
      if (error === 109 || error === 232) {
        pending = false;
        throw new Error('Provider input closed');
      }
      pipe.uncertain = true;
      throw new Error('Provider pipe completion unknown');
    }
    if (cancelled) throw signal?.reason ?? new Error('Provider write aborted');
    if (transferred[0] > bytes.length) throw new Error('Provider pipe count invalid');
    // A successful zero-byte pipe read can follow a zero-byte write. Only broken/closing pipe status proves EOF.
    return transferred[0];
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (pending || pipe.uncertain) {
      pipe.uncertain = true;
      pipe.retainedBytes = bytes;
    } else pipe.busy = false;
  }
}
function makeOwnedWindows(input: {
  lib: Kernel;
  job: bigint;
  pid: number;
  identity: string;
  pipes: readonly Pipe[];
  debug: WindowsDebugDispatcher;
  debugJob: DebugJob;
}): OwnedProviderBackend {
  const {lib, job, pid, identity, pipes, debug, debugJob} = input;
  let closed = false,
    unknown = false,
    closing = false,
    ioUnknown = false,
    inputClosing = false,
    writes = 0,
    writeBytes = 0;
  let tail = Promise.resolve(),
    leaderExitCode: number | null = null;
  const eof = [false, false];
  const stdout = EffectArray.map(pipes.slice(1), (pipe, index) => {
    let discarding = false,
      failed = false;
    const pump = async (controller?: ReadableStreamDefaultController<Uint8Array>) => {
      try {
        while (!closed && !eof[index]) {
          const bytes = new Uint8Array(65536),
            count = await pipeOperation(lib, pipe, bytes, false);
          if (count === 'eof') {
            eof[index] = true;
            close(lib, pipe.parent);
            pipe.closed = true;
            if (!discarding) controller?.close();
            return;
          }
          await Bun.sleep(1);
          if (!discarding) {
            controller?.enqueue(bytes.subarray(0, count));
            return;
          }
        }
      } catch (error) {
        ioUnknown = true;
        failed = true;
        if (!discarding) controller?.error(error);
      }
    };
    return new ReadableStream<Uint8Array>(
      providerOutputSource(
        pump,
        () => {
          discarding = true;
        },
        () => !closed && !eof[index] && !failed,
      ),
      {highWaterMark: 1},
    );
  });
  const observe = () => {
    const stdioClosed = EffectArray.every(eof, Boolean) && writes === 0;
    if (closed) return {state: 'drained' as const, leaderExitCode, stdioClosed};
    if (closing) return {state: 'unknown' as const, leaderExitCode, stdioClosed};
    const native = debug.proof(debugJob);
    leaderExitCode = debugJob.root?.exitCode ?? leaderExitCode;
    if (ioUnknown || EffectArray.some(pipes, pipe => pipe.uncertain)) {
      unknown = true;
      debug.quarantine(debugJob);
    }
    return {
      state:
        unknown || native === 'unknown'
          ? ('unknown' as const)
          : native === 'drained' &&
              stdioClosed &&
              EffectArray.every(pipes, pipe => !pipe.busy && !pipe.connectionPending)
            ? ('drained' as const)
            : ('running' as const),
      leaderExitCode,
      stdioClosed,
    };
  };
  return {
    pid,
    identity,
    stdout: stdout[0],
    stderr: stdout[1],
    observe,
    write(bytes, signal) {
      if (closed || closing || unknown || inputClosing || pipes[0].closed || signal?.aborted)
        return Promise.reject(new Error('Provider input unavailable'));
      if (writes >= 64 || bytes.length > 32 * 1024 * 1024 - writeBytes)
        return Promise.reject(new Error('Provider input capacity exceeded'));
      const copy = bytes.slice();
      writes++;
      writeBytes += copy.length;
      const accepted = tail.then(async () => {
        let offset = 0;
        while (offset < copy.length) {
          const count = await pipeOperation(
            lib,
            pipes[0],
            copy.subarray(offset, Math.min(offset + 65536, copy.length)),
            true,
            signal,
          );
          if (count === 'eof' || count < 1) throw new Error('Provider input made no progress');
          offset += count;
          await Bun.sleep(1);
        }
      });
      const settled = accepted.finally(() => {
        writes--;
        writeBytes -= copy.length;
      });
      tail = settled.catch(() => undefined);
      return settled;
    },
    closeInput() {
      inputClosing = true;
      return tail.then(() => {
        if (pipes[0].uncertain || pipes[0].busy) return fail('identity');
        if (!pipes[0].closed) {
          pipes[0].closed = true;
          try {
            close(lib, pipes[0].parent);
          } catch (error) {
            pipes[0].uncertain = true;
            throw error;
          }
        }
      });
    },
    terminate(mode) {
      if (mode !== 'terminate' && mode !== 'kill') return fail('identity');
      if (closed) return;
      if (closing) return fail('identity');
      // Completion uncertainty does not erase this exact retained Job's stop capability.
      debug.stop(debugJob, mode === 'kill');
    },
    close() {
      if (closed) return;
      if (closing || observe().state !== 'drained') return fail('identity');
      closing = true;
      let failed = false;
      const release = (handle: bigint) => {
        if (lib.symbols.CloseHandle(handle) === 0) failed = true;
      };
      for (const pipe of pipes) {
        if (pipe.busy || pipe.uncertain) {
          unknown = true;
          return fail('identity');
        }
        if (!pipe.closed) {
          pipe.closed = true;
          release(pipe.parent);
        }
        release(pipe.event);
      }
      for (const member of debugJob.members) release(member.completion);
      debugJob.usable = false;
      release(job);
      if (failed) {
        unknown = true;
        debug.quarantine(debugJob);
        return fail('io');
      }
      debug.released(debugJob);
      lib.close();
      closed = true;
    },
  };
}
