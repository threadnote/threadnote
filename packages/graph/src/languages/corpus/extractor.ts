import {Array as EffectArray} from 'effect';
import {unzipSync, type UnzipFileInfo} from 'fflate';
import {getResolvedPDFJS} from 'unpdf';
import {Option, Predicate} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {compareNaturalCodeUnits} from '../../ordering.js';
import type {CodeGraphEdge, CodeGraphFileFacts, CodeGraphInventoryFile, CodeGraphSymbol} from '../../types.js';
import type {CodeGraphExtractionContext} from '../types.js';
import {scanXmlAttributes, scanXmlStartTags} from '../xml_scan.js';
import {
  CORPUS_ARCHIVE_ENTRY_BYTES_LIMIT,
  CORPUS_ARCHIVE_EXPANDED_BYTES_LIMIT,
  CORPUS_ARCHIVE_INSPECTED_ENTRY_LIMIT,
  CORPUS_ARCHIVE_SELECTED_ENTRY_LIMIT,
  CORPUS_EXTRACTION_SOURCE_BYTES_LIMIT,
  CORPUS_PDF_EXTRACTED_TEXT_CHARACTER_LIMIT,
  CORPUS_PDF_EXTRACTION_MILLISECONDS_LIMIT,
} from './policy.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const TEXT_CHUNK_TARGET = 1_800;

const OFFICE_EXTENSIONS = new Set(['.docx', '.epub', '.odp', '.ods', '.odt', '.pptx', '.xlsx']);
const IMAGE_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.heic',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.tif',
  '.tiff',
  '.webp',
]);
const AUDIO_EXTENSIONS = new Set(['.aac', '.flac', '.m4a', '.mp3', '.oga', '.ogg', '.opus', '.wav']);
const VIDEO_EXTENSIONS = new Set(['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.mpeg', '.mpg', '.webm']);
const MOBILE_RESOURCE_XML_ELEMENT_LIMIT = 512;
const MOBILE_RESOURCE_XML_ATTRIBUTE_LIMIT = 4_096;

interface ExtractedSection {
  readonly name: string;
  readonly text: string;
}

interface ExtractedCorpus {
  readonly diagnostics: readonly string[];
  readonly kind: 'asset' | 'document' | 'resource';
  readonly metadata: readonly string[];
  readonly resourceReferences?: readonly string[];
  readonly sections: readonly ExtractedSection[];
  readonly urls: readonly string[];
}

type PdfJs = Awaited<ReturnType<typeof getResolvedPDFJS>>;
type PdfLoadingTask = ReturnType<PdfJs['getDocument']>;
type PdfDocument = Awaited<PdfLoadingTask['promise']>;
type PdfPage = Awaited<ReturnType<PdfDocument['getPage']>>;
type PdfAnnotations = Awaited<ReturnType<PdfPage['getAnnotations']>>;
type PdfTextContent = Awaited<ReturnType<PdfPage['getTextContent']>>;

export interface CorpusExtractionOptions {
  /** Test and internal callers may lower, but never raise, the production safety budgets. */
  readonly archiveInspectedEntryLimit?: number;
  readonly archiveSelectedEntryLimit?: number;
  readonly maximumElapsedMilliseconds?: number;
  readonly maximumExtractedTextCharacters?: number;
  readonly monotonicNow?: () => number;
  readonly signal?: AbortSignal;
}

export async function extractCorpusFile(
  file: CodeGraphInventoryFile,
  options: CorpusExtractionOptions = {},
  context?: CodeGraphExtractionContext,
): Promise<CodeGraphFileFacts> {
  const extension = extensionOf(file.path);
  if (file.contentOmittedReason === 'metadata-only') {
    return buildFacts(
      file,
      {
        diagnostics: [`${file.path}: binary media content was not loaded; indexed as deterministic asset metadata.`],
        kind: 'asset',
        metadata: [`format ${Effect.pipe(extension, EffectString.slice(1)) || 'unknown'}`, `${file.size} bytes`],
        sections: [],
        urls: [],
      },
      context,
    );
  }
  if (file.contentOmittedReason === 'size-budget' || file.size > CORPUS_EXTRACTION_SOURCE_BYTES_LIMIT) {
    return buildFacts(
      file,
      {
        diagnostics: [
          `${file.path}: content exceeds the 64 MiB per-artifact extraction safety budget; indexed as asset metadata.`,
        ],
        kind: 'asset',
        metadata: [`format ${Effect.pipe(extension, EffectString.slice(1)) || 'unknown'}`, `${file.size} bytes`],
        sections: [],
        urls: [],
      },
      context,
    );
  }
  try {
    const extracted =
      extension === '.pdf'
        ? await extractPdf(file, options)
        : OFFICE_EXTENSIONS.has(extension)
          ? extractArchiveDocument(file, extension, options)
          : IMAGE_EXTENSIONS.has(extension)
            ? extractImage(file, extension)
            : AUDIO_EXTENSIONS.has(extension)
              ? extractMediaAsset(file, extension, 'audio')
              : VIDEO_EXTENSIONS.has(extension)
                ? extractMediaAsset(file, extension, 'video')
                : extension === '.svg'
                  ? extractSvg(file)
                  : extractTextDocument(file, extension);
    return buildFacts(file, extracted, context);
  } catch (cause) {
    if (options.signal?.aborted) throw options.signal.reason ?? cause;
    return buildFacts(
      file,
      {
        diagnostics: [`${file.path}: corpus extraction failed (${messageOf(cause)})`],
        kind: 'asset',
        metadata: [`format ${Effect.pipe(extension, EffectString.slice(1)) || 'unknown'}`, `${file.size} bytes`],
        sections: [],
        urls: [],
      },
      context,
    );
  }
}

function extractTextDocument(file: CodeGraphInventoryFile, extension: string): ExtractedCorpus {
  const source = requireText(file);
  const resource = extractMobileResourceXml(file.path, source, extension);
  if (resource !== undefined) return resource;
  const text = normalizeTextDocument(source, extension);
  return {
    diagnostics: [],
    kind: 'document',
    metadata: [`format ${Effect.pipe(extension, EffectString.slice(1)) || 'text'}`, `${file.size} bytes`],
    sections: sectionize(text, basename(file.path)),
    urls: extractUrls(text),
  };
}

function extractMobileResourceXml(path: string, source: string, extension: string): ExtractedCorpus | undefined {
  const normalizedPath = Effect.pipe(path, EffectString.replaceAll('\\', '/'), EffectString.toLowerCase);
  const platform =
    extension === '.xml' &&
    /(?:^|\/)res\/(?:anim|animator|color|drawable|font|layout|menu|mipmap|navigation|raw|values|xml)(?:-[^/]*)?\//u.test(
      normalizedPath,
    )
      ? 'android'
      : ['.plist', '.storyboard', '.xib'].includes(extension)
        ? 'apple'
        : undefined;
  if (platform === undefined) return undefined;

  const evidence: string[] = [];
  const references: string[] = [];
  let attributes = 0;
  let elements = 0;
  for (const element of scanXmlStartTags(source)) {
    if (elements >= MOBILE_RESOURCE_XML_ELEMENT_LIMIT || attributes >= MOBILE_RESOURCE_XML_ATTRIBUTE_LIMIT) break;
    const elementName = element.name;
    const values = [`element ${elementName}`];
    for (const attribute of scanXmlAttributes(element.attributes)) {
      if (attributes >= MOBILE_RESOURCE_XML_ATTRIBUTE_LIMIT) break;
      const name = attribute.name;
      const value = decodeXmlEntities(attribute.value);
      values.push(`attribute ${name} ${value}`);
      for (const reference of Effect.pipe(
        value,
        EffectString.match(/[@?](?:android:)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/gu),
        Effect.Option.getOrElse(() => null),
      ) ?? []) {
        references.push(reference);
      }
      if (
        platform === 'apple' &&
        /^(?:customClass|image|name|restorationIdentifier|reuseIdentifier|storyboardIdentifier)$/u.test(name) &&
        value.length > 0 &&
        value.length <= 256
      ) {
        references.push(value);
      }
      attributes += 1;
    }
    evidence.push(EffectArray.join(values, ' · '));
    elements += 1;
  }

  const text = normalizeWhitespace(xmlToText(source));
  const wiring = EffectArray.join(evidence, '\n');
  const combined = EffectArray.join(EffectArray.filter([wiring, text], Boolean), '\n\n');
  const bounded = elements >= MOBILE_RESOURCE_XML_ELEMENT_LIMIT || attributes >= MOBILE_RESOURCE_XML_ATTRIBUTE_LIMIT;
  return {
    diagnostics: bounded
      ? [
          `${path}: mobile resource wiring extraction reached its bounded element or attribute limit; results are partial.`,
        ]
      : [],
    kind: 'resource',
    metadata: [
      platform === 'android' ? 'platform Android resource XML' : 'platform Apple interface resource',
      `${elements} element${elements === 1 ? '' : 's'}`,
      `${attributes} attribute${attributes === 1 ? '' : 's'}`,
    ],
    resourceReferences: uniqueStrings(references),
    sections: sectionize(combined, platform === 'android' ? 'Android resource wiring' : 'Apple resource wiring'),
    urls: extractUrls(source),
  };
}

function extractSvg(file: CodeGraphInventoryFile): ExtractedCorpus {
  const source = requireText(file);
  if (!svgHasTextElements(source)) {
    return {
      diagnostics: [`${file.path}: SVG has no text elements; indexed as deterministic asset metadata.`],
      kind: 'asset',
      metadata: ['format svg', `${file.size} bytes`],
      sections: [],
      urls: [],
    };
  }
  return extractTextDocument(file, '.svg');
}

function svgHasTextElements(source: string): boolean {
  let cursor = 0;
  while (cursor < source.length) {
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native search position argument changes the search origin; Effect String has no position parameter.
    const opening = source.indexOf('<', cursor);
    if (opening < 0) return false;
    if (Effect.pipe(source, EffectString.startsWith('<!--', opening))) {
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native search position argument changes the search origin; Effect String has no position parameter.
      const closing = source.indexOf('-->', opening + 4);
      cursor = closing < 0 ? source.length : closing + 3;
      continue;
    }
    let nameStart = opening + 1;
    if (source[nameStart] === '/') nameStart += 1;
    while (/\s/u.test(source[nameStart] ?? '')) nameStart += 1;
    let nameEnd = nameStart;
    while (/[A-Za-z0-9_.:-]/.test(source[nameEnd] ?? '')) nameEnd += 1;
    const localName = Effect.pipe(
      Effect.pipe(source, EffectString.slice(nameStart, nameEnd), EffectString.split(':')).at(-1),
      effectOptionalString =>
        effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.toLowerCase),
    );
    if (localName === 'text' || localName === 'title' || localName === 'desc') return true;
    cursor = Math.max(opening + 1, nameEnd);
  }
  return false;
}

async function extractPdf(file: CodeGraphInventoryFile, options: CorpusExtractionOptions): Promise<ExtractedCorpus> {
  const bytes = sourceBytes(file);
  const budget = pdfExtractionBudget(options);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', forwardAbort, {once: true});
  const timeout = setTimeout(
    () => controller.abort(new Error('PDF extraction exceeded the per-artifact elapsed-time safety budget')),
    budget.maximumElapsedMilliseconds,
  );
  let destroy: (() => Promise<void>) | undefined;
  try {
    budget.check();
    const pdfjs = await abortable(getResolvedPDFJS(), controller.signal);
    budget.check();
    let standardFontDataUrl: string | undefined;
    try {
      standardFontDataUrl = new URL('./standard_fonts/', import.meta.resolve('pdfjs-dist/package.json')).href;
    } catch {
      // The bundled serverless PDF.js build can still extract embedded-font text without this optional path.
    }
    const loadingTask = pdfjs.getDocument({
      data: bytes,
      disableFontFace: true,
      // PDF.js removed its final eval-based compiler together with the former isEvalSupported option.
      ...(standardFontDataUrl ? {standardFontDataUrl} : {}),
      useSystemFonts: true,
    });
    destroy = async () => {
      await loadingTask.destroy();
    };
    const abortLoading = () => void destroy?.().catch(() => undefined);
    controller.signal.addEventListener('abort', abortLoading, {once: true});
    const pdf = await abortable<PdfDocument>(loadingTask.promise, controller.signal);
    const text: string[] = [];
    const links: string[] = [];
    let extractedCharacters = 0;
    // Deliberately sequential: memory stays bounded by one decoded page plus the cumulative text budget.
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      budget.check();
      const page = await abortable<PdfPage>(pdf.getPage(pageNumber), controller.signal);
      try {
        const content = await abortable<PdfTextContent>(page.getTextContent(), controller.signal);
        budget.check();
        const pageText = joinPdfTextItemsWithinLimit(
          content.items,
          budget.maximumExtractedTextCharacters - extractedCharacters,
        );
        extractedCharacters += pageText.length;
        text.push(pageText);
        const annotations = await abortable<PdfAnnotations>(page.getAnnotations(), controller.signal);
        for (const annotation of annotations) {
          if (Predicate.isObject(annotation) && annotation.subtype === 'Link' && typeof annotation.url === 'string') {
            links.push(annotation.url);
          }
        }
      } finally {
        page.cleanup();
      }
    }
    budget.check();
    return {
      diagnostics: EffectArray.every(text, page => Effect.pipe(page, EffectString.trim).length === 0)
        ? [`${file.path}: PDF has no extractable text; indexed as an asset.`]
        : [],
      kind: 'document',
      metadata: ['format pdf', `${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'}`, `${file.size} bytes`],
      sections: EffectArray.flatMap(text, (page, index) =>
        EffectArray.map(sectionize(page, `Page ${index + 1}`), (section, sectionIndex) => ({
          ...section,
          name:
            section.name === `Page ${index + 1}`
              ? section.name
              : `Page ${index + 1} · ${sectionIndex + 1}: ${section.name}`,
        })),
      ),
      urls: uniqueStrings([
        ...links,
        ...EffectArray.flatMap(text, (__effectFlatMapValue, __effectFlatMapIndex) =>
          __effectFlatMapIndex in text ? extractUrls(__effectFlatMapValue) : [],
        ),
      ]),
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', forwardAbort);
    await destroy?.().catch(() => undefined);
  }
}

export function joinPdfTextItemsWithinLimit(items: readonly unknown[], maximumCharacters: number): string {
  const chunks: string[] = [];
  let characters = 0;
  for (const item of items) {
    if (!Predicate.isObject(item) || typeof item.str !== 'string') continue;
    const hasEndOfLine = item.hasEOL === true;
    characters += item.str.length + (hasEndOfLine ? 1 : 0);
    if (characters > maximumCharacters) {
      throw new Error('PDF extracted text exceeds the per-artifact character safety budget');
    }
    chunks.push(item.str);
    if (hasEndOfLine) chunks.push('\n');
  }
  return EffectArray.join(chunks, '');
}

function extractArchiveDocument(
  file: CodeGraphInventoryFile,
  extension: string,
  options: CorpusExtractionOptions,
): ExtractedCorpus {
  options.signal?.throwIfAborted();
  const inspectedEntryLimit = loweredSafetyLimit(
    options.archiveInspectedEntryLimit,
    CORPUS_ARCHIVE_INSPECTED_ENTRY_LIMIT,
  );
  const selectedEntryLimit = loweredSafetyLimit(options.archiveSelectedEntryLimit, CORPUS_ARCHIVE_SELECTED_ENTRY_LIMIT);
  let inspectedEntries = 0;
  let selectedBytes = 0;
  const selectedEntries: {readonly name: string; readonly normalized: string}[] = [];
  const selectedKeys = new Set<string>();
  const files = unzipSync(sourceBytes(file), {
    filter: (entry: UnzipFileInfo) => {
      inspectedEntries += 1;
      if (inspectedEntries > inspectedEntryLimit) {
        throw new Error('archive exceeds the per-document inspected entry-count safety budget');
      }
      const normalized = normalizeArchiveEntryName(entry.name);
      if (!normalized || !archiveEntryAccepted(extension, normalized)) return false;
      const key = Effect.pipe(normalized, EffectString.toLowerCase);
      if (selectedKeys.has(key)) return false;
      if (selectedEntries.length >= selectedEntryLimit) {
        throw new Error('archive exceeds the per-document selected entry-count safety budget');
      }
      if (entry.originalSize > CORPUS_ARCHIVE_ENTRY_BYTES_LIMIT) {
        throw new Error(`archive entry ${entry.name} expands beyond the per-entry safety budget`);
      }
      selectedBytes += entry.originalSize;
      if (selectedBytes > CORPUS_ARCHIVE_EXPANDED_BYTES_LIMIT) {
        throw new Error('selected archive text expands beyond the per-document safety budget');
      }
      selectedKeys.add(key);
      selectedEntries.push({name: entry.name, normalized});
      return true;
    },
  });
  options.signal?.throwIfAborted();
  const sections = EffectArray.flatMap(
    selectedEntries.sort((left, right) => compareNaturalCodeUnits(left.normalized, right.normalized)),
    (entry, index) => {
      const bytes = files[entry.name];
      if (!bytes) return [];
      const decoded = decodeUtf8(bytes);
      if (decoded === undefined) return [];
      const text = xmlToText(decoded);
      if (!text) return [];
      const entryName = archiveEntryLabel(extension, entry.normalized, index);
      return EffectArray.map(sectionize(text, entryName), (section, sectionIndex) => ({
        ...section,
        name: section.name === entryName ? entryName : `${entryName} · ${sectionIndex + 1}: ${section.name}`,
      }));
    },
  );
  return {
    diagnostics:
      sections.length === 0 ? [`${file.path}: document archive has no extractable text; indexed as an asset.`] : [],
    kind: 'document',
    metadata: [
      `format ${Effect.pipe(extension, EffectString.slice(1))}`,
      `${sections.length} text section${sections.length === 1 ? '' : 's'}`,
    ],
    sections,
    urls: uniqueStrings(EffectArray.flatMap(sections, section => extractUrls(section.text))),
  };
}

function extractImage(file: CodeGraphInventoryFile, extension: string): ExtractedCorpus {
  const dimensions = imageDimensions(sourceBytes(file), extension);
  return {
    diagnostics: [
      `${file.path}: image pixels were not interpreted; filename and deterministic metadata remain searchable.`,
    ],
    kind: 'asset',
    metadata: [
      `format ${Effect.pipe(extension, EffectString.slice(1))}`,
      ...(dimensions ? [`${dimensions.width}×${dimensions.height} pixels`] : []),
      `${file.size} bytes`,
    ],
    sections: [],
    urls: [],
  };
}

function extractMediaAsset(file: CodeGraphInventoryFile, extension: string, media: 'audio' | 'video'): ExtractedCorpus {
  return {
    diagnostics: [`${file.path}: ${media} was not transcribed; filename and deterministic metadata remain searchable.`],
    kind: 'asset',
    metadata: [`${media} format ${Effect.pipe(extension, EffectString.slice(1))}`, `${file.size} bytes`],
    sections: [],
    urls: [],
  };
}

function buildFacts(
  file: CodeGraphInventoryFile,
  extracted: ExtractedCorpus,
  context?: CodeGraphExtractionContext,
): CodeGraphFileFacts {
  const packageName = context ? Option.getOrUndefined(context.packageName) : undefined;
  const rootName = titleFromPath(file.path);
  const root = symbol(file, extracted.kind, rootName, file.path, 1, 1, {
    documentation: EffectArray.join([rootName, ...extracted.metadata], '\n'),
    packageName,
    signature: EffectArray.join(extracted.metadata, ' · '),
  });
  const symbols: CodeGraphSymbol[] = [root];
  const edges: CodeGraphEdge[] = [];
  let logicalLine = 2;
  EffectArray.forEach(extracted.sections, (section, index) => {
    const lineCount = Math.max(1, Effect.pipe(section.text, EffectString.split('\n')).length);
    const child = symbol(
      file,
      'section',
      section.name,
      `${file.path}#section-${index + 1}-${slug(section.name)}`,
      logicalLine,
      logicalLine + lineCount - 1,
      {documentation: section.text, packageName},
    );
    symbols.push(child);
    edges.push(edge(file, root, child, 'contains', logicalLine));
    logicalLine += lineCount;
  });
  EffectArray.forEach(extracted.urls, (url, index) => {
    const child = symbol(
      file,
      'external-resource',
      url,
      `${file.path}#url-${Effect.pipe(sha256HexSync(url), EffectString.slice(0, 16))}`,
      logicalLine,
      logicalLine,
      {
        documentation: url,
        language: 'url',
        packageName,
      },
    );
    symbols.push(child);
    edges.push(edge(file, root, child, 'references', logicalLine + index));
  });
  Option.getOrUndefined(
    Option.map(Option.fromNullishOr(extracted.resourceReferences), __effectArrayReceiver =>
      EffectArray.forEach(__effectArrayReceiver, (reference, index) => {
        const child = symbol(
          file,
          'resource-reference',
          reference,
          `${file.path}#resource-${Effect.pipe(sha256HexSync(reference), EffectString.slice(0, 16))}`,
          logicalLine + index,
          logicalLine + index,
          {
            documentation: `Declared mobile resource reference ${reference}`,
            packageName,
          },
        );
        symbols.push(child);
        edges.push(edge(file, root, child, 'references', logicalLine + index));
      }),
    ),
  );
  return {diagnostics: extracted.diagnostics, edges, path: file.path, symbols};
}

function symbol(
  file: CodeGraphInventoryFile,
  kind: string,
  name: string,
  qualifiedName: string,
  line: number,
  endLine: number,
  options: {
    readonly documentation?: string;
    readonly language?: string;
    readonly packageName?: string;
    readonly signature?: string;
  } = {},
): CodeGraphSymbol {
  const language = options.language ?? file.language;
  return {
    contentHash: file.contentHash,
    documentation: options.documentation,
    exported: true,
    id: `cgs_${Effect.pipe(sha256HexSync(`${file.path}\0${qualifiedName}\0${kind}`), EffectString.slice(0, 40))}`,
    kind,
    language,
    lookupKeys: uniqueStrings([name, qualifiedName, file.path, ...tokens(name), ...tokens(file.path)]),
    name,
    packageName: options.packageName,
    path: file.path,
    qualifiedName,
    resolutionDomain: 'corpus',
    signature: options.signature,
    span: {column: 1, endColumn: 1, endLine, line},
  };
}

function edge(
  file: CodeGraphInventoryFile,
  source: CodeGraphSymbol,
  target: CodeGraphSymbol,
  relation: 'contains' | 'references',
  line: number,
): CodeGraphEdge {
  return {
    confidence: 1,
    evidencePath: file.path,
    evidenceSpan: {column: 1, endColumn: 1, endLine: line, line},
    id: `cge_${Effect.pipe(sha256HexSync(`${source.id}\0${relation}\0${target.id}`), EffectString.slice(0, 40))}`,
    provenance: 'declared',
    relation,
    sourceId: source.id,
    sourceName: source.name,
    targetId: target.id,
    targetName: target.name,
  };
}

function sectionize(raw: string, fallbackName: string): readonly ExtractedSection[] {
  const text = normalizeWhitespace(raw);
  if (!text) return [];
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native matchAll preserves the standard RegExpMatchArray index type.
  const headings = [...text.matchAll(/^(#{1,6}|={1,6}|\*{1,6})\s+(.+)$/gm)];
  if (headings.length === 0) return chunkSection(fallbackName, text);
  const sections: ExtractedSection[] = [];
  const preamble = Effect.pipe(text, __effectPipeInput => {
    const __effectPipeStage0 = Effect.pipe(__effectPipeInput, EffectString.slice(0, headings[0].index));
    const __effectPipeStage1 = Effect.pipe(__effectPipeStage0, EffectString.trim);
    return __effectPipeStage1;
  });
  if (preamble) sections.push(...chunkSection(fallbackName, preamble));
  EffectArray.forEach(headings, (match, index) => {
    const start = match.index + match[0].length;
    const end = headings[index + 1]?.index ?? text.length;
    const name =
      Effect.pipe(match[2], EffectString.trim, EffectString.replace(/\s+#+$/, '')) || `${fallbackName} · ${index + 1}`;
    const body = Effect.pipe(text, EffectString.slice(start, end), EffectString.trim);
    sections.push(...chunkSection(name, body || name));
  });
  return sections;
}

function chunkSection(name: string, text: string): readonly ExtractedSection[] {
  const paragraphs = EffectArray.filter(
    EffectArray.map(Effect.pipe(text, EffectString.split(/\n{2,}/)), value => Effect.pipe(value, EffectString.trim)),
    Boolean,
  );
  if (paragraphs.length === 0) return [];
  const output: ExtractedSection[] = [];
  let current = '';
  const flush = () => {
    if (!current) return;
    output.push({name: output.length === 0 ? name : `${name} · part ${output.length + 1}`, text: current});
    current = '';
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > TEXT_CHUNK_TARGET) {
      flush();
      for (let offset = 0; offset < paragraph.length; offset += TEXT_CHUNK_TARGET) {
        const part = Effect.pipe(paragraph, EffectString.slice(offset, offset + TEXT_CHUNK_TARGET), EffectString.trim);
        if (part) output.push({name: output.length === 0 ? name : `${name} · part ${output.length + 1}`, text: part});
      }
      continue;
    }
    const combined = current ? `${current}\n\n${paragraph}` : paragraph;
    if (current && combined.length > TEXT_CHUNK_TARGET) flush();
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  flush();
  return output;
}

function normalizeTextDocument(content: string, extension: string): string {
  if (extension === '.ipynb') return notebookToText(content);
  if (['.html', '.htm', '.svg', '.xml', '.drawio', '.graphml', '.webloc'].includes(extension)) {
    return xmlToText(content);
  }
  if (extension === '.rtf') return rtfToText(content);
  if (extension === '.url') {
    return Effect.pipe(content, EffectString.replace(/^URL=/m, 'URL: '));
  }
  if (extension === '.rst') {
    return Effect.pipe(content, EffectString.replace(/^(.+)\n([=\-~^"`:+*#])\2{2,}\s*$/gm, '# $1'));
  }
  if (['.adoc', '.asciidoc'].includes(extension))
    return Effect.pipe(content, EffectString.replace(/^(={1,6})\s+/gm, Effect.pipe('#', EffectString.repeat(1)) + ' '));
  if (extension === '.org')
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native replacement callbacks receive capture groups and offsets; Effect String accepts replacement strings only. The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
    return content.replace(/^(\*{1,6})\s+/gm, (_match, marks: string) => `${'#'.repeat(marks.length)} `);
  if (extension === '.tex') {
    return replaceTexHeadings(content);
  }
  return content;
}

function replaceTexHeadings(content: string): string {
  const commands = ['subsubsection', 'subsection', 'section', 'chapter', 'part'] as const;
  const output: string[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native search position argument changes the search origin; Effect String has no position parameter.
    const opening = content.indexOf('\\', cursor);
    if (opening < 0) break;
    const command = Option.getOrUndefined(
      EffectArray.findFirst(
        commands,
        __effectArrayValue =>
          !!(candidate => Effect.pipe(content, EffectString.startsWith(candidate, opening + 1)))(__effectArrayValue),
      ),
    );
    if (!command) {
      output.push(Effect.pipe(content, EffectString.slice(cursor, opening + 1)));
      cursor = opening + 1;
      continue;
    }
    let brace = opening + 1 + command.length;
    if (content[brace] === '*') brace += 1;
    if (content[brace] !== '{') {
      output.push(Effect.pipe(content, EffectString.slice(cursor, brace)));
      cursor = brace;
      continue;
    }
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native search position argument changes the search origin; Effect String has no position parameter.
    const closing = content.indexOf('}', brace + 1);
    if (closing <= brace + 1) {
      output.push(Effect.pipe(content, EffectString.slice(cursor, brace + 1)));
      cursor = brace + 1;
      continue;
    }
    output.push(
      Effect.pipe(content, EffectString.slice(cursor, opening)),
      '# ',
      Effect.pipe(content, EffectString.slice(brace + 1, closing)),
    );
    cursor = closing + 1;
  }
  output.push(Effect.pipe(content, EffectString.slice(cursor)));
  return EffectArray.join(output, '');
}

function notebookToText(content: string): string {
  try {
    const value: unknown = JSON.parse(content);
    if (!Predicate.isObject(value) || !EffectArray.isArray(value.cells)) return content;
    return EffectArray.join(
      EffectArray.flatMap(value.cells, (cell, index) => {
        if (!Predicate.isObject(cell) || !EffectArray.isArray(cell.source)) return [];
        const source = EffectArray.join(
          EffectArray.filter(cell.source, (line): line is string => typeof line === 'string'),
          '',
        );
        if (!Effect.pipe(source, EffectString.trim)) return [];
        const label = cell.cell_type === 'markdown' ? 'Markdown' : cell.cell_type === 'code' ? 'Code' : 'Cell';
        return [`# ${label} cell ${index + 1}\n${source}`];
      }),
      '\n\n',
    );
  } catch {
    return content;
  }
}

function xmlToText(content: string): string {
  return decodeXmlEntities(
    Effect.pipe(
      Effect.pipe(content, EffectString.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' '))
        // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native replacement callbacks receive capture groups and offsets; Effect String accepts replacement strings only.
        .replace(
          /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
          // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
          (_match, level: string, body: string) => `\n${'#'.repeat(Number(level))} ${stripTags(body)}\n`,
        ),
      EffectString.replace(/<\/(?:p|div|section|article|li|tr|w:p|a:p|text:p|text:h|table:table-row)>/gi, '\n'),
      EffectString.replace(/<(?:br|w:br|a:br)\s*\/?>/gi, '\n'),
      EffectString.replace(/<[^>]+>/g, ' '),
    ),
  );
}

function rtfToText(content: string): string {
  return Effect.pipe(
    Effect.pipe(content, EffectString.replace(/\\par[d]?\b/g, '\n'))
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native replacement callbacks receive capture groups and offsets; Effect String accepts replacement strings only.
      .replace(/\\'[0-9a-fA-F]{2}/g, match =>
        String.fromCharCode(Number.parseInt(Effect.pipe(match, EffectString.slice(2)), 16)),
      ),
    EffectString.replace(/\\[a-zA-Z]+-?\d* ?/g, ''),
    EffectString.replace(/[{}]/g, ' '),
  );
}

function archiveEntryAccepted(extension: string, name: string): boolean {
  const normalized = Effect.pipe(name, EffectString.toLowerCase);
  if (extension === '.docx') {
    return /^word\/(?:document|comments|footnotes|endnotes|header\d+|footer\d+)\.xml$/.test(normalized);
  }
  if (extension === '.pptx') return /^ppt\/(?:slides\/slide\d+|notesslides\/notesslide\d+)\.xml$/.test(normalized);
  if (extension === '.xlsx')
    return /^(?:xl\/(?:sharedstrings|workbook)|xl\/worksheets\/sheet\d+)\.xml$/.test(normalized);
  if (['.odt', '.odp', '.ods'].includes(extension)) return normalized === 'content.xml' || normalized === 'meta.xml';
  if (extension === '.epub') return /\.(?:xhtml|html|htm|ncx|opf)$/i.test(normalized);
  return false;
}

function normalizeArchiveEntryName(value: string): string | undefined {
  if (Effect.pipe(value, EffectString.includes('\0'))) return undefined;
  const normalized = Effect.pipe(value, EffectString.normalize('NFC'), EffectString.replaceAll('\\', '/'));
  if (Effect.pipe(normalized, EffectString.startsWith('/'))) return undefined;
  const segments: string[] = [];
  for (const segment of Effect.pipe(normalized, EffectString.split('/'))) {
    if (!segment || segment === '.') continue;
    if (segment === '..') return undefined;
    segments.push(segment);
  }
  return segments.length === 0 ? undefined : EffectArray.join(segments, '/');
}

function archiveEntryLabel(extension: string, name: string, index: number): string {
  const normalized = Effect.pipe(name, EffectString.replaceAll('\\', '/'));
  const slide = /slide(\d+)\.xml$/i.exec(normalized)?.[1];
  if (extension === '.pptx' && slide) return `Slide ${slide}`;
  const sheet = /sheet(\d+)\.xml$/i.exec(normalized)?.[1];
  if (extension === '.xlsx' && sheet) return `Sheet ${sheet}`;
  if (extension === '.docx' && /document\.xml$/i.test(normalized)) return 'Document';
  return (
    Effect.pipe(Effect.pipe(normalized, EffectString.split('/')).at(-1), effectOptionalString =>
      effectOptionalString == null
        ? undefined
        : Effect.pipe(effectOptionalString, EffectString.replace(/\.[^.]+$/, '')),
    ) || `Part ${index + 1}`
  );
}

function imageDimensions(
  bytes: Uint8Array,
  extension: string,
): {readonly height: number; readonly width: number} | undefined {
  if (extension === '.png' && bytes.length >= 24 && ascii(bytes, 1, 3) === 'PNG') {
    return {height: uint32(bytes, 20), width: uint32(bytes, 16)};
  }
  if (extension === '.gif' && bytes.length >= 10 && ascii(bytes, 0, 3) === 'GIF') {
    return {height: uint16le(bytes, 8), width: uint16le(bytes, 6)};
  }
  if (['.jpg', '.jpeg'].includes(extension)) return jpegDimensions(bytes);
  if (extension === '.webp' && bytes.length >= 30 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    if (ascii(bytes, 12, 4) === 'VP8X') {
      return {height: uint24le(bytes, 27) + 1, width: uint24le(bytes, 24) + 1};
    }
  }
  return undefined;
}

function jpegDimensions(bytes: Uint8Array): {readonly height: number; readonly width: number} | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2 || offset + 2 + length > bytes.length) return undefined;
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: (bytes[offset + 5] << 8) | bytes[offset + 6],
        width: (bytes[offset + 7] << 8) | bytes[offset + 8],
      };
    }
    offset += 2 + length;
  }
  return undefined;
}

function sourceBytes(file: CodeGraphInventoryFile): Uint8Array {
  if (file.bytes) return file.bytes;
  if (file.content !== undefined) return new TextEncoder().encode(file.content);
  throw new Error(`Repository bytes for ${file.path} were not loaded before extraction.`);
}

function requireText(file: CodeGraphInventoryFile): string {
  if (file.content !== undefined) return file.content;
  if (file.bytes) {
    const decoded = decodeUtf8(file.bytes);
    if (decoded !== undefined) return decoded;
  }
  throw new Error(`Repository text for ${file.path} was not loaded before extraction.`);
}

function normalizeWhitespace(value: string): string {
  return Effect.pipe(
    value,
    EffectString.replace(/\r\n?/g, '\n'),
    EffectString.replace(/[\t ]+\n/g, '\n'),
    EffectString.replace(/\n{4,}/g, '\n\n\n'),
    EffectString.trim,
  );
}

function extractUrls(value: string): readonly string[] {
  return uniqueStrings(
    EffectArray.map([...Effect.pipe(value, EffectString.matchAll(/\bhttps?:\/\/[^\s<>"')\]}]+/gi))], match =>
      Effect.pipe(match[0], EffectString.replace(/[.,;:]$/, '')),
    ),
  );
}

function decodeXmlEntities(value: string): string {
  return Effect.pipe(
    value
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native replacement callbacks receive capture groups and offsets; Effect String accepts replacement strings only.
      .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native replacement callbacks receive capture groups and offsets; Effect String accepts replacement strings only.
      .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16))),
    EffectString.replaceAll('&lt;', '<'),
    EffectString.replaceAll('&gt;', '>'),
    EffectString.replaceAll('&quot;', '"'),
    EffectString.replaceAll('&apos;', "'"),
    EffectString.replaceAll('&amp;', '&'),
  );
}

function stripTags(value: string): string {
  return Effect.pipe(
    value,
    EffectString.replace(/<[^>]+>/g, ' '),
    EffectString.replace(/\s+/g, ' '),
    EffectString.trim,
  );
}

function titleFromPath(path: string): string {
  return (
    Effect.pipe(basename(path), EffectString.replace(/\.[^.]+$/, ''), EffectString.replace(/[-_]+/g, ' '))
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native replacement callbacks receive capture groups and offsets; Effect String accepts replacement strings only.
      .replace(/\b\w/g, character => Effect.pipe(character, EffectString.toUpperCase))
  );
}

function basename(path: string): string {
  return Effect.pipe(path, EffectString.replaceAll('\\', '/'), EffectString.split('/')).at(-1) ?? path;
}

function extensionOf(path: string): string {
  const name = Effect.pipe(basename(path), EffectString.toLowerCase);
  const index = Effect.pipe(
    name,
    EffectString.lastIndexOf('.'),
    Effect.Option.getOrElse(() => -1),
  );
  return index < 0 ? '' : Effect.pipe(name, EffectString.slice(index));
}

function tokens(value: string): readonly string[] {
  return EffectArray.filter(
    EffectArray.map(
      Effect.pipe(value, EffectString.replace(/([a-z0-9])([A-Z])/g, '$1 $2'), EffectString.split(/[^A-Za-z0-9]+/)),
      token => Effect.pipe(token, EffectString.toLowerCase),
    ),
    token => token.length >= 2,
  );
}

function slug(value: string): string {
  return EffectArray.join(tokens(value).slice(0, 12), '-') || 'section';
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(EffectArray.filter(values, Boolean))];
}

function loweredSafetyLimit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error('corpus extraction safety limits must be positive integers');
  return Math.min(value, maximum);
}

function pdfExtractionBudget(options: CorpusExtractionOptions): {
  readonly check: () => void;
  readonly maximumElapsedMilliseconds: number;
  readonly maximumExtractedTextCharacters: number;
} {
  const maximumElapsedMilliseconds = loweredSafetyLimit(
    options.maximumElapsedMilliseconds,
    CORPUS_PDF_EXTRACTION_MILLISECONDS_LIMIT,
  );
  const maximumExtractedTextCharacters = loweredSafetyLimit(
    options.maximumExtractedTextCharacters,
    CORPUS_PDF_EXTRACTED_TEXT_CHARACTER_LIMIT,
  );
  const now = options.monotonicNow ?? (() => performance.now());
  const startedAt = now();
  return {
    check: () => {
      options.signal?.throwIfAborted();
      if (now() - startedAt > maximumElapsedMilliseconds) {
        throw new Error('PDF extraction exceeded the per-artifact elapsed-time safety budget');
      }
    },
    maximumElapsedMilliseconds,
    maximumExtractedTextCharacters,
  };
}

function abortable<A>(promise: PromiseLike<A>, signal: AbortSignal): Promise<A> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  const {promise: result, reject, resolve} = Promise.withResolvers<A>();
  const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  signal.addEventListener('abort', abort, {once: true});
  void Promise.resolve(promise).then(
    value => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    },
    cause => {
      signal.removeEventListener('abort', abort);
      reject(cause);
    },
  );
  return result;
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    return undefined;
  }
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function uint16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function uint24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function uint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
