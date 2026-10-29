import {Array as EffectArray} from 'effect';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Resvg} from '@resvg/resvg-js';
import {Console, Effect, FileSystem, Path} from 'effect';
import {strToU8, zipSync, type Zippable} from 'fflate';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const palettes = [
  {id: 'monochrome-light', label: 'Monochrome / light', foreground: '#182124', background: '#ffffff'},
  {id: 'monochrome-dark', label: 'Monochrome / dark', foreground: '#ffffff', background: '#182124'},
  {id: 'brand-light', label: 'Brand / light', foreground: '#182124', background: '#67e8c7'},
  {id: 'brand-dark', label: 'Brand / dark', foreground: '#67e8c7', background: '#141b1e'},
] as const;
const shapes = ['naked', 'rounded-square', 'circle'] as const;
type Shape = (typeof shapes)[number] | 'avatar';
type Palette = (typeof palettes)[number];
const zipDate = new Date('2000-01-01T00:00:00Z');

function symbolGroup(source: string): string {
  const group = /<g\b[\s\S]*<\/g>/.exec(source)?.[0];
  if (!group) throw ScriptError.make({message: 'The canonical brand SVG is missing its symbol group.'});
  return group;
}

function artwork(group: string, shape: Shape, palette: Palette): string {
  const background =
    shape === 'circle'
      ? `<circle cx="128" cy="128" r="128" fill="${palette.background}"/>`
      : shape === 'naked'
        ? ''
        : `<rect width="256" height="256" rx="${shape === 'avatar' ? 0 : 44}" fill="${palette.background}"/>`;
  return background + Effect2.pipe(group, EffectString.replaceAll('#67e8c7', palette.foreground));
}

function svg(group: string, shape: Shape, palette: Palette): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" role="img" aria-label="Threadnote">
  <title>Threadnote Continuum</title>
  <desc>A continuous t and n with an extended tail. ${shape}, ${Effect2.pipe(palette.label, EffectString.toLowerCase)}.</desc>
  ${artwork(group, shape, palette)}
</svg>
`;
}

function png(source: string, width: number, root: string): Uint8Array {
  const fontRoot = `${root}/node_modules/@expo-google-fonts/spline-sans`;
  return new Resvg(source, {
    fitTo: {mode: 'width', value: width},
    font: {
      defaultFontFamily: 'Spline Sans',
      fontFiles: [
        `${fontRoot}/400Regular/SplineSans_400Regular.ttf`,
        `${fontRoot}/600SemiBold/SplineSans_600SemiBold.ttf`,
      ],
      loadSystemFonts: false,
    },
  })
    .render()
    .asPng();
}

function faviconIco(source: string, root: string): Uint8Array {
  const sizes = [16, 32, 48];
  const images = EffectArray.map(sizes, size => png(source, size, root));
  const headerSize = 6 + sizes.length * 16;
  const output = new Uint8Array(headerSize + EffectArray.reduce(images, 0, (sum, image) => sum + image.length));
  const view = new DataView(output.buffer);
  view.setUint16(2, 1, true);
  view.setUint16(4, sizes.length, true);
  let offset = headerSize;
  for (const [index, image] of images.entries()) {
    const entry = 6 + index * 16;
    view.setUint8(entry, sizes[index]);
    view.setUint8(entry + 1, sizes[index]);
    view.setUint16(entry + 4, 1, true);
    view.setUint16(entry + 6, 32, true);
    view.setUint32(entry + 8, image.length, true);
    view.setUint32(entry + 12, offset, true);
    output.set(image, offset);
    offset += image.length;
  }
  return output;
}

function overview(group: string): string {
  const cells = EffectArray.flatMap(shapes, (shape, row) =>
    EffectArray.map(palettes, (palette, column) => {
      const x = 40 + column * 300;
      const y = 140 + row * 276;
      const isDark = Effect2.pipe(palette.id, EffectString.endsWith('-dark'));
      return `<g><rect x="${x}" y="${y}" width="276" height="252" rx="16" fill="${isDark ? '#263035' : '#e8ebe6'}"/>
        <g transform="translate(${x + 38} ${y + 14}) scale(.78125)">${artwork(group, shape, palette)}</g>
        <text x="${x + 138}" y="${y + 236}" text-anchor="middle" fill="${isDark ? '#e9efec' : '#182124'}" font-size="14">${shape}</text></g>`;
    }),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="1010" viewBox="0 0 1280 1010">
    <rect width="1280" height="1010" fill="#f7f7f2"/>
    <g font-family="Spline Sans"><text x="40" y="55" fill="#182124" font-size="30" font-weight="600">Threadnote / Continuum</text>
    ${EffectArray.join(
      EffectArray.map(
        palettes,
        (palette, column) =>
          `<text x="${40 + column * 300}" y="113" fill="#182124" font-size="18">${palette.label}</text>`,
      ),
      '',
    )}
    ${EffectArray.join(cells, '')}<text x="40" y="994" fill="#606864" font-size="13">Approved extended-tail geometry · 12 SVG variants · Social avatars at 512 and 1024 px</text></g>
  </svg>`;
}

function socialCard(group: string, wordmark: string): string {
  const lettering = /<path\b[^>]*\/>/.exec(wordmark)?.[0];
  if (!lettering) throw ScriptError.make({message: 'The outlined wordmark is missing its path.'});
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <rect width="1200" height="630" fill="#141b1e"/>
    <g transform="translate(36 106) scale(1.4)">${group}</g>
    <g transform="translate(404 233) scale(.91)">${lettering}</g>
    <text x="408" y="377" fill="#b9cbc5" font-family="Spline Sans" font-size="34">Your team remembers.</text>
    <path d="M80 499H1120" stroke="#34423e"/>
    <text x="80" y="557" fill="#67e8c7" font-family="Spline Sans" font-size="22">threadnote.io</text>
  </svg>`;
}

const generateBrandAssets = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL('..', import.meta.url));
  const brandRoot = path.join(root, 'assets/brand');
  const publicRoot = path.join(root, 'apps/website/public');
  const canonical = yield* fs.readFileString(path.join(brandRoot, 'threadnote-logo.svg'));
  const wordmark = yield* fs.readFileString(path.join(brandRoot, 'threadnote-wordmark.svg'));
  const group = symbolGroup(canonical);
  for (const directory of ['continuum']) yield* fs.makeDirectory(path.join(brandRoot, directory), {recursive: true});
  for (const directory of ['brand/png', 'brand/avatars'])
    yield* fs.makeDirectory(path.join(publicRoot, directory), {recursive: true});
  const archive: Zippable = {};
  for (const shape of shapes) {
    for (const palette of palettes) {
      const name = `threadnote-${shape}-${palette.id}`;
      const vector = svg(group, shape, palette);
      const raster = png(vector, 1024, root);
      yield* fs.writeFileString(path.join(brandRoot, 'continuum', `${name}.svg`), vector);
      yield* fs.writeFile(path.join(publicRoot, 'brand/png', `${name}-1024.png`), raster);
      archive[`svg/${name}.svg`] = [strToU8(vector), {mtime: zipDate}];
      archive[`png/${name}-1024.png`] = [raster, {mtime: zipDate}];
    }
  }
  for (const palette of palettes) {
    for (const size of [512, 1024]) {
      const name = `threadnote-avatar-${palette.id}-${size}.png`;
      const raster = png(svg(group, 'avatar', palette), size, root);
      yield* fs.writeFile(path.join(publicRoot, 'brand/avatars', name), raster);
      archive[`avatars/${name}`] = [raster, {mtime: zipDate}];
    }
  }
  const darkBrand = palettes[3];
  const favicon = svg(group, 'circle', darkBrand);
  yield* fs.writeFileString(path.join(publicRoot, 'threadnote-logo.svg'), canonical);
  yield* fs.writeFileString(path.join(root, 'cursor-plugin/assets/logo.svg'), svg(group, 'rounded-square', darkBrand));
  yield* fs.writeFileString(path.join(publicRoot, 'favicon.svg'), favicon);
  yield* fs.writeFile(path.join(publicRoot, 'favicon.ico'), faviconIco(favicon, root));
  yield* fs.writeFile(path.join(publicRoot, 'apple-touch-icon.png'), png(svg(group, 'avatar', darkBrand), 180, root));
  const preview = png(overview(group), 1280, root);
  yield* fs.writeFile(path.join(publicRoot, 'brand/overview.png'), preview);
  yield* fs.writeFile(path.join(publicRoot, 'og.png'), png(socialCard(group, wordmark), 1200, root));
  archive['overview.png'] = [preview, {mtime: zipDate}];
  archive['README.md'] = [strToU8(yield* fs.readFileString(path.join(brandRoot, 'README.md'))), {mtime: zipDate}];
  yield* fs.writeFile(path.join(publicRoot, 'brand/threadnote-brand-kit.zip'), zipSync(archive, {level: 9}));
  yield* Console.log(
    'Generated 12 SVGs, 12 matching PNGs, 8 social avatars, website icons, social card, and brand kit.',
  );
});

BunRuntime.runMain(provideScriptLayer(generateBrandAssets, BunServices.layer));
