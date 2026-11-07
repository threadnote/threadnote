import type {Page, WebSocketRoute} from '@playwright/test';
import {Array as EffectArray} from 'effect';
import {isJsonObject} from '@threadnote/platform/json';
import {test, expect} from './fixtures/test.js';

/** Forward real frames unchanged; a cut gates transport without inventing protocol responses. */
async function liveTransport(page: Page) {
  let blocked = false;
  const peers: WebSocketRoute[] = [];
  const ready = new Set<WebSocketRoute>();
  await page.routeWebSocket(/\/api\/live\?/u, socket => {
    peers.push(socket);
    const server = socket.connectToServer();
    socket.onMessage(message => {
      if (!blocked) server.send(message);
    });
    server.onMessage(message => {
      if (blocked) return;
      const frame: unknown = JSON.parse(typeof message === 'string' ? message : message.toString());
      if (isJsonObject(frame) && frame.type === 'subscribed') ready.add(socket);
      socket.send(message);
    });
  });
  const close = async () => {
    const current = peers.splice(0);
    await Promise.all(EffectArray.map(current, peer => peer.close({code: 1012, reason: 'Owned E2E transport gate'})));
  };
  await page.reload();
  await expect.poll(() => ready.size).toBeGreaterThan(0);
  return {
    cut: async () => {
      blocked = true;
      await close();
    },
    recover: async () => {
      const previous = ready.size;
      blocked = false;
      await close();
      await expect.poll(() => ready.size).toBeGreaterThan(previous);
    },
  };
}

async function openMemory(page: Page, uri: string) {
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Library', exact: true})
    .click();
  const search = page.getByRole('searchbox', {name: 'Search Library'});
  await search.fill(uri);
  await search.press('Enter');
  await search.fill('');
  await expect(page.getByRole('button', {name: 'Edit', exact: true})).toBeEnabled();
}

test('S16 Home observes an external CLI mutation through the real live channel', async ({page, manager}) => {
  const sentinel = await manager.remember('Existing live sentinel.', 'live-sentinel');
  await liveTransport(page);
  const count = page.locator('.home-overview button').filter({hasText: 'Memories'}).locator('strong');
  await expect(count).toHaveText('1');
  let navigations = 0;
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) navigations++;
  });
  const uri = await manager.remember('External live mutation.', 'live-external');
  await expect(count).toHaveText('2');
  await expect(page.getByRole('button', {name: /live-external/u})).toBeVisible();
  expect(navigations).toBe(0);
  expect(await manager.cli(['read', uri])).toContain('External live mutation.');
  expect(await manager.cli(['read', sentinel])).toContain('Existing live sentinel.');
});

for (const changed of [false, true]) {
  test(`S16 transport recovery preserves an unsaved draft when canonical state ${changed ? 'changes' : 'stays unchanged'}`, async ({
    page,
    manager,
  }) => {
    test.setTimeout(60_000);
    const uri = await manager.remember('Original canonical text.', 'live-draft');
    const before = (await manager.api(`/api/memory?uri=${encodeURIComponent(uri)}`)).content;
    const transport = await liveTransport(page);
    await openMemory(page, uri);
    await page.getByRole('button', {name: 'Edit', exact: true}).click();
    const editor = page.getByRole('textbox', {name: 'editable markdown', exact: true});
    await editor.fill('An unsaved browser draft.');
    await transport.cut();
    await expect(page.getByRole('alert').filter({hasText: 'Manager disconnected'})).toBeVisible();
    await expect(page.getByRole('button', {name: 'Save', exact: true})).toHaveCount(0);
    await expect(page.getByRole('button', {name: 'New memory', exact: true})).toBeDisabled();
    if (changed)
      await manager.cli([
        'remember',
        '--kind',
        'handoff',
        '--project',
        'manager-e2e',
        '--topic',
        'live-draft',
        '--replace-uri',
        uri,
        '--text',
        'Newer canonical text.',
      ]);
    const current = (await manager.api(`/api/memory?uri=${encodeURIComponent(uri)}`)).content;
    if (!changed) expect(current).toBe(before);
    await transport.recover();
    if (changed) {
      const comparison = page
        .getByRole('alert')
        .filter({hasText: 'The saved record changed. Your unsaved draft is preserved.'});
      await expect(comparison).toBeVisible();
      await expect(page.getByRole('button', {name: 'Save', exact: true})).toHaveCount(0);
      await expect(page.getByText('An unsaved browser draft.', {exact: true})).toBeVisible();
      await comparison.getByText('Review the reloaded record', {exact: true}).click();
      await expect(comparison).toContainText('Newer canonical text.');
      expect((await manager.api(`/api/memory?uri=${encodeURIComponent(uri)}`)).content).toBe(current);
      await comparison.getByRole('button', {name: 'Keep my draft', exact: true}).click();
      await page.getByRole('button', {name: 'Edit', exact: true}).click();
    }
    await expect(editor).toHaveText('An unsaved browser draft.');
    await page.getByRole('button', {name: 'Save', exact: true}).click();
    await expect
      .poll(async () => (await manager.api(`/api/memory?uri=${encodeURIComponent(uri)}`)).content)
      .toContain('An unsaved browser draft.');
  });
}

test('S16 an old held read cannot overwrite fresh canonical content after live recovery', async ({page, manager}) => {
  test.setTimeout(60_000);
  const uri = await manager.remember('Old read payload.', 'held-live-read');
  const transport = await liveTransport(page);
  let release = () => {};
  let admitted = () => {};
  let completed = () => {};
  let hold = true;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const pending = new Promise<void>(resolve => {
    admitted = resolve;
  });
  const finished = new Promise<void>(resolve => {
    completed = resolve;
  });
  await page.route('**/api/memory?*', async route => {
    if (new URL(route.request().url()).searchParams.get('uri') !== uri || !hold) {
      await route.continue();
      return;
    }
    hold = false;
    const response = await route.fetch();
    admitted();
    await gate;
    try {
      await route.fulfill({response});
    } finally {
      completed();
    }
  });
  try {
    await page
      .getByRole('navigation', {name: 'Manager sections'})
      .getByRole('button', {name: 'Library', exact: true})
      .click();
    const search = page.getByRole('searchbox', {name: 'Search Library'});
    await search.fill(uri);
    await search.press('Enter');
    await pending;
    await transport.cut();
    await manager.cli([
      'remember',
      '--kind',
      'handoff',
      '--project',
      'manager-e2e',
      '--topic',
      'held-live-read',
      '--replace-uri',
      uri,
      '--text',
      'Fresh authoritative payload.',
    ]);
    await transport.recover();
    await expect(page.getByText('Fresh authoritative payload.', {exact: true})).toBeVisible();
    release();
    await finished;
    await page.evaluate(
      () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    await expect(page.getByText('Fresh authoritative payload.', {exact: true})).toBeVisible();
    await expect(page.getByText('Old read payload.', {exact: true})).toHaveCount(0);
  } finally {
    release();
  }
});

test('S16 capability fallback keeps canonical reads and writes real', async ({page, manager}) => {
  // A missing live capability is the only substituted response; business APIs still reach the compiled server.
  manager.expectedErrors.push({
    path: '/api/live-session',
    status: 501,
    error: 'Live capability unavailable in this transport fixture.',
  });
  await page.route('**/api/live-session', route =>
    route.fulfill({
      status: 501,
      contentType: 'application/json',
      body: JSON.stringify({error: 'Live capability unavailable in this transport fixture.'}),
    }),
  );
  const uri = await manager.remember('Fallback canonical body.', 'fallback-memory');
  await page.reload();
  await openMemory(page, uri);
  await page.getByRole('button', {name: 'Edit', exact: true}).click();
  await page
    .getByRole('textbox', {name: 'editable markdown', exact: true})
    .fill('Saved through the fallback transport.');
  await page.getByRole('button', {name: 'Save', exact: true}).click();
  await expect.poll(() => manager.cli(['read', uri])).toContain('Saved through the fallback transport.');
});

test('S16 a full Manager restart rotates authority and opens its newly issued URL', async ({
  browser,
  manager,
  request,
}) => {
  const oldToken = manager.token;
  await manager.stop();
  await manager.start();
  expect(manager.token).not.toBe(oldToken);
  expect(
    (await request.get(manager.origin + '/api/tree', {headers: {authorization: `Bearer ${oldToken}`}})).status(),
  ).toBe(401);
  const page = await browser.newPage();
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.route('**/*', async route => {
    const u = new URL(route.request().url());
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== manager.origin) {
      failures.push('Unowned browser origin');
      await route.abort();
    } else await route.continue();
  });
  try {
    await page.goto(manager.url);
    await expect(page.getByRole('heading', {name: 'Threadnote', exact: true})).toBeVisible();
    expect((await manager.api('/api/state')).config).toMatchObject({
      user: 'playwright',
      agentContextHome: manager.home,
    });
    expect(failures).toEqual([]);
  } finally {
    await page.close();
  }
});
