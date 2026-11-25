---
title: Vite
nav_order: 10
---

# Vite

To work on a goal.js app inside Vite's dev server, add the plugin:

```js
// vite.config.js
import { goal } from 'goaljs/vite';

export default {
  plugins: [goal()],
};
```

```bash
npx vite
```

The app works as it does under `goal dev`:

- Vite serves its own modules and the `public/` folder. Every other request goes to the app's routes
  and server functions, with error details and all the [security defaults](security).
- Each component's browser code is a Vite module, and so is the code a component renders other
  components from. The `.goal` files themselves are never served: their server code stays on the
  server.
- [Live updates](how-it-works#live-updates-in-goal-dev) work the same way. A stylesheet change
  applies in place, a code change updates the page with each component's state kept, and a compile
  error shows over the page.

The plugin is for development. For production, build and serve the app with `goal build` and
`goal start`.

## Options

`goal({ config })` takes what `goal.config.js` would hold, such as `{ csrf: false }` or a CSP of your
own. See [Security](security).
