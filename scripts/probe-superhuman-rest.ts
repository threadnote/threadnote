import {Redacted} from 'effect';
import {probeSuperhumanRestPage, RestProbeError} from '@threadnote/threadnote/superhuman/rest-probe';

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
  const summary = await probeSuperhumanRestPage(token, selectedUrl, {expectedDocumentId});
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} catch (error) {
  const code = error instanceof RestProbeError ? error.code : 'transport-rejected';
  process.stderr.write(`Superhuman Docs REST probe: ${code}\n`);
  process.exitCode = 1;
}
