import {Array as EffectArray, Schema} from 'effect';

const Step = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  started_at: Schema.NullOr(Schema.String),
  completed_at: Schema.NullOr(Schema.String),
});
const Job = Schema.Struct({
  id: Schema.Int,
  run_id: Schema.Int,
  run_attempt: Schema.Int,
  head_sha: Schema.String,
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  started_at: Schema.NullOr(Schema.String),
  completed_at: Schema.NullOr(Schema.String),
  steps: Schema.optionalKey(Schema.Array(Step)),
});
const Artifact = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  expired: Schema.Boolean,
  created_at: Schema.String,
  expires_at: Schema.String,
  digest: Schema.NullOr(Schema.String),
  workflow_run: Schema.Struct({
    id: Schema.Int,
    repository_id: Schema.Int,
    head_repository_id: Schema.Int,
    head_sha: Schema.String,
  }),
});
export interface WindowsReplicaBinding {
  readonly repository: string;
  readonly repositoryId: number;
  readonly runId: number;
  readonly consumerAttempt: number;
  readonly headSha: string;
}
export const WINDOWS_REPLICA_UPLOAD_STEP = 'Upload fixed native graph replica';
const LEGACY_UPLOAD_STEP = 'Run actions/upload-artifact@v7';

function validateBinding(binding: WindowsReplicaBinding): void {
  if (
    !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/u.test(binding.repository) ||
    !/^[a-f0-9]{40}$/u.test(binding.headSha) ||
    !EffectArray.every(
      [binding.runId, binding.repositoryId, binding.consumerAttempt],
      x => Number.isSafeInteger(x) && x > 0,
    )
  )
    throw new Error('Invalid Windows replica run binding');
}
function timestamp(value: string | null): number {
  const parsed = value !== null && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed)) throw new Error('Missing or invalid replica execution timestamp');
  return parsed;
}

/** Attempt views project reused jobs with new IDs/attempts but their original execution times. */
export function selectWindowsReplicaArtifacts(
  binding: WindowsReplicaBinding,
  jobsValue: unknown,
  artifactsValue: unknown,
  now = Date.now(),
) {
  validateBinding(binding);
  const jobs = Schema.decodeUnknownSync(Schema.Array(Job))(jobsValue);
  const artifacts = Schema.decodeUnknownSync(Schema.Array(Artifact))(artifactsValue);
  const selected = EffectArray.map([1, 2, 3], replica => {
    const producers = EffectArray.filter(
      jobs,
      job => job.name === `Code graph Windows replica ${replica} · windows-latest`,
    );
    const job = producers[0];
    if (
      producers.length !== 1 ||
      !job ||
      job.status !== 'completed' ||
      job.conclusion !== 'success' ||
      job.run_id !== binding.runId ||
      job.run_attempt !== binding.consumerAttempt ||
      job.head_sha !== binding.headSha ||
      job.id <= 0
    )
      throw new Error(`Replica ${replica} lacks one successful bound producer`);
    const uploads = EffectArray.filter(
      job.steps ?? [],
      step => step.name === WINDOWS_REPLICA_UPLOAD_STEP || step.name === LEGACY_UPLOAD_STEP,
    );
    const upload = uploads[0];
    if (uploads.length !== 1 || !upload || upload.status !== 'completed' || upload.conclusion !== 'success')
      throw new Error(`Replica ${replica} lacks one successful upload`);
    const start = timestamp(upload.started_at),
      end = timestamp(upload.completed_at);
    if (start > end || start < timestamp(job.started_at) || end > timestamp(job.completed_at))
      throw new Error(`Replica ${replica} upload is outside its execution`);
    const name = new RegExp(
      `^code-graph-benchmarks-Windows-X64-replica-${replica}-${binding.runId}-([1-9][0-9]*)$`,
      'u',
    );
    const matches = EffectArray.filter(artifacts, artifact => {
      const match = name.exec(artifact.name);
      if (!match) return false;
      const attempt = Number(match[1]);
      const run = artifact.workflow_run;
      return (
        Number.isSafeInteger(attempt) &&
        attempt <= binding.consumerAttempt &&
        !artifact.expired &&
        run.id === binding.runId &&
        run.repository_id === binding.repositoryId &&
        run.head_repository_id === binding.repositoryId &&
        run.head_sha === binding.headSha &&
        timestamp(artifact.created_at) >= start &&
        timestamp(artifact.created_at) <= end &&
        timestamp(artifact.created_at) <= now &&
        timestamp(artifact.expires_at) > now
      );
    });
    const artifact = matches[0];
    if (
      matches.length !== 1 ||
      !artifact ||
      artifact.id <= 0 ||
      !artifact.digest ||
      !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest)
    )
      throw new Error(`Replica ${replica} lacks one unexpired execution-bound artifact with SHA-256`);
    return {
      replica,
      viewJobId: job.id,
      consumerAttempt: binding.consumerAttempt,
      artifactId: artifact.id,
      artifactAttempt: Number(name.exec(artifact.name)?.[1]),
      artifactName: artifact.name,
      digest: artifact.digest,
      uploadStartedAt: upload.started_at,
      uploadCompletedAt: upload.completed_at,
      artifactCreatedAt: artifact.created_at,
    };
  });
  if (new Set(EffectArray.map(selected, x => x.artifactId)).size !== 3)
    throw new Error('Replica artifact IDs are duplicated');
  return {
    version: 1,
    ...binding,
    selected,
    artifactIds: EffectArray.join(
      EffectArray.map(selected, x => String(x.artifactId)),
      ',',
    ),
  };
}

const MAX_PAGES = 20;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const defaults = {
  fetch: (url: string, options: RequestInit) => fetch(url, options),
  sleep: (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)),
};

/** Read-only GitHub boundary; bounded transport retries never retry a benchmark measurement. */
export async function fetchWindowsReplicaSelection(
  binding: WindowsReplicaBinding,
  token: string,
  dependencies: Partial<typeof defaults> = {},
) {
  validateBinding(binding);
  if (!token) throw new Error('A GitHub Actions read token is required');
  const options = {...defaults, ...dependencies};
  async function page(endpoint: string): Promise<unknown> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await options.fetch(`https://api.github.com/repos/${binding.repository}/${endpoint}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2026-03-10',
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status >= 500 && attempt < 2) {
        await response.body?.cancel();
        await options.sleep(250 * (attempt + 1));
        continue;
      }
      if (!response.ok) throw new Error(`Windows replica metadata request failed: HTTP ${response.status}`);
      if (!response.body) throw new Error('Windows replica metadata response has no body');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new Error('Windows replica metadata exceeds response bound');
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      return JSON.parse(Buffer.concat(chunks, length).toString('utf8')) as unknown;
    }
    throw new Error('Windows replica metadata retries exhausted');
  }
  async function all(endpoint: string, field: 'jobs' | 'artifacts'): Promise<readonly unknown[]> {
    const values: unknown[] = [];
    for (let number = 1; number <= MAX_PAGES; number++) {
      const result = Schema.decodeUnknownSync(
        Schema.Struct({total_count: Schema.Int, [field]: Schema.Array(Schema.Unknown)}),
      )(await page(`${endpoint}?per_page=100&page=${number}`));
      const items = result[field];
      if (!EffectArray.isArray(items)) throw new Error('Invalid Windows replica metadata page');
      values.push(...items);
      if (values.length === result.total_count) return values;
      if (items.length !== 100 || values.length > result.total_count)
        throw new Error('Incomplete Windows replica metadata pagination');
    }
    throw new Error('Windows replica metadata exceeds page bound');
  }
  const jobs = await all(`actions/runs/${binding.runId}/attempts/${binding.consumerAttempt}/jobs`, 'jobs');
  const artifacts = await all(`actions/runs/${binding.runId}/artifacts`, 'artifacts');
  return selectWindowsReplicaArtifacts(binding, jobs, artifacts);
}

if (import.meta.main) {
  try {
    const selection = await fetchWindowsReplicaSelection(
      {
        repository: process.env.GITHUB_REPOSITORY ?? '',
        repositoryId: Number(process.env.GITHUB_REPOSITORY_ID),
        runId: Number(process.env.GITHUB_RUN_ID),
        consumerAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
        headSha: process.env.GITHUB_SHA ?? '',
      },
      process.env.GH_TOKEN ?? '',
    );
    const output = process.env.GITHUB_OUTPUT;
    if (!output) throw new Error('GITHUB_OUTPUT is required');
    await Bun.write('artifacts/windows-replica-selection.json', `${JSON.stringify(selection, null, 2)}\n`);
    const file = Bun.file(output);
    await Bun.write(output, `${await file.text()}artifact-ids=${selection.artifactIds}\n`);
  } catch (error) {
    await Bun.write(Bun.stderr, `Windows replica selection failed: ${String(error)}\n`);
    process.exitCode = 1;
  }
}
