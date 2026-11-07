import * as EffectArray from 'effect/Array';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {Schema} from 'effect';
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192));
export const ProbeConfig = Schema.Struct({
  id: text,
  version: text,
  command: text,
  args: Schema.Array(Schema.String).check(Schema.isMaxLength(128)),
  language: Schema.Literals(['typescript', 'javascript', 'python', 'go', 'rust', 'java']),
  settings: Schema.optionalKey(Schema.Json),
  configurationTemplate: Schema.optionalKey(text),
  fixture: Schema.optionalKey(Schema.Literals(['standard', 'java-gradle', 'rust-build-script'])),
  expectedBuildExecution: Schema.optionalKey(Schema.Boolean),
}).check(
  Schema.makeFilter(config => {
    if (config.language === 'java' && !config.configurationTemplate)
      return 'Java requires an explicit JDT LS configurationTemplate directory.';
    const fixture = config.fixture ?? 'standard';
    if (fixture === 'java-gradle' && config.language !== 'java') return 'Gradle requires Java.';
    if (fixture === 'rust-build-script' && config.language !== 'rust') return 'Build script requires Rust.';
    if ((fixture !== 'standard') !== (config.expectedBuildExecution !== undefined))
      return 'Build/import fixtures require an explicit expectedBuildExecution; standard fixtures have none.';
    return undefined;
  }),
);
export type ProbeConfig = typeof ProbeConfig.Type;
/** Substitute string values without parsing interpolated JSON or rewriting object keys. */
export function expandProbeScratch(value: Schema.Json, scratch: string): Schema.Json {
  if (typeof value === 'string') return EffectString.replaceAll('{scratch}', scratch)(value);
  if (EffectArray.isArray<Schema.Json>(value)) return EffectArray.map(value, item => expandProbeScratch(item, scratch));
  if (value !== null && typeof value === 'object')
    return EffectRecord.fromEntries(
      EffectArray.map(EffectRecord.toEntries(value), ([key, item]) => [key, expandProbeScratch(item, scratch)]),
    );
  return value;
}
export function providerFixture(config: Pick<ProbeConfig, 'language' | 'fixture'>): {
  sources: Record<string, string>;
  projectFiles: Record<string, string>;
  runtimeFiles: Record<string, string>;
  executionMarker: string | null;
} {
  const projectFiles: Record<string, string> = {};
  const runtimeFiles: Record<string, string> = {};
  let sources: Record<string, string>;
  let executionMarker: string | null = null;
  switch (config.language) {
    case 'python':
      sources = {
        'a.py': 'class SavedName:\r\n    def value(self):\r\n        return "🧵"\r\n',
        'b.py': 'from a import SavedName\r\nresult = SavedName().value()\r\n',
      };
      break;
    case 'go':
      sources = {
        'a.go': 'package demo;\r\n/* 🧵 */ type SavedName struct{}\r\n',
        'b.go': 'package demo;\r\nvar result = SavedName{}\r\n',
      };
      projectFiles['go.mod'] = 'module example.test/demo\n\ngo 1.27.0\n';
      break;
    case 'rust':
      sources = {
        'src/lib.rs': '/* 🧵 */ pub struct SavedName;\r\nmod usage;\r\n',
        'src/usage.rs': 'use crate::SavedName;\r\npub fn make() -> SavedName { SavedName }\r\n',
      };
      projectFiles['Cargo.toml'] = '[package]\nname = "semantic-fixture"\nversion = "0.1.0"\nedition = "2024"\n';
      if (config.fixture === 'rust-build-script') {
        executionMarker = 'probe-build-script-ran';
        projectFiles['build.rs'] = 'fn main() { std::fs::write("probe-build-script-ran", "executed").unwrap(); }\n';
      }
      break;
    case 'java':
      sources = {
        'src/main/java/demo/Subject.java':
          'package demo;\r\n/* 🧵 */ class SavedName { String value() { return "🧵"; } }\r\n',
        'src/main/java/demo/Usage.java': 'package demo;\r\nclass Usage { SavedName value = new SavedName(); }\r\n',
      };
      if (config.fixture === 'java-gradle') {
        executionMarker = 'probe-gradle-import-ran';
        projectFiles['settings.gradle'] = 'rootProject.name = "semantic-fixture"\n';
        projectFiles['build.gradle'] =
          'plugins { id "java" }\njava { sourceCompatibility = JavaVersion.VERSION_21; targetCompatibility = JavaVersion.VERSION_21 }\nnew File(rootDir, "probe-gradle-import-ran").text = "executed"\n';
        runtimeFiles['gradle/gradle.properties'] = 'org.gradle.daemon.idletimeout=1000\norg.gradle.workers.max=2\n';
      } else {
        projectFiles['pom.xml'] =
          '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>example</groupId><artifactId>semantic-fixture</artifactId><version>1.0</version><properties><maven.compiler.source>21</maven.compiler.source><maven.compiler.target>21</maven.compiler.target></properties></project>';
      }
      break;
    default: {
      const extension = config.language === 'javascript' ? 'js' : 'ts';
      sources = {
        ['a.' + extension]: 'export /* 🧵 */ class SavedName { value() { return "🧵"; } }\r\n',
        ['b.' + extension]: 'import { SavedName } from "./a";\r\nconst result = new SavedName().value();\r\n',
      };
      projectFiles['tsconfig.json'] = JSON.stringify({
        compilerOptions: {strict: true, noEmit: true, allowJs: extension === 'js', checkJs: extension === 'js'},
        include: ['*.' + extension],
      });
    }
  }
  return {sources, projectFiles, runtimeFiles, executionMarker};
}
