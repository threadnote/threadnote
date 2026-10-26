// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {ManagerDialogProvider} from '../../src/dialog.js';
import {DevSkillsPanel} from '../../src/dev_skills/view.js';
import type {
  ManagerDevSkillsCatalog,
  ManagerDevSkillsPlan,
  ManagerDevSkillsTargetStatus,
} from '../../src/dev_skills/contracts.js';

let root: Root | undefined;
let catalog: ManagerDevSkillsCatalog;
let target: ManagerDevSkillsTargetStatus;
let calls: {url: string; body?: Record<string, unknown>}[];
let stale: boolean;
let pending: {url: string; resolve: (response: Response) => void}[];
let deferStatus: boolean;
let deferPreview: boolean;
let recorded: ManagerDevSkillsTargetStatus[] | undefined;
let projectsFail: boolean;
let inventoryFail: boolean;
let registeredProjects: {name: string; path: string}[];
const digest = 'a'.repeat(64);
const previewDigest = 'b'.repeat(64);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status});
function plan(action = 'install'): ManagerDevSkillsPlan {
  return {
    schemaVersion: 1,
    action: action as ManagerDevSkillsPlan['action'],
    target: target.target,
    consumerId: 'one',
    installationState: target.installationState,
    bundleDigest: digest,
    previewDigest,
    changes: [{path: '/skills/dev-spec/SKILL.md', beforeHash: null, afterHash: digest}],
    consumers: target.consumers,
    issues: [],
    canApply: true,
  };
}
function status() {
  return {schemaVersion: 1, bundle: catalog.bundle, targets: [target]};
}
beforeEach(() => {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  calls = [];
  recorded = undefined;
  projectsFail = false;
  inventoryFail = false;
  registeredProjects = [{name: 'registered', path: '/registered/repo'}];
  pending = [];
  stale = false;
  deferStatus = false;
  deferPreview = false;
  catalog = {
    schemaVersion: 1,
    platform: 'darwin',
    bundle: {
      schemaVersion: 1,
      workflowProtocol: 1,
      stateSchema: 1,
      minimumRuntime: '5.3.0',
      releaseVersion: '5.3.1',
      prerequisites: {commands: ['git'], prCommands: ['gh']},
      skills: [],
      hashes: {},
      digest,
    },
    surfaces: [
      {
        surfaceId: 'codex',
        agentId: 'codex',
        displayName: 'Codex',
        aliases: [],
        status: 'managed',
        profile: 'desktop',
        scopes: ['user', 'project'],
        defaultScope: 'user',
        platforms: ['darwin', 'win32', 'linux'],
        layout: 'directory',
      },
      {
        surfaceId: 'cursor',
        agentId: 'cursor',
        displayName: 'Cursor',
        aliases: [],
        status: 'managed',
        profile: 'desktop',
        scopes: ['user', 'project'],
        defaultScope: 'user',
        platforms: ['darwin', 'win32', 'linux'],
        layout: 'flat',
      },
      {
        surfaceId: 'codex-cloud',
        agentId: 'codex',
        displayName: 'Personal Codex cloud',
        aliases: [],
        status: 'managed',
        profile: 'codex-cloud-personal',
        scopes: ['user'],
        defaultScope: 'user',
        platforms: ['linux'],
        layout: 'directory',
      },
      {
        surfaceId: 'unsupported',
        agentId: 'unsupported',
        displayName: 'Unsupported host',
        aliases: [],
        status: 'unsupported',
        reason: 'No managed skill destination',
      },
    ],
  };
  target = {
    target: {
      surfaceId: 'codex',
      agentId: 'codex',
      profile: 'desktop',
      scope: 'user',
      skillRoot: '/skills',
      layout: 'directory',
      discoveryRoots: ['/skills'],
    },
    consumerId: 'one',
    installationState: 'absent',
    enrolled: false,
    enrollmentState: 'unregistered',
    enabled: false,
    issues: [],
    consumers: [],
    readiness: {
      planning: {state: 'ready', reasons: []},
      publication: {state: 'blocked', reasons: [{code: 'missing-gh', message: 'GitHub CLI missing'}]},
      watch: {state: 'unchecked', reasons: []},
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({url, body});
      if (url === '/api/dev-skills/catalog') return json(catalog);
      if ((url === '/api/worksets' || url === '/api/dev-skills/projects') && projectsFail)
        return json({error: 'Project catalog unavailable'}, 503);
      if (url === '/api/dev-skills/status')
        return inventoryFail
          ? json({error: 'Inventory unavailable'}, 503)
          : json({...status(), targets: recorded ?? [target]});
      if (url === '/api/worksets')
        return json({projects: registeredProjects.map(project => ({...project, path: project.path.trim()}))});
      if (url === '/api/dev-skills/projects') return json({schemaVersion: 1, projects: registeredProjects});
      if (url.startsWith('/api/runtime/updates')) return json({policy: 'automatic', automaticRunning: false});
      if ((deferStatus && url.startsWith('/api/dev-skills/status')) || (deferPreview && url.endsWith('/preview'))) {
        const deferred = Promise.withResolvers<Response>();
        pending.push({url, resolve: deferred.resolve});
        return deferred.promise;
      }
      if (url.startsWith('/api/dev-skills/status')) return json(status());
      if (url.endsWith('/preview')) return json(plan(String(body?.action)));
      if (url.endsWith('/apply')) {
        if (stale) return json({code: 'stale-preview', error: 'Files changed after preview', recovery: 'preview'}, 409);
        const action = String(body?.action);
        target = {
          ...target,
          installationState: action === 'remove' ? 'absent' : 'current',
          enrolled: action !== 'remove',
          enrollmentState: action === 'remove' ? 'removed' : 'enrolled',
          enabled: action !== 'remove',
          installed:
            action === 'remove'
              ? undefined
              : {releaseVersion: '5.3.1', digest, workflowProtocol: 1, stateSchema: 1, minimumRuntime: '5.3.0'},
        };
        return json({
          result: {
            ...plan(action),
            applied: true,
            recovered: false,
            retainedPaths: action === 'remove' ? ['/skills/edited.md'] : [],
          },
          status: status(),
        });
      }
      throw new Error('Unexpected route ' + url);
    }),
  );
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
async function render() {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <ManagerDialogProvider>
        <DevSkillsPanel />
      </ManagerDialogProvider>,
    ),
  );
}
function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === label);
  if (!found) throw new Error('Missing button ' + label);
  return found;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function select(label: string, value: string) {
  await act(async () => {
    const element = document.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
    element.value = value;
    element.dispatchEvent(new Event('change', {bubbles: true}));
  });
}
async function apply(action: string) {
  await click('Preview ' + action);
  await click('Review and confirm ' + action);
  await click('Confirm ' + action);
}

it('explains the linked workflow and completes preview-confirm-install-update-remove using the authenticated helper', async () => {
  await render();
  for (const text of [
    'Specify → Plan → Implement',
    'dev-spec',
    'dev-plan',
    'dev-cycle',
    'Support dependency: watch-pr',
    'approved knowledge',
    'Installing files does not execute development',
    '$dev-spec',
    'GitHub CLI missing',
    'Runtime automatic update policy: automatic',
  ])
    expect(document.body.textContent).toContain(text);
  expect(button('Preview install').disabled).toBe(false);
  expect(button('Preview update').disabled).toBe(true);
  await click('Preview install');
  expect(calls.some(call => call.url.endsWith('/apply'))).toBe(false);
  expect(document.body.textContent).toContain(previewDigest);
  await click('Review and confirm install');
  expect(document.querySelector('dialog')).not.toBeNull();
  await click('Confirm install');
  expect(calls.find(call => call.url.endsWith('/apply'))?.body).toEqual({
    action: 'install',
    selector: {agent: 'codex', profile: 'desktop', scope: 'user'},
    previewDigest,
    confirm: true,
  });
  expect(document.body.textContent).toContain('5.3.1');
  await apply('update');
  await apply('remove');
  expect(document.body.textContent).toContain('Retained files: /skills/edited.md');
  expect(document.body.textContent).toContain('removed · disabled');
  expect(button('Preview remove').disabled).toBe(true);
  expect((vi.mocked(fetch).mock.calls[0]?.[1]?.headers as Record<string, string> | undefined)?.authorization).toBe(
    'Bearer ',
  );
});

it('requires a fresh preview after a stale 409 and permits keyboard cancellation without applying', async () => {
  await render();
  stale = true;
  await apply('install');
  expect(document.querySelector('[role=alert]')?.textContent).toContain('Review a fresh preview');
  expect(document.body.textContent).not.toContain('Review and confirm install');
  expect(calls.filter(call => call.url.endsWith('/apply'))).toHaveLength(1);
  await click('Preview install');
  await click('Review and confirm install');
  await act(async () =>
    document.querySelector('dialog')!.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})),
  );
  expect(document.querySelector('dialog')).toBeNull();
  expect(calls.filter(call => call.url.endsWith('/apply'))).toHaveLength(1);
});

it('uses an explicit registered project path and rejects late status/preview responses from an older selection', async () => {
  await render();
  deferPreview = true;
  await click('Preview install');
  expect(pending).toHaveLength(1);
  deferStatus = true;
  await select('Host / profile', 'cursor');
  await select('Scope', 'project');
  expect(button('Preview install').disabled).toBe(true);
  await select('Registered project path', '/registered/repo');
  expect(pending.at(-1)?.url).toContain('cwd=%2Fregistered%2Frepo');
  const newest = pending.pop()!;
  await act(async () =>
    newest.resolve(
      json({
        ...status(),
        targets: [
          {...target, target: {...target.target, skillRoot: '/registered/repo/.cursor/skills', layout: 'flat'}},
        ],
      }),
    ),
  );
  expect(document.body.textContent).toContain('/registered/repo/.cursor/skills');
  await act(async () => {
    for (const item of pending) item.resolve(json(item.url.endsWith('/preview') ? plan() : status()));
  });
  expect(document.body.textContent).toContain('/registered/repo/.cursor/skills');
  expect(document.body.textContent).not.toContain('Review and confirm install');
});

it('separates disabled enrollment, pending refresh, physical state and readiness without blocking file operations', async () => {
  target = {
    ...target,
    installationState: 'update-available',
    enrolled: true,
    enrollmentState: 'enrolled',
    enabled: false,
    installedDigest: 'old',
    lastRefresh: {
      intentId: 'one',
      requestedReleaseVersion: '5.3.1',
      requestedBundleDigest: digest,
      state: 'pending',
      attemptedAt: '2026-10-20',
      issues: [{code: 'inaccessible', message: 'Target refresh pending'}],
    },
    consumers: [{home: '/other-home', installationRoot: '/runtime', target: target.target}],
  };
  await render();
  for (const text of [
    'update-available',
    'enrolled · disabled',
    'Last refresh: pending',
    'Target refresh pending',
    'Planning: ready',
    'Publication: blocked',
    'Watch: unchecked',
    'Shared consumers (1)',
    '/other-home',
  ])
    expect(document.body.textContent).toContain(text);
  expect(button('Preview install').disabled).toBe(false);
  expect(button('Preview update').disabled).toBe(false);
  expect(button('Preview remove').disabled).toBe(false);
  await select('Host / profile', 'codex-cloud');
  expect(document.body.textContent).toContain('unavailable on darwin');
  expect(button('Preview install').disabled).toBe(true);
  await select('Host / profile', 'unsupported');
  expect(document.body.textContent).toContain('No managed skill destination');
});

it('invalidates old approval across bounded generated selector/action changes, including changes during a dialog', async () => {
  target = {...target, installationState: 'current', enrolled: true, enrollmentState: 'enrolled', enabled: false};
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom('host', 'scope', 'action'), {minLength: 1, maxLength: 5}),
      async changes => {
        await render();
        await click('Preview install');
        await click('Review and confirm install');
        for (const change of changes) {
          if (change === 'host') {
            const element = document.querySelector('select[aria-label="Host / profile"]') as HTMLSelectElement;
            await select('Host / profile', element.value === 'codex' ? 'cursor' : 'codex');
          } else if (change === 'scope') {
            await select('Scope', 'project');
            await select('Scope', 'user');
          } else {
            await click('Preview remove');
          }
        }
        await click('Confirm install');
        expect(calls.filter(call => call.url.endsWith('/apply'))).toHaveLength(0);
        await act(async () => root!.unmount());
        root = undefined;
        document.body.replaceChildren();
        calls = [];
      },
    ),
    {numRuns: 12},
  );
});

it('offers explicit install to reenable a physically current disabled enrollment', async () => {
  target = {...target, installationState: 'current', enrolled: true, enrollmentState: 'enrolled', enabled: false};
  await render();
  expect(button('Preview install').disabled).toBe(false);
  await apply('install');
  expect(document.body.textContent).toContain('enrolled · enabled');
});

it('reports a blocked preview and keeps file installation available when Python readiness is blocked', async () => {
  target = {
    ...target,
    readiness: {
      planning: {state: 'blocked', reasons: [{code: 'missing-python', message: 'Python unavailable'}]},
      publication: {state: 'blocked', reasons: []},
      watch: {state: 'blocked', reasons: []},
    },
  };
  await render();
  expect(button('Preview install').disabled).toBe(false);
  expect(document.body.textContent).toContain('Python unavailable');
  deferPreview = true;
  await click('Preview install');
  await act(async () =>
    pending[0].resolve(
      json({
        ...plan(),
        canApply: false,
        issues: [{code: 'file-conflict', message: 'Unowned file conflicts', path: '/skills/dev-spec/SKILL.md'}],
      }),
    ),
  );
  expect(button('Review and confirm install').disabled).toBe(true);
  expect(document.body.textContent).toContain('Unowned file conflicts');
  expect(document.body.textContent).toContain('This preview cannot be applied');
});

it('keeps an enrolled project installation addressable after registration is removed, even when project catalog fails', async () => {
  target = {
    ...target,
    installationState: 'current',
    enrolled: true,
    enrollmentState: 'enrolled',
    enabled: true,
    target: {...target.target, scope: 'project', cwd: '/previous/repo', skillRoot: '/previous/repo/.agents/skills'},
  };
  recorded = [
    target,
    {
      ...target,
      consumerId: 'removed',
      enrollmentState: 'removed',
      enrolled: false,
      target: {...target.target, cwd: '/removed/repo'},
    },
    {...target, consumerId: 'foreign', target: {...target.target, surfaceId: 'cursor', cwd: '/cursor/repo'}},
  ];
  projectsFail = true;
  await render();
  await select('Scope', 'project');
  const picker = document.querySelector('select[aria-label="Registered project path"]') as HTMLSelectElement;
  expect(picker.textContent).toContain('Existing installation · /previous/repo');
  expect(picker.textContent).not.toContain('/removed/repo');
  expect(picker.textContent).not.toContain('/cursor/repo');
  expect(document.body.textContent).toContain('Registered projects unavailable');
  await select('Registered project path', '/previous/repo');
  await apply('update');
  inventoryFail = true;
  await apply('remove');
  expect(calls.filter(call => call.url.endsWith('/apply')).map(call => call.body)).toEqual(
    ['update', 'remove'].map(action => ({
      action,
      selector: {agent: 'codex', profile: 'desktop', scope: 'project', cwd: '/previous/repo'},
      previewDigest,
      confirm: true,
    })),
  );
  expect(picker.textContent).not.toContain('/previous/repo');
  expect(button('Preview install').disabled).toBe(true);
  expect(document.body.textContent).toContain('Retained files: /skills/edited.md');
});

it('shows inventory failure without disabling registered project selection', async () => {
  inventoryFail = true;
  await render();
  await select('Scope', 'project');
  await select('Registered project path', '/registered/repo');
  expect(document.body.textContent).toContain('Existing installation inventory unavailable: Inventory unavailable');
  expect(button('Preview install').disabled).toBe(false);
});

it('preserves the authoritative whitespace-suffixed project identity through preview and apply', async () => {
  const exactPath = '/registered/repo ';
  registeredProjects = [{name: 'Whitespace-suffixed repository', path: exactPath}];
  await render();
  await select('Scope', 'project');
  const picker = document.querySelector('select[aria-label="Registered project path"]') as HTMLSelectElement;
  expect([...picker.options].map(option => option.value)).toContain(exactPath);
  expect([...picker.options].map(option => option.value)).not.toContain(exactPath.trim());
  await select('Registered project path', exactPath);
  await apply('install');
  const mutationCalls = calls.filter(call => call.url.endsWith('/preview') || call.url.endsWith('/apply'));
  expect(mutationCalls).toHaveLength(2);
  for (const call of mutationCalls)
    expect(call.body?.selector).toEqual({agent: 'codex', profile: 'desktop', scope: 'project', cwd: exactPath});
  expect(calls.some(call => call.url === '/api/worksets')).toBe(false);
});

it.each(['update', 'remove'] as const)(
  'allows an ownership-fenced legacy %s preview while execution stays blocked',
  async action => {
    target = {
      ...target,
      installationState: 'incompatible',
      enrolled: true,
      enrollmentState: 'enrolled',
      enabled: true,
      installed: {
        releaseVersion: '5.2.0',
        digest,
        workflowProtocol: 1,
        stateSchema: 1,
        minimumRuntime: '5.2.0',
      },
      installedDigest: digest,
      issues: [
        {code: 'legacy-workflow-update-required', message: 'Explicitly update before running legacy workflows.'},
      ],
      readiness: {
        planning: {state: 'blocked', reasons: []},
        publication: {state: 'blocked', reasons: []},
        watch: {state: 'blocked', reasons: []},
      },
    };
    await render();
    expect(button('Preview install').disabled).toBe(true);
    expect(button('Preview update').disabled).toBe(false);
    expect(button('Preview remove').disabled).toBe(false);
    expect(document.body.textContent).toContain('Planning: blocked');
    await click('Preview ' + action);
    expect(calls.find(call => call.url.endsWith('/preview'))?.body).toEqual({
      action,
      selector: {agent: 'codex', profile: 'desktop', scope: 'user'},
    });
    expect(document.body.textContent).toContain(previewDigest);
    expect(calls.some(call => call.url.endsWith('/apply'))).toBe(false);
  },
);

it.each(['modified', 'incompatible', 'historical-ownership-conflict'])(
  'does not admit a legacy repair UI transition with %s evidence',
  async code => {
    target = {
      ...target,
      installationState: 'incompatible',
      enrolled: true,
      enrollmentState: 'enrolled',
      installed: {
        releaseVersion: '5.2.0',
        digest,
        workflowProtocol: 1,
        stateSchema: 1,
        minimumRuntime: '5.2.0',
      },
      issues: [
        {code: 'legacy-workflow-update-required', message: 'Legacy workflow'},
        {code, message: 'Preserve conflicting evidence'},
      ],
    };
    await render();
    expect(button('Preview update').disabled).toBe(true);
    expect(button('Preview remove').disabled).toBe(true);
    expect(calls.some(call => call.url.endsWith('/preview'))).toBe(false);
  },
);
