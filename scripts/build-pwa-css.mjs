#!/usr/bin/env bun
// Compiles the app's Tailwind CSS. Bun bundles JS/TS/HTML but does not run
// PostCSS, so the stylesheet is built ahead of `bun build` and linked from
// src/standalone/index.html.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';

const root = process.cwd();
const input = resolve(root, 'src/standalone/styles/standalone.css');
const output = resolve(root, 'src/standalone/styles/app.css');

const css = await readFile(input, 'utf8');
const result = await postcss([tailwindcss()]).process(css, { from: input, to: output });

await mkdir(dirname(output), { recursive: true });
await writeFile(output, result.css, 'utf8');

console.log(`built ${output} (${result.css.length} bytes)`);
