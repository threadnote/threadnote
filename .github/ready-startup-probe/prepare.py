from pathlib import Path

src = Path("scripts/benchmark-recall-vectors.ts").read_text()


def replace(old, new, count=1):
    global src
    if src.count(old) != count:
        raise RuntimeError(f"Cannot adapt stock benchmark: {old}")
    src = src.replace(old, new)


replace(
    "type ProductionBackend = 'baseline' | 'candidate';",
    """type ProductionBackend = 'baseline' | 'candidate' | 'baseline-trace' | 'candidate-trace';
const backends = ['baseline', 'candidate', 'baseline-trace', 'candidate-trace'] as const;
const orders = [[0, 1, 3, 2], [1, 2, 0, 3], [2, 3, 1, 0], [3, 0, 2, 1]] as const;""",
)
replace(
    "    const baselineEvidence = yield* verifyFrozenBaseline(baselineDistributionRoot, release.sourceIdentity.target);",
    """    const baselineEvidence = yield* (Effect.gen(function* () {
      const baselineRelease = JSON.parse(yield* fs.readFileString(path.join(baselineDistributionRoot, 'release.json')));
      const baselineNative = yield* Effect.tryPromise({
        try: () => verifyNativeVectorReaderPayload(path.join(baselineDistributionRoot, 'runtime', 'vector-reader', 'manifest.json')),
        catch: scriptError,
      });
      const expectedStock = process.env.THREADNOTE_STARTUP_STOCK_COMMIT;
      const expectedCandidate = process.env.THREADNOTE_STARTUP_CANDIDATE_COMMIT;
      if (
        baselineNative.development ||
        baselineRelease.sourceIdentity.commit !== expectedStock ||
        baselineRelease.sourceIdentity.commit !== baselineNative.buildInfo.sourceCommit ||
        baselineRelease.sourceIdentity.tree !== baselineNative.buildInfo.sourceTree ||
        baselineRelease.sourceIdentity.target !== release.sourceIdentity.target ||
        baselineNative.bunTarget !== release.sourceIdentity.target ||
        baselineRelease.sourceIdentity.bun !== Bun.version ||
        release.sourceIdentity.commit !== expectedCandidate ||
        baselineNative.buildInfo.sqliteSourceId !== nativeManifest.buildInfo.sqliteSourceId
      ) return yield* ScriptError.make({message: 'Stock and candidate executable/native identities differ from their requested source or platform.'});
      return {release: baselineRelease, nativeManifest: baselineNative, finalInventory: yield* productionDistributionInventory(baselineDistributionRoot)};
    }));""",
)
replace(
    """    const executableFor = (backend: ProductionBackend) =>
      path.join(
        backend === 'candidate' ? candidateRoot : baselineRoot,
        backend === 'candidate' ? release.executable : baselineEvidence.release.executable,
      );""",
    """    const traceRoots = [
      path.resolve(process.env.THREADNOTE_STARTUP_STOCK_TRACE!),
      path.resolve(process.env.THREADNOTE_STARTUP_CANDIDATE_TRACE!),
    ] as const;
    const traceInventories = yield* Effect.forEach(traceRoots, productionDistributionInventory);
    const payloadOnly = (inventory: typeof inputInventory, exe: string) =>
      inventory.filter(file => file.path !== exe && file.path !== exe + '.map');
    if (JSON.stringify(payloadOnly(traceInventories[0], baselineEvidence.release.executable)) !==
        JSON.stringify(payloadOnly(baselineInventory, baselineEvidence.release.executable)) ||
        JSON.stringify(payloadOnly(traceInventories[1], release.executable)) !==
        JSON.stringify(payloadOnly(candidateInventory, release.executable)))
      return yield* ScriptError.make({message: 'Instrumented executable sidecars differ from uninstrumented controls.'});
    const executables = {
      baseline: path.join(baselineRoot, baselineEvidence.release.executable),
      candidate: path.join(candidateRoot, release.executable),
      'baseline-trace': path.join(traceRoots[0], baselineEvidence.release.executable),
      'candidate-trace': path.join(traceRoots[1], release.executable),
    };
    const executableFor = (backend: ProductionBackend) => executables[backend];
    let phase = 'first-use';""",
)
replace("      executableVerification,", "      executableVerification,\n      traceInventories,\n      executables,")
replace(
    "        const selected = {\n          ...system,",
    """        if (backend.endsWith('-trace')) {
          environment.THREADNOTE_STARTUP_PROBE_LOG = options.output + '.stages.jsonl';
          environment.THREADNOTE_STARTUP_PROBE_REQUEST = phase + '/' + backend + '/' + sample;
        }
        const selected = {
          ...system,""",
)
replace(
    "              const reply = yield* command.execute(executable, args, requestOptions).pipe(Effect.result);",
    """              const launchEpochMilliseconds = backend.endsWith('-trace') ? performance.timeOrigin + performance.now() : undefined;
              const reply = yield* command.execute(executable, args, requestOptions).pipe(Effect.result);""",
)
replace(
    "{operation: string; milliseconds: number; timeoutMs: number | undefined}",
    "{operation: string; milliseconds: number; timeoutMs: number | undefined; launchEpochMilliseconds?: number}",
    count=2,
)
replace(
    "                timeoutMs: requestOptions?.timeoutMs,",
    "                timeoutMs: requestOptions?.timeoutMs,\n                launchEpochMilliseconds,",
)
replace("for (const backend of ['baseline', 'candidate'] as const)", "for (const backend of backends)", count=3)
replace(
    "      const discriminatorStartedAt = yield* Clock.currentTimeNanos;",
    "      phase = 'native-proof';\n      const discriminatorStartedAt = yield* Clock.currentTimeNanos;",
)
replace(
    "      // The oracle reads original stored bytes; native must return them, TS must fail strict validation.",
    "      // Both native builds must return the original stored bytes through the native-specific view.",
)
replace(
    "if (proof[0]?.result.success || proof[0]?.result.reason !== 'worker-failed' || !proof[1]?.result.success)",
    "if (proof.length !== backends.length || proof.some(entry => !entry.result.success))",
)
replace(
    "Actual compiled native/TypeScript engine proof failed; capture is unqualified.",
    "Actual compiled native engine proof failed for at least one arm.",
)
replace(
    """        const order: readonly ProductionBackend[] =
          pair % 2 === 1 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];""",
    """        phase = 'warm/' + pair;
        const order = orders[(pair - 1) % orders.length].map(index => backends[index]);""",
)
replace(
    "      closingSource = yield* productionSourceFence(nativeManifest.buildInfo.sourceCommit);",
    """      const closingTraceInventories = yield* Effect.forEach(traceRoots, productionDistributionInventory);
      if (JSON.stringify(traceInventories) !== JSON.stringify(closingTraceInventories))
        return yield* ScriptError.make({message: 'Instrumented distribution changed during measurement.'});
      closingSource = yield* productionSourceFence(nativeManifest.buildInfo.sourceCommit);""",
)
Path("scripts/ready-startup-observe.ts").write_text(src)
