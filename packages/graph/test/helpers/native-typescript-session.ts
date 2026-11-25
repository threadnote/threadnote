import {Effect, Layer} from 'effect';
import {it as vitestIt} from 'vitest';
import * as EffectString from 'effect/String';
import {realpathSync} from '@threadnote/testing/node-fs';
import {
  createNativeTypeScriptSession,
  NativeTypeScriptSessionService,
  type NativeTypeScriptSession,
} from '@threadnote/graph/typescript_runtime';
import {
  NATIVE_TYPESCRIPT_PREPARED_ASSET_ENV,
  nativeTypeScriptHostKey,
  nativeTypeScriptReviewedBinarySha256,
} from '@threadnote/graph/typescript_native_asset_pins';

const host = nativeTypeScriptHostKey(process.platform, process.arch);
const configured = process.env[NATIVE_TYPESCRIPT_PREPARED_ASSET_ENV] || undefined;
const pinned = nativeTypeScriptReviewedBinarySha256(host) !== undefined;
const enabled = (value: string | undefined) => !['', '0', 'false'].includes(EffectString.toLowerCase(value ?? ''));
/** Bazel forwards only the dedicated flag (never `CI`); a direct CI vitest run may rely on `CI` alone. */
export const NATIVE_TYPESCRIPT_REQUIRED_ENV = 'THREADNOTE_NATIVE_TYPESCRIPT_REQUIRED';
const required = enabled(process.env[NATIVE_TYPESCRIPT_REQUIRED_ENV]) || enabled(process.env.CI);

/**
 * Native TypeScript tests need the verified prepared asset on a host with a reviewed binary pin. Elsewhere they skip
 * with a stated reason instead of failing; when the asset is configured they always run, and a bad asset fails.
 * When the asset is required (CI, or the forwarded Bazel flag) on a reviewed-pin host, a missing asset fails here.
 */
if (required && pinned && configured === undefined)
  throw new Error(
    `${host} must provide ${NATIVE_TYPESCRIPT_PREPARED_ASSET_ENV} when native TypeScript tests are required (${NATIVE_TYPESCRIPT_REQUIRED_ENV} or CI): they never skip on a reviewed-pin host there.`,
  );
export const nativeTypeScriptSkipReason: string | undefined = !pinned
  ? `no reviewed native TypeScript pin for ${host}`
  : configured === undefined
    ? `${NATIVE_TYPESCRIPT_PREPARED_ASSET_ENV} is not set`
    : undefined;
export const nativeTypeScriptUnavailable = nativeTypeScriptSkipReason !== undefined;

let skipReported = false;
/** Registers one skipped placeholder per test file that names the reason; test names themselves never change. */
export function reportNativeTypeScriptSkip(): void {
  if (nativeTypeScriptSkipReason === undefined || skipReported) return;
  skipReported = true;
  vitestIt.skip(`native TypeScript tests skipped: ${nativeTypeScriptSkipReason}`, () => undefined);
}

/**
 * Skips a running plain Vitest test without the native asset. Use it as a test's first statement where wrapping the
 * registration would reflow a long test call; the skip note names the reason.
 */
export function skipWithoutNativeTypeScript(context: {readonly skip: (note?: string) => void}): void {
  if (nativeTypeScriptSkipReason !== undefined)
    context.skip(`native TypeScript unavailable: ${nativeTypeScriptSkipReason}`);
}

const hasSkipIf = (api: unknown): api is {readonly skipIf: (condition: boolean) => unknown} =>
  (typeof api === 'function' || (typeof api === 'object' && api !== null)) &&
  'skipIf' in api &&
  typeof api.skipIf === 'function';

/**
 * Gates any Vitest or Effect Vitest test or suite API on the native asset, keeping the call shape and name:
 * `native(it.effect)('name', ...)`, `native(describe)('name', ...)`, `native(it)('name', ...)`. A parameterized
 * registrar without `skipIf` (for example `native(it.effect.each(cases))`) registers one skipped test instead.
 */
export function native<Api extends {readonly skipIf: (condition: boolean) => unknown}>(
  api: Api,
): ReturnType<Api['skipIf']>;
export function native<Register extends (...args: never[]) => unknown>(register: Register): Register;
export function native(api: unknown): unknown {
  reportNativeTypeScriptSkip();
  if (hasSkipIf(api)) return api.skipIf(nativeTypeScriptUnavailable);
  // An unnamed block (for example a callback-only Effect Vitest layer) skips as one named placeholder.
  return nativeTypeScriptUnavailable
    ? (name: unknown) => vitestIt.skip(typeof name === 'string' ? name : 'native TypeScript block', () => undefined)
    : api;
}

/**
 * Gates an Effect Vitest property registrar (as passed to `fcEffectProp`): without the native asset its
 * `it.effect.prop` registers one skipped test under the same name.
 */
export function nativeProperty<Methods extends object>(methods: Methods): Methods {
  reportNativeTypeScriptSkip();
  if (!nativeTypeScriptUnavailable) return methods;
  return new Proxy(methods, {
    get: (target, key, receiver) => {
      const value: unknown = Reflect.get(target, key, receiver);
      if (key !== 'effect' || (typeof value !== 'function' && typeof value !== 'object') || value === null)
        return value;
      return new Proxy(value, {
        get: (effect, member, effectReceiver) =>
          member === 'prop'
            ? (name: string) => vitestIt.skip(name, () => undefined)
            : Reflect.get(effect, member, effectReceiver),
      });
    },
  });
}

/** The canonical prepared asset directory; only called by tests that are not skipped. */
export function nativeTypeScriptTestAssetDirectory(): string {
  if (configured === undefined) throw new Error(`${NATIVE_TYPESCRIPT_PREPARED_ASSET_ENV} is not set`);
  return realpathSync(configured);
}

/** One native session; the startup deadline bounds construction only, each operation has its own budget. */
export function createNativeTypeScriptTestSession(cwd = process.cwd()): Promise<NativeTypeScriptSession> {
  return createNativeTypeScriptSession({
    cwd,
    deadline: Date.now() + 60_000,
    assetDirectory: nativeTypeScriptTestAssetDirectory(),
  });
}

/** A scoped native session; its original owner is closed when the enclosing scope ends. */
export const nativeTypeScriptTestSession = Effect.acquireRelease(
  Effect.tryPromise(() => createNativeTypeScriptTestSession()),
  session => Effect.promise(() => session.close()),
);

export const NativeTypeScriptTestSessionLayer = Layer.effect(
  NativeTypeScriptSessionService,
  nativeTypeScriptTestSession,
);
