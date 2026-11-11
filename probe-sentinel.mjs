/**
 * probe-sentinel.mjs — the one thing the unit suites cannot prove.
 *
 * verify-host asserts the CODE handles the sentinel correctly, but it feeds that
 * code a stub. What is untested is whether a real model actually obeys rule 6
 * and emits NO_VERIFIABLE_ACCEPTANCE when the draft has no checkable goal —
 * versus inventing an acceptance section to look diligent, which is exactly the
 * failure the sentinel exists to outrank.
 *
 * Three sections, four real calls:
 *   A. "优化一下"                  → goal-free draft; expect declared:true
 *   B. a draft with a real target → expect present:true (the sentinel must not
 *                                   become the easy way out for every draft)
 *   C. judgement on a real rewrite → expect judged:true and every signal inside
 *                                   the enum the plugin itself advertises, plus
 *                                   D. judge:false → no judgement at all.
 *
 * C/D exist because the unit suites feed the judge a stub. What they cannot
 * prove is whether a real model answers in the four enums instead of writing
 * prose about the prompt — and prose is the failure mode that silently turns
 * into "unclear" everywhere, which renders as a grey line nobody reads.
 *
 * Usage: node probe-sentinel.mjs [authority]
 */
import { readFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { discoverAuthority } from './host-authority.mjs';

const { authority, source } = await discoverAuthority(process.argv[2]);
const base = 'http://' + authority;
console.log('authority =', authority, '(discovered via ' + source + ')');

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
  const issuedAt = Date.now();
  const payload = { version: 1, authority, issuedAt, expiresAt: issuedAt + 30 * 24 * 60 * 60 * 1000 };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  const name = 'dsh-auth-' + b64url(createHash('sha256').update(authority).digest());
  return name + '=v1.' + body + '.' + sig;
}

const cookie = mintCookie();

async function rewrite(draft, mode) {
  const res = await fetch(base + '/prompt-forge/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ command: 'rewrite', draft, mode }),
  });
  let body;
  try { body = await res.json(); } catch { body = undefined; }
  return { status: res.status, body };
}

/* A. A draft that expresses no goal. Rule 6 says: emit the sentinel, do not
 * invent checkboxes. */
console.log('\n--- A. goal-free draft in acceptance mode ---');
let r = await rewrite('优化一下', 'acceptance');
console.log('status =', r.status);
console.log('acceptance =', JSON.stringify(r.body?.acceptance));
console.log('rewrite =', JSON.stringify(r.body?.rewrite));
console.log('usage =', JSON.stringify(r.body?.usage));
ok('the call succeeds', r.status === 200, 'status=' + r.status);
if (r.status === 200) {
  ok('a real model declares instead of inventing an acceptance section',
    r.body?.acceptance?.declared === true, JSON.stringify(r.body?.acceptance));
  ok('no fabricated acceptance section is reported as present',
    r.body?.acceptance?.present === false);
  ok('the sentinel is stripped from the text the user would paste',
    !String(r.body?.rewrite ?? '').includes('NO_VERIFIABLE_ACCEPTANCE'));
}

/* B. A draft with a checkable target must still get a real section — the
 * sentinel must not become the universal escape hatch. */
console.log('\n--- B. draft with a concrete target, same mode ---');
r = await rewrite('给 dsh-prompt-forge 加一个把改写结果复制到剪贴板的按钮，路径在 client.js。', 'acceptance');
console.log('status =', r.status);
console.log('acceptance =', JSON.stringify(r.body?.acceptance));
console.log('rewrite =', JSON.stringify(String(r.body?.rewrite ?? '').slice(0, 400)));
ok('the call succeeds', r.status === 200, 'status=' + r.status);
if (r.status === 200) {
  ok('a concrete draft still gets a real acceptance section',
    r.body?.acceptance?.present === true, JSON.stringify(r.body?.acceptance));
  ok('a concrete draft is not declared goal-free',
    r.body?.acceptance?.declared === false);
  ok('the path literal survives into the rewrite',
    String(r.body?.rewrite ?? '').includes('client.js'),
    'facts=' + JSON.stringify(r.body?.facts));
}

/* C. The judge. Read the enum table off the plugin's own config route first —
 * asserting against a copy pasted into this file would let the probe and the
 * plugin drift apart while both stayed green. */
console.log('\n--- C. judgement on a real rewrite ---');
let cfg;
try {
  const res = await fetch(base + '/prompt-forge/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ command: 'config' }),
  });
  cfg = await res.json();
} catch (err) {
  cfg = undefined;
  console.log('config fetch failed =', err && err.message);
}
const adv = cfg && cfg.judge;
ok('config advertises the judge', !!(adv && adv.default === true), JSON.stringify(adv && adv.default));
ok('capability.judge is true', !!(cfg && cfg.capability && cfg.capability.judge === true));
const enums = (adv && adv.values) || {};
const verdicts = (adv && adv.verdicts) || [];
ok('four signals are advertised', ['fidelity', 'depth', 'grounding', 'executability'].every((k) => Array.isArray(enums[k]) && enums[k].length >= 3),
  Object.keys(enums).join(','));

r = await rewrite('把 E:\\deepseek-workspace\\dsh-prompt-forge\\client.js 里的触发按钮改成正忙时点击即取消，别动 index.js。');
console.log('status =', r.status);
console.log('judge =', JSON.stringify(r.body?.judge));
console.log('usage =', JSON.stringify(r.body?.usage));
ok('the call succeeds with judgement on', r.status === 200, 'status=' + r.status);
const j = r.body?.judge;
if (r.status === 200 && j) {
  ok('judgement was requested by default', j.enabled === true);
  ok('a real model answered in JSON instead of prose', j.judged === true, 'error=' + JSON.stringify(j.error));
  ok('the judgement block is versioned', j.version === 1);
  for (const key of ['fidelity', 'depth', 'grounding', 'executability']) {
    const v = j.signals && j.signals[key];
    ok('signal ' + key + ' is one of its own enum values',
      typeof v === 'string' && Array.isArray(enums[key]) && enums[key].includes(v),
      key + '=' + JSON.stringify(v));
  }
  ok('codeFactsMissing is injected by code, not asked of the model',
    typeof j.signals?.codeFactsMissing === 'boolean', 'codeFactsMissing=' + JSON.stringify(j.signals?.codeFactsMissing));
  ok('verdict is one of the advertised verdicts',
    typeof j.verdict === 'string' && verdicts.includes(j.verdict), 'verdict=' + JSON.stringify(j.verdict));
  ok('conflicts is an array of strings',
    Array.isArray(j.conflicts) && j.conflicts.every((c) => typeof c === 'string'),
    JSON.stringify(j.conflicts));
  /* The whole point: a conflict can never render as a clean pass. */
  ok('a conflict never reports verdict ok',
    !(Array.isArray(j.conflicts) && j.conflicts.length > 0) || j.verdict !== 'ok',
    'conflicts=' + JSON.stringify(j.conflicts) + ' verdict=' + JSON.stringify(j.verdict));
  ok('the rewrite is returned untouched by the judgement',
    typeof r.body?.rewrite === 'string' && r.body.rewrite.length > 0);
}

/* D. Opting out must mean no judgement at all — not a silent default pass. */
console.log('\n--- D. judge:false ---');
{
  const res = await fetch(base + '/prompt-forge/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ command: 'rewrite', draft: '优化一下', judge: false }),
  });
  const body = await res.json().catch(() => undefined);
  console.log('status =', res.status);
  console.log('judge =', JSON.stringify(body?.judge));
  ok('the call still succeeds', res.status === 200, 'status=' + res.status);
  ok('no judgement is requested when the caller opts out', body?.judge?.enabled === false);
  ok('nothing is reported as judged', body?.judge?.judged === false);
  ok('no signals are invented for a call that never happened',
    !body?.judge?.signals || Object.keys(body.judge.signals).length === 0,
    JSON.stringify(body?.judge?.signals));
}

console.log('\n' + (failures === 0
  ? 'PROBE OK — the sentinel is obeyed, and the judge answers in its own enums without ever passing a conflict.'
  : failures + ' PROBE FAILURE(S) — see above.'));
if (failures > 0) process.exit(1);
