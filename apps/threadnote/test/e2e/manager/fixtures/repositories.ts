import {Array as Arr, String as Str} from 'effect';
import {mkdir, writeFile} from '@threadnote/testing/node-fs-promises';
import {spawnSync} from '@threadnote/testing/node-child-process';
import {join} from '@threadnote/testing/node-path';
import {findExecutable} from './environment.js';
import type {ManagerRuntime} from './runtime.js';

export const largeDiagramStages = Arr.makeBy(400, index => `authenticationStage${index}${Str.repeat(18)('Evidence')}`);

export async function createRepository(
  manager: ManagerRuntime,
  name = 'alpha',
  register = true,
  diagramFixture?: 'oversized' | 'viewer',
) {
  const root = join(manager.root, name);
  const symbol = `${name}Greeting`;
  const source = `import {normalize} from './words.js';\n/** A synthetic ${name} greeting contract. */\nexport function ${symbol}(name: string): string { return normalize(name); }\n`;
  await mkdir(join(root, 'src'), {recursive: true});
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({name: `fixture-${name}`, version: '1.0.0', type: 'module'}),
  );
  await writeFile(join(root, 'src/entry.ts'), source);
  await writeFile(
    join(root, 'src/words.ts'),
    'export function normalize(value: string): string { return value.trim(); }\n',
  );
  await writeFile(
    join(root, 'src/auth.ts'),
    Arr.join(
      [
        "import {loadSession} from './sessions.js';",
        'export function authenticateRequest(token: string): boolean { return loadSession(token); }',
      ],
      '\n',
    ),
  );
  await writeFile(
    join(root, 'src/sessions.ts'),
    Arr.join(
      [
        "import {verifySignature} from './signature.js';",
        'export function loadSession(token: string): boolean { return verifySignature(token); }',
      ],
      '\n',
    ),
  );
  await writeFile(
    join(root, 'src/signature.ts'),
    'export function verifySignature(token: string): boolean { return token.length > 3; }\n',
  );
  await writeFile(
    join(root, 'src/auth-distractor.ts'),
    'export function authenticateRequestDocumentation(): string { return "authentication documentation"; }\n',
  );
  if (diagramFixture === 'oversized') {
    await writeFile(
      join(root, 'src/large-auth.ts'),
      Arr.join(
        [
          'export function runLargeAuthenticationWorkflow(): void {',
          ...Arr.map(largeDiagramStages, stage => `  ${stage}();`),
          '}',
          ...Arr.map(largeDiagramStages, stage => `function ${stage}(): void {}`),
        ],
        '\n',
      ),
    );
  }
  if (diagramFixture === 'viewer') {
    const farStages = Arr.makeBy(360, index => `viewerFarStage${index}${Str.repeat(8)('WideLabel')}`);
    const viewerStages = Arr.makeBy(14, index => `viewerStage${index}`);
    await writeFile(
      join(root, 'src/viewer.ts'),
      Arr.join(
        [
          'export function runViewerWorkflow(): void {',
          '  viewerStage0();',
          ...Arr.map(farStages, stage => `  ${stage}();`),
          '}',
          ...Arr.map(farStages, stage => `function ${stage}(): void {}`),
          ...Arr.map(viewerStages, (stage, index) => {
            const next = viewerStages[index + 1];
            return `function ${stage}(): void { ${next ? `${next}();` : ''} }`;
          }),
        ],
        '\n',
      ),
    );
  }
  await writeFile(join(root, 'README.md'), `# ${name}\n\nSynthetic Manager E2E repository.\n`);
  for (const args of [
    ['init', '--initial-branch=main'],
    ['add', '.'],
    ['commit', '-m', 'Synthetic fixture'],
  ]) {
    const result = spawnSync(findExecutable('git'), args, {cwd: root, env: manager.environment, encoding: 'utf8'});
    if (result.status !== 0) throw new Error(`Fixture git failed: ${result.stderr}`);
  }
  if (register) await manager.cli(['project', 'create', name, '--path', root, '--seed', 'README.md']);
  return {root, name, symbol, source};
}

export async function indexRepository(
  manager: ManagerRuntime,
  repository: Awaited<ReturnType<typeof createRepository>>,
) {
  return manager.cli(
    ['graph', 'index', '--cwd', repository.root, '--project', repository.name, '--no-vectors'],
    undefined,
    60_000,
  );
}

export async function rememberCited(manager: ManagerRuntime, repository: Awaited<ReturnType<typeof createRepository>>) {
  const output = await manager.cli(
    [
      'remember',
      '--kind',
      'durable',
      '--project',
      repository.name,
      '--topic',
      'greeting-contract',
      '--code-ref',
      'src/entry.ts',
      '--require-current-code-refs',
      '--text',
      `Keep the ${repository.symbol} greeting contract stable.`,
    ],
    undefined,
    30_000,
    repository.root,
  );
  const uri = /Stored memory: (threadnote:\/\/\S+)/u.exec(output)?.[1];
  if (!uri) throw new Error('Fixture citation write did not return a canonical URI.');
  return uri;
}
