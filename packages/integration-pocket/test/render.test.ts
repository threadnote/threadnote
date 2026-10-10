import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {renderPocketCatalog, renderPocketRecord} from '../src/render.js';

describe('Pocket readable resources', () => {
  it('renders actual v2 content once without flattening administrative metadata', () => {
    const [resource] = renderPocketRecord({
      id: 'recording_1',
      title: 'Planning meeting',
      recording_at: '2026-10-08T12:00:00Z',
      duration: 122,
      tags: [{id: 'tag_1', name: 'Planning', color: '#000000'}],
      speakers: {SPEAKER_00: {name: 'Alex', speakerId: 'internal_speaker'}},
      transcript: {
        metadata: {transcription_id: 'internal_transcript', language_probability: 0.99},
        text: 'Discuss the launch. Ship on Friday.',
        segments: [
          {start: 1, end: 2, speaker: 'SPEAKER_00', text: 'Discuss the launch.', originalText: 'Discuss the launch.'},
          {start: 3, end: 5, speakerName: 'Sam', text: 'Ship on Friday.'},
        ],
      },
      summarizations: {
        summary_1: {
          settings: {summaryMeasurement: {costUsd: 0.01}, firestoreNotificationId: 'internal_notification'},
          processingStatus: 'completed',
          v2: {
            summary: {markdown: 'Launch is ready.', version: '1'},
            actionItems: {
              actions: [{label: 'Prepare release', assignee: 'Alex', isCompleted: true, id: 'internal_action'}],
            },
            mindMap: {nodes: [{node_id: '1', parent_node_id: '0', title: 'Release plan', color: '#000000'}]},
          },
        },
      },
    });
    expect(resource.chunkId).toBe('content');
    expect(resource.title).toBe('Planning meeting');
    expect(resource.body).toContain('# Planning meeting');
    expect(resource.body).toContain('## Summary\n\nLaunch is ready.');
    expect(resource.body).toContain('- [x] Prepare release — Alex');
    expect(resource.body).toContain('## Mind map\n\n- Release plan');
    expect(resource.body).toContain('[00:01] Alex: Discuss the launch.');
    expect(resource.body).toContain('[00:03] Sam: Ship on Friday.');
    expect(resource.body.match(/Discuss the launch\./g)).toHaveLength(1);
    expect(resource.body).toContain('Tags: Planning');
    expect(resource.body).not.toMatch(/recording\.|internal_|costUsd|processingStatus|language_probability/);
  });

  it('keeps long recordings whole, with stable identity after edits', () => {
    const text = 'A long meeting sentence. '.repeat(2500);
    const first = renderPocketRecord({id: 'recording_1', title: 'Meeting', transcript: {text}});
    expect(first).toHaveLength(1);
    expect(Buffer.byteLength(first[0].body)).toBeGreaterThan(16 * 1024);
    expect(first[0].body).toContain(text.trim());
    const edited = renderPocketRecord({id: 'recording_1', title: 'Renamed', transcript: {text: `${text}Next steps.`}});
    expect(edited[0].chunkId).toBe(first[0].chunkId);
    expect(edited[0].contentHash).not.toBe(first[0].contentHash);
  });

  it('retains plain transcripts, legacy summaries and nested action items', () => {
    const [resource] = renderPocketRecord({
      id: 'recording_1',
      title: 'Meeting',
      transcript: 'Plain transcript.',
      summarizations: {
        summary: 'Legacy summary.',
        action_items: [{title: 'Parent task', subtasks: [{title: 'Child task', description: 'Do the work.'}]}],
      },
    });
    expect(resource.body).toContain('Legacy summary.');
    expect(resource.body).toContain('Parent task');
    expect(resource.body).toContain('Child task');
    expect(resource.body).toContain('Do the work.');
    expect(resource.body).toContain('Plain transcript.');
  });

  it('preserves distinct originals and falls back from empty segments to full text', () => {
    const translated = renderPocketRecord({
      id: 'recording_1',
      transcript: {segments: [{text: 'Hello', originalText: 'Bonjour', start: 0}]},
    })[0];
    expect(translated.body).toContain('Hello');
    expect(translated.body).toContain('Bonjour');
    expect(
      renderPocketRecord({id: 'recording_1', transcript: {segments: [], text: 'Fallback text'}})[0].body,
    ).toContain('Fallback text');
  });

  it('reports unsupported summary content and rejects oversized complete records', () => {
    expect(
      renderPocketRecord({id: 'recording_1', summarizations: {summary_1: {v3: {novelContent: 'Text'}}}})[0].body,
    ).toContain('unsupported');
    expect(() => renderPocketRecord({id: 'recording_1', transcript: 'a'.repeat(512 * 1024)})).toThrow(/budget/);
  });

  it('renders catalog names and descriptions without internal identifiers', () => {
    const result = renderPocketCatalog('folders', [
      {id: 'internal_folder', name: 'Research', description: 'Project notes', created_at: 'internal_date'},
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].body).toContain('- Research: Project notes');
    expect(result[0].body).not.toContain('internal_');
  });

  it('is independent of technical metadata and object key insertion order', () => {
    const text = fc
      .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz '), {minLength: 1, maxLength: 200})
      .map(characters => characters.join(''));
    fc.assert(
      fc.property(text, fc.nat(), (content, cost) => {
        const base = {
          id: 'recording_1',
          title: 'Meeting',
          transcript: {text: content},
          summarizations: {summary_a: {v2: {summary: {markdown: content}}}},
        };
        const changed = {
          summarizations: {
            summary_a: {
              settings: {summaryMeasurement: {costUsd: cost}, dispatchTaskId: 'administrative'},
              v2: {summary: {markdown: content}},
            },
          },
          transcript: {metadata: {source: 'provider'}, text: content},
          title: 'Meeting',
          id: 'recording_1',
        };
        expect(renderPocketRecord(changed)).toEqual(renderPocketRecord(base));
      }),
      {numRuns: 80},
    );
  });
});
