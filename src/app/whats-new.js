// What changed since the last time the user ran ETTORE.
//
// An update arrived silently: the version number in the sidebar changed and
// nothing said what came with it, so a new command or a fixed bug went
// unnoticed until someone read CHANGELOG.md on GitHub. The changelog ships in
// the npm package; at startup the TUI compares the running version with the
// last one it saw and, when it moved forward, shows the headings of every
// release in between as an info message. `/changelog` shows the notes in full.
//
// A fresh install has seen nothing and gets no list — only when an earlier
// version left a trace (the saved version, or a configured provider from
// before this existed) is there something to have missed.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHANGELOG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../CHANGELOG.md');
const RELEASE_RE = /^## \[(\d+\.\d+\.\d+)\](?:\s*[—-]\s*(\S+))?/;

/** The shipped CHANGELOG.md, or '' when it is missing. */
export function readChangelog(path = CHANGELOG_PATH) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** -1, 0 or 1 comparing two `x.y.z` versions; anything after the numbers is ignored. */
export function compareVersions(a, b) {
  const parts = (v) => String(v || '').replace(/^v/, '').split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  }
  return 0;
}

const plain = (text) => String(text || '').replace(/\*\*|`/g, '').trim();

/**
 * The released versions of a changelog, newest first:
 * `{ version, date, body, sections: [{ title, items }] }`, where `items` are
 * the bold leads of the section's bullets. `[Unreleased]` is left out.
 */
export function parseChangelog(text) {
  const releases = [];
  let release = null;
  let section = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      const match = RELEASE_RE.exec(line);
      release = match ? { version: match[1], date: match[2] || null, body: [], sections: [] } : null;
      if (release) releases.push(release);
      section = null;
      continue;
    }
    if (!release) continue;
    release.body.push(line);
    if (line.startsWith('### ')) {
      section = { title: plain(line.slice(4)), items: [] };
      release.sections.push(section);
      continue;
    }
    const lead = /^- \*\*(.+?)\*\*/.exec(line);
    if (section && lead) section.items.push(plain(lead[1]).replace(/[.:]$/, ''));
  }
  for (const r of releases) r.body = r.body.join('\n').trim();
  return releases;
}

/** Releases newer than `since`, up to and including `current`, newest first. */
export function releasesBetween(releases, since, current) {
  return releases.filter((r) => compareVersions(r.version, since) > 0 && compareVersions(r.version, current) <= 0);
}

/**
 * The info message for `releases` (newest first): one line per section, the
 * bullets of a bare "### Fixed" folded into it. At most `maxReleases` are
 * listed; older ones are counted.
 */
export function formatWhatsNew(releases, { current, maxReleases = 3, maxItems = 3 } = {}) {
  if (!releases.length) return '';
  const lines = [`✨ ETTORE ${current || releases[0].version} — what's new since you last ran it:`];
  for (const r of releases.slice(0, maxReleases)) {
    lines.push(`${r.version}${r.date ? ` (${r.date})` : ''}`);
    for (const s of r.sections) {
      // "Added — a github plugin" says it all; a bare "Fixed" needs its bullets.
      if (/\s[—-]\s/.test(s.title) || !s.items.length) {
        lines.push(`  • ${s.title}`);
        continue;
      }
      const shown = s.items.slice(0, maxItems).join(' · ');
      const more = s.items.length > maxItems ? ` · +${s.items.length - maxItems} more` : '';
      lines.push(`  • ${s.title}: ${shown}${more}`);
    }
  }
  const older = releases.length - maxReleases;
  if (older > 0) lines.push(`…and ${older} earlier release${older === 1 ? '' : 's'}`);
  lines.push('/changelog for the full notes');
  return lines.join('\n');
}

/**
 * What to show at startup. `lastSeen` is the saved version (or null),
 * `upgraded` says an earlier install left config behind without one.
 * Returns `{ message, record }`: the text to show ('' for none) and the
 * version to save as seen.
 */
export function whatsNewOnStartup({ current, lastSeen = null, upgraded = false, changelog = readChangelog() } = {}) {
  if (!current) return { message: '', record: null };
  const record = current;
  if (lastSeen && compareVersions(current, lastSeen) <= 0) return { message: '', record };
  if (!lastSeen && !upgraded) return { message: '', record };
  const releases = parseChangelog(changelog);
  // With no saved version, an upgrade shows only the release it landed on.
  const since = lastSeen || releases.find((r) => compareVersions(r.version, current) < 0)?.version || '0.0.0';
  const message = formatWhatsNew(releasesBetween(releases, since, current), { current });
  return { message, record };
}

/** `/changelog [version]`: the full notes of one release, as plain text. */
export function changelogText(version = null, changelog = readChangelog()) {
  const releases = parseChangelog(changelog);
  if (!releases.length) return 'No changelog found in this installation.';
  const release = version ? releases.find((r) => r.version === String(version).replace(/^v/, '')) : releases[0];
  if (!release) {
    return `No release ${version} in the changelog. Known: ${releases.slice(0, 8).map((r) => r.version).join(', ')}${releases.length > 8 ? ', …' : ''}`;
  }
  const body = release.body
    .split('\n')
    .map((line) => (line.startsWith('### ') ? plain(line.slice(4)) : line.replace(/\*\*|`/g, '')))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  const others = releases.filter((r) => r !== release).slice(0, 5).map((r) => r.version);
  return [
    `ETTORE ${release.version}${release.date ? ` — ${release.date}` : ''}`,
    '',
    body,
    '',
    others.length ? `Use /changelog <version> for another release: ${others.join(', ')}` : '',
  ].join('\n').trim();
}
