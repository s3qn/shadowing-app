// Proofs: every check fails on the real past mistake and passes on the fix.
// Old file contents come from git history, so a missing object skips rather than lies.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { lintText } = require('./lint');
const { speedProblems, easProblems } = require('./check');

const root = require('path').resolve(__dirname, '..', '..');
const show = (rev, file) => {
  try {
    return execFileSync('git', ['show', `${rev}:${file}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 });
  } catch { return null; }
};
const rules = (code, ids) => lintText(code).filter((m) => ids.includes(m.ruleId));
const WORKLET = ['repo/worklet-captures'];

test('worklet: ladder-stage.tsx at c3bafcb read p.fill inside useAnimatedStyle (FiberNode crash)', (t) => {
  const old = show('c3bafcb', 'src/components/tide/ladder-stage.tsx');
  if (!old) return t.skip('git object missing');
  const hits = rules(old, WORKLET);
  assert.ok(hits.some((m) => m.line === 265 && /p\.fill/.test(m.message)), 'expected a hit at line 265');
});
test('worklet: the fix (const fill = p.fill outside) passes, SharedValue API and runOnJS gestures pass', () => {
  const clean = `function C(p){ const fill = p.fill; const s = useAnimatedStyle(() => ({ width: fill.value * 100 }));
    const g = Gesture.Pan().runOnJS(true).onStart(() => { ref.current = p.x; });
    const h = useDerivedValue(() => other.get() + fill.value); other.set(1); return s; }`;
  assert.deepStrictEqual(rules(clean, WORKLET), []);
});
test('worklet: ref.current, props reads and JSX inside a worklet fail', () => {
  assert.equal(rules('function C(props){ useAnimatedStyle(() => ({ o: props.x })); }', WORKLET).length, 1);
  assert.equal(rules('function C(){ const r = useRef(); useAnimatedStyle(() => ({ o: r.current })); }', WORKLET).length, 1);
  assert.equal(rules('function C(){ useDerivedValue(() => <View />); }', WORKLET).length, 1);
  assert.equal(rules('function C(p){ Gesture.Pan().onUpdate(() => p.cb()); }', WORKLET).length, 1);
});

test('blocker: guide-layer.tsx at c3bafcb built one union box around the holes', (t) => {
  const old = show('c3bafcb', 'src/components/onboarding/guide-layer.tsx');
  if (!old) return t.skip('git object missing');
  assert.equal(rules(old, ['repo/no-union-box-blocker']).length, 1);
});
test('blocker: the banded guideBlockers shape passes', () => {
  const good = `export function guideBlockers(holes){ const sink = () => <View onStartShouldSetResponder={() => true} />;
    const edges = [Math.min(0, ...holes.map((h) => h.y)), ...holes.flatMap((h) => [h.y, h.y + h.height])]; return edges.map(sink); }`;
  assert.deepStrictEqual(rules(good, ['repo/no-union-box-blocker']), []);
});

test('speed: settings.ts before 43096cc defaulted to 0.5', (t) => {
  const old = show('43096cc^', 'src/lib/settings.ts');
  if (!old) return t.skip('git object missing');
  assert.equal(speedProblems(old).length, 1);
});
test('speed: today passes', () => {
  assert.deepStrictEqual(speedProblems(fs.readFileSync(`${root}/src/lib/settings.ts`, 'utf8')), []);
});

test('eas: eas.json before requireCommit fails, today passes, EAS_NO_VCS fails', (t) => {
  const old = show('ba5a0a5', 'eas.json');
  if (!old) return t.skip('git object missing');
  assert.equal(easProblems(old, {}).length, 1);
  const now = fs.readFileSync(`${root}/eas.json`, 'utf8');
  assert.deepStrictEqual(easProblems(now, { 'ios-build.yml': fs.readFileSync(`${root}/.github/workflows/ios-build.yml`, 'utf8') }), []);
  assert.equal(easProblems(now, { 'x.yml': 'env:\n  EAS_NO_VCS: 1' }).length, 1);
});

test('dir.row: leaderboard-row.tsx before 6103497 stacked as a column in LTR', (t) => {
  const old = show('6103497^', 'src/components/cat/leaderboard-row.tsx');
  const fixed = show('6103497', 'src/components/cat/leaderboard-row.tsx');
  if (!old || !fixed) return t.skip('git object missing');
  const id = ['repo/dir-row-needs-flex-direction'];
  assert.ok(rules(old, id).length >= 1);
  assert.deepStrictEqual(rules(fixed, id), []);
});
