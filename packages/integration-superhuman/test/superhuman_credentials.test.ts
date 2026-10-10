import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Redacted, Result, Schema} from 'effect';
import {describe, expect} from 'vitest';
import {SystemInfo} from '@threadnote/platform/system';
import {reusableExternalCredential, storeExternalCredential} from '@threadnote/integration-core/external-credentials';
import type {SuperhumanSourceConfig} from '../src/config.js';
import {
  removeSuperhumanCredential,
  resolveSuperhumanCredential,
  storeSuperhumanCredential,
  superhumanCredentialConfigured,
} from '../src/credentials.js';
import {provideSuperhumanTestLayer} from './layer.js';

const source: SuperhumanSourceConfig = {
  type: 'superhuman',
  id: 'docs',
  enabled: true,
  credentialStorage: 'local',
  credentialEnv: 'SUPERHUMAN_DOCS_CREDENTIAL_TEST',
  project: null,
  documents: [{id: 'doc_one'}],
  includeHidden: false,
  refreshIntervalMinutes: 15,
  maxStaleHours: 24,
};

describe('protected Superhuman credentials', () => {
  effectIt.effect('skips unavailable credentials and never selects another provider', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const agentContextHome = yield* fs.makeTempDirectoryScoped({prefix: 'superhuman-reuse-fallback-'});
      const config = {agentContextHome};
      const candidates = [
        {type: 'superhuman', id: 'a', credentialEnv: 'UNUSED', credentialStorage: 'local' as const},
        {type: 'superhuman', id: 'b', credentialEnv: 'UNUSED', credentialStorage: 'local' as const},
        {type: 'github', id: 'c', credentialEnv: 'UNUSED', credentialStorage: 'local' as const},
      ];
      yield* storeExternalCredential(config, 'c', Redacted.make('synthetic-github'), 'github');
      expect(yield* reusableExternalCredential(config, candidates, 'superhuman', 'new')).toBeUndefined();
      yield* storeSuperhumanCredential(config, 'b', Redacted.make('synthetic-superhuman'));
      const selected = yield* reusableExternalCredential(config, candidates, 'superhuman', 'new');
      expect(selected?.source.id).toBe('b');
      expect(Redacted.value(selected!.token)).toBe('synthetic-superhuman');
    }).pipe(provideSuperhumanTestLayer),
  );
  effectIt.effect.prop(
    'selects the same available same-provider credential regardless of source order',
    {ids: Schema.Array(Schema.Literals(['a', 'b', 'c'])).check(Schema.isMinLength(1), Schema.isMaxLength(3))},
    ({ids}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const agentContextHome = yield* fs.makeTempDirectoryScoped({prefix: 'superhuman-reusable-credential-'});
        const config = {agentContextHome};
        const selected = [...new Set(ids)];
        for (const id of selected) yield* storeSuperhumanCredential(config, id, Redacted.make(`synthetic-${id}`));
        yield* storeExternalCredential(config, '0', Redacted.make('synthetic-github'), 'github');
        const candidates = [
          {type: 'github', id: '0', credentialEnv: 'UNUSED', credentialStorage: 'local' as const},
          ...selected.map(id => ({
            type: 'superhuman',
            id,
            credentialEnv: 'UNUSED',
            credentialStorage: 'local' as const,
          })),
        ];
        const first = yield* reusableExternalCredential(config, candidates, 'superhuman', 'new');
        const reversed = yield* reusableExternalCredential(config, [...candidates].reverse(), 'superhuman', 'new');
        const expected = [...selected].sort()[0];
        expect(first?.source.id).toBe(expected);
        expect(reversed?.source.id).toBe(expected);
        expect(Redacted.value(first!.token)).toBe(`synthetic-${expected}`);
      }).pipe(provideSuperhumanTestLayer),
    {arbitrary: {runs: 12}},
  );
  effectIt.effect.prop(
    'credential transitions match an isolated per-source model',
    {
      steps: Schema.Array(
        Schema.Struct({
          source: Schema.Literals([0, 1, 2]),
          operation: Schema.Literals(['put', 'remove']),
          seed: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 999})),
        }),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
    },
    ({steps}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const agentContextHome = yield* fs.makeTempDirectoryScoped({prefix: 'superhuman-credential-model-'});
        const config = {agentContextHome};
        const expected = new Map<string, string>();
        for (const step of steps) {
          const id = `docs-${step.source}`;
          if (step.operation === 'put') {
            const value = `synthetic-${step.seed}`;
            yield* storeSuperhumanCredential(config, id, Redacted.make(value));
            expected.set(id, value);
          } else {
            yield* removeSuperhumanCredential(config, id);
            expected.delete(id);
          }
          for (const index of [0, 1, 2]) {
            const selected = {...source, id: `docs-${index}`};
            expect(yield* superhumanCredentialConfigured(config, selected)).toBe(expected.has(selected.id));
            if (expected.has(selected.id))
              expect(Redacted.value(yield* resolveSuperhumanCredential(config, selected))).toBe(
                expected.get(selected.id),
              );
          }
        }
      }).pipe(provideSuperhumanTestLayer),
    {arbitrary: {runs: 12}},
  );

  effectIt.effect('keeps legacy environment resolution and reports unavailable owner protection explicitly', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const agentContextHome = yield* fs.makeTempDirectoryScoped({prefix: 'superhuman-credential-platform-'});
      const system = yield* SystemInfo;
      const unsupported = {
        ...system,
        platform: 'win32' as const,
        userId: undefined,
        environment: () => ({SUPERHUMAN_DOCS_CREDENTIAL_TEST: 'synthetic-env'}),
      };
      const config = {agentContextHome};
      expect(
        Redacted.value(
          yield* resolveSuperhumanCredential(config, {...source, credentialStorage: undefined}).pipe(
            Effect.provideService(SystemInfo, unsupported),
          ),
        ),
      ).toBe('synthetic-env');
      const result = yield* storeSuperhumanCredential(config, source.id, Redacted.make('synthetic-local')).pipe(
        Effect.provideService(SystemInfo, unsupported),
        Effect.result,
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.message).toContain('unsupported on this platform');
      expect(yield* fs.exists(`${agentContextHome}/threadnote/credentials`)).toBe(false);
      yield* removeSuperhumanCredential(config, source.id).pipe(Effect.provideService(SystemInfo, unsupported));
    }).pipe(provideSuperhumanTestLayer),
  );

  effectIt.effect('rejects linked credential ancestors without writing outside the protected root', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const agentContextHome = yield* fs.makeTempDirectoryScoped({prefix: 'superhuman-credential-linked-'});
      const outside = yield* fs.makeTempDirectoryScoped({prefix: 'superhuman-credential-outside-'});
      yield* fs.makeDirectory(`${agentContextHome}/threadnote`, {mode: 0o700});
      yield* fs.symlink(outside, `${agentContextHome}/threadnote/credentials`);
      const config = {agentContextHome};
      expect(
        Result.isFailure(
          yield* storeSuperhumanCredential(config, source.id, Redacted.make('synthetic-local')).pipe(Effect.result),
        ),
      ).toBe(true);
      expect(yield* superhumanCredentialConfigured(config, source)).toBe(false);
      expect(yield* fs.readDirectory(outside)).toEqual([]);
    }).pipe(provideSuperhumanTestLayer),
  );

  effectIt.effect('writes privately, resolves after restart, replaces atomically, and removes', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const agentContextHome = yield* fs.makeTempDirectoryScoped({prefix: 'superhuman-credential-'});
      const config = {agentContextHome};
      const filename = `${agentContextHome}/threadnote/credentials/superhuman/docs`;
      expect(yield* superhumanCredentialConfigured(config, source)).toBe(false);
      yield* storeSuperhumanCredential(config, source.id, Redacted.make('synthetic-original'));
      expect((yield* fs.stat(filename)).mode & 0o777).toBe(0o600);
      expect((yield* fs.stat(`${agentContextHome}/threadnote/credentials`)).mode & 0o777).toBe(0o700);
      expect(Redacted.value(yield* resolveSuperhumanCredential({...config}, {...source}))).toBe('synthetic-original');
      yield* storeSuperhumanCredential(config, source.id, Redacted.make('synthetic-rotated'));
      expect(Redacted.value(yield* resolveSuperhumanCredential(config, source))).toBe('synthetic-rotated');
      expect(yield* superhumanCredentialConfigured(config, source)).toBe(true);
      yield* removeSuperhumanCredential(config, source.id);
      expect(yield* superhumanCredentialConfigured(config, source)).toBe(false);
      yield* removeSuperhumanCredential(config, source.id);
    }).pipe(provideSuperhumanTestLayer),
  );

  effectIt.effect('rejects insecure files, symlinks and directories without disclosing values', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const agentContextHome = yield* fs.makeTempDirectoryScoped({prefix: 'superhuman-credential-invalid-'});
      const config = {agentContextHome};
      const filename = `${agentContextHome}/threadnote/credentials/superhuman/docs`;
      const sentinel = 'SYNTHETIC_PRIVATE_SENTINEL';
      yield* storeSuperhumanCredential(config, source.id, Redacted.make(sentinel));
      yield* fs.chmod(filename, 0o644);
      expect(yield* superhumanCredentialConfigured(config, source)).toBe(false);
      const failed = yield* resolveSuperhumanCredential(config, source).pipe(Effect.result);
      expect(Result.isFailure(failed)).toBe(true);
      expect(JSON.stringify(failed)).not.toContain(sentinel);
      expect(
        Result.isFailure(
          yield* storeSuperhumanCredential(config, source.id, Redacted.make('replacement')).pipe(Effect.result),
        ),
      ).toBe(true);
      yield* fs.chmod(filename, 0o600);
      yield* fs.rename(filename, `${agentContextHome}/outside`);
      yield* fs.symlink(`${agentContextHome}/outside`, filename);
      expect(yield* superhumanCredentialConfigured(config, source)).toBe(false);
      expect(Result.isFailure(yield* removeSuperhumanCredential(config, source.id).pipe(Effect.result))).toBe(true);
      expect(yield* fs.readFileString(`${agentContextHome}/outside`)).toBe(sentinel);
      yield* fs.remove(filename);
      yield* fs.makeDirectory(filename, {mode: 0o700});
      expect(yield* superhumanCredentialConfigured(config, source)).toBe(false);
      yield* fs.remove(filename, {recursive: true});
      yield* fs.chmod(`${agentContextHome}/threadnote/credentials`, 0o755);
      expect(
        Result.isFailure(
          yield* storeSuperhumanCredential(config, source.id, Redacted.make('replacement')).pipe(Effect.result),
        ),
      ).toBe(true);
    }).pipe(provideSuperhumanTestLayer),
  );

  effectIt.effect('rejects bounded token format failures before creating directories', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const agentContextHome = yield* fs.makeTempDirectoryScoped({prefix: 'superhuman-credential-bounds-'});
      for (const value of ['', 'token\n', ' token', 'x'.repeat(4097), '\uD800']) {
        const failed = yield* storeSuperhumanCredential({agentContextHome}, source.id, Redacted.make(value)).pipe(
          Effect.result,
        );
        expect(Result.isFailure(failed)).toBe(true);
      }
      expect(yield* fs.exists(`${agentContextHome}/threadnote/credentials`)).toBe(false);
    }).pipe(provideSuperhumanTestLayer),
  );

  effectIt.effect('rejects oversized and malformed persisted UTF-8 values', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const agentContextHome = yield* fs.makeTempDirectoryScoped({prefix: 'superhuman-credential-malformed-'});
      const config = {agentContextHome};
      yield* storeSuperhumanCredential(config, source.id, Redacted.make('synthetic-local'));
      const filename = `${agentContextHome}/threadnote/credentials/superhuman/docs`;
      for (const bytes of [new TextEncoder().encode('x'.repeat(4097)), new Uint8Array([0xff]), new Uint8Array()]) {
        yield* fs.writeFile(filename, bytes, {mode: 0o600});
        expect(yield* superhumanCredentialConfigured(config, source)).toBe(false);
        expect(Result.isFailure(yield* resolveSuperhumanCredential(config, source).pipe(Effect.result))).toBe(true);
      }
    }).pipe(provideSuperhumanTestLayer),
  );
});
