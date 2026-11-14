import {Array as EffectArray} from 'effect';
import {expect, it, vi} from 'vitest';
import {runtimeAssertPrivateProviderPath, RuntimeWriterFault} from '../../src/system.js';

const supported =
  (process.platform === 'darwin' || process.platform === 'linux') &&
  (process.arch === 'arm64' || process.arch === 'x64');
const fs = process.getBuiltinModule('fs'),
  path = process.getBuiltinModule('path'),
  os = process.getBuiltinModule('os');
function fixture(run: (folder: string, sibling: string) => void): void {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'provider-directory-proof-'))),
    sibling = `${folder}-owned-sibling`;
  try {
    run(folder, sibling);
  } finally {
    fs.rmSync(folder, {recursive: true, force: true});
    fs.rmSync(`${folder}-moved`, {recursive: true, force: true});
    fs.rmSync(sibling, {force: true});
    fs.rmSync(`${sibling}-second`, {force: true});
  }
}
function sampleChanges(target: string, change: (sample: number, fd: number) => void, run: () => void): number {
  const anchor = fs.statSync(target, {bigint: true}),
    original = fs.fstatSync.bind(fs);
  let samples = 0;
  const spy = vi.spyOn(fs, 'fstatSync').mockImplementation((fd, options) => {
    const current = original(fd, options);
    if (options?.bigint && current.dev === anchor.dev && current.ino === anchor.ino) {
      change(++samples, fd);
    }
    // Mutations happen after the actual observation; never substitute a post-mutation sample.
    return current;
  });
  try {
    run();
    return samples;
  } finally {
    spy.mockRestore();
  }
}
it.skipIf(!supported)('accepts one actual owned sibling creation between ancestry capture and a fresh ACL sample', () =>
  fixture((folder, sibling) => {
    runtimeAssertPrivateProviderPath(folder, {kind: 'directory'});
    let injected = false;
    sampleChanges(
      path.dirname(folder),
      sample => {
        if (sample === 2) {
          fs.writeFileSync(sibling, 'owned fixture', {mode: 0o600});
          injected = true;
        }
      },
      () => {
        expect(() => runtimeAssertPrivateProviderPath(folder, {kind: 'directory'})).not.toThrow();
      },
    );
    expect(injected).toBe(true);
    expect(fs.readFileSync(sibling, 'utf8')).toBe('owned fixture');
    expect(fs.readdirSync(folder)).toEqual([]);
  }),
);
// Exhaust the finite role/count contract: unrelated ancestor entries never spend the
// selected directory's one coherent retry; a second selected-entry change must refuse.
for (const role of ['ancestor', 'selected'] as const)
  for (const changes of [1, 2] as const) {
    it.skipIf(!supported)(`${role} directory proof preserves bytes across ${changes} real entry changes`, () =>
      fixture((folder, sibling) => {
        const sentinel = path.join(folder, 'private.json');
        fs.writeFileSync(sentinel, 'PRIVATE_ORIGINAL', {mode: 0o600});
        runtimeAssertPrivateProviderPath(folder, {kind: 'directory'});
        const originalClose = fs.closeSync.bind(fs);
        let retained: number | undefined;
        let namedCloses = 0;
        const aliases = new Set<number>();
        const close = vi.spyOn(fs, 'closeSync').mockImplementation(fd => {
          const result = originalClose(fd);
          if (aliases.delete(fd)) namedCloses++;
          return result;
        });
        const writes = vi.spyOn(fs, 'writeFileSync');
        const entries: string[] = [];
        const cuts = role === 'ancestor' ? [3, 5] : [3, 7];
        try {
          const samples = sampleChanges(
            role === 'ancestor' ? path.dirname(folder) : folder,
            (sample, fd) => {
              if (role === 'selected') {
                retained ??= fd;
                if (fd !== retained) aliases.add(fd);
              }
              if (sample === cuts[0] || (changes === 2 && sample === cuts[1])) {
                const file =
                  role === 'ancestor'
                    ? entries.length === 0
                      ? sibling
                      : `${sibling}-second`
                    : path.join(folder, `owned-change-${entries.length}`);
                fs.writeFileSync(file, `owned entry ${entries.length}`, {flag: 'wx', mode: 0o600});
                entries.push(file);
              }
            },
            () => {
              const assert = () => runtimeAssertPrivateProviderPath(folder, {kind: 'directory'});
              if (role === 'selected' && changes === 2) expect(assert).toThrow(RuntimeWriterFault);
              else expect(assert).not.toThrow();
            },
          );
          expect(samples).toBeGreaterThanOrEqual(cuts[changes - 1]);
          expect(entries).toHaveLength(changes);
          expect(writes).toHaveBeenCalledTimes(changes);
          if (role === 'selected') {
            // Each complete selected-directory attempt owns one fresh named alias, including FD reuse.
            expect(namedCloses).toBe(2);
            expect(aliases.size).toBe(0);
          }
          expect(fs.readFileSync(sentinel, 'utf8')).toBe('PRIVATE_ORIGINAL');
          for (const [index, file] of entries.entries())
            expect(fs.readFileSync(file, 'utf8')).toBe(`owned entry ${index}`);
          expect(fs.readdirSync(folder).sort()).toEqual(
            role === 'ancestor'
              ? ['private.json']
              : [...EffectArray.map(entries, file => path.basename(file)), 'private.json'].sort(),
          );
        } finally {
          writes.mockRestore();
          close.mockRestore();
        }
      }),
    );
  }
it.skipIf(!supported)('refuses an actual changed private directory mode without a metadata retry', () =>
  fixture(folder => {
    let changed = false;
    let restored = false;
    const samples = sampleChanges(
      folder,
      sample => {
        if (sample === 2) {
          fs.chmodSync(folder, 0o750);
          changed = true;
        }
        if (sample === 6) {
          fs.chmodSync(folder, 0o700);
          restored = true;
        }
      },
      () => {
        expect(() => runtimeAssertPrivateProviderPath(folder, {kind: 'directory'})).toThrow();
      },
    );
    expect(changed).toBe(true);
    expect(restored).toBe(false);
    expect(samples).toBeLessThan(6);
    expect(fs.statSync(folder).mode & 0o777).toBe(0o750);
  }),
);
it.skipIf(!supported)(
  'refuses a current parent name replaced by another actual directory with the same owner and mode',
  () =>
    fixture(folder => {
      const samples = sampleChanges(
        folder,
        sample => {
          if (sample === 2) {
            fs.renameSync(folder, `${folder}-moved`);
            fs.mkdirSync(folder, {mode: 0o700});
          }
        },
        () => {
          expect(() => runtimeAssertPrivateProviderPath(folder, {kind: 'directory'})).toThrow();
        },
      );
      expect(samples).toBe(2);
    }),
);
it.skipIf(process.platform !== 'darwin' || !supported)(
  'never retries an actually unsafe sampled ACL into a later allowed state',
  () =>
    fixture(folder => {
      let unsafe = false;
      const chmod = (...args: string[]) =>
        expect(
          Bun.spawnSync(['/bin/chmod', ...args, folder], {stdout: 'pipe', stderr: 'pipe', timeout: 5000}).exitCode,
        ).toBe(0);
      try {
        const samples = sampleChanges(
          folder,
          sample => {
            if (sample === 2) {
              chmod('+a', 'everyone allow read,write,execute,file_inherit,directory_inherit');
              unsafe = true;
              expect(fs.statSync(folder).mode & 0o777).toBe(0o700);
            }
            if (sample === 4) {
              chmod('-N');
              unsafe = false;
            }
          },
          () => {
            expect(() => runtimeAssertPrivateProviderPath(folder, {kind: 'directory'})).toThrow();
          },
        );
        expect(samples).toBe(3);
        expect(unsafe).toBe(true);
      } finally {
        if (unsafe) chmod('-N');
      }
    }),
);

it.skipIf(process.platform !== 'darwin' || !supported)(
  'rechecks an ACL changed after an allowed sample before accepting the final parent-name reopen',
  () =>
    fixture(folder => {
      let unsafe = false;
      const chmod = (...args: string[]) =>
        expect(
          Bun.spawnSync(['/bin/chmod', ...args, folder], {stdout: 'pipe', stderr: 'pipe', timeout: 5000}).exitCode,
        ).toBe(0);
      try {
        const samples = sampleChanges(
          folder,
          sample => {
            if (sample === 4) {
              chmod('+a', 'everyone allow read,write,execute,file_inherit,directory_inherit');
              unsafe = true;
            }
            if (sample === 8) {
              chmod('-N');
              unsafe = false;
            }
          },
          () => {
            expect(() => runtimeAssertPrivateProviderPath(folder, {kind: 'directory'})).toThrow();
          },
        );
        expect(samples).toBe(7);
        expect(unsafe).toBe(true);
      } finally {
        if (unsafe) chmod('-N');
      }
    }),
);
it.skipIf(!supported)(
  'keeps actual private file metadata strict and preserves changed bytes without a coherent retry',
  () =>
    fixture(folder => {
      const file = path.join(folder, 'ledger.json');
      fs.writeFileSync(file, 'old', {mode: 0o600});
      const samples = sampleChanges(
        file,
        sample => {
          if (sample === 2) fs.writeFileSync(file, 'current-owned-fixture');
        },
        () => {
          expect(() => runtimeAssertPrivateProviderPath(file, {kind: 'file'})).toThrow();
        },
      );
      expect(samples).toBe(5);
      expect(fs.readFileSync(file, 'utf8')).toBe('current-owned-fixture');
    }),
);

for (const boundary of ['root', 'child'] as const) {
  it.skipIf(!supported)(`closes every owned descriptor when initial ${boundary} metadata capture fails`, () =>
    fixture(folder => {
      const originalStat = fs.fstatSync.bind(fs),
        originalOpen = fs.openSync.bind(fs),
        originalClose = fs.closeSync.bind(fs);
      type Acquisition = {fd: number; kind: 'prerequisite' | 'ancestry'};
      const acquired: Acquisition[] = [],
        active = new Map<number, Acquisition>(),
        visited: Acquisition[] = [],
        closed: Acquisition[] = [],
        unmatched: number[] = [];
      const retain = (fd: number, kind: Acquisition['kind']) => {
        const generation = {fd, kind};
        acquired.push(generation);
        active.set(fd, generation);
        return generation;
      };
      const target = boundary === 'root' ? 1 : 2;
      let injected = false;
      // Linux's ELF prerequisite opens/closes a separate generation before ancestry, often reusing the root FD.
      const open = vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
        const fd = originalOpen(file, flags, mode);
        retain(fd, file === '/' ? 'ancestry' : 'prerequisite');
        return fd;
      });
      const stat = vi.spyOn(fs, 'fstatSync').mockImplementation((fd, options) => {
        // Native openat acquisitions first cross this observed metadata boundary.
        const generation = active.get(fd) ?? retain(fd, 'ancestry');
        if (!visited.includes(generation)) visited.push(generation);
        if (!injected && visited.length === target) {
          injected = true;
          throw new Error('owned initial metadata failure');
        }
        return originalStat(fd, options);
      });
      const close = vi.spyOn(fs, 'closeSync').mockImplementation(fd => {
        const generation = active.get(fd);
        const result = originalClose(fd);
        if (generation) {
          closed.push(generation);
          active.delete(fd);
        } else unmatched.push(fd);
        return result;
      });
      try {
        expect(() => runtimeAssertPrivateProviderPath(folder, {kind: 'directory'})).toThrow();
        expect(injected).toBe(true);
        expect(visited).toHaveLength(target);
        expect(EffectArray.filter(closed, generation => generation.kind === 'ancestry')).toEqual(
          [...visited].reverse(),
        );
        for (const generation of acquired)
          expect(EffectArray.filter(closed, item => item === generation)).toHaveLength(1);
        expect(active.size).toBe(0);
        expect(unmatched).toEqual([]);
      } finally {
        close.mockRestore();
        stat.mockRestore();
        open.mockRestore();
      }
    }),
  );
}
