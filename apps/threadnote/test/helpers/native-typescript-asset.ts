import {Effect, Schema} from 'effect';
import {verifyNativeTypeScriptAsset} from '@threadnote/graph/typescript_runtime';
import {nativeTypeScriptTestAssetDirectory} from '@threadnote/graph/test/helpers/native-typescript-session';
import {NativeTypeScriptHostCandidate} from '../../src/semantic/host_catalog.js';
import {verifyNativeTypeScriptCandidate} from '../../src/semantic/providers/typescript_runtime.js';

export {
  native,
  nativeTypeScriptSkipReason,
  nativeTypeScriptUnavailable,
  reportNativeTypeScriptSkip,
} from '@threadnote/graph/test/helpers/native-typescript-session';

/** Consume the one host-prepared asset through the runtime verifier; tests never build or select a fallback SDK. */
export const nativeTypeScriptTestCandidate = Effect.fn('test.nativeTypeScriptCandidate')(function* () {
  const asset = yield* Effect.tryPromise(() => verifyNativeTypeScriptAsset(nativeTypeScriptTestAssetDirectory()));
  const candidate = yield* Schema.decodeEffect(NativeTypeScriptHostCandidate, {onExcessProperty: 'error'})({
    executable: asset.compilerPath,
    executableDigest: asset.pinned,
    version: asset.manifest.version,
    sdkDirectory: asset.sdkDirectory,
    sdkTreeDigest: asset.manifest.frontend.derivedSdkTreeSha256,
    sourceCommit: asset.manifest.provenance.sourceCommit,
    sourceTree: asset.manifest.provenance.sourceTree,
    overlaySha256: asset.manifest.provenance.overlaySha256,
  });
  yield* verifyNativeTypeScriptCandidate(candidate);
  return candidate;
});
