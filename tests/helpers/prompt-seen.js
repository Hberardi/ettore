// What the model is shown on one provider call: the system prompt plus the
// one-request recovery overlay, which the agent appends as a trailing message
// so the cached system prompt stays byte-identical across the loop.
export function promptSeen(messages = []) {
  const system = String(messages[0]?.content || '');
  const last = messages[messages.length - 1];
  const text = last?.role === 'user' ? String(last.content || '') : '';
  return text.startsWith('TURN RECOVERY OVERLAY') ? `${system}\n\n${text}` : system;
}
