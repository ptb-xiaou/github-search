#!/usr/bin/env node
/**
 * github-search skill — GitHub REST API search client.
 *
 * Credential resolution order (first hit wins):
 *   1. --token <value>                       (discouraged: leaks into shell history)
 *   2. --token-file <path>                   (JSON {"token":"..."} or a bare token file)
 *   3. $GITHUB_SEARCH_CONFIG / $DSH_GITHUB_SEARCH_CONFIG  (path to a JSON config)
 *   4. --config <path>                       (explicit JSON config)
 *   5. $GITHUB_TOKEN / $GH_TOKEN
 *   6. $DSH_HOME/secrets/github-search.json  (~/.dsh/secrets/github-search.json)
 *   7. <bundle>/.secrets/github-search.json  (git-ignored, portable)
 *   8. `gh auth token`                       (GitHub CLI, if installed)
 *
 * The token is never printed in full; errors carry a masked prefix only.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = resolve(HERE, '..');
const DEFAULT_API = 'https://api.github.com';
const DEFAULT_UA = 'dsh-github-search-skill/1.0';
const API_VERSION = '2022-11-28';

// ---------------------------------------------------------------- args

/** Flags that never consume the next token. */
const BOOLEAN_FLAGS = new Set([
  'json', 'help', 'dry-run', 'yes', 'no-wait',
  'public', 'private', 'auto-init', 'no-issues', 'wiki', 'archive', 'unarchive',
]);

/** Single-dash aliases. */
const SHORT_FLAGS = { m: 'message', h: 'help' };

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }

    let key;
    let value;
    let takesValue;

    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        key = a.slice(2, eq);
        value = a.slice(eq + 1);
        takesValue = false;
      } else {
        key = a.slice(2);
        takesValue = !BOOLEAN_FLAGS.has(key);
      }
    } else if (/^-[A-Za-z]$/.test(a)) {
      key = SHORT_FLAGS[a[1]] || a[1];
      takesValue = !BOOLEAN_FLAGS.has(key);
    } else {
      positional.push(a);
      continue;
    }

    if (takesValue) {
      const next = argv[i + 1];
      value = next !== undefined && !next.startsWith('-') ? argv[++i] : true;
    } else if (value === undefined) {
      value = true;
    }

    if (key === 'param') {
      (flags.param ||= []).push(value);
    } else {
      flags[key] = value;
    }
  }
  return { positional, flags };
}

const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

// ------------------------------------------------------- credentials

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh');

function readJsonFile(path) {
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) throw new Error('file is empty');
  if (!raw.startsWith('{')) return { token: raw }; // bare token file
  return JSON.parse(raw);
}

function candidateConfigs(flags) {
  const list = [];
  if (typeof flags.config === 'string') {
    list.push({ path: resolve(flags.config), source: 'flag:--config' });
  }
  for (const name of ['GITHUB_SEARCH_CONFIG', 'DSH_GITHUB_SEARCH_CONFIG']) {
    if (process.env[name]) {
      list.push({ path: resolve(process.env[name]), source: `env:${name}` });
    }
  }
  list.push({
    path: join(dshHome(), 'secrets', 'github-search.json'),
    source: `user:${join(dshHome(), 'secrets', 'github-search.json')}`,
  });
  list.push({
    path: join(BUNDLE, '.secrets', 'github-search.json'),
    source: `bundle:${join(BUNDLE, '.secrets', 'github-search.json')}`,
  });
  return list;
}

function mask(token) {
  if (!token) return '(none)';
  const t = String(token).trim();
  if (t.length <= 12) return `${t.slice(0, 3)}***`;
  return `${t.slice(0, 7)}…${t.slice(-4)}`;
}

function resolveCredentials(flags) {
  if (typeof flags.token === 'string') {
    return { token: flags.token.trim(), source: 'flag:--token', warning: 'token passed on the command line' };
  }

  if (typeof flags['token-file'] === 'string') {
    const p = resolve(flags['token-file']);
    const cfg = readJsonFile(p);
    if (!cfg.token) throw new Error(`no "token" key in ${p}`);
    return { token: String(cfg.token).trim(), source: `flag:--token-file ${p}`, config: cfg };
  }

  for (const cand of candidateConfigs(flags)) {
    if (!existsSync(cand.path)) continue;
    try {
      const cfg = readJsonFile(cand.path);
      if (cfg.token) {
        return { token: String(cfg.token).trim(), source: cand.source, config: cfg };
      }
    } catch (err) {
      process.stderr.write(`[warn] ignoring unreadable config ${cand.path}: ${err.message}\n`);
    }
  }

  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    if (process.env[name]) return { token: process.env[name].trim(), source: `env:${name}` };
  }

  const gh = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 15000 });
  if (gh.status === 0 && (gh.stdout || '').trim()) {
    return { token: gh.stdout.trim(), source: 'gh auth token' };
  }

  return { token: null, source: null };
}

function requireToken(flags) {
  const cred = resolveCredentials(flags);
  if (!cred.token) {
    process.stderr.write(
      [
        'No GitHub token found.',
        'Configure one of:',
        `  - ${join(dshHome(), 'secrets', 'github-search.json')}   (recommended, outside any git repo)`,
        `      {"token": "ghp_..."}`,
        `  - ${join(BUNDLE, '.secrets', 'github-search.json')}     (git-ignored bundle-local copy)`,
        '  - environment variable GITHUB_TOKEN or GH_TOKEN',
        '  - --token-file <path>',
        'See README.md in the skill bundle.',
      ].join('\n') + '\n',
    );
    process.exit(3);
  }
  return cred;
}

// ----------------------------------------------------------- transport

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ApiError extends Error {
  constructor(status, message, meta = {}) {
    super(message);
    this.status = status;
    Object.assign(this, meta);
  }
}

async function callApi(url, { token, maxWaitMs = 70000, noWait = false, method = 'GET', body } = {}) {
  for (;;) {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': DEFAULT_UA,
    };
    let payload;
    if (body !== undefined && body !== null) {
      headers['Content-Type'] = 'application/json';
      payload = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const res = await fetch(url, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(45000),
    });

    const h = res.headers;
    const rate = {
      limit: Number(h.get('x-ratelimit-limit') || 0),
      remaining: Number(h.get('x-ratelimit-remaining') || 0),
      reset: Number(h.get('x-ratelimit-reset') || 0),
      resource: h.get('x-ratelimit-resource') || '',
      retryAfter: Number(h.get('retry-after') || 0),
      scopes: h.get('x-oauth-scopes') || '',
    };

    if (res.status === 403 || res.status === 429) {
      let body = '';
      try {
        body = await res.text();
      } catch {
        /* ignore */
      }
      const isPrimary = rate.remaining === 0 && rate.reset > 0;
      const waitMs = rate.retryAfter
        ? rate.retryAfter * 1000
        : isPrimary
          ? Math.max(0, rate.reset * 1000 - Date.now()) + 1000
          : 0;

      if (waitMs > 0 && !noWait && waitMs <= maxWaitMs) {
        process.stderr.write(`[rate] ${rate.resource} limit hit; waiting ${Math.ceil(waitMs / 1000)}s\n`);
        await sleep(waitMs);
        continue;
      }

      const hint = isPrimary
        ? `search API allows ${rate.limit || 30} requests/minute; retry in ${Math.ceil(waitMs / 1000)}s`
        : 'secondary rate limit or insufficient token scope';
      throw new ApiError(res.status, `HTTP 403 from GitHub — ${hint}`, { rate, body: body.slice(0, 400) });
    }

    if (!res.ok) {
      let body = '';
      try {
        body = await res.text();
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, `HTTP ${res.status} from GitHub`, { rate, body: body.slice(0, 400) });
    }

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { data, rate, status: res.status };
  }
}

// ------------------------------------------------------------ output

function rateLine(rate) {
  if (!rate || !rate.resource) return '';
  const secs = rate.reset ? Math.max(0, Math.round(rate.reset - Date.now() / 1000)) : 0;
  return `[rate] ${rate.resource} ${rate.remaining}/${rate.limit} reset in ${secs}s`;
}

function truncate(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function printRepos(data) {
  console.log(`total_count: ${data.total_count}  (showing ${data.items.length})`);
  for (const r of data.items) {
    console.log(
      `- ${r.full_name}  ★${r.stargazers_count}  fork=${r.forks_count}  ${r.language || 'n/a'}  updated ${(r.updated_at || '').slice(0, 10)}\n    ${truncate(r.description, 140)}\n    ${r.html_url}`,
    );
  }
}

function printCode(data) {
  console.log(`total_count: ${data.total_count}  (showing ${data.items.length})`);
  for (const f of data.items) {
    console.log(`- ${f.repository.full_name}  ${f.path}\n    ${f.html_url}`);
  }
}

function printIssues(data) {
  console.log(`total_count: ${data.total_count}  (showing ${data.items.length})`);
  for (const i of data.items) {
    const repo = (i.repository_url || '').replace('https://api.github.com/repos/', '');
    const kind = i.pull_request ? 'PR' : 'issue';
    console.log(`- ${repo}#${i.number} [${i.state}] (${kind}) ${truncate(i.title, 120)}\n    ${i.html_url}`);
  }
}

function printCommits(data) {
  console.log(`total_count: ${data.total_count}  (showing ${data.items.length})`);
  for (const c of data.items) {
    const repo = (c.repository?.full_name) || '?';
    console.log(`- ${repo} ${(c.sha || '').slice(0, 8)} ${truncate(c.commit?.message, 110)}\n    ${c.html_url}`);
  }
}

function printUsers(data) {
  console.log(`total_count: ${data.total_count}  (showing ${data.items.length})`);
  for (const u of data.items) {
    console.log(`- ${u.login}  ${u.type}  ${u.html_url}`);
  }
}

function splitList(value) {
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Validate and normalise "owner/name"; also accepts a full API or html URL. */
function repoSlug(arg) {
  if (!arg) throw new Error('this command needs <owner/repo>');
  let s = String(arg).trim();
  s = s.replace(/^https?:\/\/[^/]+\//, '').replace(/^repos\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!/^[^/\s]+\/[^/\s]+$/.test(s)) throw new Error(`expected <owner/repo>, got "${arg}"`);
  return s;
}

function printRepoSummary(r) {
  const flags = [r.private ? 'private' : 'public', r.archived ? 'archived' : null, r.fork ? 'fork' : null]
    .filter(Boolean)
    .join(', ');
  console.log(`${r.full_name}  (${flags})`);
  console.log(`  description : ${truncate(r.description, 200) || '(none)'}`);
  console.log(`  branch      : ${r.default_branch}`);
  console.log(`  stars/forks : ${r.stargazers_count}/${r.forks_count}`);
  console.log(`  open issues : ${r.open_issues_count}`);
  console.log(`  license     : ${(r.license && r.license.spdx_id) || '(none)'}`);
  console.log(`  topics      : ${(r.topics || []).join(', ') || '(none)'}`);
  console.log(`  size        : ${r.size} KB`);
  console.log(`  created     : ${r.created_at}`);
  console.log(`  pushed      : ${r.pushed_at}`);
  console.log(`  url         : ${r.html_url}`);
}

function printRepoList(items) {
  console.log(`${items.length} repositor${items.length === 1 ? 'y' : 'ies'}`);
  for (const r of items) {
    console.log(
      `- ${r.full_name}  ${r.private ? 'private' : 'public'}  ★${r.stargazers_count}  updated ${(r.updated_at || '').slice(0, 10)}\n    ${truncate(r.description, 120) || '(no description)'}\n    ${r.html_url}`,
    );
  }
}

const PER_PAGE_MAX = 100;

// ------------------------------------------------ publish (git + gate)

function gitAt(dir, args, extraEnv = {}) {
  return spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
  });
}

/** Auth for git over HTTPS without ever writing the token to .git/config. */
function authEnv(token) {
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

function redact(text, token) {
  if (!text) return '';
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  return String(text).split(token).join('***').split(basic).join('***');
}

const errText = (r) => `${r.stderr || ''}${r.stdout || ''}`.trim();

async function runPublish({ dir, flags, token, dryRun }) {
  if (!existsSync(dir)) throw new Error(`directory not found: ${dir}`);
  // 1. the gate decides — nothing gets committed or pushed unless it says SAFE
  const gate = spawnSync(process.execPath, [join(BUNDLE, 'scripts', 'check-public-safe.mjs'), '--history'], {
    cwd: dir,
    encoding: 'utf8',
  });
  process.stdout.write(gate.stdout || '');
  if (gate.error) throw new Error(`could not run the publish gate: ${gate.error.message}`);
  if (gate.status !== 0) {
    process.stderr.write(redact(gate.stderr || '', token));
    throw new Error('publish gate failed — refusing to commit or push');
  }

  const inside = gitAt(dir, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0) throw new Error(`${dir} is not a git repository (run "git init -b main" first)`);

  const remote = typeof flags.remote === 'string' ? flags.remote : 'origin';
  const remoteUrl = (gitAt(dir, ['remote', 'get-url', remote]).stdout || '').trim();
  if (!remoteUrl) {
    throw new Error(
      `git remote "${remote}" is not configured — add one first:\n  git -C "${dir}" remote add ${remote} https://github.com/<owner>/<repo>.git`,
    );
  }

  const branch =
    (typeof flags.branch === 'string' && flags.branch) ||
    (gitAt(dir, ['symbolic-ref', '--short', 'HEAD']).stdout || '').trim() ||
    'main';
  const message =
    (typeof flags.message === 'string' && flags.message) ||
    (typeof flags.m === 'string' && flags.m) ||
    `Update ${new Date().toISOString().slice(0, 10)}`;

  if (dryRun) {
    const changes = (gitAt(dir, ['status', '--porcelain']).stdout || '')
      .split('\n')
      .map((s) => s.trimEnd())
      .filter(Boolean);
    if (!changes.length) console.log('[publish] nothing to commit');
    else {
      console.log(`[publish] would commit ${changes.length} path(s):`);
      for (const c of changes.slice(0, 30)) console.log(`  ${c}`);
      if (changes.length > 30) console.log(`  … and ${changes.length - 30} more`);
    }
    console.log(`[dry-run] git commit -m "${message}"`);
    console.log(`[dry-run] git push -u ${remote} ${branch}`);
    return;
  }

  const add = gitAt(dir, ['add', '-A']);
  if (add.status !== 0) throw new Error(redact(errText(add), token) || 'git add failed');

  const staged = (gitAt(dir, ['diff', '--cached', '--name-only']).stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!staged.length) {
    console.log('[publish] nothing to commit');
  } else {
    console.log(`[publish] staged ${staged.length} file(s):`);
    for (const f of staged.slice(0, 30)) console.log(`  ${f}`);
    if (staged.length > 30) console.log(`  … and ${staged.length - 30} more`);
    const commit = gitAt(dir, ['commit', '-m', message]);
    if (commit.status !== 0) throw new Error(redact(errText(commit), token) || 'git commit failed');
    console.log(`[publish] commit ${(gitAt(dir, ['log', '--oneline', '-1']).stdout || '').trim()}`);
  }

  console.log(`[publish] pushing ${branch} -> ${remote} (${remoteUrl.replace(/\/\/[^@/]+@/, '//')})`);
  const push = gitAt(dir, ['push', '-u', remote, branch], authEnv(token));
  if (push.status !== 0) throw new Error(redact(errText(push), token) || 'git push failed');
  console.log('[publish] push OK');
}

function buildUrl(base, path, params) {
  const url = new URL(path.startsWith('http') ? path : `${base}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

// -------------------------------------------------------------- main

const HELP = `github-search — GitHub REST search + repository client

Usage:
  node scripts/gh-search.mjs <command> [argument] [flags]

Search:
  repo   <query>                   search repositories
  code   <query>                   search code (exact file contents, qualifiers supported)
  issues <query>                   search issues and pull requests
  commits <query>                  search commits
  users  <query>                   search users and organizations

Repository management:
  repo-create <name>               create a repository (PRIVATE unless --public)
  repo-view   <owner/repo>         show one repository
  repo-list                        list repositories you own
  repo-edit   <owner/repo>         update description/homepage/visibility/topics/archive
  repo-delete <owner/repo> --yes   delete a repository (irreversible)
  publish [dir]                    run the publish gate, commit, then push

Diagnostics:
  check                            validate the token, print scopes and rate limits
  config                           show which credential source is in use (masked)
  limit                            print current rate-limit buckets
  api    <path>                    call any REST path, e.g. "repos/nodejs/node"

Search flags:
  --limit <n>        results to return (default 10, max 100)
  --sort <field>     repo: stars|forks|updated|help-wanted-issues ; issues: created|updated|comments
  --order <dir>      asc|desc (default desc)
  --state <s>        issues: open|closed
  --param k=v        extra query parameter for "api" (repeatable)
  --json             print the raw JSON payload

Repository flags:
  --public | --private      visibility (repo-create defaults to private)
  --desc <text>             description (create/edit)
  --homepage <url>          homepage (create/edit)
  --topics a,b,c            topics; on repo-edit this REPLACES the whole list
  --org <name>              create inside an organisation
  --name <new>              rename the repository (repo-edit)
  --default-branch <name>   set the default branch (repo-edit)
  --archive | --unarchive   archive or unarchive (repo-edit)
  --auto-init, --no-issues, --wiki, --gitignore <t>, --license <t>   repo-create extras
  --affiliation <a>, --visibility <v>, --type <t>                    repo-list filters

Write flags:
  --dry-run          print the request instead of sending it
  --yes              required by repo-delete
  --method <verb>    api: GET|POST|PATCH|PUT|DELETE (default GET)
  --data <json>      api: request body (implies POST unless --method is given)

publish flags:
  -m, --message <text>   commit message (default "Update <date>")
  --remote <name>        git remote to push to (default origin)
  --branch <name>        branch to push (default: current branch)

Credential flags:
  --token-file <p>   credential file to use
  --config <p>       JSON config to use
  --no-wait          fail instead of waiting out a rate limit
  --max-wait <sec>   cap on automatic waiting (default 70)

Query qualifiers: see references/search-syntax.md
Examples:
  node scripts/gh-search.mjs repo "agent framework language:python stars:>1000" --limit 5
  node scripts/gh-search.mjs code "repo:torvalds/linux define MAX_ORDER"
  node scripts/gh-search.mjs repo-create my-tool --public --desc "my tool" --topics cli,nodejs
  node scripts/gh-search.mjs repo-edit ptb-xiaou/my-tool --desc "new description"
  node scripts/gh-search.mjs repo-list --limit 20
  node scripts/gh-search.mjs publish -m "feat: initial commit"
  node scripts/gh-search.mjs api repos/ptb-xiaou --param per_page=5
`;

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  const query = positional[1];
  const limit = Math.min(num(flags.limit, 10), PER_PAGE_MAX);
  const noWait = flags['no-wait'] === true;
  const maxWaitMs = num(flags['max-wait'], 70) * 1000;
  const asJson = flags.json === true;

  if (!cmd || cmd === 'help' || flags.help) {
    process.stdout.write(HELP);
    return;
  }

  if (cmd === 'config' || cmd === 'where') {
    const active = resolveCredentials(flags);
    console.log(`active source : ${active.source || '(none)'}`);
    console.log(`active token  : ${mask(active.token)}`);
    console.log('candidates    :');
    for (const c of candidateConfigs(flags)) {
      console.log(`  ${existsSync(c.path) ? 'present' : 'missing'}  ${c.path}  [${c.source}]`);
    }
    for (const name of ['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_SEARCH_CONFIG', 'DSH_GITHUB_SEARCH_CONFIG']) {
      console.log(`  env ${name}: ${process.env[name] ? 'set' : 'unset'}`);
    }
    return;
  }

  const cred = requireToken(flags);
  const base = cred.config?.apiBase || process.env.GITHUB_API_BASE || DEFAULT_API;

  if (cmd === 'check') {
    const [me, limits] = await Promise.all([
      callApi(`${base}/user`, { token: cred.token }),
      callApi(`${base}/rate_limit`, { token: cred.token }),
    ]);
    console.log(`token source : ${cred.source}`);
    console.log(`token        : ${mask(cred.token)}`);
    if (cred.warning) console.log(`warning      : ${cred.warning}`);
    console.log(`login        : ${me.data.login} (${me.data.type})`);
    console.log(`scopes       : ${me.rate.scopes || '(none)'}`);
    if ((me.rate.scopes || '').split(',').map((s) => s.trim()).includes('repo')) {
      console.log('note         : "repo" scope grants read/write access to all your private repositories.');
    }
    console.log(`core         : ${limits.data.resources.core.remaining}/${limits.data.resources.core.limit}`);
    console.log(`search       : ${limits.data.resources.search.remaining}/${limits.data.resources.search.limit} per minute`);
    return;
  }

  if (cmd === 'limit') {
    const { data } = await callApi(`${base}/rate_limit`, { token: cred.token });
    if (asJson) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    for (const [name, r] of Object.entries(data.resources)) {
      console.log(`${name.padEnd(16)} ${r.remaining}/${r.limit}  resets in ${Math.max(0, r.reset - Math.round(Date.now() / 1000))}s`);
    }
    return;
  }

  // ---------------------------------------------- repository management
  const dryRun = flags['dry-run'] === true;
  const send = async (method, target, body) => {
    const url = target.startsWith('http') ? target : `${base}${target.startsWith('/') ? '' : '/'}${target}`;
    if (dryRun) {
      console.log(`[dry-run] ${method} ${url}`);
      if (body) console.log(JSON.stringify(body, null, 2));
      return { data: null, rate: null, status: 0 };
    }
    return callApi(url, { token: cred.token, method, body, noWait, maxWaitMs });
  };

  if (cmd === 'repo-create' || cmd === 'repo-new') {
    if (!query) throw new Error('repo-create requires a repository name');
    const visibility =
      (typeof flags.visibility === 'string' && flags.visibility) ||
      (flags.public === true ? 'public' : 'private');
    if (!['public', 'private'].includes(visibility)) {
      throw new Error('--visibility must be "public" or "private"');
    }
    if (visibility === 'private' && flags.public !== true) {
      console.log('[note] no --public flag given; creating a PRIVATE repository');
    }
    const body = {
      name: query,
      private: visibility === 'private',
      description: flags.desc || flags.description || undefined,
      homepage: flags.homepage || undefined,
      has_issues: flags['no-issues'] === true ? false : undefined,
      has_wiki: flags.wiki === true ? true : undefined,
      auto_init: flags['auto-init'] === true ? true : undefined,
      gitignore_template: flags.gitignore || undefined,
      license_template: flags.license || undefined,
    };
    const target = typeof flags.org === 'string' ? `/orgs/${flags.org}/repos` : '/user/repos';
    const { data } = await send('POST', target, body);
    if (dryRun) return;
    console.log(`created : ${data.full_name}  (${data.private ? 'private' : 'public'})`);
    console.log(`  url   : ${data.html_url}`);
    console.log(`  clone : ${data.clone_url}`);
    if (flags.topics) {
      const topics = splitList(flags.topics);
      await send('PUT', `/repos/${data.full_name}/topics`, { names: topics });
      console.log(`  topics: ${topics.join(', ')}`);
    }
    console.log(`next    : git remote add origin ${data.clone_url}  &&  node scripts/gh-search.mjs publish -m "initial commit"`);
    return;
  }

  if (cmd === 'repo-view' || cmd === 'repo-info') {
    const slug = repoSlug(query);
    const { data } = await send('GET', `/repos/${slug}`);
    if (dryRun) return;
    if (asJson) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    printRepoSummary(data);
    return;
  }

  if (cmd === 'repo-list' || cmd === 'my-repos') {
    const url = buildUrl(base, '/user/repos', {
      per_page: limit,
      affiliation: typeof flags.affiliation === 'string' ? flags.affiliation : 'owner',
      visibility: typeof flags.visibility === 'string' ? flags.visibility : undefined,
      type: typeof flags.type === 'string' ? flags.type : undefined,
      sort: typeof flags.sort === 'string' ? flags.sort : 'updated',
      direction: typeof flags.order === 'string' ? flags.order : 'desc',
    });
    const { data, rate } = await send('GET', url);
    if (dryRun) return;
    if (asJson) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    printRepoList(Array.isArray(data) ? data : []);
    const rl = rateLine(rate);
    if (rl) process.stderr.write(`${rl}\n`);
    return;
  }

  if (cmd === 'repo-edit' || cmd === 'repo-update') {
    const slug = repoSlug(query);
    const body = {};
    if (typeof flags.desc === 'string' || typeof flags.description === 'string') {
      body.description = flags.desc || flags.description;
    }
    if (typeof flags.homepage === 'string') body.homepage = flags.homepage;
    if (typeof flags.name === 'string') body.name = flags.name;
    if (typeof flags['default-branch'] === 'string') body.default_branch = flags['default-branch'];
    if (flags.public === true) body.private = false;
    if (flags.private === true) body.private = true;
    if (flags.archive === true) body.archived = true;
    if (flags.unarchive === true) body.archived = false;

    if (!Object.keys(body).length && !flags.topics) {
      throw new Error(
        'repo-edit needs at least one of --desc --homepage --name --default-branch --public --private --archive --unarchive --topics',
      );
    }
    if (Object.keys(body).length) {
      const { data } = await send('PATCH', `/repos/${slug}`, body);
      if (dryRun) return;
      console.log(
        `updated : ${data.full_name}  (${data.private ? 'private' : 'public'}${data.archived ? ', archived' : ''})`,
      );
      console.log(`  url   : ${data.html_url}`);
    }
    if (flags.topics) {
      const topics = splitList(flags.topics);
      await send('PUT', `/repos/${slug}/topics`, { names: topics });
      if (!dryRun) console.log(`  topics: ${topics.join(', ') || '(none)'}  (replaces the whole list)`);
    }
    return;
  }

  if (cmd === 'repo-delete' || cmd === 'repo-rm') {
    const slug = repoSlug(query);
    if (flags.yes !== true && !dryRun) {
      throw new Error(
        `refusing to delete ${slug} without --yes — deletion is irreversible and drops settings, issues, releases and stars`,
      );
    }
    console.log(`deleting: ${slug}`);
    try {
      await send('DELETE', `/repos/${slug}`);
    } catch (err) {
      if (err.status === 403) {
        throw new Error(
          `cannot delete ${slug}: the token is missing the "delete_repo" scope.\n` +
            'Classic PATs need that scope on its own — "repo" is not enough. Add it at\n' +
            'https://github.com/settings/tokens (edit the token → check delete_repo),\n' +
            `or delete the repository in the web UI: https://github.com/${slug}/settings`,
        );
      }
      throw err;
    }
    if (dryRun) return;
    console.log(`deleted : ${slug}`);
    return;
  }

  if (cmd === 'publish') {
    const dir = resolve(typeof query === 'string' ? query : process.cwd());
    await runPublish({ dir, flags, token: cred.token, dryRun });
    return;
  }

  let path;
  let params = {};
  let render = null;
  let method = 'GET';
  let reqBody;

  switch (cmd) {
    case 'repo':
    case 'repos': {
      if (!query) throw new Error('repo requires a query');
      path = '/search/repositories';
      params = {
        q: query,
        per_page: limit,
        sort: flags.sort || undefined,
        order: flags.order || (flags.sort ? 'desc' : undefined),
      };
      render = printRepos;
      break;
    }
    case 'code': {
      if (!query) throw new Error('code requires a query');
      path = '/search/code';
      params = { q: query, per_page: limit, sort: flags.sort || undefined, order: flags.order || undefined };
      render = printCode;
      break;
    }
    case 'issues': {
      if (!query) throw new Error('issues requires a query');
      path = '/search/issues';
      params = {
        q: query,
        per_page: limit,
        sort: flags.sort || undefined,
        order: flags.order || (flags.sort ? 'desc' : undefined),
      };
      render = printIssues;
      break;
    }
    case 'commits': {
      if (!query) throw new Error('commits requires a query');
      path = '/search/commits';
      params = { q: query, per_page: limit, sort: flags.sort || undefined, order: flags.order || undefined };
      render = printCommits;
      break;
    }
    case 'users': {
      if (!query) throw new Error('users requires a query');
      path = '/search/users';
      params = { q: query, per_page: limit, sort: flags.sort || undefined, order: flags.order || undefined };
      render = printUsers;
      break;
    }
    case 'api': {
      if (!query) throw new Error('api requires a path, e.g. "repos/nodejs/node"');
      path = query.startsWith('/') ? query : `/${query}`;
      for (const kv of flags.param || []) {
        const idx = String(kv).indexOf('=');
        if (idx === -1) throw new Error(`--param expects k=v, got ${kv}`);
        params[String(kv).slice(0, idx)] = String(kv).slice(idx + 1);
      }
      if (typeof flags.method === 'string') method = flags.method.toUpperCase();
      if (flags.data !== undefined) {
        reqBody = flags.data;
        if (typeof reqBody === 'string') {
          try {
            reqBody = JSON.parse(reqBody);
          } catch {
            /* not JSON — send the string as-is */
          }
        }
        if (method === 'GET') method = 'POST';
      }
      break;
    }
    default:
      throw new Error(`unknown command "${cmd}" — run with --help`);
  }

  const url = buildUrl(base, path, params);
  if (dryRun) {
    console.log(`[dry-run] ${method} ${url}`);
    if (reqBody !== undefined) console.log(JSON.stringify(reqBody, null, 2));
    return;
  }

  const { data, rate } = await callApi(url, {
    token: cred.token,
    noWait,
    maxWaitMs,
    method,
    body: reqBody,
  });

  if (asJson) {
    console.log(JSON.stringify(data, null, 2));
  } else if (render) {
    render(data);
  } else if (data === null || data === '') {
    console.log('(no content — the API returned an empty success body)');
  } else {
    console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  }

  const rl = rateLine(rate);
  if (rl) process.stderr.write(`${rl}\n`);
}

main().catch((err) => {
  if (err instanceof ApiError) {
    process.stderr.write(`error: ${err.message}\n`);
    if (err.body) process.stderr.write(`detail: ${err.body}\n`);
    const rl = rateLine(err.rate);
    if (rl) process.stderr.write(`${rl}\n`);
    process.exit(1);
  }
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
});
