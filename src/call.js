// Calling a server function from the browser. A file of its own, so a page whose components call
// none doesn't load it: the bundler splits the browser code by file.

/**
 * Calls a server function from the browser: what a call in an event handler compiles to. The
 * request carries the page's CSRF token and comes from this site, so the server lets it through.
 * call() (load.js) stops one on its way with `signal`. With tenants by path, the page names its
 * tenant's path (`goal-base`), which goes in front.
 */
export const _$sf = async (url, args, signal) => {
  const meta = (n) => document.querySelector(`meta[name=goal-${n}]`)?.content ?? '';
  const token = meta('csrf');
  const res = await fetch(meta('base') + url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': token }, body: JSON.stringify(args), signal });
  if (!res.ok) throw new Error(`server function ${url} failed: ${res.status}`);
  return (await res.json()).v;
};
