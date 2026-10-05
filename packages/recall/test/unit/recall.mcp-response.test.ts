import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {projectRecallMcpResponse, RECALL_MCP_RESPONSE_MINIMUM_ESTIMATED_TOKENS} from '@threadnote/recall/mcp/response';
import {lexicalIndexUnavailableWarning} from '@threadnote/recall/warning';
import type {RecallHit} from '@threadnote/recall/results';

function hit(index: number, options: Partial<RecallHit> = {}): RecallHit {
  return {
    category: 'memories',
    contextType: 'memory',
    finalScore: 0.73456,
    rankReasons: [{code: 'exact_term_match', contribution: 0.18, detail: 'Exact terms matched the memory.'}],
    rankSignals: {
      authority: 0.6,
      bm25: 0.4,
      exact: 0.8,
      feedback: 0,
      field: 0.5,
      freshness: 1,
      graph: 0,
      kindIntent: 0,
      lifecycle: 1,
      reranker: 0,
      scope: 1,
      semantic: 0,
      temporal: 1,
      workspace: 0,
    },
    rankWarnings: ['lexical-only result'],
    score: 0,
    snippet: `memory ${index}`,
    uri: `threadnote://user/test/memories/durable/projects/threadnote/memory-${index}.md`,
    ...options,
  };
}

function logical(results: readonly RecallHit[], notices: readonly string[] = []) {
  return {
    confidence: {level: 'medium' as const, margin: 0.2, reason: 'Useful match.', score: 0.73},
    notices,
    queryExpansions: ['expanded query'],
    rankerVersion: 'hybrid-v5',
    results,
  };
}

function seededNavigation(results: readonly RecallHit[]) {
  return {
    ...logical(results),
    confidence: {
      level: 'no_answer' as const,
      margin: 0,
      reason: 'No candidate passed the minimum combined relevance threshold.',
      score: 0,
    },
    memoryConnections: {
      candidates: [],
      connections: results.map((result, relationOrdinal) => ({
        currentness: 'current' as const,
        direction: 'outgoing' as const,
        distance: 1 as const,
        neighborMemoryId: `tn_direct_${relationOrdinal}`,
        neighborUri: result.uri,
        origin: 'relation' as const,
        relationOrdinal,
        relationType: 'evidence_for' as const,
        requestedOrdinal: 0,
        resolution: 'resolved' as const,
        sourceMemoryId: 'tn_seed',
      })),
      coverage: {
        connectionCount: results.length,
        premiseCount: 1,
        resultCount: results.length,
        truncated: false,
        version: 1 as const,
      },
      diagnostics: {
        canonicalMismatches: 0,
        canonicalRereads: results.length + 1,
        rawLinkRows: results.length,
        refreshRepairs: 0,
        truncatedSeedOrdinals: [],
      },
      premises: [
        {
          memoryId: 'tn_seed',
          requestedOrdinal: 0,
          requestedRef: 'threadnote://memory/tn_seed',
          state: 'current' as const,
        },
      ],
    },
  };
}

describe('recall MCP response projection', () => {
  it('rejects budgets that cannot fit the required dual-channel envelope', () => {
    expect(() =>
      projectRecallMcpResponse(logical([]), {
        budgetTokens: RECALL_MCP_RESPONSE_MINIMUM_ESTIMATED_TOKENS - 1,
      }),
    ).toThrow(
      `Recall response budget must be an integer from ${RECALL_MCP_RESPONSE_MINIMUM_ESTIMATED_TOKENS} to 1500.`,
    );
  });

  it('surfaces all normal-workflow feedback actions and distinguishes applied', () => {
    const projected = projectRecallMcpResponse(logical([hit(1)]), {responseFormat: 'dual'});

    expect(projected.text).toContain('recall_feedback useful|wrong|pin|dismiss|applied');
  });

  it('defaults to a deterministic text-only semantic agent projection', () => {
    const firstHit = hit(1, {
      rankReasons: [
        {code: 'exact_term_match', contribution: 0.18, detail: 'Quoted\tvalue\nwith \\ unicode: 🚀\u001b\u2028'},
      ],
      uri: 'threadnote://user/test/memories/durable/projects/threadnote/a path/🚀.md',
    });
    const response = {
      ...seededNavigation([firstHit]),
      memoryScope: {root: 'threadnote://shared/team/memories', type: 'threadnote-memory-scope', version: 1},
      notices: ['A notice with a tab\tand newline\n'],
      warnings: [lexicalIndexUnavailableWarning()],
    };
    const first = projectRecallMcpResponse(response, {explain: true});
    const second = projectRecallMcpResponse(response, {explain: true});

    expect(first).toEqual(second);
    expect(first.responseFormat).toBe('agent');
    expect(first.measurement.structuredBytes).toBe(0);
    expect(first.text).toMatch(/^TN-RECALL\/1\n/);
    expect(first.text).toContain(firstHit.uri.replace(/\s+/gu, ' '));
    expect(first.text).toContain('1. Memory, confidence');
    expect(first.text).toContain('Connection 1:');
    expect(first.text).toContain('Premise 1:');
    expect(first.text).toContain('Memory scope:');
    expect(first.text).toContain('Confidence:');
    expect(first.text).toContain('Read first with read_context: 1.');
    expect(first.text).toContain('Notice:');
    expect(first.text).toContain('Recall index warning:');
    expect(first.text).toContain('Quoted value with \\ unicode: 🚀');
    expect(first.text).not.toContain('\u001b');
    expect(first.text).not.toContain('\u2028');
    expect(first.text).not.toContain('recall_feedback');
    expect(first.text).not.toContain('Quoted\tvalue\nwith');
  });

  it('keeps the legacy dual channels only when explicitly requested', () => {
    const projected = projectRecallMcpResponse(logical([hit(1)]), {responseFormat: 'dual'});

    expect(projected.responseFormat).toBe('dual');
    expect(projected.measurement.structuredBytes).toBeGreaterThan(0);
    expect(projected.text).toContain('Recall returned 1/1 unread pointer(s)');
  });

  it('retains at least as many ranked pointers as dual under the same transport budget', () => {
    const response = logical(
      Array.from({length: 30}, (_, index) =>
        hit(index, {
          rankReasons: [
            {
              code: 'exact_term_match',
              contribution: 0.18,
              detail: `Matched the requested implementation contract at rank ${index}`,
            },
          ],
          uri: `threadnote://user/test/memories/durable/projects/threadnote/token-efficient-result-${index}.md`,
        }),
      ),
    );
    const agent = projectRecallMcpResponse(response, {budgetTokens: 1_500});
    const dual = projectRecallMcpResponse(response, {budgetTokens: 1_500, responseFormat: 'dual'});

    expect(agent.structuredContent.results.length).toBeGreaterThanOrEqual(dual.structuredContent.results.length);
    expect(agent.measurement.totalBytes / agent.structuredContent.results.length).toBeLessThan(
      dual.measurement.totalBytes / dual.structuredContent.results.length,
    );
    expect(agent.measurement.totalBytes).toBeLessThanOrEqual(1_500 * 3);
    expect(dual.measurement.totalBytes).toBeLessThanOrEqual(1_500 * 3);
  });

  it('fits bounded notices, scope, and degraded-index guidance at the advertised minimum', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z0-9 -]{1,240}$/), {maxLength: 8, selector: value => value}),
        fc.stringMatching(/^[a-z0-9-]{1,128}$/),
        (notices, team) => {
          const projected = projectRecallMcpResponse(
            {
              ...logical([], notices),
              memoryScope: {
                mode: 'cloud',
                root: `threadnote://shared/${team}/memories`,
                team,
                type: 'threadnote-memory-scope',
                version: 1 as const,
              },
              warnings: [lexicalIndexUnavailableWarning()],
            },
            {budgetTokens: RECALL_MCP_RESPONSE_MINIMUM_ESTIMATED_TOKENS},
          );

          expect(projected.measurement.totalBytes).toBeLessThanOrEqual(
            RECALL_MCP_RESPONSE_MINIMUM_ESTIMATED_TOKENS * 3,
          );
        },
      ),
      {numRuns: 100},
    );
  });

  it('keeps degraded lexical state typed and visible when no pointer is available', () => {
    const warning = lexicalIndexUnavailableWarning();
    const projected = projectRecallMcpResponse(
      {...logical([]), warnings: [warning, warning]},
      {responseFormat: 'dual'},
    );

    expect(projected.structuredContent.results).toEqual([]);
    expect(projected.structuredContent.warnings).toEqual([warning]);
    expect(projected.text).toContain('Recall returned 0/0 unread pointer(s)');
    expect(projected.text).toContain('Recall index warning:');
    expect(projected.text).toContain(warning.remediation);
  });

  it('returns a compact unread queue by default and restores ranking detail only with explain', () => {
    const compact = projectRecallMcpResponse(logical([hit(1)]), {budgetTokens: 1_500, responseFormat: 'dual'});

    expect(compact.structuredContent.confidence?.basis).toBe('ranked-relevance');
    expect(compact.structuredContent).toMatchObject({
      nextAction: {
        tool: 'read_context',
        uris: ['threadnote://user/test/memories/durable/projects/threadnote/memory-1.md'],
      },
      output: {explain: false, omittedResults: 0, returnedResults: 1, truncated: false},
      rankerVersion: 'hybrid-v5',
      results: [
        {
          category: 'memories',
          confidence: 0.735,
          readState: 'unread',
          reason: 'Exact terms matched the memory.',
        },
      ],
    });
    expect(compact.structuredContent).not.toHaveProperty('queryExpansions');
    expect(compact.structuredContent.results[0]).not.toHaveProperty('reasons');
    expect(compact.structuredContent.results[0]).not.toHaveProperty('signals');
    expect(compact.text).toContain('Ranked pointers are not evidence');

    const explained = projectRecallMcpResponse(logical([hit(1)]), {
      budgetTokens: 1_500,
      explain: true,
      responseFormat: 'dual',
    });
    expect(explained.structuredContent.output).toMatchObject({explain: true, explainDetails: 'included'});
    expect(explained.structuredContent.queryExpansions).toEqual(['expanded query']);
    expect(explained.structuredContent.results[0]).toMatchObject({
      finalScore: 0.73456,
      rankWarnings: ['lexical-only result'],
      reasons: expect.any(Array),
      signals: expect.any(Object),
    });
  });

  it('projects bounded one-hop receipts only when seeded recall requested them', () => {
    const firstHit = hit(1);
    const omittedHit = hit(2);
    const projected = projectRecallMcpResponse(
      {
        ...logical([firstHit]),
        memoryConnections: {
          candidates: [],
          connections: [
            {
              currentness: 'current',
              direction: 'outgoing',
              distance: 1,
              neighborMemoryId: 'tn_first',
              neighborUri: firstHit.uri,
              origin: 'relation',
              relationOrdinal: 0,
              relationType: 'depends_on',
              requestedOrdinal: 0,
              resolution: 'resolved',
              sourceMemoryId: 'tn_seed',
            },
            {
              currentness: 'current',
              direction: 'outgoing',
              distance: 1,
              neighborMemoryId: 'tn_omitted',
              neighborUri: omittedHit.uri,
              origin: 'relation',
              relationOrdinal: 1,
              relationType: 'related_to',
              requestedOrdinal: 0,
              resolution: 'resolved',
              sourceMemoryId: 'tn_seed',
            },
          ],
          coverage: {
            connectionCount: 2,
            premiseCount: 1,
            resultCount: 2,
            truncated: false,
            version: 1,
          },
          diagnostics: {
            canonicalMismatches: 0,
            canonicalRereads: 3,
            rawLinkRows: 3,
            refreshRepairs: 0,
            truncatedSeedOrdinals: [],
          },
          premises: [
            {
              memoryId: 'tn_seed',
              requestedOrdinal: 0,
              requestedRef: 'threadnote://memory/tn_seed',
              state: 'current',
            },
          ],
        },
      },
      {budgetTokens: RECALL_MCP_RESPONSE_MINIMUM_ESTIMATED_TOKENS, responseFormat: 'dual'},
    );

    expect(projected.structuredContent.memoryConnections).toMatchObject({
      connections: [{neighborMemoryId: 'tn_first'}],
      coverage: {connectionCount: 1, resultCount: 1, truncated: true},
      premises: [{memoryId: 'tn_seed', state: 'current'}],
    });
    expect(projected.structuredContent.memoryConnections).not.toHaveProperty('diagnostics');
    expect(projected.text).toContain('Relations are navigation evidence, not entailment');
    expect(projected.measurement.totalBytes).toBeLessThanOrEqual(RECALL_MCP_RESPONSE_MINIMUM_ESTIMATED_TOKENS * 3);
  });

  it('budgets the maximum unresolved receipt shape at the advertised minimum', () => {
    const premises = Array.from({length: 8}, (_, requestedOrdinal) => ({
      memoryId: `tn_seed_${requestedOrdinal}`,
      requestedOrdinal,
      requestedRef: `threadnote://memory/tn_seed_${requestedOrdinal}`,
      state: 'unresolved' as const,
    }));
    const connections = Array.from({length: 32}, (_, relationOrdinal) => ({
      currentness: 'unresolved' as const,
      direction: 'outgoing' as const,
      distance: 1 as const,
      neighborMemoryId: `tn_missing_${relationOrdinal}`,
      origin: 'relation' as const,
      relationOrdinal,
      relationType: 'references' as const,
      requestedOrdinal: relationOrdinal % premises.length,
      resolution: 'unresolved' as const,
      sourceMemoryId: `tn_seed_${relationOrdinal % premises.length}`,
      targetMemoryId: `tn_missing_${relationOrdinal}`,
    }));
    const response = {
      ...logical([]),
      memoryConnections: {
        candidates: [],
        connections,
        coverage: {
          connectionCount: connections.length,
          premiseCount: premises.length,
          resultCount: 0,
          truncated: false,
          version: 1 as const,
        },
        diagnostics: {
          canonicalMismatches: 0,
          canonicalRereads: 32,
          rawLinkRows: 32,
          refreshRepairs: 0,
          truncatedSeedOrdinals: [],
        },
        premises,
      },
    };

    const first = projectRecallMcpResponse(response, {
      budgetTokens: RECALL_MCP_RESPONSE_MINIMUM_ESTIMATED_TOKENS,
    });
    const second = projectRecallMcpResponse(response, {
      budgetTokens: RECALL_MCP_RESPONSE_MINIMUM_ESTIMATED_TOKENS,
    });

    expect(first).toEqual(second);
    expect(first.measurement.totalBytes).toBeLessThanOrEqual(RECALL_MCP_RESPONSE_MINIMUM_ESTIMATED_TOKENS * 3);
    expect(first.structuredContent.memoryConnections).toMatchObject({
      coverage: {resultCount: 0, truncated: true},
    });
    expect(first.structuredContent.memoryConnections?.connections.length).toBeLessThan(connections.length);
    expect(first.structuredContent.memoryConnections?.coverage.connectionCount).toBe(
      first.structuredContent.memoryConnections?.connections.length,
    );
    expect(first.structuredContent.memoryConnections?.coverage.premiseCount).toBe(
      first.structuredContent.memoryConnections?.premises.length,
    );
    expect(first.text).toContain('Recovery: increase budgetTokens if below 1500, or narrow memoryRefs/relationTypes.');
  });

  it('counts only projected direct neighbors in seeded one-hop coverage', () => {
    const directHit = hit(1);
    const topicalHit = hit(2);
    const projected = projectRecallMcpResponse({
      ...logical([directHit, topicalHit]),
      memoryConnections: {
        candidates: [],
        connections: [
          {
            currentness: 'current',
            direction: 'outgoing',
            distance: 1,
            neighborMemoryId: 'tn_direct',
            neighborUri: directHit.uri,
            origin: 'relation',
            relationOrdinal: 0,
            relationType: 'depends_on',
            requestedOrdinal: 0,
            resolution: 'resolved',
            sourceMemoryId: 'tn_seed',
          },
        ],
        coverage: {
          connectionCount: 1,
          premiseCount: 1,
          resultCount: 1,
          truncated: false,
          version: 1,
        },
        diagnostics: {
          canonicalMismatches: 0,
          canonicalRereads: 2,
          rawLinkRows: 2,
          refreshRepairs: 0,
          truncatedSeedOrdinals: [],
        },
        premises: [
          {
            memoryId: 'tn_seed',
            requestedOrdinal: 0,
            requestedRef: 'threadnote://memory/tn_seed',
            state: 'current',
          },
        ],
      },
    });

    expect(projected.structuredContent.results.map(result => result.uri)).toEqual([directHit.uri, topicalHit.uri]);
    expect(projected.structuredContent.memoryConnections).toMatchObject({
      connections: [{neighborUri: directHit.uri}],
      coverage: {connectionCount: 1, resultCount: 1, truncated: false},
    });
  });

  it('treats a projected verified connection as high-confidence navigation, not a topical answer', () => {
    const topicalHit = hit(1);
    const directHit = hit(2);
    const projected = projectRecallMcpResponse({
      ...logical([topicalHit, directHit]),
      confidence: {
        level: 'no_answer',
        margin: 0,
        reason: 'No candidate passed the minimum combined relevance threshold.',
        score: 0,
      },
      memoryConnections: {
        candidates: [],
        connections: [
          {
            currentness: 'current',
            direction: 'outgoing',
            distance: 1,
            neighborMemoryId: 'tn_direct',
            neighborUri: directHit.uri,
            origin: 'relation',
            relationOrdinal: 0,
            relationType: 'depends_on',
            requestedOrdinal: 0,
            resolution: 'resolved',
            sourceMemoryId: 'tn_seed',
          },
        ],
        coverage: {
          connectionCount: 1,
          premiseCount: 1,
          resultCount: 1,
          truncated: false,
          version: 1,
        },
        diagnostics: {
          canonicalMismatches: 0,
          canonicalRereads: 2,
          rawLinkRows: 1,
          refreshRepairs: 0,
          truncatedSeedOrdinals: [],
        },
        premises: [
          {
            memoryId: 'tn_seed',
            requestedOrdinal: 0,
            requestedRef: 'threadnote://memory/tn_seed',
            state: 'current',
          },
        ],
      },
    });

    expect(projected.structuredContent.confidence).toEqual({
      basis: 'explicit-memory-connection',
      level: 'high',
      margin: 1,
      reason: 'Verified one-hop relation; confidence covers navigation only, not entailment.',
      score: 1,
    });
    expect(projected.structuredContent.results.map(result => result.uri)).toEqual([topicalHit.uri, directHit.uri]);
    expect(projected.structuredContent.nextAction.uris[0]).toBe(directHit.uri);
  });

  it('marks a verified seed connection as budget-limited when 700 tokens omit its pointer', () => {
    const directHit = hit(1, {
      uri: `threadnote://user/test/memories/durable/projects/threadnote/${'verified-connection-'.repeat(4)}.md`,
    });
    const response = seededNavigation([directHit]);
    const narrow = projectRecallMcpResponse(response, {budgetTokens: 700, responseFormat: 'dual'});
    const expanded = projectRecallMcpResponse(response, {budgetTokens: 1_000, responseFormat: 'dual'});

    expect(narrow.structuredContent.output).toMatchObject({budgetLimited: true, retryBudgetTokens: 1_500});
    expect(narrow.structuredContent.confidence).toMatchObject({basis: 'response-budget', level: 'low'});
    expect(narrow.text).toContain('budgetTokens=1500');
    expect(expanded.structuredContent.nextAction.uris).toContain(directHit.uri);
    expect(expanded.structuredContent.confidence?.basis).toBe('explicit-memory-connection');
  });

  it('keeps relevance absence distinct from a response-budget omission', () => {
    const empty = projectRecallMcpResponse(seededNavigation([]), {budgetTokens: 700});
    expect(empty.structuredContent.confidence).toMatchObject({basis: 'ranked-relevance', level: 'no_answer'});
    expect(empty.structuredContent.output).not.toHaveProperty('budgetLimited');
  });

  it('preserves topical confidence when a later verified neighbor is budget-omitted', () => {
    const topical = hit(1);
    const neighbor = hit(2, {
      uri: `threadnote://user/test/memories/durable/projects/threadnote/${'verified-neighbor-'.repeat(5)}.md`,
    });
    const seeded = seededNavigation([topical, neighbor]);
    const response = {
      ...seeded,
      confidence: logical([]).confidence,
      memoryConnections: {
        ...seeded.memoryConnections,
        connections: seeded.memoryConnections.connections.slice(1),
        coverage: {...seeded.memoryConnections.coverage, connectionCount: 1, resultCount: 1},
      },
    };
    const projected = projectRecallMcpResponse(response, {budgetTokens: 700, responseFormat: 'dual'});

    expect(projected.structuredContent.results.map(result => result.uri)).toEqual([topical.uri]);
    expect(projected.structuredContent.confidence).toMatchObject({basis: 'ranked-relevance', level: 'medium'});
    expect(projected.structuredContent.output).toMatchObject({budgetLimited: true, retryBudgetTokens: 1_500});
  });

  it('classifies verified seeded evidence across budgets, URI lengths, and connection counts', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({min: 1, max: 140}), {minLength: 1, maxLength: 8}),
        fc.integer({min: 700, max: 1_500}),
        (uriLengths, budgetTokens) => {
          const results = uriLengths.map((length, index) =>
            hit(index, {
              uri: `threadnote://user/test/memories/durable/projects/threadnote/${index}-${'x'.repeat(length)}.md`,
            }),
          );
          const projected = projectRecallMcpResponse(seededNavigation(results), {budgetTokens});
          const {confidence, memoryConnections, output} = projected.structuredContent;

          expect(projected.measurement.totalBytes).toBeLessThanOrEqual(budgetTokens * 3);
          expect(confidence?.level).not.toBe('no_answer');
          if (confidence?.basis === 'response-budget') {
            expect(output.budgetLimited).toBe(true);
            expect(memoryConnections?.coverage.resultCount).toBe(0);
            if (budgetTokens < 1_500) expect(output.retryBudgetTokens).toBe(1_500);
            expect(projected.text).toContain('Verified one-hop navigation evidence omitted by response budget.');
          } else {
            expect(confidence?.basis).toBe('explicit-memory-connection');
            expect(memoryConnections?.coverage.resultCount).toBeGreaterThan(0);
            expect(output).not.toHaveProperty('budgetLimited');
          }
        },
      ),
      {numRuns: 100},
    );
  });

  it('preserves a matching explicit-connection receipt bundle before max-budget explanation detail', () => {
    const results = Array.from({length: 3}, (_, index) =>
      hit(index, {
        rankReasons: Array.from({length: 12}, (__, reasonIndex) => ({
          code: 'exact_term_match' as const,
          contribution: 0.01,
          detail: `Verbose diagnostic reason ${reasonIndex} for result ${index} carries optional ranking explanation detail.`,
        })),
        rankWarnings: Array.from(
          {length: 8},
          (__, warningIndex) => `Optional diagnostic warning ${warningIndex} for result ${index}.`,
        ),
      }),
    );
    const directHit = results.at(2);
    if (directHit === undefined) throw new Error('Expected the direct result fixture.');
    const projected = projectRecallMcpResponse(
      {
        ...logical(results),
        confidence: {
          level: 'no_answer',
          margin: 0,
          reason: 'No candidate passed the minimum combined relevance threshold.',
          score: 0,
        },
        memoryConnections: {
          candidates: [],
          connections: [
            {
              currentness: 'current',
              direction: 'outgoing',
              distance: 1,
              neighborMemoryId: 'tn_direct',
              neighborUri: directHit.uri,
              origin: 'relation',
              relationOrdinal: 0,
              relationType: 'references',
              requestedOrdinal: 1,
              resolution: 'resolved',
              sourceMemoryId: 'tn_seed',
            },
          ],
          coverage: {
            connectionCount: 1,
            premiseCount: 2,
            resultCount: 1,
            truncated: false,
            version: 1,
          },
          diagnostics: {
            canonicalMismatches: 0,
            canonicalRereads: 2,
            rawLinkRows: 1,
            refreshRepairs: 0,
            truncatedSeedOrdinals: [],
          },
          premises: [
            {
              requestedOrdinal: 0,
              requestedRef: 'threadnote://memory/tn_unresolved',
              state: 'unresolved',
            },
            {
              memoryId: 'tn_seed',
              requestedOrdinal: 1,
              requestedRef: 'threadnote://memory/tn_seed',
              state: 'current',
            },
          ],
        },
      },
      {budgetTokens: 1_500, explain: true},
    );

    expect(projected.structuredContent.results).toHaveLength(3);
    expect(projected.structuredContent.output).toMatchObject({
      explain: true,
      explainDetails: 'omitted-response-budget',
    });
    expect(projected.structuredContent).not.toHaveProperty('queryExpansions');
    expect(projected.structuredContent.confidence).toMatchObject({
      basis: 'explicit-memory-connection',
      level: 'high',
    });
    const nextUri = projected.structuredContent.nextAction.uris[0];
    const receipt = projected.structuredContent.memoryConnections?.connections.find(
      connection => connection.neighborUri === nextUri,
    );
    if (receipt === undefined) throw new Error('Expected an actionable connection receipt.');
    expect(receipt).toMatchObject({currentness: 'current', requestedOrdinal: 1, resolution: 'resolved'});
    expect(projected.structuredContent.memoryConnections?.premises).toContainEqual(
      expect.objectContaining({requestedOrdinal: receipt.requestedOrdinal, state: 'current'}),
    );
    expect(projected.measurement.totalBytes).toBeLessThanOrEqual(1_500 * 3);
  });

  it('keeps an explicitly included historical connection actionable while preserving its receipt', () => {
    const historicalHit = hit(1);
    const projected = projectRecallMcpResponse({
      ...logical([historicalHit]),
      confidence: {
        level: 'no_answer',
        margin: 0,
        reason: 'No candidate passed the minimum combined relevance threshold.',
        score: 0,
      },
      memoryConnections: {
        candidates: [],
        connections: [
          {
            currentness: 'historical',
            direction: 'outgoing',
            distance: 1,
            neighborMemoryId: 'tn_historical',
            neighborUri: historicalHit.uri,
            origin: 'relation',
            relationOrdinal: 0,
            relationType: 'references',
            requestedOrdinal: 0,
            resolution: 'resolved',
            sourceMemoryId: 'tn_seed',
          },
        ],
        coverage: {
          connectionCount: 1,
          premiseCount: 1,
          resultCount: 1,
          truncated: false,
          version: 1,
        },
        diagnostics: {
          canonicalMismatches: 0,
          canonicalRereads: 2,
          rawLinkRows: 1,
          refreshRepairs: 0,
          truncatedSeedOrdinals: [],
        },
        premises: [
          {
            memoryId: 'tn_seed',
            requestedOrdinal: 0,
            requestedRef: 'threadnote://memory/tn_seed',
            state: 'current',
          },
        ],
      },
    });

    expect(projected.structuredContent.confidence).toMatchObject({
      basis: 'explicit-memory-connection',
      level: 'high',
    });
    expect(projected.structuredContent.memoryConnections?.connections).toEqual([
      expect.objectContaining({currentness: 'historical', resolution: 'resolved'}),
    ]);
    expect(projected.structuredContent.nextAction.uris).toEqual([historicalHit.uri]);
  });

  it('keeps every projected verified connection actionable across bounded response budgets', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z0-9-]{1,24}$/), {
          maxLength: 8,
          minLength: 1,
          selector: value => value,
        }),
        fc.integer({min: RECALL_MCP_RESPONSE_MINIMUM_ESTIMATED_TOKENS, max: 1_500}),
        fc.boolean(),
        (segments, budgetTokens, explain) => {
          const results = segments.map((segment, index) =>
            hit(index, {uri: `threadnote://user/test/memories/durable/projects/threadnote/${segment}.md`}),
          );
          const connections = results.map((result, relationOrdinal) => ({
            currentness: relationOrdinal % 2 === 0 ? ('current' as const) : ('historical' as const),
            direction: 'outgoing' as const,
            distance: 1 as const,
            neighborMemoryId: `tn_direct_${relationOrdinal}`,
            neighborUri: result.uri,
            origin: 'relation' as const,
            relationOrdinal,
            relationType: 'related_to' as const,
            requestedOrdinal: 0,
            resolution: 'resolved' as const,
            sourceMemoryId: 'tn_seed',
          }));
          const response = {
            ...logical(results),
            confidence: {
              level: 'no_answer' as const,
              margin: 0,
              reason: 'No candidate passed the minimum combined relevance threshold.',
              score: 0,
            },
            memoryConnections: {
              candidates: [],
              connections,
              coverage: {
                connectionCount: connections.length,
                premiseCount: 1,
                resultCount: results.length,
                truncated: false,
                version: 1 as const,
              },
              diagnostics: {
                canonicalMismatches: 0,
                canonicalRereads: results.length + 1,
                rawLinkRows: connections.length,
                refreshRepairs: 0,
                truncatedSeedOrdinals: [],
              },
              premises: [
                {
                  memoryId: 'tn_seed',
                  requestedOrdinal: 0,
                  requestedRef: 'threadnote://memory/tn_seed',
                  state: 'current' as const,
                },
              ],
            },
          };
          const projected = projectRecallMcpResponse(response, {budgetTokens, explain});
          const repeated = projectRecallMcpResponse(response, {budgetTokens, explain});
          const returnedUris = new Set(projected.structuredContent.results.map(result => result.uri));

          expect(projected).toEqual(repeated);
          expect(projected.measurement.totalBytes).toBeLessThanOrEqual(budgetTokens * 3);
          expect(projected.structuredContent.memoryConnections?.coverage.resultCount).toBeGreaterThan(0);
          expect(projected.structuredContent.confidence).toMatchObject({
            basis: 'explicit-memory-connection',
            level: 'high',
          });
          expect(projected.structuredContent.nextAction.uris.length).toBeGreaterThan(0);
          expect(projected.structuredContent.nextAction.uris.every(uri => returnedUris.has(uri))).toBe(true);
          const actionableReceipt = projected.structuredContent.memoryConnections?.connections.find(
            connection => connection.neighborUri === projected.structuredContent.nextAction.uris[0],
          );
          if (actionableReceipt === undefined) throw new Error('Expected an actionable connection receipt.');
          expect(actionableReceipt).toMatchObject({resolution: 'resolved'});
          expect(projected.structuredContent.memoryConnections?.premises).toContainEqual(
            expect.objectContaining({requestedOrdinal: actionableReceipt.requestedOrdinal}),
          );
        },
      ),
      {numRuns: 100},
    );
  });

  it('surfaces a typed identity-conflict warning without enabling diagnostic explanations', () => {
    const compact = projectRecallMcpResponse(logical([hit(1, {identityConflict: true})]));

    expect(compact.structuredContent.output.explain).toBe(false);
    expect(compact.structuredContent.results[0]).toMatchObject({
      warnings: [
        {
          code: 'memory_identity_conflict',
          message: expect.stringContaining('divergent bodies'),
          remediation: expect.stringContaining('verify'),
        },
      ],
    });
    expect(compact.structuredContent.results[0]).not.toHaveProperty('rankWarnings');
  });

  it('keeps the canonical top pointer when one logical memory has hundreds of aliases', () => {
    const aliases = Array.from(
      {length: 500},
      (_, index) => `threadnote://user/test/memories/shared/team-${index}/memory.md`,
    );
    const projected = projectRecallMcpResponse(logical([hit(1, {equivalentUris: aliases})]));

    expect(projected.measurement.totalBytes).toBeLessThanOrEqual(1_500 * 3);
    expect(projected.structuredContent.results).toHaveLength(1);
    expect(projected.structuredContent.results[0]).toMatchObject({
      aliasCount: 500,
      aliases: aliases.slice(0, 3),
      omittedAliases: 497,
      uri: 'threadnote://user/test/memories/durable/projects/threadnote/memory-1.md',
    });
  });

  it('prioritizes bounded warnings and hygiene hints in compact text', () => {
    const projected = projectRecallMcpResponse(
      logical(
        [hit(1)],
        [
          'Workset scope: product',
          'Recall query expansion: evaluated one rewrite.',
          'Memory hygiene hints:\n- Review an older handoff.',
          'Local AI recall unavailable: worker failed. Deterministic recall continued.',
          'Auto-synced Obsidian sources: notes',
        ],
      ),
    );

    expect(projected.text).toContain('Local AI recall unavailable');
    expect(projected.text).toContain('Memory hygiene hints: - Review an older handoff.');
    expect(projected.text).toContain('Auto-synced Obsidian sources: notes');
    expect(projected.text).not.toContain('Recall query expansion');
  });

  it('selects a deterministic ranked prefix within the declared budget', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z0-9-]{1,32}$/), {maxLength: 30, selector: value => value}),
        fc.integer({min: RECALL_MCP_RESPONSE_MINIMUM_ESTIMATED_TOKENS, max: 1_500}),
        (segments, budgetTokens) => {
          const results = segments.map((segment, index) =>
            hit(index, {
              uri: `threadnote://user/test/memories/durable/projects/threadnote/${segment}.md`,
            }),
          );
          const first = projectRecallMcpResponse(logical(results), {budgetTokens});
          const second = projectRecallMcpResponse(logical(results), {budgetTokens});

          expect(first).toEqual(second);
          expect(first.measurement.totalBytes).toBeLessThanOrEqual(budgetTokens * 3);
          expect(first.structuredContent.results.map(result => result.uri)).toEqual(
            results.slice(0, first.structuredContent.output.returnedResults).map(result => result.uri),
          );
          expect(first.structuredContent.results.every(result => result.readState === 'unread')).toBe(true);
          expect(first.structuredContent.nextAction.uris).toEqual(
            first.structuredContent.results.slice(0, 3).map(result => result.uri),
          );
        },
      ),
      {numRuns: 100},
    );
  });

  it('keeps agent receipts UTF-8-safe, immutable, ranked, and monotonic across budgets', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z0-9-]{1,180}$/), {
          minLength: 1,
          maxLength: 30,
          selector: value => value,
        }),
        segments => {
          const results = segments.map((segment, index) =>
            hit(index, {
              rankReasons: [{code: 'exact_term_match', contribution: 0.18, detail: `Match ${segment}\t🚀\n${index}`}],
              uri: `threadnote://user/test/memories/durable/projects/threadnote/${segment}.md`,
            }),
          );
          const response = logical(results, ['notice\t🚀\nquoted "value"']);
          const before = structuredClone(response);
          const narrow = projectRecallMcpResponse(response, {budgetTokens: 700});
          const expanded = projectRecallMcpResponse(response, {budgetTokens: 1_500});

          expect(response).toEqual(before);
          expect(narrow).toEqual(projectRecallMcpResponse(response, {budgetTokens: 700}));
          expect(narrow.measurement.structuredBytes).toBe(0);
          expect(expanded.measurement.structuredBytes).toBe(0);
          expect(narrow.measurement.totalBytes).toBeLessThanOrEqual(700 * 3);
          expect(expanded.measurement.totalBytes).toBeLessThanOrEqual(1_500 * 3);

          const narrowUris = narrow.structuredContent.results.map(result => result.uri);
          const expandedUris = expanded.structuredContent.results.map(result => result.uri);
          expect(narrowUris).toEqual(results.slice(0, narrowUris.length).map(result => result.uri));
          expect(expandedUris).toEqual(results.slice(0, expandedUris.length).map(result => result.uri));
          expect(expandedUris.slice(0, narrowUris.length)).toEqual(narrowUris);
          expect(expandedUris.length).toBeGreaterThanOrEqual(narrowUris.length);

          for (const [index, result] of expanded.structuredContent.results.entries()) {
            const row = expanded.text.split('\n').find(line => line.startsWith(`${index + 1}. `));
            expect(row).toContain(result.uri);
            expect(row).not.toMatch(/[\t\n]/u);
          }
        },
      ),
      {numRuns: 100},
    );
  });

  it('renders readable recovery when a budget omits ranked pointers', () => {
    const projected = projectRecallMcpResponse(
      seededNavigation([
        hit(1, {
          uri: `threadnote://user/test/memories/durable/projects/threadnote/${'long-uri-segment-'.repeat(250)}.md`,
        }),
      ]),
      {budgetTokens: 700},
    );

    expect(projected.structuredContent.output.budgetLimited).toBe(true);
    expect(projected.text).toContain('Recovery: retry recall_context with budgetTokens=1500.');
  });
});
