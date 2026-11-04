import {describe, expect, it} from '@effect/vitest';
import {renderMemoryPreview, renderMemoryPreviewError} from '@threadnote/manager/preview';

const metadata = {
  kind: 'durable' as const,
  project: 'threadnote',
  sourceAgentClient: 'user',
  status: 'active' as const,
  timestamp: '2026-11-01T00:00:00Z',
  topic: 'Preview contract',
};
const node = {
  isDir: false,
  isShared: false,
  isSystem: false,
  metadata,
  name: 'preview-contract.md',
  relativePath: 'durable/projects/threadnote/preview-contract.md',
  size: 100,
  uri: 'threadnote://user/alice/memories/durable/projects/threadnote/preview-contract.md',
};

describe('private memory preview document', () => {
  it('renders the current memory pane without mutation controls or document fields', () => {
    const content = `MEMORY\nkind: durable\nstatus: active\n\n# Body heading\n\nCurrent content.\n\n<!-- MEMORY_FIELDS\nprivate_marker\n-->`;
    const html = renderMemoryPreview({content, node, memoryId: 'tn_saved'});
    expect(html).toContain('Preview contract');
    expect(html).toContain('Body heading');
    expect(html).toContain('Current content.');
    expect(html).toContain('Local only');
    expect(html).toContain('Memory details');
    expect(html).toContain('Canonical URI');
    expect(html).toContain('tn_saved');
    expect(html).not.toContain('private_marker');
    expect(html).not.toContain('Automatic memory');
    expect(html).not.toContain('Topic expansion');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('contenteditable');
  });

  it('escapes hostile title and Markdown HTML and provides a safe missing-state page', () => {
    const html = renderMemoryPreview({
      content: '# Safe\n\n<script>alert(1)</script>',
      node: {...node, metadata: {...metadata, topic: '<img src=x onerror=alert(1)>'}},
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
    expect(renderMemoryPreviewError()).toContain('Memory unavailable');
  });

  it('shows Mermaid source without an active iframe or server-side document access', () => {
    const html = renderMemoryPreview({content: '# Diagram\n\n```mermaid\ngraph TD; A-->B\n```', node});
    expect(html).toContain('graph TD; A--&gt;B');
    expect(html).not.toContain('<iframe');
  });

  it('keeps image embeds inert, including React image preloads', () => {
    const html = renderMemoryPreview({content: '![secret chart](https://example.test/private.png)', node});
    expect(html).toContain('[Image: secret chart]');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('rel="preload"');
    expect(html).not.toContain('example.test');
  });
});
