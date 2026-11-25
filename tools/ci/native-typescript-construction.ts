/**
 * Steps for .github/workflows/native-typescript-construction.yml and the .github/actions/native-typescript-asset
 * provisioning action. Inputs come only from the builder recipe and the reviewed asset pins; the construction summary
 * is unreviewed evidence and never edits a reviewed host pin or marks an asset qualified.
 * GITHUB_OUTPUT and GITHUB_STEP_SUMMARY are per-step files, so each step writes its file once.
 */
import {mkdir, rename, stat} from 'node:fs/promises';
import {Array as EffectArray, Option as EffectOption, Schema} from 'effect';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {hostToolchainArchive, typescriptNativeBuildRecipe} from '../semantic/build-typescript-native.js';
import {
  nativeTypeScriptAssetPins,
  nativeTypeScriptHostKey,
  nativeTypeScriptReviewedBinarySha256,
} from '@threadnote/graph/typescript_native_asset_pins';

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

/** Construction inputs for the current host, shared by the construction workflow and asset provisioning. */
function constructionInputs(): Readonly<Record<string, string>> {
  const host = nativeTypeScriptHostKey(process.platform, process.arch);
  const archive = hostToolchainArchive();
  if (!archive) throw new Error(`No pinned Go archive for ${host}.`);
  const temp = portable(required('RUNNER_TEMP'));
  const {upstream} = typescriptNativeBuildRecipe;
  return {
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
  };
}

async function resolveInputs(): Promise<void> {
  const host = nativeTypeScriptHostKey(process.platform, process.arch);
  if (host !== required('EXPECTED_HOST'))
    throw new Error(`Runtime host ${host} differs from the matrix host ${required('EXPECTED_HOST')}.`);
  await writeOutputs(constructionInputs());
}

/**
 * Every input that determines the prepared bytes: the recipe, the builder source, its ordered overlays, this host's
 * pinned Go archive, the host and the reviewed pins. A change to any of them is a new cache entry.
 */
export async function nativeTypeScriptAssetCacheKey(host: string, root = process.cwd()): Promise<string> {
  const overlays: [string, string][] = [];
  for (const name of [...new Bun.Glob('tools/semantic/typescript-native-*.patch').scanSync({cwd: root})].sort())
    overlays.push([name, sha256HexSync(await Bun.file(`${root}/${name}`).bytes())]);
  const digest = sha256HexSync(
    JSON.stringify({
      kind: 'threadnote-native-typescript-asset-cache-v1',
      host,
      recipe: typescriptNativeBuildRecipe,
      builder: sha256HexSync(await Bun.file(`${root}/tools/semantic/build-typescript-native.ts`).bytes()),
      overlays,
      goArchive: hostToolchainArchive() ?? null,
      pins: nativeTypeScriptAssetPins,
    }),
  );
  return `threadnote-native-typescript-${host}-${digest}`;
}

/**
 * A fixed per-host location under the runner temp directory, so the exported path (and the Bazel test action keys that
 * inherit it) is identical on every runner of that image.
 */
const assetRoot = (host: string) => `${portable(required('RUNNER_TEMP'))}/threadnote-native-typescript/${host}`;

async function provisionInputs(): Promise<void> {
  const host = nativeTypeScriptHostKey(process.platform, process.arch);
  // Windows and every host without a reviewed binary pin provision nothing; native tests there skip visibly.
  if (process.platform === 'win32' || nativeTypeScriptReviewedBinarySha256(host) === undefined) {
    await writeOutputs({enabled: 'false', host});
    return;
  }
  const root = assetRoot(host);
  await writeOutputs({
    ...constructionInputs(),
    enabled: 'true',
    host,
    cache_key: await nativeTypeScriptAssetCacheKey(host),
    asset_root: root,
    payload: `${root}/payload`,
    prepared: `${root}/prepared`,
  });
}

/** Move a fresh construction's payload and prepared asset, as siblings, into the fixed per-host location. */
async function provisionInstall(): Promise<void> {
  const {assetDirectory, payloadDirectory} = Schema.decodeUnknownSync(VerifiedAsset)(
    await readJson(evidencePath('prepare.json')),
  );
  const root = portable(required('ASSET_ROOT'));
  if (
    await stat(root).then(
      () => true,
      () => false,
    )
  )
    throw new Error('Native TypeScript asset root must be fresh.');
  await mkdir(root, {recursive: true, mode: 0o700});
  await rename(portable(payloadDirectory), `${root}/payload`);
  await rename(portable(assetDirectory), `${root}/prepared`);
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
  const multiplier = process.env.THREADNOTE_TYPESCRIPT_NATIVE_DEADLINE_MULTIPLIER;
  if (multiplier !== undefined && !/^[1-4]$/u.test(multiplier))
    throw new Error('THREADNOTE_TYPESCRIPT_NATIVE_DEADLINE_MULTIPLIER must be an integer from 1 to 4.');
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
    deadlineMultiplier: multiplier === undefined ? 1 : Number(multiplier),
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
    ['provision-inputs', provisionInputs],
    ['provision-install', provisionInstall],
  ]);
  const step = steps.get(process.argv[2] ?? '');
  if (!step)
    throw new Error(
      'Usage: bun tools/ci/native-typescript-construction.ts inputs|locate|summarize|provision-inputs|provision-install',
    );
  await step();
}
