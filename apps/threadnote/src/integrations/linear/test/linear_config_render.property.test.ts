import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  parseSourceConfiguration,
  renderSourceConfiguration,
  sourceConfigurationFingerprint,
  upsertLinearSource,
} from '../../config.js';
import {validateLinearSourceConfig} from '../config.js';
import {linearDocumentId, renderLinearIssue, scrubLinearMarkdown} from '../render.js';
import {linearIssueInScope} from '../client.js';
import {comment, issue, source, uuid} from './fixtures.js';
describe('Linear configuration and rendering invariants', () => {
  it('round-trips version 2 and keeps version 1 Obsidian compatibility', () => {
    expect(parseSourceConfiguration('version: 1\nsources: []\nprojections: []')).toEqual({
      version: 1,
      sources: [],
      projections: [],
    });
    const config = upsertLinearSource({version: 1, sources: [], projections: []}, source);
    expect(parseSourceConfiguration(renderSourceConfiguration(config))).toEqual(config);
    expect(() => parseSourceConfiguration(renderSourceConfiguration({...config, version: 1} as never))).toThrow();
  });
  it('rejects missing selections, duplicates and projectless bindings', () => {
    for (const delta of [
      {teamIds: []},
      {issueIds: [], projectIds: []},
      {teamIds: [uuid(3), uuid(3)]},
      {organizationId: 'org-name'},
      {project: null},
    ])
      expect(() => validateLinearSourceConfig({...source, ...delta} as never)).toThrow();
  });
  it('fingerprints are independent of selection order and change whenever permission scope changes', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({min: 10, max: 100}), {minLength: 1, maxLength: 20}), values => {
        const ids = values.map(uuid);
        const selected = {...source, issueIds: ids};
        expect(sourceConfigurationFingerprint(selected)).toBe(
          sourceConfigurationFingerprint({...selected, issueIds: [...ids].reverse()}),
        );
        expect(sourceConfigurationFingerprint(selected)).not.toBe(
          sourceConfigurationFingerprint({...selected, principalId: uuid(900)}),
        );
      }),
      {numRuns: 40},
    );
  });
  it('identity is stable across title changes and isolated by organization and object kind', () => {
    fc.assert(
      fc.property(fc.uuid(), id => {
        const rendered = renderLinearIssue(source, {issue: {...issue, id}, comments: []});
        const renamed = renderLinearIssue(source, {issue: {...issue, id, title: 'Changed title'}, comments: []});
        expect(rendered.documentId).toBe(renamed.documentId);
        expect(linearDocumentId(source.organizationId, 'issue', id)).not.toBe(linearDocumentId(uuid(999), 'issue', id));
        expect(linearDocumentId(source.organizationId, 'issue', id)).not.toBe(
          linearDocumentId(source.organizationId, 'document', id),
        );
      }),
      {numRuns: 40},
    );
  });
  it('renders comments deterministically under enumeration permutations without mutating inputs', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({min: 100, max: 500}), {maxLength: 20}), values => {
        const comments = values.map(n => {
          const {children: _, ...c} = comment(n);
          return c;
        });
        const before = JSON.stringify(comments);
        expect(renderLinearIssue(source, {issue, comments})).toEqual(
          renderLinearIssue(source, {issue, comments: [...comments].reverse()}),
        );
        expect(JSON.stringify(comments)).toBe(before);
      }),
      {numRuns: 40},
    );
  });
  it('team allowlists intersect selection and never expand through visible project membership', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (teamAllowed, selected) => {
        const config = {...source, issueIds: selected ? [issue.id] : [], projectIds: [uuid(100)]};
        const item = {...issue, team: teamAllowed ? issue.team : {id: uuid(999), name: 'Outside'}};
        expect(linearIssueInScope(config, item)).toBe(teamAllowed && selected);
      }),
      {numRuns: 20},
    );
  });
  it('omits attachment images and signed capability links while keeping ordinary references', () => {
    const input =
      '![diagram](https://uploads.linear.app/image.png) [download](https://uploads.linear.app/file?X-Amz-Signature=secret) https://linear.app/workspace/issue/T-1';
    const result = scrubLinearMarkdown(input);
    expect(result).not.toContain('secret');
    expect(result).not.toContain('image.png');
    expect(result).toContain('Capability link omitted');
    expect(result).toContain('https://linear.app/workspace/issue/T-1');
    expect(scrubLinearMarkdown(result)).toBe(result);
  });
  it.each(['HTTPS', 'HtTpS', 'HTTP', 'hTtP'])('scrubs signed capability links with scheme %s', scheme => {
    const url = `${scheme}://uploads.linear.app/file?X-Amz-Signature=synthetic-capability`;
    for (const input of [`[download](${url})`, `[download][file]\n\n[file]: ${url}`, `<${url}>`]) {
      const rendered = scrubLinearMarkdown(input);
      expect(rendered).not.toContain('synthetic-capability');
      expect(rendered).toContain('Capability link omitted');
      expect(scrubLinearMarkdown(rendered)).toBe(rendered);
    }
  });
});
