/**
 * Steps for .github/workflows/native-typescript-construction.yml. Inputs come only from the builder recipe; the summary
 * is unreviewed construction evidence and never edits a reviewed host pin or marks an asset qualified.
 * GITHUB_OUTPUT and GITHUB_STEP_SUMMARY are per-step files, so each step writes its file once.
 */
import {Array as EffectArray, Option as EffectOption, Schema} from 'effect';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {hostToolchainArchive, typescriptNativeBuildRecipe} from '../semantic/build-typescript-native.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};
/** Forward slashes keep Windows paths intact through Git Bash, curl, tar and Bun alike. */
const portable = (path: string) => (process.platform === 'win32' ? EffectString.replaceAll('\\', '/')(path) : path);
const writeOutputs = (outputs: Readonly<Record<string, string>>) =>
  Bun.write(
    required('GITHUB_OUTPUT'),
    EffectArray.join(
      EffectArray.map(EffectRecord.toEntries(outputs), ([key, value]) => `${key}=${value}\n`),
      '',
    ),
  );

async function resolveInputs(): Promise<void> {
  const host = `${process.platform}-${process.arch}`;
  if (host !== required('EXPECTED_HOST'))
    throw new Error(`Runtime host ${host} differs from the matrix host ${required('EXPECTED_HOST')}.`);
  const archive = hostToolchainArchive();
  if (!archive) throw new Error(`No pinned Go archive for ${host}.`);
  const temp = portable(required('RUNNER_TEMP'));
  const {upstream} = typescriptNativeBuildRecipe;
  await writeOutputs({
    repository: upstream.repository,
    commit: upstream.commit,
    tree: upstream.tree,
    archive_url: archive.url,
    archive_size: String(archive.size),
    archive: `${temp}/go-archive/${archive.filename}`,
    source: `${temp}/tssrc`,
    private_root: `${temp}/ntc`,
    evidence: `${temp}/ntc-evidence`,
    extracted: `${temp}/ntc-extracted`,
    repository_root: portable(process.cwd()),
  });
}

const VerifiedAsset = Schema.Struct({
  assetDirectory: Schema.String,
  payloadDirectory: Schema.String,
  binarySha256: Schema.String,
});
const ConstructionReceipt = Schema.Struct({
  host: Schema.String,
  sourceCommit: Schema.String,
  goArchiveSha256: Schema.String,
  completedChecks: Schema.Array(Schema.String),
  binarySha256: Schema.String,
  binaryBytes: Schema.Int,
});
const ExecutableDigest = Schema.Struct({binarySha256: Schema.String});
const readJson = async (path: string): Promise<unknown> => JSON.parse(await Bun.file(path).text());
const evidencePath = (name: string) => `${portable(required('EVIDENCE'))}/${name}`;

async function locateOutput(): Promise<void> {
  const {assetDirectory, payloadDirectory} = Schema.decodeUnknownSync(VerifiedAsset)(
    await readJson(evidencePath('prepare.json')),
  );
  const payload = portable(payloadDirectory);
  if (!EffectString.endsWith('/payload')(payload)) throw new Error('Prepared output has no payload directory.');
  await writeOutputs({
    payload,
    prepared: portable(assetDirectory),
    construction: EffectString.slice(0, -'/payload'.length)(payload),
  });
}

async function summarize(): Promise<void> {
  const prepared = Schema.decodeUnknownSync(VerifiedAsset)(await readJson(evidencePath('prepare.json')));
  const digests = new Set<string>();
  for (const name of ['prepare.json', 'verify-construction.json', 'verify-prepared.json', 'verify-extracted.json'])
    digests.add(Schema.decodeUnknownSync(ExecutableDigest)(await readJson(evidencePath(name))).binarySha256);
  if (digests.size !== 1)
    throw new Error('Construction, prepared and extracted verification disagree on the executable.');
  const receiptBytes = await Bun.file(`${portable(prepared.payloadDirectory)}/construction-receipt.json`).bytes();
  const receipt = Schema.decodeUnknownSync(ConstructionReceipt)(JSON.parse(new TextDecoder().decode(receiptBytes)));
  const commit = required('THREADNOTE_COMMIT');
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('THREADNOTE_COMMIT is not a full commit SHA.');
  const pin = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      typescriptNativeBuildRecipe.runtimeAsset.reviewedHostBinaries,
      item => item.host === receipt.host,
    ),
  );
  const summary = {
    kind: 'threadnote-native-typescript-construction-ci-summary-v1',
    evidence: 'unreviewed construction evidence; not a reviewed host pin',
    host: receipt.host,
    runner: required('MATRIX_RUNNER'),
    imageOS: process.env.ImageOS ?? null,
    imageVersion: process.env.ImageVersion ?? null,
    bun: Bun.version,
    threadnoteCommit: commit,
    upstreamCommit: receipt.sourceCommit,
    goArchiveSha256: receipt.goArchiveSha256,
    completedChecks: receipt.completedChecks,
    executableSha256: receipt.binarySha256,
    executableBytes: receipt.binaryBytes,
    receiptSha256: sha256HexSync(receiptBytes),
    archiveSha256: sha256HexSync(await Bun.file(evidencePath('native-typescript-construction.tar')).bytes()),
    reviewedPin: pin === undefined ? 'absent' : pin.sha256 === receipt.binarySha256 ? 'matches' : 'differs',
  };
  const text = `${JSON.stringify(summary, null, 2)}\n`;
  await Bun.write(evidencePath('summary.json'), text);
  await Bun.write(
    required('GITHUB_STEP_SUMMARY'),
    `### Native TypeScript construction · ${receipt.host}\n\nUnreviewed construction evidence, not a reviewed pin.\n\n\`\`\`json\n${text}\`\`\`\n`,
  );
}

if (import.meta.main) {
  const steps = new Map([
    ['inputs', resolveInputs],
    ['locate', locateOutput],
    ['summarize', summarize],
  ]);
  const step = steps.get(process.argv[2] ?? '');
  if (!step) throw new Error('Usage: bun tools/ci/native-typescript-construction.ts inputs|locate|summarize');
  await step();
}
