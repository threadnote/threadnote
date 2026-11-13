import * as EffectOption from 'effect/Option';
import * as EffectArray from 'effect/Array';
import * as EffectString from 'effect/String';
import {describe, expect, vi, it as plainIt} from 'vitest';
import {it as effectIt} from '@effect/vitest';
import {Context, Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import {Database} from 'bun:sqlite';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphStore} from '@threadnote/graph/store';
import {CodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {CodeGraphMaintenanceCoordinator} from '@threadnote/graph/maintenance/coordinator';
import {CodeGraphParserPool} from '@threadnote/graph/parser_worker';
import {TreeSitterRuntime} from '@threadnote/graph/tree_sitter/runtime';
import {CodeGraphEmbeddingIndex} from '@threadnote/graph/embedding';
import {CodeGraphObservability, CodeGraphProcessActivity} from '@threadnote/graph/runtime_ports';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {discoverCodeGraphTask, type TaskDiscoveryBudget} from '@threadnote/graph/query/task_discovery';
import {BODY_DISCOVERY_PREFIX} from '@threadnote/graph/languages/body_discovery';
import {
  taskPostingStatement,
  taskExpansionStatement,
  taskNodeStatement,
  taskHeaderStatement,
} from '@threadnote/graph/store/query/core';
import {decodeStoredCodeGraphFact} from '@threadnote/graph/fact/storage';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {makeReadDeadline} from '@threadnote/platform/read_deadline';
import {SystemInfo} from '@threadnote/platform/system';
import {runCommandEffect} from '@threadnote/platform/command';
import {citationPlatformLayer} from '../helpers/citation-platform.js';
import type {CodeGraphBodyDiscovery, CodeGraphIndexSummary} from '@threadnote/graph/types';

// Independently frozen v2 oracle; production discovery receives only prompt/scope/budget.
const frozen = [
  {
    id: 'a.ts',
    language: 'ts',
    path: 'a.ts',
    sourceSha256: 'fe74764ddaa7c45ecfd3f0b4d4df14c100fe4438117ab7a32dcc42c9e9847fec',
    expectedOwner: {
      name: 'f',
      kind: 'function',
      span: {
        startLine: 1,
        startColumn: 1,
        endLine: 8,
        endColumn: 2,
      },
    },
    expectedNeighbor: {
      name: 'g',
      kind: 'function',
      span: {
        startLine: 10,
        startColumn: 1,
        endLine: 12,
        endColumn: 2,
      },
      basis: 'direct same-file call from g to f; source expression independently inspected',
    },
    naturalBehaviorPrompt: 'Which routine repeatedly collects pending items?',
    sourceText:
      'export function f(limit: number): number {\n  let count = 0;\n  while (count < limit) {\n    count += 1;\n  }\n  console.info("collector pending items", count);\n  return count;\n}\n\nexport function g(limit: number): number {\n  return f(limit);\n}\n',
    oracleComment:
      'Source inspection supports a candidate and direct-call neighbor only. Textual clues do not prove executed behavior, Python binding, or a qualified effect observation. TS/Python journal code contains an append operation syntactically; that is not evidence it ran.',
  },
  {
    id: 'b.ts',
    language: 'ts',
    path: 'b.ts',
    sourceSha256: 'ecd39fe2c2e3a7ed43a59c82972c383af350dbba8011cd4524b3caa2c4eb16ac',
    expectedOwner: {
      name: 'f',
      kind: 'function',
      span: {
        startLine: 3,
        startColumn: 1,
        endLine: 7,
        endColumn: 2,
      },
    },
    expectedNeighbor: {
      name: 'g',
      kind: 'function',
      span: {
        startLine: 9,
        startColumn: 1,
        endLine: 11,
        endColumn: 2,
      },
      basis: 'direct same-file call from g to f; source expression independently inspected',
    },
    naturalBehaviorPrompt: 'Where is text appended to a journal file?',
    sourceText:
      'import {appendFile} from "node:fs/promises";\n\nexport async function f(x: string, y: string): Promise<void> {\n  const line = `${y}\\n`;\n  await appendFile(x, line, "utf8");\n  console.info("appended journal text", x);\n}\n\nexport async function g(x: string, y: string): Promise<void> {\n  await f(x, y);\n}\n',
    oracleComment:
      'Source inspection supports a candidate and direct-call neighbor only. Textual clues do not prove executed behavior, Python binding, or a qualified effect observation. TS/Python journal code contains an append operation syntactically; that is not evidence it ran.',
  },
  {
    id: 'a.py',
    language: 'py',
    path: 'a.py',
    sourceSha256: '1a18b9d25deeafc0ad67951e74333b9e6a6a67c4bf51b885daf81ebdaf9d177e',
    expectedOwner: {
      name: 'f',
      kind: 'function',
      span: {
        startLine: 1,
        startColumn: 1,
        endLine: 6,
        endColumn: 17,
      },
    },
    expectedNeighbor: {
      name: 'g',
      kind: 'function',
      span: {
        startLine: 8,
        startColumn: 1,
        endLine: 9,
        endColumn: 20,
      },
      basis: 'direct same-file call from g to f; source expression independently inspected',
    },
    naturalBehaviorPrompt: 'Which routine repeatedly collects pending items?',
    sourceText:
      'def f(limit):\n    count = 0\n    while count < limit:\n        count += 1\n    print("collector pending items", count)\n    return count\n\ndef g(limit):\n    return f(limit)\n',
    oracleComment:
      'Source inspection supports a candidate and direct-call neighbor only. Textual clues do not prove executed behavior, Python binding, or a qualified effect observation. TS/Python journal code contains an append operation syntactically; that is not evidence it ran.',
  },
  {
    id: 'b.py',
    language: 'py',
    path: 'b.py',
    sourceSha256: '6740f7d63336e6634d3ffead3c7969d2cd48cad47b5d4cd6a059cf90155f7c8c',
    expectedOwner: {
      name: 'f',
      kind: 'function',
      span: {
        startLine: 1,
        startColumn: 1,
        endLine: 4,
        endColumn: 38,
      },
    },
    expectedNeighbor: {
      name: 'g',
      kind: 'function',
      span: {
        startLine: 6,
        startColumn: 1,
        endLine: 7,
        endColumn: 19,
      },
      basis: 'direct same-file call from g to f; source expression independently inspected',
    },
    naturalBehaviorPrompt: 'Where is text appended to a journal file?',
    sourceText:
      'def f(x, y):\n    with open(x, "a", encoding="utf-8") as journal:\n        journal.write(f"{y}\\n")\n    print("appended journal text", x)\n\ndef g(x, y):\n    return f(x, y)\n',
    oracleComment:
      'Source inspection supports a candidate and direct-call neighbor only. Textual clues do not prove executed behavior, Python binding, or a qualified effect observation. TS/Python journal code contains an append operation syntactically; that is not evidence it ran.',
  },
] as const;
const decoyHashes = [
  '219052f619deab8725c065e774fc049dd7aafa25b0831befb2e4dbb1c12f1a18',
  '5835e747422766aa02129ed8cf8e41bc5579e5940b819c5d8ce1c0ce3540e54e',
  '3717793278411d913b46070dd30b1ed77fbead006675154f6e5d46d9c0115d31',
  '5727ccbc353a05b8664e4745746d5a21cfc64fab1a4e77c3bf9a185f5cf11f4f',
  '8b1ded8b7f4b158590eca2f32bb4031817b6b8b2796fb36bcdc79baa9082c5e3',
  '506ea9a058ba134f3fb3c58d1627361c07f7eb13641b7cf8b2c2ddefaa272e9c',
  '7b3b076f0617223debe1263e864ca2f9fafbc4ea4e7615fe8a08d8b9c415260e',
  '720f5ff55f091e688c1ff3436797108d9e14c5d586777695e6521f76715577a6',
  '0a4d43c1ff50bf0d02effea3e46c0872493bf7e4675b1ab0008ab8d240a4735b',
  'b978c6535ebf6f15be8c4bc36f11e887594a068a83a54508b68ed7380605d526',
  '2de1aafe8175a374718f656625968884d9dc12a0d53fb6ea33a1a12b6fe6a050',
  '8ab567b94185de2886958805633c460d2f501a5be69839e821f1dd54ef204aa4',
  'c01d5e1ecd747b7f2c5463e347dd2118de4d9c8cdf7b982e4370d00745f6973f',
  '4d555f3c6fd7e3d51f874a82f3476ddf797edaf0a3e8bde44bdcefdce687034a',
  'bb11887b33055fb8cda9114314e8d8adcf94fad12b45e23382c8a4f4c0bc736b',
  '8ec35ec0172f187751a4fa8a2a8acf411ff897dc2abc9487c6c2f188b129d5db',
  '637bf2bb72ec10296244fc108f54b4f0c4fdfbc2b77d7bcd56badfe1969f582b',
  '652434099614be260e90029f7cb5b7003872efab1edf5e8905e518f02dc4c862',
  '201669201f7601d4a3a97d72518feb35d98d6cb1c73a8a0fe59bd68faa34aed1',
  'b9fdf6723a8769ada8a403aa97f8eedab3e826a711043b3d34ce8eb0b33d0e46',
  '7c1e3d2582ecbd3e75dcef92a27ed523d4e0a01e0ef37a4c9a09069a32469532',
  '3056c200dc6a5abf4acc875b1c3b263b23243e7aa98aaad2ebb1afff43951352',
  '545480eb906470392b4ecb59259d65101725e1b72d1b431e3782ed76b67a446d',
  '3a4c928e8cf02e61e812bfdc7a919f2b5ce2d1b4d1e54ce53339578734b4816c',
  'b01e0a85982d24a42fcdc85756befb935b508a98a0717c3029458d9e2e766868',
  'd7be929174474ae453da3d692a164c623ce5b5e57e47a95bc1ce0c75efbd5b30',
  'a9a1eca5fcf86ff83107f6484c46cdc00a227ac03b4582d25a19fbdb19edd09a',
  '70d4d9d5718ce19d95ebeb07ca50600462c891b8034a9097ed2ea588bc82b2fa',
  'bcba8a40f690d05db82a999d95b733109a278243e65ff183c8a8787e180ad00c',
  '54a08acf3856850f17062ae2674aee769d1103a2d4c69a69971691cfab4ff0f9',
  '63ef4f8b1851849345893130df6229aa8a566795b1ffdec6e0f6d7295dcc2dc0',
  '203a00e090226496c713af8d06ee97fda66384ce07178018ec48168b5b478413',
  '3801fda68669a3e34f3b97af1d7263cf89061ebd975e3c5fe513dab567dee59d',
  'bd7ac03927abed6a880ea683c9ac75abff1dcf864d1ffc997dfce7347e5c0faf',
  '40f37f83b6778a86a9b62cebf4731e8955402f164762e7bb5b125592ec97b624',
  'f604fdf8373e74a907f6b8290cfb70f7437d92fa56d161ac7dc986a611eee458',
  'f6fc5109c7998303c7a437468c17bfed1931030e4599e106e9d439e94094563d',
  'aa7766b5785020eb3414842c5d846e828c337683512e36e941c6a27e4810e3d1',
  'd41a500aeb3b57ed8e7099132852f13d44415a705c62d4e06c61cbadbf668cf2',
  '666dc0539e77aef574519341139970c7ec2024b0a20f0fff3da7fd2dca501350',
  'f5dd68963c4337cda9bb6e4821a328ed4d8d7ba6e41876c9d6b61ea65292c1a8',
  '0868d9a74e74c57cfc509251e06f5a04a15ffa7e9f9d5343f721d71143cc3535',
  '1b3e186ab98be0ad35e317fc2207f3a912af9641e4a66da8d68a2c0779252153',
  'd75669180bac7e57972feac5dc2a04691af7d8d2556680e6ecb6856617a10571',
  'f72a64d279a7dbeb390c72ba716645dc75d59d92f9d653755bf01591e91bdd85',
  'c183355201071c1a6c7a0a3a7c4be2794a4e7d9e277857cb4c721951aa50e704',
  '00c01ab3e4e3286bf0050110d8ccb33aa318bf1adf7d778582d4f853e7150744',
  'abba0b22d075e23c6e1ab82c081437438a75b7e8afd6bb23595c5189ad4fb62f',
  'd8e4bc65582660255d6e812b8a9028b36b86ce2f144ca5ba7a242fae44417fa3',
  'f26e730b2da0b764065d294712306e53e39752cf62978e265156e6b255aca637',
  '4b223419493e8c08fc556e583651fe03ca62bb8bf1c6ae74d9bb4ca7a91afbc6',
  '9b7b1f037092b8c183d7056986b64f87e19eec266bfb3865324ab87fc020ab23',
  'c8ffd189cc35d1e5e10f339f4ae136ac7c5eb39a58dfe87bd42723acaba26025',
  '9497323cc19e28ade917251a2ceaedafde7aa3ab2805fcdd7030bdd685823f32',
  'a68ee19557f3628487eba57be650b0fca8a03ad1cc6a39000b496b376c41bdea',
  'c05cb32dc449e077ad92d439c5e44a9f088ea4f4fba70043fa0d77fd61ad028b',
  '2e3ba219ec819606510036bc4cb53833b5b8594531e7b55ba17b93bd225993cd',
  '784562131cd58de419ea093e854c12d6ee7f1b0a909383e2774bda71afe8aaef',
  '498e8d0d767c5c7c7b993a3fa1a35f40d713779fcbe660bd908cba03fbff192c',
  'bc812d46a4f94b14c180d02e4092ac15b2f6dfc8118a1b3cbcb5a6e103c2cda6',
  '41a5489abd16647a561360f26f4621822eb5b3480edd32eef45b68a83a9d9fae',
  '541efea29e088f1104a96f13fe73e7a3ea358d0b4503dcb0fd5af6272c04d910',
  '035f70dc55e81c6ccc21800676c0ce605f748618e07681dc0231ca3213ad322a',
  '8ed98123f05a07f92ff5e5804e2e49e40c2d99c1a7bc1c28b4532568efc19d89',
  'f379b66f7c9a80daa1129063391945dff86d1361be3f6809426df6b4463ea12c',
  '5885ac9750464c41d58d93f72fc373e5ad3b09d752d81c1974bbd8496d6cbf4e',
  '32c61464b3a6d779e36aee1b46a06b003360b03597f0f7d3858a0971208c737a',
  '3630622c9e810f1add7a4515f1be3b0d87f6323ca5efb6dc5f1a1137df665777',
  '25c4239c500e0665b548ac2ddc7f0e612f1d899c443c1cda80752e27a7de9890',
  '553046678ebe1351e92544e2e0987210be3f33b6b5d48842b915947dbe206c02',
  'ee877bb8b8c4dcbef2dcb0a1cc08055015187c5dad5ad95b31907df1f227e0b5',
  'dde0b13fb4b452ac28d7f9080063bc737f9238a788acf5aca357e97c071bcfde',
  'd93f37e28505722f53703e7be724482458f96f0d7457296b3781f6db6e147a06',
  '7637e9e475a1f5185419e843e9d94a17b350aaa060c959fd74ab23dd05db368a',
  '015bbad0daddf04be7312b685a0a5735be079dd37a2fd90607982c888fb203e6',
  '8ec3db53649c8fa80728b7e9ea7acaf2ccb6b77e907ad8827ae80daadef0e3d8',
  'e2868042f5c7f82f86c39852fdeb4685b06919d63ad0aed745eab1b5213fdc72',
  'dc9115a511ae5c05a8eed4c0bbef5967a7b651b052a6f546843073f08a714cdb',
  'ac6d16831acd8121e1474133c353bc631837e7e8f9f6b134183a4d1a3b3d1c4f',
  'dc6f1bac2c18d4824b91b3f6ff014dd8a6ffd7f6de0e893c06f68388dffb2fa9',
  '2c41eccc0aaabdf9c492ab8c50464ecf561d567aa171610a8d1befa1c6c1ed55',
  '6e5b36c6c0573d9cb0e1c953fbc801ec3f9786823e5604613c3c6a18c6aae6aa',
  '807f5001236926b35a9f5ae1a364bd668406d426b2917402aae8ae76f8c010d9',
  'cbad08a34bda57524ff1ae1929c8dfbd6c5d9798d6724fa13fe1d304d6f77528',
  '28cc1d8c5b163d297feab1388cb3f1590a38d4b9eac3d8805121a0298ba05d56',
  '1b72c30a9a6d22686f6e480dfea48983def4673d22dd18b96c7e33e89d980d21',
  '9a3e47774dbdb2cbe8dc26735ee9a9d4a45e1467e45523d42092d6d3df67cfff',
  '9be1a96e95117bbe97ce5478dc8006fc44e88d1fb59b44b6b3e0fb425171112d',
  '54d43274bb40d6fdb196400a8e00bfa20e3d5bbe76fc549faab0cd6fdb6631f9',
  '58569ca2d27eb3c5aae7b5965091db877b7f092c3eb3d7b328c80c128ca713b2',
  '6d17ac272f31cf460e38612801b4724b43cc073bb6902ca6cb553824c3968810',
  'cb0c53b43f6f5b6c6960bf7f304e0ad68bfb41f5ae425f9f127c509f35b95c3d',
  '068e57664505eb2d6aaa4af7b6b60e9a6252faed7940ae2575749bc3c2cf6d42',
  'f7737020a895373ee9336ad4b35410e964a7f0e67d860293d3ab948e50a1bea5',
  '87b39b5fe4265757c2f0744d5eb32c7de35c6a32f1da8eaf9ff73b890e34b9b8',
  '7a75da87e2305bcf65d7042b0b84ddec64cff90033bc187f69e38b7f70fa36f7',
  'd01e7f7a262c98545cfba03c94f3277e8fcc8ba99234b360da199aad81ba9453',
  '7424f3c9e6cde6129fd1c4a3309714013db2a8a8099d020fb5c627b4a748274e',
  '6abb63dc948449aa061c02b481cbf50e679e3ac3f03f81c715461813554c8b82',
  '64290e035486fe753d6d364e968458f272a0428baf63e6db33a47b1e1a4ff1a0',
  'e2a85bb9e8f7374632d0006848b5cfdc413539b09d1570f6b2a04d098fffd79d',
  'f3b7d29d579fd4ce206b1122d8e070c10dd1159b29639f06eb58f9fef61c840e',
  'b9015e1239d59c022d9b172fe611648aeb533996ae5227274100589fa65fc79b',
  'bd548959c0250932b8d5f05235c996d816949d445496abd4315f9e85cb21961e',
  'c4af53fa7905ad67bc34d1a5a7cb48926785c30116336750aed5cbf3e7c99682',
  'cd7887287a09061ad00f3c26c89328a1263cdd8dafc82220eef636535eed03a1',
  'aa9225b024da4fdac7446b8d2c05a1411cd3fbb1c12d470d007ddd78df9c498c',
  'e2055e1b7eaa642bf80e81de36cdc5b4db6b60b30d32752fb1f1190bb91e4f17',
  '48e037790d2c7765e67c446215d557e80ed2ebaac1c1eb50c1f4dea2a6bf1f74',
  '3ecc8c2c8dd8b7f328b870bf02c80f979466658d10e21fe4a0e4c1c14ba3b260',
  'f409147849af3455a02958e1721edccee685631b6357744c02b1eab83ccb11e1',
  '681e8f2ac2275ad3a1f61593ce01f37bcb94ebf4224337641b6c8d32ad687e7d',
  '41878a1b8ec2967c3d9dae9494cc4eef94a38d23ef8c46901f71d1d055f656f6',
  '207413c9c2008253162c91ac6ee8be426a1cb6f80b210b578ee13d7d4358d2a6',
  '1bdcf58ee7c8cee971da2f06be58b016cbef6e2334abd43b1fdb5088ff2bcc5e',
  'a31f45c528652854a073f506796e6bbb93a3550e866f3a2393d9331490567a90',
  'c3dda164043b4f016894bf025c18feeaffd8ebb0c08f8508d9c7538ab4f9b4b0',
  '75837c01707ee9755e8d0e6f5be554f55a92594304e10fca44734a0ec3765ab8',
  'f1e352ed2321a6f79b8328fbe64b4d3b180bf1c81652ffc8adfceed3713d5ca2',
  'e3d5e962ee657526e4ff6e46f4dc3cdb629cd22a985b06b4014dab6683aebf80',
  '818a2e5f482ab6b87c1b8449869558e08e130fdfa955564d7fe2c6e70f82c838',
  '06a940d477dc89550e7c2330f02f98f551a39a1982fd5e1cf4f3227e88eb6251',
  'e38f8f00cb643ffa7c2088457738df32debebb056315ba80f6f6db4527f7281d',
  'a0d247b75c324add4a7a92b40e90caea34c09ed88ac7c7c9e5beeee6aaf72e37',
  '833b855cd48b92db5053ac8b435631da53d060b3c2938a797e937a468eee7c86',
  '1032d9662e75f708deeb53f61632af9b5b6028441a102066bfc1ec32f404782f',
  '0ab6f8a60a03410b9a0e9da91e09c30afc7d308d3283b5f26cb955f6e5116a2b',
  'fba5686a6621bfb076538f4c619087f4d0713f35e2133b5fcbe88f4696b36886',
  '5f80da4f637c46c5d5ca2d0ba81efafdbd479d453267475625dcb6513640d4f9',
  '76ef0ab8e559323e1ecbd44e9a8aee832f60af27bd47e3e5b9d7a82e555cbc0d',
  '7324b33d945c4d7e68d85aae1278e9cce42ed20fcb3a01d922e71fca6d734e68',
  '8b4e82812fb39eac9c901fb7f43dabbd5998d8592ab60587e3debefd3336070b',
  'b3f497e13e766261c1f650c946da41643efa3516a9c77fd9e7e33b584065a297',
  '2fb48a9d50703fb8d5ab311e681dcea65884fa434390a5e35f63bae75320ed08',
  '05ab2780be0812448863e18dd907665c07cde391128cf6c44bceca94f1139aeb',
  '9ccc8fa88d28f431e337d486c27114cbe0caa7f1960c4a853165e6cbb71875b2',
  'c23d72ac71981c17db7b9806e2922dd0cf2fbe9897997d7da9745aacec5f9d5c',
  'e509e642fa44b9898561b80db42f74054f6f5c158541c847653884265e11a393',
  '33ace08e2befd6876997011460e4f648b4e55d6cc5e1e191c070f22c8e2851bf',
  '3f28f0f24d1531b0af332df7dce89b6cd53f941633441b83be9e12eec585d634',
  'f835e8d1bcdb4b5f7bbd9df9143e945c715499dcc27744333980ea33349ad643',
  'c4b7f6c1647435ca0935d63f7803bf7d9fd6fb3adedc96341a03993e88a1fdce',
  'e56e8b6a8a276150da01948ca1b77e5373a12690409fa6435d7024759244e666',
  '30ba805672df658623f65a1102af635b1072162e955a6796e7eecec4735e0ff3',
  '981412539d7e2aa8ab00012855f90706c53ab8213db452b0a145497e03e2d108',
  '7440c1bf0d0d42305426f1c4ff0eaaad89f3586cf94b9f2a9760e563f084cd8f',
  'c82d6d0b8d6ed27eaa5ffdeaf4ca608559d02a8f984c2cbf540bc983d4b06ba6',
  'aeaeb2c993bc7751a53c4719071ed16d715050d0663147623cb9481f3f3219db',
  '3d9a23bd36a3866e724b64ab20fc4ba51c6913002fa59ec051100eaad1ad42e6',
  '373793d896b3da095b0cefa65bebb8f64368576014b3cadbac5be9a407bd63b9',
  '3905c73af60137e591a589fec4ebc232af17af01205687a2dde1a8f35a3ee0e7',
  'a6b6544c0947012c3503abc216b73a70b2016109d1bd6d6abc3701e80f941674',
  '26aab9da33e9d8a41e8350a7e4b4bf3157955798a7be974f210217c5eaad50a8',
  '69aa5fb94d452ed155eb32fd5ba02cb6ed96028ae4388ed6323d8b36869e85d4',
  'ef561d9dd0b14615c7d764a723d42e56764145ba81a851897072ae8a4b8c96df',
  '5f1647a0caab369e8e40eb80ea93d749b542e443c997ad3ccf980f075e2259d9',
  '03b9ec29161bc956bac884efd81929b0dbb1768367fce743031e11fca6b8f1d1',
  '10028d26eead11c2916ef2193b35ec5e058b52a30657d8147cce313294bdffc9',
  '9d78970a7ea5f0c9e45024b7e23e2c0064abc8aed9c6e4f91c209743d9c43155',
  '451a118b1687a5d9458104d36ed4aa09a4e459f5cd8ef02b9fd658e51a88c5d5',
  '878e634a0094b702c2076ffd7c0967e69717f1e03ca8ab40d5e9f4a115ab36b7',
  '4e141d7389f2727def2b8287422ed217a911d02e47f409b28ed87fb064a28e02',
  'ae9eb027be169fdbc0e1531c33056291197ad77da0bd121b7be8b06db4d7e1db',
  'ff1fc7f25c73d906673da51f5fc9da3ddf0f1938edd3be840a4c6be5424772df',
  '7c169443958c785bec314a5fa544cd04c4fd357b53e412962f7ec9dea8d495d6',
  '726dad16ba48478693e90a895fe45ed83bd77cb0de9811b99efd98a1a49bd2bb',
  'ce80c5a5738361096539f11df0e5a7115d395580e29a7c4c50b4e9909d2d0393',
  '45dc1c17d6ff5682646813ccbe8227ae46b2820931a3072b4d6db02836d6eba6',
  '7c0c3501766f9fef841b22a4e9baeffc4b5a0701b2b8b147e0fee29472e7f109',
  '380a93ce94c23827b6ba9c854250393602e73461f2588065252fe3454ad711f5',
  '33b9d77b6a28cf83c3dbf9f49c43c0efcf4f1da122df5d4ce8fa0c8d4ded0734',
  '47b2c14b5da99b7c0804d408af19aa7917d690a72173ca645246c84d50f4ab83',
  'e50b345b2641f4bdc98105488177196be84d6995425200bff5c542524bbe24f7',
  '2745f35d6d11141b32632c3c583aa40d7ad7da146fda9bae1848cf6bb09460c3',
  '7ac4e2fce14a073c6a64a56ed7ab1ea064648e6d215fe3354fcde8173e2a2936',
  '3ec351d3bd876f51b20d757498ca2401f2d1cb00d751d15ef234479fe7c48736',
  'b7460869e640b855331b3bd73752f38b9020ef8d528003dba034726cb81232e8',
  'e6c6043b57858919efe5c64e8c55282e618161a1bf4976cc83e18095928467dc',
  '3ce20b5199de58925bb9651f71b890bc5c209ba98dac5f41d5aeda88a74d1725',
  '640e1994d48b4fcf47c676033f12e0a414f12ade021de538673d5649021370f8',
  'c8298f1242f6d2b83a4281cd922d62f45997f69f433fc1a7b8b8887fda0c816f',
  '41da78088927a0d4d459ca8150cc750e0ea5a00118d1b60b09c4f160f51db87a',
  'd8ddce303d02322b2bccd1da49ac1edbcec68734497291c382b2d3de4a26d9bf',
  '000128504456a84b83fbbe1225673c5fe86495c518ed4ee9f1b62dc7a88ff9d7',
  'b3a8dc24840c4a3c8ddc90cf5c07a582c300f9b5e6e3dcf1714f64de3e52e98b',
  '54b618180b001004542e33f5ffc3c5f1f5b9a917a186cb526f8ff1137007eb22',
  'ab3d6d5718cf037487d55856ac77e8611386a120a9644a415dca0f65b4b06c60',
  '42b4e9362a61e7c004edaf536bb72a54281b1c2320e6d188931c7930f289efd9',
  '4793f5fe701cfcf83f7ddfbba96d47e14c33f9e2fcf426d28f107a65ec4efcfa',
  '769500719320d223750ef0c4bc5b504f2b85e4f6415a07df7d50b1935c183db9',
  '4a204e197d464a865b69b06e7020f577f5d968d2a97fa70dfba52c3167101226',
  '717366e3398c517a869e5b3c1ecc58225310e07486de0e537f4dab0f7aca96f5',
  'ec0e65facb02337d5d1a17061e104b5668f36e7685eec3e004f1523844b1ff00',
  '3cc416fd4bc0e59eccae934d085310ae7490e4b09db9f2fe58aa286156804ab7',
  '2a69536538811c9607f179a7b4d663ed22c89c9d8465758f52017f39899d81a2',
  '9c5fba30544548f9c63f26709c955e0de2cae7f95975377cbbc7bf7be4ee5bbf',
  'e7bfdcaaf8ac561c364445925cb94fcfb4991ec11b2dfd90eb690b548cd9b857',
  '762399bd9d4ac35dc0b6ac6890fba08f292b5bfc069ad8bd5971b4ed28f0f39e',
  'be296036d7835e47716df833c79bab186aebf007553097111d310b3429274396',
  'f097550e280ec940973cc873f4519032e5761e13617b6f81bf7b1cae0813201d',
  'eedd45e5179a01d87f35b42e032a4208e3bc33d3d0dae1fab3eebee32414ad5e',
  '65e2cd4382f257f85e1e593de6897cee1c5251efbbd15a2bdcfe3f80f70d668c',
  '509180eb2e2212f6addda4e714f873603f23b8315553b6aa3e44129302336929',
  '975041121f16e8276216270a71bfa00bf41f9d572124889242405d11884376ae',
  'c1d81ab685cc1e1311ad4ae8216f2eda029bc022fb341593ace7435c06903556',
  'bcf5c39655d52bc6ed74653b9d16a46965f74c7adbc79ac9b4ca576c12f31a6d',
  'be76e330c58851083e3df9dd28271c63ac01aa55fe7570f963d2de348fc92a9d',
  '548b11ff4a2d1f5dc6f35dcf167fbeaf07f73fdad6d11861dca0f4b5f74450fc',
  '87e703f06d1f8b7f657f87c6044b00868b6b7eeb1a2731648a09b4cb2f279147',
  'cdd693a18d4df8719da6889c93f813d4a26a899c9c8bbbc49c83baa9402d3387',
  '8b59c4c2e65b4df49700cd78adfb25d5f0f83265a28ef32108557623ccfe1a55',
  '7098e31e4d7be39c8885dfcf73b0ef8346e55c21430388f50b53a76d4d227c3f',
  '1d7381df1d348edaf69f9c79ce12261043045a3561f8f06cfdce4c1b7e7f79ae',
  '7bcbd03b1a2a8d46dbbd626702cd258c947968ddb91601824c32f965b5902711',
  '506c7919b3774c2ba4c9ba4b768e9731cfa763551e5c1726efe5c86ae80886f7',
  'a931fa8abd7d000a8b3bd630f3a8675dca3ab51ff499240221993d22bc541d31',
  'ee23a703615df194c629970cb91c98a7a60c9685e33844147c91a5e41b6ba998',
  '030a5c8bfb062a19256c849f7b2ac05ee9456aca341ef758792685ea7fa0335e',
  '2c647a4f74d5451b1a2392fc072c3441061f71ed5378af1ed97c37166f2c9463',
  'fde8d21a8e36784ef7859a3f71c63a2909e551ad2578ce23800062aa30306cd2',
  '6e832059048febc65dd2e0b17c8e18b9a40f8e19af4504495fd0863a0e901ab4',
  'c6363235586cecf45348f0cd983f6fd552162da48a2bf330bc9d2b92ba97fd7d',
  '32b7ad53a656a1060854206ac2f909b19397816187b5f86e49d98cf509b04271',
  'ef1264e4476a618022e122f8b16edb898e5466019aabbb922233ac7d8347e355',
  '9378fcee1d83dc4d237b90a58c6b4051ecb248c4d562d5f7fa6109700e6e7d77',
  '5a58de57b5aa4447f1f017a36ef9de4a86fd2dc0bba85e696c476668ab81d57e',
  '8975d73974c81c05958cb1592b0ed1b8ba5540a840917137221b25c60f18c596',
  '0bd004779ef8e89b25e4806d8907490efe0dbcde22d1f70b96b27cd15bd15b9b',
  'f1c0fe07c7801b5f1e1b6fc2313f6c732ddcbb68263b083e397818d97598ed9b',
  '67c969e3919239ecea4a8ca14dc43870046c0de05c52c4009d633370998a82f4',
  '4702bb2af1fba6bbb98443bd37824ac2ca2281ca0fba6c8cf5f596083b0fa5cb',
  '762fcd4fd3f32bd8206f67ffb73f1898f771dd404d00788501518fa4cb63a7d1',
  '15a3a91518f9968ba547f20e258647813855960ca621c91ce2a0f42fafec2fdb',
  '31771f2de7baa28b9844aebdbb24884c707ea17778fb582b3d5167fc14cf3cf5',
  '67cd1c54654eb435fbc241f66087bcc188b3c270162246a70b2ee88eac1831e4',
  '88f73f6a44497e9ed13636a02597fdabc0d3c96344f7db11a7d6bb4a53b581cb',
  '6988dbee62cc78c507e9bb20be603b3e829a4a548696f99fa91e40180cce7303',
  '4c4b36b77b40e8a8f9e6e1a517ce5b1ce062bce687061d2a16ecfd76fe6be7f3',
  '52ebad70450c5382881671f02ea170142887efc19e96df976fc04e9ec62245ce',
  'b538f6d15ac93a8ae574d03457a1b914dbd70c32f1b6953fc92f940b5d5c786f',
  '72a91526d1f3a4303944e311012911e92732522a189c431c68ac3317fdbcaed4',
  '76f8ee02369a04045edca19f0ab7fd3816c4594e894dbe32a52e5920a415cfed',
  '9d82b37e5604d681e864b016fc26ff0824cdb62923dc68306bb7a73975501163',
  'a63c383fd517b3b7ebae215f8c5962bae3d1e20f9d8cedb32b2114b7a88cb387',
  '2c009c36e79dee44ee3ab957af24c7c97b15e148d83deb7b17e391a8649f14f9',
  '163314775e5c0d93983e06d0af3dc245d5332e728b9b5b994bdbf14676d371ec',
  'f2259c35ed0c68d5938cb317d47e59b5dd925a322e7b87719b718a6f95a621b7',
  '84caa945644988720a3f88d372ea978d85e769b5fd56905eddd64836fd1d70bd',
  'c4e3e43310ccfeb15ffe911626d05ce243c7e9944bfe20199ad57d36f6419c0d',
  'b372c12dc11bb3bafc75ad756b81628e3d15f4a4c1b2998763184b9f177ae9d9',
  '099e8ff7ec677b2bcf7c248583f5404f49f00b51a649a4438055d66098b92b99',
  '1dfc71c72f89a40569a1e6b9dbfda52242a6762464292a0489fbd747ffc58615',
  'bb52ab476b62be4aa792f8bef9720ada7171fecc61e3652d43552f48bbb69d35',
  '00faabdfa8b095afb91fb920b143d96f463febcf3280180b1cbe8deaab882162',
  'cd6408bac09310dccf65d6c9ce4d068e513d2df1a0a93c93adb9cc2cbbfaa0b6',
  'df2f6338092c3341445f9abffe5b70dc0ce8f96a9ac072eb2377209d4133f43d',
] as const;
const platform = Layer.effect(
  SystemInfo,
  Effect.gen(function* () {
    const system = yield* SystemInfo;
    const path = yield* Path.Path;
    return SystemInfo.of({
      ...system,
      developmentEntrypoint: yield* path.fromFileUrl(
        new URL('../../../../apps/threadnote/src/standalone.ts', import.meta.url),
      ),
      environment: () => ({...system.environment(), THREADNOTE_CODE_GRAPH_PARSER_WORKERS: '1'}),
    });
  }),
).pipe(Layer.provideMerge(citationPlatformLayer));
const ports = Layer.mergeAll(
  Layer.succeed(CodeGraphProcessActivity, {withActivity: (_role, _operation, program) => program}),
  Layer.succeed(CodeGraphObservability, {
    makeBuildReporter: () =>
      Effect.succeed({
        observeExtractedFactBytes: () => Effect.void,
        observeInventory: () => Effect.void,
        observeOverlay: () => Effect.void,
        progress: () => Effect.void,
        terminal: () => Effect.void,
      }),
    makeWorksetReporter: Effect.succeed({
      failure: () => Effect.void,
      progress: () => Effect.void,
      terminal: () => Effect.void,
    }),
    backgroundFailure: () => Effect.void,
  }),
  Layer.succeed(CodeGraphEmbeddingIndex, {
    check: () => Effect.succeed({state: 'unavailable' as const, reason: 'vectors disabled'}),
    ensure: () => Effect.die('No inference'),
    search: () => Effect.die('No query inference'),
  }),
  FetchHttpClient.layer,
);
const base = Layer.mergeAll(platform, ports);
const storeLayer = CodeGraphStore.layer.pipe(Layer.provideMerge(base));
const dependencies = Layer.mergeAll(
  CodeGraphMaintenanceCoordinator.layer.pipe(Layer.provideMerge(storeLayer)),
  CodeGraphParserPool.layer.pipe(Layer.provideMerge(base)),
  TreeSitterRuntime.layer.pipe(Layer.provideMerge(base)),
  CodeGraphLanguagePackRegistry.layer,
);

effectIt.layer(citationPlatformLayer)(it => {
  describe('actual task-only body acquisition', () => {
    it.effect('charges cycles and high fanout before expansion hydration and preserves caller reservations', () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'task-expansion-bound-'});
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const fixtureServices = yield* Layer.build(dependencies);
              return yield* Effect.gen(function* () {
                const databasePath = path.join(root, 'graph.sqlite');
                const store = yield* CodeGraphStore;
                const identity = {
                  caseMode: 'sensitive',
                  checkoutId: EffectString.repeat(64)('a'),
                  displayName: 'fixture',
                  gitCommonDirectory: root,
                  headCommit: EffectString.repeat(40)('b'),
                  objectFormat: 'sha1',
                  repoRoot: root,
                  repositoryId: EffectString.repeat(64)('c'),
                  worktreeId: EffectString.repeat(64)('d'),
                } as const;
                const snapshot = {
                  commit: identity.headCommit,
                  dirty: false,
                  edgeCount: 21,
                  extractorSet: 'fixture',
                  fileCount: 1,
                  id: `cgsn_${EffectString.repeat(40)('e')}`,
                  repositoryId: identity.repositoryId,
                  state: 'ready',
                  symbolCount: 21,
                  worktreeId: identity.worktreeId,
                } as const;
                const span = {line: 1, column: 1, endLine: 1, endColumn: 2};
                const symbols = Array.from({length: 21}, (_, i) => ({
                  id: `cgs_${EffectString.padStart(32, '0')(i.toString(16))}`,
                  name: i === 0 ? 'pending' : 'generic' + i,
                  qualifiedName: i === 0 ? 'pending' : 'generic' + i,
                  path: 'a.ts',
                  contentHash: EffectString.repeat(64)('f'),
                  kind: 'function',
                  language: 'typescript',
                  exported: true,
                  span,
                }));
                const edges = EffectArray.map(symbols, (symbol, i) => ({
                  id: `cge_${EffectString.padStart(32, '0')(i.toString(16))}`,
                  sourceId: symbol.id,
                  sourceName: symbol.name,
                  targetId: symbols[0].id,
                  targetName: symbols[0].name,
                  relation: 'calls' as const,
                  provenance: 'resolved' as const,
                  confidence: 1,
                  evidencePath: 'a.ts',
                  evidenceSpan: span,
                }));
                yield* store.activate(
                  databasePath,
                  identity,
                  snapshot,
                  [
                    {
                      blobId: EffectString.repeat(40)('0'),
                      path: 'a.ts',
                      contentHash: EffectString.repeat(64)('f'),
                      language: 'typescript',
                      mode: '100644',
                      size: 1,
                      source: 'commit',
                    },
                  ],
                  symbols,
                  edges,
                );
                const observation = {
                  repository: {repositoryId: identity.repositoryId, displayName: identity.displayName},
                  snapshot: {id: snapshot.id, commit: snapshot.commit, worktreeId: snapshot.worktreeId, dirty: false},
                  freshness: 'current' as const,
                };
                const budget = {
                  remainingReads: 17,
                  remainingBytes: 4 * 1024 * 1024,
                  remainingNodes: 12,
                  remainingEdges: 4,
                  deadline: yield* makeReadDeadline(1500),
                };
                const acquired = yield* discoverCodeGraphTask({
                  databasePath,
                  observation,
                  task: 'pending',
                  budget,
                  depth: 2,
                });
                expect(acquired.evidence.counters.rawEdges).toBe(4);
                expect(acquired.evidence.counters.hydratedNodes).toBeLessThanOrEqual(5);
                expect(acquired.result.nodes.length).toBeLessThanOrEqual(5);
                expect(acquired.result.edges.length).toBeLessThanOrEqual(4);
                expect(acquired.evidence.gaps).toContain('task-edge-cap-reached');
                expect(acquired.evidence.gaps).toContain('task-critical-expansion-omitted');
                expect(budget.remainingEdges).toBe(0);
                expect(budget.remainingNodes).toBeGreaterThanOrEqual(7);
                const malformed = yield* Effect.acquireRelease(
                  Effect.sync(() => new Database(databasePath)),
                  db => Effect.sync(() => db.close()),
                );
                malformed.query('UPDATE edges SET provenance=?').run(EffectString.repeat(262144)('x'));
                const rejected = yield* discoverCodeGraphTask({
                  databasePath,
                  observation,
                  task: 'pending',
                  budget: {
                    remainingReads: 17,
                    remainingBytes: 4 * 1024 * 1024,
                    remainingNodes: 12,
                    remainingEdges: 4,
                    deadline: yield* makeReadDeadline(1500),
                  },
                  depth: 1,
                });
                expect(rejected.evidence.counters.nativeTransferRefusals).toBeGreaterThan(0);
                expect(rejected.evidence.counters.transferredBytes).toBeLessThan(32768);
                expect(rejected.evidence.gaps).toContain('task-edge-metadata-omitted');
                for (const field of ['path', 'package_name']) {
                  malformed.query(`UPDATE symbols SET ${field}=?`).run(new Uint8Array([112]));
                  const omitted = yield* discoverCodeGraphTask({
                    databasePath,
                    observation,
                    task: 'pending',
                    budget: {
                      remainingReads: 17,
                      remainingBytes: 4 * 1024 * 1024,
                      remainingNodes: 12,
                      remainingEdges: 4,
                      deadline: yield* makeReadDeadline(1500),
                    },
                    depth: 0,
                  });
                  expect(omitted.evidence.counters.nativeTransferRefusals).toBeGreaterThan(0);
                  expect(omitted.evidence.gaps).toContain('task-posting-metadata-omitted');
                  expect(omitted.result.nodes).toEqual([]);
                  malformed.query(`UPDATE symbols SET ${field}=?`).run(field === 'path' ? 'a.ts' : null);
                }
                const keyed = malformed
                  .query<{snapshot_key: number; term_key: number}, [string]>(
                    `SELECT compact.snapshot_key,terms.term_key FROM lexical_compact_snapshots compact
                    JOIN lexical_compact_terms terms ON terms.snapshot_key=compact.snapshot_key
                    WHERE compact.snapshot_id=? AND terms.term='pending'`,
                  )
                  .get(snapshot.id)!;
                for (let key = -140; key < 0; key++)
                  malformed
                    .query('INSERT INTO lexical_compact_postings VALUES(?,?,?,1)')
                    .run(keyed.snapshot_key, keyed.term_key, key);
                const dangling = yield* discoverCodeGraphTask({
                  databasePath,
                  observation,
                  task: 'pending',
                  budget: {
                    remainingReads: 17,
                    remainingBytes: 4 * 1024 * 1024,
                    remainingNodes: 12,
                    remainingEdges: 4,
                    deadline: yield* makeReadDeadline(1500),
                  },
                  depth: 0,
                });
                expect(dangling.evidence.counters.metadataPostings).toBeGreaterThan(0);
                expect(dangling.evidence.counters.metadataPostings).toBeLessThanOrEqual(128);
                expect(dangling.evidence.counters.nativeTransferRefusals).toBe(
                  dangling.evidence.counters.metadataPostings,
                );
                expect(dangling.evidence.gaps).toContain('task-metadata-posting-cap-reached');
                expect(dangling.evidence.gaps).toContain('task-posting-metadata-omitted');
                expect(dangling.result.nodes).toEqual([]);

                const denied = yield* discoverCodeGraphTask({
                  databasePath: '/unused',
                  observation,
                  task: 'pending',
                  budget: {...budget, remainingReads: 0},
                });
                expect(denied.evidence.counters.reads).toBe(0);
              }).pipe(Effect.provideContext(fixtureServices));
            }),
          );
        }),
      ),
    );
    it.effect('labels legacy-only and mixed contributors unsupported without loading legacy weights', () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'task-legacy-capability-'});
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const services = yield* Layer.build(storeLayer);
              return yield* Effect.gen(function* () {
                const store = yield* CodeGraphStore;
                const identity = {
                  caseMode: 'sensitive',
                  checkoutId: EffectString.repeat(64)('a'),
                  displayName: 'fixture',
                  gitCommonDirectory: root,
                  headCommit: EffectString.repeat(40)('b'),
                  objectFormat: 'sha1',
                  repoRoot: root,
                  repositoryId: EffectString.repeat(64)('c'),
                  worktreeId: EffectString.repeat(64)('d'),
                } as const;
                const span = {line: 1, column: 1, endLine: 1, endColumn: 2};
                const hash = EffectString.repeat(64)('a');
                for (const unsupported of ['both', 'current', 'base']) {
                  const databasePath = path.join(root, unsupported + '.sqlite');
                  const baseSnapshot = {
                    commit: identity.headCommit,
                    dirty: false,
                    edgeCount: 0,
                    extractorSet: 'fixture',
                    fileCount: 1,
                    id: 'cgsn_' + EffectString.repeat(40)('e'),
                    repositoryId: identity.repositoryId,
                    state: 'ready',
                    symbolCount: 1,
                    worktreeId: identity.worktreeId,
                  } as const;
                  const currentSnapshot = {
                    ...baseSnapshot,
                    id: 'cgsn_' + EffectString.repeat(40)('f'),
                    baseSnapshotId: baseSnapshot.id,
                  };
                  const symbols = EffectArray.map(['base', 'current'], (contributor, index) => ({
                    id: 'cgs_' + EffectString.padStart(32, '0')(index.toString(16)),
                    name: 'pending',
                    qualifiedName: 'pending',
                    path: contributor + '.ts',
                    contentHash: hash,
                    kind: 'function',
                    language: 'typescript',
                    exported: true,
                    span,
                  }));
                  for (const [index, snapshot] of [baseSnapshot, currentSnapshot].entries()) {
                    const symbol = symbols[index];
                    yield* store.activate(
                      databasePath,
                      identity,
                      snapshot,
                      [
                        {
                          blobId: EffectString.repeat(40)('0'),
                          path: symbol.path,
                          contentHash: hash,
                          language: 'typescript',
                          mode: '100644',
                          size: 1,
                          source: 'commit',
                        },
                      ],
                      [symbol],
                      [],
                    );
                  }
                  const db = yield* Effect.acquireRelease(
                    Effect.sync(() => new Database(databasePath)),
                    db => Effect.sync(() => db.close()),
                  );
                  db.exec('PRAGMA foreign_keys=ON');
                  // activate supplies complete views. This controlled overlay retains the base
                  // contributor instead of treating its omitted full-view entries as deletions.
                  db.query('DELETE FROM snapshot_symbol_deletions WHERE snapshot_id=?').run(currentSnapshot.id);
                  db.query('DELETE FROM snapshot_file_deletions WHERE snapshot_id=?').run(currentSnapshot.id);
                  for (const [index, snapshot] of [baseSnapshot, currentSnapshot].entries()) {
                    if (unsupported !== 'both' && unsupported !== (index === 0 ? 'base' : 'current')) continue;
                    db.query('DELETE FROM lexical_storage_formats WHERE snapshot_id=?').run(snapshot.id);
                    db.query('DELETE FROM lexical_compact_snapshots WHERE snapshot_id=?').run(snapshot.id);
                    db.query('INSERT INTO symbol_terms VALUES(?,?,?,?)').run(
                      snapshot.id,
                      'pending',
                      symbols[index].id,
                      new Uint8Array([1]),
                    );
                  }
                  const observation = {
                    repository: {repositoryId: identity.repositoryId, displayName: 'fixture'},
                    snapshot: {
                      id: currentSnapshot.id,
                      commit: currentSnapshot.commit,
                      worktreeId: currentSnapshot.worktreeId,
                      dirty: false,
                    },
                    freshness: 'current' as const,
                  };
                  const budget = {
                    remainingReads: 17,
                    remainingBytes: 4 * 1024 * 1024,
                    remainingNodes: 12,
                    remainingEdges: 1,
                    deadline: yield* makeReadDeadline(1500),
                  };
                  const acquired = yield* discoverCodeGraphTask({
                    databasePath,
                    observation,
                    task: 'pending',
                    budget,
                    depth: 0,
                  });
                  expect(acquired.evidence.gaps).toContain('task-lexical-coverage-partial');
                  for (const contributor of ['current', 'base'])
                    expect(acquired.evidence.gaps.includes(`task-${contributor}-lexical-format-unsupported`)).toBe(
                      unsupported === 'both' || unsupported === contributor,
                    );
                  expect(acquired.result.warnings).toContain('task-lexical-coverage-partial');
                  expect(budget.remainingReads).toBe(17 - acquired.evidence.counters.reads);
                  expect(budget.remainingBytes).toBe(4 * 1024 * 1024 - acquired.evidence.counters.transferredBytes);
                  if (unsupported === 'both') {
                    expect(acquired.result.nodes).toEqual([]);
                    expect(acquired.evidence.counters.reads).toBe(1);
                    expect(acquired.evidence.counters.metadataPostings).toBe(0);
                    expect(acquired.evidence.counters.bodyPostings).toBe(0);
                    expect(budget.remainingNodes).toBe(12);
                  } else {
                    expect(EffectArray.map(acquired.result.nodes, node => node.id)).toEqual([
                      symbols[unsupported === 'current' ? 0 : 1].id,
                    ]);
                  }
                  const legacyRoot = db
                    .query<{rootpage: number}, []>("SELECT rootpage FROM sqlite_schema WHERE name='symbol_terms'")
                    .get()!.rootpage;
                  for (const statement of [
                    taskHeaderStatement(currentSnapshot.id),
                    taskPostingStatement(currentSnapshot.id, baseSnapshot.id, ['pending'], 128),
                  ]) {
                    const bytecode = db
                      .query<{opcode: string; p2: number}, (string | number)[]>('EXPLAIN ' + statement.text)
                      .all(...statement.parameters);
                    expect(EffectArray.some(bytecode, op => op.opcode === 'OpenRead' && op.p2 === legacyRoot)).toBe(
                      false,
                    );
                  }
                }
              }).pipe(Effect.provideContext(services));
            }),
          );
        }),
      ),
    );
    for (const oracle of frozen)
      it.effect(
        `acquires ${oracle.id} through real full/cache/spool and reserves its caller outside seeds`,
        () =>
          TestClock.withLive(
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              const root = yield* fs.makeTempDirectoryScoped({prefix: 'task-body-acquisition-'});
              return yield* Effect.scoped(
                Effect.gen(function* () {
                  const fixtureServices = yield* Layer.build(dependencies);
                  return yield* Effect.gen(function* () {
                    const cwd = path.join(root, 'repo');
                    const home = path.join(root, 'home');
                    yield* fs.makeDirectory(cwd);
                    yield* fs.makeDirectory(home);
                    yield* fs.makeDirectory(path.join(cwd, 'decoys'));
                    const git = (args: readonly string[]) => runCommandEffect('git', ['-C', cwd, ...args]);
                    yield* git(['init', '--quiet']);
                    expect(sha256HexSync(oracle.sourceText)).toBe(oracle.sourceSha256);
                    yield* fs.writeFileString(path.join(cwd, oracle.path), oracle.sourceText);
                    for (let j = 0; j < 128; j += 1) {
                      const n = EffectString.padStart(3, '0')(j.toString());
                      const text =
                        oracle.language === 'ts'
                          ? `/** Which routine repeatedly collects pending items? Where is text appended to a journal file? */\nexport function constant${n}() { return ${j}; }\n`
                          : `# Which routine repeatedly collects pending items? Where is text appended to a journal file?\ndef constant${n}():\n    return ${j}\n`;
                      expect(sha256HexSync(text)).toBe(decoyHashes[(oracle.language === 'ts' ? 0 : 128) + j]);
                      yield* fs.writeFileString(
                        path.join(
                          cwd,
                          'decoys',
                          `decoy-${EffectString.padStart(3, '0')((j + (oracle.language === 'ts' ? 0 : 128)).toString())}.${oracle.language}`,
                        ),
                        text,
                      );
                    }
                    yield* fs.writeFileString(
                      path.join(cwd, `unrelated.${oracle.language}`),
                      oracle.language === 'ts' ? 'export const z = 0;' : 'z = 0',
                    );
                    yield* git(['add', '.']);
                    yield* git([
                      '-c',
                      'user.name=Fixture',
                      '-c',
                      'user.email=fixture@example.invalid',
                      '-c',
                      'core.hooksPath=/dev/null',
                      '-c',
                      'commit.gpgsign=false',
                      'commit',
                      '-qm',
                      'frozen oracle',
                    ]);
                    const store = yield* CodeGraphStore;
                    const staged = vi.spyOn(store, 'stageActivationFactBatches');
                    yield* Effect.addFinalizer(() => Effect.sync(() => staged.mockRestore()));
                    const context = yield* Layer.build(CodeGraphIndexer.layer);
                    const indexer = Context.get(context, CodeGraphIndexer);
                    const summary = yield* indexer.index({
                      cwd,
                      threadnoteHome: home,
                      sourceOnly: true,
                      vectorPolicy: 'off',
                    });
                    const layout = codeGraphLayout(
                      path,
                      home,
                      summary.identity.checkoutId,
                      summary.identity.worktreeId,
                    );
                    const observe = (summary: CodeGraphIndexSummary) => ({
                      repository: {
                        repositoryId: summary.identity.repositoryId,
                        displayName: summary.identity.displayName,
                      },
                      snapshot: {
                        id: summary.snapshot.id,
                        commit: summary.snapshot.commit,
                        worktreeId: summary.snapshot.worktreeId,
                        dirty: summary.snapshot.dirty,
                      },
                      freshness: 'current' as const,
                    });
                    const discover = (current: CodeGraphIndexSummary, depth: 0 | 1 | 2 = 1, nodes = 12, edges = 1) =>
                      Effect.gen(function* () {
                        const budget: TaskDiscoveryBudget = {
                          remainingReads: 17,
                          remainingBytes: 1024 * 1024,
                          remainingNodes: nodes,
                          remainingEdges: edges,
                          deadline: yield* makeReadDeadline(1500),
                        };
                        const acquired = yield* discoverCodeGraphTask({
                          databasePath: layout.databasePath,
                          observation: observe(current),
                          task: oracle.naturalBehaviorPrompt,
                          budget,
                          depth,
                        });
                        expect(budget.remainingReads).toBeGreaterThanOrEqual(0);
                        expect(budget.remainingBytes).toBeGreaterThanOrEqual(0);
                        expect(acquired.evidence.counters.metadataPostings).toBeLessThanOrEqual(128);
                        expect(acquired.evidence.counters.bodyPostings).toBeLessThanOrEqual(128);
                        return acquired;
                      });
                    const ordinary = yield* store.searchSymbols(
                      layout.databasePath,
                      summary.snapshot.id,
                      oracle.naturalBehaviorPrompt,
                      12,
                    );
                    expect(ordinary).toHaveLength(12);
                    expect(EffectArray.every(ordinary, node => node.name !== 'f' && node.name !== 'g')).toBe(true);
                    const first = yield* discover(summary);
                    const owner = first.result.nodes[0];
                    expect(owner, JSON.stringify(first)).toMatchObject({
                      path: oracle.path,
                      name: 'f',
                      span: {
                        line: oracle.expectedOwner.span.startLine,
                        column: oracle.expectedOwner.span.startColumn,
                        endLine: oracle.expectedOwner.span.endLine,
                        endColumn: oracle.expectedOwner.span.endColumn,
                      },
                    });
                    const caller = EffectOption.getOrUndefined(
                      EffectArray.findFirst(first.result.nodes, node => node.path === oracle.path && node.name === 'g'),
                    );
                    expect(caller, JSON.stringify(first)).toMatchObject({
                      span: {
                        line: oracle.expectedNeighbor.span.startLine,
                        endLine: oracle.expectedNeighbor.span.endLine,
                      },
                    });
                    expect(first.evidence.seedIds).not.toContain(caller!.id);
                    expect(
                      EffectArray.some(
                        first.result.edges,
                        edge => edge.sourceId === caller!.id && edge.targetId === owner.id && edge.relation === 'calls',
                      ),
                    ).toBe(true);
                    expect(first.evidence.vector.ran).toBe(false);
                    expect(first.result.nodes).toHaveLength(7);
                    expect(JSON.stringify(first.result)).not.toMatch(/bodyDiscovery|workBytes|~body/);
                    const db = yield* Effect.acquireRelease(
                      Effect.sync(() => new Database(layout.databasePath, {readonly: true})),
                      db => Effect.sync(() => db.close()),
                    );
                    const plan = taskPostingStatement(
                      summary.snapshot.id,
                      undefined,
                      [BODY_DISCOVERY_PREFIX + 'pending'],
                      32,
                    );
                    const explain = EffectArray.join(
                      EffectArray.map(
                        db
                          .query<{detail: string}, (string | number)[]>(`EXPLAIN QUERY PLAN ${plan.text}`)
                          .all(...plan.parameters),
                        row => row.detail,
                      ),
                      '\n',
                    );
                    const saturated = taskPostingStatement(summary.snapshot.id, undefined, ['pending'], 128);
                    expect(db.query(saturated.text).all(...saturated.parameters)).toHaveLength(128);
                    expect(explain).toContain('MATERIALIZE raw');
                    expect(explain).toContain('SEARCH posting USING PRIMARY KEY');
                    expect(explain).not.toMatch(/USE TEMP B-TREE FOR (GROUP BY|ORDER BY)/);
                    const facts = EffectArray.map(
                      db
                        .query<{facts_json: string}, [string]>('SELECT facts_json FROM file_blobs WHERE path_hint = ?')
                        .all(oracle.path),
                      row => decodeStoredCodeGraphFact(row.facts_json).facts,
                    );
                    const privateBody = EffectOption.getOrUndefined(
                      EffectArray.findFirst(facts, fact =>
                        EffectArray.some(
                          fact.derivationInputs?.bodyDiscovery?.records ?? [],
                          record => record.ownerId === owner.id,
                        ),
                      ),
                    )!.derivationInputs!.bodyDiscovery!;
                    expect(
                      EffectOption.getOrUndefined(
                        EffectArray.findFirst(privateBody.records, record => record.ownerId === owner.id),
                      )!.terms,
                    ).toEqual(
                      expect.arrayContaining(
                        EffectString.startsWith('a.')(oracle.path)
                          ? ['pending', 'items']
                          : ['appended', 'journal', 'text'],
                      ),
                    );
                    expect(privateBody.workBytes).toBeLessThanOrEqual(65_536);
                    let stagedBody: CodeGraphBodyDiscovery | undefined;
                    for (const call of staged.mock.calls)
                      for (const batch of call[1])
                        for (const body of batch.bodyDiscovery ?? []) if (body.path === oracle.path) stagedBody = body;
                    expect(stagedBody).toEqual(privateBody);
                    const postingCount = (snapshot: string) =>
                      Effect.acquireUseRelease(
                        Effect.sync(() => new Database(layout.databasePath, {readonly: true})),
                        fresh =>
                          Effect.sync(() =>
                            Number(
                              fresh
                                .query<{count: number}, [string]>(
                                  'SELECT COUNT(*) AS count FROM lexical_compact_postings AS p JOIN lexical_compact_snapshots AS s ON s.snapshot_key=p.snapshot_key WHERE s.snapshot_id=?',
                                )
                                .get(snapshot)!.count,
                            ),
                          ),
                        fresh => Effect.sync(() => fresh.close()),
                      );
                    const firstPostingCount = yield* postingCount(summary.snapshot.id);
                    const firstStageCount = staged.mock.calls.length;
                    const replay = yield* indexer.index({
                      cwd,
                      threadnoteHome: home,
                      sourceOnly: true,
                      vectorPolicy: 'off',
                      force: true,
                    });
                    const replayResult = yield* discover(replay);
                    expect(EffectArray.map(replayResult.result.nodes, node => node.id)).toEqual(
                      EffectArray.map(first.result.nodes, node => node.id),
                    );
                    expect(
                      yield* postingCount(replay.snapshot.id),
                      JSON.stringify({snapshot: replay.snapshot, stages: staged.mock.calls.length}),
                    ).toBe(firstPostingCount);
                    expect(staged.mock.calls.length).toBeGreaterThan(firstStageCount);
                    yield* fs.writeFileString(
                      path.join(cwd, `unrelated.${oracle.language}`),
                      oracle.language === 'ts' ? 'export const z = 1;' : 'z = 1',
                    );
                    const inherited = yield* indexer.index({
                      cwd,
                      threadnoteHome: home,
                      sourceOnly: true,
                      vectorPolicy: 'off',
                    });
                    expect(inherited.materialization?.mode, JSON.stringify(inherited.materialization)).toBe(
                      'incremental-overlay',
                    );
                    expect((yield* discover(inherited)).result.nodes[0]).toMatchObject({
                      id: owner.id,
                      contentHash: owner.contentHash,
                    });
                    // A one-file body change goes through ordinary incremental preparation; then deletion/rename suppress inherited postings.
                    const changed = EffectString.replace(
                      EffectString.startsWith('a.')(oracle.path) ? 'collector pending items' : 'appended journal text',
                      'unrelated phrase',
                    )(oracle.sourceText);
                    yield* fs.writeFileString(path.join(cwd, oracle.path), changed);
                    const incremental = yield* indexer.index({
                      cwd,
                      threadnoteHome: home,
                      sourceOnly: true,
                      vectorPolicy: 'off',
                    });
                    const changedResult = yield* discover(incremental);
                    const changedBody = EffectOption.getOrUndefined(
                      EffectArray.findFirst(
                        changedResult.evidence.candidates,
                        candidate => candidate.id === owner.id && candidate.origin === 'body',
                      ),
                    );
                    expect(changedBody?.score ?? 0).toBeLessThan(
                      EffectOption.getOrUndefined(
                        EffectArray.findFirst(first.evidence.candidates, candidate => candidate.id === owner.id),
                      )!.score,
                    );
                    yield* fs.remove(path.join(cwd, oracle.path));
                    const deleted = yield* indexer.index({
                      cwd,
                      threadnoteHome: home,
                      sourceOnly: true,
                      vectorPolicy: 'off',
                    });
                    expect(
                      EffectArray.some((yield* discover(deleted)).result.nodes, node => node.path === oracle.path),
                    ).toBe(false);
                    yield* fs.writeFileString(path.join(cwd, `renamed.${oracle.language}`), oracle.sourceText);
                    const renamed = yield* indexer.index({
                      cwd,
                      threadnoteHome: home,
                      sourceOnly: true,
                      vectorPolicy: 'off',
                    });
                    const renamedResult = yield* discover(renamed);
                    expect(renamedResult.result.nodes[0]).toMatchObject({
                      path: `renamed.${oracle.language}`,
                      name: 'f',
                    });
                    expect(EffectArray.some(renamedResult.result.nodes, node => node.path === oracle.path)).toBe(false);
                    const clean = yield* indexer.index({
                      cwd,
                      threadnoteHome: home,
                      sourceOnly: true,
                      vectorPolicy: 'off',
                      force: true,
                    });
                    expect(
                      EffectArray.map((yield* discover(clean)).result.nodes, node => [
                        node.id,
                        node.path,
                        node.contentHash,
                      ]),
                    ).toEqual(
                      EffectArray.map(renamedResult.result.nodes, node => [node.id, node.path, node.contentHash]),
                    );
                  }).pipe(Effect.provideContext(fixtureServices));
                }),
              );
            }),
          ),
        30000,
      );
  });
});

plainIt('refuses oversized persisted scalars in native SQL before returning bounded JS rows', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE snapshots(id TEXT PRIMARY KEY,repository_id TEXT,worktree_id TEXT,commit_id TEXT,dirty INTEGER CHECK(dirty IN(0,1)),base_snapshot_id TEXT,state TEXT);
      CREATE TABLE lexical_storage_formats(snapshot_id TEXT PRIMARY KEY,format_version INTEGER CHECK(format_version=1));
      CREATE TABLE symbols(snapshot_id TEXT,id TEXT,content_hash TEXT,kind TEXT,language TEXT,name TEXT,qualified_name TEXT,path TEXT,span_json TEXT,package_name TEXT,resolution_domain TEXT,resolution_scope_id TEXT,arity INTEGER,exported INTEGER CHECK(exported IN(0,1)),PRIMARY KEY(snapshot_id,id));
      CREATE TABLE edges(snapshot_id TEXT,id TEXT,confidence REAL CHECK(confidence>=0 AND confidence<=1),provenance TEXT,relation TEXT,source_id TEXT,target_id TEXT,evidence_path TEXT,source_name TEXT,target_name TEXT,evidence_span_json TEXT,PRIMARY KEY(snapshot_id,id));
      CREATE INDEX edges_source ON edges(snapshot_id,source_id,relation);CREATE INDEX edges_target_resolved ON edges(snapshot_id,target_id,relation) WHERE target_id IS NOT NULL;
      CREATE TABLE snapshot_edge_deletions(snapshot_id TEXT,edge_id TEXT,PRIMARY KEY(snapshot_id,edge_id));CREATE TABLE snapshot_symbol_deletions(snapshot_id TEXT,symbol_id TEXT,PRIMARY KEY(snapshot_id,symbol_id));`);
    const id = 'cgs_' + EffectString.repeat(32)('0');
    const other = 'cgs_' + EffectString.repeat(32)('1');
    const huge = EffectString.repeat(262144)('x');
    const span = JSON.stringify({line: 1, column: 1, endLine: 1, endColumn: 2});
    db.query('INSERT INTO snapshots VALUES(?,?,?,?,?,?,?)').run('snap', 'r', 'w', 'c', 0, null, 'ready');
    for (const owner of [id, other])
      db.query('INSERT INTO symbols VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        'snap',
        owner,
        EffectString.repeat(64)('a'),
        'function',
        'typescript',
        'f',
        'f',
        'a.ts',
        span,
        null,
        null,
        null,
        1,
        1,
      );
    db.query('INSERT INTO edges VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
      'snap',
      'cge_' + EffectString.repeat(32)('0'),
      1,
      huge,
      'calls',
      other,
      id,
      'a.ts',
      'g',
      'f',
      span,
    );
    const edgeQuery = taskExpansionStatement('snap', undefined, [id], 1);
    const edgeRows = db.query(edgeQuery.text).all(...edgeQuery.parameters);
    expect(edgeRows).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(edgeRows))).toBeLessThanOrEqual(32768);
    expect(edgeRows[0]).toMatchObject({provenance: null, row_valid: 0, transfer_valid: 1});
    for (const field of ['arity', 'content_hash']) {
      db.query(`UPDATE symbols SET ${field}=? WHERE id=?`).run(huge, other);
      const nodeQuery = taskNodeStatement('snap', undefined, [other]);
      const rows = db.query(nodeQuery.text).all(...nodeQuery.parameters);
      expect(rows).toHaveLength(1);
      expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThanOrEqual(32768);
      expect(rows[0]).toMatchObject({[field]: null, row_valid: 0, transfer_valid: 1});
      db.query(`UPDATE symbols SET ${field}=? WHERE id=?`).run(
        field === 'arity' ? 1 : EffectString.repeat(64)('a'),
        other,
      );
    }
    for (const field of ['repository_id', 'worktree_id', 'commit_id', 'base_snapshot_id']) {
      db.query(`UPDATE snapshots SET ${field}=?`).run(huge);
      const headerQuery = taskHeaderStatement('snap');
      const rows = db.query(headerQuery.text).all(...headerQuery.parameters);
      expect(rows).toHaveLength(1);
      expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThanOrEqual(4096);
      expect(rows[0]).toMatchObject({[field]: null, row_valid: 0, transfer_valid: 1});
      db.query(`UPDATE snapshots SET ${field}=?`).run(field === 'base_snapshot_id' ? null : 'valid');
    }
  } finally {
    db.close();
  }
});
