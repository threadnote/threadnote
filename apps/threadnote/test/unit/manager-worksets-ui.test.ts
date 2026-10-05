// @vitest-environment happy-dom

import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {renderToStaticMarkup} from 'react-dom/server';
import fc from 'fast-check';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ManagerDialogProvider} from '@threadnote/manager/dialog';
import type {ManagerWorksetPrepareJob} from '@threadnote/threadnote/manager/worksets';
import {managerWorksetJobElapsedMilliseconds, PrepareJobPanel, WorksetsPanel} from '@threadnote/manager/worksets_view';
import {readFile} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';

interface PendingQuery {
  readonly signal?: AbortSignal;
  readonly resolve: (response: Response) => void;
}

interface PendingProjectDetail extends PendingQuery {
  readonly name: string;
}

interface PendingScopePreview extends PendingQuery {
  readonly name: string;
}

interface PendingCatalog extends PendingQuery {
  readonly body: ReturnType<typeof catalog>;
}

const REVISION = 'a'.repeat(64);
let reactRoot: Root | undefined;
let fetchOriginal: typeof fetch;
let pendingQueries: PendingQuery[];
let catalogRevision: string;
let definitionProjects: Map<string, readonly string[]>;
let definitionMutationBodies: Record<string, unknown>[];
let projectMutationBodies: Record<string, unknown>[];
let projectInventory: readonly string[];
let projectDetails: Map<
  string,
  {readonly name: string; readonly path: string; readonly seed: readonly string[]; readonly uri: string}
>;
let projectRevisionConflictOnce: boolean;
let deferProjectDetails: boolean;
let pendingProjectDetails: PendingProjectDetail[];
let deferScopePreview: boolean;
let pendingScopePreviews: PendingScopePreview[];
let scopePreviewFailure: string | undefined;
let deferCatalog: boolean;
let pendingCatalogs: PendingCatalog[];
let statusUnavailable: boolean;

beforeEach(() => {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  fetchOriginal = globalThis.fetch;
  pendingQueries = [];
  catalogRevision = REVISION;
  definitionMutationBodies = [];
  projectMutationBodies = [];
  definitionProjects = new Map([
    ['alpha', ['alpha']],
    ['beta', ['beta']],
  ]);
  projectInventory = ['alpha', 'beta'];
  projectDetails = new Map(projectInventory.map(name => [name, manifestProject(name)]));
  projectRevisionConflictOnce = false;
  deferProjectDetails = false;
  pendingProjectDetails = [];
  deferScopePreview = false;
  pendingScopePreviews = [];
  scopePreviewFailure = undefined;
  deferCatalog = false;
  pendingCatalogs = [];
  statusUnavailable = false;
  const fetchStub = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
    if (url === '/api/worksets') {
      const body = catalog();
      if (deferCatalog) {
        return new Promise<Response>(resolve =>
          pendingCatalogs.push({body, resolve, signal: init?.signal ?? undefined}),
        );
      }
      return Promise.resolve(jsonResponse(body));
    }
    if (url === '/api/worksets/jobs') return Promise.resolve(jsonResponse({jobs: []}));
    if (url.startsWith('/api/worksets/project?')) {
      const name = new URL(url, 'http://manager.test').searchParams.get('project') ?? '';
      const detail = projectDetails.get(name) ?? manifestProject(name);
      if (deferProjectDetails) {
        return new Promise<Response>(resolve =>
          pendingProjectDetails.push({name, resolve, signal: init?.signal ?? undefined}),
        );
      }
      return Promise.resolve(jsonResponse(detail));
    }
    if (url.startsWith('/api/worksets/project-graph-preview?')) {
      const name = new URL(url, 'http://manager.test').searchParams.get('project') ?? '';
      if (scopePreviewFailure !== undefined) {
        return Promise.resolve(jsonResponse({error: scopePreviewFailure}, 422));
      }
      if (deferScopePreview) {
        return new Promise<Response>(resolve =>
          pendingScopePreviews.push({name, resolve, signal: init?.signal ?? undefined}),
        );
      }
      return Promise.resolve(jsonResponse(scopePreview(name)));
    }
    if (url === '/api/worksets/projects') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      projectMutationBodies.push(body);
      if (projectRevisionConflictOnce) {
        projectRevisionConflictOnce = false;
        catalogRevision = 'f'.repeat(64);
        return Promise.resolve(jsonResponse({code: 'revision-conflict', error: 'Manifest changed.'}, 409));
      }
      const operation = body.operation;
      if (operation === 'delete') {
        const name = String(body.project);
        projectInventory = projectInventory.filter(project => project !== name);
        projectDetails.delete(name);
      } else {
        const name = String(body.name);
        const originalName = operation === 'update' ? String(body.project) : undefined;
        if (originalName !== undefined) {
          projectInventory = projectInventory.map(project => (project === originalName ? name : project));
          definitionProjects = new Map(
            [...definitionProjects].map(([workset, projects]) => [
              workset,
              projects.map(project => (project === originalName ? name : project)),
            ]),
          );
          projectDetails.delete(originalName);
        } else {
          projectInventory = [...projectInventory, name];
        }
        projectDetails.set(name, {
          name,
          path: String(body.path),
          seed: Array.isArray(body.seed) ? body.seed.map(String) : [],
          uri: String(body.uri),
        });
      }
      catalogRevision = String.fromCharCode(106 + projectMutationBodies.length - 1).repeat(64);
      return Promise.resolve(jsonResponse({catalog: catalog(), changed: true, warnings: []}));
    }
    if (url === '/api/worksets/definitions') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      definitionMutationBodies.push(body);
      const operation = body.operation;
      if (operation === 'delete') {
        definitionProjects.delete(String(body.workset));
      } else {
        const name = String(body.name);
        const originalName = operation === 'update' ? String(body.workset) : undefined;
        if (originalName !== undefined && originalName !== name) definitionProjects.delete(originalName);
        definitionProjects.set(name, Array.isArray(body.projects) ? body.projects.map(String) : []);
      }
      catalogRevision = String.fromCharCode(98 + definitionMutationBodies.length - 1).repeat(64);
      return Promise.resolve(jsonResponse({catalog: catalog(), changed: true, warnings: []}));
    }
    if (url.startsWith('/api/worksets/definition')) {
      const name = new URL(url, 'http://manager.test').searchParams.get('workset') ?? 'alpha';
      return Promise.resolve(jsonResponse(definition(name)));
    }
    if (url.startsWith('/api/worksets/status')) {
      if (statusUnavailable)
        return Promise.resolve(
          jsonResponse(
            {code: 'maintenance-busy', error: 'Graph maintenance is active.', retryAfterMilliseconds: 1_000},
            409,
          ),
        );
      const name = new URL(url, 'http://manager.test').searchParams.get('workset') ?? 'alpha';
      return Promise.resolve(jsonResponse(status(name)));
    }
    if (url === '/api/worksets/query') {
      return new Promise<Response>(resolve => pendingQueries.push({resolve, signal: init?.signal ?? undefined}));
    }
    throw new Error(`Unexpected Worksets request: ${url}`);
  };
  globalThis.fetch = Object.assign(fetchStub, {preconnect: fetchOriginal.preconnect});
});

afterEach(async () => {
  await act(async () => reactRoot?.unmount());
  reactRoot = undefined;
  document.body.replaceChildren();
  globalThis.fetch = fetchOriginal;
});

describe('Manager Worksets interaction fencing', () => {
  it('renders a live elapsed projection message instead of a stale child update', () => {
    const nowMilliseconds = Date.parse('2026-08-27T10:05:12.000Z');
    const job = prepareJob({
      createdAt: '2026-08-27T10:00:00.000Z',
      elapsedMilliseconds: 1_000,
    });
    const now = vi.spyOn(Date, 'now').mockReturnValue(nowMilliseconds);
    try {
      const markup = renderToStaticMarkup(React.createElement(PrepareJobPanel, {job, onCancel: () => undefined}));
      expect(markup).toContain('Workset projecting · alpha · 0/2 members · 5m 12s elapsed.');
      expect(markup).not.toContain('1s elapsed');
    } finally {
      now.mockRestore();
    }
  });

  it('keeps active elapsed time monotonic and no lower than the latest authoritative update', () => {
    fc.assert(
      fc.property(
        fc.integer({max: 600_000, min: 0}),
        fc.integer({max: 600_000, min: -600_000}),
        fc.integer({max: 600_000, min: 0}),
        (ageMilliseconds, clockAdjustmentMilliseconds, reportedMilliseconds) => {
          const baseline = Date.parse('2026-08-27T10:00:00.000Z');
          const job = prepareJob({
            createdAt: new Date(baseline - ageMilliseconds).toISOString(),
            elapsedMilliseconds: reportedMilliseconds,
          });
          const first = managerWorksetJobElapsedMilliseconds(job, baseline);
          const next = managerWorksetJobElapsedMilliseconds(job, baseline + clockAdjustmentMilliseconds, first);
          expect(first).toBeGreaterThanOrEqual(reportedMilliseconds);
          expect(next).toBeGreaterThanOrEqual(first);
        },
      ),
      {numRuns: 40},
    );
  });

  it('aborts stale selection work, clears cancellation immediately, and permits a clean rerun', async () => {
    await renderWorksets();
    const input = await waitForElement<HTMLInputElement>('input[placeholder="checkout ownership or parseManifest"]');
    await changeInput(input, 'ownership');
    await clickButton('Search published workset');
    expect(pendingQueries).toHaveLength(1);

    await clickButtonStartingWith('beta');
    expect(pendingQueries[0]?.signal?.aborted).toBe(true);
    pendingQueries[0].resolve(jsonResponse(evidence('alpha', 'AlphaOnlySymbol')));
    await flush();
    expect(document.body.textContent).toContain('beta');
    expect(document.body.textContent).not.toContain('AlphaOnlySymbol');

    await clickButton('Search published workset');
    expect(pendingQueries).toHaveLength(2);
    await clickButton('Cancel request');
    expect(pendingQueries[1]?.signal?.aborted).toBe(true);
    expect(findButton('Cancel request')).toBeUndefined();
    expect(findButton('Search published workset')?.disabled).toBe(false);

    await clickButton('Search published workset');
    expect(pendingQueries).toHaveLength(3);
    pendingQueries[2].resolve(jsonResponse(evidence('beta', 'BetaOwnership')));
    await flush();
    expect(document.body.textContent).toContain('BetaOwnership');
    expect(document.body.textContent).toContain('observed branch main');

    await clickButton('Use as From');
    await flush();
    expect(document.querySelector<HTMLButtonElement>('#worksets-tab-traversal')?.getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(document.querySelector<HTMLInputElement>('#worksets-traversal-from')?.value).toBe('cgr_example');
  });

  it('reloads a retained definition at the new revision and clears stale readiness and query results', async () => {
    await renderWorksets();
    const queryInput = await waitForElement<HTMLInputElement>(
      'input[placeholder="checkout ownership or parseManifest"]',
    );
    await changeInput(queryInput, 'ownership');
    await clickButton('Search published workset');
    pendingQueries[0].resolve(jsonResponse(evidence('alpha', 'OldGenerationSymbol')));
    await flush();
    expect(document.body.textContent).toContain('OldGenerationSymbol');
    expect(document.body.textContent).toContain('Current members');

    catalogRevision = 'd'.repeat(64);
    definitionProjects.set('alpha', ['alpha', 'beta']);
    await clickButton('Refresh definitions');
    await waitForText('2 members');
    expect(document.body.textContent).not.toContain('OldGenerationSymbol');
    await waitForButtonEnabled('Edit');
    await clickButton('Edit');
    await waitForText('2 selected');

    await clickButton('Cancel');
    statusUnavailable = true;
    await clickButton('Refresh');
    await waitForText('Readiness is temporarily unavailable');
    expect(document.body.textContent).not.toContain('Current members');
  });

  it('keeps more than 250 selected projects searchable and pageable', async () => {
    projectInventory = Array.from({length: 320}, (_, index) => `project-${String(index).padStart(3, '0')}`);
    definitionProjects = new Map([
      ['alpha', projectInventory.slice(0, 300)],
      ['beta', ['project-319']],
    ]);
    await renderWorksets();
    await waitForButtonEnabled('Edit');
    await clickButton('Edit');
    const filter = await waitForElement<HTMLInputElement>('input[placeholder="Filter manifest projects"]');
    await changeInput(filter, 'project-299');
    await waitForText('project-299');
    expect(document.querySelector<HTMLInputElement>('.worksets-project-picker input[type="checkbox"]')?.checked).toBe(
      true,
    );

    await changeInput(filter, '');
    await clickButton('Show selected only');
    await clickButton('Next');
    await waitForText('Page 2 of 2');
    expect(document.body.textContent).toContain('project-299');
  });

  it('creates and confirmed-deletes a Workset through the visible definition controls', async () => {
    await renderWorksets();
    const create = await waitForElement<HTMLButtonElement>('button[aria-label="Create workset"]');
    await act(async () => create.click());
    await flush();

    const name = await waitForElement<HTMLInputElement>(
      '.worksets-editor input:not([type="search"]):not([type="checkbox"])',
    );
    await changeInput(name, 'gamma');
    const firstProject = await waitForElement<HTMLInputElement>('.worksets-project-picker input[type="checkbox"]');
    await act(async () => firstProject.click());
    await flush();
    await clickButton('Save definition');
    await waitForText('Workset definition saved.');

    expect(definitionMutationBodies[0]).toMatchObject({
      expectedRevision: REVISION,
      name: 'gamma',
      operation: 'create',
      projects: ['alpha'],
    });
    expect(document.body.textContent).toContain('gamma');

    await clickButton('Delete');
    await flush();
    await clickButton('Delete definition');
    await waitForText('Workset definition deleted.');
    expect(definitionMutationBodies[1]).toMatchObject({
      confirm: true,
      expectedRevision: 'b'.repeat(64),
      operation: 'delete',
      workset: 'gamma',
    });
  });

  it('creates the first manifest project before enabling Workset creation', async () => {
    projectInventory = [];
    projectDetails.clear();
    definitionProjects.clear();
    await renderWorksets('#manifest-management-panel-projects');
    await waitForText('Add your first manifest project');
    await clickButton('Add first project');

    const inputs = [...document.querySelectorAll<HTMLInputElement>('.project-editor input:not([type="checkbox"])')];
    expect(inputs).toHaveLength(3);
    await changeInput(inputs[0], 'checkout');
    await changeInput(inputs[1], '~/src/checkout');
    await changeInput(inputs[2], 'threadnote://resources/repos/checkout');
    const seeds = await waitForElement<HTMLTextAreaElement>('.project-editor textarea');
    await changeTextArea(seeds, 'AGENTS.md\ndocs/**/*.md');
    await clickButton('Save project');
    await waitForText('Manifest project saved.');

    expect(projectMutationBodies[0]).toEqual({
      expectedRevision: REVISION,
      name: 'checkout',
      operation: 'create',
      path: '~/src/checkout',
      seed: ['AGENTS.md', 'docs/**/*.md'],
      uri: 'threadnote://resources/repos/checkout',
    });
    await clickButtonStartingWith('Worksets');
    await waitForText('No workset selected');
    expect(findButton('Create workset')?.disabled).toBe(false);
  });

  it('saves optional graph roots and includes from the project editor', async () => {
    await renderWorksets();
    await clickButtonStartingWith('Projects');
    await waitForButtonEnabled('Edit project');
    await clickButton('Edit project');
    const enabled = await waitForElement<HTMLInputElement>('.project-editor input[type="checkbox"]');
    await changeCheckbox(enabled, true);
    const fields = [...document.querySelectorAll<HTMLTextAreaElement>('.project-editor textarea')];
    await changeTextArea(fields[1], 'apps/web\npackages/core');
    await changeTextArea(fields[2], 'tools/generated');
    await clickButton('Save project');
    await waitForText('Manifest project saved.');
    expect(projectMutationBodies[0]).toMatchObject({
      graph: {closure: 'dependencies', include: ['tools/generated'], roots: ['apps/web', 'packages/core']},
      operation: 'update',
      project: 'alpha',
    });
  });

  it('shows graph scope preview progress and a completed preview result', async () => {
    deferScopePreview = true;
    await renderWorksets();
    await clickButtonStartingWith('Projects');
    await waitForButtonEnabled('Preview graph scope');
    await clickButton('Preview graph scope');
    await waitForPendingScopePreviews(1);

    expect(findButton('Previewing graph scope…')?.disabled).toBe(true);
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Previewing graph scope…');

    pendingScopePreviews[0]?.resolve(jsonResponse(scopePreview('alpha')));
    await waitForElement<HTMLElement>('[aria-label="Graph scope preview"]');
    expect(document.body.textContent).toContain('12 included / 4 excluded files · complete');
    expect(document.body.textContent).toContain('Kashkovsky/alpha @ abcdef123456');
    expect(document.body.textContent).toContain('apps/web, packages/core');
    expect(document.body.textContent).toContain('Read-only preview; no index was started.');
    expect(findButton('Preview graph scope')?.disabled).toBe(false);
  });

  it('shows partial graph scope preview completeness', async () => {
    deferScopePreview = true;
    await renderWorksets();
    await clickButtonStartingWith('Projects');
    await waitForButtonEnabled('Preview graph scope');
    await clickButton('Preview graph scope');
    await waitForPendingScopePreviews(1);

    pendingScopePreviews[0]?.resolve(jsonResponse(scopePreview('alpha', 'partial')));
    await waitForElement<HTMLElement>('[aria-label="Graph scope preview"]');

    expect(document.querySelector('[aria-label="Graph scope preview"] [role="status"]')?.textContent).toContain(
      'Partial',
    );
    expect(document.querySelector('[aria-label="Graph scope preview"] [role="status"]')?.textContent).not.toContain(
      'Complete',
    );
  });

  it('keeps graph scope preview failures actionable', async () => {
    scopePreviewFailure = 'The configured project is not an available local Git repository.';
    await renderWorksets();
    await clickButtonStartingWith('Projects');
    await waitForButtonEnabled('Preview graph scope');
    await clickButton('Preview graph scope');
    await waitForText("Couldn't preview graph scope");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(scopePreviewFailure);
    expect(document.body.textContent).toContain('Review the project path and graph roots, then try again.');
  });

  it('keeps the deletion receipt visible after removing the final project', async () => {
    projectInventory = ['solo'];
    projectDetails = new Map([['solo', manifestProject('solo')]]);
    definitionProjects = new Map([['platform', ['solo']]]);
    await renderWorksets();
    await clickButtonStartingWith('Projects');
    await waitForButtonEnabled('Delete project');
    await clickButton('Delete project');
    await flush();
    await clickButton('Confirm project deletion');
    await waitForText('Referencing Worksets are now unresolved.');
    expect(document.body.textContent).toContain('Add your first manifest project');
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      'Referencing Worksets are now unresolved.',
    );
  });

  it('preserves an edited project draft across a revision conflict, then renames and deletes it explicitly', async () => {
    await renderWorksets();
    await clickButtonStartingWith('Projects');
    await waitForButtonEnabled('Edit project');
    await clickButton('Edit project');
    const inputs = [...document.querySelectorAll<HTMLInputElement>('.project-editor input:not([type="checkbox"])')];
    await changeInput(inputs[0], 'alpha-renamed');
    await changeInput(inputs[1], '/workspace/alpha-renamed');
    projectRevisionConflictOnce = true;
    await clickButton('Save project');
    await waitForText('your draft is preserved');
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain('your draft is preserved');
    expect(document.querySelector<HTMLInputElement>('.project-editor input:not([type="checkbox"])')?.value).toBe(
      'alpha-renamed',
    );

    await clickButton('Save project');
    await waitForText('Manifest project saved.');
    expect(projectMutationBodies[1]).toMatchObject({
      expectedRevision: 'f'.repeat(64),
      name: 'alpha-renamed',
      operation: 'update',
      project: 'alpha',
    });
    await waitForButtonEnabled('Delete project');
    await clickButton('Delete project');
    await flush();
    expect(document.body.textContent).toContain('Resources and repository graphs are not deleted.');
    expect(document.body.textContent).toContain('referenced by 1 Workset: alpha');
    await clickButton('Confirm project deletion');
    await waitForText('Referencing Worksets are now unresolved.');
    expect(projectMutationBodies[2]).toMatchObject({
      confirm: true,
      operation: 'delete',
      project: 'alpha-renamed',
    });
  });

  it('fences stale project detail responses after selection changes', async () => {
    deferProjectDetails = true;
    await renderWorksets();
    await clickButtonStartingWith('Projects');
    await waitForPendingProjectDetails(1);
    await clickButtonStartingWith('beta');
    await waitForPendingProjectDetails(2);
    expect(pendingProjectDetails[0]?.signal?.aborted).toBe(true);

    pendingProjectDetails[0].resolve(jsonResponse(manifestProject('alpha')));
    await flush();
    expect(document.body.textContent).not.toContain('threadnote://resources/repos/alpha');
    pendingProjectDetails[1].resolve(jsonResponse(manifestProject('beta')));
    await waitForText('threadnote://resources/repos/beta');
  });

  it('does not let an older catalog refresh overwrite a successful project mutation', async () => {
    await renderWorksets();
    deferCatalog = true;
    await clickButton('Refresh definitions');
    await waitForPendingCatalogs(1);

    await clickButtonStartingWith('Projects');
    await waitForButtonEnabled('Edit project');
    await clickButton('Edit project');
    const inputs = [...document.querySelectorAll<HTMLInputElement>('.project-editor input:not([type="checkbox"])')];
    await changeInput(inputs[0], 'gamma');
    await clickButton('Save project');
    await waitForText('Manifest project saved.');
    expect(pendingCatalogs[0]?.signal?.aborted).toBe(true);

    pendingCatalogs[0].resolve(jsonResponse(pendingCatalogs[0].body));
    await flush();
    expect(findButtonStartingWith('gamma')).toBeDefined();
    expect(findButtonStartingWith('alpha')).toBeUndefined();

    await waitForButtonEnabled('Edit project');
    await clickButton('Edit project');
    const updatedInputs = [
      ...document.querySelectorAll<HTMLInputElement>('.project-editor input:not([type="checkbox"])'),
    ];
    await changeInput(updatedInputs[1], '/workspace/gamma');
    await clickButton('Save project');
    await waitForText('Manifest project saved.');
    expect(projectMutationBodies[1]?.expectedRevision).toBe('j'.repeat(64));
  });

  it('links operation tabs to panels and supports arrow-key navigation', async () => {
    await renderWorksets();
    const managementWorksets = await waitForElement<HTMLButtonElement>('#manifest-management-tab-worksets');
    await act(async () =>
      managementWorksets.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, key: 'ArrowLeft'})),
    );
    await flush();
    const managementProjects = document.querySelector<HTMLButtonElement>('#manifest-management-tab-projects');
    expect(managementProjects?.getAttribute('aria-selected')).toBe('true');
    expect(managementProjects?.tabIndex).toBe(0);
    await act(async () =>
      managementProjects?.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, key: 'ArrowRight'})),
    );
    await flush();

    const queryTab = await waitForElement<HTMLButtonElement>('#worksets-tab-query');
    expect(queryTab.getAttribute('aria-controls')).toBe('worksets-panel-query');
    expect(document.querySelector('#worksets-panel-query')?.getAttribute('aria-labelledby')).toBe('worksets-tab-query');

    await act(async () => queryTab.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, key: 'ArrowRight'})));
    await flush();
    const traversalTab = document.querySelector<HTMLButtonElement>('#worksets-tab-traversal');
    expect(traversalTab?.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('#worksets-panel-traversal')?.getAttribute('aria-labelledby')).toBe(
      'worksets-tab-traversal',
    );
  });

  it('offers resume in the Workset Context Brief mode selector', async () => {
    await renderWorksets();
    await clickButton('Context brief');
    const mode = await waitForElement<HTMLSelectElement>('#worksets-panel-brief select');

    expect([...mode.options].map(option => option.value)).toContain('resume');
  });

  it('keeps the six-section nav and Worksets editor usable at narrow widths', async () => {
    const css = await readFile(join(process.cwd(), 'packages', 'manager', 'static', 'app.css'), 'utf8');
    expect(css).toMatch(
      /@media \(max-width: 980px\)[\s\S]*\.worksets-workspace\s*\{[\s\S]*grid-template-columns: 1fr/u,
    );
    expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*\.primary-nav\s*\{[\s\S]*repeat\(3,/u);
    expect(css).toMatch(
      /\.worksets-editor\s*\{[\s\S]*max-height: min\(760px, calc\(100dvh - 40px\)\);[\s\S]*overflow-y: auto/u,
    );
  });
});

function prepareJob(input: {
  readonly createdAt: string;
  readonly elapsedMilliseconds: number;
}): ManagerWorksetPrepareJob {
  return {
    createdAt: input.createdAt,
    id: 'cgwj_live_elapsed',
    progress: {
      completed: 0,
      elapsedMilliseconds: input.elapsedMilliseconds,
      message: 'Workset projecting · alpha · 0/2 members · 1s elapsed.',
      phase: 'projecting',
      project: 'alpha',
      total: 2,
    },
    status: 'running',
    workset: 'platform',
  };
}

async function renderWorksets(waitSelector = '#worksets-tab-query'): Promise<void> {
  const container = document.createElement('div');
  document.body.append(container);
  reactRoot = createRoot(container);
  await act(async () => {
    reactRoot?.render(React.createElement(ManagerDialogProvider, undefined, React.createElement(WorksetsPanel)));
  });
  await waitForElement(waitSelector);
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise(resolve => window.setTimeout(resolve, 0));
  });
}

async function waitForElement<T extends Element>(selector: string): Promise<T> {
  for (let index = 0; index < 20; index += 1) {
    const element = document.querySelector<T>(selector);
    if (element) return element;
    await flush();
  }
  throw new Error(`Element did not render: ${selector}`);
}

async function waitForText(text: string): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (document.body.textContent?.includes(text)) return;
    await flush();
  }
  throw new Error(`Text did not render: ${text}`);
}

async function waitForButtonEnabled(label: string): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    const button = findButton(label);
    if (button && !button.disabled) return;
    await flush();
  }
  throw new Error(`Button did not become enabled: ${label}`);
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await flush();
}

async function changeCheckbox(input: HTMLInputElement, checked: boolean): Promise<void> {
  await act(async () => {
    if (input.checked !== checked) input.click();
  });
  await flush();
}

async function changeTextArea(input: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await flush();
}

async function waitForPendingProjectDetails(count: number): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (pendingProjectDetails.length >= count) return;
    await flush();
  }
  throw new Error(`Expected ${count} pending project detail requests.`);
}

async function waitForPendingScopePreviews(count: number): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (pendingScopePreviews.length >= count) return;
    await flush();
  }
  throw new Error(`Expected ${count} pending graph scope previews.`);
}

async function waitForPendingCatalogs(count: number): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (pendingCatalogs.length >= count) return;
    await flush();
  }
  throw new Error(`Expected ${count} pending catalog requests.`);
}

async function clickButton(label: string): Promise<void> {
  const button = findButton(label);
  expect(button).toBeDefined();
  await act(async () => button?.click());
}

async function clickButtonStartingWith(label: string): Promise<void> {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(candidate =>
    candidate.textContent?.trim().startsWith(label),
  );
  expect(button).toBeDefined();
  await act(async () => button?.click());
  await flush();
}

function findButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    candidate => candidate.textContent?.trim() === label,
  );
}

function findButtonStartingWith(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(candidate =>
    candidate.textContent?.trim().startsWith(label),
  );
}

function jsonResponse(body: unknown, statusCode = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: {'content-type': 'application/json'},
    status: statusCode,
  });
}

function catalog() {
  return {
    definitions: [...definitionProjects].map(([name, projects]) => ({
      description: `${name[0].toUpperCase()}${name.slice(1)} services`,
      memberCount: projects.length,
      name,
    })),
    definitionSource: 'seed-manifest',
    editability: {state: 'editable'},
    projectEditability: {state: 'editable'},
    projects: projectInventory.map(project),
    projectsReadOnly: false,
    readOnly: false,
    revision: catalogRevision,
    type: 'manager-workset-catalog',
    version: 1,
  };
}

function project(name: string) {
  return {
    branch: 'main',
    branchState: 'current',
    folder: `${name}-service`,
    name,
    path: `/workspace/${name}-service`,
    worksets: [...definitionProjects].filter(([, projects]) => projects.includes(name)).map(([workset]) => workset),
    worksetCount: [...definitionProjects.values()].filter(projects => projects.includes(name)).length,
  };
}

function manifestProject(name: string) {
  return {
    name,
    path: `/workspace/${name}-service`,
    seed: ['AGENTS.md'],
    uri: `threadnote://resources/repos/${name}`,
  };
}

function scopePreview(name: string, completeness: 'complete' | 'partial' = 'complete') {
  return {
    inventory: {
      excluded: {bytes: 1_024, files: 4},
      included: {bytes: 4_096, files: 12},
    },
    project: {graph: {closure: 'dependencies', include: ['tools/generated'], roots: ['apps/web']}, name},
    repository: {commit: 'abcdef1234567890', dirty: false, displayName: `Kashkovsky/${name}`},
    scope: {
      completeness,
      controlPaths: ['AGENTS.md'],
      dependencyComponents: ['packages/core'],
      diagnostics: ['Included a dependency component.'],
      includes: ['tools/generated'],
      rootComponents: ['apps/web', 'packages/core'],
      roots: ['apps/web'],
    },
    snapshotReuse: 'not-evaluated',
    type: 'code-graph-project-scope-preview',
    version: 1,
  };
}

function definition(name: string) {
  const projects = definitionProjects.get(name) ?? [name];
  return {
    configuredMembers: projects.length,
    description: `${name} services`,
    members: projects.map(member => ({...project(member), configured: true, project: member})),
    name,
    unresolvedMembers: 0,
  };
}

function status(name: string) {
  return {
    catalog: {state: 'missing'},
    coverage: {
      current: 0,
      requested: 1,
      states: {current: 0, deferred: 0, excluded: 0, failed: 0, missing: 1, stale: 0, uncatalogued: 0},
    },
    manifestDigest: 'b'.repeat(64),
    members: [{project: name, reason: 'no-ready-snapshot', state: 'missing'}],
    type: 'code-graph-workset-status',
    version: 1,
    warnings: [],
    workset: name,
  };
}

function evidence(repositoryKey: string, qualifiedName: string) {
  return {
    maximumBytes: 4_096,
    measurement: {},
    structuredContent: {
      cards: [
        {
          id: `card-${repositoryKey}`,
          reason: {score: 1, signals: [], summary: 'Exact graph match'},
          ref: 'cgr_example',
          relationships: [],
          repositoryKey,
          symbol: {
            kind: 'function',
            language: 'typescript',
            name: qualifiedName,
            path: 'src/index.ts',
            qualifiedName,
            span: {column: 0, endColumn: 1, endLine: 1, line: 1},
          },
        },
      ],
      coverage: {
        cataloguedRepositories: 1,
        complete: true,
        consideredRepositories: 1,
        deepQueriedRepositories: 1,
        requestedRepositories: 1,
        states: {current: 1, deferred: 0, excluded: 0, failed: 0, missing: 0, stale: 0},
        stopReason: 'exhaustion',
      },
      output: {omittedCards: 0, projectorVersion: 1, returnedCards: 1, totalCards: 1, truncated: false},
      repositories: {},
      trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
      type: 'code-graph-workset-query',
      version: 2,
      warnings: [],
      workset: {generation: {digest: 'c'.repeat(64), id: 'cgwg_example'}, name: repositoryKey},
    },
    text: '',
  };
}
