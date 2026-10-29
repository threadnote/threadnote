import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path, PlatformError} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  canonicalProcedureManifest,
  canonicalProcedureVerificationReceipt,
  createProcedureVerificationReceipt,
  parseProcedureManifest,
} from '@threadnote/context/procedure/contract';
import {loadPublishedProcedureCandidates} from '@threadnote/threadnote/procedure/repository';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('published procedure repository evidence', () => {
  effectIt.effect('distinguishes an unconfigured team registry from a corrupt one', () =>
    Effect.scoped(
      repositoryTest(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-procedure-repository-missing-'});
          const config = runtimeConfig(home, path.join(home, 'threadnote.json'));

          expect(yield* loadPublishedProcedureCandidates(config)).toEqual({
            candidates: [],
            gaps: [],
          });

          yield* fs.makeDirectory(path.join(home, 'share'), {recursive: true});
          yield* fs.writeFileString(path.join(home, 'share', 'teams.json'), '{not-json');
          expect(yield* loadPublishedProcedureCandidates(config)).toEqual({
            candidates: [],
            gaps: ['procedure-evidence-unavailable'],
          });
        }),
      ),
    ),
  );

  effectIt.effect('rejects a symbolic-link artifact root as unavailable evidence', () =>
    Effect.scoped(
      repositoryTest(
        Effect.gen(function* () {
          const fixture = yield* repositoryFixture('symlink');
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const outside = path.join(fixture.root, 'outside-artifacts');
          yield* fs.makeDirectory(outside, {recursive: true});
          yield* fs.symlink(outside, path.join(fixture.worktree, 'agent-artifacts'));

          expect(yield* loadPublishedProcedureCandidates(fixture.config)).toEqual({
            candidates: [],
            gaps: ['procedure-evidence-unavailable'],
          });
        }),
      ),
    ),
  );

  effectIt.effect('reports a configured procedure directory that cannot be inspected as unavailable', () =>
    Effect.scoped(
      repositoryTest(
        Effect.gen(function* () {
          const fixture = yield* repositoryFixture('unreadable');
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const artifacts = path.join(fixture.worktree, 'agent-artifacts');
          const procedures = path.join(artifacts, 'procedures');
          yield* fs.makeDirectory(procedures, {recursive: true});
          const unavailableFs = FileSystem.FileSystem.of({
            ...fs,
            stat: target =>
              String(target) === procedures
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: 'PermissionDenied',
                      method: 'stat',
                      module: 'FileSystem',
                      pathOrDescriptor: String(target),
                    }),
                  )
                : fs.stat(target),
          });

          expect(
            yield* loadPublishedProcedureCandidates(fixture.config).pipe(
              Effect.provideService(FileSystem.FileSystem, unavailableFs),
            ),
          ).toEqual({candidates: [], gaps: ['procedure-evidence-unavailable']});
        }),
      ),
    ),
  );

  effectIt.effect('reports truncation when a team exceeds the bounded artifact-source page', () =>
    Effect.scoped(
      repositoryTest(
        Effect.gen(function* () {
          const fixture = yield* repositoryFixture('truncated');
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const procedures = path.join(fixture.worktree, 'agent-artifacts', 'procedures');
          yield* fs.makeDirectory(procedures, {recursive: true});
          yield* Effect.forEach(
            Array.from({length: 257}, (_, index) => Effect2.pipe(index.toString(16), EffectString.padStart(64, '0'))),
            name => fs.makeDirectory(path.join(procedures, name)),
            {concurrency: 32, discard: true},
          );

          expect(yield* loadPublishedProcedureCandidates(fixture.config)).toEqual({
            candidates: [],
            gaps: ['procedure-evidence-truncated'],
          });
        }),
      ),
    ),
  );

  effectIt.effect('enforces exact BOM-free NUL-free UTF-8 while preserving valid multibyte artifacts', () =>
    Effect.scoped(
      repositoryTest(
        Effect.gen(function* () {
          const invalidCases = [
            {bytes: Uint8Array.from([0xff, 0xfe]), id: 'team/invalid-utf8', text: 'invalid'},
            {
              bytes: new TextEncoder().encode('\uFEFFreviewed workflow\n'),
              id: 'team/bom',
              text: '\uFEFFreviewed workflow\n',
            },
            {
              bytes: new TextEncoder().encode('reviewed\u0000workflow\n'),
              id: 'team/nul',
              text: 'reviewed\u0000workflow\n',
            },
          ];
          for (const invalid of invalidCases) {
            const fixture = yield* repositoryFixture(Effect2.pipe(invalid.id, EffectString.replace('/', '-')));
            yield* writePublishedCandidate(fixture, invalid.id, invalid.text, invalid.bytes);
            expect(yield* loadPublishedProcedureCandidates(fixture.config)).toEqual({
              candidates: [],
              gaps: ['procedure-evidence-unavailable'],
            });
          }

          const valid = yield* repositoryFixture('multibyte');
          const artifact = 'Déployer avec vérification ✅\n';
          yield* writePublishedCandidate(valid, 'team/multibyte', artifact, new TextEncoder().encode(artifact));
          expect(yield* loadPublishedProcedureCandidates(valid.config)).toEqual({
            candidates: [expect.objectContaining({artifactSha256: sha256HexSync(artifact), team: 'default'})],
            gaps: [],
          });
        }),
      ),
    ),
  );
});

function repositoryTest<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(provideTestLayer(ApplicationLayer));
}

function repositoryFixture(suffix: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({prefix: `threadnote-procedure-repository-${suffix}-`});
    const home = path.join(root, 'home');
    const worktree = path.join(root, 'shared');
    yield* fs.makeDirectory(path.join(home, 'share'), {recursive: true});
    yield* fs.makeDirectory(worktree, {recursive: true});
    yield* fs.writeFileString(
      path.join(home, 'share', 'teams.json'),
      JSON.stringify({
        defaultTeam: 'default',
        teams: {
          default: {
            access: 'read-write',
            addedAt: '2026-09-17T00:00:00.000Z',
            gitdir: path.join(root, 'unused.gitdir'),
            name: 'default',
            remote: 'https://example.invalid/shared.git',
            worktree,
          },
        },
        version: 1,
      }),
    );
    return {config: runtimeConfig(home, path.join(root, 'threadnote.json')), root, worktree};
  });
}

function writePublishedCandidate(
  fixture: {readonly worktree: string},
  artifactId: string,
  artifactText: string,
  artifactBytes: Uint8Array,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const manifest = parseProcedureManifest({
      artifact: {id: artifactId, semanticVersion: '1.0.0', sha256: sha256HexSync(artifactText)},
      compatible: {capabilities: ['mcp'], surfaceIds: ['codex']},
      dependencies: [],
      owner: 'platform-team',
      presentation: {summary: 'Reviewed workflow.', taskKeywords: ['deploy']},
      relatedDurableMemoryIds: [],
      reviewedOn: '2026-09-17',
      rollout: {channel: 'stable', percentage: 100},
      schemaVersion: 2,
      verification: {commands: [{argv: ['bun', 'test'], id: 'test'}], fixtures: []},
    });
    const receipt = createProcedureVerificationReceipt(manifest, {
      hostVersion: 'test-host',
      threadnoteVersion: '5.0.0',
      verifiedAt: '2026-09-17T12:00:00.000Z',
      verifier: 'test-verifier',
    });
    const root = path.join(fixture.worktree, 'agent-artifacts', 'procedures', sha256HexSync(artifactId), '1.0.0');
    yield* fs.makeDirectory(root, {recursive: true});
    yield* fs.writeFileString(path.join(root, 'manifest.json'), canonicalProcedureManifest(manifest));
    yield* fs.writeFileString(path.join(root, 'receipt.json'), canonicalProcedureVerificationReceipt(receipt));
    yield* fs.writeFile(path.join(root, 'artifact.txt'), artifactBytes);
  });
}

function runtimeConfig(agentContextHome: string, manifestPath: string): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome,
    agentId: 'codex',
    manifestPath,
    user: 'test-user',
  };
}
