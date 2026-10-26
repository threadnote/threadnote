import {generationRoot, renderEntrypoints} from '../../src/dev_skills/inspection.js';
import {parseReceipt, receiptPath} from '../../src/dev_skills/registry.js';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import fc from 'fast-check';
import {expect, it} from 'vitest';
import {buildDevSkillsManifest} from '../../../../scripts/build.js';
import {installedSummary} from '../../src/dev_skills/capabilities.js';
import {hash} from '../../src/dev_skills/files.js';
import {
  loadDevSkillsBundleAt,
  nativeRequirements,
  parseDevSkillsManifest,
  parseHistoricalDevSkillsManifest,
} from '../../src/dev_skills/manifest.js';
import {parseCapabilities} from '../../src/dev_skills/refresh_state.js';
import {
  applyDevSkills,
  previewDevSkills,
  statusDevSkills,
  prepareDevSkillsRefresh,
  previewDevSkillsRefresh,
} from '../../src/dev_skills/index.js';
import {devSkillsCompatibility} from '../../src/dev_skills/manifest.js';
import {devSkillsReleaseFixture, devSkillsTestLayer, fixture, snapshot} from './service-fixture.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

it('rejects every missing native feature and unknown capability field', () => {
  const complete = {
    schemaVersion: 2,
    runtimeVersion: '5.3.0-beta.7',
    workflowProtocols: [1],
    stateSchemas: [1],
    enrollmentSchemas: [1, 2],
    manifestSchemas: [1, 2],
    nativeFeatures: nativeRequirements,
  };
  expect(parseCapabilities(complete)).toEqual(complete);
  fc.assert(
    fc.property(fc.constantFrom(...Object.keys(nativeRequirements)), key => {
      const features = Object.fromEntries(Object.entries(nativeRequirements).filter(([name]) => name !== key));
      expect(() => parseCapabilities({...complete, nativeFeatures: features})).toThrow();
    }),
    {numRuns: 20},
  );
  for (const malformed of [
    {...complete, extra: true},
    {...complete, schemaVersion: 3},
    {...complete, nativeFeatures: {...nativeRequirements, extra: 1}},
    {...complete, manifestSchemas: undefined},
  ])
    expect(() => parseCapabilities(malformed)).toThrow();
  const old = {
    schemaVersion: 1,
    runtimeVersion: complete.runtimeVersion,
    workflowProtocols: [1],
    stateSchemas: [1],
    enrollmentSchemas: [1, 2],
  };
  expect(parseCapabilities(old)).toEqual(old);
});

effectIt.effect('ships only native payload and matches the builder canonical contract', () =>
  Effect.gen(function* () {
    const bundle = yield* loadDevSkillsBundleAt(process.cwd(), '5.3.0-beta.7', false);
    expect(bundle.manifest.schemaVersion).toBe(2);
    expect(bundle.manifest.minimumRuntime).toBe('5.3.0-beta.7');
    expect(bundle.manifest.nativeRequirements).toEqual(nativeRequirements);
    for (const malformed of [
      {...bundle.manifest, nativeRequirements: undefined},
      {...bundle.manifest, nativeRequirements: {...nativeRequirements, unknownVersion: 1}},
      {...bundle.manifest, unknown: true},
      {...bundle.manifest, prerequisites: {...bundle.manifest.prerequisites, python: '>=3.10'}},
    ])
      expect(() => parseDevSkillsManifest(malformed)).toThrow();

    expect(bundle.manifest.prerequisites).not.toHaveProperty('python');
    expect(Object.keys(bundle.files).some(file => file.endsWith('.py'))).toBe(false);
    expect(yield* buildDevSkillsManifest(process.cwd(), '5.3.0-beta.7')).toEqual(bundle.manifest);
    expect(installedSummary(bundle.manifest)).toMatchObject({manifestSchema: 2, nativeRequirements});
  }).pipe(provideTestLayer(devSkillsTestLayer)),
);

effectIt.effect('preserves canonical historical ownership while refusing legacy readiness', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const current = (yield* loadDevSkillsBundleAt(f.source, '5.3.0-beta.4')).manifest;
    const {digest: _digest, nativeRequirements: _native, ...rest} = current;
    const legacy = {
      ...rest,
      schemaVersion: 1,
      prerequisites: {python: '>=3.10', commands: ['threadnote', 'git', 'rg'], prCommands: ['gh']},
    };
    const owned = {...legacy, digest: hash(JSON.stringify(legacy))};
    expect(parseHistoricalDevSkillsManifest(owned)).toEqual(owned);
    expect(() => parseDevSkillsManifest(owned)).toThrow();
    expect(installedSummary(parseHistoricalDevSkillsManifest(owned))).not.toHaveProperty('manifestSchema');
    expect(devSkillsCompatibility(parseHistoricalDevSkillsManifest(owned), '5.3.0-beta.7')[0].code).toBe(
      'legacy-workflow-update-required',
    );
  }).pipe(provideTestLayer(devSkillsTestLayer)),
);

effectIt.effect('rejects incomplete same-version native candidates before any writes', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const release = yield* devSkillsReleaseFixture(f, '5.3.0-beta.4');
    for (const key of Object.keys(nativeRequirements)) {
      const capabilities = {...release.capabilities, nativeFeatures: {...nativeRequirements, [key]: 2}};
      const before = yield* snapshot(f.root);
      const preview = yield* previewDevSkillsRefresh(f.config, {...release, capabilities}).pipe(f.run);
      expect(preview.compatibility).toBe('incompatible');
      expect(
        yield* prepareDevSkillsRefresh(f.config, preview, {expectedDigest: preview.previewDigest}).pipe(
          f.run,
          Effect.result,
        ),
      ).toMatchObject({_tag: 'Failure'});
      expect(yield* snapshot(f.root)).toEqual(before);
    }
    const {manifestSchemas: _schemas, nativeFeatures: _features, ...legacy} = release.capabilities;
    const before = yield* snapshot(f.root);
    const preview = yield* previewDevSkillsRefresh(f.config, {
      ...release,
      capabilities: {...legacy, schemaVersion: 1},
    }).pipe(f.run);
    expect(preview.compatibility).toBe('incompatible');
    expect(yield* snapshot(f.root)).toEqual(before);
  }).pipe(provideTestLayer(devSkillsTestLayer)),
);

effectIt.effect('updates recognized v1 ownership and preserves edited legacy payload on removal', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const selector = {agent: 'amp'};
    const installed = yield* f.run(applyDevSkills(f.config, 'install', selector));
    const bundle = yield* loadDevSkillsBundleAt(f.source, '5.3.0-beta.4');
    const {digest: _digest, nativeRequirements: _native, ...rest} = bundle.manifest;
    const legacy = {
      ...rest,
      schemaVersion: 1,
      prerequisites: {python: '>=3.10', commands: ['threadnote', 'git', 'rg'], prCommands: ['gh']},
    };
    const manifest = parseHistoricalDevSkillsManifest({...legacy, digest: hash(JSON.stringify(legacy))});
    const ownedPath = receiptPath(f.path, installed.target.skillRoot);
    const receipt = parseReceipt(JSON.parse(yield* f.fs.readFileString(ownedPath)));
    const entrypoints = renderEntrypoints(f.path, installed.target, {...bundle, manifest});
    yield* f.fs.rename(
      generationRoot(f.path, installed.target.skillRoot, bundle.manifest.digest),
      generationRoot(f.path, installed.target.skillRoot, manifest.digest),
    );
    for (const [relative, content] of Object.entries(entrypoints))
      yield* f.fs.writeFileString(f.path.join(installed.target.skillRoot, relative), content);
    yield* f.fs.writeFileString(
      ownedPath,
      JSON.stringify({...receipt, manifest, generations: {[manifest.digest]: manifest}, entrypoints}),
    );
    const status = (yield* f.run(statusDevSkills(f.config, selector))).targets[0];
    expect(status.readiness?.planning.state).toBe('blocked');
    expect(status.installationState).toBe('incompatible');
    expect(status.installed).toBeDefined();
    expect(status.installed).not.toHaveProperty('manifestSchema');
    expect(status.issues.map(issue => issue.code)).toEqual(['legacy-workflow-update-required']);
    expect(status.installedDigest).toBe(manifest.digest);
    for (const action of ['update', 'remove'] as const) {
      const preview = yield* f.run(previewDevSkills(f.config, action, selector));
      expect(preview.canApply).toBe(true);
      expect(preview.readiness?.planning.state).toBe('blocked');
    }
    const update = yield* f.run(previewDevSkills(f.config, 'update', selector));
    const untouched = yield* snapshot(f.root);
    expect(
      yield* f.run(applyDevSkills(f.config, 'update', selector, {expectedDigest: '0'.repeat(64)})).pipe(Effect.result),
    ).toMatchObject({_tag: 'Failure'});
    expect(yield* snapshot(f.root)).toEqual(untouched);
    expect(
      (yield* f.run(applyDevSkills(f.config, 'update', selector, {expectedDigest: update.previewDigest}))).applied,
    ).toBe(true);
    const oldFile = f.path.join(
      generationRoot(f.path, installed.target.skillRoot, manifest.digest),
      'dev-plan/scripts/helper.py',
    );
    yield* f.fs.writeFileString(oldFile, 'user edited historical helper');
    const before = yield* snapshot(f.root);
    expect(yield* f.run(applyDevSkills(f.config, 'update', selector)).pipe(Effect.result)).toMatchObject({
      _tag: 'Failure',
    });
    expect(yield* snapshot(f.root)).toEqual(before);
    yield* f.run(applyDevSkills(f.config, 'remove', selector));
    expect(yield* f.fs.readFileString(oldFile)).toBe('user edited historical helper');
  }).pipe(provideTestLayer(devSkillsTestLayer)),
);

effectIt.effect('rejects unsupported or malformed retained native feature pins before writes', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const installed = yield* f.run(applyDevSkills(f.config, 'install', {agent: 'amp'}));
    const ownedPath = receiptPath(f.path, installed.target.skillRoot);
    const receipt = parseReceipt(JSON.parse(yield* f.fs.readFileString(ownedPath)));
    const release = yield* devSkillsReleaseFixture(f, '5.3.0-beta.4');
    for (const native of [{...nativeRequirements, cycleVersion: 2}, {executorVersion: 1}]) {
      const {digest: _digest, ...rest} = receipt.manifest;
      const retained = {...rest, nativeRequirements: native};
      const digest = hash(JSON.stringify(retained));
      yield* f.fs.writeFileString(
        ownedPath,
        JSON.stringify({...receipt, generations: {...receipt.generations, [digest]: {...retained, digest}}}),
      );
      const before = yield* snapshot(f.root);
      const preview = yield* f.run(previewDevSkillsRefresh(f.config, release));
      expect(preview.compatibility).toBe('incompatible');
      expect(
        yield* f
          .run(prepareDevSkillsRefresh(f.config, preview, {expectedDigest: preview.previewDigest}))
          .pipe(Effect.result),
      ).toMatchObject({_tag: 'Failure'});
      expect(yield* snapshot(f.root)).toEqual(before);
    }
  }).pipe(provideTestLayer(devSkillsTestLayer)),
);
