# Third-party software

Threadnote 5 is a self-contained application with an embedded Bun runtime. It does not install or invoke Node.js,
Python, OpenViking, or a separate memory server.

## Runtime and bundled software

Direct runtime software and packages bundled into the published JavaScript retain their own licenses:

- `node-llama-cpp` (MIT), used in a supervised local worker with prebuilt `llama.cpp` binaries for GGUF inference
- Bun (MIT), embedded into each compiled executable
- `effect`, `@effect/platform-bun`, `@effect/ai-openai-compat`, `@effect/sql-sqlite-bun`, and `@effect/vitest` (MIT)
- `@modelcontextprotocol/sdk` 1.32.1 (MIT), pinned for the Streamable HTTP and stdio MCP protocol boundary
- `jose` 6.2.12 (MIT), used for OAuth and Cursor workload JWT/JWKS verification
- `pxpipe-proxy` 0.14.0 (MIT), used to render optional MCP memory PNG pages
- `postgres` 3.4.9 (MIT), used by the managed remote-memory PostgreSQL service and operator
- `zod` 4.4.3 (MIT), retained transitively by `@modelcontextprotocol/sdk` for its protocol implementation
- `react`, `react-dom`, and `react-markdown` (MIT)
- `remark-gfm` (MIT)
- `three` (MIT), used for GPU-accelerated manager graph rendering
- `js-yaml` (MIT)
- `yaml` 2.9.1 (ISC), used for comment-preserving Manager Workset manifest updates
- TypeScript compiler 5.9 (`typescript-compiler`, Apache-2.0), bundled for native TypeScript/JavaScript graph extraction
- `fflate` 0.8.3 (MIT), used for bounded local text extraction from tracked OpenXML, OpenDocument, and EPUB archives
- `unpdf` 1.8.1 (MIT) and its bundled PDF.js engine (Apache-2.0), used for local tracked-PDF text and link extraction
- `web-tree-sitter` 0.27.1 (MIT), bundled as the portable structural parser runtime
- `tree-sitter-java` 0.23.5 (MIT), bundled as a verified WASM grammar
- `tree-sitter-kotlin` 0.3.8 plus pinned upstream revision `c8ac3d2` (MIT), bundled as a verified WASM grammar
- `tree-sitter-swift` 0.7.3 (MIT), bundled as a verified WASM grammar
- `tree-sitter-python` 0.25.0, `tree-sitter-go` 0.25.0, `tree-sitter-rust` 0.24.0, `tree-sitter-c` 0.24.1,
  `tree-sitter-cpp` 0.23.4, `tree-sitter-c-sharp` 0.23.1, `tree-sitter-ruby` 0.23.1,
  `tree-sitter-php` 0.24.2, and `tree-sitter-bash` 0.25.0 (MIT), bundled as verified WASM grammars
- `@tree-sitter-grammars/tree-sitter-hcl` 1.2.0 (Apache-2.0), bundled as the verified HCL/Terraform WASM grammar
- `tree-sitter-powershell` revision `9379c77`, `tree-sitter-dart` revision `0fc19c3`,
  `tree-sitter-solidity` revision `4e938a4`, and `tree-sitter-vue` revision `22bdfa6` (MIT), bundled as verified
  WASM grammars
- `@tree-sitter-grammars/tree-sitter-lua` 0.4.1, `tree-sitter-scala` 0.24.0,
  `@tree-sitter-grammars/tree-sitter-zig` 1.1.2, `tree-sitter-julia` 0.23.1, `tree-sitter-objc` 3.0.2, and
  `@tree-sitter-grammars/tree-sitter-svelte` 1.0.2 (MIT), bundled as verified WASM grammars
- `tree-sitter-systemverilog` 0.4.1 (MIT), bundled as the verified Verilog/SystemVerilog WASM grammar
- `tree-sitter-elixir` 0.3.5 (Apache-2.0), bundled as a verified WASM grammar
- `@vscode/tree-sitter-wasm` 0.3.1 (MIT) and `@repomix/tree-sitter-wasms` 0.1.17 (Unlicense), pinned
  build-time sources for selected precompiled grammar assets; neither is required by the standalone runtime

Grammar and parser license copies, source revisions, ABIs, and SHA-256 checksums are included under
`assets/code-graph/`. Consult those files and each installed package's metadata for the authoritative terms. The
pinned MIT-licensed BGE Small embedding model is embedded in the standalone executable and installed automatically by
`threadnote install`; other model files require an explicit `threadnote models install` action. Catalog entries identify
every model source and license. The complete upstream BGE/FlagEmbedding MIT notice is included in release archives at
`assets/models/licenses/bge-small-en-v1.5.LICENSE`.

### `yaml` 2.9.1 license notice

Copyright Eemeli Aro <eemeli@gmail.com>

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby
granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN
AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.

## Public website

The separately deployed GitHub Pages website is not part of the standalone release. Its build uses Vite and
`@vitejs/plugin-react` (MIT). Release social cards are rendered during the website build with `@resvg/resvg-js` 2.6.2
(MIT) and Spline Sans from `@expo-google-fonts/spline-sans` 0.4.2 (MIT package, SIL Open Font License 1.1 font). The
website also self-hosts Spline Sans and JetBrains Mono through Fontsource packages. The font packages and font files
are distributed under the SIL Open Font License 1.1. A copy is included with the website assets.

## Historical migration compatibility

Threadnote 5 can read a legacy `~/.openviking` directory during the explicit, non-destructive home migration. That
compatibility path copies user-owned data into `~/.threadnote`, excludes old runtime artifacts, and never executes or
bundles OpenViking code. OpenViking is not a Threadnote 5 runtime dependency.
