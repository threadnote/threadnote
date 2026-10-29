import {Array as EffectArray, Option as EffectOption} from 'effect';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {execFileSync} from '@threadnote/testing/node-child-process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {dirname, join} from '@threadnote/testing/node-path';
import {it as effectIt} from '@effect/vitest';
import {Effect, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {afterEach, describe, expect} from 'vitest';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {CodeGraphStore} from '@threadnote/graph/store';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0).reverse()) rmSync(root, {force: true, recursive: true});
});

describe('polyglot code graph lifecycle', () => {
  effectIt.effect(
    'indexes and queries a mixed compiler, AST, structured, and bounded specialist graph',
    () =>
      Effect.gen(function* () {
        const root = createPolyglotRepository();
        const home = join(root, '.threadnote-test-home');
        const indexer = yield* CodeGraphIndexer;
        const query = yield* CodeGraphQueryService;
        const store = yield* CodeGraphStore;
        const path = yield* Path.Path;
        const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
        const layout = codeGraphLayout(path, home, indexed.identity.checkoutId, indexed.identity.worktreeId);
        const graph = yield* store.loadGraph(layout.databasePath, indexed.snapshot.id);
        const operations = yield* Effect.all(
          [
            query.inspect({
              cwd: root,
              operation: 'query',
              query: 'Greeter',
              refresh: false,
              threadnoteHome: home,
            }),
            query.inspect({
              cwd: root,
              operation: 'explain',
              refresh: false,
              symbol: 'KotlinApp',
              threadnoteHome: home,
            }),
            query.inspect({
              cwd: root,
              from: 'typescriptBoot',
              operation: 'path',
              refresh: false,
              threadnoteHome: home,
              to: 'typescriptHelper',
            }),
            query.inspect({
              cwd: root,
              operation: 'impact',
              query: 'makeService',
              refresh: false,
              threadnoteHome: home,
            }),
          ],
          {concurrency: 1},
        );
        expect(EffectArray.map(graph.symbols, symbol => symbol.language)).toEqual(
          expect.arrayContaining([
            'apex',
            'bash',
            'c',
            'cpp',
            'csharp',
            'dart',
            'fortran',
            'go',
            'java',
            'json',
            'kotlin',
            'php',
            'python',
            'razor',
            'ruby',
            'rust',
            'sql',
            'swift',
            'systemverilog',
            'terraform',
            'typescript',
          ]),
        );
        expect(
          EffectOption.getOrUndefined(
            EffectArray.findFirst(
              graph.edges,
              edge => edge.sourceName === 'start' && edge.relation === 'constructs' && edge.targetName === 'Greeter',
            ),
          ),
        ).toMatchObject({provenance: 'resolved', targetId: expect.stringMatching(/^cgs_/)});
        expect(
          EffectOption.getOrUndefined(
            EffectArray.findFirst(
              graph.edges,
              edge => edge.sourceName === 'swiftBoot' && edge.relation === 'calls' && edge.targetName === 'makeService',
            ),
          ),
        ).toMatchObject({provenance: 'resolved', targetId: expect.stringMatching(/^cgs_/)});
        expect(
          EffectOption.getOrUndefined(
            EffectArray.findFirst(
              graph.edges,
              edge =>
                edge.sourceName === 'typescriptBoot' &&
                edge.relation === 'calls' &&
                edge.targetName === 'typescriptHelper',
            ),
          ),
        ).toMatchObject({provenance: 'resolved', targetId: expect.stringMatching(/^cgs_/)});
        expect(EffectArray.every(operations, operation => operation.snapshot.id === indexed.snapshot.id)).toBe(true);
        expect(EffectArray.some(operations[0].nodes, node => node.language === 'java')).toBe(true);
        expect(EffectArray.some(operations[1].nodes, node => node.name === 'KotlinApp')).toBe(true);
        expect(EffectArray.some(operations[2].edges, edge => edge.targetName === 'typescriptHelper')).toBe(true);
        expect(EffectArray.some(operations[3].nodes, node => node.name === 'swiftBoot')).toBe(true);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    60_000,
  );
});

function createPolyglotRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-code-graph-polyglot-'));
  temporaryRoots.push(root);
  write(root, 'settings.gradle.kts', 'include(":shared", ":app")\n');
  write(root, 'shared/build.gradle.kts', '');
  write(root, 'app/build.gradle.kts', 'dependencies { implementation(project(":shared")) }\n');
  write(
    root,
    'shared/src/main/java/com/acme/Greeter.java',
    'package com.acme; public class Greeter { public Greeter() {} }\n',
  );
  write(
    root,
    'app/src/main/kotlin/com/acme/KotlinApp.kt',
    'package com.acme\nimport com.acme.Greeter\nclass KotlinApp { fun start() = Greeter() }\n',
  );
  write(
    root,
    'Package.swift',
    EffectArray.join(
      [
        'import PackageDescription',
        'let package = Package(name: "SwiftWorkspace", targets: [',
        '  .target(name: "SwiftCore"),',
        '  .target(name: "SwiftApp", dependencies: ["SwiftCore"])',
        '])',
      ],
      '\n',
    ),
  );
  write(root, 'Sources/SwiftCore/Service.swift', 'public func makeService() -> String { "ready" }\n');
  write(root, 'Sources/SwiftApp/Main.swift', 'import SwiftCore\npublic func swiftBoot() -> String { makeService() }\n');
  write(root, 'src/helper.ts', 'export function typescriptHelper(): string { return "ready"; }\n');
  write(
    root,
    'src/main.ts',
    'import {typescriptHelper} from "./helper.js";\nexport function typescriptBoot() { return typescriptHelper(); }\n',
  );
  write(root, 'src/service.py', 'class PythonService:\n  def run(self):\n    return helper()\n');
  write(root, 'src/service.go', 'package service\ntype GoService struct{}\nfunc Run() { helper() }\n');
  write(root, 'src/service.rs', 'pub struct RustService;\npub fn run() { helper(); }\n');
  write(root, 'src/service.c', 'struct CService { int value; };\nint run(void) { return helper(); }\n');
  write(root, 'src/service.cpp', 'class CppService { public: void run() { helper(); } };\n');
  write(root, 'src/Service.cs', 'public class CSharpService { public void Run() { Helper(); } }\n');
  write(root, 'lib/service.rb', 'class RubyService\n  def run\n    helper\n  end\nend\n');
  write(root, 'src/service.php', '<?php class PhpService { public function run() { helper(); } }\n');
  write(root, 'scripts/service.sh', 'run() { helper; }\n');
  write(root, 'infra/main.tf', 'resource "example_service" "main" { name = "ready" }\n');
  write(root, 'lib/service.dart', 'class DartService { void run() { helper(); } }\n');
  write(root, 'rtl/service.sv', 'module service; function int run(); return helper(); endfunction endmodule\n');
  write(
    root,
    'legacy/service.f90',
    'module service\ncontains\nsubroutine run()\ncall helper()\nend subroutine run\nend module service\n',
  );
  write(root, 'force-app/classes/Service.cls', 'public class ApexService { public void run() {} }\n');
  write(root, 'Pages/Service.razor', '@page "/service"\n<ChildService />\n@code { private void Run() {} }\n');
  write(root, 'db/schema.sql', 'CREATE TABLE services (id int);\n');
  write(root, 'config/app.json', '{"service":{"enabled":true}}\n');
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', [
    '-C',
    root,
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '-qm',
    'polyglot fixture',
  ]);
  return root;
}

function write(root: string, relative: string, content: string): void {
  const target = join(root, relative);
  mkdirSync(dirname(target), {recursive: true});
  writeFileSync(target, content);
}
