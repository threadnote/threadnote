import {Effect, FileSystem, Option, Path, String as EffectString} from 'effect';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {readBoundedText} from '../fingerprint.js';
import {LspFault} from '../lsp_transport.js';

export const typeScriptPolicyCommand = 'threadnoteHostPolicyV1';
export const typeScriptPolicyVersion = 'typescript-6.0.3-no-plugins-v1';

/** Runs before the original SDK entrypoint. The compiler and SDK bytes remain unchanged. */
const launcherSource = (compiler: string, entrypoint: string) => `"use strict";
const ts = require(${JSON.stringify(compiler)});
if (ts.version !== "6.0.3" || !ts.sys || !ts.server?.Session) throw new Error("Unsupported host compiler");
for (const name of ["require", "importPlugin"]) {
  Object.defineProperty(ts.sys, name, {value: undefined, configurable: false, writable: false});
}
const instance = [...globalThis.crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, "0")).join("");
const original = ts.server.Session.prototype.executeCommand;
if (typeof original !== "function") throw new Error("Unsupported host session");
ts.server.Session.prototype.executeCommand = function(request) {
  if (request.command !== ${JSON.stringify(typeScriptPolicyCommand)}) return original.call(this, request);
  const args = request.arguments;
  if (!args || Object.keys(args).length !== 1 || !/^[a-f0-9]{64}$/.test(args.challenge)) throw new Error("Invalid host challenge");
  const locked = this.host === ts.sys && ["require", "importPlugin"].every(name => {
    const descriptor = Object.getOwnPropertyDescriptor(this.host, name);
    return descriptor && descriptor.value === undefined && descriptor.writable === false && descriptor.configurable === false;
  });
  if (!locked) throw new Error("Host policy unavailable");
  return this.requiredResponse({policy: ${JSON.stringify(typeScriptPolicyVersion)}, launcher: __filename,
    compiler: ${JSON.stringify(compiler)}, version: ts.version, pid: process.pid, instance, challenge: args.challenge, locked});
};
require(${JSON.stringify(entrypoint)});
`;

/** Immutable private package layout required by TLS's selected-version resolver. */
export const makeTypeScriptRuntime = Effect.fn('semantic.makeTypeScriptRuntime')(function* (options: {
  readonly home: string;
  readonly sdkDirectory: string;
  readonly sdkTreeDigest: string;
  readonly worktree: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeOwner = (yield* fs.stat(options.home)).uid;
  const reject = () => LspFault.make({code: 'prerequisite'});
  const compiler = path.join(options.sdkDirectory, 'lib/typescript.js');
  const sourceRoot = path.join(options.sdkDirectory, 'lib');
  const text = launcherSource(compiler, path.join(sourceRoot, 'tsserver.js'));
  const parent = path.join(options.home, 'semantic', 'typescript-runtime');
  const directory = path.join(parent, sha256HexSync(JSON.stringify([options.sdkTreeDigest, compiler, text])));
  const launcher = path.join(directory, 'lib/tsserver.js');
  const metadata = JSON.stringify({private: true, type: 'commonjs', version: '6.0.3'});
  const verifyDirectory = (folder: string) =>
    Effect.gen(function* () {
      const stat = yield* fs.stat(folder);
      if (
        stat.type !== 'Directory' ||
        stat.mode & 0o077 ||
        (yield* fs.realPath(folder)) !== folder ||
        Option.isSome(yield* fs.readLink(folder).pipe(Effect.option)) ||
        (Option.isSome(homeOwner) && (!Option.isSome(stat.uid) || stat.uid.value !== homeOwner.value))
      )
        return yield* reject();
    });
  for (const folder of [path.join(options.home, 'semantic'), parent, directory, path.join(directory, 'lib')]) {
    if (
      folder === options.worktree ||
      EffectString.startsWith(options.worktree + path.sep)(folder) ||
      folder === options.sdkDirectory ||
      EffectString.startsWith(options.sdkDirectory + path.sep)(folder)
    )
      return yield* reject();
    if (!(yield* fs.exists(folder))) yield* fs.makeDirectory(folder, {mode: 0o700, recursive: true});
    yield* verifyDirectory(folder);
  }
  const files: readonly (readonly [string, string])[] = [
    [path.join(directory, 'package.json'), metadata],
    [launcher, text],
  ];
  const verify = Effect.gen(function* () {
    for (const folder of [parent, directory, path.join(directory, 'lib')]) yield* verifyDirectory(folder);
    for (const [file, expected] of files) {
      const stat = yield* fs.stat(file);
      if (
        stat.type !== 'File' ||
        stat.mode & 0o277 ||
        Number(stat.size) > 16384 ||
        (yield* fs.realPath(file)) !== file ||
        Option.isSome(yield* fs.readLink(file).pipe(Effect.option)) ||
        (Option.isSome(homeOwner) && (!Option.isSome(stat.uid) || stat.uid.value !== homeOwner.value)) ||
        (yield* readBoundedText(file, 16384)) !== expected
      )
        return yield* reject();
    }
  });
  yield* withExclusiveFileLock(
    fs,
    path.join(directory, 'prepare.lock'),
    {
      createParentDirectory: false,
      retryIntervalMilliseconds: 25,
      waitTimeoutMilliseconds: 5000,
      staleAfterMilliseconds: 60000,
      useCanonicalProcessStartIdentity: true,
    },
    Effect.gen(function* () {
      for (const [file, bytes] of files) {
        if (!(yield* fs.exists(file))) yield* fs.writeFileString(file, bytes, {flag: 'wx', mode: 0o400});
      }
      yield* verify;
    }),
  );
  return {launcher, compiler, sourceRoot, verify};
});
