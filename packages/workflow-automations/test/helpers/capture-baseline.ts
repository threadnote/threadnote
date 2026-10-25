#!/usr/bin/env bun
/** Test-only reproducible source and workflow baseline capture. */
import {spawnSync} from '@threadnote/testing/node-child-process';
import {createHash} from '@threadnote/testing/node-crypto';
import {chmod, readFile, writeFile} from '@threadnote/testing/node-fs-promises';
import {isAbsolute, join, resolve} from '@threadnote/testing/node-path';
import {fileURLToPath} from '@threadnote/testing/node-url';
import {workflowScenarios, workflowScenarioCatalogVersion} from '../../src/scenarios.js';

type Json = Record<string, unknown>;
const captureFormatVersion = 2;
const utf8Bytes = (value: string) => Buffer.byteLength(value, 'utf8');

function gitHead(repo: string): string {
  const result = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {encoding: 'utf8', timeout: 2_000});
  if (result.status !== 0 || !result.stdout.trim()) throw new Error('Unable to identify source revision');
  return result.stdout.trim();
}

async function runtimeBaseline(executable: string): Promise<Json> {
  if (!isAbsolute(executable)) throw new Error('--runtime must be an absolute executable path');
  let version: string | null = null;
  const timingsMilliseconds: number[] = [];
  let successfulSamples = 0;
  for (let index = 0; index < 3; index++) {
    const started = performance.now();
    const result = spawnSync(executable, ['--version'], {encoding: 'utf8', timeout: 2_000, maxBuffer: 4_096});
    timingsMilliseconds.push(Number((performance.now() - started).toFixed(3)));
    if (result.status === 0) {
      successfulSamples++;
      if (version === null) version = result.stdout.trim().split(/\r?\n/, 1)[0]?.slice(0, 120) ?? '';
    }
  }
  const bytes = await readFile(executable);
  const binaryMagic = isExecutableBinary(bytes);
  const versionAvailable = successfulSamples > 0;
  return {
    sourceIdentity: {
      executableSha256: createHash('sha256').update(bytes).digest('hex'),
      path: 'withheld',
      method: 'hash of caller-supplied executable bytes',
    },
    version: versionAvailable ? version : null,
    versionStatus: versionAvailable ? 'available' : 'unavailable',
    startup: {
      argument: '--version',
      samples: 3,
      successfulSamples,
      durationsMilliseconds: timingsMilliseconds,
      method: 'wall-clock process startup; each sample bounded to 2000ms',
    },
    fileSize: {
      bytes: bytes.byteLength,
      label: binaryMagic ? 'executable-binary-bytes' : 'launcher-file-bytes',
      method: 'filesystem byte length; binary identified by recognized ELF, Mach-O, or PE magic',
    },
  };
}

function isExecutableBinary(bytes: Uint8Array): boolean {
  const b = bytes;
  const elf = b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46;
  const pe = b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a;
  const macho =
    b.length >= 4 &&
    [
      [0xfe, 0xed, 0xfa, 0xce],
      [0xce, 0xfa, 0xed, 0xfe],
      [0xfe, 0xed, 0xfa, 0xcf],
      [0xcf, 0xfa, 0xed, 0xfe],
      [0xca, 0xfe, 0xba, 0xbe],
    ].some(magic => magic.every((byte, i) => b[i] === byte));
  return elf || pe || macho;
}

export interface CaptureBaselineOptions {
  readonly repo: string;
  readonly runtime?: string;
}

export async function captureBaseline({repo: repoArg, runtime}: CaptureBaselineOptions): Promise<Json> {
  const repo = resolve(repoArg);
  const head = gitHead(repo);
  const manifest = JSON.parse(await readFile(join(repo, 'config/dev-skills.json'), 'utf8')) as {
    schemaVersion: number;
    nativeRequirements: Record<string, number>;
    workflowProtocol: number;
    stateSchema: number;
    skills: {id: string; files: string[]}[];
  };
  const sourceIdentity = {
    captureFormatVersion,
    repositoryHead: head,
    manifestSchemaVersion: manifest.schemaVersion,
    nativeRequirements: manifest.nativeRequirements,
    workflowProtocol: manifest.workflowProtocol,
    stateSchema: manifest.stateSchema,
    scenarioCatalogVersion: workflowScenarioCatalogVersion,
  };
  const skillFiles = manifest.skills
    .flatMap(skill =>
      skill.files
        .filter(file => file === 'SKILL.md' || (file.startsWith('references/') && file.endsWith('.md')))
        .map(file => `config/agent-skills/${skill.id}/${file}`),
    )
    .sort();
  const skillDocuments = await Promise.all(
    skillFiles.map(async path => {
      const content = await readFile(join(repo, path), 'utf8');
      return {path, bytes: utf8Bytes(content), method: 'UTF-8 encoded file content byte length'};
    }),
  );
  const scenarioRecords = workflowScenarios.map(item => ({
    id: item.id,
    category: item.category,
    expectedInvariants: [...item.expectedInvariants],
    measurementUnits: [...item.measurements],
  }));
  const result: Json = {
    schemaVersion: captureFormatVersion,
    source: sourceIdentity,
    capturedAt: new Date().toISOString(),
    sourceMeasurements: {
      skillDocuments: {
        sourceIdentity,
        method: 'manifest-declared SKILL.md and references/*.md files; UTF-8 bytes; sorted by relative path',
        files: skillDocuments,
        totalBytes: skillDocuments.reduce((sum, file) => sum + file.bytes, 0),
      },
      scenarios: {
        sourceIdentity,
        method:
          'frozen scenario catalog; records expected invariants and declared measurement names as units, not measured outcomes',
        count: scenarioRecords.length,
        cases: scenarioRecords,
      },
    },
    frozenCorpus: {
      recipeVersion: 1,
      selection:
        'Use the fixed scenario IDs below from the versioned scenario catalog; preserve task prompt, source revision, and policy conditions for every rerun.',
      taskFamilies: [
        {
          kind: 'routine',
          scenarioIds: ['autonomy-mechanical-edit', 'autonomy-bounded-edit', 'challenger-routine-skip'],
          acceptance: [
            'stay within declared scope',
            'record required acceptance evidence',
            'skip design challenge when no material uncertainty exists',
          ],
        },
        {
          kind: 'risk-bearing',
          scenarioIds: [
            'autonomy-high-risk',
            'challenger-out-of-scope-rejected',
            'challenger-design-change-invalidates-review',
            'context-stale-readiness',
          ],
          acceptance: [
            'preserve autonomous authority for authorized work',
            'apply justified capacity and quality gates',
            'reject unauthorized scope expansion',
            'invalidate stale review and readiness evidence',
          ],
        },
      ],
      policyEvaluationControls: [
        'hold prompt and source revision fixed across policy conditions',
        'compare the same acceptance criteria and evidence inputs',
        'record model and reasoning effort only when supplied by an actual run',
        'separate infrastructure failures from task-quality outcomes',
        'do not infer quality success from a completed capture',
      ],
    },
    unavailableMetrics: {
      tokenCounts: 'unavailable',
      pricing: 'unavailable',
      actualModelUsage: 'unavailable',
      qualityClaims: 'unavailable',
      reason:
        'This source baseline helper does not observe model billing, token telemetry, or evaluated task outcomes.',
    },
    // Session observations require actual run evidence; never invent one for a new capture.
    observations: [],
    runtime: runtime
      ? await runtimeBaseline(runtime)
      : {
          status: 'not-requested',
          sourceIdentity,
          method: 'runtime capture requires an explicit --runtime absolute executable path',
        },
  };
  return result;
}

async function main(argv: string[]) {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (!['--repo', '--out', '--runtime'].includes(name)) throw new Error('Unsupported argument');
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    args.set(name, value);
  }
  const repo = args.get('--repo');
  const out = args.get('--out');
  if (!repo || !out)
    throw new Error(
      'Usage: bun capture-baseline.ts --repo <root> --out <private-file> [--runtime <absolute-executable>]',
    );
  const baseline = await captureBaseline({repo, runtime: args.get('--runtime')});
  const output = resolve(out);
  await writeFile(output, `${JSON.stringify(baseline, null, 2)}\n`, {mode: 0o600});
  await chmod(output, 0o600);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write('baseline capture failed\n');
    process.exitCode = 1;
  });
}
