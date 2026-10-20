import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import fc from 'fast-check';
import {expect} from 'vitest';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {CommandExecutor, CommandSpawnFailed} from '@threadnote/platform/command';
import {HttpService} from '@threadnote/platform/http';
import {SystemInfo} from '@threadnote/platform/system';
import {
  GITHUB_RELEASES_URL,
  githubReleaseHeaders,
  LEGACY_GITHUB_RELEASES_URL,
} from '@threadnote/threadnote/release/github_auth';
import {fetchThreadnoteReleaseNotes} from '@threadnote/threadnote/release/notes';
import {fetchLatestVersion} from '@threadnote/threadnote/release/update';

for (const token of [undefined, 'existing-token']) {
  effectIt.effect(
    `observational release requests never invoke a credential command (token: ${token !== undefined})`,
    () =>
      Effect.gen(function* () {
        const baseSystem = yield* SystemInfo;
        const system = SystemInfo.of({...baseSystem, environment: () => (token ? {GH_TOKEN: token} : {})});
        const requests: Array<string | undefined> = [];
        const command = CommandExecutor.of({
          execute: () => Effect.die('observational requests must not run gh'),
          executeStreaming: () => Effect.die('observational requests must not run gh'),
        });
        const http = HttpService.of({
          downloadToFile: () => Effect.die('not used'),
          getJson: (_url, options) =>
            Effect.sync(() => {
              requests.push(options?.headers?.authorization);
              return {
                body: [{assets: [], draft: false, immutable: true, prerelease: false, tag_name: 'v5.4.0'}],
                status: 200,
              };
            }),
          getStatus: () => Effect.die('not used'),
          getText: () => Effect.die('not used'),
        });
        const [version, notes] = yield* Effect.all([
          fetchLatestVersion(GITHUB_RELEASES_URL, 'latest', {allowCredentialCommand: false}),
          fetchThreadnoteReleaseNotes({allowCredentialCommand: false}),
        ]).pipe(
          Effect.provideService(SystemInfo, system),
          Effect.provideService(CommandExecutor, command),
          Effect.provideService(HttpService, http),
        );
        expect(version).toBe('5.4.0');
        expect(notes.map(note => note.version)).toEqual(['5.4.0']);
        expect(requests).toEqual(Array(2).fill(token ? `Bearer ${token}` : undefined));
      }).pipe(provideTestLayer(TestSystemInfoLayer)),
  );
}

effectIt.effect('prefers GH_TOKEN over GITHUB_TOKEN without starting gh', () =>
  Effect.gen(function* () {
    const baseSystem = yield* SystemInfo;
    const system = SystemInfo.of({
      ...baseSystem,
      environment: () => ({GH_TOKEN: 'first-token', GITHUB_TOKEN: 'second-token'}),
    });
    const command = CommandExecutor.of({
      execute: () => Effect.die('gh should not run when an environment token is available'),
      executeStreaming: () => Effect.die('not used'),
    });
    const headers = yield* githubReleaseHeaders(GITHUB_RELEASES_URL).pipe(
      Effect.provideService(SystemInfo, system),
      Effect.provideService(CommandExecutor, command),
    );
    expect(headers).toHaveProperty('authorization', 'Bearer first-token');
  }).pipe(provideTestLayer(TestSystemInfoLayer)),
);

effectIt.effect('uses GITHUB_TOKEN when GH_TOKEN is absent without starting gh', () =>
  Effect.gen(function* () {
    const baseSystem = yield* SystemInfo;
    const system = SystemInfo.of({...baseSystem, environment: () => ({GITHUB_TOKEN: 'fallback-token'})});
    const command = CommandExecutor.of({
      execute: () => Effect.die('gh should not run when an environment token is available'),
      executeStreaming: () => Effect.die('not used'),
    });
    const headers = yield* githubReleaseHeaders(GITHUB_RELEASES_URL).pipe(
      Effect.provideService(SystemInfo, system),
      Effect.provideService(CommandExecutor, command),
    );
    expect(headers).toHaveProperty('authorization', 'Bearer fallback-token');
  }).pipe(provideTestLayer(TestSystemInfoLayer)),
);

effectIt.effect('uses a stored github.com gh identity when no environment token exists', () =>
  Effect.gen(function* () {
    const baseSystem = yield* SystemInfo;
    const system = SystemInfo.of({...baseSystem, environment: () => ({})});
    let calls = 0;
    const command = CommandExecutor.of({
      execute: (executable, args, options) =>
        Effect.sync(() => {
          calls += 1;
          expect(executable).toBe('gh');
          expect(args).toEqual(['auth', 'token', '--hostname', 'github.com']);
          expect(options?.env?.GH_PROMPT_DISABLED).toBe('1');
          return {exitCode: 0, stderr: '', stdout: 'stored-token\n'};
        }),
      executeStreaming: () => Effect.die('not used'),
    });
    const headers = yield* githubReleaseHeaders(GITHUB_RELEASES_URL).pipe(
      Effect.provideService(SystemInfo, system),
      Effect.provideService(CommandExecutor, command),
    );
    expect(headers).toHaveProperty('authorization', 'Bearer stored-token');
    expect(calls).toBe(1);
  }).pipe(provideTestLayer(TestSystemInfoLayer)),
);

effectIt.effect('keeps the public release request available when gh authentication is unavailable', () =>
  Effect.gen(function* () {
    const baseSystem = yield* SystemInfo;
    const system = SystemInfo.of({...baseSystem, environment: () => ({})});
    const command = CommandExecutor.of({
      execute: () =>
        Effect.fail(
          CommandSpawnFailed.make({
            args: ['auth', 'token', '--hostname', 'github.com'],
            cause: new Error('gh unavailable'),
            executable: 'gh',
            message: 'gh unavailable',
          }),
        ),
      executeStreaming: () => Effect.die('not used'),
    });
    const headers = yield* githubReleaseHeaders(GITHUB_RELEASES_URL).pipe(
      Effect.provideService(SystemInfo, system),
      Effect.provideService(CommandExecutor, command),
    );
    expect(headers).not.toHaveProperty('authorization');
    expect(headers.accept).toBe('application/vnd.github+json');
  }).pipe(provideTestLayer(TestSystemInfoLayer)),
);

effectIt.effect('authenticates updater and release notes requests but never a custom source', () =>
  Effect.gen(function* () {
    const baseSystem = yield* SystemInfo;
    const system = SystemInfo.of({...baseSystem, environment: () => ({GH_TOKEN: 'fixture-token'})});
    const requests: Array<{readonly authorization?: string; readonly url: string}> = [];
    const release = {
      assets: [],
      draft: false,
      immutable: true,
      name: '4.7.3',
      prerelease: false,
      tag_name: 'v4.7.3',
    };
    const http = HttpService.of({
      downloadToFile: () => Effect.die('not used'),
      getJson: (url, options) =>
        Effect.sync(() => {
          requests.push({authorization: options?.headers?.authorization, url: String(url)});
          return {body: [release], status: 200};
        }),
      getStatus: () => Effect.die('not used'),
      getText: () => Effect.die('not used'),
    });
    const command = CommandExecutor.of({
      execute: () => Effect.die('gh should not run when an environment token is available'),
      executeStreaming: () => Effect.die('not used'),
    });
    const [version, notes, legacyVersion, customVersion] = yield* Effect.all([
      fetchLatestVersion(),
      fetchThreadnoteReleaseNotes(),
      fetchLatestVersion(LEGACY_GITHUB_RELEASES_URL),
      fetchLatestVersion('https://mirror.example/releases'),
    ]).pipe(
      Effect.provideService(SystemInfo, system),
      Effect.provideService(CommandExecutor, command),
      Effect.provideService(HttpService, http),
    );
    expect(version).toBe('4.7.3');
    expect(notes.map(note => note.version)).toEqual(['4.7.3']);
    expect(legacyVersion).toBe('4.7.3');
    expect(customVersion).toBe('4.7.3');
    expect(requests).toEqual([
      {authorization: 'Bearer fixture-token', url: GITHUB_RELEASES_URL},
      {authorization: 'Bearer fixture-token', url: GITHUB_RELEASES_URL},
      {authorization: 'Bearer fixture-token', url: LEGACY_GITHUB_RELEASES_URL},
      {authorization: undefined, url: 'https://mirror.example/releases'},
    ]);
  }).pipe(provideTestLayer(TestSystemInfoLayer)),
);

fcEffectProp(
  effectIt,
  'never forwards a GitHub credential to generated custom release sources',
  {
    source: fc.oneof(
      fc.domain().map(host => `https://${host}/releases`),
      fc.constant('https://api.github.com/repos/Kashkovsky/threadnote/releases?per_page=50'),
      fc.constant('https://api.github.com/repos/threadnote/threadnote/releases?per_page=50'),
      fc.constant('https://api.github.com/repos/Elsewhere/threadnote/releases?per_page=100'),
    ),
  },
  ({source}) =>
    Effect.gen(function* () {
      const baseSystem = yield* SystemInfo;
      const system = SystemInfo.of({...baseSystem, environment: () => ({GH_TOKEN: 'fixture-token'})});
      const headers = yield* githubReleaseHeaders(source).pipe(Effect.provideService(SystemInfo, system));
      expect(headers).not.toHaveProperty('authorization');
      expect(headers['user-agent']).toBe('threadnote-cli');
    }).pipe(provideTestLayer(TestSystemInfoLayer)),
  {fastCheck: {numRuns: 100}},
);
