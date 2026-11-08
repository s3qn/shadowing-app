// Locale parity: every language listed in COMPLETE_LANGS has exactly the en
// keys, the same {placeholder} names per key, and no em dash. `tsc` already
// enforces key parity through `satisfies`; this adds placeholders and the list.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const LOCALES = path.join(ROOT, 'src', 'locales');

const START = /^\s*'((?:[^'\\]|\\.)+)'\s*:/gm;

// A key's value is everything up to the next key, minus comment lines. That
// covers wrapped values and ones built with isolate(...) or a template.
function readCatalogue(dir) {
  const out = new Map();
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts') && n !== 'index.ts').sort()) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const starts = [...src.matchAll(START)];
    starts.forEach((m, i) => {
      const end = i + 1 < starts.length ? starts[i + 1].index : src.length;
      const body = src
        .slice(m.index + m[0].length, end)
        .split('\n')
        .filter((l) => !l.trim().startsWith('//'))
        .join('\n');
      out.set(m[1], body);
    });
  }
  return out;
}

function placeholders(s) {
  return [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
}

// A plural variant may drop its number ("one line" instead of "{count} line") or
// add the base key's number, but may not name a placeholder neither has. Everything else matches exactly.
function samePlaceholders(key, enValue, value, enBase) {
  const a = placeholders(enValue);
  const b = placeholders(value);
  if (!/_(one|two|few|many|other)$/.test(key)) return a === b;
  const allowed = new Set(a.split(',').concat(placeholders(enBase ?? '').split(',')).filter(Boolean));
  return b.split(',').filter(Boolean).every((x) => allowed.has(x));
}

/** Problems found comparing a catalogue against en. */
function compare(en, other) {
  const problems = [];
  for (const [k, v] of en) {
    if (!other.has(k)) problems.push(`missing key ${k}`);
    else if (!samePlaceholders(k, v, other.get(k), en.get(k.replace(/_(one|two|few|many|other)$/, '')))) problems.push(`placeholders differ for ${k}`);
  }
  // A language may add a plural form en lacks (he has _two where en has none, ar adds _few and _many).
  const isExtraPlural = (k) => {
    if (!/_(one|two|few|many|other)$/.test(k)) return false;
    const base = k.replace(/_(one|two|few|many|other)$/, '');
    return en.has(base) || en.has(`${base}_other`);
  };
  for (const k of other.keys()) if (!en.has(k) && !isExtraPlural(k)) problems.push(`extra key ${k}`);
  return problems;
}

function completeLangs() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'app-languages.ts'), 'utf8');
  const m = src.match(/COMPLETE_LANGS\s*=\s*\[([^\]]*)\]/);
  return [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]);
}

const en = readCatalogue(path.join(LOCALES, 'en'));

for (const code of completeLangs().filter((c) => c !== 'en')) {
  test(`locale ${code} matches en keys and placeholders`, () => {
    assert.deepStrictEqual(compare(en, readCatalogue(path.join(LOCALES, code))), []);
  });
  test(`locale ${code} has no em dash`, () => {
    const dir = path.join(LOCALES, code);
    for (const f of fs.readdirSync(dir)) {
      assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes('\u2014'), `${code}/${f} has an em dash`);
    }
  });
}

test('parity check catches a dropped key and a changed placeholder', () => {
  const good = new Map(en);
  assert.deepStrictEqual(compare(en, good), []);
  const [k0] = [...en.keys()];
  const dropped = new Map(en);
  dropped.delete(k0);
  assert.ok(compare(en, dropped).some((p) => p.startsWith('missing key')));
  const withVar = [...en].find(([k, v]) => !/_(one|two|few|many|other)$/.test(k) && /\{\w+\}/.test(v));
  const changed = new Map(en);
  changed.set(withVar[0], withVar[1].replace(/\{\w+\}/, '{zzz}'));
  assert.ok(compare(en, changed).some((p) => p.startsWith('placeholders differ')));
});

test('the en reader finds every key', () => {
  assert.ok(en.size > 900);
});
