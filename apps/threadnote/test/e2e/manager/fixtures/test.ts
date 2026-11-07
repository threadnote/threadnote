import {expect, test as base} from '@playwright/test';
import {ManagerRuntime} from './runtime.js';
import {configureModel} from './model.js';
import {configureProviders} from './providers.js';
import {createRepository, indexRepository} from './repositories.js';
import {Array as EffectArray, pipe} from 'effect';
import * as EffectString from 'effect/String';
import {mkdtemp, rm} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {spawnSync} from '@threadnote/testing/node-child-process';

interface ManagerFixtures {
  readonly manager: ManagerRuntime;
  readonly managerMode: 'compiled' | 'source';
  readonly managerScenario: 'empty' | 'populated' | 'providers' | 'remote-model' | 'model-setup' | 'graph-pair';
}

export const test = base.extend<ManagerFixtures>({
  browser: [
    async ({playwright, browserName, launchOptions, headless, channel}, use) => {
      const home = await mkdtemp(join(tmpdir(), 'threadnote-manager-browser-'));
      try {
        const browser = await playwright[browserName].launch({
          ...launchOptions,
          headless,
          ...(channel ? {channel} : {}),
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            HOME: home,
            USERPROFILE: home,
            TMPDIR: home,
            TMP: home,
            TEMP: home,
            ...(process.env.SystemRoot ? {SystemRoot: process.env.SystemRoot} : {}),
            ...(process.env.DISPLAY ? {DISPLAY: process.env.DISPLAY} : {}),
            LIBGL_ALWAYS_SOFTWARE: '1',
          },
        });
        try {
          await use(browser);
        } finally {
          await browser.close();
        }
      } finally {
        // Cocoa may put deny-delete ACLs on the synthetic home folders it creates.
        if (process.platform === 'darwin') spawnSync('/bin/chmod', ['-RN', home]);
        await rm(home, {recursive: true, force: true});
      }
    },
    {scope: 'worker'},
  ],
  managerMode: ['compiled', {option: true}],
  managerScenario: ['empty', {option: true}],
  manager: async ({managerMode, managerScenario}, use, testInfo) => {
    if (managerScenario === 'graph-pair') testInfo.setTimeout(60_000);
    const manager = await ManagerRuntime.create();
    try {
      if (managerScenario === 'graph-pair') {
        // Finish manifest mutations before live authority starts issuing tickets.
        for (const name of ['alpha', 'beta']) await indexRepository(manager, await createRepository(manager, name));
      }
      if (managerScenario === 'remote-model') await configureModel(manager);
      if (managerScenario === 'model-setup') {
        const {configureSetup} = await import('./setup.js');
        await configureSetup(manager);
      }
      if (
        testInfo.title ===
          'S07 S09 workset preparation publishes real repositories and converges after source changes' &&
        testInfo.retry === 0 &&
        manager.environment.THREADNOTE_E2E_ROOT === manager.root &&
        manager.environment.THREADNOTE_HOME === manager.home &&
        manager.environment.HOME === manager.home
      ) {
        manager.environment.THREADNOTE_MANAGER_WORKSET_FAILURE_DIAGNOSTICS = '1';
      }
      await manager.start(managerMode);
      if (managerScenario === 'populated')
        await manager.remember(
          '# Browser fixture\n\nA synthetic memory for Manager browser coverage.\n\n```mermaid\ngraph LR\n  A[Fixture] --> B[Ready]\n```',
          'browser-fixture',
        );
      if (managerScenario === 'providers') await configureProviders(manager);
      await use(manager);
      const unexpected = EffectArray.filter(await manager.networkJournal(), request => request.matched !== true);
      expect(unexpected.length, JSON.stringify(EffectArray.take(unexpected, 5))).toBe(0);
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('manager.log', {body: manager.output, contentType: 'text/plain'});
        await testInfo.attach('outbound-requests.log', {
          body: JSON.stringify(await manager.networkJournal()),
          contentType: 'text/plain',
        });
        await testInfo.attach('spawn-attempts.log', {
          body: JSON.stringify(await manager.journal('spawn-attempts')),
          contentType: 'text/plain',
        });
      }
      await manager.dispose();
    }
  },
  page: async ({page, manager}, use) => {
    const failures: string[] = [];
    const consoleErrors: {text: string; url: string}[] = [];
    const expectedResponses = new Set<string>();
    const responseChecks: Promise<void>[] = [];
    page.on('pageerror', error => failures.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push({text: message.text(), url: message.location().url});
    });
    page.on('response', response => {
      if (response.status() < 400) return;
      responseChecks.push(
        (async () => {
          const url = new URL(response.url());
          const expected = EffectArray.filter(
            [
              {
                path: '/api/shares/conflicts',
                status: 409,
                error: 'No shared teams configured. Run: threadnote share init <remote-url>',
              },
              ...manager.expectedErrors,
            ],
            item => item.path === url.pathname && item.status === response.status(),
          );
          if (expected.length) {
            let body = await response.text().catch(() => {
              if (response.request().method() !== 'GET')
                throw new Error('Could not verify intentional mutation error response.');
              return '';
            });
            if (!body && response.request().method() === 'GET') {
              // Navigation can cancel a read after headers; verify its exact body through the same authenticated route.
              const current = await fetch(response.url(), {
                headers: {authorization: `Bearer ${manager.token}`},
                signal: AbortSignal.timeout(5_000),
              });
              expect(current.status).toBe(response.status());
              body = await current.text();
            }
            if (
              EffectArray.some(
                expected,
                item =>
                  body ===
                  JSON.stringify({
                    ...('code' in item && item.code !== undefined ? {code: item.code} : {}),
                    error: item.error,
                    ...('retryAfterMilliseconds' in item && item.retryAfterMilliseconds !== undefined
                      ? {retryAfterMilliseconds: item.retryAfterMilliseconds}
                      : {}),
                  }),
              )
            ) {
              expectedResponses.add(response.url());
              return;
            }
          }
          failures.push(`Unexpected HTTP ${response.status()}: ${url.pathname}`);
        })().catch(error => {
          failures.push(String(error));
        }),
      );
    });
    page.on('requestfailed', request => {
      const error = request.failure()?.errorText ?? 'unknown';
      const url = new URL(request.url());
      if (
        url.origin === manager.origin &&
        EffectArray.some(manager.expectedRequestErrors, item => item.path === url.pathname && item.error === error)
      ) {
        expectedResponses.add(request.url());
        return;
      }
      if (pipe(request.url(), EffectString.startsWith(manager.origin)) && !/^net::ERR_ABORTED$/u.test(error))
        failures.push(`First-party request failed: ${new URL(request.url()).pathname}: ${error}`);
    });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== manager.origin) {
        failures.push(`Unexpected browser egress: ${url.origin}${url.pathname}`);
        await route.abort();
      } else await route.continue();
    });
    await page.goto(manager.url);
    await expect(page.getByRole('navigation', {name: 'Manager sections'})).toBeVisible();
    await expect(page.getByText('Connecting…', {exact: true})).toHaveCount(0);
    await use(page);
    await Promise.all(responseChecks);
    for (const error of consoleErrors) if (!expectedResponses.has(error.url)) failures.push(error.text);
    expect(failures).toEqual([]);
  },
});

export {expect};
