import {
  completeDiagramSubject,
  describeCodeGraphDiagramQuestion,
  renderCompleteCodeGraphDiagram,
} from '@threadnote/graph/query/diagram';
import {CodeGraphDiagramResultSchema, type CodeGraphDiagramType} from '@threadnote/graph/query/diagram_contract';
import type {CodeGraphEdge, CodeGraphQueryNode} from '@threadnote/graph/types';
import {Array as Arr, Option, Schema, String as Str} from 'effect';
import {test, expect} from './fixtures/test.js';
import {createRepository, indexRepository, largeDiagramStages, rememberCited} from './fixtures/repositories.js';
import {readFile} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';

test('S08 the real graph scene queries a symbol and opens indexed source and relationships', async ({
  page,
  manager,
}) => {
  test.setTimeout(90_000);
  const repository = await createRepository(manager);
  expect(await indexRepository(manager, repository)).toContain('ready');
  const uri = await rememberCited(manager, repository);
  expect(await manager.cli(['read', uri])).toContain('code_citation:');
  await page.getByRole('button', {name: 'Refresh manager', exact: true}).click();
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Graph', exact: true})
    .click();
  await page.getByText('Search and relationship filters', {exact: true}).click();
  await page.getByRole('searchbox', {name: 'Query the code graph', exact: true}).fill(repository.symbol);
  const querying = page.waitForResponse(response => new URL(response.url()).pathname === '/api/graph/query');
  await page.getByRole('button', {name: 'Query graph', exact: true}).click();
  expect((await querying).ok()).toBe(true);
  await expect(page.getByRole('button', {name: 'Query graph', exact: true})).toBeEnabled();
  await page.getByText('Search and relationship filters', {exact: true}).click();
  await expect(page.locator('canvas')).toBeVisible();
  expect(
    await page.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
      const context = canvas.getContext('webgl2');
      return context !== null && !context.isContextLost();
    }),
  ).toBe(true);
  await page.getByRole('searchbox', {name: 'Find in current view', exact: true}).fill(repository.symbol);
  const result = page.locator('.graph-search-results').getByRole('button').filter({hasText: repository.symbol});
  await expect(result).toBeVisible();
  await result.click();
  const inspector = page.locator('.node-inspector');
  await expect(inspector.getByRole('heading', {name: repository.symbol, exact: true})).toBeVisible();
  await expect(inspector.locator('.source-location')).toContainText('src/entry.ts');
  await expect(inspector.locator('.node-signature')).toContainText('name: string');
  await inspector.getByRole('tab', {name: 'Relations', exact: true}).click();
  await expect(inspector.locator('.relationship-view')).toContainText(/calls|normalize/iu);
  await inspector.getByRole('tab', {name: 'Evidence', exact: true}).click();
  await expect(inspector).toContainText('src/entry.ts');
});

test('S08 Graph Explore renders and copies a diagram from indexed authentication source', async ({page, manager}) => {
  test.setTimeout(90_000);
  const repository = await createRepository(manager);
  expect(await indexRepository(manager, repository)).toContain('ready');
  await indexRepository(manager, await createRepository(manager, 'beta'));
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {origin: manager.origin});
  await page.getByRole('button', {name: 'Refresh manager', exact: true}).click();
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Graph', exact: true})
    .click();
  const repositoryChoice = page.getByRole('combobox', {name: 'Repository', exact: true});
  await repositoryChoice.selectOption({label: 'alpha'});
  await page.getByText('Ask for a code diagram', {exact: true}).click();
  await page.getByRole('textbox', {name: 'Question'}).fill('How authentication works?');
  const typeChoice = page.getByRole('combobox', {name: 'Diagram type'});
  await expect(typeChoice.locator('option')).toHaveText(['Auto', 'Flowchart', 'Sequence', 'Class', 'Architecture']);
  const generate = async () => {
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/graph/diagram');
    await page.getByRole('button', {name: 'Generate diagram'}).click();
    return pending;
  };
  await typeChoice.selectOption('class');
  const unsupported = await generate();
  expect(unsupported.ok()).toBe(true);
  const diagramRequest = Schema.Struct({
    viewId: Schema.String,
    snapshotId: Schema.String,
    question: Schema.String,
    diagramType: Schema.String,
  });
  const originalRequest = Schema.decodeUnknownSync(diagramRequest)(unsupported.request().postDataJSON());
  expect(originalRequest.diagramType).toBe('class');
  expect(await unsupported.json()).toMatchObject({status: 'unavailable', suggestedType: 'flowchart'});
  const result = page.getByRole('region', {name: 'Code diagram result'});
  const suggestedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/graph/diagram');
  await result.getByRole('button', {name: 'Show Flowchart', exact: true}).click();
  await expect(typeChoice).toHaveValue('flowchart');
  const response = await suggestedResponse;
  expect(response.ok()).toBe(true);
  const diagram = Schema.decodeUnknownSync(CodeGraphDiagramResultSchema)(await response.json());
  if (diagram.status !== 'diagram') throw new Error(JSON.stringify(diagram));
  expect(Schema.decodeUnknownSync(diagramRequest)(response.request().postDataJSON())).toEqual({
    ...originalRequest,
    diagramType: 'flowchart',
  });
  expect(diagram.diagramType).toBe('flowchart');
  await expect(result.getByRole('heading', {name: 'Flowchart diagram'})).toBeVisible();
  await expect(result).toContainText('Coverage complete');
  await expect(result.frameLocator('iframe').locator('svg')).toBeVisible();
  await result.getByText('Source evidence', {exact: true}).click();
  await expect(result).toContainText('src/auth.ts:2');
  await expect(result).toContainText('src/sessions.ts:2');
  await expect(result).toContainText('src/signature.ts:1');
  await expect(result).not.toContainText('src/auth-distractor.ts');
  await result.getByRole('button', {name: 'Copy Mermaid code'}).click();
  await expect(result).toContainText('Mermaid code copied.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(diagram.source);

  await page.evaluate(() => {
    const fetchRequest = window.fetch.bind(window);
    Reflect.set(window, 'fetch', async (url: RequestInfo | URL, options?: RequestInit) => {
      if (url !== '/api/graph/diagram') return fetchRequest(url, options);
      const response = await fetchRequest(url, {...options, signal: undefined});
      const json = response.json.bind(response);
      Reflect.set(response, 'json', async () => {
        const payload: unknown = await json();
        document.documentElement.dataset.lateDiagramRead = 'yes';
        return payload;
      });
      return response;
    });
  });
  const held = Promise.withResolvers<void>();
  const admitted = Promise.withResolvers<void>();
  await page.route('**/api/graph/diagram', async route => {
    const response = await route.fetch();
    admitted.resolve();
    await held.promise;
    await route.fulfill({response});
  });
  try {
    await page.getByRole('button', {name: 'Generate diagram'}).click();
    await admitted.promise;
    await repositoryChoice.selectOption({label: 'beta'});
    await page.getByText('Ask for a code diagram', {exact: true}).click();
    await expect(page.getByRole('textbox', {name: 'Question'})).toHaveValue('');
    const lateResponse = page.waitForResponse(reply => new URL(reply.url()).pathname === '/api/graph/diagram');
    held.resolve();
    expect((await lateResponse).ok()).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('data-late-diagram-read', 'yes');
    await page.evaluate(
      () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    await expect(result).toHaveCount(0);
  } finally {
    held.resolve();
  }
});

const browserTypes = [
  ['architecture', 'service', 'database', 'configures', 'Architecture'],
  ['class', 'class', 'interface', 'implements', 'Class'],
  ['sequence', 'function', 'function', 'calls', 'Sequence'],
  ['flowchart', 'module', 'module', 'imports', 'Flowchart'],
] as const satisfies readonly (readonly [CodeGraphDiagramType, string, string, CodeGraphEdge['relation'], string])[];

test('S08 all projected diagram types render hostile evidence labels as inert text', async ({page, manager}) => {
  test.setTimeout(90_000);
  await indexRepository(manager, await createRepository(manager));
  const externalRequests: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== manager.origin) {
      externalRequests.push(url.href);
    }
  });
  const span = {line: 1, column: 1, endLine: 1, endColumn: 6};
  const node = (id: string, kind: string, qualifiedName: string): CodeGraphQueryNode => ({
    id,
    kind,
    qualifiedName,
    name: id,
    path: `src/${id}.ts`,
    exported: true,
    language: 'typescript',
    span,
    score: 1,
    contentHash: 'fixture',
  });
  await page.route('**/api/graph/diagram', async route => {
    const response = await route.fetch();
    const answer = Schema.decodeUnknownSync(CodeGraphDiagramResultSchema)(await response.json());
    const body = Schema.decodeUnknownSync(Schema.Struct({diagramType: Schema.String}))(route.request().postDataJSON());
    const type = Arr.findFirst(browserTypes, ([diagramType]) => diagramType === body.diagramType);
    if (Option.isNone(type)) throw new Error('Expected an explicit diagram type.');
    const [diagramType, sourceKind, targetKind, relation] = type.value;
    const subject = node(
      'RenderSubject',
      sourceKind,
      'RenderSubject"]\nclick x "https://unused.invalid"\n<script>⛔</script><img src=https://unused.invalid/pixel>',
    );
    const linked = node('LinkedSubject', targetKind, 'LinkedSubject');
    const result = renderCompleteCodeGraphDiagram({
      question: describeCodeGraphDiagramQuestion(
        diagramType === 'class'
          ? 'Class diagram for RenderSubject'
          : diagramType === 'architecture'
            ? 'Architecture for RenderSubject'
            : 'RenderSubject',
        diagramType,
      ),
      scope: answer.scope,
      freshness: answer.freshness,
      coverage: {completeness: 'complete', subject: completeDiagramSubject(subject), boundaries: [], gaps: []},
      nodes: new Map([
        [subject.id, subject],
        [linked.id, linked],
      ]),
      boundaryIds: new Set(),
      facts: [
        {
          id: 'relation',
          relation,
          sourceId: 'RenderSubject',
          targetId: 'LinkedSubject',
          sourceName: 'RenderSubject',
          targetName: 'LinkedSubject',
          evidencePath: 'src/RenderSubject.ts',
          evidenceSpan: span,
          provenance: 'resolved',
          confidence: 1,
        },
      ],
    });
    if (result.status !== 'diagram') throw new Error(JSON.stringify(result));
    await route.fulfill({response, json: result});
  });
  await page.getByRole('button', {name: 'Refresh manager', exact: true}).click();
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Graph', exact: true})
    .click();
  await page.getByText('Ask for a code diagram', {exact: true}).click();
  await page.getByRole('textbox', {name: 'Question'}).fill('RenderSubject');
  for (const [type, , , , label] of browserTypes) {
    await page.getByRole('combobox', {name: 'Diagram type'}).selectOption(type);
    await page.getByRole('button', {name: 'Generate diagram'}).click();
    const result = page.getByRole('region', {name: 'Code diagram result'});
    await expect(result.getByRole('heading', {name: `${label} diagram`})).toBeVisible();
    await expect(result.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
    const svg = result.frameLocator('iframe').locator('svg');
    await expect(svg).toBeVisible();
    await expect(svg).toContainText('RenderSubject');
    await expect(svg.locator('script,a,img,image')).toHaveCount(0);
  }
  expect(externalRequests).toEqual([]);
});

test('S08 a rendered diagram opens a full-screen viewer with zoom and scroll', async ({page, manager}) => {
  test.setTimeout(90_000);
  expect(await indexRepository(manager, await createRepository(manager, 'alpha', true, 'viewer'))).toContain('ready');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {origin: manager.origin});
  await page.getByRole('button', {name: 'Refresh manager', exact: true}).click();
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Graph', exact: true})
    .click();
  await page.getByText('Ask for a code diagram', {exact: true}).click();
  await page.getByRole('textbox', {name: 'Question'}).fill('How does runViewerWorkflow work?');
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/graph/diagram');
  await page.getByRole('button', {name: 'Generate diagram'}).click();
  const response = await pending;
  const answer = Schema.decodeUnknownSync(CodeGraphDiagramResultSchema)(await response.json());
  if (answer.status !== 'diagram') throw new Error(JSON.stringify(answer));
  expect(answer.evidence.edges).toHaveLength(374);
  expect(answer.source.length).toBeLessThan(50_000);
  const result = page.getByRole('region', {name: 'Code diagram result'});
  const preview = result.locator('iframe[title="Mermaid diagram"]');
  await expect(result.frameLocator('iframe[title="Mermaid diagram"]').locator('svg')).toBeVisible();
  const open = result.getByRole('button', {name: 'Open full-screen diagram'});
  await expect(open).toBeVisible();
  await preview.evaluate(element => element.scrollIntoView({block: 'start'}));
  const previewBox = await preview.boundingBox();
  if (!previewBox) throw new Error('Diagram preview is unavailable.');
  await page.mouse.click(previewBox.x + previewBox.width / 2, previewBox.y + 45);
  const viewer = page.getByRole('dialog', {name: 'Full-screen diagram'});
  await expect(viewer).toBeVisible();
  const frame = viewer.locator('iframe');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  const svg = viewer.frameLocator('iframe').locator('svg');
  await expect(svg).toBeVisible();
  await expect(svg).toContainText('viewerStage13');
  const viewport = viewer.getByRole('region', {name: 'Scrollable diagram'});
  const scrollRoom = await viewport.evaluate(element => element.scrollWidth - element.clientWidth);
  expect(scrollRoom).toBeGreaterThan(60_000);
  const frameWidth = await frame.evaluate(element => element.clientWidth);
  const viewBoxWidth = async () => Number(Str.split(' ')((await svg.getAttribute('viewBox')) ?? '')[2]);
  await expect(viewer.getByRole('button', {name: 'Reset zoom'})).toHaveText('100%');
  await expect.poll(viewBoxWidth).toBeCloseTo(frameWidth, 0);
  await viewer.getByRole('button', {name: 'Zoom in'}).click();
  await expect(viewer.getByRole('button', {name: 'Reset zoom'})).toHaveText('125%');
  await expect.poll(viewBoxWidth).toBeCloseTo(frameWidth / 1.25, 0);
  expect(await frame.evaluate(element => element.clientWidth)).toBe(frameWidth);
  await viewport.evaluate(element => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect.poll(() => viewport.evaluate(element => element.scrollLeft)).toBeGreaterThan(60_000);
  await expect
    .poll(() =>
      svg.locator('g.node').evaluateAll(nodes => {
        for (const node of nodes) {
          const bounds = node.getBoundingClientRect();
          if (
            /^viewerFarStage/u.test(node.textContent ?? '') &&
            bounds.left < window.innerWidth &&
            bounds.right > 0 &&
            bounds.right <= window.innerWidth + 4
          )
            return true;
        }
        return false;
      }),
    )
    .toBe(true);
  await viewport.focus();
  await page.keyboard.press('PageDown');
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(open).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(viewer).toBeVisible();
  await viewer.getByRole('button', {name: 'Close diagram'}).click();
  await expect(viewer).toHaveCount(0);
  await result.getByRole('button', {name: 'Copy Mermaid code'}).click();
  await expect(result).toContainText('Mermaid code copied.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(answer.source);
});

test('S08 oversized diagram source remains selectable and copyable after preview failure', async ({page, manager}) => {
  test.setTimeout(90_000);
  expect(await indexRepository(manager, await createRepository(manager, 'alpha', true, 'oversized'))).toContain(
    'ready',
  );
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {origin: manager.origin});
  await page.getByRole('button', {name: 'Refresh manager', exact: true}).click();
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Graph', exact: true})
    .click();
  await page.getByText('Ask for a code diagram', {exact: true}).click();
  await page.getByRole('textbox', {name: 'Question'}).fill('How does runLargeAuthenticationWorkflow work?');
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/graph/diagram');
  await page.getByRole('button', {name: 'Generate diagram'}).click();
  const response = await pending;
  expect(response.ok()).toBe(true);
  const answer = Schema.decodeUnknownSync(CodeGraphDiagramResultSchema)(await response.json());
  if (answer.status !== 'diagram') throw new Error(JSON.stringify(answer));
  const {source} = answer;
  expect(source.length).toBeGreaterThan(50_000);
  expect(answer.coverage?.completeness).toBe('complete');
  expect(answer.evidence.edges).toHaveLength(largeDiagramStages.length);
  const ids = new Map(Arr.map(answer.evidence.nodes, node => [node.name, node.diagramId]));
  const caller = ids.get('runLargeAuthenticationWorkflow');
  expect(caller).toBeDefined();
  const expectedCalls = Arr.map(largeDiagramStages, stage => {
    const callee = ids.get(stage);
    expect(callee).toBeDefined();
    return `  ${caller} -->|calls| ${callee}`;
  });
  const serializedCalls = Arr.filter(Str.split('\n')(source), line => /^ {2}n[0-9]+ -->\|calls\| n[0-9]+$/u.test(line));
  expect(serializedCalls.sort()).toEqual(expectedCalls.sort());
  const result = page.getByRole('region', {name: 'Code diagram result'});
  await expect(result).toContainText('Coverage complete');
  await expect(result).toContainText('Unable to render this diagram');
  await expect(result.locator('iframe')).toHaveCount(0);
  const selectable = result.locator('pre code');
  await expect(selectable).toBeVisible();
  expect(await selectable.textContent()).toBe(source);
  const copy = result.getByRole('button', {name: 'Copy Mermaid code'});
  await copy.click();
  await expect(result).toContainText('Mermaid code copied.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(source);
  await page.evaluate(() => {
    Reflect.set(navigator.clipboard, 'writeText', () => Promise.reject(new Error('Clipboard denied')));
  });
  await copy.click();
  await expect(result.getByRole('alert')).toContainText('Clipboard access failed');
  expect(await result.getByRole('textbox', {name: 'Selectable Mermaid code'}).inputValue()).toBe(source);
});

test('S08 an architecture preview with 501 connections preserves exact source for copy', async ({page, manager}) => {
  test.setTimeout(90_000);
  await indexRepository(manager, await createRepository(manager));
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {origin: manager.origin});
  function architectureSource(edgeCount: number): string {
    return Arr.join(
      [
        'architecture-beta',
        ...Arr.makeBy(edgeCount + 1, index => `  service s${index}[Service ${index}]`),
        ...Arr.makeBy(edgeCount, index => `  s${index}:R --> L:s${index + 1}`),
      ],
      '\n',
    );
  }
  const largeSource = architectureSource(501);
  expect(largeSource.length).toBeLessThan(50_000);
  await page.route('**/api/graph/diagram', async route => {
    const response = await route.fetch();
    const answer = Schema.decodeUnknownSync(CodeGraphDiagramResultSchema)(await response.json());
    const {question} = Schema.decodeUnknownSync(Schema.Struct({question: Schema.String}))(
      route.request().postDataJSON(),
    );
    const result = {
      status: 'diagram',
      diagramType: 'architecture',
      scope: answer.scope,
      freshness: answer.freshness,
      limits: [],
      source: question === 'Small architecture' ? architectureSource(1) : largeSource,
      inferred: false,
      evidence: {nodes: [], edges: [], groups: []},
    } satisfies typeof CodeGraphDiagramResultSchema.Type;
    await route.fulfill({response, json: result});
  });
  await page.getByRole('button', {name: 'Refresh manager', exact: true}).click();
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Graph', exact: true})
    .click();
  await page.getByText('Ask for a code diagram', {exact: true}).click();
  await page.getByRole('combobox', {name: 'Diagram type'}).selectOption('architecture');
  const question = page.getByRole('textbox', {name: 'Question'});
  const generate = page.getByRole('button', {name: 'Generate diagram'});
  await question.fill('Small architecture');
  await generate.click();
  const result = page.getByRole('region', {name: 'Code diagram result'});
  await expect(result.frameLocator('iframe').locator('svg')).toBeVisible();
  await question.fill('Large architecture');
  await generate.click();
  await expect(result).toContainText('Unable to render this diagram');
  await expect(result.locator('iframe')).toHaveCount(0);
  expect(await result.locator('pre code').textContent()).toBe(largeSource);
  await result.getByRole('button', {name: 'Copy Mermaid code'}).click();
  await expect(result).toContainText('Mermaid code copied.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(largeSource);
});

test('S09 graph view removal uses an exact preview, cancellation preserves it and confirmation preserves source', async ({
  page,
  manager,
}) => {
  test.setTimeout(60_000);
  const repository = await createRepository(manager);
  await indexRepository(manager, repository);
  await page.getByRole('button', {name: 'Refresh manager', exact: true}).click();
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Graph', exact: true})
    .click();
  await page.getByRole('tab', {name: /^Indexes & administration/u}).click();
  const remove = page.getByRole('button', {name: /^Remove active worktree view /u});
  await expect(remove).toBeVisible();
  await remove.click();
  const dialog = page.getByRole('dialog', {name: 'Remove this indexed view?', exact: true});
  await expect(dialog).toContainText(/alpha|snapshot|view/iu);
  await dialog.getByRole('button', {name: 'Cancel', exact: true}).click();
  await expect(remove).toBeVisible();
  expect((await manager.api('/api/graphs')).repositories).toHaveLength(1);
  await remove.click();
  await dialog.getByRole('button', {name: 'Remove view', exact: true}).click();
  await expect(remove).toHaveCount(0);
  expect((await manager.api('/api/graphs')).repositories).toHaveLength(0);
  expect(await readFile(join(repository.root, 'src/entry.ts'), 'utf8')).toBe(repository.source);
});

const graphPairTest = test.extend({managerScenario: 'graph-pair'});

graphPairTest('S09 a delayed query from the old repository cannot replace the selected repository', async ({page}) => {
  test.setTimeout(60_000);
  const alpha = {symbol: 'alphaGreeting'};
  const beta = {symbol: 'betaGreeting'};
  await page.getByRole('button', {name: 'Refresh manager', exact: true}).click();
  await page
    .getByRole('navigation', {name: 'Manager sections'})
    .getByRole('button', {name: 'Graph', exact: true})
    .click();
  await page.getByRole('combobox', {name: 'Repository', exact: true}).selectOption({label: 'alpha'});
  let release = () => {};
  let admitted = () => {};
  let completed = () => {};
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const pending = new Promise<void>(resolve => {
    admitted = resolve;
  });
  const fulfilled = new Promise<void>(resolve => {
    completed = resolve;
  });
  await page.route('**/api/graph/query?*', async route => {
    const response = await route.fetch();
    if (new URL(route.request().url()).searchParams.get('query') === alpha.symbol) {
      admitted();
      await gate;
      try {
        await route.fulfill({response});
      } finally {
        completed();
      }
      return;
    }
    await route.fulfill({response});
  });
  try {
    await page.getByText('Search and relationship filters', {exact: true}).click();
    await page.getByRole('searchbox', {name: 'Query the code graph', exact: true}).fill(alpha.symbol);
    await page.getByRole('button', {name: 'Query graph', exact: true}).click();
    await pending;
    await page.getByRole('combobox', {name: 'Repository', exact: true}).selectOption({label: 'beta'});
    await expect(page.getByRole('searchbox', {name: 'Query the code graph', exact: true})).toHaveValue('');
    await page.getByRole('searchbox', {name: 'Query the code graph', exact: true}).fill(beta.symbol);
    const querying = page.waitForResponse(
      response =>
        new URL(response.url()).pathname === '/api/graph/query' &&
        new URL(response.url()).searchParams.get('query') === beta.symbol,
    );
    await page.getByRole('button', {name: 'Query graph', exact: true}).click();
    expect((await querying).ok()).toBe(true);
    await expect(page.getByRole('button', {name: 'Query graph', exact: true})).toBeEnabled();
    await page.getByText('Search and relationship filters', {exact: true}).click();
    await page.getByRole('searchbox', {name: 'Find in current view', exact: true}).fill(beta.symbol);
    const result = page.locator('.graph-search-results').getByRole('button').filter({hasText: beta.symbol});
    await expect(result).toBeVisible();
    await result.click();
    await expect(page.locator('.node-inspector h3')).toHaveText(beta.symbol);
    release();
    await fulfilled;
    await page.evaluate(
      () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    await expect(page.locator('.node-inspector h3')).toHaveText(beta.symbol);
    await expect(page.locator('.node-inspector')).not.toContainText(alpha.symbol);
  } finally {
    release();
  }
});
