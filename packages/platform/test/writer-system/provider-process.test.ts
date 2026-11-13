import {dlopen, type FFIFunction} from 'bun:ffi';
import {windowsProcessIdentity} from '../../src/writer-system/windows-native.js';
import {windowsProviderCommandLine, WindowsDebugThreadLedger} from '../../src/writer-system/provider-windows.js';
import * as EffectString from 'effect/String';
import * as EffectArray from 'effect/Array';
import {expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {decodeUnreapedPosixExitStatus} from '../../src/writer-system/provider-posix.js';
import {
  runtimeSpawnOwnedProviderTree,
  runtimeObserveOwnedProviderTree,
  runtimeTerminateOwnedProviderTree,
  runtimeCloseOwnedProviderTree,
  runtimeProbeProviderTree,
  runtimeNativePlatformSupport,
  type RuntimeOwnedProviderProcess,
} from '../../src/system.js';

// Borrow only the original Job while its production owner retains it. No handles enter emitted metadata.
const jobSample = vi.hoisted(() => ({
  active: undefined as
    | {
        incomplete: boolean;
        getLastError(): number;
        setLastError(code: number): void;
        called(name: string, args: readonly unknown[], result: unknown): void;
      }
    | undefined,
}));
vi.mock('bun:ffi', async importOriginal => {
  const real = await importOriginal<typeof import('bun:ffi')>();
  return {
    ...real,
    dlopen: <Fns extends Record<string, FFIFunction>>(name: Parameters<typeof real.dlopen>[0], symbols: Fns) => {
      const library = real.dlopen(name, symbols),
        observed = new Map<string, (...args: unknown[]) => unknown>();
      for (const key of [
        'CreateJobObjectW',
        'QueryInformationJobObject',
        'TerminateJobObject',
        'CloseHandle',
        'GetCurrentThreadId',
        'WaitForDebugEvent',
        'ContinueDebugEvent',
        'DuplicateHandle',
        'ResumeThread',
        'WaitForSingleObject',
      ]) {
        const original: unknown = Reflect.get(library.symbols, key);
        if (typeof original !== 'function') continue;
        observed.set(key, (...args: unknown[]) => {
          const result: unknown = Reflect.apply(original, undefined, args);
          const active = jobSample.active;
          if (active) {
            let lastError: number | undefined;
            try {
              lastError = active.getLastError();
              // Failed native calls still belong to the caller; make no secondary observations of them.
              if ((result !== 0 && result !== 0n) || key === 'WaitForDebugEvent' || key === 'WaitForSingleObject')
                active.called(key, args, result);
            } catch {
              active.incomplete = true;
            } finally {
              try {
                if (lastError !== undefined) active.setLastError(lastError);
              } catch {
                active.incomplete = true;
              }
            }
          }
          return result;
        });
      }
      return {
        ...library,
        symbols: new Proxy(library.symbols, {
          get(target, key, receiver) {
            return typeof key === 'string' && observed.has(key)
              ? observed.get(key)
              : Reflect.get(target, key, receiver);
          },
        }),
      };
    },
  };
});

const supported = runtimeNativePlatformSupport().providerTree;

it('retains bounded debug thread roles until successful exit continuation and separates PI alias ownership', () => {
  const shared = {threads: 0, pi: 0},
    member = {},
    child = {},
    ledger = new WindowsDebugThreadLedger(shared, 3, 3, 1);
  expect(shared).toEqual({threads: 1, pi: 1});
  ledger.create(member, 10, true);
  ledger.releasePi(); // either one successful distinct PI close or transfer of the actual alias
  ledger.create(member, 11);
  ledger.create(child, 20);
  expect(shared).toEqual({threads: 3, pi: 0});
  expect(() => ledger.create(member, 12)).toThrow();
  expect(() => ledger.create(member, 11)).toThrow();
  expect(() => ledger.releasePi()).toThrow();
  // A pending/failed native continuation does not call an exit transition and keeps occupied roles.
  expect(ledger.live).toBe(3);
  ledger.exitThread(member, 11);
  expect(() => ledger.exitThread(member, 11)).toThrow();
  ledger.create(member, 11); // only successful retirement permits numeric TID reuse
  ledger.exitProcess(member); // final thread needs no separate EXIT_THREAD
  expect(shared).toEqual({threads: 1, pi: 0});
  ledger.exitProcess(child);
  expect(shared).toEqual({threads: 0, pi: 0});
  expect(() => ledger.exitProcess(child)).toThrow();
});

it('matches an independent active-thread model across bounded valid creation and exit orders', () => {
  fc.assert(
    fc.property(fc.uniqueArray(fc.integer({min: 2, max: 1000}), {maxLength: 6}), fc.nat(), (tids, cut) => {
      const shared = {threads: 0, pi: 0},
        member = {},
        ledger = new WindowsDebugThreadLedger(shared, 8, 8, 1),
        model = new Set([1]);
      ledger.create(member, 1, true);
      ledger.releasePi();
      for (const tid of tids) {
        ledger.create(member, tid);
        model.add(tid);
      }
      for (const tid of tids.slice(0, cut % (tids.length + 1))) {
        expect(ledger.live).toBe(model.size); // no release while an exit remains pending
        ledger.exitThread(member, tid);
        model.delete(tid);
        expect(shared.threads).toBe(model.size);
        expect(ledger.has(member, tid)).toBe(false);
      }
      ledger.exitProcess(member);
      expect(shared).toEqual({threads: 0, pi: 0});
      expect(ledger.live).toBe(0);
    }),
    {numRuns: 100},
  );
});

it('decodes unreaped kernel exit statuses without treating stop or malformed records as termination', () => {
  expect(decodeUnreapedPosixExitStatus(String(7 * 256))).toBe(7);
  fc.assert(
    fc.property(
      fc.oneof(
        fc.integer({min: 0, max: 255}).map(code => ({status: code * 256, code})),
        fc.record({signal: fc.integer({min: 1, max: 64}), core: fc.boolean()}).map(({signal, core}) => ({
          status: signal + (core ? 128 : 0),
          code: 128 + signal,
        })),
      ),
      ({status, code}) => {
        expect(decodeUnreapedPosixExitStatus(String(status))).toBe(code);
      },
    ),
    {numRuns: 100},
  );
  for (const invalid of [
    undefined,
    '',
    '-1',
    '1.5',
    'NaN',
    'Infinity',
    ' 1792',
    '01792',
    '65536',
    '127',
    '65535',
    '128',
    '257',
  ])
    expect(() => decodeUnreapedPosixExitStatus(invalid)).toThrow();
});

const spawn = (source: string) =>
  runtimeSpawnOwnedProviderTree({
    command: process.execPath,
    args: ['-e', source],
    cwd: process.cwd(),
    environment: process.env,
  });
async function until<T>(read: () => T, accept: (value: T) => boolean, milliseconds = 3000): Promise<T> {
  const deadline = Date.now() + milliseconds;
  while (true) {
    const value = read();
    if (accept(value)) return value;
    if (Date.now() >= deadline) throw new Error('Native provider fixture deadline expired');
    await Bun.sleep(5);
  }
}
async function stop(provider: RuntimeOwnedProviderProcess): Promise<void> {
  if (runtimeObserveOwnedProviderTree(provider.handle).state !== 'drained')
    runtimeTerminateOwnedProviderTree(provider.handle, 'kill');
  await until(
    () => runtimeObserveOwnedProviderTree(provider.handle),
    o => o.state === 'drained',
  );
  runtimeCloseOwnedProviderTree(provider.handle);
}

// Fixed test-only wire command. Its emitted function is the same decoder exercised below.
function fixtureExitCommand(progress: number, bytes: Uint8Array): number {
  const command = [101, 120, 105, 116, 10];
  if (
    !Number.isSafeInteger(progress) ||
    progress < 0 ||
    progress >= command.length ||
    bytes.length === 0 ||
    progress + bytes.length > command.length
  )
    throw new Error('Invalid bounded fixture exit command.');
  for (const byte of bytes) {
    if (byte !== command[progress]) throw new Error('Invalid bounded fixture exit command.');
    progress++;
  }
  return progress;
}
it('decodes the fixed exit command once across every byte partition and refuses malformed input', () => {
  const command = new TextEncoder().encode('exit\n');
  expect(fixtureExitCommand(fixtureExitCommand(0, command.subarray(0, 1)), command.subarray(1))).toBe(5);
  // Four boundaries give exactly sixteen partitions, independent of operating-system chunking.
  for (let mask = 0; mask < 16; mask++) {
    let start = 0,
      progress = 0;
    for (let end = 1; end <= command.length; end++) {
      if (end !== command.length && (mask & (1 << (end - 1))) === 0) continue;
      progress = fixtureExitCommand(progress, command.subarray(start, end));
      expect(progress === 5).toBe(end === command.length);
      start = end;
    }
    expect(progress).toBe(5);
    expect(() => fixtureExitCommand(progress, command)).toThrow();
  }
  for (const invalid of ['', 'x', 'exat', 'exit\r', 'exit\nextra'])
    expect(() => fixtureExitCommand(0, new TextEncoder().encode(invalid))).toThrow();
});

// These exercise the synchronous native spawn / Promise stdio boundary, rather than an Effect program.
it.skipIf(!supported)(
  'binds actual stdio and refuses close until whole-group zero, EOF and accepted writes settle',
  async () => {
    const provider = spawn(`for await(const bytes of Bun.stdin.stream()) await Bun.write(Bun.stdout,bytes);`);
    const output = new Response(provider.stdout).text(),
      errors = new Response(provider.stderr).text();
    try {
      expect(runtimeObserveOwnedProviderTree(provider.handle).state).toBe('running');
      expect(() => runtimeCloseOwnedProviderTree(provider.handle)).toThrow();
      expect(() => Reflect.apply(runtimeObserveOwnedProviderTree, undefined, [Object.freeze({})])).toThrow();
      expect(runtimeProbeProviderTree({pid: provider.pid, identity: provider.identity})).toBe(
        process.platform === 'win32' ? 'unknown' : 'present',
      );
      expect(runtimeProbeProviderTree({pid: provider.pid, identity: provider.identity + '-different'})).toBe('unknown');
      await provider.write(new TextEncoder().encode('native-stdio-fixture'));
      await provider.closeInput();
      expect(await output).toBe('native-stdio-fixture');
      expect(await errors).toBe('');
      const final = await until(
        () => runtimeObserveOwnedProviderTree(provider.handle),
        o => o.state === 'drained',
      );
      expect(final.leaderExitCode).toBe(0);
      expect(final.stdioClosed).toBe(true);
      expect(runtimeProbeProviderTree({pid: provider.pid, identity: provider.identity})).toBe(
        process.platform === 'win32' ? 'unknown' : 'absent',
      );
    } finally {
      await stop(provider);
    }
  },
);

it.skipIf(!supported)(
  'retains original group authority after leader exit and terminates its actual surviving descendant',
  async () => {
    const childSource = `process.stdout.write('descendant-ready'+String.fromCharCode(10));setInterval(()=>{},1000);`;
    // Windows uses native creation: Bun.spawn teardown must not decide whether the fixture child survives.
    const windows = process.platform === 'win32';
    const windowsLeader = windows
      ? `
      import {dlopen,ptr} from 'bun:ffi';
      const k=dlopen('kernel32.dll',{
        CreateProcessW:{args:['buffer','buffer','ptr','ptr','i32','u32','ptr','ptr','buffer','buffer'],returns:'i32'},
        GetStdHandle:{args:['u32'],returns:'u64'},
        GetCurrentProcess:{args:[],returns:'u64'},GetLastError:{args:[],returns:'u32'},
        DuplicateHandle:{args:['u64','u64','u64','buffer','u32','i32','u32'],returns:'i32'},
        GetHandleInformation:{args:['u64','buffer'],returns:'i32'},
        InitializeProcThreadAttributeList:{args:['ptr','u32','u32','buffer'],returns:'i32'},
        UpdateProcThreadAttribute:{args:['buffer','u32','u64','buffer','u64','ptr','ptr'],returns:'i32'},
        DeleteProcThreadAttributeList:{args:['buffer'],returns:'void'},
        GetProcessTimes:{args:['u64','buffer','buffer','buffer','buffer'],returns:'i32'},
        ResumeThread:{args:['u64'],returns:'u32'},CloseHandle:{args:['u64'],returns:'i32'}
      });
      const wide=s=>{const b=new Uint16Array(s.length+1);for(let i=0;i<s.length;i++)b[i]=s.charCodeAt(i);return b;};
      const failed=(stage,code)=>{throw new Error('Native fixture '+stage+' failed: '+code);};
      const startup=new BigUint64Array(14), v=new DataView(startup.buffer), info=new BigUint64Array(3),
        handles=new BigUint64Array(new ArrayBuffer(24)), attributeSize=new BigUint64Array(1);
      let attributes,attributesReady=false;
      try {
        const current=k.symbols.GetCurrentProcess();
        for(let i=0;i<3;i++) {
          const source=k.symbols.GetStdHandle(0xfffffff6-i), duplicate=new BigUint64Array(1), flags=new Uint32Array(1);
          if(source===0n||source===0xffffffffffffffffn)failed('std-handles',0);
          if(k.symbols.DuplicateHandle(current,source,current,duplicate,0,1,2)!==1)failed('std-handles',k.symbols.GetLastError());
          handles[i]=duplicate[0];
          if(k.symbols.GetHandleInformation(handles[i],flags)!==1)failed('std-handles',k.symbols.GetLastError());
          if((flags[0]&1)!==1)failed('std-handles',0);
        }
        if(k.symbols.InitializeProcThreadAttributeList(null,1,0,attributeSize)!==0)failed('attributes',0);
        const sizeError=k.symbols.GetLastError();
        if(sizeError!==122||attributeSize[0]===0n||attributeSize[0]>65536n)failed('attributes',sizeError);
        const attributeBuffer=new ArrayBuffer(Number(attributeSize[0]));
        attributes=new Uint8Array(attributeBuffer);
        const attributeAddress=ptr(attributes);
        if(k.symbols.InitializeProcThreadAttributeList(attributeAddress,1,0,attributeSize)!==1)failed('attributes',k.symbols.GetLastError());
        attributesReady=true;
        if(k.symbols.UpdateProcThreadAttribute(attributes,0,0x00020002n,handles,24n,null,null)!==1)failed('attributes',k.symbols.GetLastError());
        v.setUint32(0,112,true);v.setUint32(60,0x100,true);
        startup[10]=handles[0];startup[11]=handles[1];startup[12]=handles[2];startup[13]=BigInt(attributeAddress);
        // No breakaway/new Job: this suspended child inherits the leader's original native Job.
        if(k.symbols.CreateProcessW(wide(${JSON.stringify(process.execPath)}),wide(${JSON.stringify(windowsProviderCommandLine(process.execPath, ['-e', childSource]))}),null,null,1,0x08080004,null,null,startup,info)!==1)failed('create',k.symbols.GetLastError());
        const creation=new BigUint64Array(1), exit=new BigUint64Array(1), kernel=new BigUint64Array(1), user=new BigUint64Array(1);
        if(k.symbols.GetProcessTimes(info[0],creation,exit,kernel,user)!==1)failed('identity',k.symbols.GetLastError());
        if(creation[0]===0n)failed('identity',0);
        await Bun.write(Bun.stdout,JSON.stringify({childPid:new DataView(info.buffer).getUint32(16,true),childIdentity:'win32:'+(creation[0]+504911232000000000n)})+String.fromCharCode(10));
        if(k.symbols.ResumeThread(info[1])!==1)failed('resume',k.symbols.GetLastError());
        const decodeExitCommand=${fixtureExitCommand.toString()};
        let commandBytes=0;
        for await(const bytes of Bun.stdin.stream()) {commandBytes=decodeExitCommand(commandBytes,bytes);if(commandBytes===5)break;}
        if(commandBytes!==5)throw new Error('Incomplete fixture exit command.');
      } finally {
        let closed=true;
        if(attributesReady)k.symbols.DeleteProcThreadAttributeList(attributes);
        for(const handle of handles)if(handle!==0n&&k.symbols.CloseHandle(handle)!==1)closed=false;
        for(const handle of [info[1],info[0]])if(handle!==0n&&k.symbols.CloseHandle(handle)!==1)closed=false;
        k.close();
        if(!closed)failed('cleanup',0);
      }
      process.exit(7);
    `
      : '';
    const kernel = windows
      ? dlopen('kernel32.dll', {
          OpenProcess: {args: ['u32', 'i32', 'u32'], returns: 'u64'},
          WaitForSingleObject: {args: ['u64', 'u32'], returns: 'u32'},
          IsProcessInJob: {args: ['u64', 'u64', 'buffer'], returns: 'i32'},
          GetLastError: {args: [], returns: 'u32'},
          SetLastError: {args: ['u32'], returns: 'void'},
          CloseHandle: {args: ['u64'], returns: 'i32'},
        })
      : undefined;
    type JobQuery = {
      active: number;
      total: number;
      terminatedByLimit: number;
      childMember: 'yes' | 'no' | 'unknown';
      membershipCode: number;
      childWait: number;
    };
    let childHandle = 0n,
      originalJob = 0n,
      jobClosed = false,
      queryCount = 0,
      terminationCalls = 0,
      beforeTermination: JobQuery | undefined,
      firstAfterTermination: JobQuery | undefined,
      lastAfterTermination: JobQuery | undefined,
      firstZeroAfterTermination: JobQuery | undefined,
      drainedQuery: JobQuery | undefined,
      drainedChildWait: number | undefined;
    const priorJobSample = jobSample.active;
    const observation: NonNullable<typeof jobSample.active> = {
      incomplete: false,
      getLastError() {
        if (!kernel) throw new Error('Windows observation has no native kernel boundary.');
        return kernel.symbols.GetLastError();
      },
      setLastError(code) {
        if (!kernel) throw new Error('Windows observation has no native kernel boundary.');
        kernel.symbols.SetLastError(code);
      },
      called(name, args, result) {
        if (name === 'CreateJobObjectW') {
          if (originalJob !== 0n || typeof result !== 'bigint' || result === 0xffffffffffffffffn) {
            observation.incomplete = true;
            return;
          }
          originalJob = result;
          return;
        }
        if (args[0] !== originalJob || originalJob === 0n) return;
        if (name === 'CloseHandle') {
          jobClosed = true;
          return;
        }
        if (jobClosed) {
          observation.incomplete = true;
          return;
        }
        if (name === 'TerminateJobObject') {
          terminationCalls++;
          return;
        }
        if (name !== 'QueryInformationJobObject' || childHandle === 0n || !kernel) return;
        if (
          typeof result !== 'number' ||
          result === 0 ||
          args[1] !== 1 ||
          !(args[2] instanceof Uint8Array) ||
          args[2].byteLength !== 48 ||
          args[3] !== 48 ||
          !(args[4] instanceof Uint32Array) ||
          args[4][0] !== 48 ||
          ++queryCount > 10000
        ) {
          observation.incomplete = true;
          return;
        }
        const view = new DataView(args[2].buffer, args[2].byteOffset, args[2].byteLength),
          member = new Int32Array(1),
          membershipResult = kernel.symbols.IsProcessInJob(childHandle, originalJob, member),
          membershipCode = membershipResult === 0 ? kernel.symbols.GetLastError() : 0,
          query: JobQuery = {
            active: view.getUint32(40, true),
            total: view.getUint32(36, true),
            terminatedByLimit: view.getUint32(44, true),
            childMember: membershipResult === 0 ? 'unknown' : member[0] !== 0 ? 'yes' : 'no',
            membershipCode,
            childWait: kernel.symbols.WaitForSingleObject(childHandle, 0),
          };
        if (terminationCalls === 0) beforeTermination = query;
        else {
          firstAfterTermination ??= query;
          lastAfterTermination = query;
          if (query.active === 0) firstZeroAfterTermination ??= query;
        }
      },
    };
    if (windows) jobSample.active = observation;
    const provider = (() => {
      try {
        return spawn(
          windows
            ? windowsLeader
            : `Bun.spawn([process.execPath,'-e',${JSON.stringify(childSource)}],{stdin:'ignore',stdout:'inherit',stderr:'inherit'});setTimeout(()=>process.exit(7),100);`,
        );
      } catch (error) {
        jobSample.active = priorJobSample;
        kernel?.close();
        throw error;
      }
    })();
    const reader = provider.stdout.getReader();
    let output = '';
    const collect = (async () => {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        output += new TextDecoder().decode(item.value);
      }
    })();
    const errors = new Response(provider.stderr).text();
    let passed = false;
    try {
      await until(
        () => output,
        text => EffectString.includes('descendant-ready')(text),
      );
      if (kernel) {
        const record = await until(
          () => {
            for (const line of EffectString.split(output, '\n')) {
              if (!EffectString.startsWith('{')(line) || !EffectString.endsWith('}')(line)) continue;
              const value: unknown = JSON.parse(line);
              if (
                typeof value === 'object' &&
                value !== null &&
                'childPid' in value &&
                typeof value.childPid === 'number' &&
                Number.isSafeInteger(value.childPid) &&
                value.childPid > 0 &&
                value.childPid <= 0xffffffff &&
                'childIdentity' in value &&
                typeof value.childIdentity === 'string' &&
                /^win32:[0-9]+$/u.test(value.childIdentity)
              )
                return {pid: value.childPid, identity: value.childIdentity};
            }
            return undefined;
          },
          value => value !== undefined,
        );
        if (!record) throw new Error('Native child identity was not observed.');
        childHandle = kernel.symbols.OpenProcess(0x00101000, 0, record.pid);
        expect(childHandle !== 0n && childHandle !== 0xffffffffffffffffn).toBe(true);
        expect(windowsProcessIdentity(childHandle, record.pid) === record.identity).toBe(true);
        expect(kernel.symbols.WaitForSingleObject(childHandle, 0)).toBe(258);
        await provider.write(new TextEncoder().encode('exit\n'));
      }
      const leaderExited = await until(
        () => runtimeObserveOwnedProviderTree(provider.handle),
        o => o.leaderExitCode === 7,
      );
      // Query the same retained creation-authenticated HANDLE after leader exit, before backend-state assertions.
      if (kernel) {
        expect(kernel.symbols.WaitForSingleObject(childHandle, 0)).toBe(258);
        expect(beforeTermination?.childMember).toBe('yes');
        expect(beforeTermination?.active).toBeGreaterThanOrEqual(1);
      }
      expect(leaderExited.state).toBe('running');
      expect(leaderExited.stdioClosed).toBe(false);
      runtimeTerminateOwnedProviderTree(provider.handle, 'kill');
      if (kernel) expect(terminationCalls).toBe(1);
      await provider.closeInput();
      await collect;
      expect(await errors).toBe('');
      const final = await until(
        () => runtimeObserveOwnedProviderTree(provider.handle),
        o => o.state === 'drained',
      );
      expect(final.leaderExitCode).toBe(7);
      if (kernel) {
        drainedQuery = lastAfterTermination;
        drainedChildWait = kernel.symbols.WaitForSingleObject(childHandle, 0);
        expect(drainedQuery?.active).toBe(0);
        expect(drainedQuery?.childWait).toBe(0);
        expect(drainedChildWait).toBe(0);
        expect(observation.incomplete).toBe(false);
      }
      passed = true;
    } finally {
      try {
        await stop(provider);
        if (windows && (!passed || observation.incomplete || !jobClosed)) {
          const settled = await Promise.allSettled([collect, errors]),
            stderr = settled[1].status === 'fulfilled' ? settled[1].value : '',
            failure =
              /Native fixture (std-handles|attributes|create|identity|resume|cleanup) failed: ([0-9]{1,10})/u.exec(
                stderr,
              );
          process.stdout.write(
            'WINDOWS_CHILD_SAMPLE ' +
              JSON.stringify({
                nativeStage: failure?.[1] ?? 'unobserved',
                nativeCode: failure ? Number(failure[2]) : null,
                originalJobObserved: originalJob !== 0n,
                originalJobClosed: jobClosed,
                jobObservationIncomplete: observation.incomplete,
                queryCount,
                terminationCalls,
                beforeTermination,
                firstAfterTermination,
                firstZeroAfterTermination,
                lastAfterTermination,
                drainedQuery,
                drainedChildWait,
                receiptObserved: /"childIdentity":"win32:[0-9]+"/u.test(output),
                childReadyObserved: EffectString.includes('descendant-ready')(output),
                stdoutBytes: new TextEncoder().encode(output).length,
                stderrBytes: new TextEncoder().encode(stderr).length,
                streamReadFailed: EffectArray.some(settled, result => result.status === 'rejected'),
              }) +
              String.fromCharCode(10),
          );
        }
        if (windows) {
          expect(observation.incomplete).toBe(false);
          expect(jobClosed).toBe(true);
        }
      } finally {
        jobSample.active = priorJobSample;
        if (kernel) {
          if (childHandle !== 0n && childHandle !== 0xffffffffffffffffn)
            expect(kernel.symbols.CloseHandle(childHandle)).toBe(1);
          kernel.close();
        }
      }
    }
  },
);

it.skipIf(process.platform !== 'win32' || !supported)(
  'captures fast native children and real worker threads across two interleaved original Jobs',
  async () => {
    const kernel = dlopen('kernel32.dll', {
      GetLastError: {args: [], returns: 'u32'},
      SetLastError: {args: ['u32'], returns: 'void'},
    });
    const prior = jobSample.active,
      creatorIds = new Set<number>(),
      processes = new Map<number, {process: bigint; threads: Map<number, bigint>; exit: boolean}>(),
      borrowed = new Set<bigint>();
    let pending: {kind: number; pid: number; tid: number} | undefined,
      creates = 0,
      threadCreates = 0,
      exits = 0,
      emptyPolls = 0,
      resumes = 0;
    const observation: NonNullable<typeof jobSample.active> = {
      incomplete: false,
      getLastError: () => kernel.symbols.GetLastError(),
      setLastError: code => kernel.symbols.SetLastError(code),
      called(name, args, result) {
        if (name === 'GetCurrentThreadId' && typeof result === 'number') creatorIds.add(result);
        if (name === 'WaitForDebugEvent') {
          if (result === 0) {
            expect(kernel.symbols.GetLastError()).toBe(121);
            emptyPolls++;
            return;
          }
          expect(pending).toBeUndefined();
          if (!(args[0] instanceof Uint8Array)) throw new Error('No actual debug event backing.');
          const view = new DataView(args[0].buffer, args[0].byteOffset, args[0].byteLength);
          pending = {kind: view.getUint32(0, true), pid: view.getUint32(4, true), tid: view.getUint32(8, true)};
          const {kind, pid, tid} = pending;
          if (kind === 3) {
            const process = view.getBigUint64(24, true),
              thread = view.getBigUint64(32, true);
            expect(processes.has(pid)).toBe(false);
            processes.set(pid, {process, threads: new Map([[tid, thread]]), exit: false});
            borrowed.add(process);
            borrowed.add(thread);
            creates++;
          } else if (kind === 2) {
            const member = processes.get(pid),
              thread = view.getBigUint64(16, true);
            if (!member) throw new Error('Thread without native CREATE.');
            expect(member.threads.has(tid)).toBe(false);
            member.threads.set(tid, thread);
            borrowed.add(thread);
            threadCreates++;
          }
        }
        if (name === 'CloseHandle') expect(borrowed.has(BigInt(String(args[0])))).toBe(false);
        if (name === 'ResumeThread') {
          expect(result).toBe(1);
          resumes++;
        }
        if (name === 'ContinueDebugEvent') {
          expect(result).toBe(1);
          if (!pending) throw new Error('Continue without actual delivered event.');
          expect(args.slice(0, 2)).toEqual([pending.pid, pending.tid]);
          const member = processes.get(pending.pid);
          if (!member) throw new Error('Continue without captured native process.');
          if (pending.kind === 4) {
            const thread = member.threads.get(pending.tid);
            if (thread === undefined) throw new Error('Exit without captured native thread.');
            borrowed.delete(thread);
            member.threads.delete(pending.tid);
          }
          if (pending.kind === 5) {
            borrowed.delete(member.process);
            for (const thread of member.threads.values()) borrowed.delete(thread);
            member.threads.clear();
            member.exit = true;
            exits++;
          }
          pending = undefined;
        }
      },
    };
    jobSample.active = observation;
    const providers: RuntimeOwnedProviderProcess[] = [];
    try {
      providers.push(
        spawn(`
        const worker = new Worker(URL.createObjectURL(new Blob(['postMessage("ready");close();'], {type:'application/javascript'})));
        await new Promise((resolve,reject)=>{worker.onmessage=resolve;worker.onerror=reject;});
        await Promise.all(Array.from({length:3},()=>Bun.spawn([process.execPath,'-e','process.exit(0)'],{stdout:'ignore',stderr:'ignore'}).exited));
        process.stdout.write('first');
      `),
      );
      providers.push(spawn("for await (const bytes of Bun.stdin.stream()) {} process.stdout.write('second');"));
      const outputs = EffectArray.map(providers, provider => new Response(provider.stdout).text()),
        errors = EffectArray.map(providers, provider => new Response(provider.stderr).text());
      // Keep the second actual debuggee alive until a genuine empty/121 poll is observed.
      // The existing input EOF releases it; queue scheduling cannot erase this proof obligation.
      await until(
        () => emptyPolls,
        count => count > 0,
      );
      for (const provider of providers) await provider.closeInput();
      expect(await Promise.all(outputs)).toEqual(['first', 'second']);
      expect(await Promise.all(errors)).toEqual(['', '']);
      for (const provider of providers)
        await until(
          () => runtimeObserveOwnedProviderTree(provider.handle),
          o => o.state === 'drained',
        );
      expect(creates).toBe(5);
      expect(exits).toBe(creates);
      expect(threadCreates).toBeGreaterThan(0);
      expect(emptyPolls).toBeGreaterThan(0);
      expect(resumes).toBe(2);
      expect(creatorIds.size).toBe(1);
      expect(pending).toBeUndefined();
      expect(borrowed.size).toBe(0);
      expect(observation.incomplete).toBe(false);
    } finally {
      try {
        for (const provider of providers) await stop(provider);
      } finally {
        jobSample.active = prior;
        kernel.close();
      }
    }
  },
);

it.skipIf(process.platform !== 'win32' || !supported)(
  'keeps actual debugger-chain override coverage UNKNOWN in an isolated owning host',
  async () => {
    // This root really becomes a second debugger. Its creation-owned duplicate proves inner cleanup;
    // its inherited original Job lifetime total still cannot supply the missing production CREATE handle.
    const fixture = `
      import {dlopen} from 'bun:ffi';
      const k=dlopen('kernel32.dll',{
        CreateProcessW:{args:['buffer','buffer','ptr','ptr','i32','u32','ptr','ptr','buffer','buffer'],returns:'i32'},
        GetCurrentProcess:{args:[],returns:'u64'},DuplicateHandle:{args:['u64','u64','u64','buffer','u32','i32','u32'],returns:'i32'},
        WaitForDebugEvent:{args:['buffer','u32'],returns:'i32'},ContinueDebugEvent:{args:['u32','u32','u32'],returns:'i32'},
        WaitForSingleObject:{args:['u64','u32'],returns:'u32'},CloseHandle:{args:['u64'],returns:'i32'},GetLastError:{args:[],returns:'u32'}
      });
      const wide=s=>{const b=new Uint16Array(s.length+1);for(let i=0;i<s.length;i++)b[i]=s.charCodeAt(i);return b;};
      const startup=new BigUint64Array(13),info=new BigUint64Array(3),completion=new BigUint64Array(1),
        event=new Uint8Array(208),view=new DataView(event.buffer);
      new DataView(startup.buffer).setUint32(0,104,true);
      const check=v=>{if(!v)throw new Error('Native override fixture failed.');};
      check(k.symbols.CreateProcessW(wide(process.execPath),wide(${JSON.stringify(windowsProviderCommandLine(process.execPath, ['-e', 'process.exit(0)']))}),null,null,0,0x08000001,null,null,startup,info));
      const self=k.symbols.GetCurrentProcess();check(k.symbols.DuplicateHandle(self,info[0],self,completion,0x00101000,0,0));
      const deadline=Date.now()+2500;let exited=false,initial=true;
      while(!exited&&Date.now()<deadline){
        event.fill(0xa5);
        if(!k.symbols.WaitForDebugEvent(event.subarray(0,176),0)){check(k.symbols.GetLastError()===121);await Bun.sleep(1);continue;}
        check(event.subarray(176).every(v=>v===0xa5));
        const kind=view.getUint32(0,true),pid=view.getUint32(4,true),tid=view.getUint32(8,true);let status=0x10002;
        if(kind===3){
          if(info[0]!==view.getBigUint64(24,true))check(k.symbols.CloseHandle(info[0]));
          if(info[1]!==view.getBigUint64(32,true))check(k.symbols.CloseHandle(info[1]));
        }
        if(kind===3||kind===6){const file=view.getBigUint64(16,true);if(file!==0n)check(k.symbols.CloseHandle(file));}
        if(kind===1){if(initial&&view.getUint32(16,true)===0x80000003&&view.getUint32(168,true)===1)initial=false;else status=0x80010001;}
        check(kind>=1&&kind<=8);check(k.symbols.ContinueDebugEvent(pid,tid,status));
        if(kind===5)exited=true;
      }
      check(exited);
      while(k.symbols.WaitForSingleObject(completion[0],0)===258&&Date.now()<deadline)await Bun.sleep(1);
      check(k.symbols.WaitForSingleObject(completion[0],0)===0);check(k.symbols.CloseHandle(completion[0]));k.close();
    `;
    const host = `
      const api=await import(${JSON.stringify(new URL('../../src/system.ts', import.meta.url).href)});
      const provider=api.runtimeSpawnOwnedProviderTree({command:process.execPath,args:['-e',${JSON.stringify(fixture)}],cwd:process.cwd(),environment:process.env});
      const output=new Response(provider.stdout).text(),errors=new Response(provider.stderr).text();
      await provider.closeInput();await output;const stderr=await errors;
      let observation;const deadline=Date.now()+3000;
      do { observation=api.runtimeObserveOwnedProviderTree(provider.handle);if(observation.state==='unknown')break;await Bun.sleep(5); }while(Date.now()<deadline);
      let closeRefused=false;try{api.runtimeCloseOwnedProviderTree(provider.handle);}catch{closeRefused=true;}
      api.runtimeTerminateOwnedProviderTree(provider.handle,'kill');
      process.stdout.write(JSON.stringify({state:observation.state,leaderExitCode:observation.leaderExitCode,closeRefused,stderr}));
    `;
    const child = Bun.spawn([process.execPath, '-e', host], {stdout: 'pipe', stderr: 'pipe'}),
      output = new Response(child.stdout).text(),
      errors = new Response(child.stderr).text();
    try {
      expect(await child.exited).toBe(0);
      expect(await errors).toBe('');
      expect(JSON.parse(await output)).toEqual({state: 'unknown', leaderExitCode: 0, closeRefused: true, stderr: ''});
    } finally {
      if (child.exitCode === null) child.kill();
    }
  },
);

it.skipIf(!supported)(
  'cancels a real full-pipe input without blocking escalation and drains cancelled output readers',
  async () => {
    const provider = spawn('setInterval(()=>{},1000)');
    const controller = new AbortController();
    const output = provider.stdout.cancel(),
      errors = provider.stderr.cancel();
    try {
      const write = provider.write(new Uint8Array(2 * 1024 * 1024), controller.signal);
      const rejection = expect(write).rejects.toThrow();
      await Bun.sleep(20);
      controller.abort(new Error('cancel fixture'));
      await rejection;
      runtimeTerminateOwnedProviderTree(provider.handle, 'kill');
      await provider.closeInput();
      await output;
      await errors;
      expect(
        (
          await until(
            () => runtimeObserveOwnedProviderTree(provider.handle),
            o => o.state === 'drained',
          )
        ).stdioClosed,
      ).toBe(true);
    } finally {
      await stop(provider);
    }
  },
);

it.skipIf(!supported)('allows finite cancellation while an actual provider continuously fills output', async () => {
  const provider = spawn('const bytes=new Uint8Array(65536);while(true)await Bun.write(Bun.stdout,bytes)');
  const stdout = provider.stdout.cancel(),
    stderr = provider.stderr.cancel();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    runtimeTerminateOwnedProviderTree(provider.handle, 'kill');
  }, 30);
  try {
    await stdout;
    await stderr;
    await provider.closeInput();
    expect(fired).toBe(true);
    await until(
      () => runtimeObserveOwnedProviderTree(provider.handle),
      o => o.state === 'drained',
    );
  } finally {
    clearTimeout(timer);
    await stop(provider);
  }
});

it.skipIf(!supported)('retains the native unreaped group anchor while independent Bun children complete', async () => {
  const provider = spawn('process.exit(3)');
  const output = new Response(provider.stdout).text(),
    errors = new Response(provider.stderr).text();
  try {
    await output;
    await errors;
    await provider.closeInput();
    for (let attempt = 0; attempt < 3; attempt++) {
      const other = Bun.spawn([process.execPath, '-e', 'process.exit(0)'], {stdout: 'ignore', stderr: 'ignore'});
      expect(await other.exited).toBe(0);
    }
    const final = await until(
      () => runtimeObserveOwnedProviderTree(provider.handle),
      o => o.state === 'drained',
    );
    expect(final.leaderExitCode).toBe(3);
  } finally {
    await stop(provider);
  }
});

it.skipIf(process.platform !== 'win32' || !supported)(
  'atomically contains native child creation and refuses an actual Job breakaway request',
  async () => {
    const fixture = `
    import {dlopen} from 'bun:ffi';
    const k=dlopen('kernel32.dll',{
      CreateProcessW:{args:['buffer','buffer','ptr','ptr','i32','u32','ptr','ptr','buffer','buffer'],returns:'i32'},
      CloseHandle:{args:['u64'],returns:'i32'},GetLastError:{args:[],returns:'u32'}
    });
    const wide=s=>{const b=new Uint16Array(s.length+1);for(let i=0;i<s.length;i++)b[i]=s.charCodeAt(i);return b;};
    const app=process.execPath;
    const run=flags=>{const start=new BigUint64Array(13);new DataView(start.buffer).setUint32(0,104,true);const info=new BigUint64Array(3);
      const ok=k.symbols.CreateProcessW(wide(app),wide('"'+app+'" -e "process.exit(0)"'),null,null,0,0x08000000|flags,null,null,start,info);
      const error=ok?0:k.symbols.GetLastError();if(ok){k.symbols.CloseHandle(info[1]);k.symbols.CloseHandle(info[0]);}return {ok,error};};
    process.stdout.write(JSON.stringify({contained:run(0),breakaway:run(0x01000000)})+String.fromCharCode(10));k.close();
  `;
    const provider = spawn(fixture);
    const output = new Response(provider.stdout).text(),
      errors = new Response(provider.stderr).text();
    try {
      await provider.closeInput();
      expect(JSON.parse(await output)).toEqual({contained: {ok: 1, error: 0}, breakaway: {ok: 0, error: 5}});
      expect(await errors).toBe('');
      await until(
        () => runtimeObserveOwnedProviderTree(provider.handle),
        o => o.state === 'drained',
      );
    } finally {
      await stop(provider);
    }
  },
);

it.skipIf(!supported)(
  'signals only the captured original group or Job and leaves a separate owned provider running',
  async () => {
    const first = spawn('setInterval(()=>{},1000)'),
      second = spawn('setInterval(()=>{},1000)');
    const outputs = [first.stdout.cancel(), first.stderr.cancel(), second.stdout.cancel(), second.stderr.cancel()];
    try {
      runtimeTerminateOwnedProviderTree(first.handle, 'kill');
      await first.closeInput();
      await outputs[0];
      await outputs[1];
      await until(
        () => runtimeObserveOwnedProviderTree(first.handle),
        o => o.state === 'drained',
      );
      expect(runtimeObserveOwnedProviderTree(second.handle).state).toBe('running');
    } finally {
      await stop(first);
      await stop(second);
      await Promise.all(outputs);
    }
  },
);

it.skipIf(process.platform !== 'win32' || !supported)(
  'round-trips actual Windows argv without a shell, including empty, quote, backslash and metacharacter arguments',
  async () => {
    const expected = ['', 'space value', 'quote"value', 'tail\\', '\\"', '%PATH%&|^<>'];
    const provider = runtimeSpawnOwnedProviderTree({
      command: process.execPath,
      args: [
        '-e',
        'process.stdout.write(JSON.stringify(process.argv.slice(1))+String.fromCharCode(10))',
        '--',
        ...expected,
      ],
      cwd: process.cwd(),
      environment: process.env,
    });
    const output = new Response(provider.stdout).text(),
      errors = new Response(provider.stderr).text();
    try {
      await provider.closeInput();
      expect(JSON.parse(await output)).toEqual(expected);
      expect(await errors).toBe('');
      await until(
        () => runtimeObserveOwnedProviderTree(provider.handle),
        o => o.state === 'drained',
      );
    } finally {
      await stop(provider);
    }
  },
);

it.skipIf(!supported)(
  'drains actual stdout through EOF when its reader cancels immediately after one delivered chunk',
  async () => {
    const provider = spawn("process.stdout.write('one'+String.fromCharCode(10));setInterval(()=>{},1000)");
    const reader = provider.stdout.getReader();
    const errors = provider.stderr.cancel();
    try {
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(first.value!.length).toBeGreaterThan(0);
      const cancelled = reader.cancel();
      runtimeTerminateOwnedProviderTree(provider.handle, 'kill');
      await provider.closeInput();
      await cancelled;
      await errors;
      const final = await until(
        () => runtimeObserveOwnedProviderTree(provider.handle),
        o => o.state === 'drained',
      );
      expect(final.stdioClosed).toBe(true);
    } finally {
      reader.releaseLock();
      await stop(provider);
    }
  },
);
