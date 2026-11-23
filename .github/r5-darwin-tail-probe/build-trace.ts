import {resolve, relative} from 'node:path';

const root = process.cwd();
const probe = resolve(root, '.context/darwin-recall-probe');
const release = await Bun.file(resolve(root, 'dist/release.json')).json();
const output = resolve(probe, 'trace-dist/threadnote');
const mark = (event: string) => `markProbe(${JSON.stringify(event)});`;

const patches = new Map<string, [anchor: string, replacement: string][]>([
  ['apps/threadnote/src/standalone.ts', [
    ['if (process.argv[2] === RECALL_READY_READ_WORKER_ARGUMENT) {',
      'if (process.argv[2] === RECALL_READY_READ_WORKER_ARGUMENT) {\n  ' + mark('worker.entry')],
  ]],
  ['apps/threadnote/src/recall/ready_read_entry.ts', [
    ['export function runReadyRecallReadWorker(arguments_: readonly string[]) {',
      'export function runReadyRecallReadWorker(arguments_: readonly string[]) {\n  ' + mark('worker.setup')],
  ]],
  ['apps/threadnote/src/recall/ready_read_worker.ts', [
    ['  const request = yield* readRequest;',
      '  ' + mark('request.read') + '\n  const request = yield* readRequest;\n  markProbe(request.operation + ".decoded");'],
    ['  const served = yield* serveRecallReadyRead(request);',
      '  const served = yield* serveRecallReadyRead(request);\n  ' + mark('request.served')],
    ['  yield* Stream.run(Stream.make(bytes), stdio.stdout({endOnDone: false}));',
      '  yield* Stream.run(Stream.make(bytes), stdio.stdout({endOnDone: false}));\n  ' + mark('request.written')],
  ]],
  ['packages/recall/src/vector-index.ts', [
    ['  validateCanonicalScores = false,\n) {', '  validateCanonicalScores = false,\n) {\n  ' + mark('vector.enter')],
    ['  const binding = yield* requiredNativeVectorReader;',
      '  ' + mark('payload.begin') + '\n  const binding = yield* requiredNativeVectorReader;\n  ' + mark('payload.end')],
    ['    const openingCorpus = yield* verifyCurrentCorpusGeneration(manifest, options).pipe(Effect.result);',
      '    ' + mark('open-lexical.begin') +
      '\n    const openingCorpus = yield* verifyCurrentCorpusGeneration(manifest, options).pipe(Effect.result);\n    ' +
      mark('open-lexical.end')],
    ['    const result = yield* runNativeVectorRead(binding, nativeRequest, query);',
      '    ' + mark('native-call.begin') + '\n    const result = yield* runNativeVectorRead(binding, nativeRequest, query);\n    ' +
      mark('native-call.end')],
    ['  const scores = yield* selectedRead;', '  const scores = yield* selectedRead;\n  ' + mark('closing.begin')],
    ['    const current = yield* readRecallIndexData(', '    '+mark('canonical.begin')+'\n    const current = yield* readRecallIndexData('],
    ['    const currentUris = new Set(', '    '+mark('canonical.end')+'\n    const currentUris = new Set('],
    ['  return scores;\n});\n\nexport const vectorIndexStatus',
      '  ' + mark('closing.end') + '\n  return scores;\n});\n\nexport const vectorIndexStatus'],
  ]],
  ['packages/recall/src/index.ts', [
    ['    let result: unknown = yield*', '    '+mark('selector.begin')+'\n    let result: unknown = yield*'],
    ['      const validated = yield* validateRecallReadyResult(', '      '+mark('validation.begin')+'\n      const validated = yield* validateRecallReadyResult('],
    ['      result = validated.result;', '      '+mark('validation.end')+'\n      result = validated.result;'],
  ]],
  ['packages/recall/src/index/ready_result.ts', [
    ['  const validate = yield* makeRecallReadyValidator(config, projected);', '  '+mark('validator.prepare.begin')+'\n  const validate = yield* makeRecallReadyValidator(config, projected);\n  '+mark('validator.prepare.end')],
  ]],
  ['packages/recall/src/vector/native-reader-payload.ts', [
    ['  const manifest = await verifyNativeVectorReaderPayload(manifestPath);',
      '  ' + mark('payload.verify.begin') + '\n  const manifest = await verifyNativeVectorReaderPayload(manifestPath);\n  ' +
      mark('payload.verify.end')],
    ['  process.dlopen(nativeModule, path.join(path.dirname(manifestPath), manifest.binary));',
      '  ' + mark('payload.dlopen.begin') + '\n  process.dlopen(nativeModule, path.join(path.dirname(manifestPath), manifest.binary));\n  ' +
      mark('payload.dlopen.end')],
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
      builder.onLoad({filter: /(?:standalone|ready_read_entry|ready_read_worker|vector-index|native-reader-payload|index|ready_result)\.ts$/}, async args => {
        const name = relative(root, args.path);
        const changes = patches.get(name);
        if (changes === undefined) return;
        let source = await Bun.file(args.path).text();
        for (const [anchor, replacement] of changes) {
          if (source.split(anchor).length !== 2) throw Error(`Ambiguous or absent probe marker in ${name}: ${anchor}`);
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
if (transformed.size !== patches.size) throw Error(`Missing probe transforms: ${[...patches.keys()].filter(k => !transformed.has(k)).join(', ')}`);
console.log(JSON.stringify({diagnostic: true, sourceIdentity: release.sourceIdentity, transformed: [...transformed], output}));
