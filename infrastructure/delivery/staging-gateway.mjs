import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, request } from 'node:http';
import { pathToFileURL } from 'node:url';

const cookieName = 'gthf_staging_session';
const lifetime = 12 * 60 * 60;
const equal = (left, right) => {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function issueSession(key, now = Math.floor(Date.now() / 1000)) {
  const expires = String(now + lifetime);
  return expires + '.' + createHmac('sha256', key).update(expires).digest('hex');
}

export function verifySession(value, key, now = Math.floor(Date.now() / 1000)) {
  const match = /^(\d{1,12})\.([a-f0-9]{64})$/.exec(value ?? '');
  if (!match || Number(match[1]) <= now || Number(match[1]) > now + lifetime) return false;
  return equal(match[2], createHmac('sha256', key).update(match[1]).digest('hex'));
}

export function upstreamForHost(host) {
  if (host === 'staging.gthf.fr') return 'http://gthf-frontend:3000';
  if (host === 'staging-cms.gthf.fr') return 'http://gthf-cms:1337';
  throw new Error('Unknown staging host');
}

export function privateResponseHeaders(headers) {
  return { ...headers, 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow, noarchive' };
}

export function createGateway(password, key) {
  if (password.length < 24 || key.length < 32) throw new Error('Dedicated staging credentials are required');
  return createServer(async (incoming, outgoing) => {
    outgoing.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    outgoing.setHeader('Cache-Control', 'private, no-store');
    if (incoming.url === '/_gateway/health') {
      outgoing.writeHead(200); outgoing.end('ok'); return;
    }
    let upstream;
    try { upstream = upstreamForHost(incoming.headers.host); }
    catch { outgoing.writeHead(421); outgoing.end(); return; }
    if (!incoming.url.startsWith('/') || incoming.url.startsWith('//') || incoming.url.includes('\\')) {
      outgoing.writeHead(400); outgoing.end(); return;
    }
    const pathname = new URL(incoming.url, 'https://' + incoming.headers.host).pathname;
    if (pathname === '/_gateway/login' && incoming.method === 'POST') {
      const origin = incoming.headers.origin;
      if (origin && origin !== 'https://' + incoming.headers.host) { outgoing.writeHead(403); outgoing.end(); return; }
      let body = '';
      for await (const chunk of incoming) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 4096) { outgoing.writeHead(413); outgoing.end(); return; }
      }
      if (equal(new URLSearchParams(body).get('password') ?? '', password)) {
        outgoing.setHeader('Set-Cookie', `${cookieName}=${issueSession(key)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${lifetime}`);
        outgoing.writeHead(303, { Location: '/' }); outgoing.end(); return;
      }
      outgoing.writeHead(403); outgoing.end('Accès refusé.'); return;
    }
    const cookie = (incoming.headers.cookie ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    const basic = incoming.headers.authorization?.startsWith('Basic ') && equal(incoming.headers.authorization, 'Basic ' + Buffer.from('recette:' + password).toString('base64'));
    const authorized = basic || verifySession(cookie, key);
    if (!authorized) {
      outgoing.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'" });
      outgoing.end('<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Recette GTHF</title><h1>Environnement de recette GTHF</h1><form action="/_gateway/login" method="post"><label>Mot de passe <input type="password" name="password" required autocomplete="current-password"></label><button>Accéder à la recette</button></form></html>'); return;
    }
    const headers = { ...incoming.headers, 'x-forwarded-proto': 'https' };
    if (basic) delete headers.authorization;
    headers.cookie = (headers.cookie ?? '').split(';').filter((part) => !part.trim().startsWith(cookieName + '=')).join(';');
    // Cookie access leaves Strapi's Bearer authentication intact.
    const proxied = request(new URL(incoming.url, upstream), { method: incoming.method, headers }, (response) => {
      outgoing.writeHead(response.statusCode, privateResponseHeaders(response.headers));
      response.pipe(outgoing);
    });
    proxied.setTimeout(60000, () => proxied.destroy());
    proxied.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    incoming.on('aborted', () => proxied.destroy());
    incoming.pipe(proxied);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createGateway(process.env.STAGING_PASSWORD ?? '', process.env.STAGING_SESSION_KEY ?? '');
  server.requestTimeout = 60000;
  server.listen(3001, '0.0.0.0');
  process.on('SIGTERM', () => server.close());
}
