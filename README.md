# goal.js

A compiled JavaScript framework where **`var` is state** and **`let`/`const` are computed**. Pages are
rendered on the server and the browser **resumes** them instead of hydrating: no component code runs at
load, and each component's code, in a small chunk of its own, loads on its first event. Components
reach the server through **server functions**, with no `async` and no `fetch`. It is **secure by
default**.

**Documentation: <https://goallabs.github.io/goal/>**

```jsx
// app.goal
import { Counter } from './Counter.goal';

route GET / {
  return <main><h1>Hello</h1><Counter start={1} /></main>;
}
```

```jsx
// Counter.goal
export function Counter({ start }) {
  var count = start;                         // state
  const double = count * 2;                  // computed

  return (
    <div>
      <button onclick={() => count++}>+</button>
      <p>{double}</p>
      {if (count > 9) <b>big</b> else <span>small</span>}
    </div>
  );
}
```

## Install

```bash
npm install goaljs
npx goal dev .        # build the app in this folder, serve it on http://localhost:3000, rebuild on save
```

[Getting started](https://goallabs.github.io/goal/getting-started) walks through a first app. The docs
also cover [routes](https://goallabs.github.io/goal/routes),
[components](https://goallabs.github.io/goal/components),
[server functions](https://goallabs.github.io/goal/server-functions),
[security](https://goallabs.github.io/goal/security),
[how it works](https://goallabs.github.io/goal/how-it-works) and
[performance](https://goallabs.github.io/goal/performance).

## Working on goal.js

```bash
npm install
npm run demo            # builds examples/demo, serves it on http://localhost:3000, rebuilds on save
npm test                # the tests, with 100% coverage of src/ required
npm run bench:virtual   # a 100,000-row virtual list in headless Chrome: speed and memory
```

The docs site is the `docs/` folder, published by GitHub Pages. `editors/vscode` is the VS Code
extension.

## License

MIT
