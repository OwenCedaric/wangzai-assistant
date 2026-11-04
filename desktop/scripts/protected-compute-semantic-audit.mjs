import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { extractFile, listPackage } from '@electron/asar';
import { Parser } from 'acorn';
import jsx from 'acorn-jsx';

const JavaScriptParser = Parser.extend(jsx());

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.cache',
  '.pytest_cache',
  '.ruff_cache',
  'node_modules',
  '__pycache__',
]);
const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs']);
const SOURCE_MAP_EXTENSION = '.map';
const HTML_EXTENSIONS = new Set(['.html', '.htm']);
const WASM_EXTENSION = '.wasm';
const MAX_ALIAS_DEPTH = 64;
const MAX_INLINE_SOURCE_MAP_DEPTH = 4;
const PRICING_SCALES = new Set([100, 10_000]);
const PROFITABILITY_THRESHOLDS = Object.freeze([450, 1_250, 2_100]);
const INLINE_SOURCE_MAP_PATTERN = /sourceMappingURL\s*=\s*(data:application\/json(?:;charset=[^;,\s*]+)?(?:;base64)?,[^\s*]+)/giu;

function isTestFixturePath(file) {
  return /(?:^|[\\/])(?:__tests__|test|tests|fixture|fixtures)(?:[\\/]|$)|\.(?:test|spec)\.[^.]+$/iu.test(
    file,
  );
}

function isFunctionNode(nodeValue) {
  return ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(
    nodeValue?.type,
  );
}

function numericValue(nodeValue) {
  if (
    nodeValue?.type === 'Literal'
    && typeof nodeValue.value === 'number'
    && Number.isFinite(nodeValue.value)
  ) {
    return nodeValue.value;
  }
  if (nodeValue?.type === 'UnaryExpression' && ['+', '-'].includes(nodeValue.operator)) {
    const value = numericValue(nodeValue.argument);
    if (value !== null) return nodeValue.operator === '-' ? -value : value;
  }
  if (nodeValue?.type === 'BinaryExpression') {
    const left = numericValue(nodeValue.left);
    const right = numericValue(nodeValue.right);
    if (left === null || right === null) return null;
    if (nodeValue.operator === '+') return left + right;
    if (nodeValue.operator === '-') return left - right;
    if (nodeValue.operator === '*') return left * right;
    if (nodeValue.operator === '/' && right !== 0) return left / right;
    if (nodeValue.operator === '%' && right !== 0) return left % right;
    if (nodeValue.operator === '**') {
      const value = left ** right;
      return Number.isFinite(value) ? value : null;
    }
  }
  return null;
}

function isNullishNode(nodeValue) {
  return (
    nodeValue == null
    || (nodeValue.type === 'Literal' && nodeValue.value == null)
    || (nodeValue.type === 'Identifier' && nodeValue.name === 'undefined')
    || (nodeValue.type === 'UnaryExpression' && nodeValue.operator === 'void')
  );
}

function staticStringValue(nodeValue) {
  if (nodeValue?.type === 'Literal' && typeof nodeValue.value === 'string') {
    return nodeValue.value;
  }
  if (
    nodeValue?.type === 'TemplateLiteral'
    && nodeValue.expressions.length === 0
    && nodeValue.quasis.length === 1
  ) {
    return nodeValue.quasis[0].value.cooked ?? nodeValue.quasis[0].value.raw;
  }
  if (nodeValue?.type === 'BinaryExpression' && nodeValue.operator === '+') {
    const left = staticStringValue(nodeValue.left);
    const right = staticStringValue(nodeValue.right);
    return left === null || right === null ? null : `${left}${right}`;
  }
  return null;
}

function memberName(nodeValue) {
  if (!nodeValue) return '';
  if (nodeValue.type === 'Identifier') return nodeValue.name;
  if (
    nodeValue.type !== 'MemberExpression'
    && nodeValue.type !== 'OptionalMemberExpression'
  ) {
    return '';
  }
  const object = memberName(nodeValue.object);
  const property = nodeValue.computed
    ? staticStringValue(nodeValue.property)
    : memberName(nodeValue.property);
  return object && property ? `${object}.${property}` : property || object;
}

const stableNodeFingerprintCache = new WeakMap();

function stableNode(value) {
  if (value === null) return 'null';
  const valueType = typeof value;
  if (valueType !== 'object') {
    if (valueType === 'number' && Number.isNaN(value)) return 'number:NaN';
    return `${valueType}:${String(value)}`;
  }
  const cached = stableNodeFingerprintCache.get(value);
  if (cached) return cached;

  const hash = createHash('sha256');
  const append = (part) => {
    const text = String(part);
    hash.update(String(Buffer.byteLength(text, 'utf8')));
    hash.update(':');
    hash.update(text);
  };
  if (Array.isArray(value)) {
    append('array');
    append(value.length);
    for (const item of value) append(stableNode(item));
  } else {
    append('object');
    const keys = Object.keys(value).sort();
    append(keys.length);
    for (const key of keys) {
      append(key);
      append(stableNode(value[key]));
    }
  }
  const fingerprint = `sha256:${hash.digest('hex')}`;
  stableNodeFingerprintCache.set(value, fingerprint);
  return fingerprint;
}

function num(value) {
  return Object.freeze({ op: 'num', value });
}

function sym(value) {
  return Object.freeze({ op: 'sym', value });
}

function semanticNode(op, args) {
  return Object.freeze({ op, args: Object.freeze(args) });
}

function normalizedCommutative(op, args) {
  const flattened = [];
  for (const argument of args) {
    if (argument?.op === op) flattened.push(...argument.args);
    else flattened.push(argument);
  }

  const numeric = flattened.filter((argument) => argument?.op === 'num');
  const symbolic = flattened.filter((argument) => argument?.op !== 'num');
  if (op === 'add') {
    const total = numeric.reduce((sum, argument) => sum + argument.value, 0);
    if (total !== 0 || symbolic.length === 0) symbolic.push(num(total));
  } else if (op === 'mul') {
    const product = numeric.reduce((result, argument) => result * argument.value, 1);
    if (product === 0) return num(0);
    if (product !== 1 || symbolic.length === 0) symbolic.push(num(product));
  }
  if (symbolic.length === 1) return symbolic[0];
  symbolic.sort((left, right) => stableNode(left).localeCompare(stableNode(right)));
  return semanticNode(op, symbolic);
}

function withoutFactor(candidate, factor) {
  const expected = stableNode(factor);
  const values = candidate?.op === 'mul' ? [...candidate.args] : [candidate];
  const index = values.findIndex((value) => stableNode(value) === expected);
  if (index < 0) return null;
  values.splice(index, 1);
  if (!values.length) return num(1);
  if (values.length === 1) return values[0];
  return normalizedCommutative('mul', values);
}

function withoutAddend(candidate, addend) {
  if (candidate?.op !== 'add') return null;
  const expected = stableNode(addend);
  const values = [...candidate.args];
  const index = values.findIndex((value) => stableNode(value) === expected);
  if (index < 0) return null;
  values.splice(index, 1);
  if (!values.length) return num(0);
  if (values.length === 1) return values[0];
  return normalizedCommutative('add', values);
}

function canonicalizeRoundedRatio(candidate) {
  if (candidate?.op !== 'div' || candidate.args.length !== 2) return candidate;
  const [top, denominator] = candidate.args;
  if (top?.op === 'sub' && top.args.length === 2 && isNumber(top.args[1], 1)) {
    const numerator = withoutAddend(top.args[0], denominator);
    if (numerator) return semanticNode('div', [numerator, denominator]);
  }
  if (top?.op === 'add') {
    const withoutDenominator = withoutAddend(top, denominator);
    const numerator = withoutDenominator && withoutAddend(withoutDenominator, num(-1));
    if (numerator) return semanticNode('div', [numerator, denominator]);
  }
  return candidate;
}

function forEachAstChild(nodeValue, visitor) {
  if (!nodeValue || typeof nodeValue !== 'object') return;
  for (const [key, value] of Object.entries(nodeValue)) {
    if (['start', 'end', 'loc', 'range'].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object') visitor(item);
      }
    } else if (value && typeof value === 'object') {
      visitor(value);
    }
  }
}

function walk(nodeValue, visitor, { skipNestedFunctions = false, rootFunction = null } = {}) {
  if (!nodeValue || typeof nodeValue !== 'object') return;
  if (
    skipNestedFunctions
    && rootFunction
    && nodeValue !== rootFunction
    && isFunctionNode(nodeValue)
  ) {
    return;
  }
  visitor(nodeValue);
  forEachAstChild(nodeValue, (child) => {
    walk(child, visitor, { skipNestedFunctions, rootFunction });
  });
}

function parameterName(parameter) {
  if (parameter?.type === 'Identifier') return parameter.name;
  if (parameter?.type === 'AssignmentPattern' && parameter.left?.type === 'Identifier') {
    return parameter.left.name;
  }
  if (parameter?.type === 'RestElement' && parameter.argument?.type === 'Identifier') {
    return parameter.argument.name;
  }
  return '';
}

function discoverScopes(ast) {
  const scopes = [];
  const scopeByNode = new WeakMap();
  const createScope = (type, nodeValue, parent) => {
    const scope = {
      id: scopes.length,
      type,
      node: nodeValue,
      parent,
      bindings: new Map(),
      functionBindings: new Map(),
      parameterIndexes: new Map(),
      expressions: [],
      identifiers: new Set(),
      operators: new Set(),
      staticNumbers: new Set(),
      hasCall: false,
    };
    scopes.push(scope);
    scopeByNode.set(nodeValue, scope);
    if (isFunctionNode(nodeValue)) {
      for (const [index, parameter] of nodeValue.params.entries()) {
        const name = parameterName(parameter);
        if (name) scope.parameterIndexes.set(name, index);
      }
      if (nodeValue.type === 'FunctionExpression' && nodeValue.id?.name) {
        scope.functionBindings.set(nodeValue.id.name, nodeValue);
      }
    }
    return scope;
  };

  const program = createScope('Program', ast, null);
  const discoverChildren = (nodeValue, parentScope) => {
    forEachAstChild(nodeValue, (child) => {
      if (isFunctionNode(child)) {
        if (child.type === 'FunctionDeclaration' && child.id?.name) {
          parentScope.functionBindings.set(child.id.name, child);
        }
        const childScope = createScope(child.type, child, parentScope);
        discoverChildren(child, childScope);
      } else {
        discoverChildren(child, parentScope);
      }
    });
  };
  discoverChildren(ast, program);

  const addBinding = (scope, name, expression) => {
    if (!name || !expression) return;
    const values = scope.bindings.get(name) || [];
    values.push(expression);
    scope.bindings.set(name, values);
  };

  for (const scope of scopes) {
    if (
      scope.node.type === 'ArrowFunctionExpression'
      && scope.node.body?.type !== 'BlockStatement'
    ) {
      scope.expressions.push(scope.node.body);
    }
    for (const parameter of scope.node.params || []) {
      if (parameter?.type === 'AssignmentPattern' && parameter.right) {
        scope.expressions.push(parameter.right);
      }
    }
    walk(
      scope.node,
      (candidate) => {
        if (candidate.type === 'Identifier') scope.identifiers.add(candidate.name);
        if (candidate.type === 'BinaryExpression') {
          scope.operators.add(candidate.operator);
          const value = numericValue(candidate);
          if (value !== null) scope.staticNumbers.add(value);
        }
        if (candidate.type === 'Literal' && typeof candidate.value === 'number') {
          scope.staticNumbers.add(candidate.value);
        }
        if (candidate.type === 'CallExpression' || candidate.type === 'NewExpression') {
          scope.hasCall = true;
        }
        if (candidate.type === 'VariableDeclarator' && candidate.id?.type === 'Identifier') {
          if (isFunctionNode(candidate.init)) {
            scope.functionBindings.set(candidate.id.name, candidate.init);
          } else {
            addBinding(scope, candidate.id.name, candidate.init);
            if (candidate.init) scope.expressions.push(candidate.init);
          }
        }
        if (candidate.type === 'AssignmentExpression') {
          if (candidate.left?.type === 'Identifier') {
            addBinding(scope, candidate.left.name, candidate.right);
          }
          if (candidate.right) scope.expressions.push(candidate.right);
        }
        if (candidate.type === 'ReturnStatement' && candidate.argument) {
          scope.expressions.push(candidate.argument);
        }
        if (candidate.type === 'ExpressionStatement' && candidate.expression) {
          scope.expressions.push(candidate.expression);
        }
      },
      { skipNestedFunctions: true, rootFunction: scope.node },
    );
  }

  return { scopes, scopeByNode };
}

function functionReturnExpression(functionNode) {
  if (functionNode?.type === 'ArrowFunctionExpression' && functionNode.body.type !== 'BlockStatement') {
    return functionNode.body;
  }
  const returns = [];
  walk(
    functionNode?.body,
    (candidate) => {
      if (candidate.type === 'ReturnStatement' && candidate.argument) returns.push(candidate.argument);
    },
    { skipNestedFunctions: true, rootFunction: functionNode },
  );
  return returns.length === 1 ? returns[0] : null;
}

function resolveStaticBinding(scope, name) {
  for (let current = scope; current; current = current.parent) {
    if (current.parameterIndexes.has(name)) return null;
    const candidates = current.bindings.get(name) || [];
    if (candidates.length) return { scope: current, expression: candidates.at(-1) };
  }
  return null;
}

function evaluateStaticNumber(expression, scope, stack = new Set(), depth = 0) {
  if (!expression || depth > MAX_ALIAS_DEPTH) return null;
  const direct = numericValue(expression);
  if (direct !== null) return direct;
  if (expression.type !== 'Identifier') return null;
  const resolved = resolveStaticBinding(scope, expression.name);
  if (!resolved) return null;
  const key = `${resolved.scope.id}:${expression.name}`;
  if (stack.has(key)) return null;
  return evaluateStaticNumber(
    resolved.expression,
    resolved.scope,
    new Set(stack).add(key),
    depth + 1,
  );
}

function scopeHasProtectedScale(scope) {
  if ([...scope.staticNumbers].some((value) => PRICING_SCALES.has(value))) return true;
  for (const name of scope.identifiers) {
    const value = evaluateStaticNumber({ type: 'Identifier', name }, scope);
    if (PRICING_SCALES.has(value)) return true;
  }
  return false;
}

function scopeMayContainProtectedFormula(scope) {
  return (
    scopeHasProtectedScale(scope)
    && scope.operators.has('*')
    && scope.operators.has('-')
    && (scope.operators.has('/') || scope.hasCall)
  );
}

function expressionHasFormulaArithmetic(expression) {
  let found = false;
  walk(
    expression,
    (candidate) => {
      if (
        candidate.type === 'BinaryExpression'
        && ['*', '/', '-'].includes(candidate.operator)
      ) {
        found = true;
      }
    },
    { skipNestedFunctions: true, rootFunction: expression },
  );
  return found;
}

function createNormalizer(scopeModel) {
  const bindingMemo = new Map();

  const resolveBinding = (scope, name) => {
    for (let current = scope; current; current = current.parent) {
      const candidates = current.bindings.get(name) || [];
      if (candidates.length) {
        return { scope: current, expression: candidates.at(-1) };
      }
      if (current.parameterIndexes.has(name)) return null;
    }
    return null;
  };

  const resolveFunction = (scope, name) => {
    for (let current = scope; current; current = current.parent) {
      const functionNode = current.functionBindings.get(name);
      if (functionNode) return functionNode;
    }
    return null;
  };

  const normalize = (
    expression,
    scope,
    {
      overrides = null,
      identifierStack = new Set(),
      helperStack = new Set(),
      depth = 0,
    } = {},
  ) => {
    if (!expression || depth > MAX_ALIAS_DEPTH) return sym('unknown');
    const next = (candidate, nextScope = scope, extra = {}) => normalize(candidate, nextScope, {
      overrides,
      identifierStack,
      helperStack,
      depth: depth + 1,
      ...extra,
    });
    if (expression.type === 'ChainExpression') return next(expression.expression);
    if (expression.type === 'ParenthesizedExpression') return next(expression.expression);
    if (expression.type === 'SequenceExpression') {
      return semanticNode('sequence', expression.expressions.map((candidate) => next(candidate)));
    }
    if (expression.type === 'ConditionalExpression') {
      if (isNullishNode(expression.alternate)) return next(expression.consequent);
      if (isNullishNode(expression.consequent)) return next(expression.alternate);
      return semanticNode('conditional', [
        next(expression.test),
        next(expression.consequent),
        next(expression.alternate),
      ]);
    }
    const literalNumber = numericValue(expression);
    if (literalNumber !== null) return num(literalNumber);
    if (expression.type === 'Literal') return sym(`literal:${String(expression.value)}`);
    if (expression.type === 'TemplateLiteral') {
      const staticValue = staticStringValue(expression);
      if (staticValue !== null) return sym(`literal:${staticValue}`);
      return semanticNode('template', expression.expressions.map((candidate) => next(candidate)));
    }
    if (expression.type === 'Identifier') {
      const name = expression.name;
      if (overrides?.has(name)) return overrides.get(name);
      if (scope.parameterIndexes.has(name)) return sym(`param:${scope.parameterIndexes.get(name)}`);
      const resolved = resolveBinding(scope, name);
      if (!resolved) return sym(`id:${name}`);
      const memoKey = `${resolved.scope.id}:${name}`;
      if (!overrides && bindingMemo.has(memoKey)) return bindingMemo.get(memoKey);
      if (identifierStack.has(memoKey)) return sym(`id:${name}`);
      const nextIdentifierStack = new Set(identifierStack).add(memoKey);
      const result = normalize(resolved.expression, resolved.scope, {
        overrides,
        identifierStack: nextIdentifierStack,
        helperStack,
        depth: depth + 1,
      });
      if (!overrides) bindingMemo.set(memoKey, result);
      return result;
    }
    if (
      expression.type === 'MemberExpression'
      || expression.type === 'OptionalMemberExpression'
    ) {
      const object = next(expression.object);
      const property = expression.computed
        ? staticStringValue(expression.property) || 'computed'
        : memberName(expression.property) || 'computed';
      return sym(`member:${stableNode(object)}.${property}`);
    }
    if (expression.type === 'UnaryExpression') {
      const argument = next(expression.argument);
      if (argument.op === 'num' && expression.operator === '+') return argument;
      if (argument.op === 'num' && expression.operator === '-') return num(-argument.value);
      return semanticNode(`unary:${expression.operator}`, [argument]);
    }
    if (expression.type === 'LogicalExpression') {
      return semanticNode(`logical:${expression.operator}`, [
        next(expression.left),
        next(expression.right),
      ]);
    }
    if (expression.type === 'BinaryExpression') {
      const left = next(expression.left);
      const right = next(expression.right);
      if (expression.operator === '+') return normalizedCommutative('add', [left, right]);
      if (expression.operator === '*') return normalizedCommutative('mul', [left, right]);
      if (left.op === 'num' && right.op === 'num') {
        if (expression.operator === '-') return num(left.value - right.value);
        if (expression.operator === '/' && right.value !== 0) return num(left.value / right.value);
        if (expression.operator === '%' && right.value !== 0) return num(left.value % right.value);
        if (expression.operator === '**') {
          const value = left.value ** right.value;
          if (Number.isFinite(value)) return num(value);
        }
      }
      if (expression.operator === '-') return semanticNode('sub', [left, right]);
      if (expression.operator === '/') return semanticNode('div', [left, right]);
      return semanticNode(`binary:${expression.operator}`, [left, right]);
    }
    if (expression.type === 'CallExpression' || expression.type === 'NewExpression') {
      const name = memberName(expression.callee);
      const args = expression.arguments.map((argument) => (
        argument?.type === 'SpreadElement' ? next(argument.argument) : next(argument)
      ));
      if (/^(?:Math\.)?(?:ceil|floor|round|trunc)$/u.test(name) && args.length === 1) {
        return canonicalizeRoundedRatio(args[0]);
      }
      if (expression.callee?.type === 'Identifier') {
        const helper = resolveFunction(scope, expression.callee.name);
        if (helper && !helperStack.has(helper)) {
          const helperScope = scopeModel.scopeByNode.get(helper);
          const returnExpression = functionReturnExpression(helper);
          if (helperScope && returnExpression) {
            const helperOverrides = new Map();
            for (const [index, parameter] of helper.params.entries()) {
              const parameterIdentifier = parameterName(parameter);
              if (parameterIdentifier && args[index]) helperOverrides.set(parameterIdentifier, args[index]);
            }
            const result = normalize(returnExpression, helperScope, {
              overrides: helperOverrides,
              identifierStack: new Set(),
              helperStack: new Set(helperStack).add(helper),
              depth: depth + 1,
            });
            return canonicalizeRoundedRatio(result);
          }
        }
      }
      return semanticNode(`call:${name || 'anonymous'}`, args);
    }
    if (expression.type === 'AssignmentExpression') return next(expression.right);
    if (expression.type === 'AwaitExpression') return next(expression.argument);
    if (expression.type === 'ArrayExpression') {
      return semanticNode(
        'array',
        expression.elements.filter(Boolean).map((candidate) => (
          candidate.type === 'SpreadElement' ? next(candidate.argument) : next(candidate)
        )),
      );
    }
    if (expression.type === 'ObjectExpression') {
      return semanticNode(
        'object',
        expression.properties.flatMap((property) => {
          if (property.type === 'SpreadElement') return [next(property.argument)];
          return property.value ? [next(property.value)] : [];
        }),
      );
    }
    if (expression.type === 'TaggedTemplateExpression') {
      return semanticNode('tagged-template', [next(expression.tag), next(expression.quasi)]);
    }
    if (expression.type === 'UpdateExpression') {
      return semanticNode(`update:${expression.operator}`, [next(expression.argument)]);
    }
    return sym(`ast:${expression.type}`);
  };

  return normalize;
}

function flattenSemanticNodes(normalizedExpressions) {
  const output = [];
  const seen = new Set();
  const visit = (candidate) => {
    if (!candidate) return;
    const fingerprint = stableNode(candidate);
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    output.push(candidate);
    for (const argument of candidate.args || []) visit(argument);
  };
  for (const expression of normalizedExpressions) visit(expression);
  return output;
}

function isNumber(candidate, expected) {
  return candidate?.op === 'num' && candidate.value === expected;
}

function matchScaledRate(candidate) {
  if (candidate?.op !== 'div' || candidate.args.length !== 2) return null;
  const [source, scale] = candidate.args;
  if (scale?.op !== 'num' || !PRICING_SCALES.has(scale.value)) return null;
  return { source, scale: scale.value };
}

function matchPricingDenominator(candidate) {
  if (candidate?.op === 'sub' && candidate.args.length === 2) {
    const [scale, commission] = candidate.args;
    if (scale?.op === 'num' && PRICING_SCALES.has(scale.value)) {
      return { mode: 'integer', scale: scale.value, commission, denominator: candidate };
    }
    if (isNumber(scale, 1)) {
      const rate = matchScaledRate(commission);
      if (rate) {
        return {
          mode: 'fractional',
          scale: rate.scale,
          commission: rate.source,
          denominator: candidate,
        };
      }
    }
  }
  if (candidate?.op === 'div' && candidate.args.length === 2) {
    const [numerator, scale] = candidate.args;
    if (
      numerator?.op === 'sub'
      && scale?.op === 'num'
      && PRICING_SCALES.has(scale.value)
      && isNumber(numerator.args[0], scale.value)
    ) {
      return {
        mode: 'scaled-denominator',
        scale: scale.value,
        commission: numerator.args[1],
        denominator: candidate,
      };
    }
  }
  return null;
}

function matchIntegerSuggestedNumerator(candidate, scale) {
  for (const factor of candidate?.op === 'mul' ? candidate.args : [candidate]) {
    if (factor?.op !== 'add') continue;
    const margin = withoutAddend(factor, num(scale));
    if (!margin) continue;
    const base = withoutFactor(candidate, factor);
    if (base) return { base, margin };
  }
  return null;
}

function matchFractionalSuggestedNumerator(candidate, scale) {
  for (const factor of candidate?.op === 'mul' ? candidate.args : [candidate]) {
    if (factor?.op !== 'add') continue;
    const marginRate = withoutAddend(factor, num(1));
    const scaledMargin = matchScaledRate(marginRate);
    if (!scaledMargin || scaledMargin.scale !== scale) continue;
    const base = withoutFactor(candidate, factor);
    if (base) return { base, margin: scaledMargin.source };
  }
  return null;
}

function findCollectionPricingFormula(nodes, { modes = null } = {}) {
  const breakEvenCandidates = [];
  const suggestedCandidates = [];
  for (const candidate of nodes) {
    if (candidate?.op !== 'div' || candidate.args.length !== 2) continue;
    const denominator = matchPricingDenominator(candidate.args[1]);
    if (!denominator || (modes && !modes.has(denominator.mode))) continue;
    if (denominator.mode === 'integer') {
      const base = withoutFactor(candidate.args[0], num(denominator.scale));
      if (base) breakEvenCandidates.push({ candidate, denominator, base });
      const suggested = matchIntegerSuggestedNumerator(candidate.args[0], denominator.scale);
      if (suggested) suggestedCandidates.push({ candidate, denominator, ...suggested });
    } else {
      breakEvenCandidates.push({ candidate, denominator, base: candidate.args[0] });
      const suggested = matchFractionalSuggestedNumerator(candidate.args[0], denominator.scale);
      if (suggested) suggestedCandidates.push({ candidate, denominator, ...suggested });
    }
  }

  for (const breakEven of breakEvenCandidates) {
    for (const suggested of suggestedCandidates) {
      if (breakEven.candidate === suggested.candidate) continue;
      if (breakEven.denominator.scale !== suggested.denominator.scale) continue;
      if (
        stableNode(breakEven.denominator.commission)
        !== stableNode(suggested.denominator.commission)
      ) {
        continue;
      }
      if (stableNode(breakEven.base) !== stableNode(suggested.base)) continue;
      const fractional = breakEven.denominator.mode !== 'integer';
      return {
        family: fractional
          ? 'fractional-fee-margin-pricing'
          : 'integer-basis-point-fee-margin-pricing',
        scale: breakEven.denominator.scale,
        evidence: [breakEven.candidate, suggested.candidate],
      };
    }
  }
  return null;
}

function findFractionalPricingFormula(nodes) {
  return findCollectionPricingFormula(nodes, {
    modes: new Set(['fractional', 'scaled-denominator']),
  });
}

function findIntegerPricingFormula(nodes) {
  return findCollectionPricingFormula(nodes, { modes: new Set(['integer']) });
}

function productRemainder(candidate, numericFactor, denominator) {
  if (candidate?.op !== 'div' || !isNumber(candidate.args[1], denominator)) return null;
  return withoutFactor(candidate.args[0], num(numericFactor));
}

function signedTerms(candidate, sign = 1, output = []) {
  if (candidate?.op === 'add') {
    for (const argument of candidate.args) signedTerms(argument, sign, output);
    return output;
  }
  if (candidate?.op === 'sub') {
    signedTerms(candidate.args[0], sign, output);
    signedTerms(candidate.args[1], -sign, output);
    return output;
  }
  output.push({ sign, value: candidate });
  return output;
}

function includesSemantic(values, expected) {
  const fingerprint = stableNode(expected);
  return values.some((value) => stableNode(value) === fingerprint);
}

function findProfitabilityFormula(nodes) {
  const variableCharges = [];
  const reserves = [];
  const logisticsCharges = [];
  for (const candidate of nodes) {
    if (candidate?.op !== 'div') continue;
    if (isNumber(candidate.args[1], 10_000)) {
      const numeratorFactors = candidate.args[0]?.op === 'mul'
        ? candidate.args[0].args
        : [candidate.args[0]];
      const rateSum = numeratorFactors.find((factor) => (
        factor?.op === 'add'
        && factor.args.filter((argument) => argument?.op !== 'num').length >= 3
      ));
      if (rateSum) {
        const sale = withoutFactor(candidate.args[0], rateSum);
        if (sale) variableCharges.push({ node: candidate, sale, rateSum });
      }
      const sale = productRemainder(candidate, 137, 10_000);
      if (sale) reserves.push({ node: candidate, sale });
    }
    const logistics = productRemainder(candidate, 103, 100);
    if (logistics) logisticsCharges.push({ node: candidate, logistics });
  }

  for (const variableCharge of variableCharges) {
    for (const reserve of reserves) {
      if (stableNode(variableCharge.sale) !== stableNode(reserve.sale)) continue;
      for (const logistics of logisticsCharges) {
        for (const contribution of nodes) {
          if (contribution?.op !== 'sub') continue;
          const terms = signedTerms(contribution);
          const positive = terms.filter((term) => term.sign > 0).map((term) => term.value);
          const negative = terms.filter((term) => term.sign < 0).map((term) => term.value);
          if (!includesSemantic(positive, variableCharge.sale)) continue;
          if (!includesSemantic(negative, variableCharge.node)) continue;
          if (!includesSemantic(negative, reserve.node)) continue;
          if (!includesSemantic(negative, logistics.node)) continue;
          if (negative.length < 4) continue;
          const margin = nodes.find((candidate) => {
            if (candidate?.op !== 'div') return false;
            if (stableNode(candidate.args[1]) !== stableNode(variableCharge.sale)) return false;
            const numerator = withoutFactor(candidate.args[0], num(10_000));
            return numerator && stableNode(numerator) === stableNode(contribution);
          });
          if (!margin) continue;
          const numericValues = new Set(
            nodes.filter((candidate) => candidate?.op === 'num').map((candidate) => candidate.value),
          );
          const thresholdCount = PROFITABILITY_THRESHOLDS.filter((value) => numericValues.has(value)).length;
          return {
            family: 'profitability-reserve-logistics-decision',
            scale: 10_000,
            thresholdCount,
            evidence: [
              variableCharge.node,
              reserve.node,
              logistics.node,
              contribution,
              margin,
            ],
          };
        }
      }
    }
  }
  return null;
}

function parseJavaScript(source) {
  const options = {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    locations: true,
  };
  try {
    return JavaScriptParser.parse(source, options);
  } catch (moduleError) {
    try {
      return JavaScriptParser.parse(source, { ...options, sourceType: 'script' });
    } catch (scriptError) {
      const error = new Error(scriptError.message || moduleError.message);
      error.cause = scriptError;
      throw error;
    }
  }
}

function dynamicCodeFindings(ast, file) {
  const findings = [];
  const seen = new Set();
  const add = (kind, candidate) => {
    const key = `${kind}:${candidate.start ?? -1}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({
      code: 'PROTECTED_COMPUTE_DYNAMIC_CODE_FORBIDDEN',
      file,
      evidence: `${kind} at ${candidate.loc?.start?.line ?? '?'}:${candidate.loc?.start?.column ?? '?'}`,
    });
  };
  walk(ast, (candidate) => {
    if (candidate.type === 'CallExpression' || candidate.type === 'NewExpression') {
      const name = memberName(candidate.callee);
      if (/(?:^|\.)(?:eval|Function)$/u.test(name)) add(name || 'dynamic-code', candidate);
      if (
        /(?:^|\.)(?:setTimeout|setInterval)$/u.test(name)
        && typeof staticStringValue(candidate.arguments?.[0]) === 'string'
      ) {
        add(`${name}:string-argument`, candidate);
      }
    }
    if (
      candidate.type === 'Identifier'
      && ['eval', 'Function', 'WebAssembly'].includes(candidate.name)
    ) {
      add(`${candidate.name}:reference`, candidate);
    }
  });
  return findings;
}

function decodeInlineSourceMaps(source, file) {
  const units = [];
  INLINE_SOURCE_MAP_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(INLINE_SOURCE_MAP_PATTERN)) {
    const uri = match[1].replace(/\*\/$/u, '');
    const commaIndex = uri.indexOf(',');
    try {
      if (commaIndex < 0) throw new Error('inline source map data URI is missing a comma');
      const metadata = uri.slice(0, commaIndex);
      const payload = uri.slice(commaIndex + 1);
      const text = /;base64$/iu.test(metadata)
        ? Buffer.from(payload, 'base64').toString('utf8')
        : decodeURIComponent(payload);
      units.push(...sourceMapUnits(text, `${file}::inline-source-map`));
    } catch (error) {
      units.push({
        file: `${file}::inline-source-map`,
        parseFinding: {
          code: 'PROTECTED_COMPUTE_SOURCE_MAP_PARSE_FAILED',
          file: `${file}::inline-source-map`,
          evidence: String(error?.message || error),
        },
      });
    }
  }
  return units;
}

function scanJavaScriptAst(ast, file, packageMode) {
  const scopeModel = discoverScopes(ast);
  const normalize = createNormalizer(scopeModel);
  const allNodes = [];
  const allFingerprints = new Set();
  const appendNodes = (nodes) => {
    for (const candidate of nodes) {
      const fingerprint = stableNode(candidate);
      if (allFingerprints.has(fingerprint)) continue;
      allFingerprints.add(fingerprint);
      allNodes.push(candidate);
    }
  };
  for (const scope of scopeModel.scopes) {
    if (!scopeMayContainProtectedFormula(scope)) continue;
    appendNodes([...scope.staticNumbers].map((value) => num(value)));
    const expressions = scope.expressions.filter(expressionHasFormulaArithmetic);
    appendNodes(flattenSemanticNodes(
      expressions.map((expression) => normalize(expression, scope)),
    ));
  }

  const findings = [];
  const collection = findCollectionPricingFormula(allNodes);
  if (collection) {
    findings.push({
      code: 'PROTECTED_COMPUTE_EQUIVALENT_FORMULA_LEAK',
      file,
      evidence: `${collection.family}; scale=${collection.scale}; scope=aggregate`,
    });
  }
  const profitability = findProfitabilityFormula(allNodes);
  if (profitability) {
    findings.push({
      code: 'PROTECTED_COMPUTE_EQUIVALENT_FORMULA_LEAK',
      file,
      evidence: `${profitability.family}; scale=${profitability.scale}; thresholds=${profitability.thresholdCount}/3; scope=aggregate`,
    });
  }
  if (packageMode) findings.push(...dynamicCodeFindings(ast, file));
  return findings;
}

export function scanProtectedComputeSemanticText(
  source,
  {
    file = '<memory>',
    packageMode = false,
    inlineSourceMapDepth = 0,
  } = {},
) {
  let ast;
  try {
    ast = parseJavaScript(String(source || ''));
  } catch (error) {
    return Object.freeze({
      ok: false,
      findings: Object.freeze([Object.freeze({
        code: 'PROTECTED_COMPUTE_SEMANTIC_PARSE_FAILED',
        file,
        evidence: String(error?.message || error),
      })]),
    });
  }

  const findings = scanJavaScriptAst(ast, file, packageMode);
  if (inlineSourceMapDepth < MAX_INLINE_SOURCE_MAP_DEPTH) {
    for (const unit of decodeInlineSourceMaps(String(source || ''), file)) {
      if (unit.parseFinding) {
        findings.push(unit.parseFinding);
        continue;
      }
      const result = scanProtectedComputeSemanticText(unit.source, {
        file: unit.file,
        packageMode,
        inlineSourceMapDepth: inlineSourceMapDepth + 1,
      });
      findings.push(...result.findings);
    }
  }
  findings.sort((left, right) => `${left.file}:${left.code}`.localeCompare(`${right.file}:${right.code}`));
  return Object.freeze({
    ok: findings.length === 0,
    findings: Object.freeze(findings.map((finding) => Object.freeze(finding))),
  });
}

function isSemanticCandidate(source) {
  const text = String(source || '');
  return (
    /sourceMappingURL\s*=\s*data:application\/json/iu.test(text)
    || (text.includes('-') && text.includes('*') && text.includes('/'))
  );
}

async function collectRegularFiles(root, output, { excludeTestFixtures, packageMode }) {
  let rootStat;
  try {
    rootStat = await fs.stat(root);
  } catch {
    return;
  }
  if (rootStat.isFile()) {
    if (!excludeTestFixtures || !isTestFixturePath(root)) output.push(path.resolve(root));
    return;
  }
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!packageMode && entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const target = path.join(root, entry.name);
    if (excludeTestFixtures && isTestFixturePath(target)) continue;
    if (entry.isDirectory()) {
      await collectRegularFiles(target, output, { excludeTestFixtures, packageMode });
    }
    else if (entry.isFile()) output.push(path.resolve(target));
  }
}

function isJavaScriptFile(file) {
  return JAVASCRIPT_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function sourceMapUnits(text, file) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    return [{
      file,
      parseFinding: {
        code: 'PROTECTED_COMPUTE_SOURCE_MAP_PARSE_FAILED',
        file,
        evidence: String(error?.message || error),
      },
    }];
  }
  const contents = Array.isArray(payload.sourcesContent) ? payload.sourcesContent : [];
  const sources = Array.isArray(payload.sources) ? payload.sources : [];
  return contents.flatMap((source, index) => {
    if (typeof source !== 'string') return [];
    const sourceName = sources[index] || `source-${index}.js`;
    const extension = path.extname(sourceName).toLowerCase();
    if (extension && !JAVASCRIPT_EXTENSIONS.has(extension) && !['.ts', '.tsx'].includes(extension)) {
      return [];
    }
    return [{ file: `${file}::${sourceName}`, source, kind: 'javascript' }];
  });
}

function htmlInlineFinding(text, file) {
  const inlineScript = Array.from(text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu))
    .find((match) => !/\bsrc\s*=/iu.test(match[1]) && match[2].trim());
  if (inlineScript) {
    return {
      code: 'PROTECTED_COMPUTE_HTML_INLINE_CODE_FORBIDDEN',
      file,
      evidence: 'inline <script> content',
    };
  }
  if (/\son[a-z]+\s*=|(?:href|src)\s*=\s*["']?\s*javascript:/iu.test(text)) {
    return {
      code: 'PROTECTED_COMPUTE_HTML_INLINE_CODE_FORBIDDEN',
      file,
      evidence: 'inline event handler or javascript: URL',
    };
  }
  return null;
}

function textUnits(buffer, file, { packageMode }) {
  const extension = path.extname(file).toLowerCase();
  const text = buffer.toString('utf8');
  if (extension === SOURCE_MAP_EXTENSION) return sourceMapUnits(text, file);
  if (JAVASCRIPT_EXTENSIONS.has(extension)) {
    return [{ file, source: text, kind: 'javascript' }];
  }
  if (packageMode && HTML_EXTENSIONS.has(extension)) {
    const finding = htmlInlineFinding(text, file);
    return finding ? [{ file, parseFinding: finding }] : [];
  }
  if (packageMode && extension === WASM_EXTENSION) {
    return [{
      file,
      parseFinding: {
        code: 'PROTECTED_COMPUTE_WASM_ARTIFACT_FORBIDDEN',
        file,
        evidence: 'WebAssembly binary in client package',
      },
    }];
  }
  return [];
}

async function unitsFromAsar(asarPath, { packageMode, excludeTestFixtures }) {
  const units = [];
  for (const rawEntry of listPackage(asarPath)) {
    const archiveEntry = String(rawEntry).replace(/^[\\/]+|[\\/]+$/gu, '');
    const entry = archiveEntry.replace(/\\/gu, '/');
    if (excludeTestFixtures && isTestFixturePath(entry)) continue;
    const extension = path.extname(entry).toLowerCase();
    const supported = isJavaScriptFile(entry)
      || extension === SOURCE_MAP_EXTENSION
      || (packageMode && (HTML_EXTENSIONS.has(extension) || extension === WASM_EXTENSION));
    if (!supported) {
      if (packageMode && extension === '.asar') {
        units.push({
          file: `${asarPath}::${entry}`,
          parseFinding: {
            code: 'PROTECTED_COMPUTE_NESTED_ASAR_FORBIDDEN',
            file: `${asarPath}::${entry}`,
            evidence: 'nested ASAR cannot be recursively audited without extraction',
          },
        });
      }
      continue;
    }
    try {
      const buffer = extractFile(asarPath, archiveEntry);
      units.push(...textUnits(buffer, `${asarPath}::${entry}`, { packageMode }));
    } catch (error) {
      units.push({
        file: `${asarPath}::${entry}`,
        parseFinding: {
          code: 'PROTECTED_COMPUTE_ASAR_ENTRY_READ_FAILED',
          file: `${asarPath}::${entry}`,
          evidence: String(error?.message || error),
        },
      });
    }
  }
  return units;
}

export async function scanProtectedComputeSemanticBoundary({
  clientRoots,
  packageMode = false,
  excludeTestFixtures = !packageMode,
}) {
  const roots = [...new Set((clientRoots || []).map((value) => path.resolve(value)))];
  if (!roots.length) throw new Error('At least one client/package root is required.');
  const regularFiles = [];
  const units = [];
  for (const root of roots) {
    await collectRegularFiles(root, regularFiles, { excludeTestFixtures, packageMode });
  }
  for (const file of regularFiles) {
    const extension = path.extname(file).toLowerCase();
    if (extension === '.asar') {
      try {
        units.push(...await unitsFromAsar(file, { packageMode, excludeTestFixtures }));
      } catch (error) {
        units.push({
          file,
          parseFinding: {
            code: 'PROTECTED_COMPUTE_ASAR_READ_FAILED',
            file,
            evidence: String(error?.message || error),
          },
        });
      }
      continue;
    }
    if (
      !isJavaScriptFile(file)
      && extension !== SOURCE_MAP_EXTENSION
      && !(packageMode && (HTML_EXTENSIONS.has(extension) || extension === WASM_EXTENSION))
    ) {
      continue;
    }
    const buffer = await fs.readFile(file);
    units.push(...textUnits(buffer, file, { packageMode }));
  }

  const findings = [];
  let scannedUnitCount = 0;
  let duplicateUnitCount = 0;
  let prefilteredUnitCount = 0;
  const scannedContentHashes = new Set();
  for (const unit of units) {
    if (unit.parseFinding) {
      findings.push(unit.parseFinding);
      continue;
    }
    const contentHash = createHash('sha256').update(unit.source).digest('hex');
    if (scannedContentHashes.has(contentHash)) {
      duplicateUnitCount += 1;
      continue;
    }
    scannedContentHashes.add(contentHash);
    if (!packageMode && !isSemanticCandidate(unit.source)) {
      prefilteredUnitCount += 1;
      continue;
    }
    scannedUnitCount += 1;
    const result = scanProtectedComputeSemanticText(unit.source, {
      file: unit.file,
      packageMode,
    });
    findings.push(...result.findings);
  }
  findings.sort((left, right) => `${left.file}:${left.code}`.localeCompare(`${right.file}:${right.code}`));
  return Object.freeze({
    ok: findings.length === 0,
    roots: Object.freeze(roots),
    packageMode,
    scannedUnitCount,
    duplicateUnitCount,
    prefilteredUnitCount,
    findings: Object.freeze(findings.map((finding) => Object.freeze(finding))),
  });
}

export const protectedComputeSemanticAuditInternals = Object.freeze({
  findCollectionPricingFormula,
  findFractionalPricingFormula,
  findIntegerPricingFormula,
  findProfitabilityFormula,
  isSemanticCandidate,
  stableNode,
});
