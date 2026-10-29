import {Predicate} from 'effect';
import {Array as EffectArray} from 'effect';
/* oxlint-disable effecttsgo/node-builtin-import -- Tests of the private process/filesystem collection boundary. */
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {
  assertCollectionCardinality,
  collectionTrialIdentity,
  collectionObservationField,
  parseThreadnote5CollectionPlan,
  projectNativeCapture,
  THREADNOTE_5_COLLECTION_MATRIX,
  threadnote5CollectionPlanHash,
  type NativeProjection,
} from '@threadnote/threadnote/evaluation/threadnote-5-release-collection';
import {
  atomicDirectory,
  assertIsolatedCollectionArguments,
  assertUniqueNativeIdentities,
  CollectionCaptureBudget,
  collectThreadnote5Candidate,
  previewThreadnote5Collection,
  readCollectionDirectoryIdentity,
  readNativeCollectionJson,
  sealThreadnote5Collection,
  writeSyntheticCollectionFile,
} from '../../../../scripts/threadnote-5-collection-runner.js';
import {
  collectionEnvironment,
  observeCollectionRuntime,
  runCollectionProcess,
  readCollectionPayloadIdentity,
} from '../../../../scripts/threadnote-5-collection-process.js';
import type {Threadnote5SourceV1} from '@threadnote/threadnote/evaluation/threadnote-5-release-readiness-contract';
import {threadnote5LocalAuthorityManifestHash} from '@threadnote/threadnote/evaluation/threadnote-5-release-readiness-authority';
import {collectionTranscriptFixture} from '../helpers/threadnote-5-collection-transcripts.js';
import {threadnote5CollectionAuthorityBindingHash} from '@threadnote/threadnote/evaluation/threadnote-5-release-collection-envelope';
import {
  CollectionMcpTransport,
  createCollectionVerifiedLaunch,
  runVerifiedCollectionProcess,
} from '../../../../scripts/threadnote-5-collection-transport.js';
import fixture from '../evaluation/fixtures/threadnote-5-task-loop-v1/fixture.json' with {type: 'json'};
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const candidate: Threadnote5SourceV1 = {
  id: 'threadnote-5.0.0',
  version: `5.0.0-local.g${Effect.pipe('1', EffectString.repeat(40))}`,
  commit: Effect.pipe('1', EffectString.repeat(40)),
  executableSha256: Effect.pipe('2', EffectString.repeat(64)),
};
const macosIt = process.platform === 'darwin' ? it : it.skip;

function plan() {
  return {
    version: 1,
    runId: 'isolated_run',
    candidate,
    measuredTrials: 10,
    retentionHours: 24,
    recipes: EffectArray.map(THREADNOTE_5_COLLECTION_MATRIX, ([scenario, kinds]) => ({
      scenario,
      steps: [{id: 'native', type: 'cli', surface: 'primary', argv: ['--version'], expectedExit: 0}],
      exports: EffectRecord.fromEntries(
        EffectArray.map(kinds, ([kind, count]): [string, NativeProjection] => [
          kind,
          count === 1
            ? {select: 'native', pointer: '/json', trial: 0}
            : {
                object: {
                  [collectionObservationField(scenario, kind)!]: {
                    collect: 'native',
                    pointer: '/json/observation',
                    flatten: false,
                  },
                },
              },
        ]),
      ),
    })),
  };
}

describe('private Threadnote 5 collection', () => {
  it('covers exactly 15 scenarios and 24 sources with asymmetric static cardinalities', () => {
    expect(THREADNOTE_5_COLLECTION_MATRIX).toHaveLength(15);
    expect(EffectArray.reduce(THREADNOTE_5_COLLECTION_MATRIX, 0, (count, [, kinds]) => count + kinds.length)).toBe(24);
    expect(previewThreadnote5Collection(plan())).toMatchObject({
      scenarioCount: 15,
      sourceRecordCount: 24,
      externalAuthorityRequired: true,
    });
    assertCollectionCardinality('interrupted-resumed', 'activation', {trials: [{}]}, 10);
    assertCollectionCardinality('interrupted-resumed', 'closeout', {reviews: Array(10).fill({})}, 10);
    expect(() =>
      assertCollectionCardinality('interrupted-resumed', 'activation', {trials: Array(10).fill({})}, 10),
    ).toThrow('cardinality');
    expect(() =>
      assertCollectionCardinality('output-budgets', 'context-brief', {attempts: Array(10).fill({})}, 10),
    ).toThrow('cardinality');
    expect(() => assertCollectionCardinality('solo', 'activation', {trials: [{}]}, 10)).toThrow('cardinality');
  });

  it('rejects missing, duplicate, extra, literal, and synthetic evidence projections before execution', () => {
    const value = plan();
    expect(() => parseThreadnote5CollectionPlan({...value, recipes: value.recipes.slice(1)})).toThrow();
    expect(() =>
      parseThreadnote5CollectionPlan({...value, recipes: [value.recipes[0], ...value.recipes.slice(0, 14)]}),
    ).toThrow();
    expect(() => parseThreadnote5CollectionPlan({...value, fabricated: true})).toThrow();
    // @ts-expect-error This negative parser fixture replaces the activation binding with the invalid literal form.
    value.recipes[0].exports.activation = {literal: {passed: true}};
    expect(() => parseThreadnote5CollectionPlan(value)).toThrow();
    value.recipes[0].steps[0] = {
      id: 'native',
      type: 'write',
      surface: 'primary',
      // @ts-expect-error This negative parser fixture includes a field outside the declared write-step shape.
      root: 'home',
      path: 'source.json',
      text: '{}',
    };
    value.recipes[0].exports.activation = {select: 'native', pointer: '', trial: 0};
    expect(() => parseThreadnote5CollectionPlan(value)).toThrow();
  });

  it('has deterministic ordering, unique cross-trial identities, and native projection round trips', () => {
    fc.assert(
      fc.property(fc.integer({min: 10, max: 64}), fc.stringMatching(/^[a-z]{1,16}$/), (count, runId) => {
        const value = {...plan(), measuredTrials: count, runId};
        expect(threadnote5CollectionPlanHash(value)).toBe(
          threadnote5CollectionPlanHash({...value, recipes: [...value.recipes].reverse()}),
        );
        const identities = EffectArray.flatMap(THREADNOTE_5_COLLECTION_MATRIX, ([scenario]) =>
          Array.from({length: count}, (_, index) => collectionTrialIdentity(runId, scenario, index)),
        );
        for (const key of ['laneId', 'trialId', 'reviewId', 'proposalId', 'activationId'] as const)
          expect(new Set(EffectArray.map(identities, item => item[key])).size).toBe(15 * count);
      }),
      {numRuns: 20},
    );
    fc.assert(
      fc.property(fc.array(fc.jsonValue(), {maxLength: 16}), values => {
        expect(
          projectNativeCapture(
            {collect: 'native', pointer: '/value', flatten: false},
            EffectArray.map(values, value => ({native: {value}})),
          ),
        ).toEqual(values);
      }),
      {numRuns: 40},
    );
  });

  it('rejects missing native selectors and prototype traversal', () => {
    expect(() => projectNativeCapture({select: 'native', pointer: '/missing', trial: 0}, [{native: {}}])).toThrow();
    expect(() => projectNativeCapture({select: 'native', pointer: '/__proto__', trial: 0}, [{native: {}}])).toThrow();
    expect(() => projectNativeCapture({collect: 'native', pointer: '', flatten: true}, [{native: 4}])).toThrow();
  });

  it('rejects cross-trial reuse in native outputs, while allowing status rereads in the same trial', () => {
    const seen = new Map<string, string>();
    assertUniqueNativeIdentities({activationId: 'native-activation'}, 'solo/0', seen);
    assertUniqueNativeIdentities({nested: [{activationId: 'native-activation'}]}, 'solo/0', seen);
    expect(() => assertUniqueNativeIdentities({activationId: 'native-activation'}, 'solo/1', seen)).toThrow('reused');
  });

  it('structurally confines nested, concatenated, encoded, and file-URL arguments', () => {
    const root = '/private/trial';
    expect(() =>
      assertIsolatedCollectionArguments([`--output=${root}/nested/result.json`, JSON.stringify({repo: root})], root),
    ).not.toThrow();
    for (const value of [
      'child/../../../outside',
      '--output=child/../../../outside',
      '--output=child/%2e%2e/%2e%2e/outside',
      '--output=child/%252e%252e%252foutside',
      'file:///outside',
      '--remote=file%3a%2f%2f%2foutside',
    ])
      expect(() => assertIsolatedCollectionArguments([value], root)).toThrow('isolated trial');
    fc.assert(
      fc.property(fc.integer({min: 1, max: 12}), fc.boolean(), (depth, encoded) => {
        const parent = encoded ? '%2e%2e%2f' : '../';
        // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
        expect(() => assertIsolatedCollectionArguments([`prefix/${parent.repeat(depth)}outside`], root)).toThrow(
          'isolated trial',
        );
      }),
      {numRuns: 30},
    );
  });

  it('rejects selected-base symlinks before creating escaped write parents', async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), 'tn-selected-base-')));
    const home = resolve(root, 'primary-home');
    const selectedBase = resolve(home, '.threadnote');
    const sibling = resolve(root, 'secondary-home');
    try {
      await Promise.all([mkdir(home), mkdir(sibling)]);
      const env = collectionEnvironment(root, home);
      const anchorIdentity = await readCollectionDirectoryIdentity(home);
      await mkdir(selectedBase);
      await symlink(sibling, resolve(selectedBase, 'escape'));
      await expect(
        writeSyntheticCollectionFile(home, '.threadnote', 'escape/nested/capture.json', '{}', anchorIdentity, env),
      ).rejects.toThrow();
      expect(await readdir(sibling)).toEqual([]);
      await rm(selectedBase, {recursive: true, force: true});
      await symlink(sibling, selectedBase);
      await expect(
        writeSyntheticCollectionFile(home, '.threadnote', 'nested/capture.json', '{}', anchorIdentity, env),
      ).rejects.toThrow();
      expect(await readdir(sibling)).toEqual([]);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('rejects a hard-link alias of synthetic input by exact descriptor identity', async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), 'tn-synthetic-alias-')));
    try {
      const synthetic = resolve(root, 'synthetic.json');
      const alias = resolve(root, 'native.json');
      const home = resolve(root, 'home');
      await mkdir(home);
      const env = collectionEnvironment(root, home);
      const anchorIdentity = await readCollectionDirectoryIdentity(root);
      const identity = await writeSyntheticCollectionFile(
        root,
        '.',
        'synthetic.json',
        '{"synthetic":true}',
        anchorIdentity,
        env,
      );
      await link(synthetic, alias);
      await expect(
        readNativeCollectionJson(root, '.', 'native.json', anchorIdentity, new Set([identity]), env),
      ).rejects.toThrow('Synthetic input');
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('keeps descriptor-relative writes out of a concurrently retargeted selected base', async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), 'tn-selected-base-race-')));
    const home = resolve(root, 'home');
    const selectedBase = resolve(home, '.threadnote');
    const detached = resolve(home, 'detached-threadnote');
    const outside = resolve(root, 'outside');
    const ready = resolve(root, 'file-ready');
    const release = resolve(root, 'file-release');
    try {
      await Promise.all([mkdir(resolve(selectedBase, 'nested'), {recursive: true}), mkdir(outside)]);
      const anchorIdentity = await readCollectionDirectoryIdentity(home);
      const env = {
        ...collectionEnvironment(root, home),
        THREADNOTE_COLLECTION_TEST_FILE_READY: ready,
        THREADNOTE_COLLECTION_TEST_FILE_RELEASE: release,
      };
      const pending = writeSyntheticCollectionFile(
        home,
        '.threadnote',
        'nested/capture.json',
        '{"synthetic":true}',
        anchorIdentity,
        env,
      );
      await waitForCollectionMarker(ready);
      await rename(selectedBase, detached);
      await symlink(outside, selectedBase);
      await writeFile(release, '', {flag: 'wx'});
      await expect(pending).rejects.toThrow('changed during descriptor-relative access');
      expect(await readdir(outside)).toEqual([]);
      await expect(readFile(resolve(detached, 'nested', 'capture.json'))).rejects.toMatchObject({code: 'ENOENT'});
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('enforces one incremental byte budget across individually legal captures', () => {
    const budget = new CollectionCaptureBudget(10);
    budget.consume(6);
    expect(budget.remainingBytes).toBe(4);
    expect(() => budget.consume(5)).toThrow('retention bound');
    expect(budget.remainingBytes).toBe(4);
    fc.assert(
      fc.property(
        fc.integer({min: 1, max: 1024}),
        fc.array(fc.integer({min: 0, max: 256}), {minLength: 1, maxLength: 16}),
        (maximum, captures) => {
          const aggregate = new CollectionCaptureBudget(maximum);
          let accepted = 0;
          for (const bytes of captures) {
            if (accepted + bytes > maximum) {
              expect(() => aggregate.consume(bytes)).toThrow('retention bound');
              expect(aggregate.usedBytes).toBe(accepted);
              return;
            }
            aggregate.consume(bytes);
            accepted += bytes;
          }
          expect(aggregate.usedBytes).toBe(accepted);
        },
      ),
      {numRuns: 40},
    );
  });

  macosIt('applies the remaining aggregate budget while verified process output is streaming', async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), 'tn-capture-budget-')));
    try {
      const executable = resolve(root, 'candidate');
      await buildProbeCandidate(executable, false);
      const home = resolve(root, 'home');
      await mkdir(resolve(home, 'tmp'), {recursive: true});
      const env = collectionEnvironment(root, home);
      const launch = await createCollectionVerifiedLaunch(executable, await readCollectionPayloadIdentity(executable));
      const budget = new CollectionCaptureBudget(10);
      const first = await runVerifiedCollectionProcess(launch, ['emit', '123456'], root, env, {
        maximumCaptureBytes: budget.remainingBytes,
      });
      budget.consume(Buffer.byteLength(first.stdout));
      await expect(
        runVerifiedCollectionProcess(launch, ['emit', '12345'], root, env, {
          maximumCaptureBytes: budget.remainingBytes,
        }),
      ).rejects.toThrow('output bound');
      expect(budget.usedBytes).toBe(6);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  macosIt('executes the isolated product boundary but publishes nothing when a native adapter fails', async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), 'tn-collector-run-')));
    try {
      const executable = resolve(root, 'candidate');
      await buildCandidate(executable);
      const value = plan();
      value.candidate = {
        ...candidate,
        executableSha256: (await readCollectionPayloadIdentity(executable)).executableSha256,
      };
      value.recipes[0].steps[0].argv = ['context-brief'];
      await expect(
        collectThreadnote5Candidate({
          plan: value,
          approvedPlanHash: threadnote5CollectionPlanHash(value),
          executable,
          privateOutput: resolve(root, 'private'),
        }),
      ).rejects.toThrow('Candidate command failed');
      expect((await readdir(root)).sort()).toEqual(['candidate', 'candidate.c']);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('requires a reviewed plan and prevents ambient personal-home inheritance', async () => {
    const env = collectionEnvironment('/private/trial', '/private/trial/user');
    expect(env.THREADNOTE_HOME).toBe('/private/trial/user/.threadnote');
    expect(env.HOME).toBe('/private/trial/user');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    expect(() => collectionEnvironment('/private/trial', '/personal/home')).toThrow();
    await expect(
      collectThreadnote5Candidate({
        plan: plan(),
        approvedPlanHash: Effect.pipe('0', EffectString.repeat(64)),
        executable: '/missing',
        privateOutput: '/missing',
      }),
    ).rejects.toThrow('approval');
  });

  it('checks installed binary identity before and after actual process execution', async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), 'tn-collector-test-')));
    try {
      const executable = resolve(root, 'candidate');
      await buildCandidate(executable);
      const payload = await readCollectionPayloadIdentity(executable);
      const source = {...candidate, executableSha256: payload.executableSha256};
      const env = collectionEnvironment(root, resolve(root, 'user'));
      expect(await observeCollectionRuntime(executable, source, root, env)).toEqual({
        sourceCommit: candidate.commit,
        executableSha256: source.executableSha256,
      });
      await copyFile(executable, `${executable}.replacement`);
      await rename(`${executable}.replacement`, executable);
      await expect(observeCollectionRuntime(executable, source, root, env, payload)).rejects.toThrow('inode drift');
      await writeFile(executable, Buffer.concat([await readFile(executable), Buffer.from('changed-payload-bytes')]));
      await expect(observeCollectionRuntime(executable, source, root, env)).rejects.toThrow('bytes/inode drift');
      await writeFile(executable, '#!/bin/sh\nexit 0\n', {mode: 0o700});
      await expect(observeCollectionRuntime(executable, source, root, env)).rejects.toThrow('never a launcher');
      const command = await runCollectionProcess('/bin/sh', ['-c', 'printf native; exit 7'], root, env);
      expect(command).toMatchObject({exitCode: 7, stdout: 'native'});
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  macosIt('never executes CLI bytes swapped onto the verified candidate pathname', async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), 'tn-cli-object-binding-')));
    try {
      const executable = resolve(root, 'candidate');
      const replacement = resolve(root, 'replacement');
      const safeArchive = resolve(root, 'candidate-safe');
      await buildProbeCandidate(executable, false);
      await buildProbeCandidate(replacement, true);
      await copyFile(executable, safeArchive);
      const home = resolve(root, 'home');
      await mkdir(resolve(home, 'tmp'), {recursive: true});
      const ready = resolve(root, 'observer-ready');
      const release = resolve(root, 'observer-release');
      const env = {
        ...collectionEnvironment(root, home),
        THREADNOTE_COLLECTION_TEST_OBSERVER_READY: ready,
        THREADNOTE_COLLECTION_TEST_OBSERVER_RELEASE: release,
      };
      const payload = await readCollectionPayloadIdentity(executable);
      const launch = await createCollectionVerifiedLaunch(executable, payload);
      const result = await withCandidatePathReplacement(
        executable,
        safeArchive,
        replacement,
        root,
        ready,
        release,
        async () => await runVerifiedCollectionProcess(launch, ['probe'], root, env),
      );
      expect(result.stdout).not.toContain('replacement-bytes-executed');
      expect(result.exitCode).not.toBe(0);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  macosIt('never starts MCP bytes swapped onto the verified candidate pathname', async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), 'tn-mcp-object-binding-')));
    try {
      const executable = resolve(root, 'candidate');
      const replacement = resolve(root, 'replacement');
      const safeArchive = resolve(root, 'candidate-safe');
      const marker = resolve(root, 'replacement-started');
      await buildProbeCandidate(executable, false);
      await buildProbeCandidate(replacement, true);
      await copyFile(executable, safeArchive);
      const home = resolve(root, 'home');
      await mkdir(resolve(home, 'tmp'), {recursive: true});
      const ready = resolve(root, 'observer-ready');
      const release = resolve(root, 'observer-release');
      const env = {
        ...collectionEnvironment(root, home),
        ATTACK_MARKER: marker,
        THREADNOTE_COLLECTION_TEST_OBSERVER_READY: ready,
        THREADNOTE_COLLECTION_TEST_OBSERVER_RELEASE: release,
      };
      const payload = await readCollectionPayloadIdentity(executable);
      const launch = await createCollectionVerifiedLaunch(executable, payload);
      const transport = new CollectionMcpTransport({launch, argv: ['mcp-probe'], cwd: root, env});
      const outcome = new Promise<'message' | 'rejected'>(resolveOutcome => {
        transport.onmessage = () => resolveOutcome('message');
        transport.onerror = () => resolveOutcome('rejected');
        transport.onclose = () => resolveOutcome('rejected');
      });
      await withCandidatePathReplacement(executable, safeArchive, replacement, root, ready, release, async () => {
        await transport.start();
        await outcome;
        await transport.close().catch(() => {});
      });
      await expect(readFile(marker, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('fails atomically and refuses to overwrite an existing evidence directory', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'tn-collector-atomic-'));
    try {
      const output = resolve(root, 'final');
      await expect(
        atomicDirectory(output, async stage => {
          await writeFile(resolve(stage, 'partial'), 'private memory text');
          throw new Error('failed');
        }),
      ).rejects.toThrow('failed');
      expect(await readdir(root)).toEqual([]);
      await atomicDirectory(output, async stage => {
        await writeFile(resolve(stage, 'complete'), 'digest');
      });
      await expect(atomicDirectory(output, async () => {})).rejects.toThrow('exists');
      expect(await readFile(resolve(output, 'complete'), 'utf8')).toBe('digest');
      expect((await stat(output)).mode & 0o077).toBe(0);
      const raced = resolve(root, 'raced');
      await expect(
        atomicDirectory(raced, async () => {
          await mkdir(raced);
          await writeFile(resolve(raced, 'owner'), 'keep');
        }),
      ).rejects.toThrow();
      expect(await readFile(resolve(raced, 'owner'), 'utf8')).toBe('keep');
      const racedFile = resolve(root, 'raced-file');
      await expect(
        atomicDirectory(racedFile, async () => {
          await writeFile(racedFile, 'keep-file', {flag: 'wx'});
        }),
      ).rejects.toThrow();
      expect(await readFile(racedFile, 'utf8')).toBe('keep-file');
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('cannot publish transcripts, private memory, or unverified fixture records', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'tn-collector-private-'));
    try {
      await expect(
        sealThreadnote5Collection({
          collection: {
            version: 1,
            planHash: Effect.pipe('0', EffectString.repeat(64)),
            records: [],
            runtimeBoundaries: [],
            transcriptDigest: Effect.pipe('1', EffectString.repeat(64)),
          },
          plan: plan(),
          transcripts: [],
          collectionAuthorityBinding: {},
          expectedCollectionBindingSha256: Effect.pipe('0', EffectString.repeat(64)),
          fixture: {},
          candidate,
          authorityManifest: {private: 'private memory'},
          expectedAuthorityManifestSha256: Effect.pipe('1', EffectString.repeat(64)),
          publicOutput: resolve(root, 'public'),
        }),
      ).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('seals only content-free evidence and digests after strict source replay (test-only source doubles)', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'tn-collector-seal-'));
    try {
      const source = collectionTranscriptFixture();
      const authorityManifestHash = threadnote5LocalAuthorityManifestHash(source.authorityManifest);
      const binding = {version: 1, collectionHash: source.collection.collectionHash, authorityManifestHash};
      const output = resolve(root, 'public');
      await sealThreadnote5Collection({
        collection: source.collection,
        plan: source.plan,
        transcripts: source.transcripts,
        collectionAuthorityBinding: binding,
        expectedCollectionBindingSha256: threadnote5CollectionAuthorityBindingHash(binding),
        fixture,
        candidate,
        authorityManifest: source.authorityManifest,
        expectedAuthorityManifestSha256: threadnote5LocalAuthorityManifestHash(source.authorityManifest),
        publicOutput: output,
      });
      expect((await readdir(output)).sort()).toEqual(['digests.json', 'evidence.json']);
      const body = await readFile(resolve(output, 'evidence.json'), 'utf8');
      expect(body).not.toMatch(/"(?:artifact|stdout|stderr|receiptChain|feedbackEvents|artifactText)":/u);
      expect(body).not.toContain(root);
      expect(JSON.parse(body).candidateObservations).toHaveLength(15);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });
});

async function buildCandidate(path: string): Promise<void> {
  await buildNativeSource(
    path,
    `#include <stdio.h>\n#include <string.h>\nint main(int argc, char **argv) { if (argc > 1 && strcmp(argv[1], "--version") == 0) { puts("threadnote v${candidate.version}"); return 0; } return 9; }\n`,
  );
}

async function buildProbeCandidate(path: string, replacement: boolean): Promise<void> {
  await buildNativeSource(
    path,
    `#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\nint main(int argc, char **argv) { if (argc > 2 && strcmp(argv[1], "emit") == 0) { fputs(argv[2], stdout); return 0; } if (argc > 1 && strcmp(argv[1], "probe") == 0) { puts("${replacement ? 'replacement-bytes-executed' : 'verified-bytes-executed'}"); return 0; } if (argc > 1 && strcmp(argv[1], "mcp-probe") == 0) { ${replacement ? 'FILE *marker = fopen(getenv("ATTACK_MARKER"), "w"); if (marker != NULL) { fputs("executed", marker); fclose(marker); }' : ''} puts("{\\"jsonrpc\\":\\"2.0\\",\\"method\\":\\"probe\\"}"); fflush(stdout); return getchar() == EOF ? 0 : 0; } return 9; }\n`,
  );
}

async function buildNativeSource(path: string, source: string): Promise<void> {
  await writeFile(`${path}.c`, source);
  const root = resolve(path, '..');
  await mkdir(resolve(root, 'compiler-home', 'tmp'), {recursive: true});
  const compile = await runCollectionProcess(
    '/usr/bin/cc',
    [`${path}.c`, '-o', path],
    root,
    collectionEnvironment(root, resolve(root, 'compiler-home')),
  );
  await rm(resolve(root, 'compiler-home'), {recursive: true, force: true});
  if (compile.exitCode !== 0) throw new Error('Could not compile the test-only native candidate.');
}

async function withCandidatePathReplacement<T>(
  executable: string,
  safeArchive: string,
  replacement: string,
  root: string,
  ready: string,
  release: string,
  action: () => Promise<T>,
): Promise<T> {
  const attack = resolve(root, 'replacement-staged');
  const restore = resolve(root, 'restore-staged');
  await copyFile(replacement, attack);
  const pending = action();
  try {
    await waitForCollectionMarker(ready);
    await rename(attack, executable);
    await writeFile(release, '', {flag: 'wx'});
    return await pending;
  } finally {
    await copyFile(safeArchive, restore);
    await rename(restore, executable);
  }
}

async function waitForCollectionMarker(path: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (true) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if ((Predicate.hasProperty(error, 'code') ? error.code : undefined) !== 'ENOENT' || performance.now() >= deadline)
        throw error;
      await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 10));
    }
  }
}
