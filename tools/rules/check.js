// `npm run check:rules`: one command, same locally and in CI. Exit 1 on any broken rule.
// See the rule table in AGENTS.md. Proofs against real past mistakes: `npm run test:rules`.
'use strict';
const fs = require('fs');
const path = require('path');
const { lintFiles } = require('./lint');

const root = path.resolve(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const problems = [];

/** Default playback speed is 1.0. Sean has asked about this repeatedly. */
function speedProblems(settingsTs) {
  const out = [];
  const m = settingsTs.match(/const DEFAULT_DEFAULT_SPEED\s*(?::[^=]+)?=\s*([^;]+);/);
  if (!m) out.push('src/lib/settings.ts: DEFAULT_DEFAULT_SPEED is missing. Keep the single constant, set to 1.');
  else if (Number(m[1]) !== 1) out.push(`src/lib/settings.ts: DEFAULT_DEFAULT_SPEED is ${m[1].trim()}. The default playback speed is 1.0, never 0.5.`);
  if (/defaultSpeed\s*:\s*0?\.5\b/.test(settingsTs)) out.push('src/lib/settings.ts: defaultSpeed is a literal 0.5. Use DEFAULT_DEFAULT_SPEED (1).');
  return out;
}

/** An EAS iOS build must come from committed git (build 4 shipped old JS "without VCS"). */
function easProblems(easJson, workflowFiles) {
  const out = [];
  let eas = {};
  try { eas = JSON.parse(easJson); } catch { out.push('eas.json does not parse.'); }
  if (!eas.cli || eas.cli.requireCommit !== true) {
    out.push('eas.json: set "cli": { "requireCommit": true } so `eas build` refuses an uncommitted tree.');
  }
  for (const [name, text] of Object.entries(workflowFiles)) {
    if (/EAS_NO_VCS|--no-vcs/.test(text)) out.push(`${name}: remove EAS_NO_VCS / --no-vcs. Builds must archive the git commit, not the working directory.`);
  }
  return out;
}

async function main() {
  problems.push(...speedProblems(read('src/lib/settings.ts')));
  const wf = {};
  const wfDir = path.join(root, '.github', 'workflows');
  if (fs.existsSync(wfDir)) for (const f of fs.readdirSync(wfDir)) wf[`.github/workflows/${f}`] = fs.readFileSync(path.join(wfDir, f), 'utf8');
  wf['package.json'] = read('package.json');
  problems.push(...easProblems(read('eas.json'), wf));

  // Lint rules. A baseline lets old violations stand and fails only when a file gets more.
  const baseline = JSON.parse(read('tools/rules/baseline.json'));
  const found = await lintFiles(['src']);
  const counts = {};
  const sample = {};
  for (const m of found) {
    const key = `${m.ruleId}|${path.relative(root, m.file)}`;
    counts[key] = (counts[key] || 0) + 1;
    (sample[key] ||= []).push(m);
  }
  if (process.argv.includes('--update-baseline')) {
    fs.writeFileSync(path.join(root, 'tools/rules/baseline.json'), JSON.stringify(counts, null, 2) + '\n');
    console.log('baseline written');
    return;
  }
  for (const [key, n] of Object.entries(counts)) {
    if (n > (baseline[key] || 0)) {
      for (const m of sample[key]) problems.push(`${path.relative(root, m.file)}:${m.line} [${m.ruleId}] ${m.message}`);
    }
  }
  const stale = Object.keys(baseline).filter((k) => !(k in counts));
  if (stale.length) console.log(`note: ${stale.length} baseline entries are fixed, run \`node tools/rules/check.js --update-baseline\` to shrink it`);
}

module.exports = { speedProblems, easProblems };

if (require.main === module) {
  main().then(() => {
    if (problems.length) {
      console.error(problems.map((p) => `  ${p}`).join('\n'));
      console.error(`\ncheck:rules failed (${problems.length}).`);
      process.exit(1);
    }
    console.log('check:rules ok');
  });
}
