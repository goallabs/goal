// The request a server function runs for, wherever it's called from: an event handler's call, a
// route, or a page rendering with call(). Server only (node:async_hooks): app.js runs each request in
// its own box, and a server function's body begins with `const request = _$req()` (see compiler.js).

import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage();

/** Runs f with a box that will hold the request (app.js puts it in once it has read the body). */
export const _$box = (box, f) => store.run(box, f);

/** The request being answered, or undefined outside one (a script, a test). */
export const _$req = () => store.getStore()?.r;
