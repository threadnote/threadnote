import {describe, expect, it} from 'vitest';
import {
  obsidianSourceRootUri,
  obsidianSourceUri,
  sourcePathMatches,
} from '@threadnote/threadnote/integrations/obsidian/source';

describe('Obsidian source mapping', () => {
  it('requires an include match and applies exclusions', () => {
    const include = ['Engineering/**'];
    const exclude = ['.obsidian/**', 'Engineering/Private/**', 'Threadnote Inbox/**'];

    expect(sourcePathMatches('Engineering/Auth.md', include, exclude)).toBe(true);
    expect(sourcePathMatches('Engineering/Private/Keys.md', include, exclude)).toBe(false);
    expect(sourcePathMatches('Personal/Auth.md', include, exclude)).toBe(false);
    expect(sourcePathMatches('Threadnote Inbox/Candidate.md', ['**/*.md'], exclude)).toBe(false);
  });

  it('uses a distinct encoded external-resource namespace', () => {
    expect(obsidianSourceRootUri('engineering')).toBe('threadnote://resources/external/obsidian/engineering');
    expect(obsidianSourceUri('engineering', 'Architecture/Auth flow #1.md')).toBe(
      'threadnote://resources/external/obsidian/engineering/Architecture/Auth%20flow%20%231.md',
    );
  });
});
