// Local lint rules for mistakes agents keep repeating. Each error names the fix.
// Run through `npm run check:rules`; proofs live in rules.test.js.
'use strict';

const WORKLET_HOOKS = new Set([
  'useAnimatedStyle',
  'useDerivedValue',
  'useAnimatedProps',
  'useAnimatedReaction',
  'useAnimatedScrollHandler',
  'useFrameCallback',
  'runOnUI',
]);
const GESTURE_CALLBACKS = new Set([
  'onBegin', 'onStart', 'onUpdate', 'onChange', 'onEnd', 'onFinalize',
  'onTouchesDown', 'onTouchesMove', 'onTouchesUp', 'onTouchesCancelled',
]);
const FNS = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration']);

function calleeName(call) {
  const c = call.callee;
  if (c.type === 'Identifier') return c.name;
  if (c.type === 'MemberExpression' && c.property.type === 'Identifier') return c.property.name;
  return null;
}

// True for a `Gesture.X()...` chain that runs on the UI thread. `.runOnJS(true)` callbacks are
// plain JS, so reading refs and props there is fine.
function isGestureChain(node) {
  let n = node;
  while (n) {
    if (n.type === 'CallExpression') {
      const c = n.callee;
      if (c.type === 'MemberExpression' && c.property.name === 'runOnJS' && n.arguments[0]?.value === true) return false;
      n = c;
    } else if (n.type === 'MemberExpression') n = n.object;
    else return n.type === 'Identifier' && n.name === 'Gesture';
  }
  return false;
}

function hasWorkletDirective(fn) {
  const b = fn.body;
  return (
    b && b.type === 'BlockStatement' &&
    b.body.some((s) => s.type === 'ExpressionStatement' && s.directive === 'worklet')
  );
}

function isWorklet(fn) {
  if (!FNS.has(fn.type)) return false;
  if (hasWorkletDirective(fn)) return true;
  const call = fn.parent;
  if (!call || call.type !== 'CallExpression' || !call.arguments.includes(fn)) return false;
  const name = calleeName(call);
  if (call.callee.type === 'Identifier' && WORKLET_HOOKS.has(name)) return true;
  return call.callee.type === 'MemberExpression' && GESTURE_CALLBACKS.has(name) && isGestureChain(call.callee.object);
}

const inside = (node, outer) => node.range[0] >= outer.range[0] && node.range[1] <= outer.range[1];

const workletCaptures = {
  meta: { type: 'problem', schema: [], messages: {
    prop: 'Worklet reads `{{text}}` from outside the worklet. A props object or ref drags JSX and fibers to the UI thread and crashes the phone with "Cannot copy value of type FiberNode". Read it first, outside the worklet: `const x = {{root}}.{{first}};`, then use `x` inside.',
    jsx: 'JSX inside a worklet cannot be copied to the UI thread. Build the element outside the worklet and only animate SharedValues inside it.',
  } },
  create(context) {
    const sc = context.sourceCode;
    function workletOf(node) {
      for (let n = node.parent; n; n = n.parent) if (isWorklet(n)) return n;
      return null;
    }
    return {
      JSXElement(node) {
        if (workletOf(node)) context.report({ node, messageId: 'jsx' });
      },
      MemberExpression(node) {
        // Only the outermost chain: skip when this is the object of a longer member access.
        if (node.parent.type === 'MemberExpression' && node.parent.object === node) return;
        const w = workletOf(node);
        if (!w) return;
        const chain = [];
        let root = node;
        while (root.type === 'MemberExpression') {
          chain.unshift(root.computed ? null : root.property.name);
          root = root.object;
        }
        if (root.type !== 'Identifier') return;
        let scope = sc.getScope(node);
        let variable = null;
        for (let s = scope; s && !variable; s = s.upper) variable = s.set.get(root.name) ?? null;
        if (!variable || variable.defs.length === 0) return;
        if (inside(variable.defs[0].name, w)) return; // declared inside the worklet
        const isParam = variable.defs[0].type === 'Parameter';
        const first = chain[0];
        const touchesCurrent = chain.includes('current');
        // `.value`, `.get()` and `.set()` are the SharedValue API, which is safe to capture.
        const propsRead = isParam && !['value', 'get', 'set'].includes(first) && first !== null;
        if (!touchesCurrent && !propsRead) return;
        context.report({
          node,
          messageId: 'prop',
          data: { text: sc.getText(node), root: root.name, first: chain.find((c) => c) ?? 'x' },
        });
      },
    };
  },
};

const noUnionBoxBlocker = {
  meta: { type: 'problem', schema: [], messages: {
    union: 'A touch blocker built from one min/max box around several holes also blocks the space between the holes. Use `guideBlockers()` in src/components/onboarding/guide-layer.tsx, which cuts bands at every hole edge.',
  } },
  create(context) {
    const sc = context.sourceCode;
    const stack = [];
    const isMathSpread = (n, fn) =>
      n.callee.type === 'MemberExpression' && n.callee.object.name === 'Math' && n.callee.property.name === fn &&
      n.arguments.some((a) => a.type === 'SpreadElement');
    const enter = (n) => stack.push({ n, min: false, max: false });
    const exit = () => {
      const f = stack.pop();
      if (f.min && f.max && /onStartShouldSetResponder|sink|[Bb]locker/.test(sc.getText(f.n))) {
        context.report({ node: f.n, messageId: 'union' });
      }
    };
    return {
      FunctionDeclaration: enter, 'FunctionDeclaration:exit': exit,
      FunctionExpression: enter, 'FunctionExpression:exit': exit,
      ArrowFunctionExpression: enter, 'ArrowFunctionExpression:exit': exit,
      CallExpression(node) {
        const f = stack[stack.length - 1];
        if (!f) return;
        if (isMathSpread(node, 'min')) f.min = true;
        if (isMathSpread(node, 'max')) f.max = true;
      },
    };
  },
};

// `dir.row` is undefined in LTR, so a style that relies on it for flexDirection stacks as a column.
const dirRowNeedsFlexDirection = {
  meta: { type: 'problem', schema: [], messages: {
    row: '`styles.{{name}}` is used with `dir.row`, which is undefined in LTR, but it sets no flexDirection, so it stacks as a column in English. Add `flexDirection: \'row\'` to `{{name}}` in this file\'s StyleSheet.',
  } },
  create(context) {
    const used = []; // { name, node }
    const flexKeys = new Set();
    const keys = new Set();
    const isDirRow = (e) =>
      e.type === 'MemberExpression' && e.object.type === 'Identifier' && e.object.name === 'dir' &&
      e.property.type === 'Identifier' && e.property.name === 'row';
    return {
      ArrayExpression(node) {
        if (!node.elements.some((e) => e && isDirRow(e))) return;
        for (const e of node.elements) {
          if (e && e.type === 'MemberExpression' && e.object.type === 'Identifier' && e.object.name === 'styles' && !e.computed) {
            used.push({ name: e.property.name, node: e });
          }
        }
      },
      CallExpression(node) {
        const c = node.callee;
        if (!(c.type === 'MemberExpression' && c.object.name === 'StyleSheet' && c.property.name === 'create')) return;
        const obj = node.arguments[0];
        if (!obj || obj.type !== 'ObjectExpression') return;
        for (const p of obj.properties) {
          if (p.type !== 'Property' || p.key.type !== 'Identifier') continue;
          keys.add(p.key.name);
          if (p.value.type === 'ObjectExpression') {
            const has = p.value.properties.some((q) => q.type === 'SpreadElement' || (q.key && q.key.name === 'flexDirection'));
            if (has) flexKeys.add(p.key.name);
          } else flexKeys.add(p.key.name); // unknowable: do not guess
        }
      },
      'Program:exit'() {
        for (const u of used) {
          if (keys.has(u.name) && !flexKeys.has(u.name)) {
            context.report({ node: u.node, messageId: 'row', data: { name: u.name } });
          }
        }
      },
    };
  },
};

module.exports = {
  rules: {
    'worklet-captures': workletCaptures,
    'no-union-box-blocker': noUnionBoxBlocker,
    'dir-row-needs-flex-direction': dirRowNeedsFlexDirection,
  },
};
