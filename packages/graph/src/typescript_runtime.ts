import type * as ts from 'typescript/ast';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {randomUuidV4} from '@threadnote/platform/uuid';
import {Array as EffectArray, Context, String as EffectString} from 'effect';
import {
  NativeTypeScriptAssetManifest,
  nativeTypeScriptAssetPins,
  nativeTypeScriptExecutableIdentity,
  nativeTypeScriptHostKey,
  nativeTypeScriptManifestPinFailure,
  nativeTypeScriptTreeDigest,
  type NativeTypeScriptExecutableIdentity,
  type NativeTypeScriptExpectedImage,
} from './typescript_native_asset_pins.js';
import {Schema} from 'effect';

export const TYPESCRIPT_FULL_TRAVERSAL_CHARACTER_LIMIT = 2 * 1_024 * 1_024;
// One UTF-16 code unit needs at most three UTF-8 bytes. Allow an optional BOM.
export const TYPESCRIPT_FULL_TRAVERSAL_UTF8_BYTE_LIMIT = TYPESCRIPT_FULL_TRAVERSAL_CHARACTER_LIMIT * 3 + 3;

/** Synchronous parser-only loading; the literal module specifier stays visible to Bun's bundler. */
export function loadTypeScriptExtractionRuntime(compiler: NativeTypeScriptAst): {
  readonly compiler: typeof ts;
  readonly declarationKinds: ReadonlySet<ts.SyntaxKind>;
} {
  // Separate initialization keeps Bun's minifier from dropping the required compiler binding in the return object.
  const declarationKinds = new Set([
    compiler.SyntaxKind.ClassDeclaration,
    compiler.SyntaxKind.EnumDeclaration,
    compiler.SyntaxKind.FunctionDeclaration,
    compiler.SyntaxKind.InterfaceDeclaration,
    compiler.SyntaxKind.TypeAliasDeclaration,
  ]);
  return {compiler, declarationKinds};
}

export function typeScriptKindForPath(compiler: typeof ts, path: string): ts.ScriptKind {
  if (/\.tsx$/i.test(path)) return compiler.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return compiler.ScriptKind.JSX;
  if (/\.(?:js|mjs|cjs)$/i.test(path)) return compiler.ScriptKind.JS;
  return compiler.ScriptKind.TS;
}

export type NativeTypeScriptAst = typeof import('typescript/ast');
export interface NativeTypeScriptBudget {
  readonly deadline?: number;
  readonly signal?: AbortSignal;
}
export interface NativeTypeScriptSourceInput extends NativeTypeScriptBudget {
  readonly fileName: string;
  readonly text: string;
  readonly scriptKind?: import('typescript/ast').ScriptKind;
}
export interface NativeTypeScriptSession {
  /** Correlation only: neither this object nor SDK metadata is native/source authority. */
  readonly identity: object;
  readonly ast: NativeTypeScriptAst;
  /** Actual published numeric flags from this verified frontend, not a legacy compiler facade. */
  readonly extractionOptions: {readonly module: number; readonly jsx: number};
  withSourceFile<A>(
    input: NativeTypeScriptSourceInput,
    use: (source: import('typescript/ast').SourceFile) => A | Promise<A>,
  ): Promise<A>;
  withSourceFileAndTranspile<A>(
    input: NativeTypeScriptSourceInput,
    options: import('typescript/async').TranspileOptions,
    use: (
      source: import('typescript/ast').SourceFile,
      emitted: import('typescript/async').TranspileOutput,
    ) => A | Promise<A>,
  ): Promise<A>;
  transpileModule(
    input: string,
    options?: import('typescript/async').TranspileOptions,
    budget?: NativeTypeScriptBudget,
  ): Promise<import('typescript/async').TranspileOutput>;
  close(): Promise<void>;
}
/** What extraction code may use: parsing and transpiling, never closing an owner it only borrows. */
export type NativeTypeScriptExtractionSession = Omit<NativeTypeScriptSession, 'close'>;
export class NativeTypeScriptSessionService extends Context.Service<
  NativeTypeScriptSessionService,
  NativeTypeScriptExtractionSession
>()('@threadnote/graph/typescript_runtime/NativeTypeScriptSessionService') {}
export interface NativeTypeScriptLanguageServerSession extends NativeTypeScriptSession {
  readonly diagnosticCategories: typeof import('typescript/async').DiagnosticCategory;
  withLanguageServerSnapshot<A>(
    budget: NativeTypeScriptBudget & {readonly deadline: number},
    use: (snapshot: import('typescript/async').Snapshot) => A | Promise<A>,
  ): Promise<A>;
}
export interface NativeTypeScriptPipeOptions {
  /** Host-prepared immutable frontend; its bytes are verified before public module loading. */
  readonly sdkDirectory: string;
  /** Host-only closure over the SAME original opaque LSP owner; never caller JSON evidence. */
  readonly assertOriginalCurrent?: () => void;
  readonly pipe: string;
  readonly endpointDirectory: string;
  /** One enclosing caller deadline, never renewed for successive files. */
  readonly deadline: number;
}
export interface NativeTypeScriptSessionOptions {
  /** Original host cancellation during construction; never a public request/authority flag. */
  readonly startupSignal?: AbortSignal;
  readonly cwd: string;
  readonly deadline: number;
  /**
   * The verified asset directory, resolved by the composition root: the packaged `runtime/typescript` beside a compiled
   * executable, or the host-prepared asset in source mode. There is no implicit fallback; absent means refused.
   */
  readonly assetDirectory: string | undefined;
}

export interface NativeTypeScriptOwnedSession {
  readonly owner: import('@threadnote/platform/system').RuntimeOwnedProviderTree;
  readonly pipe: string;
  readonly endpointDirectory: string;
  readonly sdkDirectory: string;
  readonly verifyCurrent: () => Promise<void>;
  readonly assertCurrent: () => void;
}
const originalNativeTypeScriptOwners = new WeakMap<NativeTypeScriptSession, NativeTypeScriptOwnedSession>();
const currentNativeTypeScriptPipes = new WeakMap<NativeTypeScriptSession, () => void>();
/** Only the actual factory-issued session resolves to an original native owner. SDK JSON never supplies this. */
export function nativeTypeScriptSessionOwnership(session: NativeTypeScriptSession): NativeTypeScriptOwnedSession {
  const owned = originalNativeTypeScriptOwners.get(session);
  if (!owned) throw nativeApiError();
  return owned;
}
export function isNativeTypeScriptSource(path: string): boolean {
  return /\.(?:[cm]?[jt]s|[jt]sx)$/iu.test(path);
}

const nativeApiRequestMaximum = 60_000;
const nativeApiCloseMaximum = 500;
const nativeApiSourceMaximum = 16 * 1_048_576;
let unknownNativeApiOwner = false;
/** True once an original native owner could not be proved gone; new sessions are refused for this process. */
export const nativeTypeScriptOwnershipUnknown = (): boolean => unknownNativeApiOwner;
/** Value-free refusal reasons; none carries a path, digest or other host detail. */
const NativeTypeScriptRefusal = Schema.Literals([
  'request',
  'native-owner',
  'native-resource',
  'stdio',
  'rss',
  'resident-growth',
  'missing-asset',
  'missing-manifest',
  'non-canonical-path',
  'no-reviewed-pin',
  'pin-mismatch',
  'unsafe-asset',
  // A request refused before it was sent (oversized input or an already expired budget); the session stays healthy.
  'input-budget',
  // An ancestor of the asset is group-writable by a group not proved to be the user's own private group.
  'group-writable-ancestor',
  // The Darwin kernel reported a different code identity for the started compiler; it was killed before it ran.
  'image-mismatch',
  // The Darwin kernel did not report the started compiler's code identity; it was killed before it ran.
  'code-signature-unavailable',
]);
export type NativeTypeScriptRefusal = typeof NativeTypeScriptRefusal.Type;
/** Value-free name of the reviewed-asset check behind a `pin-mismatch`; it never carries a path or digest. */
const NativeTypeScriptPinCheck = Schema.Literals([
  // The manifest's binary digest is not this host's reviewed pin, or it names another executable.
  'manifest-binary',
  'manifest-executable',
  // A verified file, or an SDK/bundle tree, differs from its pinned bytes, shape or size bounds.
  'file-digest',
  'tree-entries',
  'tree-git-entry',
  'tree-bytes',
  'tree-digest',
  // The compiled-in signed release identity is malformed or names another host.
  'signed-identity',
]);
export type NativeTypeScriptPinCheck = typeof NativeTypeScriptPinCheck.Type;
/** A session-level (transport, budget, protocol or admission) failure, never a caller callback's own error. */
export class NativeTypeScriptUnavailable extends Schema.TaggedError<
  NativeTypeScriptUnavailable,
  {readonly brand: unique symbol}
>()('NativeTypeScriptUnavailable', {
  reason: NativeTypeScriptRefusal,
  check: Schema.optionalKey(NativeTypeScriptPinCheck),
  message: Schema.String,
}) {
  static of(reason: NativeTypeScriptRefusal, check?: NativeTypeScriptPinCheck): NativeTypeScriptUnavailable {
    const hint =
      reason === 'group-writable-ancestor'
        ? '; remove group write from the asset directory and its parents (chmod g-w <dir>)'
        : reason === 'image-mismatch' || reason === 'code-signature-unavailable'
          ? '; the compiler image is not the one this Threadnote release accepts, reinstall Threadnote'
          : '';
    return NativeTypeScriptUnavailable.make({
      reason,
      ...(check === undefined ? {} : {check}),
      message: `Native TypeScript session unavailable [${reason}${check === undefined ? '' : `: ${check}`}]${hint}`,
    });
  }
}
function nativeApiError(reason: NativeTypeScriptRefusal = 'request'): NativeTypeScriptUnavailable {
  return NativeTypeScriptUnavailable.of(reason);
}
function pinMismatch(check: NativeTypeScriptPinCheck): NativeTypeScriptUnavailable {
  return NativeTypeScriptUnavailable.of('pin-mismatch', check);
}
/**
 * The published client's transport, located by shape only (its socket is created lazily by the first request): socket
 * loss is observed, and after a failed operation the client's own transport close disposes the JSON-RPC connection
 * (rejecting pending requests) before it destroys the socket, so nothing writes to a destroyed stream.
 */
const guardedNativeApiSockets = new WeakSet<object>();
/**
 * Installs both transport guards on the published client's socket, once, as soon as the socket exists:
 * - Writes: a write still queued or attempted after the peer is gone fails with ECANCELED, ERR_SOCKET_CLOSED or EPIPE.
 *   The published JSON-RPC client rethrows that from an async promise executor, where no caller can handle it. The
 *   loss itself is reported through the socket's close/error events, so a write callback on a socket whose readable or
 *   writable side has ended, or that is destroyed, is completed without the error. node:net replaces `write` with
 *   `writeAfterFIN` when the peer sends FIN (before `destroyed` is set), so `write` is an accessor that keeps
 *   wrapping whatever implementation the socket installs.
 * - Reads: see `framedNativeApiReads`.
 */
function guardNativeApiSocket(socket: object): void {
  if (guardedNativeApiSockets.has(socket)) return;
  let write: unknown = Reflect.get(socket, 'write');
  if (typeof write !== 'function') return;
  guardedNativeApiSockets.add(socket);
  const gone = () =>
    Reflect.get(socket, 'destroyed') === true ||
    Reflect.get(socket, 'readableEnded') === true ||
    Reflect.get(socket, 'writableEnded') === true;
  const quiet = (...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === 'function')
      args[args.length - 1] = (error?: unknown) => Reflect.apply(callback, undefined, [gone() ? undefined : error]);
    return typeof write === 'function' ? Reflect.apply(write, socket, args) : false;
  };
  Reflect.defineProperty(socket, 'write', {
    configurable: true,
    enumerable: false,
    get: () => quiet,
    set: (replacement: unknown) => {
      write = replacement;
    },
  });
  framedNativeApiReads(socket);
}
const NATIVE_API_HEADER_MAXIMUM = 64 * 1024;
const NATIVE_API_RESPONSE_PAGE_MAXIMUM = 16 * 1_048_576;
/**
 * The largest frame the shim buffers; a larger one fails the session. `maxResponseBytesPerPage` does not bound a source
 * file response: its serialized AST measured about 15.9 bytes per source byte (a 15.6 MiB source, just under the 16 MiB
 * input cap, answered in one 237 MiB frame). So the bound is the input cap times 24, with headroom over that ratio.
 */
const NATIVE_API_FRAME_MAXIMUM = 24 * 16 * 1_048_576;
const nativeApiHeaderEnd = new Uint8Array([13, 10, 13, 10]);
/**
 * Delivers socket data to the published JSON-RPC reader one complete frame at a time. That reader arms a 10-second
 * partial-message timer whenever a frame is incomplete and re-arms it forever while the frame stays incomplete, so a
 * peer that exits mid-response would otherwise keep the process alive after every session closed. Holding partial
 * frames here (and dropping them when the socket closes) means the reader never sees one. Anything that is not
 * Content-Length framing is passed through unchanged, leaving the reader's own error handling in charge.
 */
function framedNativeApiReads(socket: object): void {
  const emit: unknown = Reflect.get(socket, 'emit');
  if (typeof emit !== 'function') return;
  let chunks: Uint8Array[] = [],
    buffered = 0,
    frame: number | undefined,
    passthrough = false;
  const forward = (bytes: Uint8Array) => Reflect.apply(emit, socket, ['data', bytes]);
  const flush = () => {
    const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    chunks = [];
    buffered = 0;
    return all;
  };
  Reflect.set(socket, 'emit', (event: unknown, ...rest: unknown[]) => {
    const chunk = rest[0];
    if (event !== 'data' || passthrough || !(chunk instanceof Uint8Array)) {
      if (event === 'close') chunks = [];
      return Reflect.apply(emit, socket, [event, ...rest]);
    }
    chunks.push(chunk);
    buffered += chunk.byteLength;
    for (;;) {
      if (frame === undefined) {
        const head = flush();
        const end = Buffer.from(head.buffer, head.byteOffset, head.byteLength).indexOf(nativeApiHeaderEnd);
        const length =
          end < 0
            ? undefined
            : /(?:^|\r\n)content-length:\s*(\d+)\s*(?:\r\n|$)/iu.exec(
                Buffer.from(head.subarray(0, end)).toString('ascii'),
              );
        if (end < 0 && head.byteLength <= NATIVE_API_HEADER_MAXIMUM) {
          chunks = [head];
          buffered = head.byteLength;
          return true;
        }
        if (!length) {
          // Not framing this shim understands: hand everything to the reader from here on.
          passthrough = true;
          forward(head);
          return true;
        }
        frame = end + nativeApiHeaderEnd.byteLength + Number(length[1]);
        if (Number(length[1]) > NATIVE_API_FRAME_MAXIMUM) {
          // Never buffer an unbounded frame: end the transport, which fails the session through its close watch.
          chunks = [];
          passthrough = true;
          const destroy: unknown = Reflect.get(socket, 'destroy');
          if (typeof destroy === 'function') Reflect.apply(destroy, socket, []);
          return true;
        }
        chunks = [head];
        buffered = head.byteLength;
      }
      if (buffered < frame) return true;
      // Forward the frame's chunks in this tick without copying them; only the last chunk can carry a remainder.
      const parts = chunks;
      const last = parts[parts.length - 1];
      const tail = frame - (buffered - last.byteLength);
      chunks = [];
      buffered = 0;
      frame = undefined;
      for (let index = 0; index < parts.length - 1; index += 1) forward(parts[index]);
      forward(last.subarray(0, tail));
      const remainder = last.subarray(tail);
      if (remainder.byteLength === 0) return true;
      chunks = [remainder];
      buffered = remainder.byteLength;
    }
  });
}
/**
 * Connects the published client through its own lazy initialization, so the transport can be watched before a request.
 * `ensureInitialized` is a private member of the pinned SDK (verified by digest before import, and checked again by the
 * module guard at load). Any other shape fails closed: the operation is refused rather than run unwatched.
 */
async function nativeApiConnect(api: object): Promise<void> {
  const ensureInitialized: unknown = Reflect.get(api, 'ensureInitialized');
  const client: unknown = Reflect.get(api, 'client');
  if (typeof ensureInitialized !== 'function' || typeof client !== 'object' || client === null) throw nativeApiError();
  // The client creates its socket inside `connectViaSocket` and resolves on 'connect', before it sends `initialize`:
  // guarding right there means no byte reaches the reader, and no write happens, unguarded.
  const connectViaSocket: unknown = Reflect.get(client, 'connectViaSocket');
  if (typeof connectViaSocket !== 'function') throw nativeApiError();
  Reflect.set(client, 'connectViaSocket', async (...args: unknown[]) => {
    const connected: unknown = await Reflect.apply(connectViaSocket, client, args);
    const socket: unknown = Reflect.get(client, 'socket');
    if (typeof socket === 'object' && socket !== null) guardNativeApiSocket(socket);
    return connected;
  });
  await Reflect.apply(ensureInitialized, api, []);
}
function nativeApiTransport(
  api: object,
): {readonly once: (event: 'close' | 'error', listener: () => void) => void; readonly destroy: () => void} | undefined {
  const client: unknown = Reflect.get(api, 'client');
  if (typeof client !== 'object' || client === null) return undefined;
  const socket: unknown = Reflect.get(client, 'socket');
  const closeTransport: unknown = Reflect.get(client, 'close');
  if (typeof socket !== 'object' || socket === null || typeof closeTransport !== 'function') return undefined;
  const once: unknown = Reflect.get(socket, 'once');
  const write: unknown = Reflect.get(socket, 'write');
  if (typeof once !== 'function' || typeof write !== 'function') return undefined;
  guardNativeApiSocket(socket);
  return {
    once: (event, listener) => {
      Reflect.apply(once, socket, [event, listener]);
    },
    destroy: () => {
      const closed: unknown = Reflect.apply(closeTransport, client, []);
      if (closed instanceof Promise) void closed.catch(() => undefined);
    },
  };
}
/** A caller's `use` callback outcome; its failure is the caller's own and leaves the session healthy. */
const callbackOutcome = async <A>(
  use: () => A | Promise<A>,
): Promise<{readonly ok: true; readonly value: A} | {readonly ok: false; readonly cause: unknown}> => {
  try {
    return {ok: true, value: await use()};
  } catch (cause) {
    return {ok: false, cause};
  }
};
/** Each operation gets its own bounded budget; a session's construction deadline never limits later operations. */
function nativeApiRemaining(
  scopeDeadline: number | undefined,
  budget?: NativeTypeScriptBudget,
  maximum = nativeApiRequestMaximum,
): number {
  const deadline = Math.min(scopeDeadline ?? Infinity, budget?.deadline ?? Infinity);
  const remaining = Number.isFinite(deadline) ? Math.min(maximum, deadline - Date.now()) : maximum;
  if (Number.isNaN(remaining) || remaining <= 0 || budget?.signal?.aborted) throw nativeApiError();
  return remaining;
}
async function nativeApiBounded<A>(work: Promise<A>, milliseconds: number, signal?: AbortSignal): Promise<A> {
  // An abandoned operation may still settle after its deadline (for example ECANCELED once the socket is destroyed).
  void work.catch(() => undefined);
  const expired = Promise.withResolvers<never>();
  const fail = () => expired.reject(nativeApiError());
  const timer = setTimeout(fail, Math.max(0, milliseconds));
  signal?.addEventListener('abort', fail, {once: true});
  try {
    if (signal?.aborted) throw nativeApiError();
    return await Promise.race([work, expired.promise]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', fail);
  }
}

// Assigned only after the source-controlled staged derivation has been observed and read back.
const nativeTypeScriptFrontendDigest = nativeTypeScriptAssetPins.frontend.derivedSdkTreeSha256;
const nativeTypeScriptPublicBundleDigest = nativeTypeScriptAssetPins.frontend.bundleTreeSha256;
// Byte authentication above the import is the authority; these guards also reject malformed module loading.
function isNativeTypeScriptApiModule(value: unknown): value is typeof import('typescript/async') {
  return (
    value !== null &&
    typeof value === 'object' &&
    'API' in value &&
    typeof value.API === 'function' &&
    // The session connects through this private client member (see `nativeApiConnect`); a frontend without it is
    // refused at load instead of failing later.
    typeof Reflect.get(Reflect.get(value.API, 'prototype') ?? {}, 'ensureInitialized') === 'function'
  );
}
function isNativeTypeScriptAstModule(value: unknown): value is NativeTypeScriptAst {
  return (
    value !== null &&
    typeof value === 'object' &&
    'SyntaxKind' in value &&
    typeof value.SyntaxKind === 'object' &&
    'ScriptKind' in value &&
    typeof value.ScriptKind === 'object' &&
    'isIdentifier' in value &&
    typeof value.isIdentifier === 'function'
  );
}
type NativePlatform = typeof import('@threadnote/platform/system');
type NativeStat = import('node:fs').BigIntStats;
/** Identity of one verified member: any rewrite, replacement, chmod or chown changes it (ctime is not settable). */
const nativeStatKey = (stat: NativeStat) =>
  `${stat.dev}:${stat.ino}:${stat.mode}:${stat.uid}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
/**
 * Full content verification happens once per process and canonical root; every later scope compares a cheap lstat
 * snapshot of every file and directory against the verified one. Keys hold no content and grant nothing by themselves.
 */
const verifiedNativeTrees = new Map<string, ReadonlyMap<string, string>>();
const verifiedNativeFiles = new Map<string, string>();
/** POSIX assets must be owned by the current user or root and not shared-writable, setuid or setgid. */
function assertPrivateNativeMember(native: NativePlatform, stat: NativeStat, executable = false): void {
  if (native.runtimePlatform === 'win32') return;
  const uid = native.runtimeCurrentUserId();
  if (
    uid === undefined ||
    (BigInt(uid) !== BigInt(stat.uid) && BigInt(stat.uid) !== 0n) ||
    (stat.mode & 0o6022n) !== 0n ||
    (executable && (stat.mode & 0o7777n) !== 0o755n)
  )
    throw nativeApiError('unsafe-asset');
}
/**
 * The canonical asset root (holding `tsc` and `manifest.json`) is itself a private member, and every ancestor is owned
 * by the current user or root, so no other user can swap a path component:
 * - a sticky ancestor (like `/tmp`) is accepted, since others cannot rename entries they do not own;
 * - an other-writable, non-sticky ancestor is refused;
 * - a group-writable, non-sticky ancestor is accepted only when the current user owns it and its group is the user's
 *   own user-private group (the umask 002 layout of Ubuntu and Fedora homes), as proved from the local account
 *   files. When they cannot prove it (directory-service accounts, NIS compat entries, non-file NSS sources), and for
 *   every other group, including a shared group such as macOS `admin`, it is refused as `group-writable-ancestor`,
 *   whose hint is to remove group write from that directory (`chmod g-w <dir>`).
 * Asset members themselves stay strictly private. The root's lstat identity joins the verified snapshot: a later
 * admission or pre-spawn recheck refuses any change.
 */
const verifiedNativeRoots = new Map<string, string>();
function assertNativeAssetRoot(native: NativePlatform, root: string): void {
  if (native.runtimePlatform === 'win32') return;
  const path = native.platformPathFor(native.runtimePlatform);
  const fs = native.runtimeNativeDescriptorOperations();
  const stat = fs.lstatSync(root, {bigint: true});
  if ((stat.mode & 0o170000n) !== 0o040000n) throw nativeApiError('unsafe-asset');
  assertPrivateNativeMember(native, stat);
  const uid = native.runtimeCurrentUserId();
  if (uid === undefined) throw nativeApiError('unsafe-asset');
  let primary: ReturnType<NativePlatform['runtimeCurrentUserPrimaryGroup']> | null = null;
  const ownPrivateGroup = (gid: bigint) => {
    primary ??= native.runtimeCurrentUserPrimaryGroup();
    return primary !== undefined && BigInt(primary.gid) === gid && primary.kind === 'private';
  };
  for (let ancestor = path.dirname(root); ; ancestor = path.dirname(ancestor)) {
    const parent = fs.lstatSync(ancestor, {bigint: true});
    const owned = BigInt(parent.uid) === BigInt(uid);
    if ((parent.mode & 0o170000n) !== 0o040000n || (!owned && BigInt(parent.uid) !== 0n))
      throw nativeApiError('unsafe-asset');
    if ((parent.mode & 0o1000n) === 0n) {
      if ((parent.mode & 0o002n) !== 0n) throw nativeApiError('unsafe-asset');
      if ((parent.mode & 0o020n) !== 0n && !(owned && ownPrivateGroup(BigInt(parent.gid))))
        throw nativeApiError('group-writable-ancestor');
    }
    if (path.dirname(ancestor) === ancestor) break;
  }
  const key = nativeStatKey(stat);
  const verified = verifiedNativeRoots.get(root);
  if (verified !== undefined && verified !== key) throw nativeApiError('unsafe-asset');
  verifiedNativeRoots.set(root, key);
}
/** Verify a native asset file's bytes once (SHA-256 against the given digest), then only its lstat identity. */
async function verifyNativeFile(native: NativePlatform, file: string, sha256: string, executable: boolean) {
  const fs = native.runtimeNativeDescriptorOperations();
  const stat = fs.lstatSync(file, {bigint: true});
  if ((stat.mode & 0o170000n) !== 0o100000n) throw nativeApiError('unsafe-asset');
  const key = `${sha256}:${nativeStatKey(stat)}`;
  if (verifiedNativeFiles.get(file) === key) return;
  assertPrivateNativeMember(native, stat, executable);
  if (sha256HexSync(await native.runtimeReadBoundedStableRegularFile(file, 256 * 1_048_576)) !== sha256)
    throw pinMismatch('file-digest');
  if (nativeStatKey(fs.lstatSync(file, {bigint: true})) !== nativeStatKey(stat)) throw nativeApiError('unsafe-asset');
  verifiedNativeFiles.set(file, key);
}
/** One walk: hash contents (first verification) or only lstat members (later scopes), always the same caps. */
async function walkNativeTree(native: NativePlatform, root: string, bundle: boolean, hash: boolean) {
  const path = native.platformPathFor(native.runtimePlatform);
  const fs = native.runtimeNativeDescriptorOperations();
  const entries: [string, string][] = [];
  const keys = new Map<string, string>([['', nativeStatKey(fs.lstatSync(root, {bigint: true}))]]);
  let count = 0;
  let bytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const before = fs.lstatSync(directory, {bigint: true});
    if ((before.mode & 0o170000n) !== 0o040000n) throw nativeApiError('unsafe-asset');
    if (hash) assertPrivateNativeMember(native, before);
    const directories: string[] = [];
    const names = fs.readdirSync(directory).sort();
    if (count + names.length > (bundle ? 6 : 20_000)) throw pinMismatch('tree-entries');
    // Bounded parallel reads retain the original whole-SDK entry cap.
    for (let start = 0; start < names.length; start += 8) {
      const settled = await Promise.allSettled(
        EffectArray.map(names.slice(start, start + 8), async name => {
          if (++count > (bundle ? 6 : 20_000)) throw pinMismatch('tree-entries');
          if (name === '.git') throw pinMismatch('tree-git-entry');
          const file = path.join(directory, name);
          const relative = EffectArray.join(EffectString.split(path.sep)(path.relative(root, file)), '/');
          const stat = fs.lstatSync(file, {bigint: true});
          keys.set(relative, nativeStatKey(stat));
          if ((stat.mode & 0o170000n) === 0o040000n) {
            entries.push([relative, 'directory']);
            directories.push(file);
          } else {
            if ((stat.mode & 0o170000n) !== 0o100000n || stat.size > (bundle ? 1n : 32n) * 1_048_576n)
              throw nativeApiError('unsafe-asset');
            if (hash) assertPrivateNativeMember(native, stat);
            bytes += Number(stat.size);
            if (bytes > (bundle ? 1 : 256) * 1_048_576) throw pinMismatch('tree-bytes');
            if (hash)
              entries.push([
                relative,
                sha256HexSync(await native.runtimeReadBoundedStableRegularFile(file, Number(stat.size))),
              ]);
          }
        }),
      );
      for (const result of settled) if (result.status === 'rejected') throw result.reason;
    }
    for (const child of directories) await visit(child);
    const after = fs.lstatSync(directory, {bigint: true});
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mtimeNs !== before.mtimeNs ||
      JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify(names)
    )
      throw nativeApiError('unsafe-asset');
  };
  await visit(root);
  return {entries, keys};
}
/** Verify one canonical asset tree against its pinned digest: full content once per process, lstat snapshot after. */
async function verifyNativeTree(native: NativePlatform, root: string, expected: string, bundle: boolean) {
  const path = native.platformPathFor(native.runtimePlatform);
  const fs = native.runtimeNativeDescriptorOperations();
  if (!path.isAbsolute(root) || fs.realpathSync(root) !== root) throw nativeApiError('non-canonical-path');
  const cacheKey = `${expected}:${root}`;
  const verified = verifiedNativeTrees.get(cacheKey);
  if (verified) {
    const {keys} = await walkNativeTree(native, root, bundle, false);
    if (keys.size !== verified.size) throw nativeApiError('unsafe-asset');
    for (const [relative, key] of keys) if (verified.get(relative) !== key) throw nativeApiError('unsafe-asset');
    return;
  }
  const {entries, keys} = await walkNativeTree(native, root, bundle, true);
  if (nativeTypeScriptTreeDigest(entries) !== expected) throw pinMismatch('tree-digest');
  verifiedNativeTrees.set(cacheKey, keys);
}

async function loadNativeTypeScriptFrontend(sdkDirectory: string) {
  const native = await import('@threadnote/platform/system');
  const path = native.platformPathFor(native.runtimePlatform);
  const bundleDirectory = path.join(path.dirname(sdkDirectory), 'frontend');
  const verify = async () => {
    await verifyNativeTree(native, sdkDirectory, nativeTypeScriptFrontendDigest, false);
    await verifyNativeTree(native, bundleDirectory, nativeTypeScriptPublicBundleDigest, true);
  };
  // Genuine published entrypoints from the verified immutable tree, not a compiler facade. Each import is bracketed by
  // a full verification (content once per process, then the lstat snapshot of every member). Residual gap: the module
  // loader reads the files after the preceding check, so a swap that is restored before the following check would go
  // unseen; the owner/permission checks on the root and its ancestors are what keep other users out of that window.
  await verify();
  const api: unknown = await import(Bun.pathToFileURL(path.join(bundleDirectory, 'api/async/api.js')).href);
  await verify();
  const ast: unknown = await import(Bun.pathToFileURL(path.join(bundleDirectory, 'ast/index.js')).href);
  await verify();
  if (!isNativeTypeScriptApiModule(api) || !isNativeTypeScriptAstModule(ast)) throw nativeApiError();
  return {api, ast, verify};
}

/** A pipe client owns no process authority. Its host must retain the original owner and source/resource fences. */
export async function connectNativeTypeScriptPipeSession(
  options: NativeTypeScriptPipeOptions,
): Promise<NativeTypeScriptSession> {
  return makeNativeTypeScriptPipeSession(options, false);
}
/** The pipe must come from custom/initializeAPISession on the SAME original LSP wire. No compiler is spawned. */
export async function connectNativeTypeScriptLanguageServerSession(
  options: NativeTypeScriptPipeOptions,
): Promise<NativeTypeScriptLanguageServerSession> {
  return makeNativeTypeScriptPipeSession(options, true);
}
async function makeNativeTypeScriptPipeSession(
  options: NativeTypeScriptPipeOptions,
  languageServer: boolean,
  guards?: {
    before(): Promise<void>;
    after(): Promise<void>;
    finish(deadline: number): Promise<void>;
    releaseNamespace?(): void;
  },
): Promise<NativeTypeScriptLanguageServerSession> {
  nativeApiRemaining(options.deadline);
  // Lazy imports are intentional: importing graph/extractor does not initialize a compiler or API process.
  const native = await import('@threadnote/platform/system');
  const {
    api: {API, ModuleKind, JsxEmit, DiagnosticCategory},
    ast,
    verify: verifyFrontend,
  } = await loadNativeTypeScriptFrontend(options.sdkDirectory);
  const path = native.platformPathFor(native.runtimePlatform);
  const assertOriginalCurrent = options.assertOriginalCurrent;
  if (languageServer && typeof assertOriginalCurrent !== 'function') throw nativeApiError('native-owner');
  // An original LSP can issue /tmp while Darwin's kernel directory is /private/tmp.
  // Preserve its literal socket-child relation, then bind both original paths to
  // the same canonical private directory/socket before acquiring its native handle.
  const windows = native.runtimePlatform === 'win32';
  if (windows) {
    const name = path.basename(options.pipe);
    const expectedName = languageServer
      ? /^tsgo-api-[a-f0-9]{1,16}-[a-f0-9]{1,16}$/u
      : /^threadnote-ts71-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
    if (options.pipe !== `\\\\.\\pipe\\${name}` || !expectedName.test(name)) throw nativeApiError();
  } else if (options.pipe !== path.join(options.endpointDirectory, 'socket')) throw nativeApiError();
  const descriptors = native.runtimeNativeDescriptorOperations();
  const endpointDirectory =
    languageServer && !windows ? descriptors.realpathSync(options.endpointDirectory) : options.endpointDirectory;
  const pipe = windows ? options.pipe : path.join(endpointDirectory, 'socket');
  const issuedSocket = languageServer && !windows ? descriptors.lstatSync(options.pipe, {bigint: true}) : undefined;
  const assertIssuedNamespace = () => {
    assertOriginalCurrent?.();
    if (!issuedSocket) return;
    const current = descriptors.lstatSync(options.pipe, {bigint: true});
    const canonical = descriptors.lstatSync(pipe, {bigint: true});
    if (
      descriptors.realpathSync(options.endpointDirectory) !== endpointDirectory ||
      (issuedSocket.mode & 0o170000n) !== 0o140000n ||
      current.mode !== issuedSocket.mode ||
      current.dev !== issuedSocket.dev ||
      current.ino !== issuedSocket.ino ||
      canonical.dev !== issuedSocket.dev ||
      canonical.ino !== issuedSocket.ino ||
      canonical.mode !== issuedSocket.mode
    )
      throw nativeApiError();
  };
  assertIssuedNamespace();
  // Keep the public client object before any asynchronous initialize/connect. A timeout
  // can then always close that exact client, rather than losing a partially initialized API.
  const languageApi = languageServer
    ? new API<true>({pipe, maxResponseBytesPerPage: NATIVE_API_RESPONSE_PAGE_MAXIMUM})
    : undefined;
  const api = languageApi ?? new API({pipe, maxResponseBytesPerPage: NATIVE_API_RESPONSE_PAGE_MAXIMUM});
  // A Windows LSP pipe has no filesystem dirname. Its actual original-host
  // capability plus issued secured namespace is the proof boundary, not a fake fd.
  const directory = windows && languageServer ? undefined : native.runtimeOpenPrivateWriterDirectory(endpointDirectory);
  let failed = false,
    active = false,
    closing: Promise<void> | undefined;
  const assertCurrent = () => {
    if (failed || closing) throw nativeApiError();
    if (directory) native.runtimeAssertPrivateWriterDirectoryCurrent(directory);
    assertIssuedNamespace();
  };
  // The published client opens its socket lazily, and the owner's endpoint serves a single connection (the owner or the
  // one borrower that uses it). So nothing connects at construction: the first operation connects explicitly, before
  // its own request, and attaches the watch then. Socket loss (owner exit, socket error) fails the session at once,
  // including during that first operation, instead of leaving in-flight work to run into the per-request cap.
  const lost = Promise.withResolvers<never>();
  void lost.promise.catch(() => undefined);
  let watched = false;
  const watchTransport = () => {
    const transport = watched ? undefined : nativeApiTransport(api);
    if (!transport) return;
    watched = true;
    const onLost = () => {
      failed = true;
      lost.reject(nativeApiError('native-owner'));
    };
    transport.once('close', onLost);
    transport.once('error', onLost);
  };
  const close = () =>
    (closing ??= (async () => {
      failed = true;
      const deadline = Date.now() + nativeApiCloseMaximum;
      let first: unknown;
      // An outside close while an operation is in flight tears the transport down at once; the operation then fails
      // as a typed session failure instead of holding the graceful lease disposal behind it.
      if (active) nativeApiTransport(api)?.destroy();
      try {
        await nativeApiBounded(api.close(), Math.max(0, deadline - Date.now() - (guards ? 200 : 0)));
      } catch (error) {
        first = error;
      }
      // A graceful close normally releases the transport itself. When it is stuck (behind a failed or abandoned
      // operation, or a peer that vanished without the socket closing), tear the transport down explicitly so no
      // socket handle outlives the session and keeps the process alive. The connection is disposed before its socket,
      // so no write reaches a destroyed stream, and late rejections are handled.
      nativeApiTransport(api)?.destroy();
      try {
        await guards?.finish(deadline);
      } catch (error) {
        first ??= error;
      }
      try {
        if (!guards) await nativeApiBounded(verifyFrontend(), Math.max(0, deadline - Date.now()));
      } catch (error) {
        first ??= error;
      }
      if (directory) native.runtimeClosePrivateWriterDirectory(directory);
      if (first === undefined) {
        try {
          guards?.releaseNamespace?.();
        } catch (error) {
          first = error;
        }
      }
      if (first !== undefined) {
        if (windows && guards?.releaseNamespace) unknownNativeApiOwner = true;
        throw nativeApiError();
      }
    })());
  type Outcome<A> = Awaited<ReturnType<typeof callbackOutcome<A>>>;
  const operate = async <A>(budget: NativeTypeScriptBudget | undefined, run: () => Promise<Outcome<A>>): Promise<A> => {
    assertCurrent();
    if (active) throw nativeApiError();
    // Per-operation budget: the construction deadline in `options` bounds startup only. An already expired budget is
    // refused before any request and leaves the session healthy.
    let milliseconds: number;
    try {
      milliseconds = nativeApiRemaining(undefined, budget, languageServer ? Infinity : nativeApiRequestMaximum);
    } catch {
      throw nativeApiError('input-budget');
    }
    active = true;
    watchTransport();
    let result: Outcome<A>;
    try {
      const work = (async () => {
        await guards?.before();
        assertCurrent();
        if (!watched) {
          await nativeApiConnect(api);
          watchTransport();
          if (!watched) throw nativeApiError();
        }
        const value = await run();
        watchTransport();
        assertCurrent();
        await guards?.after();
        return value;
      })();
      result = await nativeApiBounded(Promise.race([work, lost.promise]), milliseconds, budget?.signal);
      assertCurrent();
    } catch (error) {
      failed = true;
      // Closing the original host remains mandatory even if this bounded API operation has failed.
      await close().catch(() => undefined);
      // Transport, deadline and protocol failures are all reported as the one typed session failure.
      throw Schema.is(NativeTypeScriptUnavailable)(error) ? error : nativeApiError();
    } finally {
      active = false;
    }
    // A caller's own callback error leaves the transport, budget and owner proofs intact.
    if (!result.ok) throw result.cause;
    return result.value;
  };
  // An oversized input is refused before any request, so it never fails the shared session.
  const oversized = (input: NativeTypeScriptSourceInput): Promise<never> | undefined =>
    Buffer.byteLength(input.text, 'utf8') > nativeApiSourceMaximum
      ? Promise.reject(nativeApiError('input-budget'))
      : undefined;
  const session: NativeTypeScriptLanguageServerSession = {
    identity: Object.freeze({}),
    ast,
    extractionOptions: Object.freeze({module: ModuleKind.Preserve, jsx: JsxEmit.Preserve}),
    diagnosticCategories: DiagnosticCategory,
    close,
    withSourceFile: (input, use) =>
      oversized(input) ??
      operate(input, async () => {
        const lease = await api.createSourceFile(
          input.fileName,
          input.text,
          input.scriptKind === undefined ? undefined : {scriptKind: input.scriptKind},
        );
        try {
          assertCurrent();
          return await callbackOutcome(() => use(lease.sourceFile));
        } finally {
          await lease.dispose();
        }
      }),
    withSourceFileAndTranspile: (input, transpileOptions, use) =>
      oversized(input) ??
      operate(input, async () => {
        // The published asynchronous client batches requests queued in the same turn.
        const source = api.createSourceFile(
          input.fileName,
          input.text,
          input.scriptKind === undefined ? undefined : {scriptKind: input.scriptKind},
        );
        const emitted = api.transpileModule(input.text, transpileOptions);
        const [parsed, emittedResult] = await Promise.allSettled([source, emitted]);
        if (parsed.status === 'rejected') throw parsed.reason;
        const lease = parsed.value;
        try {
          assertCurrent();
          // A transpile rejection beside a parsed source is this file's own failure, never the shared session's.
          if (emittedResult.status === 'rejected')
            return {ok: false as const, cause: new Error('Native TypeScript transpile rejected this source.')};
          return await callbackOutcome(() => use(lease.sourceFile, emittedResult.value));
        } finally {
          await lease.dispose();
        }
      }),
    transpileModule: (input, transpileOptions, budget) =>
      operate(budget, async () => ({ok: true as const, value: await api.transpileModule(input, transpileOptions)})),
    withLanguageServerSnapshot: (budget, use) =>
      operate(budget, async () => {
        if (!languageApi) throw nativeApiError();
        const snapshot = await languageApi.getCurrentLanguageServerSnapshot();
        try {
          assertCurrent();
          return await callbackOutcome(() => use(snapshot));
        } finally {
          await snapshot.dispose();
        }
      }),
  };
  try {
    assertCurrent();
  } catch (error) {
    // The pinned constructor is lazy, but close its exact client object as well
    // as the acquired directory before rejecting a partially published session.
    try {
      await nativeApiBounded(api.close(), nativeApiCloseMaximum);
    } catch {
      unknownNativeApiOwner = true;
    } finally {
      if (directory) native.runtimeClosePrivateWriterDirectory(directory);
    }
    throw Schema.is(NativeTypeScriptUnavailable)(error) ? error : nativeApiError();
  }
  currentNativeTypeScriptPipes.set(session, assertCurrent);
  return Object.freeze(session);
}

/** The admitted, verified asset: canonical root, schema-valid manifest and this host's accepted binary. */
export interface NativeTypeScriptAdmittedAsset {
  readonly assetDirectory: string;
  readonly sdkDirectory: string;
  readonly compilerPath: string;
  /** The exact accepted file digest: the reviewed pin, or the compiled-in signed digest of a signed macOS release. */
  readonly pinned: string;
  /** The Darwin image the started compiler must run as; absent for unsigned images (darwin-x64 outside a release). */
  readonly image?: NativeTypeScriptExpectedImage;
  readonly manifest: NativeTypeScriptAssetManifest;
}
/** This host's accepted executable identity; a malformed compiled-in identity is refused like a pin mismatch. */
function nativeExecutableIdentity(native: NativePlatform): NativeTypeScriptExecutableIdentity {
  let identity: NativeTypeScriptExecutableIdentity | undefined;
  try {
    identity = nativeTypeScriptExecutableIdentity(nativeTypeScriptHostKey(native.runtimePlatform, process.arch));
  } catch {
    throw pinMismatch('signed-identity');
  }
  if (identity === undefined) throw nativeApiError('no-reviewed-pin');
  return identity;
}
/** A spawn refused by the kernel image check is a typed session refusal; other launch failures stay as they are. */
function nativeSpawnRefusal(native: NativePlatform, error: unknown): unknown {
  if (!Schema.is(native.RuntimeWriterFault)(error)) return error;
  return error.reason === 'image-mismatch' || error.reason === 'code-signature-unavailable'
    ? nativeApiError(error.reason)
    : error;
}
async function admitNativeTypeScriptAsset(
  native: NativePlatform,
  assetDirectory: string | undefined,
): Promise<NativeTypeScriptAdmittedAsset> {
  const path = native.platformPathFor(native.runtimePlatform);
  if (assetDirectory === undefined) throw nativeApiError('missing-asset');
  let canonical: string;
  try {
    canonical = native.runtimeNativeDescriptorOperations().realpathSync(assetDirectory);
  } catch {
    throw nativeApiError('missing-asset');
  }
  if (!path.isAbsolute(assetDirectory) || canonical !== path.resolve(assetDirectory))
    throw nativeApiError('non-canonical-path');
  assertNativeAssetRoot(native, canonical);
  // The binary must be this host's accepted identity; a self-consistent manifest can never substitute another
  // executable. The manifest always names the reviewed construction digest, also in a signed release.
  const identity = nativeExecutableIdentity(native);
  const pinned = identity.sha256;
  let manifest: NativeTypeScriptAssetManifest;
  try {
    const raw: unknown = JSON.parse(
      new TextDecoder('utf-8', {fatal: true}).decode(
        await native.runtimeReadBoundedStableRegularFile(path.join(canonical, 'manifest.json'), 64 * 1024),
      ),
    );
    manifest = Schema.decodeUnknownSync(NativeTypeScriptAssetManifest)(raw);
  } catch {
    throw nativeApiError('missing-manifest');
  }
  // The shared reviewed-binary decision: the manifest names the reviewed construction binary, also in a signed release.
  const manifestFailure = nativeTypeScriptManifestPinFailure(manifest, native.runtimePlatform, process.arch);
  if (manifestFailure === 'no-reviewed-pin') throw nativeApiError('no-reviewed-pin');
  if (manifestFailure !== undefined) throw pinMismatch(manifestFailure);
  const sdkDirectory = path.join(canonical, 'sdk');
  const compilerPath = path.join(canonical, manifest.executable);
  await verifyNativeTree(native, sdkDirectory, nativeTypeScriptFrontendDigest, false);
  await verifyNativeTree(native, path.join(canonical, 'frontend'), nativeTypeScriptPublicBundleDigest, true);
  await verifyNativeFile(native, compilerPath, pinned, true);
  assertNativeAssetRoot(native, canonical);
  return {
    assetDirectory: canonical,
    sdkDirectory,
    compilerPath,
    pinned,
    ...(identity.image ? {image: identity.image} : {}),
    manifest,
  };
}
/** Cheap recheck immediately before an executable is started: root/ancestor ownership and the binary's lstat identity. */
async function recheckNativeExecutable(native: NativePlatform, compilerPath: string, sha256: string): Promise<void> {
  const path = native.platformPathFor(native.runtimePlatform);
  assertNativeAssetRoot(native, path.dirname(compilerPath));
  await verifyNativeFile(native, compilerPath, sha256, true);
}
/**
 * The semantic provider's pre-spawn recheck of an already admitted candidate executable. It returns the Darwin image
 * the started compiler must run as, derived from the accepted identity and never re-read from the file.
 */
export async function recheckNativeTypeScriptExecutable(
  compilerPath: string,
  sha256: string,
): Promise<NativeTypeScriptExpectedImage | undefined> {
  const native = await import('@threadnote/platform/system');
  const identity = nativeExecutableIdentity(native);
  if (identity.sha256 !== sha256) throw pinMismatch('file-digest');
  await recheckNativeExecutable(native, compilerPath, sha256);
  return identity.image;
}
/** The one runtime verification of a staged or prepared asset, shared by the graph session and the semantic provider. */
export async function verifyNativeTypeScriptAsset(assetDirectory: string): Promise<NativeTypeScriptAdmittedAsset> {
  return admitNativeTypeScriptAsset(await import('@threadnote/platform/system'), assetDirectory);
}

/** One explicitly scoped original Go API owner for a whole checker/task; no per-file child or ambient singleton. */
export async function createNativeTypeScriptSession(
  options: NativeTypeScriptSessionOptions,
): Promise<NativeTypeScriptSession> {
  if (unknownNativeApiOwner) throw nativeApiError();
  nativeApiRemaining(options.deadline, {signal: options.startupSignal});
  const native = await import('@threadnote/platform/system');
  const windows = native.runtimePlatform === 'win32';
  const path = native.platformPathFor(native.runtimePlatform);
  const cwd = path.resolve(options.cwd);
  const asset = await admitNativeTypeScriptAsset(native, options.assetDirectory);
  const {compilerPath, sdkDirectory} = asset;
  const frontend = await loadNativeTypeScriptFrontend(sdkDirectory);
  const verifyCompiler = async () => {
    await frontend.verify();
    await verifyNativeFile(native, compilerPath, asset.pinned, true);
  };
  // The pinned Go IPC transport itself creates this absent directory0700/socket0600
  // and removes its own socket/directory after its original connection closes.
  // POSIX endpoints live under the fixed system /tmp (Darwin's canonical /private/tmp), not a caller TMPDIR: a Unix
  // socket path must fit sun_path (~104 bytes), and a host-level directory keeps the endpoint outside every repository
  // and test home. Windows uses its named-pipe namespace with a private writer directory under the host temp root.
  const descriptors = native.runtimeNativeDescriptorOperations();
  const temporary = descriptors.realpathSync(
    windows ? native.runtimeHostTemporaryDirectory() : native.runtimePlatform === 'darwin' ? '/private/tmp' : '/tmp',
  );
  const nonce = randomUuidV4();
  const plannedDirectory = path.join(temporary, 'tn71-' + nonce);
  const setupDirectory = windows ? native.runtimeProvisionPrivateWriterDirectory(plannedDirectory) : undefined;
  const endpoint = setupDirectory?.path ?? plannedDirectory;
  const pipe = windows ? `\\\\.\\pipe\\threadnote-ts71-${nonce}` : path.join(endpoint, 'socket');
  const environment: NodeJS.ProcessEnv = windows
    ? {HOME: endpoint, USERPROFILE: endpoint, TMPDIR: temporary, TMP: temporary, TEMP: temporary}
    : {HOME: endpoint, TMPDIR: temporary};
  let child: ReturnType<typeof native.runtimeSpawnOwnedProviderTree>;
  let spawnAttempted = false;
  try {
    // Re-verify the binary right before it is started; only synchronous setup separates this check from the spawn.
    await recheckNativeExecutable(native, compilerPath, asset.pinned);
    nativeApiRemaining(options.deadline, {signal: options.startupSignal});
    spawnAttempted = true;
    child = native.runtimeSpawnOwnedProviderTree({
      command: compilerPath,
      args: ['--api', '--async', '--pipe', windows ? pipe : endpoint, '--cwd', cwd],
      cwd,
      environment,
      // Darwin: the kernel must report the admitted image before the compiler runs, which closes the swap window
      // between the recheck above and exec.
      ...(asset.image ? {expectedDarwinImage: asset.image} : {}),
    });
  } catch (error) {
    if (setupDirectory) {
      if (spawnAttempted)
        unknownNativeApiOwner = true; // no uncaptured child is declared gone
      else {
        try {
          native.runtimeAssertPrivateWriterDirectoryCurrent(setupDirectory);
          native.runtimeClosePrivateWriterDirectory(setupDirectory);
          descriptors.rmdirSync(endpoint);
        } catch {
          unknownNativeApiOwner = true;
        }
      }
    }
    throw nativeSpawnRefusal(native, error);
  }
  let outputBytes = 0,
    outputFailed = false,
    initialPeak = 0;
  const marker = new TextEncoder().encode('THREADNOTE_TS_API_BOUND_V1\n');
  let markerBytes = 0;
  const drain = async (stream: ReadableStream<Uint8Array>, stdout: boolean) => {
    try {
      for await (const chunk of stream) {
        outputBytes += chunk.byteLength;
        if (outputBytes > 32 * 1024) outputFailed = true;
        if (windows && stdout) {
          for (const byte of chunk) {
            if (markerBytes >= marker.byteLength || byte !== marker[markerBytes]) outputFailed = true;
            markerBytes++;
          }
        } else if (chunk.byteLength !== 0) outputFailed = true;
      }
    } catch {
      outputFailed = true;
    }
  };
  const output = Promise.all([drain(child.stdout, true), drain(child.stderr, false)]);
  const check = (growth = true) => {
    const state = native.runtimeObserveOwnedProviderTree(child.handle),
      resource = native.runtimeObserveOwnedProviderResources(child.handle);
    if (state.state !== 'running' || state.leaderExitCode !== null) throw nativeApiError('native-owner');
    if (outputFailed) throw nativeApiError('stdio');
    if (setupDirectory) native.runtimeAssertPrivateWriterDirectoryCurrent(setupDirectory);
    if (resource.state !== 'known') throw nativeApiError('native-resource');
    if (resource.peakRssUpperBoundBytes > 2 * 1024 * 1_048_576) throw nativeApiError('rss');
    if (growth && resource.peakRssUpperBoundBytes - initialPeak > 512 * 1_048_576)
      throw nativeApiError('resident-growth');
    return resource.peakRssUpperBoundBytes;
  };
  let nativeCompleted = false;
  let finishing: Promise<void> | undefined;
  const finish = (deadline: number): Promise<void> =>
    (finishing ??= (async () => {
      let killed = false,
        drained = false;
      try {
        try {
          await nativeApiBounded(child.closeInput(), Math.max(0, deadline - Date.now() - 100));
        } catch {
          native.runtimeTerminateOwnedProviderTree(child.handle, 'kill');
          killed = true;
        }
        for (;;) {
          const state = native.runtimeObserveOwnedProviderTree(child.handle);
          if (state.state === 'unknown' || Date.now() >= deadline) throw nativeApiError();
          if (state.state === 'drained') {
            drained = true;
            await nativeApiBounded(output, Math.max(0, deadline - Date.now()));
            native.runtimeCloseOwnedProviderTree(child.handle);
            nativeCompleted = true;
            await nativeApiBounded(verifyCompiler(), Math.max(0, deadline - Date.now()));
            if (state.leaderExitCode !== 0 || outputFailed || outputBytes !== (windows ? marker.byteLength : 0))
              throw nativeApiError('stdio');
            return;
          }
          if (!killed && deadline - Date.now() <= 100) {
            native.runtimeTerminateOwnedProviderTree(child.handle, 'kill');
            killed = true;
          }
          await Bun.sleep(5);
        }
      } catch {
        // A drained owner is known gone: a slow or nonzero exit or stray output fails only this session. Only an
        // unknown or undrained owner is charged for the rest of the process lifetime.
        if (drained) {
          try {
            if (!nativeCompleted) native.runtimeCloseOwnedProviderTree(child.handle);
            nativeCompleted = true;
          } catch {
            unknownNativeApiOwner = true;
          }
          throw nativeApiError(unknownNativeApiOwner ? 'native-owner' : 'stdio');
        }
        unknownNativeApiOwner = true;
        if (!killed) {
          try {
            native.runtimeTerminateOwnedProviderTree(child.handle, 'kill');
          } catch {
            /* Retain the original unknown owner. */
          }
        }
        throw nativeApiError();
      }
    })());
  let namespaceReleased = false;
  const releaseNamespace = () => {
    if (!setupDirectory || namespaceReleased) return;
    if (!nativeCompleted) throw nativeApiError('native-owner');
    try {
      native.runtimeAssertPrivateWriterDirectoryCurrent(setupDirectory);
      native.runtimeClosePrivateWriterDirectory(setupDirectory);
      descriptors.rmdirSync(endpoint);
      namespaceReleased = true;
    } catch (error) {
      unknownNativeApiOwner = true;
      throw error;
    }
  };
  const startupDeadline = Math.min(options.deadline, Date.now() + nativeApiRequestMaximum);
  try {
    const socket = pipe;
    const exists = () => {
      try {
        return windows
          ? !outputFailed && markerBytes === marker.byteLength
          : (descriptors.lstatSync(socket).mode & 0o170000) === 0o140000;
      } catch {
        return false;
      }
    };
    while (!exists()) {
      nativeApiRemaining(startupDeadline, {signal: options.startupSignal});
      const starting = native.runtimeObserveOwnedProviderTree(child.handle);
      if (starting.state !== 'running' || starting.leaderExitCode !== null) throw nativeApiError('native-owner');
      if (outputFailed) throw nativeApiError('stdio');
      await Bun.sleep(5);
    }
    initialPeak = check(false);
    const session = await makeNativeTypeScriptPipeSession(
      {pipe, endpointDirectory: endpoint, sdkDirectory, deadline: options.deadline},
      false,
      {
        before: async () => {
          initialPeak = check(false);
        },
        after: async () => {
          check();
        },
        finish,
        releaseNamespace,
      },
    );
    originalNativeTypeScriptOwners.set(
      session,
      Object.freeze({
        owner: child.handle,
        pipe: socket,
        endpointDirectory: endpoint,
        sdkDirectory,
        assertCurrent: () => {
          const current = currentNativeTypeScriptPipes.get(session);
          const original = native.runtimeObserveOwnedProviderTree(child.handle);
          if (nativeCompleted || !current || original.state !== 'running' || original.leaderExitCode !== null)
            throw nativeApiError('native-owner');
          current();
        },
        verifyCurrent: async () => {
          const current = currentNativeTypeScriptPipes.get(session);
          if (!current) throw nativeApiError();
          if (!nativeCompleted) current();
          await verifyCompiler();
          if (!nativeCompleted) current();
        },
      }),
    );
    return session;
  } catch (error) {
    await finish(Date.now() + nativeApiCloseMaximum).then(releaseNamespace, () => undefined);
    throw error;
  }
}

/**
 * A borrowed view whose every operation ends by the earlier of its own deadline and `deadline`. `observe` sees each
 * operation's promise, for example to record a session failure; the view never exposes `close`.
 */
export function boundedNativeTypeScriptSession(
  session: NativeTypeScriptExtractionSession,
  deadline: number,
  observe: <A>(operation: Promise<A>) => Promise<A> = operation => operation,
): NativeTypeScriptExtractionSession {
  return {
    identity: session.identity,
    ast: session.ast,
    extractionOptions: session.extractionOptions,
    withSourceFile: (input, use) =>
      observe(session.withSourceFile({...input, deadline: Math.min(deadline, input.deadline ?? deadline)}, use)),
    withSourceFileAndTranspile: (input, options, use) =>
      observe(
        session.withSourceFileAndTranspile(
          {...input, deadline: Math.min(deadline, input.deadline ?? deadline)},
          options,
          use,
        ),
      ),
    transpileModule: (input, options, budget) =>
      observe(
        session.transpileModule(input, options, {
          ...budget,
          deadline: Math.min(deadline, budget?.deadline ?? deadline),
        }),
      ),
  };
}

/** Native syntax-only input: no project, module resolution, source loading or emit publication. */
export async function withNativeTypeScriptExtractionSource<A>(
  file: {readonly path: string; readonly content: string},
  session: NativeTypeScriptExtractionSession,
  use: (source: ts.SourceFile, diagnostics: readonly import('typescript/async').Diagnostic[]) => A | Promise<A>,
): Promise<A> {
  return session.withSourceFileAndTranspile(
    {fileName: file.path, text: file.content, scriptKind: typeScriptKindForPath(session.ast, file.path)},
    {
      fileName: file.path,
      reportDiagnostics: true,
      compilerOptions: {
        target: session.ast.ScriptTarget.Latest,
        module: session.extractionOptions.module,
        jsx: session.extractionOptions.jsx,
      },
    },
    // Transpile roots its exact single in-memory input at '/', while source leases
    // use API cwd. Retain all diagnostics instead of dropping real syntax errors
    // by comparing these different filenames. No foreign project is loaded here.
    (source, emitted) => use(source, emitted.diagnostics ?? []),
  );
}
export function typeScriptDiagnosticMessages(
  path: string,
  diagnostics: readonly import('typescript/async').Diagnostic[],
): readonly string[] {
  return EffectArray.map(diagnostics, diagnostic => {
    const position = diagnostic.startPosition === undefined ? undefined : diagnostic.startPosition.line + 1;
    const text = EffectArray.join(
      [diagnostic.text, ...EffectArray.map(diagnostic.messageChain ?? [], message => message.text)],
      ' ',
    );
    return `${path}${position ? `:${position}` : ''}: ${text}`;
  });
}
