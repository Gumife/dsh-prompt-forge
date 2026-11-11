/**
 * dev.mjs — the tight loop for editing this plugin.
 *
 * Why this exists: the two halves have very different reload costs, and
 * guessing which one you are looking at wastes the most time.
 *
 *   client.js  -> the Web half. The host stat-polls every graph row bundle
 *                 every 500ms (@deepseek-ai/dsh-client-hmr), so a save is
 *                 picked up in about a second and only that module reloads.
 *                 No restart, no page refresh.
 *
 *   index.js   -> the Host half. Imported once by the loader and never
 *                 replaced while the process lives: dsh-hmr detects the
 *                 change and warns "changed modules keep running their
 *                 previous code until a restart" instead of hot-swapping.
 *                 A restart is required.
 *
 * So: prove Host logic with verify-host.mjs (imports index.js directly, no
 * host involved, ~160ms), and spend restarts only when the RUNNING process
 * must serve the new code.
 *
 * Usage:
 *   node dev.mjs check    run all three suites, one-line verdict each
 *   node dev.mjs watch    re-run verify-host on every index.js save
 *   node dev.mjs stale    is the RUNNING host older than my source?
 */
import { spawnSync } from 'node:child_process';
import { watchFile, statSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac } from 'node:crypto';
import { discoverAuthority } from './host-authority.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
const b64url = (buf) => Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

/** Run one suite as a child. Both streams go through real file descriptors:
 *  a confined sandbox refuses capturing a child stdout through a pipe. */
function runSuite(script) {
  const dir = mkdtempSync(join(tmpdir(), 'pf-dev-'));
  const outFile = join(dir, 'out.txt');
  let fd;
  try {
    fd = openSync(outFile, 'w');
    const started = Date.now();
    const res = spawnSync(node, [join(here, script)], {
      cwd: here,
      stdio: ['ignore', fd, fd],
      timeout: 120000,
    });
    closeSync(fd);
    fd = undefined;
    const text = readFileSync(outFile, 'utf8');
    return { code: res.status ?? 1, text, ms: Date.now() - started };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** The one line that actually says whether the suite passed. */
function verdictOf(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const fail = lines.filter((l) => l.startsWith('FAIL'));
  if (fail.length > 0) return { ok: false, line: fail[0] };
  const marker = lines.find((l) => /ALL GREEN|LIVE OK|^OK\b/.test(l));
  return { ok: true, line: marker ?? lines.at(-1) ?? '' };
}

async function check() {
  const suites = [['verify-host.mjs', 'host  '], ['verify-client.mjs', 'client'], ['verify-live.mjs', 'live  ']];
  let bad = 0;
  for (const [script, label] of suites) {
    const { code, text, ms } = runSuite(script);
    const v = verdictOf(text);
    const pass = code === 0 && v.ok;
    if (!pass) bad++;
    console.log((pass ? 'PASS' : 'FAIL') + '  ' + label + '  ' + String(ms).padStart(4) + 'ms  ' + v.line.slice(0, 108));
  }
  console.log(bad === 0 ? '\nall three suites pass.' : '\n' + bad + ' suite(s) failing.');
  process.exitCode = bad === 0 ? 0 : 1;
}

function watchHostHalf() {
  const target = join(here, 'index.js');
  console.log('watching index.js - every save runs verify-host.mjs (Ctrl+C to stop)');
  let running = false;
  let queued = false;
  const fire = () => {
    if (running) { queued = true; return; }
    running = true;
    const { code, text, ms } = runSuite('verify-host.mjs');
    const v = verdictOf(text);
    console.log((code === 0 && v.ok ? 'PASS' : 'FAIL') + '  ' + String(ms).padStart(4) + 'ms  ' + v.line.slice(0, 108));
    if (code !== 0) {
      for (const l of text.split('\n').filter((l) => l.trim().startsWith('FAIL'))) console.log('   ' + l.trim());
    }
    running = false;
    if (queued) { queued = false; fire(); }
  };
  watchFile(target, { interval: 250 }, (cur, prev) => {
    if (cur.mtimeMs !== prev.mtimeMs) fire();
  });
  fire();
}

/** Mint the same browser-session cookie the host's BrowserAuth mints, from the
 *  owner's credential record. The secret is never printed nor written. */
function mintCookie(authority) {
  const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8');
  const match = text.match(/client-connection\/browser-session:\s*\n\s*kind:\s*grant\s*\n\s*payload:\s*\n\s*version:\s*1\s*\n\s*secret:\s*(\S+)/);
  if (!match) throw new Error('browser-session secret record not found');
  const secret = Buffer.from(match[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  const issuedAt = Date.now();
  const payload = { version: 1, authority, issuedAt, expiresAt: issuedAt + 86400000 };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return 'dsh-auth-' + b64url(createHash('sha256').update(authority).digest()) + '=v1.' + body + '.' + sig;
}

/** The bundle rev the host derives from a client bundle file: SHA-1 over a
 *  fixed tag plus mtimeMs, ctimeMs and size, truncated to 12 hex chars. */
function bundleRev(file) {
  const st = statSync(file);
  const h = createHash('sha1').update('plugin-artifact').update('\0');
  for (const p of [String(st.mtimeMs), String(st.ctimeMs), String(st.size)]) {
    h.update(String(Buffer.byteLength(p)) + ':' + p);
  }
  return h.digest('hex').slice(0, 12);
}

/** The VERSION constant the Host half would report if it were reloaded now. */
function sourceVersion() {
  const text = readFileSync(join(here, 'index.js'), 'utf8');
  const match = text.match(/^const VERSION = '([^']+)';$/m);
  if (!match) throw new Error('VERSION constant not found in index.js');
  return match[1];
}

/** Ask the live host, for both halves, what code it is actually running. */
async function stale() {
  const { authority, source } = await discoverAuthority(process.argv[3]);
  const base = 'http://' + authority;
  const cookie = mintCookie(authority);

  console.log('host      : ' + authority + '  (via ' + source + ')');

  /* Host half: the version the running process reports vs the version on disk.
   * A mismatch is the only thing that ever requires a restart. */
  const expected = sourceVersion();
  let live;
  try {
    const res = await fetch(base + '/prompt-forge/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ command: 'config' }),
      signal: AbortSignal.timeout(5000),
    });
    live = (await res.json()).version;
  } catch (error) {
    console.log('index.js  : host half  unreachable (' + String(error?.message ?? error) + ')');
    console.log('client.js : web half   unknown');
    return;
  }
  const hostOk = live === expected;
  console.log('index.js  : host half  source ' + expected + ' / running ' + live
    + (hostOk ? '  -> up to date' : '  -> RESTART required'));

  /* Web half: the host stat-polls each bundle every 500ms and publishes the rev
   * it computed. If our computed rev already equals the published one, the
   * running page would load exactly the file on disk. */
  try {
    const shell = await (await fetch(base + '/', { headers: { cookie }, signal: AbortSignal.timeout(5000) })).text();
    const row = shell.match(new RegExp('"id":"dsh-prompt-forge","url":"[^"]*rev=([0-9a-f]+)"'));
    const published = row?.[1];
    const computed = bundleRev(join(here, 'client.js'));
    if (published === undefined) console.log('client.js : web half   not present in the served graph');
    else if (published === computed) console.log('client.js : web half   rev ' + computed + '  -> up to date (save is live)');
    else console.log('client.js : web half   disk ' + computed + ' / served ' + published + '  -> saving again or reload the page');
  } catch (error) {
    console.log('client.js : web half   unreadable (' + String(error?.message ?? error) + ')');
  }
}

/* Where the three local plugins write their failure diaries. Read-only here:
 * status reports what is there, it never writes or trims. */
function diaryDir() {
  const override = process.env.DSH_PLUGIN_LOG_DIR;
  if (typeof override === 'string' && override !== '') return override;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return home === '' ? '' : join(home, '.dsh', 'plugin-logs');
}

/* Newest failure per plugin, plus how many landed TODAY. The count is what
 * separates 'there are some lines' from 'this is happening right now': one
 * stale line from last week and twenty from this morning look identical if you
 * only print the last one. */
function diarySummary() {
  const dir = diaryDir();
  if (dir === '') return [];
  let names;
  try { names = readdirSync(dir).filter((n) => n.endsWith('.ndjson')); } catch { return []; }
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const rows = [];
  for (const file of names) {
    let lines;
    try { lines = readFileSync(join(dir, file), 'utf8').split('\n').filter((l) => l.trim() !== ''); } catch { continue; }
    if (lines.length === 0) continue;
    let last = null;
    let today = 0;
    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      last = entry;
      const at = Date.parse(entry.at);
      if (!Number.isNaN(at) && at >= midnight.getTime()) today += 1;
    }
    rows.push({ plugin: file.slice(0, -'.ndjson'.length), total: lines.length, today, last });
  }
  return rows.sort((a, b) => b.today - a.today || b.total - a.total);
}

/* One command answering the only three questions worth asking before touching
 * code: is the host running MY code, is the page running MY code, and has
 * anything been failing. stale answered the first two; the third was the
 * missing half, and it is the half a unit suite can never answer. */
async function status() {
  await stale();
  console.log('');
  const rows = diarySummary();
  if (rows.length === 0) {
    console.log('diary     : no recorded failures (' + (diaryDir() || 'no home dir') + ')');
    return;
  }
  console.log('diary     : ' + diaryDir());
  for (const row of rows) {
    const last = row.last ?? {};
    const when = typeof last.at === 'string' ? last.at : '?';
    const what = typeof last.message === 'string' ? last.message : '(no message)';
    console.log('  ' + row.plugin.padEnd(20) + String(row.today).padStart(3) + ' today / '
      + String(row.total).padStart(4) + ' total   last ' + when + '  ' + what.slice(0, 60));
  }
}

const mode = process.argv[2] ?? 'check';
if (mode === 'check') await check();
else if (mode === 'watch') watchHostHalf();
else if (mode === 'stale') await stale();
else if (mode === 'status') await status();
else {
  console.log('usage: node dev.mjs [check|watch|stale|status] [authority]');
  process.exitCode = 2;
}
