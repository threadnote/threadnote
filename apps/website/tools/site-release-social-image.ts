import {Array as EffectArray} from 'effect';
import {Resvg} from '@resvg/resvg-js';
import {ScriptError} from './effect/errors.js';
import type {WebsiteRelease} from './site-release-notes.js';
import {websiteArticleSocialImageHeight, websiteArticleSocialImageWidth} from '../src/content/websiteArticles.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const headlineMaximumWidth = 760;
const headlineMaximumHeight = 220;
const headlineFontSizes = [38, 36, 34, 32, 30, 28, 26, 24] as const;
export const websiteReleaseSocialImageTemplateRevision = 1;

export interface ReleaseSocialHeadlineLayout {
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly lines: readonly string[];
}

function estimatedGlyphWidth(character: string): number {
  if (character === ' ') return 0.3;
  if (/[ilI.,'’!|:;]/u.test(character)) return 0.28;
  if (/[mwMW@%&]/u.test(character)) return 0.86;
  if (/[A-Z0-9]/u.test(character)) return 0.62;
  return 0.52;
}

function estimatedTextWidth(text: string, fontSize: number): number {
  return EffectArray.reduce([...text], 0, (width, character) => width + estimatedGlyphWidth(character)) * fontSize;
}

function wrapHeadline(headline: string, fontSize: number): readonly string[] | undefined {
  const lines: string[] = [];
  let line = '';
  for (const word of Effect.pipe(headline, EffectString.split(' '))) {
    if (estimatedTextWidth(word, fontSize) > headlineMaximumWidth) return undefined;
    const candidate = line ? `${line} ${word}` : word;
    if (estimatedTextWidth(candidate, fontSize) <= headlineMaximumWidth) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function layoutReleaseSocialHeadline(headline: string): ReleaseSocialHeadlineLayout {
  for (const fontSize of headlineFontSizes) {
    const lines = wrapHeadline(headline, fontSize);
    const lineHeight = Math.round(fontSize * 1.22);
    if (lines && lines.length * lineHeight <= headlineMaximumHeight) return {fontSize, lineHeight, lines};
  }
  throw ScriptError.make({message: 'The release social-card headline does not fit the bounded image layout.'});
}

function escapeXml(value: string): string {
  return Effect.pipe(
    value,
    EffectString.replaceAll('&', '&amp;'),
    EffectString.replaceAll('<', '&lt;'),
    EffectString.replaceAll('>', '&gt;'),
    EffectString.replaceAll('"', '&quot;'),
    EffectString.replaceAll("'", '&apos;'),
  );
}

const graphPoints = [
  [760, 103, 5],
  [885, 69, 7],
  [1030, 105, 5],
  [1140, 61, 8],
  [704, 218, 7],
  [842, 194, 11],
  [970, 234, 7],
  [1107, 187, 6],
  [1192, 267, 5],
  [673, 350, 5],
  [812, 327, 8],
  [935, 365, 12],
  [1075, 329, 7],
  [1169, 401, 9],
  [739, 489, 8],
  [878, 463, 5],
  [1007, 511, 9],
  [1127, 493, 6],
  [1190, 578, 5],
] as const;

const graphEdges = [
  [0, 1],
  [0, 4],
  [0, 5],
  [1, 2],
  [1, 5],
  [2, 3],
  [2, 6],
  [2, 7],
  [3, 7],
  [4, 5],
  [4, 9],
  [4, 10],
  [5, 6],
  [5, 10],
  [5, 11],
  [6, 7],
  [6, 11],
  [6, 12],
  [7, 8],
  [7, 12],
  [8, 13],
  [9, 10],
  [9, 14],
  [10, 11],
  [10, 14],
  [10, 15],
  [11, 12],
  [11, 15],
  [11, 16],
  [12, 13],
  [12, 16],
  [12, 17],
  [13, 17],
  [13, 18],
  [14, 15],
  [15, 16],
  [16, 17],
  [17, 18],
] as const;

function graphMarkup(): string {
  const edges = EffectArray.join(
    EffectArray.map(graphEdges, ([from, to], index) => {
      const left = graphPoints[from];
      const right = graphPoints[to];
      const dashed = index % 9 === 0 ? ' stroke-dasharray="5 8"' : '';
      return `<line x1="${left[0]}" y1="${left[1]}" x2="${right[0]}" y2="${right[1]}"${dashed} />`;
    }),
    '',
  );
  const points = EffectArray.join(
    EffectArray.map(graphPoints, ([x, y, radius], index) => {
      const accent = index === 5 || index === 11 || index === 16;
      return `<circle cx="${x}" cy="${y}" r="${radius}" fill="${accent ? '#67e8c7' : '#7d899b'}" />`;
    }),
    '',
  );
  return `<g opacity="0.72" stroke="#718096" stroke-width="1">${edges}</g><g>${points}</g>`;
}

export function renderWebsiteReleaseSocialImageSvg(release: Pick<WebsiteRelease, 'headline' | 'version'>): string {
  const version = Effect.pipe(release.version, EffectString.replace(/^v/u, ''));
  const layout = layoutReleaseSocialHeadline(release.headline);
  const headline = EffectArray.join(
    EffectArray.map(
      layout.lines,
      (line, index) => `<tspan x="70" dy="${index === 0 ? 0 : layout.lineHeight}">${escapeXml(line)}</tspan>`,
    ),
    '',
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${websiteArticleSocialImageWidth}" height="${websiteArticleSocialImageHeight}" viewBox="0 0 ${websiteArticleSocialImageWidth} ${websiteArticleSocialImageHeight}">
  <defs>
    <radialGradient id="glow" cx="83%" cy="45%" r="63%"><stop offset="0" stop-color="#123348"/><stop offset="0.52" stop-color="#091724"/><stop offset="1" stop-color="#050b13"/></radialGradient>
    <linearGradient id="left-fade" x1="0" x2="1"><stop offset="0" stop-color="#050b13"/><stop offset="0.72" stop-color="#050b13" stop-opacity="0.96"/><stop offset="1" stop-color="#050b13" stop-opacity="0"/></linearGradient>
    <pattern id="grid" width="112" height="112" patternUnits="userSpaceOnUse"><path d="M112 0H0V112" fill="none" stroke="#314052" stroke-opacity="0.3"/><path d="M106 0h12M112-6v12" stroke="#5b6878" stroke-opacity="0.42"/></pattern>
    <filter id="accent-glow"><feGaussianBlur stdDeviation="8" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <rect width="1200" height="630" fill="url(#grid)"/>
  <g>${graphMarkup()}</g>
  <rect width="900" height="630" fill="url(#left-fade)"/>
  <circle cx="935" cy="365" r="18" fill="#67e8c7" opacity="0.16" filter="url(#accent-glow)"/>
  <text x="70" y="72" fill="#dce5ee" font-family="Spline Sans" font-size="22" font-weight="600" letter-spacing="7">WHAT&apos;S NEW</text>
  <text x="70" y="202" font-family="Spline Sans" font-size="72" font-weight="600"><tspan fill="#f7fafc">Threadnote</tspan><tspan dx="20" fill="#67e8c7">${escapeXml(version)}</tspan></text>
  <rect x="70" y="244" width="92" height="4" rx="2" fill="#67e8c7"/>
  <text x="70" y="294" fill="#8fa0b3" font-family="Spline Sans" font-size="15" font-weight="600" letter-spacing="3.5">RELEASE HIGHLIGHT</text>
  <text x="70" y="342" fill="#edf4f8" font-family="Spline Sans" font-size="${layout.fontSize}" font-weight="400">${headline}</text>
  <text x="70" y="588" fill="#74859a" font-family="Spline Sans" font-size="15" font-weight="600" letter-spacing="2.6">THREADNOTE.IO / WHAT&apos;S NEW</text>
  <rect x="1" y="1" width="1198" height="628" rx="18" fill="none" stroke="#324255" stroke-opacity="0.6" stroke-width="2"/>
</svg>`;
}

export function renderWebsiteReleaseSocialImagePng(
  repositoryRoot: string,
  release: Pick<WebsiteRelease, 'headline' | 'version'>,
): Uint8Array {
  const fontRoot = `${repositoryRoot}/node_modules/@expo-google-fonts/spline-sans`;
  const renderer = new Resvg(renderWebsiteReleaseSocialImageSvg(release), {
    font: {
      defaultFontFamily: 'Spline Sans',
      fontFiles: [
        `${fontRoot}/400Regular/SplineSans_400Regular.ttf`,
        `${fontRoot}/600SemiBold/SplineSans_600SemiBold.ttf`,
      ],
      loadSystemFonts: false,
    },
  });
  const image = renderer.render();
  if (image.width !== websiteArticleSocialImageWidth || image.height !== websiteArticleSocialImageHeight) {
    throw ScriptError.make({message: 'The release social image renderer returned unexpected dimensions.'});
  }
  return image.asPng();
}
