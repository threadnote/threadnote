import {Predicate} from 'effect';
import {Array as EffectArray} from 'effect';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {createHash} from '@threadnote/testing/node-crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {Effect} from 'effect';
import {afterEach, describe, expect, vi} from 'vitest';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {HttpService, type HttpServiceShape} from '@threadnote/platform/http';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {stopVerifiedLegacyLocalAi} from '@threadnote/threadnote/migration/legacy-runtime';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const homes: string[] = [];
const launchId = '2025ed4f-fdfa-4467-949a-fecd0411fccb';
const model = 'legacy-model';
const pid = 30_356;
const port = 19_340;
const token = Effect2.pipe('a', EffectString.repeat(43));

afterEach(async () => {
  await Promise.all(EffectArray.map(homes.splice(0), home => rm(home, {force: true, recursive: true})));
});

describe('legacy local AI cleanup', () => {
  effectIt.effect('stops only a process with a matching receipt and token-derived loopback proof', () =>
    Effect.gen(function* () {
      const legacyHome = yield* Effect.promise(makeLegacyHome);
      let running = true;
      const signalProcess = vi.fn((_pid: number, _signal: NodeJS.Signals) => {
        running = false;
      });
      const services = yield* testServices(legacyHome, {
        isProcessRunning: () => running,
        signalProcess,
      });

      const result = yield* captureConsole(stopVerifiedLegacyLocalAi({dryRun: false, legacyHome})).pipe(
        Effect.provideService(HttpService, services.http),
        Effect.provideService(SystemInfo, services.system),
        provideTestLayer(ApplicationLayer),
      );

      expect(signalProcess).toHaveBeenCalledWith(pid, 'SIGTERM');
      expect(result.output).toContain(`Stopped verified legacy local AI process ${pid}.`);
      expect(
        yield* Effect.promise(() =>
          readFile(join(legacyHome, 'local-ai-server.json'), 'utf8').then(
            () => undefined,
            cause => (Predicate.hasProperty(cause, 'code') ? cause.code : undefined),
          ),
        ),
      ).toBe('ENOENT');
      expect(yield* Effect.promise(() => readFile(join(legacyHome, 'threadnote', 'local-ai-token'), 'utf8'))).toBe(
        token,
      );
    }),
  );

  effectIt.effect('leaves a live process untouched when its health proof does not match', () =>
    Effect.gen(function* () {
      const legacyHome = yield* Effect.promise(makeLegacyHome);
      const signalProcess = vi.fn();
      const services = yield* testServices(
        legacyHome,
        {isProcessRunning: () => true, signalProcess},
        {invalidProof: true},
      );

      const result = yield* captureConsole(stopVerifiedLegacyLocalAi({dryRun: false, legacyHome})).pipe(
        Effect.provideService(HttpService, services.http),
        Effect.provideService(SystemInfo, services.system),
        provideTestLayer(ApplicationLayer),
      );

      expect(signalProcess).not.toHaveBeenCalled();
      expect(result.output).toContain(`WARN legacy local AI process ${pid} could not be verified`);
      expect(yield* Effect.promise(() => readFile(join(legacyHome, 'local-ai-server.json'), 'utf8'))).toContain(
        launchId,
      );
    }),
  );

  effectIt.effect('reports a verified dry run without signaling the process', () =>
    Effect.gen(function* () {
      const legacyHome = yield* Effect.promise(makeLegacyHome);
      const signalProcess = vi.fn();
      const services = yield* testServices(legacyHome, {
        isProcessRunning: () => true,
        signalProcess,
      });

      const result = yield* captureConsole(stopVerifiedLegacyLocalAi({dryRun: true, legacyHome})).pipe(
        Effect.provideService(HttpService, services.http),
        Effect.provideService(SystemInfo, services.system),
        provideTestLayer(ApplicationLayer),
      );

      expect(signalProcess).not.toHaveBeenCalled();
      expect(result.output).toContain(`Would stop verified legacy local AI process ${pid}.`);
      expect(yield* Effect.promise(() => readFile(join(legacyHome, 'local-ai-server.json'), 'utf8'))).toContain(
        launchId,
      );
    }),
  );
});

async function makeLegacyHome(): Promise<string> {
  const legacyHome = await mkdtemp(join(tmpdir(), 'threadnote-legacy-runtime-'));
  homes.push(legacyHome);
  await mkdir(join(legacyHome, 'threadnote'), {recursive: true});
  await writeFile(
    join(legacyHome, 'local-ai-server.json'),
    `${JSON.stringify({launchId, pid, startedAt: '2026-07-27T00:00:00.000Z', version: 1})}\n`,
  );
  await writeFile(
    join(legacyHome, 'threadnote', 'local-ai.json'),
    `${JSON.stringify({enabled: true, host: '127.0.0.1', model, port, version: 1})}\n`,
  );
  await writeFile(join(legacyHome, 'threadnote', 'local-ai-token'), token);
  return legacyHome;
}

function testServices(
  legacyHome: string,
  processOverrides: {
    readonly isProcessRunning: (pid: number) => boolean;
    readonly signalProcess: (pid: number, signal: NodeJS.Signals) => void;
  },
  options: {readonly invalidProof?: boolean} = {},
) {
  return SystemInfo.pipe(
    provideTestLayer(ApplicationLayer),
    Effect.map(system => {
      const testSystem = SystemInfo.of({
        ...system,
        homeDirectory: join(legacyHome, '..'),
        isProcessRunning: processOverrides.isProcessRunning,
        signalProcess: processOverrides.signalProcess,
      });
      const http = HttpService.of({
        downloadToFile: () => Effect.die(TestError.make({message: 'Unexpected download'})),
        getJson: url =>
          Effect.sync(() => {
            const challenge = new URL(url).searchParams.get('challenge') ?? '';
            const proof = options.invalidProof
              ? Effect2.pipe('0', EffectString.repeat(64))
              : createHash('sha256')
                  .update(
                    EffectArray.join([challenge, 'threadnote-local-ai', model, String(pid), launchId, token], '\0'),
                  )
                  .digest('hex');
            return {
              body: {launchId, model, pid, proof, service: 'threadnote-local-ai', status: 'ok'},
              status: 200,
            };
          }),
        getStatus: () => Effect.die(TestError.make({message: 'Unexpected status request'})),
        getText: () => Effect.die(TestError.make({message: 'Unexpected text request'})),
      } satisfies HttpServiceShape);
      return {http, system: testSystem};
    }),
  );
}
