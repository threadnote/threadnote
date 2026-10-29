import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {it as effectIt} from '@effect/vitest';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as BunFileSystem from '@effect/platform-bun/BunFileSystem';
import * as BunPath from '@effect/platform-bun/BunPath';
import {Effect, Layer, Option} from 'effect';
import {describe, expect, it} from 'vitest';
import {createRepositoryFactResolver, extractFileFacts} from '@threadnote/graph/extractor';
import {
  BUILTIN_LANGUAGE_PACK_REGISTRY,
  createCodeGraphLanguagePackRegistry,
} from '@threadnote/graph/languages/registry';
import {CodeGraphLanguagePackError, type CodeGraphLanguagePack} from '@threadnote/graph/languages/types';
import {TreeSitterRuntime} from '@threadnote/graph/tree_sitter/runtime';
import type {CodeGraphInventoryFile} from '@threadnote/graph/types';
import {createWorkspaceAttributor, discoverManifestWorkspace} from '@threadnote/graph/workspace';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('polyglot code graph language packs', () => {
  effectIt.effect('discovers named TypeScript configs used by project references', () =>
    Effect.gen(function* () {
      const files = [
        inventoryFile(
          'tsconfig.json',
          JSON.stringify({references: [{path: 'tsconfig.packages.json'}, {path: 'tsconfig.tests.jsonc'}]}),
        ),
        inventoryFile('tsconfig.packages.json', JSON.stringify({include: ['packages']})),
        inventoryFile('tsconfig.tests.jsonc', '{"include":["test"],}'),
      ];
      const workspace = yield* BUILTIN_LANGUAGE_PACK_REGISTRY.discoverWorkspace(files);
      const root = Option.getOrUndefined(
        EffectArray.findFirst(workspace.projects, project => project.name === 'tsconfig.json'),
      );

      expect(BUILTIN_LANGUAGE_PACK_REGISTRY.isResolutionContext('tsconfig.packages.json')).toBe(true);
      expect(BUILTIN_LANGUAGE_PACK_REGISTRY.isResolutionContext('config/tsconfig.tests.jsonc')).toBe(true);
      expect(BUILTIN_LANGUAGE_PACK_REGISTRY.isResolutionContext('config/tsconfig..json')).toBe(false);
      expect(workspace.diagnostics).toEqual([]);
      expect(root?.dependencies).toHaveLength(2);
    }),
  );

  effectIt.effect('preserves the TypeScript compiler extractor behind the registry', () =>
    Effect.gen(function* () {
      const file = inventoryFile(
        'src/service.ts',
        `
        export interface Store { read(): string }
        export class Service implements Store {
          read(): string { return helper() }
        }
        export function helper(): string { return 'ok' }
      `,
      );
      const viaRegistry = yield* runExtraction(file);
      const direct = extractFileFacts(file);
      expect(viaRegistry).toEqual(direct);
      expect(EffectArray.map(viaRegistry.symbols, symbol => [symbol.kind, symbol.qualifiedName])).toEqual(
        expect.arrayContaining([
          ['interface', 'Store'],
          ['class', 'Service'],
          ['method', 'Service.read'],
          ['function', 'helper'],
        ]),
      );
    }),
  );
  effectIt.effect('extracts Java, Kotlin, and Swift declarations with bounded file-local recovery', () =>
    Effect.gen(function* () {
      const [java, kotlin, swift, recovering] = yield* Effect.all(
        [
          runExtraction(
            inventoryFile(
              'java/src/main/java/com/acme/Greeter.java',
              `
            package com.acme;
            public class Greeter extends BaseGreeter {
              public String greet(String name) { return normalize(name); }
            }
          `,
            ),
          ),
          runExtraction(
            inventoryFile(
              'kotlin/src/main/kotlin/com/acme/Greeter.kt',
              `
            package com.acme
            class Greeter : BaseGreeter() {
              fun greet(name: String): String = normalize(name)
            }
          `,
            ),
          ),
          runExtraction(
            inventoryFile(
              'swift/Sources/Core/Greeter.swift',
              `
            public protocol Greeting { func greet(_ name: String) -> String }
            public struct Greeter: Greeting {
              public func greet(_ name: String) -> String { normalize(name) }
            }
          `,
            ),
          ),
          runExtraction(inventoryFile('swift/Sources/Broken/Broken.swift', 'public struct Broken { func value(')),
        ],
        {
          concurrency: 'unbounded',
        },
      );
      expect(EffectArray.map(java.symbols, symbol => [symbol.kind, symbol.qualifiedName])).toEqual(
        expect.arrayContaining([
          ['class', 'com.acme.Greeter'],
          ['method', 'com.acme.Greeter.greet'],
        ]),
      );
      expect(EffectArray.map(java.edges, edge => edge.relation)).toEqual(
        expect.arrayContaining(['calls', 'contains', 'extends']),
      );
      expect(EffectArray.map(kotlin.symbols, symbol => [symbol.kind, symbol.qualifiedName])).toEqual(
        expect.arrayContaining([
          ['class', 'com.acme.Greeter'],
          ['function', 'com.acme.Greeter.greet'],
        ]),
      );
      expect(EffectArray.map(kotlin.edges, edge => edge.relation)).toEqual(
        expect.arrayContaining(['calls', 'contains', 'extends']),
      );
      expect(EffectArray.map(swift.symbols, symbol => [symbol.kind, symbol.qualifiedName])).toEqual(
        expect.arrayContaining([
          ['protocol', 'Greeting'],
          ['struct', 'Greeter'],
          ['method', 'Greeter.greet'],
        ]),
      );
      expect(EffectArray.map(swift.edges, edge => edge.relation)).toEqual(
        expect.arrayContaining(['calls', 'contains', 'extends']),
      );
      expect(recovering.diagnostics).toEqual([
        'swift/Sources/Broken/Broken.swift: swift parser recovered from one or more syntax errors',
      ]);
    }),
  );
  effectIt.effect('extracts declarations and relationships across the bundled portable language matrix', () =>
    Effect.gen(function* () {
      const samples = [
        [
          'src/service.py',
          'from core.base import Base\nclass Greeter(Base):\n  def greet(self, name):\n    return normalize(name)\n',
        ],
        [
          'src/service.go',
          'package service\nimport "fmt"\ntype Greeter struct{}\nfunc (g *Greeter) Greet(name string) string { return fmt.Sprint(name) }\n',
        ],
        [
          'src/service.rs',
          'use crate::core::Base;\npub struct Greeter;\npub trait Runner { fn run(&self); }\nimpl Runner for Greeter { fn run(&self) { normalize(); } }\n',
        ],
        [
          'src/service.c',
          '#include "core.h"\ntypedef struct Greeter { int value; } Greeter;\nint greet(void) { return normalize(); }\n',
        ],
        [
          'src/service.cpp',
          '#include "core.hpp"\nnamespace acme { class Greeter : public Base { public: int greet() { return normalize(); } }; }\n',
        ],
        [
          'src/Service.cs',
          'using Core;\nnamespace Acme;\npublic interface IRunner { void Run(); }\npublic class Greeter : Base, IRunner { public void Run() { Normalize(); } }\n',
        ],
        [
          'lib/service.rb',
          'require "core"\nmodule Acme\n class Greeter < Base\n  def greet(name)\n   normalize(name)\n  end\n end\nend\n',
        ],
        [
          'src/service.php',
          '<?php\nnamespace Acme;\nuse Core\\Base;\nclass Greeter extends Base { public function greet() { return normalize(); } }\nfunction normalize() {}\n',
        ],
        ['scripts/service.sh', '#!/usr/bin/env bash\nsource ./core.sh\ngreet() { normalize "$1"; }\ngreet world\n'],
        [
          'infra/main.tf',
          'variable "region" { type = string }\nresource "aws_s3_bucket" "logs" { bucket = var.region }\nmodule "network" { source = "./network" }\n',
        ],
      ] as const;
      const facts = yield* Effect.all(
        EffectArray.map(samples, ([path, content]) => runExtraction(inventoryFile(path, content))),
        {
          concurrency: 'unbounded',
        },
      );
      const byLanguage = new Map(
        EffectArray.map(facts, (value, index) => [inventoryFile(samples[index][0], '').language, value]),
      );
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(byLanguage.get('python')?.symbols), __effectArrayReceiver =>
            EffectArray.map(__effectArrayReceiver, symbol => [symbol.kind, symbol.qualifiedName]),
          ),
        ),
      ).toEqual(
        expect.arrayContaining([
          ['class', 'Greeter'],
          ['function', 'Greeter.greet'],
        ]),
      );
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(byLanguage.get('go')?.symbols), __effectArrayReceiver =>
            EffectArray.map(__effectArrayReceiver, symbol => symbol.kind),
          ),
        ),
      ).toEqual(expect.arrayContaining(['struct', 'method']));
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(byLanguage.get('rust')?.symbols), __effectArrayReceiver =>
            EffectArray.map(__effectArrayReceiver, symbol => symbol.kind),
          ),
        ),
      ).toEqual(expect.arrayContaining(['struct', 'trait', 'impl', 'function']));
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(byLanguage.get('c')?.symbols), __effectArrayReceiver =>
            EffectArray.map(__effectArrayReceiver, symbol => symbol.kind),
          ),
        ),
      ).toEqual(expect.arrayContaining(['struct', 'function']));
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(byLanguage.get('cpp')?.symbols), __effectArrayReceiver =>
            EffectArray.map(__effectArrayReceiver, symbol => symbol.kind),
          ),
        ),
      ).toEqual(expect.arrayContaining(['namespace', 'class', 'function']));
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(byLanguage.get('csharp')?.symbols), __effectArrayReceiver =>
            EffectArray.map(__effectArrayReceiver, symbol => symbol.kind),
          ),
        ),
      ).toEqual(expect.arrayContaining(['interface', 'class', 'method']));
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(byLanguage.get('ruby')?.symbols), __effectArrayReceiver =>
            EffectArray.map(__effectArrayReceiver, symbol => symbol.kind),
          ),
        ),
      ).toEqual(expect.arrayContaining(['module', 'class', 'method']));
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(byLanguage.get('php')?.symbols), __effectArrayReceiver =>
            EffectArray.map(__effectArrayReceiver, symbol => symbol.kind),
          ),
        ),
      ).toEqual(expect.arrayContaining(['class', 'method', 'function']));
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(byLanguage.get('bash')?.symbols), __effectArrayReceiver =>
            EffectArray.map(__effectArrayReceiver, symbol => symbol.kind),
          ),
        ),
      ).toContain('function');
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(byLanguage.get('terraform')?.symbols), __effectArrayReceiver =>
            EffectArray.map(__effectArrayReceiver, symbol => [symbol.kind, symbol.name]),
          ),
        ),
      ).toEqual(
        expect.arrayContaining([
          ['variable', 'region'],
          ['resource', 'aws_s3_bucket.logs'],
          ['module', 'network'],
        ]),
      );
      for (const value of facts) {
        expect(value.symbols[0]?.kind).toBe('module');
        expect(value.edges.length).toBeGreaterThan(0);
      }
    }),
  );
  it('detects the complete portable source and Terraform extension matrix', () => {
    const expected = new Map([
      ['src/app.py', 'python'],
      ['src/types.pyi', 'python'],
      ['src/main.go', 'go'],
      ['src/lib.rs', 'rust'],
      ['src/native.c', 'c'],
      ['include/native.h', 'c'],
      ['src/native.cpp', 'cpp'],
      ['include/native.hpp', 'cpp'],
      ['src/App.cs', 'csharp'],
      ['lib/app.rb', 'ruby'],
      ['src/app.php', 'php'],
      ['scripts/release.sh', 'bash'],
      ['infra/main.hcl', 'hcl'],
      ['infra/main.tf', 'terraform'],
      ['infra/prod.tfvars', 'terraform-vars'],
    ]);
    for (const [path, language] of expected) {
      expect(BUILTIN_LANGUAGE_PACK_REGISTRY.match(path), path).toMatchObject({
        _tag: 'Some',
        value: {
          language,
        },
      });
    }
  });
  effectIt.effect('extracts additional structural languages from verified bundled grammars', () =>
    Effect.gen(function* () {
      const samples = [
        [
          'scripts/Widget.psm1',
          'Import-Module Core.Tools\nfunction Get-Widget { Invoke-Helper }\nclass Widget : BaseWidget { [string] Run() { Invoke-Helper } }',
          ['class', 'function', 'method'],
          ['calls', 'extends', 'imports'],
        ],
        [
          'lib/widget.dart',
          'import "package:core/base.dart"; class Widget extends Base implements Runnable { void run() { helper(); } }',
          ['class', 'function'],
          ['calls', 'extends', 'implements', 'imports'],
        ],
        [
          'contracts/Vault.sol',
          'import "./Base.sol"; contract Vault is Base { event Deposited(address who); function deposit() public { helper(); } }',
          ['contract', 'event', 'function'],
          ['calls', 'extends', 'imports'],
        ],
        [
          'lib/widget.lua',
          'local util = require("util")\nfunction run(x) return util.help(x) end\nlocal function hidden() end',
          ['function'],
          ['calls', 'imports'],
        ],
        [
          'src/Widget.scala',
          'package demo\nimport core.Base\ntrait Runner { def run(): Unit }\nclass Widget extends Base with Runner { def run() = helper() }',
          ['class', 'function', 'trait'],
          ['calls', 'extends', 'imports'],
        ],
        [
          'lib/widget.ex',
          'defmodule Demo.Widget do\n alias Core.Base\n def run(x), do: helper(x)\n defp hidden(), do: :ok\nend',
          ['function', 'module'],
          ['calls', 'imports'],
        ],
        [
          'src/widget.zig',
          'const std = @import("std");\npub const Widget = struct { pub fn run(self: *Widget) void { helper(); } };',
          ['function', 'struct'],
          ['calls', 'imports'],
        ],
        [
          'src/Widget.jl',
          'module Demo\nusing Core\nstruct Widget <: Base\n value::Int\nend\nfunction run(x)\n helper(x)\nend\nend',
          ['function', 'module', 'struct'],
          ['calls', 'imports'],
        ],
        [
          'src/Widget.m',
          '#import <Foundation/Foundation.h>\n@interface Widget : Base <Runnable>\n- (void)run;\n@end\n@implementation Widget\n- (void)run { helper(); }\n@end',
          ['class', 'method'],
          ['calls', 'extends', 'implements', 'imports'],
        ],
        [
          'rtl/widget.sv',
          'package core_pkg; function int helper(); endfunction endpackage\nimport core_pkg::*; module widget; child u_child(); function int run(); return helper(); endfunction endmodule\nclass Driver extends BaseDriver; function void start(); helper(); endfunction endclass',
          ['class', 'function', 'module', 'package'],
          ['calls', 'constructs', 'extends', 'imports'],
        ],
      ] as const;
      for (const [path, content, expectedKinds, expectedRelations] of samples) {
        const facts = yield* runExtraction(inventoryFile(path, content));
        expect(
          EffectArray.map(facts.symbols, symbol => symbol.kind),
          path,
        ).toEqual(expect.arrayContaining([...expectedKinds]));
        expect(
          EffectArray.map(facts.edges, edge => edge.relation),
          path,
        ).toEqual(expect.arrayContaining([...expectedRelations]));
      }
      const [vue, svelte] = yield* Effect.all(
        [
          runExtraction(inventoryFile('src/App.vue', '<template><Widget/><div></div></template>')),
          runExtraction(inventoryFile('src/App.svelte', '<Widget/><section></section>')),
        ],
        {
          concurrency: 'unbounded',
        },
      );
      for (const facts of [vue, svelte]) {
        expect(
          Option.getOrUndefined(
            EffectArray.findFirst(facts.edges, edge => edge.relation === 'constructs' && edge.targetName === 'Widget'),
          ),
        ).toBeDefined();
        expect(EffectArray.some(facts.edges, edge => edge.targetName === 'div' || edge.targetName === 'section')).toBe(
          false,
        );
      }
    }),
  );
  it('detects every extended structural language without ambiguous matchers', () => {
    const expected = new Map([
      ['scripts/build.ps1', 'powershell'],
      ['modules/App.psm1', 'powershell'],
      ['modules/App.psd1', 'powershell-data'],
      ['lib/app.dart', 'dart'],
      ['contracts/App.sol', 'solidity'],
      ['lib/app.lua', 'lua'],
      ['src/App.scala', 'scala'],
      ['scripts/App.sc', 'scala'],
      ['lib/app.ex', 'elixir'],
      ['test/app.exs', 'elixir'],
      ['src/app.zig', 'zig'],
      ['src/App.jl', 'julia'],
      ['src/App.m', 'objective-c'],
      ['src/App.mm', 'objective-cpp'],
      ['src/App.vue', 'vue'],
      ['src/App.svelte', 'svelte'],
      ['rtl/App.v', 'verilog'],
      ['rtl/App.vh', 'verilog'],
      ['rtl/App.sv', 'systemverilog'],
      ['rtl/App.svh', 'systemverilog'],
    ]);
    for (const [path, language] of expected) {
      expect(BUILTIN_LANGUAGE_PACK_REGISTRY.match(path), path).toMatchObject({
        _tag: 'Some',
        value: {
          language,
        },
      });
    }
  });
  effectIt.effect(
    'provides bounded deterministic structure for Fortran, Apex, and Razor without claiming AST coverage',
    () =>
      Effect.gen(function* () {
        const [fortran, apex, trigger, razor] = yield* Effect.all(
          [
            runExtraction(
              inventoryFile(
                'src/solver.f90',
                'module solver\n  use iso_fortran_env\ncontains\n  subroutine run()\n    call helper()\n  end subroutine run\n  function helper() result(value)\n  end function helper\nend module solver\n',
              ),
            ),
            runExtraction(
              inventoryFile(
                'force-app/classes/Widget.cls',
                'public class Widget extends BaseWidget implements Runnable {\n  public void run() {\n    List<Account> rows = [SELECT Id FROM Account];\n  }\n}\n',
              ),
            ),
            runExtraction(
              inventoryFile(
                'force-app/triggers/AccountSync.trigger',
                'trigger AccountSync on Account (before insert) {\n}\n',
              ),
            ),
            runExtraction(
              inventoryFile(
                'Pages/Widget.razor',
                '@page "/widget"\n@using App.Core\n@inject IService Service\n@inherits WidgetBase\n<ChildWidget />\n<div></div>\n@code {\n  private void Refresh() { Service.Run(); }\n}\n',
              ),
            ),
          ],
          {
            concurrency: 'unbounded',
          },
        );
        expect(EffectArray.map(fortran.symbols, symbol => [symbol.kind, symbol.name])).toEqual(
          expect.arrayContaining([
            ['module', 'solver'],
            ['subroutine', 'run'],
            ['function', 'helper'],
          ]),
        );
        expect(EffectArray.map(fortran.edges, edge => [edge.relation, edge.targetName])).toEqual(
          expect.arrayContaining([
            ['imports', 'iso_fortran_env'],
            ['calls', 'helper'],
          ]),
        );
        expect(EffectArray.map(apex.symbols, symbol => symbol.kind)).toEqual(
          expect.arrayContaining(['class', 'method']),
        );
        expect(EffectArray.map(apex.edges, edge => [edge.relation, edge.targetName])).toEqual(
          expect.arrayContaining([
            ['extends', 'BaseWidget'],
            ['implements', 'Runnable'],
            ['references', 'Account'],
          ]),
        );
        expect(EffectArray.map(trigger.symbols, symbol => symbol.kind)).toContain('trigger');
        expect(EffectArray.map(trigger.edges, edge => [edge.relation, edge.targetName])).toContainEqual([
          'references',
          'Account',
        ]);
        expect(EffectArray.map(razor.symbols, symbol => [symbol.kind, symbol.name])).toEqual(
          expect.arrayContaining([
            ['route', '/widget'],
            ['method', 'Refresh'],
          ]),
        );
        expect(EffectArray.map(razor.edges, edge => [edge.relation, edge.targetName])).toEqual(
          expect.arrayContaining([
            ['imports', 'App.Core'],
            ['imports', 'IService'],
            ['extends', 'WidgetBase'],
            ['constructs', 'ChildWidget'],
          ]),
        );
        for (const facts of [fortran, apex, trigger, razor]) expect(facts.diagnostics).toEqual([]);
      }),
  );
  it('detects the bounded text-structural specialist formats', () => {
    const expected = new Map([
      ['src/legacy.f', 'fortran'],
      ['src/legacy.F90', 'fortran'],
      ['src/legacy.for', 'fortran'],
      ['src/legacy.f77', 'fortran'],
      ['src/legacy.f95', 'fortran'],
      ['src/legacy.f03', 'fortran'],
      ['src/legacy.f08', 'fortran'],
      ['force-app/classes/App.cls', 'apex'],
      ['force-app/triggers/App.trigger', 'apex-trigger'],
      ['Pages/App.razor', 'razor'],
      ['Views/App.cshtml', 'razor'],
    ]);
    for (const [path, language] of expected) {
      expect(BUILTIN_LANGUAGE_PACK_REGISTRY.match(path), path).toMatchObject({
        _tag: 'Some',
        value: {
          language,
        },
      });
    }
  });
  effectIt.effect('extracts SQL, config, schema, build, and container declarations without external runtimes', () =>
    Effect.gen(function* () {
      const samples = [
        [
          'db/schema.sql',
          'CREATE TABLE users (id int); CREATE VIEW active_users AS SELECT * FROM users;',
          ['table', 'view'],
          ['references'],
        ],
        ['config/app.json', '{"server":{"port":8080},"features":{"graph":true}}', ['property'], []],
        ['config/app.yaml', 'server:\n  port: 8080\nfeatures:\n  graph: true\n', ['property'], []],
        ['config/app.toml', '[server]\nport = 8080\n', ['property', 'table'], []],
        ['config/app.ini', '[server]\nport=8080\n', ['property', 'section'], []],
        [
          'schema/api.graphql',
          'interface Node { id: ID! }\ntype User implements Node { id: ID! }',
          ['interface', 'type'],
          [],
        ],
        [
          'schema/api.proto',
          'package acme;\nimport "common.proto";\nmessage User {}\nservice Users { rpc Get(User) returns (User); }',
          ['message', 'rpc', 'service'],
          ['imports'],
        ],
        [
          'build/App.csproj',
          '<Project><ItemGroup><PackageReference Include="Effect" /></ItemGroup><Target Name="Build" /></Project>',
          ['packagereference', 'target'],
          ['depends_on'],
        ],
        ['build/App.sln', 'Project("{A}") = "App", "App.csproj", "{B}"\nEndProject\n', ['project'], ['depends_on']],
        [
          'Dockerfile',
          'FROM oven/bun:1 AS build\nFROM scratch\nCOPY --from=build /app /app\n',
          ['stage'],
          ['depends_on'],
        ],
      ] as const;
      for (const [path, content, kinds, relations] of samples) {
        const facts = yield* runExtraction(inventoryFile(path, content));
        expect(
          EffectArray.map(facts.symbols, symbol => symbol.kind),
          path,
        ).toEqual(expect.arrayContaining([...kinds]));
        expect(
          EffectArray.map(facts.edges, edge => edge.relation),
          path,
        ).toEqual(expect.arrayContaining([...relations, 'contains']));
        expect(facts.diagnostics, path).toEqual([]);
      }
    }),
  );
  it('detects the complete structured schema and configuration matrix', () => {
    const expected = new Map([
      ['db/schema.sql', 'sql'],
      ['config/app.json', 'json'],
      ['config/app.jsonc', 'jsonc'],
      ['config/app.yaml', 'yaml'],
      ['config/app.yml', 'yaml'],
      ['config/app.toml', 'toml'],
      ['config/app.ini', 'ini'],
      ['config/app.properties', 'properties'],
      ['schema/api.graphql', 'graphql'],
      ['schema/api.graphqls', 'graphql'],
      ['schema/api.gql', 'graphql'],
      ['schema/api.proto', 'protobuf'],
      ['build/App.csproj', 'msbuild'],
      ['build/App.fsproj', 'msbuild'],
      ['build/App.vbproj', 'msbuild'],
      ['build/Directory.Build.props', 'msbuild'],
      ['build/Directory.Build.targets', 'msbuild'],
      ['ui/App.xaml', 'xaml'],
      ['build/App.sln', 'solution'],
      ['Dockerfile', 'dockerfile'],
      ['containers/Containerfile', 'dockerfile'],
    ]);
    for (const [path, language] of expected) {
      expect(BUILTIN_LANGUAGE_PACK_REGISTRY.match(path), path).toMatchObject({
        _tag: 'Some',
        value: {
          language,
        },
      });
    }
  });
  effectIt.effect('covers module, JVM type variants, companions, constructors, and Swift member declarations', () =>
    Effect.gen(function* () {
      const [java, kotlin, swift] = yield* Effect.all(
        [
          runExtraction(
            inventoryFile(
              'java/src/main/java/module-info.java',
              'module com.acme.app { requires com.acme.core; exports com.acme.api; }',
            ),
          ),
          runExtraction(
            inventoryFile(
              'kotlin/src/main/kotlin/acme/Types.kt',
              `
            package acme
            interface Contract
            enum class State { READY }
            annotation class Marker
            class Host() {
              companion object Factory { fun make() = Host() }
              constructor(value: Int) : this()
              val property: String = "ready"
            }
            typealias HostAlias = Host
            fun String.slug(value: Int): String = this
          `,
            ),
          ),
          runExtraction(
            inventoryFile(
              'swift/Sources/Core/Types.swift',
              `
            public protocol Contract { func run() }
            public actor Worker {
              public var name: String = "worker"
              public init() {}
              public subscript(index: Int) -> String { name }
              public func run() {}
            }
            public extension Worker { func extra() {} }
            public typealias WorkerName = String
          `,
            ),
          ),
        ],
        {
          concurrency: 'unbounded',
        },
      );
      expect(EffectArray.map(java.symbols, symbol => [symbol.kind, symbol.qualifiedName])).toEqual(
        expect.arrayContaining([['module', 'com.acme.app']]),
      );
      expect(
        Option.getOrUndefined(
          EffectArray.findFirst(java.edges, edge => edge.relation === 'imports' && edge.targetName === 'com.acme.core'),
        ),
      ).toBeDefined();
      expect(EffectArray.map(kotlin.symbols, symbol => [symbol.kind, symbol.qualifiedName])).toEqual(
        expect.arrayContaining([
          ['interface', 'acme.Contract'],
          ['enum', 'acme.State'],
          ['annotation', 'acme.Marker'],
          ['object', 'acme.Host.Factory'],
          ['constructor', 'acme.Host.Host'],
          ['property', 'acme.Host.property'],
          ['type', 'acme.HostAlias'],
          ['function', 'acme.slug'],
        ]),
      );
      expect(EffectArray.filter(kotlin.symbols, symbol => symbol.kind === 'constructor')).toHaveLength(2);
      expect(EffectArray.map(swift.symbols, symbol => [symbol.kind, symbol.qualifiedName])).toEqual(
        expect.arrayContaining([
          ['protocol', 'Contract'],
          ['method', 'Contract.run'],
          ['actor', 'Worker'],
          ['property', 'Worker.name'],
          ['initializer', 'Worker.init'],
          ['subscript', 'Worker.subscript'],
          ['method', 'Worker.run'],
          ['extension', 'Worker'],
          ['type', 'WorkerName'],
        ]),
      );
    }),
  );
  effectIt.effect('resolves Java and Kotlin only through a declared Gradle project dependency', () =>
    Effect.gen(function* () {
      const files = [
        inventoryFile(
          'settings.gradle.kts',
          `
          rootProject.name = "mixed"
          include(":libs:shared", ":apps:app", ":apps:isolated")
        `,
        ),
        inventoryFile('libs/shared/build.gradle.kts', ''),
        inventoryFile('apps/app/build.gradle.kts', 'dependencies { implementation(project(":libs:shared")) }'),
        inventoryFile('apps/isolated/build.gradle.kts', ''),
        inventoryFile(
          'libs/shared/src/main/java/com/acme/shared/Greeter.java',
          `
          package com.acme.shared;
          public class Greeter { public Greeter() {} }
        `,
        ),
        inventoryFile(
          'apps/app/src/main/kotlin/com/acme/app/App.kt',
          `
          package com.acme.app
          import com.acme.shared.Greeter
          fun boot() = Greeter()
        `,
        ),
        inventoryFile(
          'apps/isolated/src/main/kotlin/com/acme/isolated/App.kt',
          `
          package com.acme.isolated
          import com.acme.shared.Greeter
          fun boot() = Greeter()
        `,
        ),
      ];
      const workspace = discoverManifestWorkspace(files);
      const attribute = createWorkspaceAttributor(workspace);
      const extracted = attribute(
        yield* Effect.forEach(files, file => runExtraction(file), {
          concurrency: 'unbounded',
        }),
      );
      const resolved = createRepositoryFactResolver(extracted, files).resolve(extracted);
      const connected = Option.getOrUndefined(
        EffectArray.findFirst(
          resolved,
          __effectArrayValue =>
            !!(file => Effect2.pipe(file.path, EffectString.includes('apps/app/src')))(__effectArrayValue),
        ),
      )!;
      const isolated = Option.getOrUndefined(
        EffectArray.findFirst(
          resolved,
          __effectArrayValue =>
            !!(file => Effect2.pipe(file.path, EffectString.includes('apps/isolated/src')))(__effectArrayValue),
        ),
      )!;
      expect(
        Option.getOrUndefined(
          EffectArray.findFirst(
            connected.edges,
            edge => edge.relation === 'constructs' && edge.targetName === 'Greeter',
          ),
        ),
      ).toMatchObject({
        provenance: 'resolved',
        targetId: expect.stringMatching(/^cgs_/),
      });
      const isolatedConstruction = Option.getOrUndefined(
        EffectArray.findFirst(isolated.edges, edge => edge.relation === 'constructs' && edge.targetName === 'Greeter'),
      );
      expect(isolatedConstruction).toMatchObject({
        provenance: 'syntactic',
      });
      expect(isolatedConstruction?.targetId).toBeUndefined();
      expect(
        Option.getOrUndefined(EffectArray.findFirst(workspace.projects, project => project.name === 'app'))
          ?.dependencies,
      ).toHaveLength(1);
    }),
  );
  effectIt.effect(
    'keeps a nested Gradle workspace distinct while honoring its integration into the outer monorepo',
    () =>
      Effect.gen(function* () {
        const files = [
          inventoryFile(
            'settings.gradle.kts',
            `
          rootProject.name = "outer"
          include(":libs:shared", ":apps:app")
        `,
          ),
          inventoryFile('libs/shared/build.gradle.kts', ''),
          inventoryFile(
            'apps/app/settings.gradle.kts',
            `
          rootProject.name = "nested-app"
          include(":feature")
        `,
          ),
          inventoryFile(
            'apps/app/build.gradle.kts',
            `
          dependencies {
            implementation(project(":libs:shared"))
            implementation(project(":feature"))
          }
        `,
          ),
          inventoryFile('apps/app/feature/build.gradle.kts', ''),
          inventoryFile(
            'libs/shared/src/main/java/com/acme/shared/Greeter.java',
            'package com.acme.shared; public class Greeter { public Greeter() {} }',
          ),
          inventoryFile(
            'apps/app/feature/src/main/java/com/acme/feature/FeatureApi.java',
            'package com.acme.feature; public class FeatureApi { public FeatureApi() {} }',
          ),
          inventoryFile(
            'apps/app/src/main/kotlin/com/acme/app/App.kt',
            `
          package com.acme.app
          import com.acme.shared.Greeter
          import com.acme.feature.FeatureApi
          fun boot() {
            Greeter()
            FeatureApi()
          }
        `,
          ),
        ];
        const workspace = discoverManifestWorkspace(files);
        const app = Option.getOrUndefined(
          EffectArray.findFirst(workspace.projects, project => project.root === 'apps/app'),
        )!;
        const feature = Option.getOrUndefined(
          EffectArray.findFirst(workspace.projects, project => project.root === 'apps/app/feature'),
        )!;
        const shared = Option.getOrUndefined(
          EffectArray.findFirst(workspace.projects, project => project.root === 'libs/shared'),
        )!;
        const attribute = createWorkspaceAttributor(workspace);
        const extracted = attribute(
          yield* Effect.forEach(files, file => runExtraction(file), {
            concurrency: 'unbounded',
          }),
        );
        const resolved = createRepositoryFactResolver(extracted, files).resolve(extracted);
        const appFacts = Option.getOrUndefined(
          EffectArray.findFirst(
            resolved,
            __effectArrayValue =>
              !!(file => Effect2.pipe(file.path, EffectString.endsWith('/App.kt')))(__effectArrayValue),
          ),
        )!;
        const constructions = EffectArray.filter(appFacts.edges, edge => edge.relation === 'constructs');
        expect(app.workspaceRoots).toEqual(['', 'apps/app']);
        expect(app.dependencies).toEqual(expect.arrayContaining([feature.id, shared.id]));
        expect(app.dependencies).toHaveLength(2);
        expect(
          Option.getOrUndefined(EffectArray.findFirst(constructions, edge => edge.targetName === 'Greeter')),
        ).toMatchObject({
          provenance: 'resolved',
          targetId: expect.stringMatching(/^cgs_/),
        });
        expect(
          Option.getOrUndefined(EffectArray.findFirst(constructions, edge => edge.targetName === 'FeatureApi')),
        ).toMatchObject({
          provenance: 'resolved',
          targetId: expect.stringMatching(/^cgs_/),
        });
      }),
  );
  effectIt.effect('resolves Swift calls across declared SwiftPM target dependencies', () =>
    Effect.gen(function* () {
      const files = [
        inventoryFile(
          'Package.swift',
          `
          import PackageDescription
          let package = Package(
            name: "Workspace",
            targets: [
              .target(name: "Core"),
              .target(name: "App", dependencies: ["Core"])
            ]
          )
        `,
        ),
        inventoryFile('Sources/Core/Factory.swift', 'public func makeService() -> String { "ready" }'),
        inventoryFile('Sources/App/Main.swift', 'import Core\npublic func boot() -> String { makeService() }'),
      ];
      const workspace = discoverManifestWorkspace(files);
      const attribute = createWorkspaceAttributor(workspace);
      const extracted = attribute(
        yield* Effect.forEach(files, file => runExtraction(file), {
          concurrency: 'unbounded',
        }),
      );
      const resolved = createRepositoryFactResolver(extracted, files).resolve(extracted);
      const app = Option.getOrUndefined(
        EffectArray.findFirst(resolved, file => file.path === 'Sources/App/Main.swift'),
      )!;
      expect(
        Option.getOrUndefined(
          EffectArray.findFirst(app.edges, edge => edge.relation === 'calls' && edge.targetName === 'makeService'),
        ),
      ).toMatchObject({
        provenance: 'resolved',
        targetId: expect.stringMatching(/^cgs_/),
      });
    }),
  );
  effectIt.effect('promotes proven Swift protocol conformance but never resolves an override to itself', () =>
    Effect.gen(function* () {
      const files = [
        inventoryFile(
          'Package.swift',
          'import PackageDescription\nlet package = Package(name: "Core", targets: [.target(name: "Core")])',
        ),
        inventoryFile(
          'Sources/Core/Types.swift',
          `
          public protocol Contract { func run() }
          public struct Service: Contract { public func run() {} }
          public class Base { public func refresh() {} }
          public class Child: Base { public override func refresh() {} }
        `,
        ),
      ];
      const workspace = discoverManifestWorkspace(files);
      const attribute = createWorkspaceAttributor(workspace);
      const extracted = attribute(
        yield* Effect.forEach(files, file => runExtraction(file), {
          concurrency: 'unbounded',
        }),
      );
      const resolved = createRepositoryFactResolver(extracted, files).resolve(extracted);
      const facts = Option.getOrUndefined(
        EffectArray.findFirst(
          resolved,
          __effectArrayValue =>
            !!(file => Effect2.pipe(file.path, EffectString.endsWith('Types.swift')))(__effectArrayValue),
        ),
      )!;
      const conformance = Option.getOrUndefined(
        EffectArray.findFirst(facts.edges, edge => edge.sourceName === 'Service' && edge.targetName === 'Contract'),
      );
      const override = Option.getOrUndefined(
        EffectArray.findFirst(facts.edges, edge => edge.relation === 'overrides' && edge.sourceName === 'refresh'),
      );
      expect(conformance).toMatchObject({
        provenance: 'resolved',
        relation: 'implements',
        targetId: expect.stringMatching(/^cgs_/),
      });
      expect(override).toMatchObject({
        provenance: 'syntactic',
      });
      expect(override?.targetId).toBeUndefined();
    }),
  );
  effectIt.effect('fails closed when the applicable lookup tier is ambiguous', () =>
    Effect.gen(function* () {
      const files = [
        inventoryFile('settings.gradle.kts', 'include(":one", ":two", ":app")'),
        inventoryFile('one/build.gradle.kts', ''),
        inventoryFile('two/build.gradle.kts', ''),
        inventoryFile(
          'app/build.gradle.kts',
          'dependencies { implementation(project(":one")); implementation(project(":two")) }',
        ),
        inventoryFile('one/src/main/java/acme/Greeter.java', 'package acme; public class Greeter {}'),
        inventoryFile('two/src/main/kotlin/acme/Greeter.kt', 'package acme\nclass Greeter'),
        inventoryFile('app/src/main/kotlin/acme/App.kt', 'package acme\nimport acme.Greeter\nfun boot() = Greeter()'),
      ];
      const workspace = discoverManifestWorkspace(files);
      const attribute = createWorkspaceAttributor(workspace);
      const extracted = attribute(
        yield* Effect.forEach(files, file => runExtraction(file), {
          concurrency: 'unbounded',
        }),
      );
      const resolved = createRepositoryFactResolver(extracted, files).resolve(extracted);
      const edge = Option.getOrUndefined(
        EffectArray.findFirst(
          Option.getOrUndefined(
            EffectArray.findFirst(resolved, file => file.path === 'app/src/main/kotlin/acme/App.kt'),
          )!.edges,
          candidate => candidate.relation === 'constructs' && candidate.targetName === 'Greeter',
        ),
      );
      expect(edge).toMatchObject({
        provenance: 'syntactic',
      });
      expect(edge?.targetId).toBeUndefined();
    }),
  );
  effectIt.effect('accepts a synthetic future pack without changing registry or indexing code', () =>
    Effect.gen(function* () {
      const futurePack: CodeGraphLanguagePack = {
        assets: [],
        capabilities: new Set(['declarations']),
        extractor: {
          extract: file =>
            Effect.succeed({
              diagnostics: [],
              edges: [],
              path: file.path,
              symbols: [],
            }),
          version: 'future-extractor-v1',
        },
        files: [
          {
            kind: 'extension',
            language: 'future',
            role: 'source',
            value: '.future',
          },
        ],
        id: 'future',
        resolutionStrategy: {
          domain: 'future',
          version: 'future-resolution-v1',
        },
        version: '1.0.0',
        workspaceDetector: Option.none(),
      };
      const registry = createCodeGraphLanguagePackRegistry([futurePack]);
      const file = inventoryFile('src/example.future', 'entity Example', 'future');
      expect(registry.match(file.path)).toMatchObject({
        _tag: 'Some',
        value: {
          language: 'future',
          role: 'source',
        },
      });
      expect(
        yield* registry
          .extractFile(file)
          .pipe(
            provideTestLayer(TreeSitterRuntime.layer),
            provideTestLayer(TestSystemInfoLayer),
            provideTestLayer(Layer.merge(BunFileSystem.layer, BunPath.layer)),
          ),
      ).toEqual({
        diagnostics: [],
        edges: [],
        path: file.path,
        symbols: [],
      });
    }),
  );
  it('separates parser cache identities from derived graph policy identities', () => {
    const policyChangedRegistry = createCodeGraphLanguagePackRegistry(
      EffectArray.map(BUILTIN_LANGUAGE_PACK_REGISTRY.packs, pack =>
        pack.id === 'swift'
          ? {
              ...pack,
              version: `${pack.version}-next`,
            }
          : pack,
      ),
    );
    const parserChangedRegistry = createCodeGraphLanguagePackRegistry(
      EffectArray.map(BUILTIN_LANGUAGE_PACK_REGISTRY.packs, pack =>
        pack.id === 'swift'
          ? {
              ...pack,
              extractor: {
                ...pack.extractor,
                version: `${pack.extractor.version}-next`,
              },
            }
          : pack,
      ),
    );
    const originalTypeScript = Option.getOrThrow(BUILTIN_LANGUAGE_PACK_REGISTRY.cacheIdentityForPath('src/service.ts'));
    const changedTypeScript = Option.getOrThrow(parserChangedRegistry.cacheIdentityForPath('src/service.ts'));
    const originalSwift = Option.getOrThrow(
      BUILTIN_LANGUAGE_PACK_REGISTRY.cacheIdentityForPath('Sources/App/Main.swift'),
    );
    const policyChangedSwift = Option.getOrThrow(policyChangedRegistry.cacheIdentityForPath('Sources/App/Main.swift'));
    const parserChangedSwift = Option.getOrThrow(parserChangedRegistry.cacheIdentityForPath('Sources/App/Main.swift'));
    expect(changedTypeScript).toBe(originalTypeScript);
    expect(policyChangedSwift).toBe(originalSwift);
    expect(parserChangedSwift).not.toBe(originalSwift);
    expect(parserChangedRegistry.activeCacheIdentities(['src/service.ts'])).toEqual([originalTypeScript]);
    expect(policyChangedRegistry.activeDerivationIdentities(['Sources/App/Main.swift'])).not.toEqual(
      BUILTIN_LANGUAGE_PACK_REGISTRY.activeDerivationIdentities(['Sources/App/Main.swift']),
    );
  });
  effectIt.effect('keeps rationale derivation out of cached parser facts', () =>
    Effect.gen(function* () {
      const file = inventoryFile('src/rationale.ts', '// WHY: preserve parser facts\nexport function run(): void {}\n');
      const provideRuntime = <A, E>(effect: Effect.Effect<A, E, TreeSitterRuntime>) =>
        effect.pipe(
          provideTestLayer(TreeSitterRuntime.layer),
          provideTestLayer(TestSystemInfoLayer),
          provideTestLayer(Layer.merge(BunFileSystem.layer, BunPath.layer)),
        );
      const raw = yield* provideRuntime(BUILTIN_LANGUAGE_PACK_REGISTRY.extractRawFile(file));
      const derived = BUILTIN_LANGUAGE_PACK_REGISTRY.postprocessFile(file, raw);
      expect(EffectArray.some(raw.symbols, symbol => symbol.kind === 'rationale')).toBe(false);
      expect(EffectArray.some(derived.symbols, symbol => symbol.kind === 'rationale')).toBe(true);
      expect(derived).toEqual(yield* provideRuntime(BUILTIN_LANGUAGE_PACK_REGISTRY.extractFile(file)));
    }),
  );
});
function runExtraction(file: CodeGraphInventoryFile) {
  return BUILTIN_LANGUAGE_PACK_REGISTRY.extractFile(file).pipe(
    provideTestLayer(TreeSitterRuntime.layer),
    provideTestLayer(TestSystemInfoLayer),
    provideTestLayer(Layer.merge(BunFileSystem.layer, BunPath.layer)),
  );
}
function inventoryFile(path: string, content: string, language?: string): CodeGraphInventoryFile {
  const match = BUILTIN_LANGUAGE_PACK_REGISTRY.match(path);
  if (Option.isNone(match) && language === undefined) {
    throw CodeGraphLanguagePackError.make({message: `Test file is not accepted by a language pack: ${path}.`});
  }
  return {
    blobId: `blob-${path}`,
    content,
    contentHash: Bun.hash(content).toString(16),
    language: language ?? (Option.isSome(match) ? match.value.language : 'unknown'),
    mode: '100644',
    path,
    size: Buffer.byteLength(content),
    source: 'commit',
  };
}
