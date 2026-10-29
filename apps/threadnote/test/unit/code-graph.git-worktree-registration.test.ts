import {Array as EffectArray} from 'effect';
import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {TestError} from '@threadnote/testing/test-error';
import {inheritedProcessEnvironment} from '@threadnote/testing/process-environment';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {execFileSync} from '@threadnote/testing/node-child-process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join, relative} from '@threadnote/testing/node-path';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, Fiber, Layer} from 'effect';
import {TestClock} from 'effect/testing';
import {afterEach, describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS,
  captureCodeGraphGitWorktreeRegistration,
  codeGraphGitWorktreeAdminNameKeys,
  observeCodeGraphRecordedWorktreePaths,
  observeCodeGraphWorktreeReconciliationAuthority,
  parseBoundedGitDirectoryOutput,
  parseCodeGraphRecordedWorktreePathBatchResponse,
  parseCodeGraphWorktreeReconciliationAuthorityResponse,
  scanCodeGraphGitWorktreeRegistry,
  scanCodeGraphGitWorktreeRegistryBatch,
  scanCodeGraphWorktreeAuthorityWorkerRequest,
  validCodeGraphWorktreeAuthorityWorkerRequest,
  type CodeGraphGitWorktreeRegistryRequest,
  type CodeGraphWorktreeReconciliationAuthorityRequest,
} from '@threadnote/graph/git/worktree/registration';
import {CommandExecutor} from '@threadnote/platform/command';
import {runtimeDirectoryNamePage, SystemInfo} from '@threadnote/platform/system';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {CODE_GRAPH_GIT_WORKTREE_REGISTRATION_WORKER_ARGUMENT} from '@threadnote/threadnote/worker_protocol';
import {codeGraphGitdirBacklinkMatchesCanonicalWorktree} from '@threadnote/graph/git/worktree/backlink';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const roots: string[] = [];
const CHECKOUT_ID = Effect2.pipe('a', EffectString.repeat(64));
const authorityWorkerLayer = TestCommandExecutorLayer.pipe(
  Layer.provideMerge(TestSystemInfoLayer),
  Layer.provideMerge(BunServices.layer),
);

afterEach(() => {
  for (const root of roots.splice(0).reverse()) rmSync(root, {force: true, recursive: true});
});

describe('code graph common-gitdir worktree authority', () => {
  it('captures main versus linked registration without exposing the linked admin child', async () => {
    const root = localRepository();
    git(root, ['branch', 'linked']);
    const linked = join(temporaryRoot('threadnote-linked-worktree-'), 'offline-candidate');
    git(root, ['worktree', 'add', linked, 'linked']);
    const [mainIdentity, linkedIdentity] = await Promise.all([
      runEffect(resolveRepositoryIdentity(root)),
      runEffect(resolveRepositoryIdentity(linked)),
    ]);

    const main = await runEffect(captureCodeGraphGitWorktreeRegistration(mainIdentity));
    const registration = await runEffect(captureCodeGraphGitWorktreeRegistration(linkedIdentity));

    expect(main).toEqual({kind: 'main'});
    expect(registration).toMatchObject({kind: 'linked', adminNameKeys: expect.any(Array)});
    expect(JSON.stringify(registration)).not.toContain('offline-candidate');
    expect(JSON.stringify(registration)).not.toContain(mainIdentity.gitCommonDirectory);

    git(root, ['worktree', 'remove', '--force', linked]);
  });

  it('captures git-dir through the bounded binary command boundary and returns path-free failures', async () => {
    const root = localRepository();
    const identity = await runEffect(resolveRepositoryIdentity(root));
    let observedOptions: {readonly maxOutputBytes?: number; readonly timeoutMs?: number} | undefined;
    const registration = await runEffect(
      Effect.gen(function* () {
        const command = yield* CommandExecutor;
        const executeBytes = command.executeBytes;
        if (executeBytes === undefined)
          return yield* TestError.make({message: 'binary command adapter is unavailable'});
        const recording = CommandExecutor.of({
          ...command,
          executeBytes: (executable, args, options) => {
            if (executable === 'git' && args.includes('--git-dir')) observedOptions = options;
            return executeBytes(executable, args, options);
          },
        });
        return yield* captureCodeGraphGitWorktreeRegistration(identity).pipe(
          Effect.provideService(CommandExecutor, recording),
        );
      }),
    );
    const privatePath = join(temporaryRoot('threadnote-private-missing-'), 'not-a-repository');
    const failure = await runEffect(
      captureCodeGraphGitWorktreeRegistration({...identity, repoRoot: privatePath}).pipe(Effect.flip),
    );

    expect(registration).toEqual({kind: 'main'});
    expect(observedOptions).toMatchObject({
      maxOutputBytes: CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.gitDirectoryOutputBytes,
      timeoutMs: CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.gitDirectoryTimeoutMilliseconds,
    });
    expect(failure.message).toBe('Unable to verify the Git worktree registration.');
    expect(JSON.stringify(failure)).not.toContain(privatePath);
  });

  it('preserves a linked registration after its worktree folder becomes unavailable', async () => {
    const root = localRepository();
    git(root, ['branch', 'linked']);
    const linked = join(temporaryRoot('threadnote-linked-worktree-'), 'linked');
    const unavailable = `${linked}-unavailable`;
    git(root, ['worktree', 'add', linked, 'linked']);
    const linkedIdentity = await runEffect(resolveRepositoryIdentity(linked));
    const registration = await runEffect(captureCodeGraphGitWorktreeRegistration(linkedIdentity));
    expect(registration.kind).toBe('linked');

    renameSync(linked, unavailable);
    roots.push(unavailable);
    const observation = await scanCodeGraphGitWorktreeRegistry({
      adminNameKeys: registration.kind === 'linked' ? registration.adminNameKeys : [],
      checkoutId: linkedIdentity.checkoutId,
      gitCommonDirectory: linkedIdentity.gitCommonDirectory,
      protocol: 1,
    });
    const authority = await scanCodeGraphWorktreeAuthorityWorkerRequest({
      checkoutId: linkedIdentity.checkoutId,
      gitCommonDirectory: linkedIdentity.gitCommonDirectory,
      kind: 'reconciliation-authority',
      protocol: 3,
      targets: [
        {
          adminNameKeys: registration.kind === 'linked' ? registration.adminNameKeys : [],
          canonicalWorktreePath: linkedIdentity.repoRoot,
          evidenceToken: Effect2.pipe('1', EffectString.repeat(64)),
        },
      ],
    });

    expect(observation).toMatchObject({state: 'present'});
    expect(authority).toMatchObject({pathStates: ['missing'], registryStates: ['present'], state: 'complete'});
    expect(JSON.stringify(observation)).not.toContain(linked);
    renameSync(unavailable, linked);
    roots.splice(roots.indexOf(unavailable), 1);
    git(root, ['worktree', 'remove', '--force', linked]);
  });

  it.each(['directory', 'file'] as const)(
    'treats a matching partial %s admin child as registered without opening it',
    async kind => {
      const common = commonDirectoryFixture();
      const name = `partial-${kind}`;
      const child = join(common, 'worktrees', name);
      if (kind === 'directory') mkdirSync(child);
      if (kind === 'file') writeFileSync(child, 'partial registration');

      const observation = await scanCodeGraphGitWorktreeRegistry(request(common, name));

      expect(observation).toMatchObject({state: 'present'});
    },
  );

  it.skipIf(process.platform === 'win32')(
    'treats a matching symlink admin child as registered without following it',
    async () => {
      const common = commonDirectoryFixture();
      const name = 'partial-symlink';
      symlinkSync(temporaryRoot('threadnote-external-admin-'), join(common, 'worktrees', name));

      expect(await scanCodeGraphGitWorktreeRegistry(request(common, name))).toMatchObject({state: 'present'});
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not open a gitdir backlink or a registered path that would block forever',
    async () => {
      const common = commonDirectoryFixture();
      const adminName = 'blocked-registered-path';
      const child = join(common, 'worktrees', adminName);
      const fifo = join(temporaryRoot('threadnote-blocked-worktree-'), 'offline.fifo');
      mkdirSync(child);
      execFileSync('mkfifo', [fifo]);
      writeFileSync(join(child, 'gitdir'), `${fifo}\n`);

      const observation = await completesWithin(scanCodeGraphGitWorktreeRegistry(request(common, adminName)), 500);

      expect(observation).toMatchObject({state: 'present'});
    },
  );

  effectIt.effect('enumerates unrelated invalid UTF-8 POSIX names without decoding or opening them', () =>
    Effect.gen(function* () {
      if (process.platform !== 'linux') return;
      const common = commonDirectoryFixture();
      const root = Buffer.from(join(common, 'worktrees'));
      const invalidChild = Buffer.concat([root, Buffer.from('/'), Buffer.from([0xff, 0xfe])]);
      mkdirSync(invalidChild);

      const page = yield* Effect.promise(() => runtimeDirectoryNamePage(join(common, 'worktrees'), 1));
      expect(page).toMatchObject({overflow: false});
      expect(EffectArray.map(page.names, name => [...name])).toEqual([[0xff, 0xfe]]);

      const observation = yield* Effect.promise(() =>
        scanCodeGraphGitWorktreeRegistry(request(common, 'absent-target')),
      );

      expect(observation).toMatchObject({entryCount: 1, state: 'absent'});
    }),
  );

  it('treats a stably missing registry root as complete-empty', async () => {
    const missing = temporaryRoot('threadnote-common-missing-');
    const missingObservation = await scanCodeGraphGitWorktreeRegistry(request(missing, 'absent-target'));

    expect(missingObservation).toMatchObject({entryCount: 0, registryRootKind: 'missing', state: 'absent'});
  });

  it.skipIf(process.platform === 'win32')('treats a symlinked registry root as unknown', async () => {
    const symlinked = temporaryRoot('threadnote-common-symlink-');
    symlinkSync(temporaryRoot('threadnote-registry-external-'), join(symlinked, 'worktrees'));
    const symlinkObservation = await scanCodeGraphGitWorktreeRegistry(request(symlinked, 'absent-target'));

    expect(symlinkObservation).toEqual({reason: 'ambiguous', state: 'unknown'});
  });

  it('returns unknown instead of a partial absence when the immediate-name bound is exceeded', async () => {
    const common = commonDirectoryFixture();
    for (let index = 0; index <= CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.maxAdminNames; index += 1) {
      writeFileSync(join(common, 'worktrees', `entry-${index}`), '');
    }

    const observation = await scanCodeGraphGitWorktreeRegistry(request(common, 'absent-target'));

    expect(observation).toEqual({reason: 'ambiguous', state: 'unknown'});
  });

  effectIt.effect('materializes at most the requested raw-name page before reporting overflow', () =>
    Effect.gen(function* () {
      const common = commonDirectoryFixture();
      for (let index = 0; index < 16; index += 1) {
        writeFileSync(
          join(common, 'worktrees', `bounded-${Effect2.pipe(String(index), EffectString.padStart(2, '0'))}`),
          '',
        );
      }

      const page = yield* Effect.promise(() => runtimeDirectoryNamePage(join(common, 'worktrees'), 4));

      expect(page.overflow).toBe(true);
      expect(page.names).toHaveLength(4);
    }),
  );

  it('parses one bounded exact git-dir record without trimming path bytes', () => {
    expect(parseBoundedGitDirectoryOutput(Buffer.from('/private/worktree admin \n'))).toBe('/private/worktree admin ');
    expect(parseBoundedGitDirectoryOutput(Buffer.from('/private/one\n/private/two\n'))).toBeUndefined();
    expect(parseBoundedGitDirectoryOutput(Uint8Array.of(0xff, 0x0a))).toBeUndefined();
    expect(parseBoundedGitDirectoryOutput(Buffer.from('/private/no-terminator'))).toBeUndefined();
    expect(
      parseBoundedGitDirectoryOutput(
        Buffer.alloc(CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.gitDirectoryOutputBytes + 1, 0x61),
      ),
    ).toBeUndefined();
  });

  it('derives deterministic checkout-bound exact and conservative name keys', () => {
    const exact = codeGraphGitWorktreeAdminNameKeys(CHECKOUT_ID, 'Solaris');
    const repeated = codeGraphGitWorktreeAdminNameKeys(CHECKOUT_ID, Buffer.from('Solaris'));
    const folded = codeGraphGitWorktreeAdminNameKeys(CHECKOUT_ID, 'solaris');

    expect(exact).toEqual(repeated);
    expect(exact).toHaveLength(2);
    expect(EffectArray.some(exact, key => folded.includes(key))).toBe(true);
    expect(codeGraphGitWorktreeAdminNameKeys(Effect2.pipe('b', EffectString.repeat(64)), 'Solaris')).not.toEqual(exact);
    expect(JSON.stringify(exact)).not.toContain('Solaris');
    expect(codeGraphGitWorktreeAdminNameKeys(CHECKOUT_ID, Uint8Array.of(0xff, 0xfe))).toHaveLength(1);
  });

  effectIt.effect('classifies one bounded page of linked admin targets with a single stable scan', () =>
    Effect.promise(async () => {
      const common = commonDirectoryFixture();
      mkdirSync(join(common, 'worktrees', 'present-directory'));
      writeFileSync(join(common, 'worktrees', 'present-file'), 'partial registration');
      const observation = await scanCodeGraphGitWorktreeRegistryBatch({
        adminNameKeySets: EffectArray.map(['absent', 'present-directory', 'present-file'], name =>
          codeGraphGitWorktreeAdminNameKeys(CHECKOUT_ID, name),
        ),
        checkoutId: CHECKOUT_ID,
        gitCommonDirectory: common,
        protocol: 2,
      });

      expect(observation).toMatchObject({
        entryCount: 2,
        states: ['absent', 'present', 'present'],
        state: 'complete',
      });
      expect(JSON.stringify(observation)).not.toContain(common);
      expect(JSON.stringify(observation)).not.toContain('present-directory');
    }),
  );

  effectIt.effect('runs the protocol-v3 authority boundary for thirty-two index-addressed targets', () =>
    Effect.gen(function* () {
      const common = commonDirectoryFixture();
      const pathRoot = temporaryRoot('threadnote-authority-paths-');
      const targets = Array.from({length: CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.maxBatchTargets}, (_, index) => {
        const canonicalWorktreePath = join(pathRoot, `target-${index}`);
        if (index % 2 === 0) mkdirSync(canonicalWorktreePath);
        return {
          adminNameKeys: codeGraphGitWorktreeAdminNameKeys(CHECKOUT_ID, `absent-${index}`),
          canonicalWorktreePath,
          evidenceToken: Effect2.pipe(index.toString(16), EffectString.padStart(64, '0')),
        };
      });

      const observation = yield* observeCodeGraphWorktreeReconciliationAuthority(
        {checkoutId: CHECKOUT_ID, gitCommonDirectory: common},
        targets,
      );

      expect(observation).toMatchObject({entryCount: 0, registryRootKind: 'directory', state: 'complete'});
      if (observation.state === 'complete') {
        expect(observation.pathStates).toEqual(
          EffectArray.map(targets, (_, index) => (index % 2 === 0 ? 'present' : 'missing')),
        );
        expect(observation.registryStates).toEqual(EffectArray.map(targets, () => 'absent'));
      }
      const serialized = JSON.stringify(observation);
      expect(serialized).not.toContain(common);
      expect(
        EffectArray.every(
          targets,
          target => !Effect2.pipe(serialized, EffectString.includes(target.canonicalWorktreePath)),
        ),
      ).toBe(true);
    }).pipe(provideTestLayer(authorityWorkerLayer)),
  );

  effectIt.effect(
    'treats a reused admin name as absent unless its stable gitdir backlink targets the recorded worktree',
    () =>
      Effect.gen(function* () {
        const common = commonDirectoryFixture();
        const adminName = 'threadnote9';
        const adminEntry = join(common, 'worktrees', adminName);
        mkdirSync(adminEntry);
        const targetRoot = temporaryRoot('threadnote-recycled-admin-targets-');
        const removedWorktree = join(targetRoot, 'removed-worktree');
        const replacementWorktree = join(targetRoot, 'replacement-worktree');
        const targets = [
          {
            adminNameKeys: codeGraphGitWorktreeAdminNameKeys(CHECKOUT_ID, adminName),
            canonicalWorktreePath: removedWorktree,
            evidenceToken: Effect2.pipe('3', EffectString.repeat(64)),
          },
        ];

        writeFileSync(join(adminEntry, 'gitdir'), `${join(replacementWorktree, '.git')}\n`);
        const reused = yield* observeCodeGraphWorktreeReconciliationAuthority(
          {checkoutId: CHECKOUT_ID, gitCommonDirectory: common},
          targets,
        );
        expect(reused).toMatchObject({pathStates: ['missing'], registryStates: ['absent'], state: 'complete'});

        writeFileSync(join(adminEntry, 'gitdir'), `${relative(adminEntry, join(removedWorktree, '.git'))}\r\n`);
        const original = yield* observeCodeGraphWorktreeReconciliationAuthority(
          {checkoutId: CHECKOUT_ID, gitCommonDirectory: common},
          targets,
        );
        expect(original).toMatchObject({pathStates: ['missing'], registryStates: ['present'], state: 'complete'});
        expect(JSON.stringify([reused, original])).not.toContain(targetRoot);
      }).pipe(provideTestLayer(authorityWorkerLayer)),
  );

  it('fails closed when a matching admin entry has no stable regular gitdir backlink', async () => {
    const common = commonDirectoryFixture();
    const adminName = 'partial-reused-admin';
    mkdirSync(join(common, 'worktrees', adminName));
    const request = {
      checkoutId: CHECKOUT_ID,
      gitCommonDirectory: common,
      kind: 'reconciliation-authority',
      protocol: 3,
      targets: [
        {
          adminNameKeys: codeGraphGitWorktreeAdminNameKeys(CHECKOUT_ID, adminName),
          canonicalWorktreePath: join(temporaryRoot('threadnote-partial-admin-target-'), 'missing'),
          evidenceToken: Effect2.pipe('4', EffectString.repeat(64)),
        },
      ],
    } satisfies CodeGraphWorktreeReconciliationAuthorityRequest;

    expect(await scanCodeGraphWorktreeAuthorityWorkerRequest(request)).toEqual({
      reason: 'ambiguous',
      state: 'unknown',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'fails closed instead of following a matching admin entry or gitdir symlink',
    async () => {
      const targetRoot = temporaryRoot('threadnote-symlink-admin-target-');
      const canonicalWorktreePath = join(targetRoot, 'missing');
      const external = temporaryRoot('threadnote-external-admin-entry-');
      writeFileSync(join(external, 'gitdir'), `${join(canonicalWorktreePath, '.git')}\n`);
      for (const kind of ['admin', 'gitdir'] as const) {
        const common = commonDirectoryFixture();
        const adminName = `symlink-${kind}`;
        const adminEntry = join(common, 'worktrees', adminName);
        if (kind === 'admin') symlinkSync(external, adminEntry);
        else {
          mkdirSync(adminEntry);
          symlinkSync(join(external, 'gitdir'), join(adminEntry, 'gitdir'));
        }
        const observation = await scanCodeGraphWorktreeAuthorityWorkerRequest({
          checkoutId: CHECKOUT_ID,
          gitCommonDirectory: common,
          kind: 'reconciliation-authority',
          protocol: 3,
          targets: [
            {
              adminNameKeys: codeGraphGitWorktreeAdminNameKeys(CHECKOUT_ID, adminName),
              canonicalWorktreePath,
              evidenceToken: Effect2.pipe('5', EffectString.repeat(64)),
            },
          ],
        });
        expect(observation).toEqual({reason: 'ambiguous', state: 'unknown'});
      }
    },
  );

  it('normalizes Git LF/CRLF backlink spelling across supported platform path formats', () => {
    expect(
      codeGraphGitdirBacklinkMatchesCanonicalWorktree(
        Buffer.from('/private/worktree/.git\n'),
        '/private/worktree',
        '/private/repository/.git/worktrees/threadnote',
        'linux',
      ),
    ).toBe(true);
    expect(
      codeGraphGitdirBacklinkMatchesCanonicalWorktree(
        Buffer.from('c:/Private/Worktree/.git\r\n'),
        'C:\\private\\worktree',
        'C:\\repository\\.git\\worktrees\\threadnote',
        'win32',
      ),
    ).toBe(true);
    expect(
      codeGraphGitdirBacklinkMatchesCanonicalWorktree(
        Buffer.from('/private/replacement/.git\n'),
        '/private/worktree',
        '/private/repository/.git/worktrees/threadnote',
        'linux',
      ),
    ).toBe(false);
    expect(
      codeGraphGitdirBacklinkMatchesCanonicalWorktree(
        Buffer.from('/private/worktree/.git'),
        '/private/worktree',
        '/private/repository/.git/worktrees/threadnote',
        'linux',
      ),
    ).toBeUndefined();
    expect(
      codeGraphGitdirBacklinkMatchesCanonicalWorktree(
        Buffer.from('../../../../worktree/.git\n'),
        '/private/worktree',
        '/private/repository/.git/worktrees/threadnote',
        'linux',
      ),
    ).toBe(true);
    expect(
      codeGraphGitdirBacklinkMatchesCanonicalWorktree(
        Buffer.from('..\\..\\..\\..\\worktree\\.git\r\n'),
        'C:\\private\\worktree',
        'C:\\private\\repository\\.git\\worktrees\\threadnote',
        'win32',
      ),
    ).toBe(true);
  });

  effectIt.effect('rejects over-page authority before spawning and strictly parses malformed responses', () =>
    Effect.gen(function* () {
      const command = yield* CommandExecutor;
      let workerCalls = 0;
      const recording = CommandExecutor.of({
        ...command,
        executeBytes: (executable, args, options) => {
          workerCalls += 1;
          return command.executeBytes!(executable, args, options);
        },
      });
      const targets = Array.from(
        {length: CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.maxBatchTargets + 1},
        (_, index) => ({
          adminNameKeys: [Effect2.pipe('b', EffectString.repeat(64))],
          canonicalWorktreePath: `/private/authority-${String(index)}`,
          evidenceToken: Effect2.pipe('c', EffectString.repeat(64)),
        }),
      );
      const observation = yield* observeCodeGraphWorktreeReconciliationAuthority(
        {checkoutId: CHECKOUT_ID, gitCommonDirectory: '/private/common'},
        targets,
      ).pipe(Effect.provideService(CommandExecutor, recording));
      expect(observation).toEqual({reason: 'invalid', state: 'unknown'});
      expect(workerCalls).toBe(0);

      const validAuthority = `${JSON.stringify({
        contentDigest: Effect2.pipe('1', EffectString.repeat(64)),
        entryCount: 0,
        pathStates: ['missing'],
        registryRootIdentity: Effect2.pipe('2', EffectString.repeat(64)),
        registryRootKind: 'missing',
        registryStates: ['absent'],
        state: 'complete',
      })}\n`;
      const malformed = [
        Effect2.pipe(validAuthority, EffectString.slice(0, -1)),
        `${validAuthority}{}\n`,
        `${JSON.stringify({pathStates: [], state: 'complete'})}\n`,
        `${JSON.stringify({pathStates: ['missing', 'present'], state: 'complete'})}\n`,
        // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
        'x'.repeat(CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.workerOutputBytes + 1),
        `${JSON.stringify({
          contentDigest: Effect2.pipe('1', EffectString.repeat(64)),
          entryCount: 0,
          // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
          padding: 'x'.repeat(CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.workerOutputBytes),
          pathStates: ['missing'],
          registryRootIdentity: Effect2.pipe('2', EffectString.repeat(64)),
          registryRootKind: 'missing',
          registryStates: ['absent'],
          state: 'complete',
        })}\n`,
      ];
      expect(
        EffectArray.every(
          malformed,
          output =>
            parseCodeGraphWorktreeReconciliationAuthorityResponse(Buffer.from(output), 1).state === 'unknown' &&
            parseCodeGraphRecordedWorktreePathBatchResponse(Buffer.from(output), 1).state === 'unknown',
        ),
      ).toBe(true);
      expect(parseCodeGraphWorktreeReconciliationAuthorityResponse(Buffer.from(validAuthority), 1).state).toBe(
        'complete',
      );
    }).pipe(provideTestLayer(authorityWorkerLayer)),
  );

  effectIt.effect('accepts the maximally escaped valid page and rejects stdin beyond the hard cap', () =>
    Effect.gen(function* () {
      const prefix = process.platform === 'win32' ? 'C:\\' : '/';
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
      const escapedPath = `${prefix}${'\u0001'.repeat(4_096 - Buffer.byteLength(prefix))}`;
      const request = {
        checkoutId: CHECKOUT_ID,
        gitCommonDirectory: escapedPath,
        kind: 'reconciliation-authority',
        protocol: 3,
        targets: Array.from({length: 32}, () => ({
          adminNameKeys: [Effect2.pipe('b', EffectString.repeat(64))],
          canonicalWorktreePath: escapedPath,
          evidenceToken: Effect2.pipe('c', EffectString.repeat(64)),
        })),
      } satisfies CodeGraphWorktreeReconciliationAuthorityRequest;
      const bytes = Buffer.byteLength(`${JSON.stringify(request)}\n`);
      expect(bytes).toBeGreaterThan(320 * 1_024);
      expect(bytes).toBeLessThanOrEqual(CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.authorityWorkerInputBytes);
      expect(validCodeGraphWorktreeAuthorityWorkerRequest(request)).toBe(true);

      const command = yield* CommandExecutor;
      const system = yield* SystemInfo;
      const oversized = new Uint8Array(CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.authorityWorkerInputBytes + 1);
      oversized.fill(0x78);
      const worker = yield* command.executeBytes!(
        system.executablePath,
        ['apps/threadnote/src/standalone.ts', CODE_GRAPH_GIT_WORKTREE_REGISTRATION_WORKER_ARGUMENT],
        {
          allowFailure: true,
          env: {...system.environment(), THREADNOTE_CODE_GRAPH_GIT_WORKTREE_REGISTRATION_WORKER: '1'},
          input: oversized,
          maxOutputBytes: CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.workerOutputBytes,
          timeoutMs: 2_000,
        },
      );
      expect(worker.exitCode).toBe(0);
      expect(new TextDecoder().decode(worker.stdout)).toBe('{"reason":"invalid","state":"unknown"}\n');

      const invalidUtf8 = yield* command.executeBytes!(
        system.executablePath,
        ['apps/threadnote/src/standalone.ts', CODE_GRAPH_GIT_WORKTREE_REGISTRATION_WORKER_ARGUMENT],
        {
          allowFailure: true,
          env: {...system.environment(), THREADNOTE_CODE_GRAPH_GIT_WORKTREE_REGISTRATION_WORKER: '1'},
          input: Uint8Array.of(0xff, 0x0a),
          maxOutputBytes: CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.workerOutputBytes,
          timeoutMs: 2_000,
        },
      );
      expect(invalidUtf8.exitCode).toBe(0);
      expect(new TextDecoder().decode(invalidUtf8.stdout)).toBe('{"reason":"invalid","state":"unknown"}\n');
      expect(invalidUtf8.stderr).toBe('');
    }).pipe(provideTestLayer(authorityWorkerLayer)),
  );

  effectIt.effect('classifies direct lstat states and fails closed for non-ENOENT path errors', () =>
    Effect.gen(function* () {
      const root = temporaryRoot('threadnote-authority-lstat-');
      const present = join(root, 'present');
      const dangling = join(root, 'dangling');
      const missing = join(root, 'missing');
      mkdirSync(present);
      if (process.platform !== 'win32') symlinkSync(join(root, 'dangling-target'), dangling);
      const paths = process.platform === 'win32' ? [present, missing] : [present, dangling, missing];
      const observed = yield* observeCodeGraphRecordedWorktreePaths(paths);
      expect(observed).toEqual({
        pathStates: process.platform === 'win32' ? ['present', 'missing'] : ['present', 'present', 'missing'],
        state: 'complete',
      });

      const parentFile = join(root, 'not-a-directory');
      writeFileSync(parentFile, 'file');
      expect(yield* observeCodeGraphRecordedWorktreePaths([join(parentFile, 'child')])).toEqual({
        reason: 'unavailable',
        state: 'unknown',
      });
      if (process.platform !== 'win32') {
        const inaccessible = join(root, 'inaccessible');
        mkdirSync(inaccessible);
        chmodSync(inaccessible, 0o000);
        const permission = yield* observeCodeGraphRecordedWorktreePaths([join(inaccessible, 'child')]);
        chmodSync(inaccessible, 0o700);
        expect(permission).toEqual({reason: 'unavailable', state: 'unknown'});
      }
    }).pipe(provideTestLayer(authorityWorkerLayer)),
  );

  effectIt.effect('kills a hard-blocked lstat worker on deadline and interruption', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = temporaryRoot('threadnote-authority-blocked-');
        const timeoutPid = join(root, 'timeout.pid');
        const timeoutFiber = yield* withBlockedLstatWorker(timeoutPid, () =>
          observeCodeGraphRecordedWorktreePaths([join(root, 'missing')], {timeoutMilliseconds: 2_000}),
        ).pipe(Effect.forkChild);
        yield* Effect.promise(() => waitForFile(timeoutPid, 1_500));
        const timeoutObservation = yield* Fiber.join(timeoutFiber);
        expect(timeoutObservation).toEqual({reason: 'timeout', state: 'unknown'});
        const timeoutProcess = Number(Effect2.pipe(readFileSync(timeoutPid, 'utf8'), EffectString.trim));
        yield* Effect.promise(() => waitForProcessExit(timeoutProcess, 2_000));

        const interruptPid = join(root, 'interrupt.pid');
        yield* withBlockedLstatWorker(interruptPid, () =>
          Effect.gen(function* () {
            const fiber = yield* observeCodeGraphRecordedWorktreePaths([join(root, 'missing')], {
              timeoutMilliseconds: 10_000,
            }).pipe(Effect.forkChild);
            yield* Effect.promise(() => waitForFile(interruptPid, 2_000));
            const childProcess = Number(Effect2.pipe(readFileSync(interruptPid, 'utf8'), EffectString.trim));
            yield* Fiber.interrupt(fiber);
            yield* Effect.promise(() => waitForProcessExit(childProcess, 2_000));
          }),
        );
      }).pipe(provideTestLayer(authorityWorkerLayer)),
    ),
  );
});

function request(common: string, adminName: string): CodeGraphGitWorktreeRegistryRequest {
  return {
    adminNameKeys: codeGraphGitWorktreeAdminNameKeys(CHECKOUT_ID, adminName),
    checkoutId: CHECKOUT_ID,
    gitCommonDirectory: common,
    protocol: 1,
  };
}

function commonDirectoryFixture(): string {
  const common = temporaryRoot('threadnote-common-gitdir-');
  mkdirSync(join(common, 'worktrees'));
  return common;
}

function localRepository(): string {
  const root = temporaryRoot('threadnote-registration-repository-');
  git(root, ['init', '-q']);
  git(root, [
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture',
  ]);
  return root;
}

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe'});
}

async function completesWithin<A>(promise: Promise<A>, milliseconds: number): Promise<A> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(TestError.make({message: 'operation exceeded bounded test deadline'})),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function withBlockedLstatWorker<A, E, R>(
  pidFile: string,
  operation: () => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => ({
      block: inheritedProcessEnvironment().THREADNOTE_CODE_GRAPH_TEST_BLOCK_WORKTREE_LSTAT,
      pidFile: inheritedProcessEnvironment().THREADNOTE_CODE_GRAPH_TEST_WORKTREE_LSTAT_PID_FILE,
    })).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          inheritedProcessEnvironment().THREADNOTE_CODE_GRAPH_TEST_BLOCK_WORKTREE_LSTAT = '1';
          inheritedProcessEnvironment().THREADNOTE_CODE_GRAPH_TEST_WORKTREE_LSTAT_PID_FILE = pidFile;
        }),
      ),
    ),
    operation,
    previous =>
      Effect.sync(() => {
        restoreEnvironment('THREADNOTE_CODE_GRAPH_TEST_BLOCK_WORKTREE_LSTAT', previous.block);
        restoreEnvironment('THREADNOTE_CODE_GRAPH_TEST_WORKTREE_LSTAT_PID_FILE', previous.pidFile);
      }),
  );
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function waitForFile(path: string, timeoutMilliseconds: number): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!existsSync(path)) {
    if (Date.now() >= deadline)
      throw TestError.make({message: 'Worker did not publish its test PID before the deadline.'});
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function waitForProcessExit(pid: number, timeoutMilliseconds: number): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') return;
      throw error;
    }
    if (Date.now() >= deadline)
      throw TestError.make({message: `Worker ${String(pid)} survived its bounded cancellation.`});
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
