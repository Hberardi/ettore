// Parsing and admission of a provider tool call. The Agent owns transcript
// updates and UI events; this module keeps the input boundary deterministic
// and independently testable.

export function parseToolCall(toolCall, {
  coerceArgs,
  normalizeArgs,
  maxArgumentLength = 50_000,
} = {}) {
  const name = String(toolCall?.function?.name || 'unknown');
  const id = toolCall?.id;
  try {
    const raw = toolCall?.function?.arguments;
    if (typeof raw !== 'string' || raw.length === 0) throw new Error('empty arguments');
    if (raw.length > maxArgumentLength) throw new Error(`arguments too long: ${raw.length} bytes`);
    let args = JSON.parse(raw);
    if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('unexpected type');
    args = coerceArgs ? coerceArgs(name, args) : args;
    args = normalizeArgs ? normalizeArgs(name, args) : args;
    return { id, name, args, parseError: false };
  } catch (error) {
    const raw = String(toolCall?.function?.arguments ?? '').slice(0, 200);
    return {
      id,
      name,
      args: {},
      parseError: true,
      displayError: `Skipped: malformed JSON — ${error.message}`,
      output: `Error: malformed tool call JSON (${error.message}). Raw: ${raw}`,
    };
  }
}

export async function guardToolCall({ name, args, validate, authorize }) {
  const validation = validate(name, args);
  if (!validation.valid) return { allowed: false, reason: 'invalid', output: validation.error };

  const access = await authorize(name, args);
  if (!access.allowed) return { allowed: false, reason: 'policy', output: `Error: ${access.error}` };

  return { allowed: true };
}
