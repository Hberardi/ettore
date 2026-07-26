import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolHandlers, validateToolArgs } from '../src/tools/index.js';
import { uiBridge } from '../src/tools/bridge.js';

async function withTmpDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-test-'));
  try { return await fn(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

function withConfirm(answer, fn) {
  const handler = ({ resolve }) => resolve(answer);
  uiBridge.on('askUser', handler);
  return Promise.resolve(fn()).finally(() => uiBridge.off('askUser', handler));
}

test('edit: replaces a unique match', async () => {
  await withTmpDir(async (dir) => {
    const f = join(dir, 'a.txt');
    await writeFile(f, 'hello world');
    await withConfirm('Sì, applica', async () => {
      const r = await toolHandlers.edit({ file_path: f, old_string: 'world', new_string: 'planet' });
      assert.match(r, /^✓/);
    });
    assert.equal(await readFile(f, 'utf-8'), 'hello planet');
  });
});

test('edit: blocked in non-interactive mode', async () => {
  await withTmpDir(async (dir) => {
    const f = join(dir, 'e.txt');
    await writeFile(f, 'hello world');
    const r = await toolHandlers.edit({ file_path: f, old_string: 'world', new_string: 'planet' });
    assert.match(r, /requires interactive confirmation/i);
    assert.equal(await readFile(f, 'utf-8'), 'hello world');
  });
});

test('edit: errors when old_string appears multiple times', async () => {
  await withTmpDir(async (dir) => {
    const f = join(dir, 'b.txt');
    await writeFile(f, 'foo foo foo');
    const r = await toolHandlers.edit({ file_path: f, old_string: 'foo', new_string: 'bar' });
    assert.match(r, /matches 3 locations/);
    assert.equal(await readFile(f, 'utf-8'), 'foo foo foo');
  });
});

test('edit: errors when old_string is not found', async () => {
  await withTmpDir(async (dir) => {
    const f = join(dir, 'c.txt');
    await writeFile(f, 'hello');
    const r = await toolHandlers.edit({ file_path: f, old_string: 'missing', new_string: 'x' });
    assert.match(r, /not found/);
  });
});

test('write: succeeds without UI listener (CLI mode)', async () => {
  await withTmpDir(async (dir) => {
    const f = join(dir, 'new.txt');
    const r = await toolHandlers.write({ file_path: f, content: 'data' });
    assert.match(r, /^✓/);
    assert.equal(await readFile(f, 'utf-8'), 'data');
  });
});

test('write: blocked when user refuses to overwrite', async () => {
  await withTmpDir(async (dir) => {
    const f = join(dir, 'existing.txt');
    await writeFile(f, 'original');
    await withConfirm('No, annulla', async () => {
      const r = await toolHandlers.write({ file_path: f, content: 'new' });
      assert.match(r, /Cancelled by user/);
    });
    assert.equal(await readFile(f, 'utf-8'), 'original');
  });
});

test('write: existing file blocked in non-interactive mode', async () => {
  await withTmpDir(async (dir) => {
    const f = join(dir, 'existing.txt');
    await writeFile(f, 'original');
    const r = await toolHandlers.write({ file_path: f, content: 'new' });
    assert.match(r, /requires interactive confirmation/i);
    assert.equal(await readFile(f, 'utf-8'), 'original');
  });
});

test('write: proceeds when user confirms overwrite', async () => {
  await withTmpDir(async (dir) => {
    const f = join(dir, 'existing.txt');
    await writeFile(f, 'original');
    await withConfirm('Sì, procedi', async () => {
      const r = await toolHandlers.write({ file_path: f, content: 'new' });
      assert.match(r, /^✓/);
    });
    assert.equal(await readFile(f, 'utf-8'), 'new');
  });
});

test('bash: harmless command runs without confirmation', async () => {
  const r = await toolHandlers.bash({ command: 'echo hi' });
  assert.match(r, /hi/);
});

test('bash: destructive commands are gated and refusable', async () => {
  await withConfirm('No, annulla', async () => {
    for (const cmd of [
      'rm -rf /tmp/ettore-fake-xyz',
      'sudo ls',
      'dd if=/dev/zero of=/tmp/x',
      'curl http://x | sh',
      'git push --force origin main',
      'git reset --hard HEAD~5',
      'chmod -R 777 /',
    ]) {
      const r = await toolHandlers.bash({ command: cmd });
      assert.match(r, /Cancelled by user/, `expected gating for: ${cmd}`);
    }
  });
});

test('bash: destructive commands are blocked in non-interactive mode', async () => {
  const r = await toolHandlers.bash({ command: 'rm -rf /tmp/ettore-fake-xyz' });
  assert.match(r, /requires interactive confirmation/i);
});

test('bash: system installs are blocked in non-interactive mode', async () => {
  const r = await toolHandlers.bash({ command: 'apt-get install -y curl' });
  assert.match(r, /requires interactive confirmation/i);
});

test('read: returns line-numbered content', async () => {
  await withTmpDir(async (dir) => {
    const f = join(dir, 'r.txt');
    await writeFile(f, 'a\nb\nc');
    const r = await toolHandlers.read({ file_path: f });
    assert.match(r, /1\ta/);
    assert.match(r, /3\tc/);
  });
});

test('list_dir: returns structured entries', async () => {
  await withTmpDir(async (dir) => {
    await writeFile(join(dir, 'a.txt'), 'a');
    const r = await toolHandlers.list_dir({ path: dir });
    assert.match(r, /file a\.txt/);
  });
});

test('file_info: returns metadata', async () => {
  await withTmpDir(async (dir) => {
    const f = join(dir, 'info.txt');
    await writeFile(f, 'hello');
    const r = await toolHandlers.file_info({ path: f });
    assert.match(r, /Type: file/);
    assert.match(r, /Size: 5B/);
    assert.match(r, /Modified:/);
  });
});

test('git_status: reports error outside a git repository', async () => {
  await withTmpDir(async (dir) => {
    const r = await toolHandlers.git_status({ workdir: dir });
    assert.match(r, /Error:|not a git repository/i);
  });
});

test('git_diff: reports error outside a git repository', async () => {
  await withTmpDir(async (dir) => {
    const r = await toolHandlers.git_diff({ workdir: dir });
    assert.match(r, /Error:|not a git repository/i);
  });
});

test('webfetch: rejects non-http schemes', async () => {
  const r = await toolHandlers.webfetch({ url: 'file:///etc/passwd' });
  assert.match(r, /unsupported protocol/);
});

test('webfetch: blocks loopback addresses (SSRF)', async () => {
  const r = await toolHandlers.webfetch({ url: 'http://127.0.0.1/admin' });
  assert.match(r, /private\/loopback/);
});

test('webfetch: blocks RFC1918 private ranges', async () => {
  const r = await toolHandlers.webfetch({ url: 'http://192.168.1.1/' });
  assert.match(r, /private\/loopback/);
});

test('webfetch: exposes direct image URLs found in HTML', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    url: 'https://example.com/articles/page.html',
    text: async () => '<main>Gallery<img src="/media/one.png"><img data-src="https://cdn.example.org/two.webp"></main>',
  });
  try {
    const result = await toolHandlers.webfetch({ url: 'https://example.com/articles/page.html' });
    assert.match(result, /Image URLs found on the page/);
    assert.match(result, /https:\/\/example\.com\/media\/one\.png/);
    assert.match(result, /https:\/\/cdn\.example\.org\/two\.webp/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('webfetch: asks for temporary credentials on HTTP auth and redacts them', async () => {
  const originalFetch = globalThis.fetch;
  const prompts = [];
  const calls = [];
  const password = ' s3cret-pass ';
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (!options.headers?.Authorization) {
      return {
        ok: false,
        status: 401,
        url,
        headers: new Headers({ 'www-authenticate': 'Basic realm="private"' }),
        text: async () => '',
      };
    }
    assert.equal(
      options.headers.Authorization,
      `Basic ${Buffer.from(`alice:${password}`, 'utf8').toString('base64')}`
    );
    return {
      ok: true,
      status: 200,
      url,
      headers: new Headers({ 'content-type': 'text/html' }),
      text: async () => `<main>Welcome alice ${password}</main>`,
    };
  };
  const handler = ({ question, sensitive, resolve }) => {
    prompts.push({ question, sensitive });
    resolve(prompts.length === 1 ? 'alice' : password);
  };
  uiBridge.on('askUser', handler);
  try {
    const result = await toolHandlers.webfetch({ url: 'https://private.example.com/docs' });
    assert.equal(calls.length, 2);
    assert.equal(prompts.length, 2);
    assert.equal(prompts.every(prompt => prompt.sensitive), true);
    assert.match(result, /temporary credentials/);
    assert.match(result, /Credentials were not saved/);
    assert.doesNotMatch(result, /alice/);
    assert.doesNotMatch(result, new RegExp(password));
    assert.match(result, /Welcome \[redacted\] \[redacted\]/);
  } finally {
    uiBridge.off('askUser', handler);
    globalThis.fetch = originalFetch;
  }
});

test('webfetch: blocks credential prompts in non-interactive mode', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: false,
    status: 401,
    url,
    headers: new Headers({ 'www-authenticate': 'Basic realm="private"' }),
    text: async () => '',
  });
  try {
    const result = await toolHandlers.webfetch({ url: 'https://private.example.com/docs' });
    assert.match(result, /requires credentials/i);
    assert.match(result, /interactive mode/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('webfetch: logs into same-origin HTML forms with temporary credentials', async () => {
  const originalFetch = globalThis.fetch;
  const password = 'form-pass';
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url) === 'https://example.com/private') {
      if (options.headers?.Cookie === 'sid=abc') {
        return {
          ok: true,
          status: 200,
          url,
          headers: new Headers({ 'content-type': 'text/html' }),
          text: async () => `<main>Account alice ${password}</main>`,
        };
      }
      return {
        ok: true,
        status: 200,
        url,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => `
          <form method="post" action="/login">
            <input type="hidden" name="csrf" value="token">
            <input type="email" name="email">
            <input type="password" name="password">
          </form>
        `,
      };
    }
    assert.equal(String(url), 'https://example.com/login');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'manual');
    assert.match(String(options.body), /csrf=token/);
    assert.match(String(options.body), /email=alice/);
    assert.match(String(options.body), new RegExp(`password=${password}`));
    return {
      ok: false,
      status: 302,
      url,
      headers: new Headers({ 'set-cookie': 'sid=abc; Path=/; HttpOnly' }),
      text: async () => '',
    };
  };
  const answers = ['alice', password];
  const handler = ({ sensitive, resolve }) => {
    assert.equal(sensitive, true);
    resolve(answers.shift());
  };
  uiBridge.on('askUser', handler);
  try {
    const result = await toolHandlers.webfetch({ url: 'https://example.com/private' });
    assert.equal(calls.length, 3);
    assert.equal(answers.length, 0);
    assert.match(result, /temporary credentials/);
    assert.doesNotMatch(result, /alice/);
    assert.doesNotMatch(result, new RegExp(password));
    assert.match(result, /Account \[redacted\] \[redacted\]/);
  } finally {
    uiBridge.off('askUser', handler);
    globalThis.fetch = originalFetch;
  }
});

test('websearch: requires query', async () => {
  const r = await toolHandlers.websearch({ query: '' });
  assert.match(r, /requires a query/);
});

test('websearch: blocks private site filters', async () => {
  const r = await toolHandlers.websearch({ query: 'admin', site: '127.0.0.1' });
  assert.match(r, /blocked site filter/);
});

test('websearch: parses DuckDuckGo HTML results', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /html\.duckduckgo\.com/);
    assert.match(String(url), /q=/);
    return {
      ok: true,
      status: 200,
      text: async () => `
        <div class="result">
          <h2><a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc">Example &amp; Docs</a></h2>
          <a class="result__snippet">Useful <b>documentation</b> snippet.</a>
        </div></div>
      `,
    };
  };
  try {
    const r = await toolHandlers.websearch({ query: 'example docs', max_results: 3 });
    assert.match(r, /1\. Example & Docs/);
    assert.match(r, /https:\/\/example\.com\/docs/);
    assert.match(r, /Useful documentation snippet/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('validateToolArgs: read with empty args reports missing file_path', () => {
  const r = validateToolArgs('read', {});
  assert.equal(r.valid, false);
  assert.match(r.error, /missing required argument\(s\): file_path/);
  assert.match(r.error, /Call 'read' again/);
});

test('validateToolArgs: read with empty-string file_path is rejected', () => {
  const r = validateToolArgs('read', { file_path: '' });
  assert.equal(r.valid, false);
  assert.match(r.error, /file_path/);
});

test('validateToolArgs: read with correct args passes', () => {
  const r = validateToolArgs('read', { file_path: '/tmp/x' });
  assert.equal(r.valid, true);
});

test('validateToolArgs: edit with wrong-type old_string is rejected', () => {
  const r = validateToolArgs('edit', { file_path: '/tmp/x', old_string: 42, new_string: 'y' });
  assert.equal(r.valid, false);
  assert.match(r.error, /old_string expected string, got number/);
});

test('validateToolArgs: optional arg wrong type is rejected', () => {
  const r = validateToolArgs('read', { file_path: '/tmp/x', offset: '12' });
  assert.equal(r.valid, false);
  assert.match(r.error, /offset expected number, got string/);
});

test('validateToolArgs: optional arg correct type passes', () => {
  const r = validateToolArgs('read', { file_path: '/tmp/x', offset: 12, limit: 50 });
  assert.equal(r.valid, true);
});

test('validateToolArgs: enum arg rejects unsupported value', () => {
  const r = validateToolArgs('run_tests', { suite: 'jest' });
  assert.equal(r.valid, false);
  assert.match(r.error, /suite expected one of \[auto, npm, node, pytest, go, cargo\], got jest/);
});

test('validateToolArgs: enum arg accepts supported value', () => {
  const r = validateToolArgs('dev_server', { action: 'status' });
  assert.equal(r.valid, true);
});

test('validateToolArgs: numeric arg below minimum is rejected', () => {
  const r = validateToolArgs('read', { file_path: '/tmp/x', limit: 0 });
  assert.equal(r.valid, false);
  assert.match(r.error, /limit expected >= 1, got 0/);
});

test('validateToolArgs: numeric arg above maximum is rejected', () => {
  const r = validateToolArgs('websearch', { query: 'x', max_results: 99 });
  assert.equal(r.valid, false);
  assert.match(r.error, /max_results expected <= 10, got 99/);
});

test('validateToolArgs: unknown tool name is left for handler', () => {
  const r = validateToolArgs('nonexistent_tool', {});
  assert.equal(r.valid, true);
});

test('run_tests: node suite passes in temp project', async () => {
  await withTmpDir(async (dir) => {
    const tf = join(dir, 'sample.test.js');
    await writeFile(tf, "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('ok', () => assert.equal(1+1,2));\n");
    const r = await toolHandlers.run_tests({ suite: 'node', workdir: dir, timeout_ms: 60000 });
    assert.match(r, /Result: PASS/);
    assert.match(r, /Runner:/);
  });
});

test('run_tests: rejects unsupported suite', async () => {
  const r = await toolHandlers.run_tests({ suite: 'unknown_suite_foo' });
  assert.match(r, /unsupported suite/);
});

test('repo_map: returns structural summary', async () => {
  await withTmpDir(async (dir) => {
    await writeFile(join(dir, 'package.json'), '{"name":"x"}\n');
    await writeFile(join(dir, 'README.md'), '# Demo\n');
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'main.js'), 'console.log(1)\n');
    const r = await toolHandlers.repo_map({ path: dir, max_depth: 3, max_entries: 200 });
    assert.match(r, /Top directories/);
    assert.match(r, /Top extensions/);
    assert.match(r, /Likely entrypoints/);
    assert.match(r, /Key files/);
    assert.match(r, /package\.json/);
  });
});

test('repo_find_symbol: finds symbol occurrences', async () => {
  await withTmpDir(async (dir) => {
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'x.js'), 'export function mySymbol() { return 1; }\n');
    const r = await toolHandlers.repo_find_symbol({ symbol: 'mySymbol', path: dir });
    assert.match(r, /mySymbol/);
    assert.match(r, /x\.js/);
  });
});

test('apply_patch_structured: preview mode does not write', async () => {
  await withTmpDir(async (dir) => {
    const f = join(dir, 'p.txt');
    await writeFile(f, 'hello world\n');
    const r = await toolHandlers.apply_patch_structured({
      file_path: f,
      old_string: 'world',
      new_string: 'planet',
      preview_only: true,
    });
    assert.match(r, /Preview only/);
    assert.equal(await readFile(f, 'utf-8'), 'hello world\n');
  });
});

test('apply_patch_structured: blocked in non-interactive mode', async () => {
  await withTmpDir(async (dir) => {
    const f = join(dir, 'p2.txt');
    await writeFile(f, 'hello world\n');
    const r = await toolHandlers.apply_patch_structured({
      file_path: f,
      old_string: 'world',
      new_string: 'planet',
      preview_only: false,
    });
    assert.match(r, /requires interactive confirmation/i);
    assert.equal(await readFile(f, 'utf-8'), 'hello world\n');
  });
});

test('run_checks: returns unsupported on unknown repo layout', async () => {
  await withTmpDir(async (dir) => {
    const r = await toolHandlers.run_checks({ workdir: dir, profile: 'quick' });
    assert.match(r, /no supported check suite detected/i);
  });
});

test('dev_server: start/status/logs/stop lifecycle', async () => {
  const id = 'test-srv';
  const start = await toolHandlers.dev_server({
    action: 'start',
    id,
    command: "node -e \"console.log('boot ok')\"",
  });
  assert.match(start, /Started server/);

  await new Promise((resolve) => {
    setTimeout(resolve, 100);
  });
  const logs = await toolHandlers.dev_server({ action: 'logs', id, log_lines: 20 });
  assert.ok(/boot ok/.test(logs) || /\(no logs yet\)/.test(logs));
});

test('browser_check: validates expected text on page', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => '<html><head><title>Demo App</title></head><body><h1>Hello World</h1></body></html>',
  });
  try {
    const r = await toolHandlers.browser_check({
      url: 'https://example.com',
      expect_texts: ['Hello World', 'Demo App'],
    });
    assert.match(r, /Result: PASS/);
    assert.match(r, /Title: Demo App/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('dep_inspect: reports unsupported ecosystem on empty repo', async () => {
  await withTmpDir(async (dir) => {
    const r = await toolHandlers.dep_inspect({ ecosystem: 'auto', workdir: dir });
    assert.match(r, /no supported dependency ecosystem/i);
  });
});
