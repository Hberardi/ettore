// hello-world plugin — minimal example.
//
// What this demonstrates:
//   - declaring a tool with a JSON-schema parameter block
//   - declaring a slash command
//   - using the onLoad lifecycle hook to log a message at enable time
//   - returning structured data from a tool (auto-serialized to JSON)
//
// How to use:
//   1. copy this directory to ~/.config/ettore/plugins/hello-world/
//   2. restart ettore (or `/plugins reload hello-world` once slash commands
//      are wired up)
//   3. the agent can now call the `say_hello` tool and the user can type
//      `/hello` in the TUI

export const tools = {
  say_hello: {
    description: 'Greet someone by name. Returns a friendly string.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Who to greet' },
        excited: { type: 'boolean', description: 'Add an exclamation point', default: false },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async ({ name, excited = false }, ctx) => {
      const suffix = excited ? '!' : '.';
      return {
        greeting: `Hello, ${name}${suffix}`,
        from: ctx.plugin,
        tool: ctx.tool,
      };
    },
  },

  // A second tool — the agent can choose either, depending on what the
  // user asked. Both are scoped to this plugin's namespace.
  count_letters: {
    description: 'Count the letters in a string. Demonstrates a pure tool.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    handler: async ({ text }) => ({ text, length: text.length }),
  },
};

export const commands = {
  hello: {
    description: 'Say hello from the hello-world plugin',
    usage: '/hello [name]',
    handler: async (args) => {
      const name = String(args || '').trim() || 'world';
      return `Hello, ${name}! (from hello-world plugin)`;
    },
  },
};

export const hooks = {
  onLoad: async (api) => {
    api.log('info', 'hello-world plugin loaded');
  },
  onUnload: async (api) => {
    // The api is not passed to onUnload; the runtime invokes it with no
    // args. Use a module-level flag if you need to log here.
  },
};
