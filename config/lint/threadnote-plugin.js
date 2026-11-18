const NODE_EFFECT_PACKAGES = new Set(['@effect/platform-node', '@effect/sql-sqlite-node']);
const EFFECT_RUNNER = /^run(?:Callback|Fork|Promise|Sync)(?:Exit|With)?$/;

export function isNodeEffectPackageSpecifier(specifier) {
  for (const packageName of NODE_EFFECT_PACKAGES) {
    if (specifier === packageName || specifier.startsWith(`${packageName}/`)) return true;
  }
  return false;
}

export function isEffectRuntimeMember(objectName, memberName) {
  if (objectName === 'Effect') return EFFECT_RUNNER.test(memberName);
  if (objectName === 'Runtime')
    return EFFECT_RUNNER.test(memberName) || memberName === 'make' || memberName === 'makeRunMain';
  if (objectName === 'ManagedRuntime') return memberName === 'make' || EFFECT_RUNNER.test(memberName);
  return objectName === 'BunRuntime' && memberName === 'runMain';
}

function stringValue(node) {
  return node && typeof node.value === 'string' ? node.value : undefined;
}

function memberName(member) {
  if (!member.computed && member.property.type === 'Identifier') return member.property.name;
  return stringValue(member.property);
}

function runtimeObjectForImport(source, importedName) {
  if (source === 'effect') {
    return importedName === 'Effect' || importedName === 'ManagedRuntime' || importedName === 'Runtime'
      ? importedName
      : undefined;
  }
  if (source === 'effect/Effect') return 'Effect';
  if (source === 'effect/ManagedRuntime') return 'ManagedRuntime';
  if (source === 'effect/Runtime') return 'Runtime';
  if (source === '@effect/platform-bun/BunRuntime') return 'BunRuntime';
  return undefined;
}

function makeNoEffectRuntimeRule(message) {
  return {
    meta: {
      type: 'problem',
      docs: {description: message},
      messages: {forbidden: message},
      schema: [],
    },
    create(context) {
      const runtimeObjects = new Map();

      return {
        ImportDeclaration(node) {
          const source = stringValue(node.source);
          if (!source) return;

          for (const specifier of node.specifiers) {
            if (specifier.type === 'ImportNamespaceSpecifier' || specifier.type === 'ImportDefaultSpecifier') {
              const objectName = runtimeObjectForImport(source);
              if (objectName) runtimeObjects.set(specifier.local.name, objectName);
              continue;
            }
            if (specifier.type !== 'ImportSpecifier') continue;
            const importedName =
              specifier.imported.type === 'Identifier' ? specifier.imported.name : stringValue(specifier.imported);
            if (!importedName) continue;
            const objectName = runtimeObjectForImport(source, importedName);
            if (objectName) runtimeObjects.set(specifier.local.name, objectName);
            if (source === 'effect/Effect' && EFFECT_RUNNER.test(importedName)) {
              context.report({node: specifier, messageId: 'forbidden'});
            }
          }
        },
        MemberExpression(node) {
          if (node.object.type !== 'Identifier') return;
          const propertyName = memberName(node);
          const objectName = runtimeObjects.get(node.object.name);
          if (
            propertyName &&
            (EFFECT_RUNNER.test(propertyName) || (objectName && isEffectRuntimeMember(objectName, propertyName)))
          ) {
            context.report({node, messageId: 'forbidden'});
          }
        },
      };
    },
  };
}

const noNodeRuntime = {
  meta: {
    type: 'problem',
    docs: {description: 'Use Bun Effect platform packages instead of Node-specific Effect packages.'},
    messages: {forbidden: 'Use the Bun Effect platform package instead of Node-specific Effect package {{specifier}}.'},
    schema: [],
  },
  create(context) {
    const reportSource = sourceNode => {
      const specifier = stringValue(sourceNode);
      if (specifier && isNodeEffectPackageSpecifier(specifier)) {
        context.report({node: sourceNode, messageId: 'forbidden', data: {specifier}});
      }
    };

    return {
      ImportDeclaration: node => reportSource(node.source),
      ExportAllDeclaration: node => reportSource(node.source),
      ExportNamedDeclaration: node => reportSource(node.source),
      ImportExpression: node => reportSource(node.source),
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments.length > 0) {
          reportSource(node.arguments[0]);
        }
      },
    };
  },
};

export default {
  meta: {name: 'threadnote'},
  rules: {
    'no-effect-runtime': makeNoEffectRuntimeRule(
      'Compose and return the Effect; only apps/threadnote/src/standalone.ts may execute or construct an Effect runtime.',
    ),
    'no-effect-runtime-in-tests': makeNoEffectRuntimeRule(
      'Return the Effect from @effect/vitest it.effect (already scoped) instead of converting it to a Promise or running it synchronously.',
    ),
    'no-node-runtime': noNodeRuntime,
  },
};
