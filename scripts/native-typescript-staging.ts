/**
 * Set to `1` for a release build inside the glibc 2.17 GNU container, which cannot start the staging subprocess: the
 * build records `typescriptNativeAssetPending` in dist/release.json, and `stage-native-typescript-release.ts` then
 * stages the verified payload on the host.
 */
export const NATIVE_TYPESCRIPT_STAGING_DEFERRED_ENV = 'THREADNOTE_TYPESCRIPT_NATIVE_ASSET_DEFERRED';
