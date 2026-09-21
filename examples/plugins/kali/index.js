// kali — installed security tools, driven for AUTHORIZED testing only.
//
// This plugin does not install Kali or any tool, and ships no exploits. It
// wraps command-line tools you have already installed — nmap, whatweb, nikto,
// gobuster, dnsrecon, sslscan — so the agent can run reconnaissance and
// enumeration during work you are authorised to do: a pentest engagement, a
// CTF, your own lab. Each tool that touches a target is refused unless that
// target is in an explicit authorisation scope, so the plugin cannot be
// pointed at an arbitrary host by an off-hand prompt.
//
// Two properties carry the safety:
//
//   1. The scope gate. `kali_scope` sets the hosts, IPs and CIDR ranges you
//      are cleared to test; every target-taking tool checks its target against
//      that list and refuses anything outside it. The scope lives only in this
//      process — it is not written to disk and does not persist across runs, so
//      each session states its own authorisation deliberately.
//
//   2. No shell string, ever. Every tool runs through execFile with an
//      argument array, so a target or an option can never become a second
//      command however it is spelled. The tools themselves are also fixed:
//      the model chooses arguments from a typed schema, not a free command
//      line.
//
// A tool that is not installed says so and names the package, rather than
// failing with a cryptic ENOENT. Nothing here escalates privileges or runs a
// tool as root.

import { execFile } from 'node:child_process';
import { isIP } from 'node:net';

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

// Set by kali_scope, read by every target-taking tool. Process-local on
// purpose: authorisation is stated per session, never remembered.
const scope = {
  targets: [],      // exact hosts / IPs the user cleared
  cidrs: [],        // { base: <32-bit int>, bits } ranges
  note: '',         // free text: engagement id, ticket, "my lab", …
};

// ── target parsing and scope checks ─────────────────────────────────────────

// A hostname or IP, with an optional :port stripped for the check. Anything
// with a shell metacharacter, a space, or a scheme is rejected outright — a
// target is a host, not a command and not a URL to be reassembled.
function parseTarget(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('no target given');
  if (/[\s;&|`$(){}<>\\'"]/.test(text)) throw new Error(`invalid target "${text}" — a target is a single host or IP, not a command`);
  // Strip a URL scheme and path so a whatweb-style "http://host/x" still maps
  // to a host the scope can check; the tool that needs the full URL keeps it.
  const host = text.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  if (!host) throw new Error(`could not read a host out of "${text}"`);
  return { raw: text, host };
}

function ipToInt(ip) {
  return ip.split('.').reduce((acc, part) => (acc * 256) + Number(part), 0) >>> 0;
}

function inCidr(host, cidr) {
  if (isIP(host) !== 4) return false;
  const mask = cidr.bits === 0 ? 0 : (~0 << (32 - cidr.bits)) >>> 0;
  return (ipToInt(host) & mask) === (cidr.base & mask);
}

function requireInScope(target) {
  if (!scope.targets.length && !scope.cidrs.length) {
    throw new Error(
      'No authorisation scope is set. Before scanning anything, set the targets you are cleared to test with '
      + 'kali_scope (e.g. { action: "set", targets: ["10.0.0.5", "192.168.1.0/24"], note: "my lab" }). '
      + 'This plugin refuses to touch a host outside that scope.',
    );
  }
  const { host } = target;
  if (scope.targets.includes(host)) return;
  if (scope.cidrs.some(cidr => inCidr(host, cidr))) return;
  throw new Error(
    `Target "${host}" is not in the authorisation scope (${describeScope()}). `
    + 'Refusing to scan it. Add it with kali_scope if you are authorised to test it.',
  );
}

function describeScope() {
  const parts = [...scope.targets, ...scope.cidrs.map(c => `${intToIp(c.base)}/${c.bits}`)];
  return parts.length ? parts.join(', ') : '(empty)';
}

function intToIp(int) {
  return [(int >>> 24) & 255, (int >>> 16) & 255, (int >>> 8) & 255, int & 255].join('.');
}

function addToScope(entries) {
  for (const entry of entries) {
    const text = String(entry || '').trim();
    if (!text) continue;
    const cidrMatch = text.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
    if (cidrMatch && isIP(cidrMatch[1]) === 4 && Number(cidrMatch[2]) <= 32) {
      scope.cidrs.push({ base: ipToInt(cidrMatch[1]), bits: Number(cidrMatch[2]) });
      continue;
    }
    const { host } = parseTarget(text);
    if (!scope.targets.includes(host)) scope.targets.push(host);
  }
}

// ── running a tool ──────────────────────────────────────────────────────────

function run(bin, args, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, {
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      signal: signal || undefined,
      // A minimal, non-interactive environment: no inherited pager, no prompt.
      env: { ...process.env, PAGER: 'cat', TERM: 'dumb' },
    }, (error, stdout, stderr) => {
      const out = String(stdout || '');
      const err = String(stderr || '');
      if (error) {
        if (error.code === 'ENOENT') {
          reject(new Error(`"${bin}" is not installed. Install it (e.g. \`sudo apt install ${PACKAGE_FOR[bin] || bin}\`) and try again.`));
          return;
        }
        if (error.killed) {
          reject(new Error(`"${bin}" timed out after ${Math.round(timeoutMs / 1000)}s. Narrow the scan (fewer ports, one target) and retry.`));
          return;
        }
        // Many scanners exit non-zero for "host down" or "nothing found",
        // which is a result, not a crash: return whatever they printed.
        if (out || err) { resolve(clip(out || err)); return; }
        reject(new Error(err.trim() || error.message));
        return;
      }
      resolve(clip(out || err || '(no output)'));
    });
  });
}

const PACKAGE_FOR = {
  nmap: 'nmap',
  whatweb: 'whatweb',
  nikto: 'nikto',
  gobuster: 'gobuster',
  dnsrecon: 'dnsrecon',
  sslscan: 'sslscan',
};

function clip(text) {
  const s = String(text);
  return s.length > 120_000 ? `${s.slice(0, 120_000)}\n… output truncated at 120KB — narrow the scan to see the rest` : s;
}

function boundedInt(value, fallback, { min = 1, max } = {}) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  let bounded = Math.max(min, n);
  if (max !== undefined) bounded = Math.min(max, bounded);
  return bounded;
}

// ── tools ────────────────────────────────────────────────────────────────────

export const tools = {
  kali_scope: {
    // Sets/inspects authorisation. Touches no target, so it is safe in plan mode.
    risk: 'low',
    description:
      'Set or show the authorisation scope — the hosts, IPs and CIDR ranges you are cleared to test in THIS session. '
      + 'Every scanning tool refuses a target outside it. Nothing is scanned; this only records what you are allowed to scan. '
      + 'The scope is not saved to disk and does not persist across runs.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set', 'add', 'show', 'clear'], description: 'set replaces the scope, add extends it, show prints it, clear empties it' },
        targets: { type: 'array', items: { type: 'string' }, description: 'Hosts, IPs, or CIDR ranges (e.g. "10.0.0.5", "scanme.nmap.org", "192.168.1.0/24")' },
        note: { type: 'string', description: 'Why you are authorised: an engagement id, a ticket, "my own lab"' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    handler: async ({ action, targets = [], note }) => {
      if (action === 'show') {
        return { scope: describeScope(), note: scope.note || '(none)', empty: !scope.targets.length && !scope.cidrs.length };
      }
      if (action === 'clear') {
        scope.targets = []; scope.cidrs = []; scope.note = '';
        return 'Scope cleared. No target can be scanned until a new scope is set.';
      }
      if (action === 'set') { scope.targets = []; scope.cidrs = []; }
      if (note !== undefined) scope.note = String(note);
      addToScope(targets);
      return {
        action,
        scope: describeScope(),
        note: scope.note || '(none)',
        reminder: 'Only scan what you are authorised to. This scope is your record of that authorisation.',
      };
    },
  },

  kali_portscan: {
    risk: 'high',
    description:
      'Run nmap against a target IN SCOPE. Ports and speed are chosen from the schema — no raw nmap command line. '
      + 'Use for authorised network reconnaissance. Refuses any target not in the authorisation scope set by kali_scope.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'A single host or IP that is in the authorisation scope' },
        ports: { type: 'string', description: 'Ports: "top100" (default), "top1000", "all", or a list like "22,80,443" / "1-1024"' },
        service_detection: { type: 'boolean', description: 'Identify service and version on open ports (-sV). Default true' },
        os_detection: { type: 'boolean', description: 'Guess the operating system (-O). Needs root; off by default' },
        speed: { type: 'number', description: 'nmap timing 0-5; higher is faster and noisier. Default 4' },
      },
      required: ['target'],
      additionalProperties: false,
    },
    handler: async ({ target, ports = 'top100', service_detection = true, os_detection = false, speed = 4 }, ctx) => {
      const t = parseTarget(target);
      requireInScope(t);
      const args = ['-Pn', `-T${boundedInt(speed, 4, { min: 0, max: 5 })}`];
      const p = String(ports).toLowerCase();
      if (p === 'top100') args.push('--top-ports', '100');
      else if (p === 'top1000') args.push('--top-ports', '1000');
      else if (p === 'all') args.push('-p-');
      else if (/^[0-9,\-]+$/.test(p)) args.push('-p', p);
      else throw new Error(`invalid ports "${ports}" — use top100, top1000, all, or a list like "22,80,443"`);
      if (service_detection) args.push('-sV');
      if (os_detection) args.push('-O');
      args.push('--', t.host);
      return run('nmap', args, { signal: ctx?.signal });
    },
  },

  kali_web_fingerprint: {
    risk: 'medium',
    description:
      'Identify a web server\'s technologies with whatweb — server, framework, CMS, languages. A light, mostly passive probe. '
      + 'Refuses a target not in the authorisation scope.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'A URL or host in scope, e.g. "https://example.com"' },
        aggression: { type: 'number', description: 'whatweb aggression 1-3; 1 is a single passive request. Default 1' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    handler: async ({ url, aggression = 1 }, ctx) => {
      const t = parseTarget(url);
      requireInScope(t);
      return run('whatweb', [`-a${boundedInt(aggression, 1, { min: 1, max: 3 })}`, '--color=never', '--', t.raw], { signal: ctx?.signal });
    },
  },

  kali_web_scan: {
    risk: 'high',
    description:
      'Scan a web server for known issues and misconfigurations with nikto. Active and noisy — use only against a target you are '
      + 'authorised to test. Refuses a target not in the authorisation scope.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Host or URL in scope' },
        port: { type: 'number', description: 'Port, default 80 (or 443 with tls)' },
        tls: { type: 'boolean', description: 'Use HTTPS. Default false' },
      },
      required: ['target'],
      additionalProperties: false,
    },
    handler: async ({ target, port, tls = false }, ctx) => {
      const t = parseTarget(target);
      requireInScope(t);
      const args = ['-host', t.host, '-nointeractive', '-ask', 'no'];
      if (port) args.push('-port', String(boundedInt(port, tls ? 443 : 80, { max: 65535 })));
      if (tls) args.push('-ssl');
      return run('nikto', args, { signal: ctx?.signal, timeoutMs: 600_000 });
    },
  },

  kali_dir_enum: {
    risk: 'high',
    description:
      'Enumerate directories and files on a web server with gobuster and a wordlist you provide. Active and noisy. '
      + 'Refuses a target not in the authorisation scope.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Base URL in scope, e.g. "http://10.0.0.5/"' },
        wordlist: { type: 'string', description: 'Absolute path to a wordlist file (you supply it)' },
        extensions: { type: 'string', description: 'Comma-separated extensions to try, e.g. "php,txt,html"' },
        threads: { type: 'number', description: 'Concurrency 1-50. Default 10' },
      },
      required: ['url', 'wordlist'],
      additionalProperties: false,
    },
    handler: async ({ url, wordlist, extensions, threads = 10 }, ctx) => {
      const t = parseTarget(url);
      requireInScope(t);
      const wl = String(wordlist || '').trim();
      if (!wl.startsWith('/')) throw new Error('wordlist must be an absolute path to a file you provide');
      const args = ['dir', '-u', t.raw, '-w', wl, '-t', String(boundedInt(threads, 10, { max: 50 })), '-q', '--no-color'];
      if (extensions && /^[a-z0-9,]+$/i.test(extensions)) args.push('-x', extensions);
      return run('gobuster', args, { signal: ctx?.signal, timeoutMs: 600_000 });
    },
  },

  kali_dns_enum: {
    risk: 'medium',
    description:
      'Enumerate DNS records for a domain with dnsrecon — A, MX, NS, TXT and a standard walk. Refuses a domain not in the '
      + 'authorisation scope.',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain in scope, e.g. "example.com"' },
      },
      required: ['domain'],
      additionalProperties: false,
    },
    handler: async ({ domain }, ctx) => {
      const t = parseTarget(domain);
      requireInScope(t);
      return run('dnsrecon', ['-d', t.host, '--no-color'], { signal: ctx?.signal });
    },
  },

  kali_tls_scan: {
    risk: 'low',
    description:
      'Inspect a TLS service with sslscan — protocol versions, cipher suites, certificate. A read of what the server offers. '
      + 'Refuses a target not in the authorisation scope.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'host or host:port in scope, e.g. "example.com:443"' },
      },
      required: ['target'],
      additionalProperties: false,
    },
    handler: async ({ target }, ctx) => {
      const t = parseTarget(target);
      requireInScope(t);
      return run('sslscan', ['--no-colour', t.raw], { signal: ctx?.signal });
    },
  },

  kali_tools: {
    // Inventory only; touches nothing.
    risk: 'low',
    description: 'Report which of the wrapped security tools are installed on this machine, and which are missing.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_args, ctx) => {
      const bins = Object.keys(PACKAGE_FOR);
      const rows = await Promise.all(bins.map(async (bin) => {
        try { await run(bin, ['--version'], { signal: ctx?.signal, timeoutMs: 8000 }); return { tool: bin, installed: true }; }
        catch (e) { return { tool: bin, installed: !/not installed/.test(String(e.message)) }; }
      }));
      const missing = rows.filter(r => !r.installed).map(r => r.tool);
      return {
        installed: rows.filter(r => r.installed).map(r => r.tool),
        missing,
        hint: missing.length ? `Install the rest with: sudo apt install ${missing.map(m => PACKAGE_FOR[m]).join(' ')}` : 'All wrapped tools are installed.',
      };
    },
  },
};

export const commands = {
  kali: {
    description: 'Show the security-tool inventory and the current authorisation scope: /kali',
    handler: async (_arg, ctx) => {
      const inv = await tools.kali_tools.handler({}, ctx);
      return [
        `Installed: ${inv.installed.join(', ') || '(none)'}`,
        inv.missing.length ? `Missing:   ${inv.missing.join(', ')}` : 'Missing:   (none)',
        `Scope:     ${describeScope()}${scope.note ? `  — ${scope.note}` : ''}`,
        '',
        'Set the hosts you are authorised to test with kali_scope before scanning anything.',
      ].join('\n');
    },
  },
};

export const hooks = {
  async onLoad(api) {
    api.log('info', 'kali ready — scanning tools gated behind kali_scope (authorised targets only)');
  },
};

// Exposed for tests.
export const _internal = { parseTarget, addToScope, requireInScope, inCidr, describeScope, scope };
