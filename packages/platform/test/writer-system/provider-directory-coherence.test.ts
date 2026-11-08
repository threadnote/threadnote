import {expect, it, vi} from 'vitest';
import {runtimeAssertPrivateProviderPath} from '../../src/system.js';

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
function sampleChanges(target: string, change: (sample: number) => void, run: () => void): number {
  const anchor = fs.statSync(target, {bigint: true}),
    original = fs.fstatSync.bind(fs);
  let samples = 0;
  const spy = vi.spyOn(fs, 'fstatSync').mockImplementation((fd, options) => {
    const current = original(fd, options);
    if (options?.bigint && current.dev === anchor.dev && current.ino === anchor.ino) {
      change(++samples);
      return original(fd, options);
    }
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
  }),
);
it.skipIf(!supported)(
  'takes one coherent retry when actual sibling creation moves directory data during an allowed ACL sample',
  () =>
    fixture((folder, sibling) => {
      const samples = sampleChanges(
        path.dirname(folder),
        sample => {
          if (sample === 4) fs.writeFileSync(sibling, 'owned fixture', {mode: 0o600});
        },
        () => {
          expect(() => runtimeAssertPrivateProviderPath(folder, {kind: 'directory'})).not.toThrow();
        },
      );
      expect(samples).toBe(9);
    }),
);
it.skipIf(!supported)(
  'refuses a second directory-data movement instead of extending the bounded coherent sample budget',
  () =>
    fixture((folder, sibling) => {
      const samples = sampleChanges(
        path.dirname(folder),
        sample => {
          if (sample === 4) fs.writeFileSync(sibling, 'one', {mode: 0o600});
          if (sample === 8) fs.writeFileSync(`${sibling}-second`, 'two', {mode: 0o600});
        },
        () => {
          expect(() => runtimeAssertPrivateProviderPath(folder, {kind: 'directory'})).toThrow();
        },
      );
      expect(samples).toBe(9);
    }),
);
it.skipIf(!supported)('refuses an actual changed private directory mode without a metadata retry', () =>
  fixture(folder => {
    const samples = sampleChanges(
      folder,
      sample => {
        if (sample === 2) fs.chmodSync(folder, 0o750);
      },
      () => {
        expect(() => runtimeAssertPrivateProviderPath(folder, {kind: 'directory'})).toThrow();
      },
    );
    expect(samples).toBe(2);
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
        originalClose = fs.closeSync.bind(fs),
        visited: number[] = [],
        closed: number[] = [];
      const target = boundary === 'root' ? 1 : 2;
      let injected = false;
      const stat = vi.spyOn(fs, 'fstatSync').mockImplementation((fd, options) => {
        if (!visited.includes(fd)) visited.push(fd);
        if (!injected && visited.length === target) {
          injected = true;
          throw new Error('owned initial metadata failure');
        }
        return originalStat(fd, options);
      });
      const close = vi.spyOn(fs, 'closeSync').mockImplementation(fd => {
        closed.push(fd);
        return originalClose(fd);
      });
      try {
        expect(() => runtimeAssertPrivateProviderPath(folder, {kind: 'directory'})).toThrow();
        expect(injected).toBe(true);
        expect(visited).toHaveLength(target);
        expect(closed).toEqual([...visited].reverse());
      } finally {
        close.mockRestore();
        stat.mockRestore();
      }
    }),
  );
}
