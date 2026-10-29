import {Array as EffectArray, Option as EffectOption} from 'effect';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {BunFileSystem} from '@effect/platform-bun';
import {describe, expect, it} from '@effect/vitest';
import {Effect, FileSystem, Predicate} from 'effect';
import {JSON_SCHEMA, load} from 'js-yaml';
import {BUILTIN_MODEL_MANIFESTS, CORE_EMBEDDING_MODEL_ID} from '@threadnote/inference/models/builtin';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const property = (value: unknown, key: string): unknown => (Predicate.isObject(value) ? value[key] : undefined);
const stringProperty = (value: unknown, key: string): string | undefined => {
  const candidate = property(value, key);
  return typeof candidate === 'string' ? candidate : undefined;
};
const requiredStringProperty = (value: unknown, key: string): string => {
  const candidate = stringProperty(value, key);
  if (candidate === undefined) throw new Error(`Expected string property ${key}.`);
  return candidate;
};
const arrayProperty = (value: unknown, key: string): readonly unknown[] | undefined => {
  const candidate = property(value, key);
  return EffectArray.isArray(candidate) ? candidate : undefined;
};

const readProjectFile = (path: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap(fs => fs.readFileString(`${process.cwd()}/${path}`)),
    provideTestLayer(BunFileSystem.layer),
  );

const projectFileExists = (path: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap(fs => fs.exists(`${process.cwd()}/${path}`)),
    provideTestLayer(BunFileSystem.layer),
  );

describe('standalone release workflows', () => {
  it.effect('reruns only release control-plane smokes before platform payload validation', () =>
    Effect.gen(function* () {
      const workflow = yield* readProjectFile('.github/workflows/publish.yml');
      const manifest: unknown = JSON.parse(yield* readProjectFile('package.json'));

      expect(stringProperty(property(manifest, 'scripts'), 'test:smoke:release')).toBe(
        'bun --bun vitest run apps/threadnote/test/unit/bun-package-contract.test.ts apps/threadnote/test/unit/publish-workflow.test.ts',
      );
      expect(workflow).toContain('name: Run release contract smokes');
      expect(workflow).toContain('run: bun run test:smoke:release');
      expect(workflow).not.toContain('- run: bun run lint');
      expect(workflow).not.toContain('- run: bun run format:check');
      expect(workflow).not.toContain('- run: bun run typecheck');
      expect(workflow).not.toContain('- run: bun run test\n');
    }),
  );

  it.effect('keeps internal architecture records and implementation plans out of the public docs tree', () =>
    Effect.gen(function* () {
      const ignore = yield* readProjectFile('.gitignore');

      expect(ignore).toContain('docs/**/architecture.md');
      expect(ignore).toContain('docs/**/*-architecture.md');
      expect(ignore).toContain('docs/**/*-implementation-plan.md');
      expect(ignore).toContain('docs/**/adr/');
    }),
  );

  it.effect('publishes macOS, Linux, and explicit unsigned Windows artifacts', () =>
    Effect.gen(function* () {
      const workflow = yield* readProjectFile('.github/workflows/publish.yml');

      expect(workflow).toContain('oven-sh/setup-bun@v2');
      expect(workflow).toContain('bun-linux-x64-baseline');
      expect(workflow).toContain('bun-linux-arm64');
      expect(workflow).toContain('bun-darwin-x64');
      expect(workflow).toContain('bun-darwin-arm64');
      expect(workflow).toContain('target: bun-windows-x64-baseline');
      expect(workflow).toContain('BUN_VERSION: 1.4.4');
      expect(workflow).toContain('Preload checksum-pinned Bun baseline compiler backend');
      expect(workflow).toContain('BUN_BASELINE_TARBALL_SHA512: 73ed7af55fa895edbdb24e46a45ba1e');
      expect(workflow).toContain('bun-windows-x64-baseline-v$env:BUN_VERSION');
      expect(workflow).toContain('bun-windows-arm64');
      expect(workflow).toContain('windows-11-arm');
      expect(
        Effect2.pipe(
          workflow,
          EffectString.match(/if: \$\{\{ false \}\}/g),
          Effect2.Option.getOrElse(() => null),
        ),
      ).toHaveLength(1);
      expect(workflow).toContain('name: Windows · ${{ matrix.architecture }} · unsigned');
      expect(workflow).toContain('bun --bun vitest run --config vitest.windows-e2e.config.ts');
      expect(workflow).toContain('name: release-windows-${{ matrix.architecture }}');
      expect(workflow).toContain("needs.windows-build.result == 'success'");
      expect(workflow).toContain('needs: [verify, linux, macos, windows-build]');
      expect(workflow).not.toContain('needs: [verify, linux, macos, production-large-evidence]');
      expect(workflow).not.toContain('needs: [linux, macos, windows-sign]');
      expect(workflow).not.toMatch(/\bnpm(?:\s|$)/);
    }),
  );

  it.effect('retains bounded exact-tag production-large evidence without blocking publication', () =>
    Effect.gen(function* () {
      const publish = yield* readProjectFile('.github/workflows/publish.yml');
      const releaseEvidence = yield* readProjectFile('.github/workflows/release-evidence.yml');
      const benchmarks = yield* readProjectFile('.github/workflows/benchmarks.yml');
      const evidence = yield* readProjectFile('.github/workflows/production-large-evidence.yml');

      expect(publish).not.toContain('production-large-evidence:');
      expect(publish).not.toContain('needs.production-large-evidence.result');
      expect(releaseEvidence).toContain('production-large-evidence:');
      expect(releaseEvidence).toContain('uses: ./.github/workflows/production-large-evidence.yml');
      expect(releaseEvidence).toContain('release_ref: ${{ github.ref }}');
      expect(releaseEvidence).toContain('release_sha: ${{ github.sha }}');
      expect(releaseEvidence).not.toContain('strict: false');
      expect(evidence).toContain('workflow_call:');
      expect(evidence).toContain('timeout-minutes: 30');
      expect(evidence).toContain('timeout-minutes: 20');
      expect(evidence).toContain('continue-on-error: true');
      expect(evidence).toContain('not-admitted-insufficient-capacity');
      expect(evidence).toContain('Enforce a completed production-shaped observation');
      expect(evidence).toContain('--minimum-free-gib 120');
      expect(evidence).toContain('--profile-files 3000');
      expect(evidence).toContain('--profile-symbols 110000');
      expect(evidence).toContain('--minimum-free-gib 20');
      expect(evidence).toContain('if-no-files-found: error');
      expect(evidence).toContain('retention-days: 90');
      expect(benchmarks).not.toContain("startsWith(github.ref, 'refs/tags/v4.0.0-");
      expect(benchmarks).not.toMatch(/^\s+push:\s*$/m);
    }),
  );

  it.effect('signs Apple artifacts, publishes unsigned Windows archives, and retains deferred Authenticode', () =>
    Effect.gen(function* () {
      const workflow = yield* readProjectFile('.github/workflows/publish.yml');
      const publisher = yield* readProjectFile('.github/workflows/publish-release-assets.yml');
      const signing = Effect2.pipe(
        workflow,
        EffectString.indexOf('Sign nested native code and Bun executable'),
        Effect2.Option.getOrElse(() => -1),
      );
      const notarization = Effect2.pipe(
        workflow,
        EffectString.indexOf('Notarize the exact release payload'),
        Effect2.Option.getOrElse(() => -1),
      );
      const macArchive = Effect2.pipe(
        workflow,
        EffectString.indexOf('THREADNOTE_RELEASE_TARGET: darwin-'),
        Effect2.Option.getOrElse(() => -1),
      );
      const authenticode = Effect2.pipe(
        workflow,
        EffectString.indexOf('Authenticode-sign executable and native payload'),
        Effect2.Option.getOrElse(() => -1),
      );
      const unsignedWindowsArchive = Effect2.pipe(
        workflow,
        EffectString.indexOf('THREADNOTE_RELEASE_TARGET: windows-'),
        Effect2.Option.getOrElse(() => -1),
      );
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native search position argument changes the search origin; Effect String has no position parameter.
      const signedWindowsArchive = workflow.indexOf('THREADNOTE_RELEASE_TARGET: windows-', authenticode);

      expect(signing).toBeGreaterThan(0);
      expect(notarization).toBeGreaterThan(signing);
      expect(macArchive).toBeGreaterThan(notarization);
      expect(workflow).not.toContain('codesign --deep');
      expect(workflow).toContain('find dist/runtime -type f -print0');
      expect(workflow).toContain('azure/artifact-signing-action@v2');
      expect(workflow).toContain('timestamp-rfc3161: http://timestamp.acs.microsoft.com');
      expect(unsignedWindowsArchive).toBeGreaterThan(macArchive);
      expect(unsignedWindowsArchive).toBeLessThan(authenticode);
      expect(signedWindowsArchive).toBeGreaterThan(authenticode);
      expect(publisher).toContain('gh release create');
      expect(publisher).toContain('Verify release immutability');
      const websiteRefresh = Effect2.pipe(
        workflow,
        EffectString.slice(
          Effect2.pipe(
            workflow,
            EffectString.indexOf('\n  refresh-website:'),
            Effect2.Option.getOrElse(() => -1),
          ),
        ),
      );
      expect(websiteRefresh).toContain('needs: publish-release');
      expect(websiteRefresh).toContain('Refresh website after stable release publication');
      expect(websiteRefresh).toContain(
        'gh workflow run pages.yml --repo "$GITHUB_REPOSITORY" --ref main -f release_tag="$RELEASE_TAG"',
      );
      expect(workflow).toContain('actions: write');
      expect(workflow).not.toContain('types: [published]');
    }),
  );

  it.effect('sets up the pinned Bun runtime before every publisher Bun invocation', () =>
    Effect.gen(function* () {
      const publisher: unknown = load(yield* readProjectFile('.github/workflows/publish-release-assets.yml'), {
        schema: JSON_SCHEMA,
      });
      const releaseWorkflow: unknown = load(yield* readProjectFile('.github/workflows/publish.yml'), {
        schema: JSON_SCHEMA,
      });
      const job = property(property(publisher, 'jobs'), 'publish');
      const steps = arrayProperty(job, 'steps') ?? [];
      const setupIndex = EffectOption.getOrElse(
        EffectArray.findFirstIndex(steps, step => stringProperty(step, 'uses') === 'oven-sh/setup-bun@v2'),
        () => -1,
      );
      const bunRunSteps = EffectArray.filter(
        EffectArray.map(steps, (step, index) => ({index, run: stringProperty(step, 'run') ?? ''})),
        ({run}) => /(?:^|[\s;&|])bun(?:\s|$)/.test(run),
      );

      expect(stringProperty(property(releaseWorkflow, 'env'), 'BUN_VERSION')).toBe('1.4.4');
      expect(stringProperty(property(job, 'env'), 'BUN_VERSION')).toBe(
        stringProperty(property(releaseWorkflow, 'env'), 'BUN_VERSION'),
      );
      expect(setupIndex).toBeGreaterThanOrEqual(0);
      expect(property(steps[setupIndex], 'with')).toEqual({'bun-version': '${{ env.BUN_VERSION }}'});
      expect(bunRunSteps.length).toBeGreaterThan(0);
      expect(EffectArray.every(bunRunSteps, ({index}) => setupIndex < index)).toBe(true);
    }),
  );

  it.effect('loads the publisher version validator without workspace dependencies', () =>
    Effect.gen(function* () {
      const publisher = yield* readProjectFile('.github/workflows/publish-release-assets.yml');
      const releaseWorkflow = yield* readProjectFile('.github/workflows/publish.yml');
      const validator = yield* readProjectFile('scripts/release-version.ts');

      for (const workflow of [publisher, releaseWorkflow]) {
        expect(workflow).toContain('await import("./scripts/release-version.ts")');
        expect(workflow).not.toContain('await import("./scripts/prepare-release.ts")');
      }
      expect(validator).not.toMatch(/^\s*import\s/m);
      expect(validator).toContain('Number.isSafeInteger');
    }),
  );

  it.effect('keeps the v4.6.0 publication recovery exact, one-shot, and artifact-bound', () =>
    Effect.gen(function* () {
      const recovery = yield* readProjectFile('.github/workflows/publish-v4.6.0-recovery.yml');

      expect(recovery).toContain('workflow_dispatch:');
      expect(recovery).not.toMatch(/^\s+push:\s*$/m);
      expect(recovery).toContain('group: publish-v4.6.0');
      expect(recovery).toContain('TAG_COMMIT: 242d0c47fec4d643154415cb69d05036cd4dc834');
      expect(recovery).toContain('RECOVERY_BASE_COMMIT: 539a2ea3790457ad2145a7e566958ffc9a6f40fe');
      expect(recovery).toContain('RECOVERY_BASE_TREE: f81cb3a625fdc959908bc0a584fa330650c0a374');
      expect(recovery).toContain('CANDIDATE_COMMIT: 9ac28435659ce421ebc78b302616eaac75112597');
      expect(recovery).toContain("REHEARSAL_RUN_ID: '33518869399'");
      expect(recovery).toContain('refs/threadnote-v4.6.0-recovery-tag^{commit}');
      expect(recovery).toContain('verify-code-memory-link-release-deferment.ts');
      expect(recovery).toContain('run.conclusion !== "success"');
      expect(recovery).toContain('Sign nested native code and Bun executable');
      expect(recovery).toContain('Notarize the exact release payload');
      expect(recovery).toContain('Verify PowerShell installer and installed runtime');
      expect(recovery).toContain('artifact.digest !== expected.digest');
      expect(recovery).toContain('artifact.expired !== false');
      expect(
        Effect2.pipe(
          recovery,
          EffectString.match(/sha256:[0-9a-f]{64}/g),
          Effect2.Option.getOrElse(() => null),
        ),
      ).toHaveLength(4);
      expect(
        Effect2.pipe(
          recovery,
          EffectString.match(/artifact: release-(?:darwin|windows)-(?:arm64|x64)$/gm),
          Effect2.Option.getOrElse(() => null),
        ),
      ).toHaveLength(4);
      expect(
        Effect2.pipe(
          recovery,
          EffectString.match(/ref: 9ac28435659ce421ebc78b302616eaac75112597/g),
          Effect2.Option.getOrElse(() => null),
        ),
      ).toHaveLength(1);
      expect(recovery).toContain('bun-linux-x64-baseline');
      expect(recovery).toContain('bun-linux-arm64');
      expect(recovery).toContain('doctor --dry-run --strict');
      expect(recovery).toContain('apps/threadnote/test/e2e/local-bins.e2e.ts');
      expect(recovery).toContain('actions/download-artifact@v8');
      expect(recovery).toContain('artifact-ids: ${{ matrix.artifact_id }}');
      expect(recovery).toContain('digest-mismatch: error');
      expect(recovery).toContain('merge-multiple: true');
      expect(
        Effect2.pipe(
          recovery,
          EffectString.match(/artifact_id: [0-9]+$/gm),
          Effect2.Option.getOrElse(() => null),
        ),
      ).toHaveLength(4);
      expect(recovery).toContain('run-id: 33518869399');
      expect(recovery).toContain('needs: [verify, linux, promote-rehearsal]');
      expect(recovery).toContain('uses: ./.github/workflows/publish-release-assets.yml');
      expect(recovery).toContain('release_tag: v4.6.0');
      expect(recovery).toContain('release_sha: 242d0c47fec4d643154415cb69d05036cd4dc834');
    }),
  );

  it.effect('requires curated versioned notes and prepends them to generated release notes', () =>
    Effect.gen(function* () {
      const workflow = yield* readProjectFile('.github/workflows/publish.yml');
      const publisher = yield* readProjectFile('.github/workflows/publish-release-assets.yml');
      const manifest: unknown = JSON.parse(yield* readProjectFile('package.json'));
      const version = requiredStringProperty(manifest, 'version');
      const notes = yield* readProjectFile(`.github/release-notes/v${version}.md`);

      expect(Effect2.pipe(notes, EffectString.trimStart)).toMatch(/^## What's new\s/);
      expect(workflow).toContain('Verify versioned release notes');
      expect(workflow).toContain('.github/release-notes/${RELEASE_TAG}.md');
      expect(publisher).toContain('release_flags=(--verify-tag --generate-notes)');
      expect(publisher).toContain('--notes "$release_notes"');
    }),
  );

  it.effect('builds stable and beta releases from canonical tags whose commits are present on protected main', () =>
    Effect.gen(function* () {
      const workflow = yield* readProjectFile('.github/workflows/publish.yml');
      const publisher = yield* readProjectFile('.github/workflows/publish-release-assets.yml');
      const verifyJob = Effect2.pipe(
        workflow,
        EffectString.slice(
          Effect2.pipe(
            workflow,
            EffectString.indexOf('  verify:'),
            Effect2.Option.getOrElse(() => -1),
          ),
          Effect2.pipe(
            workflow,
            EffectString.indexOf('\n  linux:'),
            Effect2.Option.getOrElse(() => -1),
          ),
        ),
      );
      const resolveRelease = Effect2.pipe(
        verifyJob,
        EffectString.indexOf('Resolve exact release source'),
        Effect2.Option.getOrElse(() => -1),
      );
      const releaseSmokes = Effect2.pipe(
        verifyJob,
        EffectString.indexOf('Run release contract smokes'),
        Effect2.Option.getOrElse(() => -1),
      );

      expect(verifyJob).toContain('runs-on: ubuntu-latest');
      expect(verifyJob).toContain('release_commit: ${{ steps.release_source.outputs.release_commit }}');
      expect(verifyJob).toContain('RELEASE_TAG: ${{ github.ref_name }}');
      expect(verifyJob).toContain('name: Validate release tag syntax');
      expect(verifyJob).toContain('refs/tags/${RELEASE_TAG}^{commit}');
      expect(verifyJob).toContain('git merge-base --is-ancestor "$head_commit" refs/remotes/origin/main');
      expect(verifyJob).toContain('await import("./scripts/release-version.ts")');
      expect(verifyJob).toContain('isSupportedReleaseVersion(tag.slice(1))');
      expect(verifyJob).toContain('canonical safe-integer stable vX.Y.Z');
      expect(verifyJob).toContain('canonical safe-integer stable vX.Y.Z or numbered beta vX.Y.Z-beta.N.');
      expect(verifyJob).toContain('A release tag commit must be present on protected origin/main.');
      expect(verifyJob).not.toContain('release/5.0.0');
      expect(verifyJob).toContain('printf \'release_commit=%s\\n\' "$head_commit"');
      expect(verifyJob).not.toContain('code-memory-link');
      expect(verifyJob).not.toContain('CANDIDATE_COMMIT');
      expect(resolveRelease).toBeGreaterThan(0);
      expect(releaseSmokes).toBeGreaterThan(resolveRelease);
      expect(
        Effect2.pipe(
          verifyJob,
          EffectString.indexOf('Validate release tag syntax'),
          Effect2.Option.getOrElse(() => -1),
        ),
      ).toBeLessThan(
        Effect2.pipe(
          verifyJob,
          EffectString.indexOf('Verify release tag matches package version'),
          Effect2.Option.getOrElse(() => -1),
        ),
      );
      expect(verifyJob).not.toContain('release_tag="${{ github.ref_name }}"');
      expect(verifyJob).not.toContain('.github/release-notes/${{ github.ref_name }}.md');
      expect(
        Effect2.pipe(
          workflow,
          EffectString.match(/needs: verify/g),
          Effect2.Option.getOrElse(() => null),
        ),
      ).toHaveLength(3);
      expect(
        Effect2.pipe(
          workflow,
          EffectString.match(/name: Select exact verified release source/g),
          Effect2.Option.getOrElse(() => null),
        ),
      ).toHaveLength(3);
      expect(
        Effect2.pipe(
          workflow,
          EffectString.match(/RELEASE_COMMIT: \$\{\{ needs\.verify\.outputs\.release_commit \}\}/g),
          Effect2.Option.getOrElse(() => null),
        ),
      ).toHaveLength(3);
      expect(
        Effect2.pipe(
          workflow,
          EffectString.match(/ref: \$\{\{ github\.sha \}\}/g),
          Effect2.Option.getOrElse(() => null),
        ),
      ).toHaveLength(5);
      expect(
        Effect2.pipe(
          workflow,
          EffectString.match(/persist-credentials: false/g),
          Effect2.Option.getOrElse(() => null),
        ),
      ).toHaveLength(5);
      expect(workflow).toContain('release_sha: ${{ github.sha }}');
      expect(workflow).not.toContain('THREADNOTE_RELEASE_COORDINATOR_TOKEN');
      expect(publisher).toContain('ref: ${{ inputs.release_sha }}');
      expect(publisher).toContain('persist-credentials: false');
      expect(publisher).toContain('refs/tags/${RELEASE_TAG}:refs/threadnote-release-tag');
      expect(publisher).toContain('remote_tag_commit');
      expect(publisher).toContain('await import("./scripts/release-version.ts")');
      expect(publisher).toContain('isSupportedReleaseVersion(tag.slice(1))');
      expect(publisher).toContain('git merge-base --is-ancestor "$verified_commit" refs/remotes/origin/main');
      expect(publisher).toContain(
        'Release source is no longer present on protected origin/main; refusing publication.',
      );
      expect(
        Effect2.pipe(
          publisher,
          EffectString.match(/verify_release_source/g),
          Effect2.Option.getOrElse(() => null),
        ),
      ).toHaveLength(3);
      expect(publisher).toContain('final practical gate');
      expect(publisher).toContain('protected-main provenance');
      expect(publisher).toContain('GH_TOKEN: ${{ github.token }}');
      expect(publisher).not.toContain('release_coordinator_token');
      expect(publisher).not.toContain('publication freeze');
      expect(publisher).not.toContain('release/5.0.0');
      expect(publisher).toContain('release_flags+=(--prerelease)');
    }),
  );

  it.effect('produces a real embedding on every native release runner before signing or archiving', () =>
    Effect.gen(function* () {
      const workflow = yield* readProjectFile('.github/workflows/publish.yml');
      expect(
        Effect2.pipe(
          workflow,
          EffectString.match(/Produce a real embedding with the release payload/g),
          Effect2.Option.getOrElse(() => null),
        ),
      ).toHaveLength(3);
      expect(
        Effect2.pipe(
          workflow,
          EffectString.match(/test\/e2e\/local-bins\.e2e\.ts/g),
          Effect2.Option.getOrElse(() => null),
        ),
      ).toHaveLength(3);
    }),
  );

  it.effect('embeds the checksum-pinned core model in every standalone executable', () =>
    Effect.gen(function* () {
      const workflow = yield* readProjectFile('.github/workflows/publish.yml');
      const ci = yield* readProjectFile('.github/workflows/ci.yml');
      const asset = yield* readProjectFile('apps/threadnote/src/models/core-embedding-asset.ts');
      const checker = yield* readProjectFile('scripts/check-embedded-core-model.ts');
      const modelLicense = yield* readProjectFile('assets/models/licenses/bge-small-en-v1.5.LICENSE');
      const packageManifest: unknown = JSON.parse(yield* readProjectFile('package.json'));
      const model = EffectOption.getOrUndefined(
        EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, candidate => candidate.id === CORE_EMBEDDING_MODEL_ID),
      )!;

      expect(asset).toContain(`${model.sha256}.gguf`);
      expect(asset).toContain("type: 'file'");
      expect(checker).toContain('BUNDLED_CORE_EMBEDDING_MANIFEST.sha256');
      expect(checker).toContain('BUNDLED_MODEL_LICENSE_SHA256');
      expect(modelLicense).toContain('Copyright (c) 2022 staoxiao');
      expect(modelLicense).toContain('The above copyright notice and this permission notice shall be included');
      expect(stringProperty(property(packageManifest, 'scripts'), 'build')).toMatch(
        /^bun scripts\/check-embedded-core-model\.ts && /,
      );
      expect(stringProperty(property(packageManifest, 'scripts'), 'compile:targets')).toMatch(
        /^bun scripts\/check-embedded-core-model\.ts && /,
      );
      for (const content of [ci, workflow]) {
        expect(content).not.toContain('THREADNOTE_E2E_MODEL_PATH');
        expect(content).not.toContain('E2E_EMBEDDING_MODEL_SHA256');
      }
      expect(ci).not.toContain('prepare-e2e-model:');
      expect(workflow).not.toContain('prepare-release-model:');
      expect(workflow).not.toContain('name: Download pinned release model');
      expect(
        Effect2.pipe(
          workflow,
          EffectString.match(/needs: verify/g),
          Effect2.Option.getOrElse(() => null),
        ),
      ).toHaveLength(3);
      expect(
        Effect2.pipe(
          workflow,
          EffectString.match(/install --no-start/g),
          Effect2.Option.getOrElse(() => null),
        ),
      ).toHaveLength(3);
      expect(
        Effect2.pipe(
          workflow,
          EffectString.match(/doctor --dry-run --strict/g),
          Effect2.Option.getOrElse(() => null),
        ),
      ).toHaveLength(3);
    }),
  );

  it.effect('bytecode-compiles every base target Bun supports in ordinary CI', () =>
    Effect.gen(function* () {
      const workflow = yield* readProjectFile('.github/workflows/ci.yml');
      for (const target of [
        'bun-darwin-arm64',
        'bun-darwin-x64',
        'bun-linux-arm64',
        'bun-linux-arm64-musl',
        'bun-linux-x64-baseline',
        'bun-linux-x64-baseline-musl',
        'bun-windows-arm64',
        'bun-windows-x64-baseline',
      ]) {
        expect(workflow).toContain(target);
      }
    }),
  );

  it.effect('validates exact hosted release runners without broad Actionlint exceptions', () =>
    Effect.gen(function* () {
      const ci = yield* readProjectFile('.github/workflows/ci.yml');
      const publish = yield* readProjectFile('.github/workflows/publish.yml');
      const hostedReleaseRunners = ['macos-15-intel', 'windows-11-arm'] as const;

      expect(ci).toContain(
        'docker://rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667',
      );
      expect(ci).toContain('args: -color');
      expect(ci).not.toMatch(/^\s*args:[^\n]*-ignore/gm);
      expect(yield* projectFileExists('.github/actionlint.yaml')).toBe(false);
      expect(yield* readProjectFile('.github/actionlint.yml')).toBe(
        EffectArray.join(
          [
            'self-hosted-runner:',
            '  labels:',
            '    - threadnote-large-graph',
            '',
            'paths:',
            '  .github/workflows/publish.yml:',
            '    # These jobs are intentionally and immutably disabled until Windows signing is approved.',
            '    ignore:',
            `      - '^constant expression "false" in condition\\. remove the if: section$'`,
            '  .github/workflows/telemetry-gateway.yml:',
            '    # GitHub supports queue:max; Actionlint 1.7.12 predates that workflow syntax.',
            '    ignore:',
            `      - '^unexpected key "queue" for "concurrency" section\\. expected one of "cancel-in-progress", "group"$'`,
            '  .github/workflows/telemetry-dashboard.yml:',
            '    # GitHub supports queue:max; Actionlint 1.7.12 predates that workflow syntax.',
            '    ignore:',
            `      - '^unexpected key "queue" for "concurrency" section\\. expected one of "cancel-in-progress", "group"$'`,
            '',
          ],
          '\n',
        ),
      );
      for (const runner of hostedReleaseRunners) {
        expect(
          Effect2.pipe(
            publish,
            EffectString.match(new RegExp(`runner: ${runner}$`, 'gm')),
            Effect2.Option.getOrElse(() => null),
          ),
        ).toHaveLength(1);
      }
    }),
  );
});
