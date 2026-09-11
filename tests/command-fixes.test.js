import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtinCommands } from '../src/commands/index.js';
import * as tuiModule from '../src/app/tui-native.js';

const commandList = Object.entries(builtinCommands).map(([name, cmd]) => ({
  name, description: cmd.description || '', usage: cmd.usage || name, aliases: cmd.aliases || [],
}));

const Tui = Object.values(tuiModule).find(v => typeof v === 'function' && v.prototype?.filterCommands);

function pick(token) {
  const fake = { commandList };
  Tui.prototype.filterCommands.call(fake, token);
  return fake.commandFiltered[0]?.name || null;
}

// Enter runs the first palette entry. A substring match in list order sent
// "/models" to /providers, "/config" to /doctor and "/m" to /resume.
test('typing any command name or alias selects that command', () => {
  assert.ok(Tui, 'TUI class with filterCommands must be exported');
  const wrong = [];
  for (const cmd of commandList) {
    for (const token of [cmd.name, ...cmd.aliases]) {
      const picked = pick(token);
      if (picked !== cmd.name) wrong.push(`/${token} → /${picked} (expected /${cmd.name})`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('the palette still finds commands by prefix and by description', () => {
  assert.equal(pick('mod'), 'models');
  const fake = { commandList };
  Tui.prototype.filterCommands.call(fake, 'token usage');
  assert.ok(fake.commandFiltered.some(c => c.name === 'compress'), 'description matches are kept, just ranked last');
  Tui.prototype.filterCommands.call(fake, '');
  assert.equal(fake.commandFiltered.length, commandList.length, 'an empty filter lists everything in order');
  assert.equal(fake.commandFiltered[0].name, commandList[0].name);
});

test('/system names the active provider and the real version', async () => {
  const out = await builtinCommands.system.handler([], { version: '9.9.9' });
  assert.doesNotMatch(out, /\[object Object\]/);
  assert.match(out, /Version: 9\.9\.9/);
});

test('/config effort explains itself and rejects an unknown level without saving', async () => {
  const usage = await builtinCommands.config.handler(['effort'], { config: {} });
  assert.match(usage, /Usage: \/config effort <low\|medium\|high\|xhigh\|max\|default>/);
  const bad = await builtinCommands.config.handler(['effort', 'turbo'], { config: {} });
  assert.match(bad, /Invalid effort/);
});
