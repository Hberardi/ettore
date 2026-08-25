import { createServer } from 'http';
import { spawn } from 'child_process';
import { createGlobalSkill, validateSkillName } from '../skills/index.js';

const MAX_BODY_BYTES = 64 * 1024;
let server = null;
let studioContext = null;
let serverUrl = null;

async function openBrowser(url) {
  const candidates = process.platform === 'darwin'
    ? [['open', [url]]]
    : process.platform === 'win32'
      ? [['cmd', ['/c', 'start', '', url]]]
      : [
          ['xdg-open', [url]],
          ['gio', ['open', url]],
          ['sensible-browser', [url]],
          ['firefox', [url]],
          ['google-chrome', [url]],
          ['chromium', [url]],
          ['chromium-browser', [url]],
        ];

  for (const [command, args] of candidates) {
    const started = await new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
        child.once('spawn', () => {
          child.unref();
          finish(true);
        });
        child.once('error', () => finish(false));
      } catch {
        finish(false);
      }
    });
    if (started) return true;
  }
  return false;
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request too large.'));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(new Error('Invalid form data.'));
      }
    });
    request.on('error', reject);
  });
}

export function renderSkillStudioPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ETTORE Skill Studio</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #111416; color: #e8ecec; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #111416; }
    main { width: min(760px, calc(100% - 32px)); margin: 0 auto; padding: 52px 0 64px; }
    header { margin-bottom: 30px; }
    .eyebrow { color: #63d6bd; font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 8px 0 10px; font-size: clamp(30px, 6vw, 46px); line-height: 1.05; letter-spacing: 0; }
    .intro { max-width: 600px; margin: 0; color: #aeb9b8; font-size: 16px; line-height: 1.6; }
    form { padding: 28px; border: 1px solid #2b3636; border-radius: 8px; background: #181e1f; box-shadow: 0 16px 40px rgba(0, 0, 0, .24); }
    .field { margin-bottom: 22px; }
    label { display: block; margin-bottom: 8px; color: #e8ecec; font-size: 14px; font-weight: 700; }
    .hint { display: block; margin-top: 7px; color: #82918f; font-size: 12px; line-height: 1.45; }
    input, textarea { width: 100%; border: 1px solid #344141; border-radius: 5px; padding: 12px 13px; background: #101516; color: #f2f5f4; font: inherit; line-height: 1.5; outline: none; }
    input:focus, textarea:focus { border-color: #63d6bd; box-shadow: 0 0 0 3px rgba(99, 214, 189, .14); }
    textarea { min-height: 132px; resize: vertical; }
    .actions { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 8px; }
    button { border: 0; border-radius: 5px; padding: 12px 18px; background: #63d6bd; color: #10201e; cursor: pointer; font: inherit; font-weight: 800; }
    button:hover { background: #8ae6d2; }
    button:disabled { cursor: wait; opacity: .65; }
    #status { min-height: 22px; color: #aeb9b8; font-size: 13px; line-height: 1.5; }
    #status.success { color: #82e3ad; }
    #status.error { color: #ff9c9c; }
    @media (max-width: 560px) { main { padding-top: 32px; } form { padding: 20px; } .actions { align-items: flex-start; flex-direction: column; } button { width: 100%; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="eyebrow">ETTORE / Skill Studio</div>
      <h1>Create a global skill</h1>
      <p class="intro">Define a reusable playbook for the agent. It will be saved in your global ETTORE skills directory and can be activated automatically in any project.</p>
    </header>
    <form id="skill-form">
      <div class="field">
        <label for="name">Skill name</label>
        <input id="name" name="name" required pattern="[a-z][a-z0-9]*(?:-[a-z0-9]+)*" placeholder="api-review" autocomplete="off">
        <span class="hint">Use lowercase kebab-case, for example <code>release-notes</code>.</span>
      </div>
      <div class="field">
        <label for="purpose">What should this skill do?</label>
        <textarea id="purpose" name="purpose" required placeholder="Review an API change for compatibility, validation, and regression risks."></textarea>
        <span class="hint">Describe the workflow, constraints, and decisions the agent should follow.</span>
      </div>
      <div class="field">
        <label for="output">What should the final output look like?</label>
        <textarea id="output" name="output" required placeholder="Return a short report with findings grouped by severity, file references, and recommended fixes."></textarea>
        <span class="hint">Specify the expected structure, level of detail, and any required sections.</span>
      </div>
      <div class="actions">
        <div id="status" role="status" aria-live="polite"></div>
        <button type="submit">Create global skill</button>
      </div>
    </form>
  </main>
  <script>
    const form = document.querySelector('#skill-form');
    const status = document.querySelector('#status');
    const button = form.querySelector('button');
    form.addEventListener('submit', async event => {
      event.preventDefault();
      status.className = '';
      status.textContent = 'Creating skill…';
      button.disabled = true;
      const data = Object.fromEntries(new FormData(form));
      try {
        const response = await fetch('/api/skills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Could not create skill.');
        status.className = 'success';
        status.textContent = 'Created ' + result.name + ' globally. You can close this page.';
        form.reset();
      } catch (error) {
        status.className = 'error';
        status.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

export function parseSkillSubmission(payload) {
  const name = validateSkillName(payload?.name);
  const purpose = String(payload?.purpose || '').trim();
  const output = String(payload?.output || '').trim();
  if (!purpose) throw new Error('Describe what the skill should do.');
  if (!output) throw new Error('Describe the expected final output.');
  return { name, purpose, output };
}

async function handleRequest(request, response) {
  const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
  if (request.method === 'GET' && requestUrl.pathname === '/') {
    const page = renderSkillStudioPage();
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(page),
      'Cache-Control': 'no-store',
    });
    response.end(page);
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/skills') {
    try {
      if (!studioContext?.onCreated) throw new Error('Skill Studio is not initialized.');
      const submission = parseSkillSubmission(await readJson(request));
      const path = await createGlobalSkill(
        submission.name,
        submission.purpose,
        submission.purpose,
        submission.output,
      );
      await studioContext.onCreated({ ...submission, path });
      sendJson(response, 201, { ok: true, name: submission.name, path });
    } catch (error) {
      const status = /already exists|kebab-case|Describe|Invalid|too large/i.test(error.message) ? 400 : 500;
      sendJson(response, status, { ok: false, error: error.message });
    }
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Not found.' });
}

export async function startSkillStudio({ open = true, onCreated } = {}) {
  studioContext = { onCreated: onCreated || (async () => {}) };
  if (server && serverUrl) {
    const browserOpened = open ? await openBrowser(serverUrl) : false;
    return { url: serverUrl, reused: true, browserOpened };
  }

  server = createServer((request, response) => {
    handleRequest(request, response).catch(error => {
      if (!response.headersSent) sendJson(response, 500, { ok: false, error: error.message });
    });
  });
  await new Promise((resolve, reject) => {
    const onError = error => {
      server?.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server?.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  }).catch(error => {
    server = null;
    throw error;
  });

  const address = server.address();
  serverUrl = `http://127.0.0.1:${address.port}`;
  const browserOpened = open ? await openBrowser(serverUrl) : false;
  return { url: serverUrl, reused: false, browserOpened };
}

export async function stopSkillStudio() {
  const activeServer = server;
  server = null;
  serverUrl = null;
  studioContext = null;
  if (!activeServer) return;
  await new Promise(resolve => {
    activeServer.close(() => resolve());
  });
}
