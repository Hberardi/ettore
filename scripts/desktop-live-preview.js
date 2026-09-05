// Dev shim. The real implementation is src/cli/preview.js and the
// supported entry point is `ettore preview <id>` — which works from an
// installed copy, where this file does not exist (package.json `files`
// ships bin/ and src/ only).
//
//   node scripts/desktop-live-preview.js <app-id> [interval-ms]

import { livePreview } from '../src/cli/preview.js';

const appId = process.argv[2] || 'default';
const intervalMs = Number(process.argv[3]) || 400;
const width = Number(process.env.ETTORE_ASCII_W) || 80;
const height = Number(process.env.ETTORE_ASCII_H) || 24;

const controller = new AbortController();
process.on('SIGINT', () => {
  controller.abort();
  process.stdout.write('\x1b[2J\x1b[H');
  process.exit(0);
});

await livePreview(appId, { intervalMs, width, height, signal: controller.signal });
