import { login, signup, logout, getUser, verifyRequestOrigin } from '@netlify/identity';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}

export default async (req) => {
  const op = new URL(req.url).searchParams.get('op');

  // Read-only check, no CSRF guard needed.
  if (op === 'me') {
    const u = await getUser();
    return json({ user: u ? { id: u.id, email: u.email } : null });
  }

  try {
    // Mandatory before login/signup/logout: without it an attacker can log a
    // victim's browser into the attacker's account.
    verifyRequestOrigin(req);
  } catch {
    return json({ error: 'Request blocked (origin mismatch).' }, 403);
  }

  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  try {
    if (op === 'login') {
      if (!email || !password) return json({ error: 'Email and password required.' }, 400);
      await login(email, password);
      return json({ ok: true });
    }
    if (op === 'signup') {
      if (!email || !password) return json({ error: 'Email and password required.' }, 400);
      if (password.length < 8) return json({ error: 'Password must be at least 8 characters.' }, 400);
      await signup(email, password, {});
      return json({ ok: true });
    }
    if (op === 'logout') {
      await logout();
      return json({ ok: true });
    }
    return json({ error: 'Unknown operation.' }, 400);
  } catch (e) {
    const msg = String((e && e.message) || e);
    // Identity denies non-allowlisted signups via the userValidate handler.
    if (/401|unauthor|denied|deny/i.test(msg)) {
      return json({ error: 'That address is not on the marketing team list, or the password is wrong.' }, 401);
    }
    if (/invalid|credential|password|not\s*found/i.test(msg)) {
      return json({ error: 'That email and password do not match.' }, 401);
    }
    if (/registered|exists|duplicate/i.test(msg)) {
      return json({ error: 'That address already has a login — sign in instead.' }, 409);
    }
    return json({ error: msg }, 400);
  }
};
