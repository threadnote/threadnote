import * as MigrationSchema from 'effect/Schema';
import {Redacted} from 'effect';
import {summarizeContractObservation} from '@threadnote/integration-superhuman/contract-probe';
import {probeSelectedPageContractRaw, ProbeError} from '@threadnote/integration-superhuman/probe';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const selectedUrl = process.env.SUPERHUMAN_DOCS_SELECTED_URL;
const tokenFile = process.env.SUPERHUMAN_DOCS_TOKEN_FILE;
const stage = process.env.SUPERHUMAN_DOCS_PROBE_STAGE === 'primary' ? 'primary' : 'identity';
if (!selectedUrl || !tokenFile) {
  process.stderr.write('Superhuman Docs contract probe: missing-input\n');
  process.exit(1);
}
try {
  const token = Redacted.make(Effect.pipe(await Bun.file(tokenFile).text(), EffectString.trim));
  const expectedDocumentId = process.env.SUPERHUMAN_DOCS_SELECTED_DOC_ID;
  const result = await probeSelectedPageContractRaw(token, selectedUrl, stage, {
    ...(expectedDocumentId === undefined ? {} : {expectedDocumentId}),
  });
  process.stdout.write(`${JSON.stringify(summarizeContractObservation(stage, result), null, 2)}\n`);
} catch (error) {
  const code = MigrationSchema.is(ProbeError)(error) ? error.code : 'transport-rejected';
  const operation = MigrationSchema.is(ProbeError)(error) ? error.operation : undefined;
  process.stderr.write(`Superhuman Docs contract probe: ${code}${operation ? ` (${operation})` : ''}\n`);
  process.exitCode = 1;
}
