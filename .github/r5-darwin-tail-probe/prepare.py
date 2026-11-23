from pathlib import Path

src = Path('scripts/benchmark-recall-vectors.ts').read_text()

def replace(old, new):
    global src
    assert src.count(old) == 1, old
    src = src.replace(old, new)

replace("type ProductionBackend = 'baseline' | 'candidate';",
        "type ProductionBackend = 'baseline' | 'candidate' | 'trace';")
replace('    const executableFor = (backend: ProductionBackend) =>\n      path.join(',
        """    const traceRoot = path.resolve('.context/darwin-recall-probe/trace-dist');
    const traceInventory = yield* productionDistributionInventory(traceRoot);
    const samePayloads = (inventory: typeof inputInventory) =>
      inventory.filter(file => file.path !== release.executable && file.path !== release.executable + '.map');
    if (JSON.stringify(samePayloads(traceInventory)) !== JSON.stringify(samePayloads(candidateInventory))) {
      return yield* ScriptError.make({message: 'Traced and untraced native payloads differ.'});
    }
    let phaseContext = 'setup';
    const executableFor = (backend: ProductionBackend) => backend === 'trace'
      ? path.join(traceRoot, release.executable)
      : path.join(""")
replace('      executableVerification,','      traceInventory,\n      executableVerification,')
replace('        const selected = {\n          ...system,',"""        if (backend === 'trace') {
          environment.THREADNOTE_DARWIN_VECTOR_PROBE_LOG = options.output + '.stages.jsonl';
          environment.THREADNOTE_DARWIN_VECTOR_PROBE_CONTEXT = phaseContext + '/' + sample;
        }
        const selected = {
          ...system,""")
replace("      for (const backend of ['baseline', 'candidate'] as const)\n        proof.push(",
        "      for (const backend of ['baseline', 'candidate', 'trace'] as const)\n        proof.push(")
replace("if (!engineProofPassed())", "if (!engineProofPassed() || !proof[2]?.result.success)")
replace("        const order: readonly ProductionBackend[] =\n          pair % 2 === 1 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];",
        """        phaseContext = 'warm/' + pair;
        const orders: readonly (readonly ProductionBackend[])[] = [
          ['baseline', 'candidate', 'trace'], ['candidate', 'trace', 'baseline'],
          ['trace', 'baseline', 'candidate'], ['trace', 'candidate', 'baseline'],
          ['candidate', 'baseline', 'trace'], ['baseline', 'trace', 'candidate'],
        ];
        const order = orders[(pair - 1) % orders.length];""")
replace('      closingSource = yield* productionSourceFence(',
        """      if (JSON.stringify(traceInventory) !== JSON.stringify(yield* productionDistributionInventory(traceRoot)))
        return yield* ScriptError.make({message: 'Traced distribution changed during measurement.'});
      closingSource = yield* productionSourceFence(""")
replace('let lastQueryVector: readonly number[] = [];',
        'let lastQueryVector: readonly number[] = [];\nlet lastEmbeddingMilliseconds: number | undefined;')
replace('? real.embedMany(request).pipe(', '''? Effect.suspend(() => {
                  const begin = performance.now();
                  return real.embedMany(request).pipe(
                    Effect.ensuring(Effect.sync(() => { lastEmbeddingMilliseconds = performance.now() - begin; })),
                  );
                }).pipe(''')
replace('        lastQueryVector = [];', '        lastQueryVector = [];\n        lastEmbeddingMilliseconds = undefined;')
replace("        if (result._tag === 'Failure') {\n          const reason =",
        '''        if (lastEmbeddingMilliseconds !== undefined)
          children.push({operation: 'parent-embedding', milliseconds: lastEmbeddingMilliseconds, timeoutMs: undefined});
        if (result._tag === 'Failure') {
          const reason =''')
replace("    let phaseContext = 'setup';", """    let phaseContext = 'setup';
    const scaleTraceRequests: ProductionQuerySample[] = [];""")
replace('      traceInventory,','      traceInventory,\n      scaleTraceRequests,')
replace('      const discriminatorStartedAt = yield* Clock.currentTimeNanos;', """      if (options.documents === 100_000) {
        phaseContext = 'scale-diagnostic';
        for (let sample = 0; sample < Math.min(6, options.samples); sample++)
          scaleTraceRequests.push(yield* executeQuery('trace', fixture, sample));
        phaseContext = 'setup';
      }
      const discriminatorStartedAt = yield* Clock.currentTimeNanos;""")
Path('scripts/r5-darwin-tail-observe.ts').write_text(src)
