// Resolving a plugin's optional dependencies.
//
// A bundled plugin declares its optional dependency in ETTORE's own
// package.json (`pg`, `exceljs`, `ssh2`) and loads it with
// `createRequire(import.meta.url)`. That works while the plugin sits in
// `examples/plugins/` inside the checkout — which is exactly where the tests
// run it — and stops working the moment it is installed, because the copy
// under `~/.config/ettore/plugins/<name>/` resolves upward through the user's
// home directory and never reaches ETTORE's node_modules.
//
// The symptom was a plugin reporting "dependency is not installed" about a
// dependency that was installed, and no test could have caught it: the tests
// exercise the source in a location no user runs it from.
//
// So resolution is done here, from two roots in order: the plugin's own
// directory first — a plugin may ship or install its own modules, and its
// choice wins — then ETTORE's package root, which is where the optional
// dependencies actually live.

import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// src/plugins/peer-require.js → src/plugins → src → the package root
export const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// `createRequire` only uses the path as a resolution base; the file itself is
// never read and need not exist.
function requireFrom(root) {
  return createRequire(join(root, 'package.json'));
}

// True when the failure is "this module is not installed", as opposed to "this
// module is installed and threw while loading". The two need opposite
// handling, and only the message distinguishes them: a dependency of the
// dependency going missing also raises MODULE_NOT_FOUND.
function isMissing(err, name) {
  return err?.code === 'MODULE_NOT_FOUND' && String(err.message).includes(`'${name}'`);
}

/**
 * Build a `require` for a plugin that can reach ETTORE's own dependencies.
 *
 * The returned function throws a message naming both places it looked, so a
 * user who does need to install something is not left guessing where.
 */
export function makeRequirePeer(pluginRoot = null) {
  const roots = [];
  if (pluginRoot) roots.push(pluginRoot);
  if (!roots.includes(CLI_ROOT)) roots.push(CLI_ROOT);
  const requires = roots.map(requireFrom);

  // Tagged, so a plugin can tell "not installed" from "installed but threw"
  // and keep its own tailored advice for the first case — edi-ftp suggests
  // ftp:// instead of sftp://, which no generic message could know to say.
  const notInstalled = (name) => {
    const err = new Error(
      `optional dependency "${name}" is not installed. Run \`npm install ${name}\` in ${CLI_ROOT}`
      + (pluginRoot && pluginRoot !== CLI_ROOT ? `, or inside the plugin at ${pluginRoot}` : '')
      + '.',
    );
    err.code = 'PEER_NOT_INSTALLED';
    err.dependency = name;
    return err;
  };

  const requirePeer = (name) => {
    for (const req of requires) {
      try {
        return req(name);
      } catch (err) {
        // A module that is present but fails to load is a real error and must
        // not be reported as a missing one.
        if (!isMissing(err, name)) throw err;
      }
    }
    throw notInstalled(name);
  };

  requirePeer.resolve = (name) => {
    for (const req of requires) {
      try {
        return req.resolve(name);
      } catch (err) {
        if (!isMissing(err, name)) throw err;
      }
    }
    throw notInstalled(name);
  };

  requirePeer.roots = roots.slice();
  return requirePeer;
}
