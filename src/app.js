// Answering requests: static files, routes, and the security defaults.
//
// Secure by default, each with an explicit way out in goal.config.js:
//   - every response has strict headers: a Content-Security-Policy with a fresh nonce for the
//     loader script (`csp: "...{nonce}..."` to change it, `csp: false` to drop it), nosniff,
//     no framing, same-origin opener and resources, and HSTS over TLS;
//   - a request that changes something (POST, PUT, PATCH, DELETE) must come from this site:
//     a cross-site Origin or Sec-Fetch-Site is refused, and without `Sec-Fetch-Site: same-origin`
//     it needs the CSRF token, which forms get automatically (`csrf: false` to turn it off);
//   - except in a `group /path api`, whose routes neither read nor set cookies, so there's nothing
//     for another site to misuse; other sites read their answers only when `cors` allows;
//   - a client may send 120 requests that change things a minute (`rateLimit`; `trustProxy` behind
//     proxies), then waits;
//   - bodies are limited (`bodyLimit`, 1 MB), redirects stay on this site unless asked,
//     cookies are HttpOnly, Secure and SameSite=Lax, and errors show no details outside `goal dev`.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { isHtml, _$e, _$ok } from './rt.js';
import { _$ctx } from './render.js';
import { _$lr } from './load.js';
import { _$box } from './request.js';
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
const JSON_TYPE = 'application/json; charset=utf-8';
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

export const json = (value, status = 200, headers) => ({ [REPLY]: true, status, type: JSON_TYPE, body: JSON.stringify(value), headers });

/** Any answer: markup as a page, text, or bytes, with a status and headers of its own. */
export function reply(body, { status = 200, type, headers } = {}) {
  if (isHtml(body)) return { [REPLY]: true, status, page: body, headers };
  const bytes = body instanceof Uint8Array;
  if (!bytes && typeof body !== 'string') throw new TypeError('reply() takes markup, text or bytes: send data with json()');
  return { [REPLY]: true, status, type: type ?? (bytes ? 'application/octet-stream' : 'text/plain; charset=utf-8'), body, headers };
}

/** An answer sent as it's made: each piece (text or bytes) an async iterable gives, say an async generator. */
export const stream = (source, { status = 200, type = 'text/plain; charset=utf-8', headers } = {}) => ({ [REPLY]: true, status, type, headers, stream: source });

/**
 * Server-sent events, for EventSource: each value the source gives arrives as one message, as JSON.
 * A comment every `ping` ms (15 s) keeps proxies from closing a quiet connection.
 */
export const events = (source, { ping = 15_000, headers } = {}) => ({
  [REPLY]: true,
  status: 200,
  type: 'text/event-stream; charset=utf-8',
  headers: { 'cache-control': 'no-store', ...headers },
  stream: messages(source),
  ping,
});

async function* messages(source) {
  for await (const v of source) yield `data: ${JSON.stringify(v ?? null)}\n\n`;
}

const errorPage = (title, items = []) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${items.length ? `<ul>${items.map((x) => `<li>${_$e(x)}</li>`).join('')}</ul>` : ''}</body></html>`;

/**
 * A route's typed input (see types.js), checked: a query's or a form's text is converted first, in
 * place, to the numbers and booleans its type has. Answers 400, naming the fields that are wrong (never
 * their values), or nothing when all is well.
 */
function badInput(request, input, api) {
  const found = [];
  for (const [k, type] of Object.entries(input)) {
    if (k !== 'json')
      for (const [n, f] of Object.entries(type.fields)) {
        const v = request[k][n];
        if (f.type.k === 'number' && /^-?\d+(\.\d+)?$/.test(v)) request[k][n] = Number(v);
        if (f.type.k === 'boolean' && /^(true|false|on)$/.test(v)) request[k][n] = v !== 'false';
      }
    wrong(request[k], type, k, found);
  }
  if (!found.length) return;
  return api ? json({ error: 'Bad request', problems: found }, 400) : { [REPLY]: true, status: 400, type: HTML, body: errorPage('Bad request', found) };
}

/** What's wrong with a value for a type, by where (json.title), up to ten things. */
function wrong(v, x, at, found) {
  if (found.length >= 10) return;
  if (x.k === 'object' && v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [n, f] of Object.entries(x.fields))
      if (v[n] != null) wrong(v[n], f.type, `${at}.${n}`, found);
      else if (!f.optional && !_$ok(v[n], f.type)) found.push(`${at}.${n}: missing`);
  } else if (x.k === 'array' && Array.isArray(v)) v.forEach((y, i) => wrong(y, x.of, `${at}[${i}]`, found));
  else if (!_$ok(v, x)) found.push(`${at}: expected ${kind(x)}`);
}

const kind = (x) =>
  x.k === 'union' ? x.of.map(kind).join(' or ') : x.k === 'lit' ? JSON.stringify(x.v) : x.k === 'array' ? 'a list' : x.k === 'object' ? 'an object' : x.k;

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

const split = (path) => (path === '/' ? [] : path.slice(1).split('/'));

/** Routes sorted so fixed paths win over ones with parameters. */
function table(routes) {
  return routes
    .map((r, i) => ({ ...r, i, segs: split(r.path), ...(r.api && { api: split(r.api) }) }))
    .map((r) => ({ ...r, n: r.segs.filter((s) => s[0] === '{').length }))
    .sort((a, b) => a.n - b.n || a.i - b.i);
}

/** A path parameter: text, or a number for one typed {id: number}, which matches only a number. */
function param(r, name, seg, params) {
  if (r.types?.[name] !== 'number') return !!(params[name] = seg);
  if (!/^-?\d+(\.\d+)?$/.test(seg)) return false;
  params[name] = Number(seg);
  return true;
}

/** The route for a method and path, or the methods the path takes; api says whether it's an api route (or path). */
function match(routes, method, segs) {
  const allow = new Set();
  let api = false;
  for (const r of routes) {
    if (r.segs.length !== segs.length) continue;
    const params = {};
    if (!r.segs.every((s, i) => (s[0] === '{' ? param(r, s.slice(1, -1), segs[i], params) : s === segs[i]))) continue;
    if (r.method === method) return { route: r, params, api: !!r.api };
    allow.add(r.method);
    api ||= !!r.api;
  }
  return allow.size ? { allow: [...allow], api } : null;
}

/**
 * The rate limit on requests that change things: at most `max` (120) from one client in each `window`
 * (a minute). The client is the connection's address or, behind proxies (`trustProxy`: true for one,
 * or how many), the one they forwarded. Returns a function that counts a request and says how many
 * seconds its client must wait, or 0.
 */
function limiter(opts, trustProxy) {
  if (opts === false) return () => 0;
  const { max = 120, window = 60_000 } = opts ?? {};
  const hops = trustProxy === true ? 1 : Number(trustProxy) || 0;
  const seen = new Map(); // client -> { n, end }
  let sweep = 0;
  return (req, tenant) => {
    const now = Date.now();
    if (now >= sweep) {
      for (const [k, v] of seen) if (v.end <= now) seen.delete(k);
      sweep = now + window;
    }
    const forwarded = hops && String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const client = `${(hops && forwarded.at(-hops)) || req.socket.remoteAddress} ${tenant}`; // each tenant counts apart
    let c = seen.get(client);
    if (!c || c.end <= now) seen.set(client, (c = { n: 0, end: now + window }));
    return ++c.n > max ? Math.ceil((c.end - now) / 1000) : 0;
  };
}

/** The Access-Control-Allow-Origin for a request's Origin: goal.config.js's cors is '*' or a list of origins. */
function allowed(cors, origin) {
  if (cors === '*') return '*';
  return origin && [cors].flat().includes(origin) ? origin : null;
}

/** The state a page kept for each component, in order, sent with a live update; anything else counts as none. */
function keptState(header) {
  try {
    const v = JSON.parse(header);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * A request handler for node:http.
 * @param {{ method: string, path: string, handler: Function }[]} routes
 * @param {{ dev?: boolean, staticDirs?: string[], config?: { csp?: string | false, csrf?: boolean, bodyLimit?: number, cors?: string | string[], tenant?: (r: { host: string, hostname: string, prefix?: string, path: string, headers: object, cookies: object }) => unknown, tenantPrefix?: boolean, rateLimit?: { max?: number, window?: number } | false, trustProxy?: boolean | number, onError?: (e: Error, request?: object) => void }, log?: (e: Error) => void, styles?: string }} [opts]
 *   config.onError: called with each error a route or server function throws, and the request;
 *   styles: the URL of the app's stylesheet (the style blocks), which each page links
 */
export function createApp(routes, { dev = false, staticDirs = [], config = {}, log = console.error, styles } = {}) {
  const sorted = table(routes);
  const limit = config.bodyLimit ?? 1_000_000;
  const tooMany = limiter(config.rateLimit, config.trustProxy);
  // Each request runs in a box that will hold it, so a server function can take it (see request.js)
  return (req, res) => {
    const box = {};
    return _$box(box, () => answer(req, res, box));
  };
  async function answer(req, res, box) {
    const nonce = randomBytes(16).toString('base64');
    const headers = securityHeaders(nonce, { csp: config.csp, tls: !!req.socket.encrypted });
    const cookies = parseCookies(req.headers.cookie);
    const setCookies = [];
    let token = cookies.goal_csrf;
    const fresh = !/^[\w-]{43}$/.test(token ?? '');
    if (fresh) token = randomBytes(32).toString('base64url');
    let api = false; // a route in a group /path api: no cookies, no CSRF check, errors as JSON
    const send = (status, type, body, extra, open) => {
      const set = fresh && !api ? [serializeCookie('goal_csrf', token), ...setCookies] : setCookies;
      res.writeHead(status, { ...headers, ...(type ? { 'content-type': type } : {}), ...(set.length ? { 'set-cookie': set } : {}), ...extra });
      if (!open) res.end(req.method === 'HEAD' ? undefined : body);
    };
    const fail = (status, title) => (api ? send(status, JSON_TYPE, JSON.stringify({ error: title })) : send(status, HTML, errorPage(title)));
    // request.signal is aborted when the client goes away, so a stream or a slow call can stop
    const gone = new AbortController();
    res.on('close', () => gone.abort());
    // A stream: each piece as it comes, waiting while the client catches up, until the client goes
    const pipe = async ({ status, type, headers: extra, stream, ping }) => {
      send(status, type, null, extra, true);
      if (req.method === 'HEAD') return res.end();
      const timer = ping && setInterval(() => res.write(':\n\n'), ping);
      try {
        for await (const piece of stream) {
          if (gone.signal.aborted) break;
          if (!res.write(piece)) await once(res, 'drain', { signal: gone.signal }).catch(() => {});
        }
        res.end();
      } catch (e) {
        report(e);
        res.destroy();
      } finally {
        clearInterval(timer);
      }
    };
    let request;
    // An error is logged, and goal.config.js's onError hears of it too, say to report it to an error
    // tracker. It runs after the answer is on its way, and an error of its own is logged.
    const report = (e) => {
      log(e);
      Promise.resolve()
        .then(() => config.onError?.(e, request))
        .catch(log);
    };

    try {
      const url = new URL(req.url, 'http://localhost');
      if (SAFE.has(req.method)) {
        const f = staticFile(staticDirs, url.pathname);
        if (f) return send(200, TYPES[extname(f)] ?? 'application/octet-stream', readFileSync(f));
      }

      // Tenants (goal.config.js tenant): told apart by the host, or with tenantPrefix by the path's first
      // part, which routes then don't see. One that's unknown (null) gets a 404.
      let path = url.pathname;
      let base = '';
      let tenant;
      let host = '';
      if (config.tenant) {
        host = String((config.trustProxy && req.headers['x-forwarded-host']?.split(',').at(-1).trim()) || req.headers.host || '');
        let prefix;
        if (config.tenantPrefix) {
          const m = /^\/([^/]+)(\/.*)?$/.exec(path);
          if (m) [, prefix, path = '/'] = m;
          if (m) base = `/${prefix}`;
        }
        tenant = await config.tenant({ host, hostname: host.replace(/:\d+$/, ''), prefix, path, headers: req.headers, cookies });
        if (tenant == null) return fail(404, 'Not found');
      }

      let segs;
      try {
        segs = path === '/' ? [] : path.replace(/\/$/, '').slice(1).split('/').map(decodeURIComponent);
      } catch {
        return fail(400, 'Bad request');
      }
      let method = req.method === 'HEAD' ? 'GET' : req.method;
      let m = match(sorted, method, segs);
      // No route, under the path of an api group (its parameters match anything): a JSON 404
      if (!m) api = sorted.some((r) => r.api?.length <= segs.length && r.api.every((s, i) => s[0] === '{' || s === segs[i]));
      if (m?.api) {
        api = true;
        // Other sites may read the answers only when goal.config.js's cors lets them (no cookies are read, so none can be stolen)
        const origin = allowed(config.cors, req.headers.origin);
        if (origin) headers['access-control-allow-origin'] = origin;
        if (config.cors && config.cors !== '*') headers.vary = 'Origin';
        if (req.method === 'OPTIONS') {
          const asked = req.headers['access-control-request-headers'];
          return send(204, null, null, {
            allow: [...m.allow, 'OPTIONS'].join(', '),
            ...(origin && { 'access-control-allow-methods': m.allow.join(', '), 'access-control-max-age': '600' }),
            ...(origin && /^[\w-]+(\s*,\s*[\w-]+)*$/.test(asked ?? '') && { 'access-control-allow-headers': asked }),
          });
        }
      }
      const wait = !SAFE.has(req.method) && tooMany(req, host + base); // a client sending too many changes waits
      if (wait) return send(429, ...(api ? [JSON_TYPE, JSON.stringify({ error: 'Too many requests' })] : [HTML, errorPage('Too many requests')]), { 'retry-after': String(wait) });
      let form = {};
      const files = {};
      let data;
      let raw;
      if (!SAFE.has(req.method)) {
        raw = await readBody(req, limit);
        const type = (req.headers['content-type'] ?? '').split(';')[0].trim();
        if (raw.length) {
          if (type === 'application/x-www-form-urlencoded') form = Object.fromEntries(new URLSearchParams(raw.toString()));
          else if (type === 'multipart/form-data') {
            // A form with files: its fields go in form, and each file input's files in files, by name.
            // A file input left empty arrives as an empty field.
            let parts;
            try {
              parts = await new Response(raw, { headers: { 'content-type': req.headers['content-type'] } }).formData();
            } catch {
              return fail(400, 'Bad request');
            }
            for (const [name, v] of parts) {
              if (typeof v === 'string') form[name] = v;
              else (files[name] ??= []).push({ name: v.name, type: v.type, size: v.size, data: Buffer.from(await v.arrayBuffer()) });
            }
          } else if (type === 'application/json') {
            try {
              data = JSON.parse(raw);
            } catch {
              return fail(400, 'Bad request');
            }
          } else if (!api) return fail(415, 'Unsupported media type'); // an api route reads any body from request.body
        }
        if (!api) {
          if (config.csrf !== false && !sameSite(req, cookies.goal_csrf, form._csrf ?? req.headers['x-csrf-token'])) return fail(403, 'Forbidden');
          const override = String(form._method ?? '').toUpperCase();
          if (method === 'POST' && OVERRIDES.has(override)) m = match(sorted, (method = override), segs);
          delete form._csrf;
          delete form._method;
        }
      }

      if (!m) return fail(404, 'Not found');
      if (m.allow) return send(405, ...(api ? [JSON_TYPE, JSON.stringify({ error: 'Method not allowed' })] : [HTML, errorPage('Method not allowed')]), { allow: m.allow.join(', ') });

      const ctx = _$ctx(token);
      if (dev && req.headers['x-goal-hmr']) {
        // goal dev: a live update (see hmr.js). Components render in the page's order, so each takes
        // the next state the page kept for the same component; one the page didn't have starts anew.
        const kept = (ctx.hmr = keptState(req.headers['x-goal-hmr']));
        ctx.k = (chunk) => {
          const j = kept.findIndex((x) => x?.c === chunk);
          return j < 0 ? null : kept.splice(j, 1)[0].s; // only that one: a component's children render before it
        };
      }
      request = box.r = { method, path, url, tenant, base, params: m.params, query: Object.fromEntries(url.searchParams), headers: req.headers, cookies: api ? {} : cookies, form, files, json: data, body: raw, signal: gone.signal };
      const cookie = (name, value, opts) => {
        if (api) throw new Error('an api route answers without cookies: send a token in a header, like Authorization, instead');
        setCookies.push(serializeCookie(name, value, opts));
      };
      // With tenants by path, a redirect to a path stays in the tenant's
      const go = (to, o) => Object.assign(redirect(to, o), base && !o?.external ? { headers: { location: base + to } } : {});
      const x = { ctx, redirect: go, json, notFound: api ? () => json({ error: 'Not found' }, 404) : notFound, cookie, reply, stream, events };
      // The groups' before blocks run first, outer first: one that returns something answers instead
      let out;
      for (const b of m.route.before ?? []) if ((out = await b(request, x)) !== undefined) break;
      if (out === undefined && m.route.input) out = badInput(request, m.route.input, api); // then the input's types
      if (out === undefined) out = await m.route.handler(request, x);
      let status = 200;
      let extra;
      if (out?.[REPLY] && out.page) ({ status, headers: extra, page: out } = out); // reply(markup, { status, headers })
      if (isHtml(out)) {
        const html = await _$lr(ctx, out.s); // components that waited for a call(), with its answer
        for (const e of ctx.lx ?? []) report(e); // a server function that failed in a call()
        return send(status, HTML, page(html, [...ctx.ev], nonce, token, dev, styles, base), extra);
      }
      if (out === undefined) return send(204);
      if (out?.[REPLY]) return out.stream ? await pipe(out) : send(out.status, out.type, out.body, out.headers);
      throw new Error('a route returns markup, redirect(), json(), reply(), stream(), events(), notFound() or nothing');
    } catch (e) {
      if (e.status === 413) return fail(413, 'Too large');
      report(e);
      return dev ? send(500, 'text/plain; charset=utf-8', String(e.stack)) : fail(500, 'Something went wrong');
    }
  }
}
