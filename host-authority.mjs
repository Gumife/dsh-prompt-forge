/**
 * host-authority.mjs — find the running DSH host, whatever port it picked.
 *
 * The Desktop host binds a fresh ephemeral port on every restart, so any
 * authority baked into a script becomes a test of whether the host happens to
 * be on yesterday's port. Every script that talks to the live host resolves it
 * through here instead of carrying its own constant.
 *
 * Resolution order:
 *   1. explicit argument   — pin a known host when you mean to.
 *   2. $DSH_WEB_URL        — the harness exports the live GUI URL into every
 *                            child process; this is the authoritative answer.
 *   3. loopback port scan  — last resort for shells without the env var: probe
 *                            the loopback listeners for the one that actually
 *                            answers the route (401 counts: the route exists).
 *
 * The probe MATCHES THE RESPONSE BODY, not just the status. Other DSH services
 * on the same machine also answer 401, but with a different shape, so a
 * status-only test latches onto a neighbour and every later assertion fails
 * against the wrong process.
 */
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PROBE_PATH = '/prompt-forge/api';

/** How many listeners to probe at once during the scan fallback. */
const SCAN_CONCURRENCY = 8;

/** True when something at `authority` serves the prompt-forge route.
 *  The fence answers 401 with `{"ok":false,"error":"unauthorized"}` — error is
 *  a STRING, not an object — and an authenticated `config` answers with a
 *  version string. Both shapes are checked. */
export async function servesPromptForge(authority) {
  try {
    const res = await fetch('http://' + authority + PROBE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'config' }),
      signal: AbortSignal.timeout(1500),
    });
    let body;
    try { body = await res.json(); } catch { return false; }
    if (res.status === 401) return body?.ok === false && body?.error === 'unauthorized';
    if (res.status === 200) return typeof body?.version === 'string' && body?.ok !== false;
    return false;
  } catch {
    return false;
  }
}

/** Candidate authorities from the loopback listeners, most likely first.
 *  netstat writes into an already-open file descriptor instead of a pipe: a
 *  confined sandbox blocks capturing a child's stdout through a named pipe
 *  (EPERM), and shell redirection through cmd.exe is refused too. Handing the
 *  child a real fd keeps discovery working under both. */
export function loopbackCandidates() {
  const { mkdtempSync, openSync, closeSync, rmSync } = fs;
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ports-'));
  const outFile = join(dir, 'netstat.txt');
  let out = '';
  let fd;
  try {
    fd = openSync(outFile, 'w');
    execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], { stdio: ['ignore', fd, 'ignore'], windowsHide: true });
    closeSync(fd);
    fd = undefined;
    out = fs.readFileSync(outFile, 'utf8');
  } catch {
    return [];
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const ports = new Set();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*TCP\s+(127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d+)\s+\S+\s+LISTENING/i);
    if (!m) continue;
    const port = Number(m[2]);
    if (port >= 1024 && port <= 65535) ports.add(port);
  }
  /* Ephemeral listeners are the most likely host: a port above 49152 beats a
   * well-known service port. */
  return [...ports].sort((a, b) => b - a).map((p) => '127.0.0.1:' + p);
}

/** Resolve `{ authority, source }` for the running host, or throw with the
 *  manual override in the message. `explicit` lets each caller decide which
 *  argv slot is the authority. */
export async function discoverAuthority(explicit) {
  if (explicit) return { authority: explicit, source: 'argv' };

  const fromEnv = (process.env.DSH_WEB_URL || '').trim();
  const envMatch = fromEnv.match(/^https?:\/\/([^/]+)/);
  if (envMatch && (await servesPromptForge(envMatch[1]))) {
    return { authority: envMatch[1], source: 'DSH_WEB_URL' };
  }

  /* Probing ~40 listeners one at a time costs >10s because a few accept the TCP
   * connection and then sit there until the timeout. Waves keep the ordering
   * rule (a lower index always wins) while cutting the wall time to roughly
   * candidates/SCAN_CONCURRENCY timeouts. */
  const candidates = loopbackCandidates();
  for (let i = 0; i < candidates.length; i += SCAN_CONCURRENCY) {
    const wave = candidates.slice(i, i + SCAN_CONCURRENCY);
    const hits = await Promise.all(wave.map((c) => servesPromptForge(c)));
    const hit = hits.indexOf(true);
    if (hit !== -1) return { authority: wave[hit], source: 'port scan' };
  }

  throw new Error(
    'could not find a running DSH host serving ' + PROBE_PATH + '\n' +
    '  pass it explicitly: node <script> 127.0.0.1:<port>\n' +
    '  (DSH_WEB_URL was ' + (fromEnv || 'unset') + ')',
  );
}
