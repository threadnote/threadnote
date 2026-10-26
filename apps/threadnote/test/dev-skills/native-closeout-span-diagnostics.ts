import {Option, Tracer} from 'effect';

// Test-only closed labels. Never copy attributes, arguments, names outside this set,
// links, trace/span identifiers, results or error messages into diagnostic output.
const labels = new Set([
  'workflowMemory.readOptional',
  'workflowMemory.journalPath',
  'workflowMemory.readJournalFile',
  'workflowMemory.writeJournalFile',
  'workflowMemory.reconcileManifest',
  'workflowMemory.loadJournal',
  'workflowMemory.inspectJournal',
  'workflowMemory.validateTransition',
  'workflowMemory.transition',
  'workflowMemory.persistState',
  'workflowMemory.allowedScopes',
  'workflowMemory.strictRead',
  'workflowMemory.readArtifact',
  'workflowMemory.prepareOperation',
  'workflowMemory.executeOperation',
  'workflowMemory.sharedRoots',
  'workflowMemory.resolveConfiguredProfile',
  'workflowMemory.verifyBinding',
  'workflowAutomation.readState',
  'workflowAutomation.writeState',
  'workflowAutomation.stateBytes',
  'workflowAutomation.readCloseoutBytes',
  'workflowAutomation.readCloseoutJournal',
  'workflowAutomation.writeCloseoutJournal',
  'workflowAutomation.cycle.captureSource',
  'workflowAutomation.cycle.resolveObject',
  'workflowAutomation.cycle.canonicalRepo',
  'recall.resolveMemoryIdentityAliases',
  'recall.verifyResolvedMemoryIdentity',
  'recall.loadMemoryIdentities',
  'recall.loadIndexDataInternal',
  'recall.executeIndexQuery',
  'recall.ensureDatabaseFresh',
  'recall.refreshDatabase',
  'recall.refreshDerivedIndexesAfterCanonicalMutation',
  'recall.refreshDerivedIndexesFromSelection',
  'recall.refreshDerivedLexicalIndex',
  'recall.refreshDerivedVectorIndex',
  'memoryCodeCitation.resolveGraphProject',
  'memoryCodeCitation.capture',
  'memoryCodeCitation.captureRepositoryGroup',
  'memoryCodeCitation.captureFile',
  'memoryCodeCitation.requireExpectedCallerIdentity',
  'memoryCodeCitation.requireExpectedProjectScope',
  'memoryCodeCitation.captureSymbol',
  'workflowMemory.resolveBinding',
  'utils.gitValue',
  'runCommandEffect',
  'CommandExecutor.execute',
  'closeout.stage.application-scope',
  'closeout.stage.body',
  'closeout.stage.fixture',
  'closeout.stage.provisioning',
  'closeout.stage.fixture-git',
  'closeout.stage.cloud-profile',
  'closeout.stage.init',
  'closeout.stage.save',
  'closeout.stage.graph-ready',
  'closeout.stage.read',
  'closeout.stage.write',
  'closeout.stage.load',
  'closeout.stage.controller-state',
  'closeout.stage.schema',
  'closeout.stage.validation-input',
  'closeout.stage.prepare',
  'closeout.stage.finish',
  'closeout.stage.inspect',
  'closeout.stage.publication-preview',
  'closeout.stage.status-before',
  'closeout.stage.index',
  'closeout.stage.status-after',
  'closeout.stage.other',
]);
const bounded = (value: number) => Math.min(2_147_483_647, Math.max(0, Math.round(value)));
type Entry = {sequence: number; stage: string; parent: string; startedMs: number};

export const closeoutSpanDiagnostics = (now = () => performance.now()) => {
  const totals: Record<string, {started: number; ended: number; failures: number; inclusiveMs: number}> =
    Object.create(null);
  const selected = new WeakMap<object, string>();
  const active = new Map<number, Entry>();
  const recent: (Entry & {inclusiveMs: number; outcome: 'Success' | 'Failure'})[] = [];
  let sequence = 0;
  let activeCount = 0;
  let recentDropped = 0;
  let lastClock = 0;
  const clock = () => {
    try {
      const value = now();
      if (Number.isFinite(value)) lastClock = Math.max(lastClock, value);
    } catch {
      // Observation must not depend on the diagnostic clock being available.
    }
    return lastClock;
  };
  // Diagnostic elapsed time uses this clock; completed inclusive durations use
  // Effect's native nanosecond timestamps. Do not subtract across these clocks.
  const origin = clock();
  const elapsed = () => bounded(clock() - origin);
  const tracer = Tracer.make({
    span(options) {
      // Delegate all native span behavior/propagation. Unselected spans are untouched.
      const span = new Tracer.NativeSpan(options);
      if (!labels.has(options.name)) return span;
      try {
        selected.set(span, options.name);
        const total = (totals[options.name] ??= {started: 0, ended: 0, failures: 0, inclusiveMs: 0});
        total.started = bounded(total.started + 1);
        let parent = 'unobserved';
        let ancestor = options.parent;
        for (let depth = 0; depth < 64 && Option.isSome(ancestor); depth++) {
          const known = selected.get(ancestor.value);
          if (known) {
            parent = known;
            break;
          }
          ancestor = ancestor.value._tag === 'Span' ? ancestor.value.parent : Option.none();
        }
        const entry = {sequence: (sequence = bounded(sequence + 1)), stage: options.name, parent, startedMs: elapsed()};
        activeCount = bounded(activeCount + 1);
        if (active.size < 8) active.set(entry.sequence, entry);
        const end = span.end.bind(span);
        let ended = false;
        span.end = (at, exit) => {
          end(at, exit);
          try {
            if (ended) return;
            ended = true;
            activeCount = Math.max(0, activeCount - 1);
            active.delete(entry.sequence);
            total.ended = bounded(total.ended + 1);
            if (exit._tag === 'Failure') total.failures = bounded(total.failures + 1);
            // These inclusive durations overlap for nested/concurrent spans. They
            // are never added across labels or subtracted as exclusive child time.
            const inclusiveMs = bounded(Number(at - options.startTime) / 1_000_000);
            total.inclusiveMs = bounded(total.inclusiveMs + inclusiveMs);
            recent.push({...entry, inclusiveMs, outcome: exit._tag});
            if (recent.length > 32) {
              recent.shift();
              recentDropped = bounded(recentDropped + 1);
            }
          } catch {
            /* Observation must not change native span completion. */
          }
        };
      } catch {
        /* Observation must not prevent returning the real span. */
      }
      return span;
    },
  });
  return {
    tracer,
    snapshot: () => {
      const at = elapsed();
      return {
        version: 1,
        timing: 'inclusive-span-ms' as const,
        totals: Object.fromEntries(Object.entries(totals).map(([label, total]) => [label, {...total}])),
        activeCount,
        unlistedActiveCount: activeCount - active.size,
        active: [...active.values()].map(entry => ({...entry, elapsedMs: bounded(at - entry.startedMs)})),
        recent: recent.map(entry => ({...entry})),
        recentDropped,
      };
    },
  };
};
