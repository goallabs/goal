#!/usr/bin/env node
import { main } from '../src/cli.js';

const r = await main(process.argv.slice(2));
if (typeof r === 'number') process.exitCode = r;
