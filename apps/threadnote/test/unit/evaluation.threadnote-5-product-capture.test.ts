import {Array as EffectArray} from 'effect';
import {BunFileSystem, BunPath} from '@effect/platform-bun';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import * as fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  createThreadnote5ProductCaptureV1,
  parseThreadnote5ProductCaptureV1,
  productCaptureCanonicalJson,
  productCaptureFilename,
  productCaptureIdentityDigest,
  PRODUCT_CAPTURE_LIMITS,
} from '@threadnote/threadnote/evaluation/threadnote-5-product-capture';
import {
  captureThreadnote5ProductEventV1,
  isTrustedProductCaptureDirectoryAuthority,
} from '@threadnote/threadnote/evaluation/threadnote-5-product-capture-sink';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {aggregateValueReportV1} from '@threadnote/threadnote/value_report/index';
import {createActivationPlanV1} from '@threadnote/threadnote/activation/planner';
import {createActivationReceiptV1} from '@threadnote/threadnote/activation/receipt';
import {secondSurfaceChallengeIdV1} from '@threadnote/threadnote/activation/second/surface_store';
import {secondSurfaceProofContextHashV1} from '@threadnote/threadnote/activation/second/surface';
import {createProcedureVerificationReceipt, parseProcedureManifest} from '@threadnote/context/procedure/contract';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const commit = Effect2.pipe('a', EffectString.repeat(40));
const identity = {
  attempt: 0,
  candidate: {
    commit,
    executableSha256: Effect2.pipe('b', EffectString.repeat(64)),
    id: 'threadnote-5.0.0',
    version: `5.0.0-local.g${commit}`,
  },
  scenario: 'solo',
  trial: 0,
  version: 1,
} as const;
const request = {
  budgetTokens: 1250,
  mode: 'brief',
  scope: {callerCwd: '/work/repo', kind: 'repository', project: 'example'},
  task: 'Find the current contract',
} as const;
const event = {event: 'request', payload: request, sequence: 0, source: 'context-brief'} as const;
const layers = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);
const productCaptureSinkModule = new URL('../../src/evaluation/threadnote-5-product-capture-sink.ts', import.meta.url)
  .href;
const activationPlan = createActivationPlanV1({
  catalogSnapshotHash: Effect2.pipe('a', EffectString.repeat(64)),
  primarySurfaceId: 'codex',
  publicationMode: 'proposal',
  repositoryIdentityHash: Effect2.pipe('b', EffectString.repeat(64)),
  secondarySurfaceId: 'claude',
  selectedSourceSetHash: Effect2.pipe('c', EffectString.repeat(64)),
  taskHash: Effect2.pipe('d', EffectString.repeat(64)),
  teamId: 'default',
  teamShareStateHash: Effect2.pipe('e', EffectString.repeat(64)),
  threadnoteVersion: identity.candidate.version,
});
const proofContext = {
  activationId: Effect2.pipe('1', EffectString.repeat(64)),
  activationReceiptRevision: Effect2.pipe('2', EffectString.repeat(64)),
  catalogRevision: 'catalog-v1',
  catalogSnapshotHash: Effect2.pipe('3', EffectString.repeat(64)),
  decision: {
    canonicalUri: 'threadnote://user/tester/memories/shared/default/durable/projects/threadnote/decision.md',
    contentHash: Effect2.pipe('4', EffectString.repeat(64)),
    memoryId: 'tn_capture_decision',
    publicationReceiptHash: Effect2.pipe('5', EffectString.repeat(64)),
  },
  primary: {
    access: 'local-stdio',
    capabilitiesFingerprint: Effect2.pipe('6', EffectString.repeat(64)),
    configurationState: 'current',
    mcpCapability: 'managed',
    surfaceId: 'codex',
  },
  queryFingerprint: Effect2.pipe('7', EffectString.repeat(64)),
  repositoryIdentityHash: Effect2.pipe('8', EffectString.repeat(64)),
  repositoryState: 'clean',
  secondary: {
    access: 'local-stdio',
    capabilitiesFingerprint: Effect2.pipe('9', EffectString.repeat(64)),
    configurationState: 'current',
    mcpCapability: 'managed',
    surfaceId: 'claude',
  },
  startedAt: '2026-09-19T00:00:00.000Z',
  teamId: 'default',
  teamShareStateHash: Effect2.pipe('a', EffectString.repeat(64)),
} as const;
const challenge = {
  challengeId: secondSurfaceChallengeIdV1(proofContext),
  context: proofContext,
  contextHash: secondSurfaceProofContextHashV1(proofContext),
  issuedAt: proofContext.startedAt,
  nonceHash: Effect2.pipe('b', EffectString.repeat(64)),
  type: 'threadnote-second-surface-challenge',
  version: 1,
} as const;
const contextCheckReport = {
  evidenceReason: 'graph-impact-evidence-unavailable',
  evidenceStatus: 'unavailable',
  exitClassification: 'clean-with-evidence-warning',
  exitCode: 0,
  findings: [],
  limit: 100,
  omittedFindings: 0,
  project: 'threadnote',
  version: 2,
} as const;
const guidanceReceipt = {
  expectedManagedBlockHash: Effect2.pipe('c', EffectString.repeat(64)),
  previousManagedBlockHash: null,
  project: 'threadnote',
  removeTargetWhenEmpty: true,
  repositoryId: 'repository',
  sources: [{contentHash: Effect2.pipe('d', EffectString.repeat(64)), uri: 'threadnote://memory/tn_capture_guidance'}],
  state: 'current',
  targetIdentity: Effect2.pipe('e', EffectString.repeat(64)),
  targetPath: 'AGENTS.md',
  version: 2,
  wrapperOwned: false,
} as const;
const procedureManifest = parseProcedureManifest({
  artifact: {id: 'team.example/capture', semanticVersion: '1.0.0', sha256: Effect2.pipe('f', EffectString.repeat(64))},
  compatible: {capabilities: ['filesystem.read'], surfaceIds: ['terminal']},
  dependencies: [],
  owner: 'owner-opaque',
  presentation: {summary: 'Capture verified evidence.', taskKeywords: ['capture']},
  relatedDurableMemoryIds: [],
  reviewedOn: '2026-09-19',
  rollout: {channel: 'stable', percentage: 100},
  schemaVersion: 2,
  verification: {commands: [{argv: ['bun', 'test'], id: 'unit'}], fixtures: []},
});
const nativeCases = [
  {event: {event: 'plan', payload: activationPlan, sequence: 0, source: 'activation'}, scenario: 'solo'},
  {
    event: {
      event: 'receipt',
      payload: createActivationReceiptV1(activationPlan, '2026-09-19T00:00:00.000Z'),
      sequence: 1,
      source: 'activation',
    },
    scenario: 'solo',
  },
  {event: {event: 'challenge', payload: challenge, sequence: 2, source: 'activation'}, scenario: 'solo'},
  {event, scenario: 'solo'},
  {
    event: {
      event: 'report',
      payload: aggregateValueReportV1({period: {from: '2026-09-01T00:00:00.000Z', to: '2026-09-19T00:00:00.000Z'}}),
      sequence: 0,
      source: 'value-report',
    },
    scenario: 'solo',
  },
  {
    event: {event: 'report', payload: contextCheckReport, sequence: 0, source: 'context-check'},
    scenario: 'dirty-worktree',
  },
  {
    event: {event: 'receipt', payload: guidanceReceipt, sequence: 0, source: 'guidance'},
    scenario: 'projection-drift',
  },
  {
    event: {event: 'manifest', payload: procedureManifest, sequence: 0, source: 'procedure'},
    scenario: 'verified-procedures',
  },
  {
    event: {
      event: 'receipt',
      payload: createProcedureVerificationReceipt(procedureManifest, {
        hostVersion: 'host',
        threadnoteVersion: identity.candidate.version,
        verifiedAt: '2026-09-19T00:00:00.000Z',
        verifier: 'verifier',
      }),
      sequence: 1,
      source: 'procedure',
    },
    scenario: 'verified-procedures',
  },
] as const;

describe('private product capture contract', () => {
  it('requires operator ownership for private roots and trusted ownership for every ancestor', () => {
    const effectiveUid = 501;
    expect(isTrustedProductCaptureDirectoryAuthority({mode: 0o700, uid: effectiveUid}, effectiveUid, true)).toBe(true);
    expect(isTrustedProductCaptureDirectoryAuthority({mode: 0o700, uid: 502}, effectiveUid, true)).toBe(false);
    expect(isTrustedProductCaptureDirectoryAuthority({mode: 0o755, uid: 0}, effectiveUid, false)).toBe(true);
    expect(isTrustedProductCaptureDirectoryAuthority({mode: 0o755, uid: 502}, effectiveUid, false)).toBe(false);
    expect(isTrustedProductCaptureDirectoryAuthority({mode: 0o1777, uid: 0}, effectiveUid, false)).toBe(true);
    expect(isTrustedProductCaptureDirectoryAuthority({mode: 0o1777, uid: 502}, effectiveUid, false)).toBe(false);
    expect(isTrustedProductCaptureDirectoryAuthority({mode: 0o777, uid: 0}, effectiveUid, false)).toBe(false);
  });

  it('round trips a bounded source-native record without observer authority', () => {
    const capture = createThreadnote5ProductCaptureV1(identity, event);
    expect(parseThreadnote5ProductCaptureV1(capture)).toEqual(capture);
    expect(capture.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(productCaptureFilename(capture)).toBe('context-brief-000.json');
    expect(() => parseThreadnote5ProductCaptureV1({...capture, networkCalls: 0})).toThrow();
    expect(() =>
      parseThreadnote5ProductCaptureV1({...capture, digest: Effect2.pipe('0', EffectString.repeat(64))}),
    ).toThrow();
  });

  it('canonicalizes object key insertion order and preserves meaningful array order', () => {
    fc.assert(
      fc.property(fc.shuffledSubarray(EffectRecord.toEntries(request), {minLength: 4, maxLength: 4}), entries => {
        expect(
          createThreadnote5ProductCaptureV1(identity, {...event, payload: EffectRecord.fromEntries(entries)}),
        ).toEqual(createThreadnote5ProductCaptureV1(identity, event));
      }),
      {numRuns: 30},
    );
    expect(productCaptureCanonicalJson({items: ['first', 'second']})).not.toBe(
      productCaptureCanonicalJson({items: ['second', 'first']}),
    );
  });

  it('rejects unknown source/event pairs and unknown native fields at every level', () => {
    for (const source of ['migration', 'org', '../activation', 'context-health', 'git-proposal', 'closeout']) {
      expect(() => createThreadnote5ProductCaptureV1(identity, {...event, source})).toThrow();
    }
    expect(() => createThreadnote5ProductCaptureV1(identity, {...event, event: 'arbitrary'})).toThrow();
    expect(() =>
      createThreadnote5ProductCaptureV1(identity, {...event, payload: {...request, networkCalls: 0}}),
    ).toThrow();
    expect(() =>
      createThreadnote5ProductCaptureV1(identity, {
        ...event,
        payload: {...request, scope: {...request.scope, extra: true}},
      }),
    ).toThrow();
    expect(() => createThreadnote5ProductCaptureV1({...identity, scenario: 'upgrade-downgrade'}, event)).toThrow();
  });

  it('round trips every admitted native source/event pair and rejects excess payload fields', () => {
    const nativeRequest = structuredClone(request);
    const capture = createThreadnote5ProductCaptureV1(identity, {...event, payload: nativeRequest});
    Object.assign(nativeRequest, {task: 'Changed after capture'});
    expect(parseThreadnote5ProductCaptureV1(capture)).toEqual(capture);
    expect(capture.payload).toEqual(request);
    for (const native of nativeCases) {
      const captureIdentity = {...identity, scenario: native.scenario};
      const parsed = parseThreadnote5ProductCaptureV1(createThreadnote5ProductCaptureV1(captureIdentity, native.event));
      expect([parsed.source, parsed.event]).toEqual([native.event.source, native.event.event]);
      expect(() =>
        createThreadnote5ProductCaptureV1(captureIdentity, {
          ...native.event,
          payload: {...native.event.payload, surprise: true},
        }),
      ).toThrow();
    }
  });

  it('bounds trial, attempt and event identity without silently normalizing', () => {
    fc.assert(
      fc.property(fc.integer({min: 0, max: 63}), fc.integer({min: 0, max: 255}), (index, sequence) => {
        expect(
          createThreadnote5ProductCaptureV1({...identity, trial: index, attempt: index}, {...event, sequence}).trial,
        ).toBe(index);
        expect(() => createThreadnote5ProductCaptureV1({...identity, trial: index + 64}, event)).toThrow();
        expect(() => createThreadnote5ProductCaptureV1(identity, {...event, sequence: sequence + 256})).toThrow();
      }),
      {numRuns: 30},
    );
    for (const invalid of [-1, 0.5, NaN, Infinity, '0', '../0']) {
      expect(() => createThreadnote5ProductCaptureV1({...identity, attempt: invalid}, event)).toThrow();
    }
    expect(() =>
      createThreadnote5ProductCaptureV1({...identity, candidate: {...identity.candidate, extra: 1}}, event),
    ).toThrow();
  });

  it('enforces exact field, container, depth and UTF-8 byte bounds', () => {
    const limit = PRODUCT_CAPTURE_LIMITS;
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
    expect(() => productCaptureCanonicalJson('a'.repeat(limit.stringBytes))).not.toThrow();
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
    expect(() => productCaptureCanonicalJson('a'.repeat(limit.stringBytes + 1))).toThrow();
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
    expect(() => productCaptureCanonicalJson('é'.repeat(limit.stringBytes / 2 + 1))).toThrow();
    expect(() => productCaptureCanonicalJson(Array.from({length: limit.arrayItems}, () => null))).not.toThrow();
    expect(() => productCaptureCanonicalJson(Array.from({length: limit.arrayItems + 1}, () => null))).toThrow();
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
    expect(() => productCaptureCanonicalJson({['x'.repeat(limit.keyBytes)]: null})).not.toThrow();
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
    expect(() => productCaptureCanonicalJson({['x'.repeat(limit.keyBytes + 1)]: null})).toThrow();
    const nested = (depth: number): unknown => (depth === 0 ? null : [nested(depth - 1)]);
    expect(() => productCaptureCanonicalJson(nested(limit.depth))).not.toThrow();
    expect(() => productCaptureCanonicalJson(nested(limit.depth + 1))).toThrow();
    expect(() =>
      productCaptureCanonicalJson(
        EffectRecord.fromEntries(Array.from({length: limit.objectFields}, (_, index) => [`f${index}`, null])),
      ),
    ).not.toThrow();
    expect(() =>
      productCaptureCanonicalJson(
        EffectRecord.fromEntries(Array.from({length: limit.objectFields + 1}, (_, index) => [`f${index}`, null])),
      ),
    ).toThrow();
    const exactEntries = EffectRecord.fromEntries(
      Array.from({length: 32}, (_, index) => [`f${index}`, Array.from({length: 255}, () => null)]),
    );
    expect(() => productCaptureCanonicalJson(exactEntries)).not.toThrow();
    expect(() => productCaptureCanonicalJson({...exactEntries, f0: Array.from({length: 256}, () => null)})).toThrow();
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
    const exactBytes = Array.from({length: 16}, (_, index) => 'a'.repeat(limit.stringBytes - (index === 0 ? 49 : 0)));
    expect(Buffer.byteLength(productCaptureCanonicalJson(exactBytes))).toBe(limit.bytes);
    exactBytes[0] += 'a';
    expect(() => productCaptureCanonicalJson(exactBytes)).toThrow();
    expect(() =>
      productCaptureCanonicalJson({
        get unsafe() {
          throw new Error('must not read accessor');
        },
      }),
    ).toThrow();
  });

  it('accepts exact scalar/container bounds and rejects every generated excess', () => {
    fc.assert(
      fc.property(fc.integer({min: -4, max: 4}), offset => {
        // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
        const scalar = () => productCaptureCanonicalJson('x'.repeat(PRODUCT_CAPTURE_LIMITS.stringBytes + offset));
        const array = () =>
          productCaptureCanonicalJson(Array.from({length: PRODUCT_CAPTURE_LIMITS.arrayItems + offset}, () => null));
        if (offset <= 0) {
          expect(scalar).not.toThrow();
          expect(array).not.toThrow();
        } else {
          expect(scalar).toThrow();
          expect(array).toThrow();
        }
      }),
      {numRuns: 20},
    );
  });
});

describe('private product capture sink', () => {
  effectIt.effect('is inert without explicit configuration, including lazy payload construction', () =>
    captureThreadnote5ProductEventV1(undefined, () => {
      throw new Error('must not evaluate');
    }).pipe(
      Effect.tap(result => Effect.sync(() => expect(result).toBeUndefined())),
      provideTestLayer(layers),
    ),
  );

  fcEffectProp(
    effectIt,
    'never evaluates disabled capture payloads',
    [fc.string({maxLength: 128})],
    ([message]) => {
      let evaluated = false;
      return captureThreadnote5ProductEventV1(undefined, () => {
        evaluated = true;
        throw new Error(message);
      }).pipe(
        Effect.tap(result =>
          Effect.sync(() => {
            expect(result).toBeUndefined();
            expect(evaluated).toBe(false);
          }),
        ),
        provideTestLayer(layers),
      );
    },
    {fastCheck: {numRuns: 10}},
  );

  fcEffectProp(
    effectIt,
    'rejects generated path traversal identities',
    [fc.string({unit: fc.constantFrom(...'abcdef0123456789'), minLength: 1, maxLength: 32})],
    ([component]) =>
      captureThreadnote5ProductEventV1(
        JSON.stringify({...identity, root: `/private/${component}/../capture`}),
        () => event,
      ).pipe(
        Effect.result,
        Effect.tap(result => Effect.sync(() => expect(result._tag).toBe('Failure'))),
        provideTestLayer(layers),
      ),
    {fastCheck: {numRuns: 10}},
  );

  fcEffectProp(
    effectIt,
    'rejects malformed explicit configuration without evaluating source data',
    [fc.constantFrom('', '{}', 'null', 'false', '{', Effect2.pipe('x', EffectString.repeat(8193)))],
    ([configuration]) =>
      captureThreadnote5ProductEventV1(configuration, () => {
        throw new Error('must not evaluate');
      }).pipe(
        Effect.result,
        Effect.tap(result => Effect.sync(() => expect(result._tag).toBe('Failure'))),
        provideTestLayer(layers),
      ),
    {fastCheck: {numRuns: 10}},
  );

  fcEffectProp(
    effectIt,
    'preserves append-only evidence under arbitrary publication order and concurrent duplicates',
    [fc.uniqueArray(fc.integer({min: 0, max: 255}), {minLength: 1, maxLength: 5})],
    ([sequences]) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temporary = yield* fs.makeTempDirectoryScoped({prefix: 'product-capture-property-'});
        const root = yield* fs.realPath(temporary);
        yield* fs.chmod(root, 0o700);
        const configuration = JSON.stringify({...identity, root});
        const results = yield* Effect.forEach(
          EffectArray.flatMap(sequences, sequence => [sequence, sequence]),
          sequence => captureThreadnote5ProductEventV1(configuration, () => ({...event, sequence})).pipe(Effect.result),
          {concurrency: 'unbounded'},
        );
        const successes = EffectArray.filter(results, result => result._tag === 'Success');
        expect(successes).toHaveLength(sequences.length);
        const directory = path.dirname(successes[0].success!);
        expect(
          EffectArray.filter(
            yield* fs.readDirectory(directory),
            __effectArrayValue => !!(name => Effect2.pipe(name, EffectString.endsWith('.json')))(__effectArrayValue),
          ).sort(),
        ).toEqual(
          EffectArray.map(sequences, sequence =>
            productCaptureFilename(createThreadnote5ProductCaptureV1(identity, {...event, sequence})),
          ).sort(),
        );
        for (const sequence of sequences) {
          const capture = createThreadnote5ProductCaptureV1(identity, {...event, sequence});
          expect(yield* fs.readFileString(path.join(directory, productCaptureFilename(capture)))).toBe(
            productCaptureCanonicalJson(capture) + '\n',
          );
        }
      }).pipe(provideTestLayer(layers)),
    {fastCheck: {numRuns: 10}},
  );

  effectIt.effect('publishes private canonical files atomically and never replaces evidence', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporary = yield* fs.makeTempDirectoryScoped({prefix: 'product-capture-'});
      const root = yield* fs.realPath(temporary);
      yield* fs.chmod(root, 0o700);
      const configuration = JSON.stringify({...identity, root});
      const published = yield* captureThreadnote5ProductEventV1(configuration, () => event);
      expect(published).toBeDefined();
      const content = yield* fs.readFileString(published!);
      expect(content).toBe(productCaptureCanonicalJson(createThreadnote5ProductCaptureV1(identity, event)) + '\n');
      expect((yield* fs.stat(published!)).mode & 0o777).toBe(0o600);
      expect((yield* fs.stat(path.dirname(published!))).mode & 0o777).toBe(0o700);
      expect((yield* captureThreadnote5ProductEventV1(configuration, () => event).pipe(Effect.result))._tag).toBe(
        'Failure',
      );
      expect(yield* fs.readFileString(published!)).toBe(content);
      const second = yield* captureThreadnote5ProductEventV1(configuration, () => ({...event, sequence: 1}));
      expect(second).not.toBe(published);
      expect(
        EffectArray.filter(
          yield* fs.readDirectory(path.dirname(published!)),
          __effectArrayValue => !!(name => Effect2.pipe(name, EffectString.endsWith('.json')))(__effectArrayValue),
        ).sort(),
      ).toEqual(['context-brief-000.json', 'context-brief-001.json']);
      const sentinel = path.join(root, 'sentinel');
      yield* fs.writeFileString(sentinel, 'unchanged');
      const occupied = path.join(path.dirname(published!), 'context-brief-002.json');
      yield* fs.symlink(sentinel, occupied);
      expect(
        (yield* captureThreadnote5ProductEventV1(configuration, () => ({...event, sequence: 2})).pipe(Effect.result))
          ._tag,
      ).toBe('Failure');
      expect(yield* fs.readFileString(sentinel)).toBe('unchanged');
      expect(yield* fs.readLink(occupied)).toBe(sentinel);
    }).pipe(provideTestLayer(layers)),
  );

  effectIt.effect('erases failed reservations and never reuses or promotes an occupied destination', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporary = yield* fs.makeTempDirectoryScoped({prefix: 'product-capture-occupied-'});
      const root = yield* fs.realPath(temporary);
      yield* fs.chmod(root, 0o700);
      const directory = path.join(root, productCaptureIdentityDigest(identity));
      yield* fs.makeDirectory(directory, {mode: 0o700});
      const output = path.join(directory, productCaptureFilename(createThreadnote5ProductCaptureV1(identity, event)));
      const pending = `${output}.pending`;
      const sentinel = path.join(root, 'sentinel');
      yield* fs.writeFileString(sentinel, 'unrelated', {mode: 0o600});
      yield* fs.link(sentinel, output);
      const configuration = JSON.stringify({...identity, root});

      expect((yield* captureThreadnote5ProductEventV1(configuration, () => event).pipe(Effect.result))._tag).toBe(
        'Failure',
      );
      expect(yield* fs.readFileString(sentinel)).toBe('unrelated');
      expect(yield* fs.readFileString(output)).toBe('unrelated');
      expect(yield* fs.readFileString(pending)).toBe('');
      expect((yield* fs.stat(pending)).mode & 0o777).toBe(0o600);
      expect((yield* captureThreadnote5ProductEventV1(configuration, () => event).pipe(Effect.result))._tag).toBe(
        'Failure',
      );
      expect(yield* fs.readFileString(pending)).toBe('');
      const occupiedContent = yield* fs.readFileString(output);
      expect(() => parseThreadnote5ProductCaptureV1(JSON.parse(occupiedContent))).toThrow();
    }).pipe(provideTestLayer(layers)),
  );

  effectIt.effect('erases both links when post-link authority validation is interrupted', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporary = yield* fs.makeTempDirectoryScoped({prefix: 'product-capture-post-link-'});
      const root = yield* fs.realPath(temporary);
      yield* fs.chmod(root, 0o700);
      const directory = path.join(root, productCaptureIdentityDigest(identity));
      const output = path.join(directory, productCaptureFilename(createThreadnote5ProductCaptureV1(identity, event)));
      const pending = `${output}.pending`;
      const invalidating = FileSystem.FileSystem.of({
        ...fs,
        link: (from, to) => fs.link(from, to).pipe(Effect.andThen(fs.chmod(directory, 0o755))),
      });
      const configuration = JSON.stringify({...identity, root});
      expect(
        (yield* captureThreadnote5ProductEventV1(configuration, () => event).pipe(
          Effect.provideService(FileSystem.FileSystem, invalidating),
          Effect.result,
        ))._tag,
      ).toBe('Failure');
      expect(yield* fs.readFileString(pending)).toBe('');
      expect(yield* fs.readFileString(output)).toBe('');
      const invalidOutput = yield* fs.readFileString(output);
      expect(() => parseThreadnote5ProductCaptureV1(JSON.parse(invalidOutput))).toThrow();
      yield* fs.chmod(directory, 0o700);
      expect((yield* captureThreadnote5ProductEventV1(configuration, () => event).pipe(Effect.result))._tag).toBe(
        'Failure',
      );
    }).pipe(provideTestLayer(layers)),
  );

  effectIt.effect('fails closed across parent retarget and pending-path hard-link substitution races', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporary = yield* fs.makeTempDirectoryScoped({prefix: 'product-capture-race-'});
      const root = yield* fs.realPath(temporary);
      yield* fs.chmod(root, 0o700);
      const directory = path.join(root, productCaptureIdentityDigest(identity));
      const output = path.join(directory, productCaptureFilename(createThreadnote5ProductCaptureV1(identity, event)));
      const pending = `${output}.pending`;
      const moved = `${directory}.moved`;
      const configuration = JSON.stringify({...identity, root});
      const retargeting = FileSystem.FileSystem.of({
        ...fs,
        link: (from, to) =>
          fs
            .rename(directory, moved)
            .pipe(Effect.andThen(fs.makeDirectory(directory, {mode: 0o700})), Effect.andThen(fs.link(from, to))),
      });
      expect(
        (yield* captureThreadnote5ProductEventV1(configuration, () => event).pipe(
          Effect.provideService(FileSystem.FileSystem, retargeting),
          Effect.result,
        ))._tag,
      ).toBe('Failure');
      expect(yield* fs.readFileString(path.join(moved, path.basename(pending)))).toBe('');
      expect(yield* fs.exists(output)).toBe(false);

      yield* fs.remove(directory, {recursive: true});
      yield* fs.rename(moved, directory);
      yield* fs.remove(pending);
      const sentinel = path.join(root, 'sentinel');
      yield* fs.writeFileString(sentinel, 'unrelated', {mode: 0o600});
      const substituting = FileSystem.FileSystem.of({
        ...fs,
        link: (from, to) =>
          fs.remove(from).pipe(Effect.andThen(fs.link(sentinel, from)), Effect.andThen(fs.link(from, to))),
      });
      expect(
        (yield* captureThreadnote5ProductEventV1(configuration, () => event).pipe(
          Effect.provideService(FileSystem.FileSystem, substituting),
          Effect.result,
        ))._tag,
      ).toBe('Failure');
      expect(yield* fs.readFileString(sentinel)).toBe('unrelated');
      expect(yield* fs.readFileString(pending)).toBe('unrelated');
      expect(yield* fs.readFileString(output)).toBe('unrelated');
      const substitutedContent = yield* fs.readFileString(output);
      expect(() => parseThreadnote5ProductCaptureV1(JSON.parse(substitutedContent))).toThrow();
    }).pipe(provideTestLayer(layers)),
  );

  effectIt.effect('survives killed publishers before and immediately after the publication link', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporary = yield* fs.makeTempDirectoryScoped({prefix: 'product-capture-crash-window-'});
      const root = yield* fs.realPath(temporary);
      yield* fs.chmod(root, 0o700);
      const capture = createThreadnote5ProductCaptureV1(identity, event);
      const outputName = productCaptureFilename(capture);
      const expected = productCaptureCanonicalJson(capture) + '\n';

      for (const phase of ['before-link', 'after-link'] as const) {
        const phaseRoot = path.join(root, phase);
        yield* fs.makeDirectory(phaseRoot, {mode: 0o700});
        const configuration = JSON.stringify({...identity, root: phaseRoot});
        const marker = path.join(phaseRoot, 'ready');
        const child = Bun.spawn({
          cmd: [process.execPath, '--eval', productCaptureCrashChildScript(), phaseRoot, marker, phase],
          stderr: 'ignore',
          stdout: 'ignore',
        });
        const directory = path.join(phaseRoot, productCaptureIdentityDigest(identity));
        const output = path.join(directory, outputName);
        const pending = `${output}.pending`;
        try {
          yield* Effect.promise(() => waitForFile(marker));
          expect((yield* fs.stat(directory)).mode & 0o777).toBe(0o700);
          expect((yield* fs.stat(pending)).mode & 0o777).toBe(0o600);
          expect(yield* fs.readFileString(pending)).toBe(expected);

          if (phase === 'before-link') {
            for (let attempt = 0; attempt < 20; attempt += 1) {
              expect(
                EffectArray.filter(
                  yield* fs.readDirectory(directory),
                  __effectArrayValue =>
                    !!(name => Effect2.pipe(name, EffectString.endsWith('.json')))(__effectArrayValue),
                ),
              ).toEqual([]);
              yield* Effect.promise(() => Bun.sleep(1));
            }
          } else {
            for (let attempt = 0; attempt < 20; attempt += 1) {
              expect(
                EffectArray.filter(
                  yield* fs.readDirectory(directory),
                  __effectArrayValue =>
                    !!(name => Effect2.pipe(name, EffectString.endsWith('.json')))(__effectArrayValue),
                ),
              ).toEqual([outputName]);
              expect(yield* fs.readFileString(output)).toBe(expected);
              expect((yield* fs.stat(output)).mode & 0o777).toBe(0o600);
              yield* Effect.promise(() => Bun.sleep(1));
            }
          }
        } finally {
          if (child.exitCode === null) child.kill('SIGKILL');
          yield* Effect.promise(() => child.exited);
        }

        const restart = yield* captureThreadnote5ProductEventV1(configuration, () => event).pipe(Effect.result);
        expect(restart._tag).toBe('Failure');
        expect(yield* fs.readFileString(pending)).toBe(expected);
        expect((yield* fs.stat(pending)).mode & 0o777).toBe(0o600);
        expect((yield* fs.stat(directory)).mode & 0o777).toBe(0o700);
        expect(yield* fs.exists(output)).toBe(phase === 'after-link');
        if (phase === 'after-link') expect(yield* fs.readFileString(output)).toBe(expected);
      }
    }).pipe(provideTestLayer(layers)),
  );

  effectIt.effect('fails closed for unsafe roots and symlink ancestors', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporary = yield* fs.makeTempDirectoryScoped({prefix: 'product-capture-path-'});
      const root = yield* fs.realPath(temporary);
      const linked = path.join(root, 'link');
      yield* fs.symlink(root, linked);
      let evaluated = 0;
      for (const destination of [
        linked,
        path.join(linked, 'child'),
        root + '/../escape',
        'relative',
        '/',
        root + '/',
      ]) {
        const result = yield* captureThreadnote5ProductEventV1(JSON.stringify({...identity, root: destination}), () => {
          evaluated += 1;
          return event;
        }).pipe(Effect.result);
        expect(result._tag).toBe('Failure');
      }
      yield* fs.chmod(root, 0o755);
      expect(
        (yield* captureThreadnote5ProductEventV1(JSON.stringify({...identity, root}), () => {
          evaluated += 1;
          return event;
        }).pipe(Effect.result))._tag,
      ).toBe('Failure');
      expect(evaluated).toBe(0);
      expect(yield* fs.readDirectory(root)).toEqual(['link']);
      yield* fs.chmod(root, 0o700);
      const identityDirectory = path.join(root, productCaptureIdentityDigest(identity));
      yield* fs.makeDirectory(identityDirectory, {mode: 0o755});
      expect(
        (yield* captureThreadnote5ProductEventV1(JSON.stringify({...identity, root}), () => {
          evaluated += 1;
          return event;
        }).pipe(Effect.result))._tag,
      ).toBe('Failure');
      expect(evaluated).toBe(0);
    }).pipe(provideTestLayer(layers)),
  );

  effectIt.effect('does not evaluate private data when the capture root becomes stale during setup', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporary = yield* fs.makeTempDirectoryScoped({prefix: 'product-capture-stale-'});
      const parent = yield* fs.realPath(temporary);
      const root = path.join(parent, 'capture');
      const moved = path.join(parent, 'moved');
      yield* fs.makeDirectory(root, {mode: 0o700});
      const identityDirectory = path.join(root, productCaptureIdentityDigest(identity));
      const retargeting = FileSystem.FileSystem.of({
        ...fs,
        makeDirectory: (target, options) =>
          target === identityDirectory
            ? fs
                .rename(root, moved)
                .pipe(
                  Effect.andThen(fs.makeDirectory(root, {mode: 0o700})),
                  Effect.andThen(fs.makeDirectory(target, options)),
                )
            : fs.makeDirectory(target, options),
      });
      let evaluated = false;
      const result = yield* captureThreadnote5ProductEventV1(JSON.stringify({...identity, root}), () => {
        evaluated = true;
        return event;
      }).pipe(Effect.provideService(FileSystem.FileSystem, retargeting), Effect.result);
      expect(result._tag).toBe('Failure');
      expect(evaluated).toBe(false);
    }).pipe(provideTestLayer(layers)),
  );
});

function productCaptureCrashChildScript(): string {
  return `
    import {Effect, Layer} from 'effect';
    import {BunFileSystem, BunPath} from '@effect/platform-bun';
    import * as BunRuntime from '@effect/platform-bun/BunRuntime';
    import {captureThreadnote5ProductEventV1} from ${JSON.stringify(productCaptureSinkModule)};

    const [root, marker, phase] = process.argv.slice(1);
    const identity = ${JSON.stringify(identity)};
    const event = ${JSON.stringify(event)};
    const pause = () => Effect.promise(async () => {
      await Bun.write(marker, 'ready\\n');
      await new Promise(() => undefined);
    });
    const hooks = phase === 'before-link' ? {beforeLink: pause} : {afterLink: pause};
    BunRuntime.runMain(
      captureThreadnote5ProductEventV1(JSON.stringify({...identity, root}), () => event, hooks).pipe(
        Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
      ),
    );
  `;
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await Bun.file(file).exists()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${file}`);
}
