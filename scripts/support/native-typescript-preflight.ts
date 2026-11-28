import {Array as EffectArray} from 'effect';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {
  NATIVE_TYPESCRIPT_PREPARED_ASSET_ENV,
  nativeTypeScriptHostKey,
  nativeTypeScriptReviewedBinarySha256,
} from '@threadnote/graph/typescript_native_asset_pins';

/**
 * Up-front check for an evaluation or benchmark that indexes TypeScript through the native TypeScript asset.
 * On a reviewed-pin host a missing asset is a setup failure, never a measured quality or performance regression.
 * On a host without a reviewed pin (Windows today) TypeScript files extract as degraded metadata; that is reported
 * visibly and the run continues. Full byte verification still happens when the first native session starts.
 */
export function requireNativeTypeScriptAsset(purpose: string): 'available' | 'unsupported-host' | 'not-indexing' {
  // Help and argument errors index nothing, so they never depend on the asset.
  if (EffectArray.some(process.argv.slice(2), argument => argument === '--help' || argument === '-h'))
    return 'not-indexing';
  const host = nativeTypeScriptHostKey(process.platform, process.arch);
  if (nativeTypeScriptReviewedBinarySha256(host) === undefined) {
    process.stderr.write(
      `${purpose}: native TypeScript is unavailable on ${host} (no reviewed pin); TypeScript files extract as degraded metadata.\n`,
    );
    return 'unsupported-host';
  }
  const prepared = process.env[NATIVE_TYPESCRIPT_PREPARED_ASSET_ENV];
  if (!prepared || !existsSync(join(prepared, 'manifest.json')) || !existsSync(join(prepared, 'tsc')))
    throw new Error(
      `native TypeScript asset missing: ${purpose} indexes TypeScript fixtures on ${host}, which has a reviewed pin. ` +
        `Set ${NATIVE_TYPESCRIPT_PREPARED_ASSET_ENV} to a prepared asset directory (see "Native TypeScript 7.1 source asset" in docs/releasing.md).`,
    );
  return 'available';
}
