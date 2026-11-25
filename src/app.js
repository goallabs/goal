// Answering requests: static files, routes, and the security defaults.
//
// Secure by default, each with an explicit way out in goal.config.js:
//   - every response has strict headers: a Content-Security-Policy with a fresh nonce for the
//     loader script (`csp: "...{nonce}..."` to change it, `csp: false` to drop it), nosniff,
//     no framing, same-origin opener and resources, and HSTS over TLS;
//   - a request that changes something (POST, PUT, PATCH, DELETE) must come from this site:
//     a cross-site Origin or Sec-Fetch-Site is refused, and without `Sec-Fetch-Site: same-origin`
//     it needs the CSRF token, which forms get automatically (`csrf: false` to turn it off);
//   - bodies are limited (`bodyLimit`, 1 MB), redirects stay on this site unless asked,
//     cookies are HttpOnly, Secure and SameSite=Lax, and errors show no details outside `goal dev`.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { Html, _$ctx } from './rt.js';
import { page } from './server.js';

const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
const HTML = 'text/html; charset=utf-8';
const SAFE = new Set(['GET', 'HEAD']);
const OVERRIDES = new Set(['PUT', 'PATCH', 'DELETE']);
const REPLY = Symbol('reply');

/** The headers every response carries. */
export function securityHeaders(nonce, { csp, tls = false } = {}) {
  const h = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'x-frame-options': 'DENY',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  };
  if (csp !== false)
    h['content-security-policy'] =
      typeof csp === 'string'
        ? csp.replaceAll('{nonce}', nonce)
        : `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
  if (tls) h['strict-transport-security'] = 'max-age=63072000; includeSubDomains';
  return h;
}

/** A cookie with safe defaults: HttpOnly, Secure, SameSite=Lax, the whole site. */
export function serializeCookie(name, value, { httpOnly = true, secure = true, sameSite = 'Lax', path = '/', maxAge } = {}) {
  if (!/^[\w!#$%&'*+.^`|~-]+$/.test(name)) throw new Error(`cookie name ${JSON.stringify(name)} has characters a cookie name can't have`);
  let s = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (maxAge !== undefined) s += `; Max-Age=${Math.floor(maxAge)}`;
  if (httpOnly) s += '; HttpOnly';
  if (secure) s += '; Secure';
  return s;
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';').map((p) => p.trim())) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[name] = decodeURIComponent(v);
    } catch {
      out[name] = v;
    }
  }
  return out;
}

/** Sends the user to another page on this site. `{ external: true }` allows another site. */
export function redirect(url, { external = false, status = 303 } = {}) {
  if (!external && !/^\/(?![/\\])/.test(url))
    throw new Error(`redirect() goes to a path on this site, like /notes, not ${url}; pass { external: true } to leave the site`);
  return { [REPLY]: true, status, headers: { location: url } };
}

export const json = (value, status = 200) => ({ [REPLY]: true, status, type: 'application/json; charset=utf-8', body: JSON.stringify(value) });

const errorPage = (title) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1></body></html>`;

export const notFound = () => ({ [REPLY]: true, status: 404, type: HTML, body: errorPage('Not found') });

function sameSite(req, cookieToken, sent) {
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      return false;
    }
    if (host !== req.headers.host) return false;
  }
  const site = req.headers['sec-fetch-site'];
  if (site === 'same-origin') return true;
  if (site === 'cross-site' || site === 'same-site') return false;
  if (!cookieToken || typeof sent !== 'string') return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(cookieToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req, limit) {
  return new Promise((ok, no) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) {
        req.removeAllListeners('data');
        req.resume();
        no(Object.assign(new Error('body too large'), { status: 413 }));
      } else chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', no);
  });
}

function staticFile(dirs, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const root = resolve(dir);
    const f = resolve(root, '.' + rel);
    if (f.startsWith(root + sep) && statSync(f, { throwIfNoEntry: false })?.isFile()) return f;
  }
  return null;
}

/** Routes sorted so fixed paths win over ones with parameters. */
function table(routes) {
  return routes
    .map((r, i) => ({ ...r, i, segs: r.path === '/' ? [] : r.path.slice(1).split('/') }))
    .map((r) => ({ ...r, n: r.segs.filter((s) => s[0] === '{').length }))
    .sort((a, b) => a.n - b.n || a.i - b.i);
}

function match(routes, method, segs) {
  const allow = new Set();
  for (const r of routes) {
    if (r.segs.length !== segs.length) continue;
    const params = {};
    if (!r.segs.every((s, i) => (s[0] === '{' ? ((params[s.slice(1, -1)] = segs[i]), true) : s === segs[i]))) continue;
    if (r.method === method) return { route: r, params };
    allow.add(r.method);
  }
  return allow.size ? { allow: [...allow] } : null;
}

/** The state a page kept for each component, sent with a live update; anything else counts as none. */
function keptState(header) {
  try {
    const v = JSON.parse(header);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/**
 * A request handler for node:http.
 * @param {{ method: string, path: string, handler: Function }[]} routes
 * @param {{ dev?: boolean, staticDirs?: string[], config?: { csp?: string | false, csrf?: boolean, bodyLimit?: number }, log?: (e: Error) => void }} [opts]
 */
export function createApp(routes, { dev = false, staticDirs = [], config = {}, log = console.error } = {}) {
  const sorted = table(routes);
  const limit = config.bodyLimit ?? 1_000_000;
  return async (req, res) => {
    const nonce = randomBytes(16).toString('base64');
    const headers = securityHeaders(nonce, { csp: config.csp, tls: !!req.socket.encrypted });
    const cookies = parseCookies(req.headers.cookie);
    const setCookies = [];
    let token = cookies.goal_csrf;
    if (!/^[\w-]{43}$/.test(token ?? '')) {
      token = randomBytes(32).toString('base64url');
      setCookies.push(serializeCookie('goal_csrf', token));
    }
    const send = (status, type, body, extra) => {
      res.writeHead(status, { ...headers, ...(type ? { 'content-type': type } : {}), ...(setCookies.length ? { 'set-cookie': setCookies } : {}), ...extra });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const fail = (status, title) => send(status, HTML, errorPage(title));

    try {
      const url = new URL(req.url, 'http://localhost');
      if (SAFE.has(req.method)) {
        const f = staticFile(staticDirs, url.pathname);
        if (f) return send(200, TYPES[extname(f)] ?? 'application/octet-stream', readFileSync(f));
      }

      let method = req.method === 'HEAD' ? 'GET' : req.method;
      let form = {};
      let body;
      if (!SAFE.has(req.method)) {
        const raw = await readBody(req, limit);
        const type = (req.headers['content-type'] ?? '').split(';')[0].trim();
        if (raw.length) {
          if (type === 'application/x-www-form-urlencoded') form = Object.fromEntries(new URLSearchParams(raw.toString()));
          else if (type === 'application/json') {
            try {
              body = JSON.parse(raw);
            } catch {
              return fail(400, 'Bad request');
            }
          } else return fail(415, 'Unsupported media type');
        }
        if (config.csrf !== false && !sameSite(req, cookies.goal_csrf, form._csrf ?? req.headers['x-csrf-token'])) return fail(403, 'Forbidden');
        const override = String(form._method ?? '').toUpperCase();
        if (method === 'POST' && OVERRIDES.has(override)) method = override;
        delete form._csrf;
        delete form._method;
      }

      let segs;
      try {
        segs = url.pathname === '/' ? [] : url.pathname.replace(/\/$/, '').slice(1).split('/').map(decodeURIComponent);
      } catch {
        return fail(400, 'Bad request');
      }
      const m = match(sorted, method, segs);
      if (!m) return fail(404, 'Not found');
      if (m.allow) return send(405, HTML, errorPage('Method not allowed'), { allow: m.allow.join(', ') });

      const ctx = _$ctx(token);
      if (dev && req.headers['x-goal-hmr']) ctx.hmr = keptState(req.headers['x-goal-hmr']); // goal dev: a live update (see hmr.js)
      const request = { method, path: url.pathname, url, params: m.params, query: Object.fromEntries(url.searchParams), headers: req.headers, cookies, form, json: body };
      const cookie = (name, value, opts) => setCookies.push(serializeCookie(name, value, opts));
      const out = await m.route.handler(request, { ctx, redirect, json, notFound, cookie });
      if (out instanceof Html) return send(200, HTML, page(out.s, [...ctx.ev], nonce, token, dev));
      if (out === undefined) return send(204);
      if (out?.[REPLY]) return send(out.status, out.type, out.body, out.headers);
      throw new Error('a route returns markup, redirect(), json(), notFound() or nothing');
    } catch (e) {
      if (e.status === 413) return fail(413, 'Too large');
      log(e);
      return dev ? send(500, 'text/plain; charset=utf-8', String(e.stack)) : fail(500, 'Something went wrong');
    }
  };
}
