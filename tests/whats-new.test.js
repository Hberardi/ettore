// The release notes shown after an update, and /changelog.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareVersions, parseChangelog, releasesBetween, formatWhatsNew,
  whatsNewOnStartup, changelogText, readChangelog,
} from '../src/app/whats-new.js';

const CHANGELOG = `# Changelog

Intro text.

## [Unreleased]

### Added — something not released yet

## [1.3.0] — 2026-09-27

### Added — a \`github\` plugin: why CI failed

Some prose.

### Fixed

- **A plugin's command did not run from the shell.** More words.
- **\`/plugins enable\` failed** on an enabled plugin.
- **Third fix.** x
- **Fourth fix.** y

## [1.2.0] — 2026-09-20

### Changed — the sidebar is wider

## [1.1.0] — 2026-09-10

### Fixed — a crash

## [1.0.0] — 2026-09-01

### Added — first release
`;

test('versions compare by number, not as text', () => {
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('1.9.0', '1.10.0'), -1);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.3-beta', '1.2.3'), 0);
});

test('the changelog parses into releases, newest first, without Unreleased', () => {
  const releases = parseChangelog(CHANGELOG);
  assert.deepEqual(releases.map((r) => r.version), ['1.3.0', '1.2.0', '1.1.0', '1.0.0']);
  assert.equal(releases[0].date, '2026-09-27');
  assert.deepEqual(releases[0].sections.map((s) => s.title), ['Added — a github plugin: why CI failed', 'Fixed']);
  assert.deepEqual(releases[0].sections[1].items.slice(0, 2), [
    "A plugin's command did not run from the shell",
    '/plugins enable failed',
  ]);
});

test('only the releases after the last one seen are listed', () => {
  const releases = parseChangelog(CHANGELOG);
  assert.deepEqual(releasesBetween(releases, '1.1.0', '1.3.0').map((r) => r.version), ['1.3.0', '1.2.0']);
});

test('the message lists section headings and folds a bare Fixed into its bullets', () => {
  const text = formatWhatsNew(releasesBetween(parseChangelog(CHANGELOG), '1.1.0', '1.3.0'), { current: '1.3.0' });
  assert.match(text, /^✨ ETTORE 1\.3\.0 — what's new/);
  assert.match(text, /1\.3\.0 \(2026-09-27\)/);
  assert.match(text, /• Added — a github plugin: why CI failed/);
  assert.match(text, /• Fixed: A plugin's command did not run from the shell · \/plugins enable failed · Third fix · \+1 more/);
  assert.match(text, /• Changed — the sidebar is wider/);
  assert.doesNotMatch(text, /a crash/, 'a release already seen is not repeated');
  assert.match(text, /\/changelog for the full notes$/);
});

test('long gaps list the latest releases and count the rest', () => {
  const text = formatWhatsNew(parseChangelog(CHANGELOG), { current: '1.3.0', maxReleases: 2 });
  assert.match(text, /…and 2 earlier releases/);
});

test('startup: a fresh install records the version and shows nothing', () => {
  const r = whatsNewOnStartup({ current: '1.3.0', lastSeen: null, upgraded: false, changelog: CHANGELOG });
  assert.deepEqual(r, { message: '', record: '1.3.0' });
});

test('startup: the same version again shows nothing', () => {
  const r = whatsNewOnStartup({ current: '1.3.0', lastSeen: '1.3.0', changelog: CHANGELOG });
  assert.equal(r.message, '');
});

test('startup: after an update the releases in between are shown', () => {
  const r = whatsNewOnStartup({ current: '1.3.0', lastSeen: '1.1.0', changelog: CHANGELOG });
  assert.match(r.message, /1\.3\.0/);
  assert.match(r.message, /1\.2\.0/);
  assert.equal(r.record, '1.3.0');
});

test('startup: a downgrade shows nothing but records the version', () => {
  const r = whatsNewOnStartup({ current: '1.2.0', lastSeen: '1.3.0', changelog: CHANGELOG });
  assert.deepEqual(r, { message: '', record: '1.2.0' });
});

test('startup: an upgrade from before the saved version shows only the current release', () => {
  const r = whatsNewOnStartup({ current: '1.3.0', lastSeen: null, upgraded: true, changelog: CHANGELOG });
  assert.match(r.message, /1\.3\.0/);
  assert.doesNotMatch(r.message, /1\.2\.0/);
});

test('/changelog shows the latest release, or the one asked for, as plain text', () => {
  const latest = changelogText(null, CHANGELOG);
  assert.match(latest, /^ETTORE 1\.3\.0 — 2026-09-27/);
  assert.match(latest, /A plugin's command did not run from the shell\./);
  assert.doesNotMatch(latest, /\*\*|`/);
  assert.doesNotMatch(latest, /something not released yet/);
  assert.match(changelogText('1.1.0', CHANGELOG), /a crash/);
  assert.match(changelogText('9.9.9', CHANGELOG), /No release 9\.9\.9.*1\.3\.0/);
});

test('the shipped changelog parses and its newest release is package.json version or older', async () => {
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const releases = parseChangelog(readChangelog());
  assert.ok(releases.length > 5);
  assert.ok(compareVersions(releases[0].version, pkg.version) <= 0);
});

test('the TUI draws the notes in a bubble, every row inside it', async () => {
  const { TUI } = await import('../src/app/tui-native.js');
  const { stripAllAnsi } = await import('../src/utils/ansi.js');
  const { message } = whatsNewOnStartup({ current: '1.3.0', lastSeen: '1.0.0', changelog: CHANGELOG });
  const rows = new TUI()._renderWhatsNew({ text: message }, 60).map((r) => stripAllAnsi(r)).filter(Boolean);
  assert.match(rows[0], /WHAT'S NEW/);
  assert.equal(new Set(rows.map((r) => [...r].length)).size, 1, 'all rows the same width');
  assert.ok(rows.some((r) => r.includes('• Changed — the sidebar is wider')));
  assert.ok(rows.some((r) => r.includes('1.1.0 (2026-09-10)')));
});
