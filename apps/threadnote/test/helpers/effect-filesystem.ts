import {provideTestLayer} from './effect-layer.js';
import {BunFileSystem, BunPath} from '@effect/platform-bun';
import {Effect, FileSystem, Option, Path} from 'effect';

const FileSystemLayer = BunFileSystem.layer;

const runFileSystem = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(provideTestLayer(FileSystemLayer)));

export const pathService = Effect.runSync(Path.Path.pipe(provideTestLayer(BunPath.layer)));

export const join = pathService.join;

export const chmod = (path: string, mode: number) =>
  runFileSystem(FileSystem.FileSystem.pipe(Effect.flatMap(fileSystem => fileSystem.chmod(path, mode))));

export const mkdir = (path: string, options?: {readonly recursive?: boolean}) =>
  runFileSystem(FileSystem.FileSystem.pipe(Effect.flatMap(fileSystem => fileSystem.makeDirectory(path, options))));

export const mkdtemp = (prefix: string) =>
  runFileSystem(FileSystem.FileSystem.pipe(Effect.flatMap(fileSystem => fileSystem.makeTempDirectory({prefix}))));

export const readFile = (path: string, _encoding: 'utf8') =>
  runFileSystem(FileSystem.FileSystem.pipe(Effect.flatMap(fileSystem => fileSystem.readFileString(path))));

export const rm = (path: string, options?: {readonly force?: boolean; readonly recursive?: boolean}) =>
  runFileSystem(FileSystem.FileSystem.pipe(Effect.flatMap(fileSystem => fileSystem.remove(path, options))));

export const stat = async (path: string) => {
  const info = await runFileSystem(FileSystem.FileSystem.pipe(Effect.flatMap(fileSystem => fileSystem.stat(path))));
  return {
    isFile: () => info.type === 'File',
    mode: info.mode,
    mtimeMs: Option.getOrElse(info.mtime, () => new Date(0)).getTime(),
    size: Number(info.size),
  };
};

export const symlink = (target: string, path: string, _type?: 'dir') =>
  runFileSystem(FileSystem.FileSystem.pipe(Effect.flatMap(fileSystem => fileSystem.symlink(target, path))));

export const utimes = (path: string, atime: Date | number, mtime: Date | number) =>
  runFileSystem(FileSystem.FileSystem.pipe(Effect.flatMap(fileSystem => fileSystem.utimes(path, atime, mtime))));

export const writeFile = (
  path: string,
  data: string,
  encodingOrOptions?: 'utf8' | {readonly encoding?: 'utf8'; readonly mode?: number},
) =>
  runFileSystem(
    FileSystem.FileSystem.pipe(
      Effect.flatMap(fileSystem =>
        fileSystem.writeFileString(path, data, typeof encodingOrOptions === 'object' ? encodingOrOptions : undefined),
      ),
    ),
  );
