import {Array as EffectArray} from 'effect';
import {Option} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {fromPromiseInterruptible} from '@threadnote/platform/errors';
import {CodeGraphLanguagePackError, type CodeGraphFileMatcher, type CodeGraphLanguagePack} from '../types.js';
import {extractCorpusFile} from './extractor.js';
import {OPAQUE_CORPUS_MEDIA_EXTENSIONS} from './policy.js';

const extensions = (values: readonly string[], language: string): readonly CodeGraphFileMatcher[] =>
  EffectArray.map(values, value => ({kind: 'extension', language, role: 'corpus', value}));

export const codeGraphLanguagePack: CodeGraphLanguagePack = {
  assets: [],
  capabilities: new Set(['assets', 'corpus', 'declarations', 'documentation']),
  extractor: {
    extract: (file, context) =>
      fromPromiseInterruptible(
        signal => extractCorpusFile(file, {signal}, context),
        cause => CodeGraphLanguagePackError.make({message: `Could not extract corpus facts from ${file.path}.`, cause}),
      ),
    version: sha256HexSync('threadnote-corpus-extractor-v4-mobile-resource-wiring'),
  },
  files: [
    ...extensions(
      [
        '.adoc',
        '.asciidoc',
        '.csv',
        '.dot',
        '.drawio',
        '.graphml',
        '.htm',
        '.html',
        '.ipynb',
        '.mermaid',
        '.mmd',
        '.org',
        '.plantuml',
        '.plist',
        '.puml',
        '.rst',
        '.rtf',
        '.storyboard',
        '.svg',
        '.tex',
        '.tsv',
        '.txt',
        '.url',
        '.webloc',
        '.xib',
        '.xml',
      ],
      'document',
    ),
    ...extensions(['.docx', '.epub', '.odp', '.ods', '.odt', '.pdf', '.pptx', '.xlsx'], 'office-document'),
    ...extensions(
      EffectArray.filter(
        OPAQUE_CORPUS_MEDIA_EXTENSIONS,
        (extension, __effectArrayIndex) =>
          __effectArrayIndex in OPAQUE_CORPUS_MEDIA_EXTENSIONS &&
          ['.avif', '.bmp', '.gif', '.heic', '.ico', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp'].includes(
            extension,
          ),
      ),
      'image',
    ),
    ...extensions(
      EffectArray.filter(
        OPAQUE_CORPUS_MEDIA_EXTENSIONS,
        (extension, __effectArrayIndex) =>
          __effectArrayIndex in OPAQUE_CORPUS_MEDIA_EXTENSIONS &&
          ['.aac', '.flac', '.m4a', '.mp3', '.oga', '.ogg', '.opus', '.wav'].includes(extension),
      ),
      'audio',
    ),
    ...extensions(
      EffectArray.filter(
        OPAQUE_CORPUS_MEDIA_EXTENSIONS,
        (extension, __effectArrayIndex) =>
          __effectArrayIndex in OPAQUE_CORPUS_MEDIA_EXTENSIONS &&
          ['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.mpeg', '.mpg', '.webm'].includes(extension),
      ),
      'video',
    ),
  ],
  id: 'corpus',
  resolutionStrategy: {domain: 'corpus', version: 'corpus-links-v1'},
  version: '1.0.0',
  workspaceDetector: Option.none(),
};
