import {Array as EffectArray} from 'effect';
import {isJsonObject} from '@threadnote/platform/json';
import {isDeepStrictEqual} from 'node:util';

/** Compare the complete canonical result and its compact MCP page, including nested provenance. */
export function checkMissingProfileTransportParity(cli: unknown, mcp: unknown): boolean {
  if (!(
    isJsonObject(cli) &&
    cli.version === 1 &&
    cli.status === 'unavailable' &&
    typeof cli.reason === 'string' &&
    cli.reason.length > 0 &&
    cli.evidence === null &&
    isJsonObject(mcp) &&
    mcp.isError !== true &&
    isDeepStrictEqual(cli, mcp.structuredContent) &&
    EffectArray.isArray(mcp.content) &&
    mcp.content.length === 1
  ))
    return false;
  const page = mcp.content[0];
  if (!isJsonObject(page) || page.type !== 'text' || typeof page.text !== 'string') return false;
  try {
    return isDeepStrictEqual(cli, JSON.parse(page.text));
  } catch {
    return false;
  }
}

/** Status samples the same proposal twice; checkedAt must advance inside the actual call window. */
export function checkProposalStatusTransportParity(cli: unknown, mcp: unknown, started: number, completed: number) {
  if (!isJsonObject(cli) || !isJsonObject(mcp)) return false;
  const {checkedAt: cliTime, ...cliBody} = cli;
  const {checkedAt: mcpTime, ...mcpBody} = mcp;
  return (
    typeof cliTime === 'number' &&
    Number.isSafeInteger(cliTime) &&
    typeof mcpTime === 'number' &&
    Number.isSafeInteger(mcpTime) &&
    started <= cliTime &&
    cliTime <= mcpTime &&
    mcpTime <= completed &&
    isDeepStrictEqual(cliBody, mcpBody)
  );
}
