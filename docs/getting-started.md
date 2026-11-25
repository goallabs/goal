---
title: Getting started
nav_order: 2
---

# Getting started

## Install

goal.js needs Node.js. Make a folder for your app and install it there:

```bash
mkdir my-app && cd my-app
npm init -y
npm install goaljs
```

## Your first app

An app is a folder of `.goal` files. Create `app.goal`:

```jsx
import { Counter } from './Counter.goal';

route GET / {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>My app</title>
      </head>
      <body>
        <h1>Hello</h1>
        <Counter start={1} />
      </body>
    </html>
  );
}
```

And `Counter.goal`:

```jsx
export function Counter({ start }) {
  var count = start;
  return <button onclick={() => count++}>Clicked {count} times</button>;
}
```

Then start the development server:

```bash
npx goal dev .
```

Open <http://localhost:3000> and click the button. The page was rendered on the server; the
component's code loaded when you pointed at the button, and the click updated only the number.

## Commands

```bash
goal dev <app>      # build, serve with error details, rebuild when a file changes
goal build <app>    # compile into <app>/dist; prints the routes and each chunk's size
goal start <app>    # serve a built app (--port 3000)
```

`goal build` fails if a component's chunk is over 1 KB gzipped, and prints each chunk's size.

## What goes in an app

- `.goal` files, anywhere in the folder: [routes](routes) and [components](components).
- `.js` and `.json` files for server code the `.goal` files import.
- A `public/` folder for CSS, images and fonts, served as they are.
- An optional `goal.config.js` that changes the [security defaults](security).

Other folders are fine too: `goal build` skips `node_modules` and `dist`.
