#!/usr/bin/env node
/**
 * Publish-safety gate for the github-search skill bundle.
 *
 *     node scripts/check-public-safe.mjs            # working tree
 *     node scripts/check-public-safe.mjs --history  # also scan the last 200 commits
 *
 * Answers one question: *if this bundle were published right now, would a
 * credential go with it?*  Inside a git repository that means exactly the set
 * `git add -A` would stage (tracked + untracked-not-ignored). Credential files
 * that exist locally but are git-ignored are reported as local-only info, not
 * as failures — they are precisely what must stay behind.
 *
 * Exits non-zero when a token-shaped string is found in a publishable file, when
 * a credential path is tracked, or when .gitignore fails to cover it.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = resolve(HERE, '..');
const history = process.argv.includes('--history');

const SKIP_DIRS = new Set(['.git', 'node_modules', '.secrets', 'dist']);
const TEXT_EXT = new Set([
  '', '.md', '.mjs', '.js', '.cjs', '.json', '.ps1', '.sh', '.yml', '.yaml', '.txt', '.example',
  '.gitignore', '.gitattributes',
]);

/** Paths that must never be published. */
const MUST_BE_IGNORED = ['.secrets/github-search.json', 'config.local.json', 'config.json'];

const PATTERNS = [
  ['classic PAT', /\bghp_[A-Za-z0-9]{30,}\b/],
  ['fine-grained PAT', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['oauth token', /\bgho_[A-Za-z0-9]{30,}\b/],
  ['app/server token', /\bgh[su]_[A-Za-z0-9]{30,}\b/],
  ['refresh token', /\bghr_[A-Za-z0-9]{30,}\b/],
  ['assigned token field', /"?(token|api_?key|secret)"?\s*[:=]\s*"([A-Za-z0-9_-]{30,})"/i],
];

/** Documentation placeholders must not trip the field pattern. */
const PLACEHOLDER = /(REPLACE|YOUR_|EXAMPLE|YOURTOKEN|xxxxxx|\.\.\.|<[a-z][a-z-]*>|_TOKEN\b)/i;

const mask = (s) => (s.length <= 12 ? '***' : `${s.slice(0, 7)}…${s.slice(-4)}`);

const git = (args, opts = {}) => execFileSync('git', ['-C', BUNDLE, ...args], { encoding: 'utf8', ...opts });

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

const inRepo = existsSync(join(BUNDLE, '.git'));
const problems = [];
const localOnly = [];

// ---- 1. the publishable file set ---------------------------------------
let publishable; // absolute paths
if (inRepo) {
  // tracked + untracked-but-not-ignored == what `git add -A` would stage
  const listed = git(['ls-files', '--cached', '--others', '--exclude-standard'])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  publishable = listed.map((rel) => join(BUNDLE, rel)).filter((p) => existsSync(p));
} else {
  publishable = walk(BUNDLE).filter((p) => {
    const rel = relative(BUNDLE, p).split('\\').join('/');
    if (rel === 'config.local.json' || rel === 'config.json') {
      localOnly.push(rel);
      return false;
    }
    return true;
  });
}

// ---- 2. credential paths must be excluded ------------------------------
if (inRepo) {
  for (const rel of [...MUST_BE_IGNORED, '.secrets/']) {
    let ignored = false;
    try {
      git(['check-ignore', '-q', '--', rel], { stdio: 'ignore' });
      ignored = true;
    } catch {
      ignored = false;
    }
    if (!ignored) problems.push(`.gitignore does NOT cover "${rel}" — add it before publishing`);
  }

  const tracked = git(['ls-files']).split('\n').map((l) => l.trim()).filter(Boolean);
  const leaked = tracked.filter((f) => f.startsWith('.secrets/') || MUST_BE_IGNORED.includes(f));
  if (leaked.length) problems.push(`git already tracks credential path(s): ${leaked.join(', ')}`);

  for (const rel of MUST_BE_IGNORED) {
    if (existsSync(join(BUNDLE, rel)) && !tracked.includes(rel)) localOnly.push(rel);
  }
}

// ---- 3. scan publishable files -----------------------------------------
let scanned = 0;
for (const file of publishable) {
  const rel = relative(BUNDLE, file).split('\\').join('/');
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const ext = dot === -1 ? '' : base.slice(dot);
  if (!TEXT_EXT.has(ext)) continue;

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  scanned += 1;
  const seen = new Set();
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [label, re] of PATTERNS) {
      if (label === 'assigned token field' && PLACEHOLDER.test(line)) continue;
      const m = line.match(re);
      if (!m) continue;
      const key = `${rel}:${i + 1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const shown = (m[2] || m[0]).replace(/^.*[:=]\s*"?/, '');
      problems.push(`${rel}:${i + 1}  ${label}: ${mask(shown)}`);
    }
  });
}

// ---- 4. bounded git-history scan ---------------------------------------
if (inRepo && history) {
  try {
    const log = git(['log', '--all', '-p', '--no-color', '-n', '200'], { maxBuffer: 64 * 1024 * 1024 });
    const lines = log.split(/\r?\n/);
    for (const [label, re] of PATTERNS) {
      const rex = new RegExp(re.source, re.flags.replace('g', ''));
      const hit = lines.some((line) => {
        if (label === 'assigned token field' && PLACEHOLDER.test(line)) return false;
        return rex.test(line);
      });
      if (hit) {
        problems.push(`git history contains a ${label} (last 200 commits) — rewrite history before publishing`);
      }
    }
  } catch (err) {
    problems.push(`history scan skipped: ${String(err.message).split('\n')[0]}`);
  }
}

// ---- 5. report ---------------------------------------------------------
console.log(`bundle      : ${BUNDLE}`);
console.log(`git repo    : ${inRepo ? 'yes' : 'no (working-tree scan only)'}`);
console.log(`publishable : ${scanned} file(s) scanned` +
  (inRepo ? '  [tracked + untracked-not-ignored]' : ''));
if (localOnly.length) {
  console.log(`local-only  : ${localOnly.join(', ')}  (git-ignored, not published)`);
}

if (problems.length === 0) {
  console.log('result      : SAFE — nothing publishable carries a credential');
  process.exit(0);
}

console.error('\nresult      : NOT SAFE TO PUBLISH');
for (const p of problems) console.error(`  - ${p}`);
process.exit(1);
