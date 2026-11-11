/**
 * verify-live.mjs — proves the P1 code is actually LOADED by the running host.
 *
 * The unit suites (verify-host / verify-client) prove the source is correct;
 * this one proves the process is serving it. It answers three questions:
 *   1. does `config` report the package version / stage P3 / rewrite:true?
 *   2. does an unauthenticated request get 401 (not 403)? 401 means the fence
 *      fix is live; 403 means the old P0 build is still running.
 *   3. does an authenticated request get 200?
 *
 * It mints the same browser-session cookie the host's BrowserAuth would mint,
 * from the owner's own credential record. The secret is never printed and
 * never written to disk.
 *
 * A 401 on a cookie minted seconds earlier is treated as TRANSIENT and retried.
 * The fence can answer 401 for one request while the session store is still
 * warming up (or while the host is mid-restart), and the same build answers 200
 * immediately afterwards. Reporting that as "the old build is still running"
 * sends someone to restart a healthy host and destroys the signal this suite
 * exists to provide — so the verdict below distinguishes an auth problem from a
 * stale build instead of collapsing both into one guess.
 *
 * Usage: node verify-live.mjs [authority] [sessionId]
 *
 * The authority is DISCOVERED, not hardcoded. The Desktop host picks a fresh
 * port on every restart, so a baked-in value turns this suite into a test of
 * whether the host happens to be on yesterday's port. Resolution order:
 *   1. argv[2]            — explicit override wins, for pinning a known host.
 *   2. $DSH_WEB_URL       — the harness exports the live GUI URL into every
 *                           child process; this is the authoritative answer.
 *   3. port scan          — last resort for shells without the env var: probe
 *                           the loopback listeners for the one that answers
 *                           /prompt-forge/api (401 counts: the route exists).
 */
import { readFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { discoverAuthority } from './host-authority.mjs';

const { authority, source } = await discoverAuthority(process.argv[2]);
const base = 'http://' + authority;
/* Read the expected version instead of hardcoding it: a hardcoded copy turns
 * every release into a test edit, and a forgotten edit turns a real regression
 * into a green run. */
const EXPECTED_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

let failures = 0;
const ok = (label, cond, extra = '') => {
  if (cond) console.log('  ok   ' + label + (extra ? ' — ' + extra : ''));
  else { failures++; console.log('  FAIL ' + label + (extra ? ' — ' + extra : '')); }
};

const b64url = (buf) => Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

function mintCookie() {
  const file = join(homedir(), '.dsh', '.credentials.yaml');
  const text = readFileSync(file, 'utf8');
  const re = /client-connection\/browser-session:\s*\n\s*kind:\s*grant\s*\n\s*payload:\s*\n\s*version:\s*1\s*\n\s*secret:\s*(\S+)/;
  const match = text.match(re);
  if (!match) throw new Error('browser-session secret record not found');
  const secret = Buffer.from(match[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  if (secret.byteLength !== 32) throw new Error('secret is not 32 bytes: ' + secret.byteLength);

  const issuedAt = Date.now();
  const payload = { version: 1, authority, issuedAt, expiresAt: issuedAt + 30 * 24 * 60 * 60 * 1000 };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  const name = 'dsh-auth-' + b64url(createHash('sha256').update(authority).digest());
  return name + '=v1.' + body + '.' + sig;
}

/* Authenticated probes retry a 401 before believing it. A fence that answers
 * 401 to a cookie minted a second ago is far more often a warming/restarting
 * session store than a stale build, and the two are indistinguishable from a
 * single sample. Retrying converts a coin flip into evidence. */
const AUTH_RETRIES = 5;
const AUTH_RETRY_DELAY_MS = 250;
let authRetriesUsed = 0;
let authPersistent401 = false;

async function post(command, cookie, { retryAuth = false } = {}) {
  const attempts = retryAuth ? AUTH_RETRIES : 0;
  let last;
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(base + '/prompt-forge/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(command),
      });
      let body;
      try { body = await res.json(); } catch { body = undefined; }
      last = { status: res.status, body };
    } catch (err) {
      /* A refused connection during a host restart is the same transient class
       * as a 401: worth one more look, never worth a build verdict. */
      last = { status: 0, body: undefined, error: String((err && err.message) || err) };
    }
    const transient = last.status === 401 || last.status === 0;
    if (!transient || i >= attempts) break;
    authRetriesUsed++;
    await new Promise((resolve) => setTimeout(resolve, AUTH_RETRY_DELAY_MS));
  }
  if (retryAuth && last.status === 401) authPersistent401 = true;
  return last;
}

/* Authenticated call: retries transient auth refusals. */
const postAuthed = (command, cookie) => post(command, cookie, { retryAuth: true });

console.log('authority =', authority, '(discovered via ' + source + ')');

/* 1. unauthenticated → the fence must say 401, not 403. */
let r = await post({ command: 'config' }, null);
ok('unauthenticated is 401 (fence fix live)', r.status === 401, 'status=' + r.status);
ok('unauthenticated body says unauthorized', r.body?.error === 'unauthorized', JSON.stringify(r.body));

/* 2. authenticated config → the feature map. */
const cookie = mintCookie();
r = await postAuthed({ command: 'config' }, cookie);
ok('authenticated config is 200', r.status === 200, 'status=' + r.status);
ok('config version matches package.json (' + EXPECTED_VERSION + ')', r.body?.version === EXPECTED_VERSION, r.body?.version);
ok('config stage is P3', r.body?.stage === 'P3', r.body?.stage);
ok('config turns rewrite on', r.body?.capability?.rewrite === true);
ok('config turns the fact gate on', r.body?.capability?.hardFactGate === true);
ok('config turns acceptance on', r.body?.capability?.acceptance === true);
/* The cost fields are what distinguishes this build from the one before it:
 * a running process that predates them will answer every other assertion
 * above and still be stale. That is the failure this probe exists for. */
ok('config advertises a rate card', r.body?.pricing && typeof r.body.pricing === 'object');
ok('config rate card names its currency', r.body?.pricing?.currency === 'CNY', String(r.body?.pricing?.currency));
ok('config marks its prices as estimates', r.body?.pricing?.estimated === true);
ok('config turns workspace docs on', r.body?.contexts?.workspaceDocs === true);
ok('polish and acceptance are available', r.body?.modes?.[0]?.available === true && r.body?.modes?.[1]?.available === true);
/* A field only the CURRENT source advertises. Without this the whole suite can
 * pass against a host started before the latest index.js edit, because every
 * other assertion here was already true of the previous build — which is exactly
 * how a "LIVE OK" can be confidently wrong. */
ok('the running host was started from the current source (maxFactCount advertised)',
  r.body?.defaults?.maxFactCount === 40
  && r.body?.limits?.maxFactCount?.min === 5
  && r.body?.limits?.maxFactCount?.max === 200,
  JSON.stringify({ defaults: r.body?.defaults ?? null, limits: r.body?.limits ?? null }));

/* 2b. settings round-trip through the live route. A session id is required
 * for the workspace copy to resolve: without one the route degrades by design
 * (blank new session), so pass one when the caller supplies it, and always
 * report the host's real session shape via `diagnose` so a failure is never a
 * guess about which field carries the workspace.
 *
 * argv[3] falls back to $DSH_SESSION_ID. The harness exports that variable into
 * every child process, so the DEFAULT run is the strong one. Leaving it empty by
 * default made the weaker branch the one everyone ran: only the "degrades
 * without a workspace" assertion fired, `persisted === true` never executed, and
 * the suite printed LIVE OK over an untested persistence path. A guard that
 * silently skips its own strongest assertion is worse than no guard.
 *
 * The id must be the HOST's session id, which carries a `session-` prefix.
 * The directory name under ~/.dsh/sessions/<workspace>/ is the bare uuid used
 * for the on-disk log file — passing that one yields sessions.get() === undefined
 * and looks exactly like a broken plugin. */
/* Presence, not truthiness: an explicit '' means "test the degraded branch"
 * and must NOT fall through to the env var. Using || here silently turned that
 * explicit empty string into the strong branch and made the weak branch
 * unreachable — the mirror image of the bug this fallback was added to fix. */
const probeArg = process.argv[3];
const probeId = probeArg !== undefined ? probeArg : (process.env.DSH_SESSION_ID || '');
const diag = await postAuthed({ command: 'diagnose', sessionId: probeId }, cookie);
if (diag.status === 200 && diag.body?.diagnose) {
  console.log('\n--- host session shape (diagnose) ---');
  console.log(JSON.stringify(diag.body.diagnose, null, 2));
  console.log('--- end diagnose ---\n');
}

r = await postAuthed({ command: 'settings-set', sessionId: probeId, settings: { mode: 'acceptance', workspaceDocs: true } }, cookie);
ok('live settings-set is 200', r.status === 200, 'status=' + r.status);
ok('live settings-set reports a persistence verdict', typeof r.body?.persisted === 'boolean', String(r.body?.persisted));
const cwdSeen = r.body?.cwd;
if (probeId === '') {
  /* No session id: the workspace copy must degrade, not throw. */
  ok('sessionless settings-set degrades without a workspace', r.body?.persisted === false && r.body?.cwd === '', 'persisted=' + String(r.body?.persisted));
} else {
  ok('live settings-set resolves a workspace', typeof r.body?.cwd === 'string' && r.body.cwd !== '', 'cwd=' + String(r.body?.cwd));
  ok('live settings actually persist to the workspace', r.body?.persisted === true, 'persisted=' + String(r.body?.persisted));
}
r = await postAuthed({ command: 'settings-get', sessionId: probeId }, cookie);
ok('live settings-get is 200', r.status === 200, 'status=' + r.status);
ok('live settings-get returns an object', r.body?.settings !== null && typeof r.body?.settings === 'object');
ok('live settings-get reads the same workspace', r.body?.cwd === cwdSeen, 'cwd=' + String(r.body?.cwd));

/* 3. rewrite guard paths still answer through the live route. */
r = await postAuthed({ command: 'rewrite', draft: '   ' }, cookie);
ok('live empty draft is 400', r.status === 400, 'status=' + r.status);

r = await postAuthed({ command: 'rewrite', draft: '把 index.js 改一下', mode: 'spec' }, cookie);
ok('live unavailable mode is 400', r.status === 400, 'status=' + r.status);

/* The verdict must name the actual failure class. The old text collapsed every
 * failure into "the old build is probably still running; restart the Desktop
 * app", which is wrong whenever the cause is auth: restarting does not fix a
 * credential mismatch, and it throws away the evidence that the build was fine.
 * Three classes are distinguishable, so three outcomes are reported. */
const staleBuild = authPersistent401 === false && failures > 0;

if (failures === 0) {
  console.log('\nLIVE OK — the running host serves P3 (version ' + EXPECTED_VERSION + ' / stage P3) and the fence answers 401.');
  if (authRetriesUsed > 0) {
    console.log('  note: ' + authRetriesUsed + ' authenticated request(s) needed a retry after a transient 401; '
      + 'the build was fine, the fence was momentarily busy.');
  }
} else if (authPersistent401) {
  console.log('\n' + failures + ' LIVE FAILURE(S) — the host REJECTED an authenticated cookie even after '
    + AUTH_RETRIES + ' retries.');
  console.log('  This is an AUTH problem, not a stale build: restarting the Desktop app will not fix it.');
  console.log('  Check that ~/.dsh/.credentials.yaml still carries the client-connection/browser-session');
  console.log('  secret this run minted its cookie from, and that the authority (' + authority + ') is the');
  console.log('  one the host is actually serving — the cookie is bound to the authority string.');
} else if (staleBuild) {
  console.log('\n' + failures + ' LIVE FAILURE(S) — the host answered, but not with the current build.');
  console.log('  The fence and credentials are working (no persistent 401), so this points at a stale');
  console.log('  build rather than an auth fault. If a source file under this plugin changed since the');
  console.log('  host started, restart the Desktop app; otherwise read the failures above as regressions.');
} else {
  console.log('\n' + failures + ' LIVE FAILURE(S).');
}
if (failures > 0) process.exit(1);
