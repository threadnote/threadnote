import {resolve, relative} from 'node:path';

const root = process.cwd();
const probe = import.meta.dir;
const distribution = resolve(Bun.argv[2]);
const output = resolve(distribution, 'threadnote');
const release = await Bun.file(resolve(distribution, 'release.json')).json();

const workerFile = Bun.argv[3] ?? 'apps/threadnote/src/recall/ready_read_worker.ts';
const workerSource = await Bun.file(resolve(root, workerFile)).text();
const serveAnchor = 'const served = yield* serveRecallReadyRead(request);';
const serve = workerSource.includes(serveAnchor) ? serveAnchor : 'const served = yield* serve(request);';
const patches = new Map<string, [string, string][]>([
  ['apps/threadnote/src/standalone.ts', [
    ['if (process.argv[2] === RECALL_READY_READ_WORKER_ARGUMENT) {',
      'if (process.argv[2] === RECALL_READY_READ_WORKER_ARGUMENT) {\n  markProbe("entry");'],
  ]],
  [workerFile, [
    ['  const request = yield* readRequest;',
      '  markProbe("read");\n  const request = yield* readRequest;\n  markProbe("decoded-" + request.operation);'],
    [serve, serve + '\n  markProbe("served");'],
    ['  yield* Stream.run(Stream.make(bytes), stdio.stdout({endOnDone: false}));',
      '  yield* Stream.run(Stream.make(bytes), stdio.stdout({endOnDone: false}));\n  markProbe("written");'],
  ]],
]);

const transformed = new Set<string>();
const result = await Bun.build({
  compile: {
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadPackageJson: false,
    autoloadTsconfig: false,
    outfile: output,
    target: release.sourceIdentity.target,
  },
  define: {
    'process.env.MSGPACKR_NATIVE_ACCELERATION_DISABLED': JSON.stringify('true'),
    THREADNOTE_STANDALONE: 'true',
    THREADNOTE_VERSION: JSON.stringify(release.version),
    THREADNOTE_RUNTIME_SOURCE_IDENTITY: JSON.stringify(release.sourceIdentity),
  },
  bytecode: true,
  entrypoints: [resolve(root, 'apps/threadnote/src/standalone.ts')],
  format: 'esm',
  minify: true,
  sourcemap: 'linked',
  target: 'bun',
  plugins: [{
    name: 'compiled-worker-diagnostic-markers',
    setup(builder) {
      builder.onLoad({filter: /\.ts$/}, async args => {
        const name = relative(root, args.path);
        const changes = patches.get(name);
        if (!changes) return;
        let source = await Bun.file(args.path).text();
        for (const [anchor, replacement] of changes) {
          if (source.split(anchor).length !== 2) throw Error(`Ambiguous or absent marker in ${name}: ${anchor}`);
          source = source.replace(anchor, replacement);
        }
        transformed.add(name);
        return {
          loader: 'ts',
          contents: `import {markProbe} from ${JSON.stringify(resolve(probe, 'stage-markers.ts'))};\n${source}`,
        };
      });
    },
  }],
});
if (!result.success) throw new AggregateError(result.logs);
if (transformed.size !== patches.size) throw Error(`Missing transforms: ${[...patches.keys()].filter(k => !transformed.has(k)).join(', ')}`);
console.log(JSON.stringify({diagnostic: true, sourceIdentity: release.sourceIdentity, transformed: [...transformed], output}));
