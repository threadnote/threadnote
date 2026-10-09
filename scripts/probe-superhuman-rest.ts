import {Effect, Layer, Redacted} from 'effect';
import {admittedSourceFetch} from '@threadnote/integration-core/source-coordinator';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {getRuntimeConfig} from '@threadnote/threadnote/runtime';
import {runtimeEntrypointLayer} from '@threadnote/threadnote/effect/runtime-entrypoint';
import {telemetryChildEnvironmentPolicyLayer} from '@threadnote/threadnote/telemetry/session';
import {probeSuperhumanRestPage, RestProbeError} from '@threadnote/integration-superhuman/rest-probe';

const tokenFile = process.env.SUPERHUMAN_DOCS_TOKEN_FILE;
const selectedUrl = process.env.SUPERHUMAN_DOCS_SELECTED_URL;
const expectedDocumentId = process.env.SUPERHUMAN_DOCS_SELECTED_DOC_ID;

try {
  if (!tokenFile || !selectedUrl || !tokenFile.startsWith('/')) throw new RestProbeError({code: 'missing-input'});
  const file = Bun.file(tokenFile);
  const info = await file.stat();
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 4_096)
    throw new RestProbeError({code: 'missing-input'});
  const token = Redacted.make((await file.text()).trim());
  const summary = await Effect.runPromise(
    Effect.gen(function* () {
      const config = yield* getRuntimeConfig();
      const fetch = yield* admittedSourceFetch('superhuman', token, undefined, config);
      return yield* Effect.tryPromise(() => probeSuperhumanRestPage(token, selectedUrl, {expectedDocumentId, fetch}));
    }).pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This script is the application entry point.
      Effect.provide(
        ApplicationLayer.pipe(Layer.provide(Layer.merge(runtimeEntrypointLayer, telemetryChildEnvironmentPolicyLayer))),
      ),
    ),
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} catch (error) {
  const code = error instanceof RestProbeError ? error.code : 'transport-rejected';
  process.stderr.write(`Superhuman Docs REST probe: ${code}\n`);
  process.exitCode = 1;
}
