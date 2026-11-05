import type {Page} from '@playwright/test';
import {expect} from '@playwright/test';
import {watch} from '@threadnote/testing/node-fs';
import {readFile} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';
import {isJsonObject} from '@threadnote/platform/json';
import {recallLexicalDemandKey} from '@threadnote/recall/background/lexical-demand';
import {String as EffectString} from 'effect';
import type {ManagerRuntime} from './runtime.js';

const readiness = {
  code: 'connections-unavailable',
  error: 'A ready recall snapshot is unavailable. Retry after background maintenance, or run threadnote repair.',
  retryAfterMilliseconds: 0,
};

export function expectPendingConnections(manager: ManagerRuntime): void {
  manager.expectedErrors.push({path: '/api/context/connections', status: 503, ...readiness});
}

/** Retry through the UI only after the exact background scope records durable completion. */
export async function withReadyConnections(
  page: Page,
  manager: ManagerRuntime,
  action: () => Promise<void>,
): Promise<void> {
  const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/context/connections');
  await action();
  const initial = await response;
  if (initial.status() === 200) return;
  expect(initial.status()).toBe(503);
  expect(await initial.json()).toEqual(readiness);
  const reader = page.getByRole('complementary', {name: 'Canonical context reader'});
  await expect(reader.getByRole('status')).toContainText('prepared in the background');
  const retry = reader.getByRole('button', {name: 'Retry connections', exact: true});
  await expect(retry).toBeVisible();
  await waitForHistoricalCompletion(manager);
  const retried = page.waitForResponse(value => new URL(value.url()).pathname === '/api/context/connections');
  await retry.click();
  expect((await retried).status()).toBe(200);
}

async function waitForHistoricalCompletion(manager: ManagerRuntime): Promise<void> {
  const account = 'manager-e2e';
  const user = 'playwright';
  const generation = EffectString.trim(
    await readFile(join(manager.home, 'locks', 'resources', account, 'canonical-generation-v1'), 'utf8'),
  );
  const directory = join(manager.home, 'recall', 'lexical-demand-v1');
  const key = recallLexicalDemandKey({account, user, includeInactive: true, manifestPath: manager.manifest});
  const filename = key + '.json';
  await new Promise<void>((resolve, reject) => {
    let closed = false;
    let inspecting = false;
    let dirty = false;
    const close = () => {
      closed = true;
      clearTimeout(timeout);
      observer.close();
    };
    const inspect = async () => {
      dirty = true;
      if (inspecting || closed) return;
      inspecting = true;
      try {
        while (dirty && !closed) {
          dirty = false;
          const state: unknown = JSON.parse(await readFile(join(directory, filename), 'utf8'));
          if (
            !isJsonObject(state) ||
            state.account !== account ||
            state.user !== user ||
            state.includeInactive !== true ||
            state.manifestPath !== manager.manifest ||
            state.work !== undefined
          )
            throw new Error('Connections demand does not match the exact historical scope.');
          if (state.failures === 8) throw new Error('Historical connections maintenance exhausted its failure budget.');
          if (
            state.revision === undefined &&
            typeof state.completedAt === 'number' &&
            state.failures === 0 &&
            state.sourceGeneration === generation
          ) {
            close();
            resolve();
          }
        }
      } catch (cause) {
        close();
        reject(cause);
      } finally {
        inspecting = false;
      }
    };
    const observer = watch(directory, (_event, changed) => {
      if (changed === null || changed === filename) void inspect();
    });
    observer.on('error', cause => {
      close();
      reject(cause);
    });
    const timeout = setTimeout(() => {
      close();
      reject(new Error('Historical connections background completion exceeded 15 seconds.'));
    }, 15_000);
    void inspect();
  });
}
