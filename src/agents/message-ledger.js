import { createHash } from 'crypto';

function normalizedContent(content) {
  if (Array.isArray(content)) return content;
  if (content == null) return '';
  return String(content);
}

function canonicalContent(content, calls) {
  if (!Array.isArray(content)) return normalizedContent(content);
  let callIndex = 0;
  return content.map(block => {
    if (block?.type !== 'tool_use' || callIndex >= calls.length) return block;
    const call = calls[callIndex++];
    let input = {};
    try { input = JSON.parse(call.function.arguments || '{}'); } catch {}
    return {
      ...block,
      id: call.id,
      name: call.function.name,
      input,
    };
  });
}

function stableCallId(call, index) {
  const seed = `${call?.function?.name || 'tool'}:${call?.function?.arguments || ''}:${index}`;
  const hash = createHash('sha1').update(seed).digest('hex').slice(0, 10);
  return `ettore_call_${index}_${hash}`;
}

export function canonicalizeToolTurn(result = {}) {
  const rawCalls = Array.isArray(result.tool_calls) ? result.tool_calls : [];
  const seen = new Set();
  const issues = [];
  const calls = [];

  for (let index = 0; index < rawCalls.length; index++) {
    const raw = rawCalls[index] || {};
    const name = String(raw.function?.name || '').trim();
    if (!name) {
      issues.push({ code: 'missing_tool_name', index });
      continue;
    }

    let id = String(raw.id || '').trim() || stableCallId(raw, index);
    if (!raw.id) issues.push({ code: 'missing_tool_call_id', index, repaired: id });
    if (seen.has(id)) {
      const repaired = `${id}_${index}`;
      issues.push({ code: 'duplicate_tool_call_id', index, id, repaired });
      id = repaired;
    }
    seen.add(id);

    calls.push({
      id,
      type: 'function',
      function: {
        name,
        arguments: typeof raw.function?.arguments === 'string'
          ? raw.function.arguments
          : JSON.stringify(raw.function?.arguments ?? {}),
      },
    });
  }

  return {
    calls,
    issues,
    message: {
      role: 'assistant',
      content: canonicalContent(result.message?.content, calls),
      tool_calls: calls,
    },
  };
}

export function validateMessageHistory(messages = []) {
  const issues = [];
  const globalCallIds = new Set();

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message?.role) {
      issues.push({ code: 'missing_role', index });
      continue;
    }
    if (message.role === 'tool') {
      issues.push({
        code: 'orphan_tool_result',
        index,
        toolCallId: String(message.tool_call_id || ''),
      });
      continue;
    }
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length) {
      continue;
    }

    const expected = [];
    for (let callIndex = 0; callIndex < message.tool_calls.length; callIndex++) {
      const call = message.tool_calls[callIndex];
      const id = String(call?.id || '');
      if (!id) issues.push({ code: 'missing_tool_call_id', index, callIndex });
      if (id && globalCallIds.has(id)) issues.push({ code: 'duplicate_tool_call_id', index, callIndex, id });
      if (id) globalCallIds.add(id);
      expected.push(id);
    }

    const actual = [];
    let cursor = index + 1;
    while (cursor < messages.length && messages[cursor]?.role === 'tool') {
      actual.push(String(messages[cursor].tool_call_id || ''));
      cursor++;
    }

    if (actual.length !== expected.length || actual.some((id, callIndex) => id !== expected[callIndex])) {
      issues.push({
        code: 'tool_result_mismatch',
        index,
        expected,
        actual,
      });
    }
    for (let resultIndex = 0; resultIndex < actual.length; resultIndex++) {
      const id = actual[resultIndex];
      if (!expected.includes(id) || resultIndex >= expected.length) {
        issues.push({
          code: 'orphan_tool_result',
          index: index + 1 + resultIndex,
          toolCallId: id,
        });
      }
    }
    index = cursor - 1;
  }

  return { valid: issues.length === 0, issues };
}

export function repairMessageHistory(messages = []) {
  const repaired = [];
  const issues = [];

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message?.role) {
      issues.push({ code: 'dropped_message_without_role', index });
      continue;
    }
    if (message.role === 'tool') {
      issues.push({
        code: 'dropped_orphan_tool_result',
        index,
        toolCallId: String(message.tool_call_id || ''),
      });
      continue;
    }
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length) {
      repaired.push(message);
      continue;
    }

    const canonical = canonicalizeToolTurn({
      tool_calls: message.tool_calls,
      message,
    });
    issues.push(...canonical.issues.map(issue => ({ ...issue, messageIndex: index })));

    const toolResults = new Map();
    let cursor = index + 1;
    while (cursor < messages.length && messages[cursor]?.role === 'tool') {
      const result = messages[cursor];
      const id = String(result.tool_call_id || '');
      if (id && !toolResults.has(id)) toolResults.set(id, result);
      else issues.push({ code: 'dropped_duplicate_or_empty_tool_result', index: cursor, toolCallId: id });
      cursor++;
    }

    const matchedCalls = canonical.calls.filter(call => toolResults.has(call.id));
    if (matchedCalls.length !== canonical.calls.length) {
      issues.push({
        code: 'removed_unmatched_tool_calls',
        index,
        removed: canonical.calls.filter(call => !toolResults.has(call.id)).map(call => call.id),
      });
    }

    if (matchedCalls.length) {
      repaired.push({ ...canonical.message, tool_calls: matchedCalls });
      for (const call of matchedCalls) {
        const result = toolResults.get(call.id);
        repaired.push({
          role: 'tool',
          tool_call_id: call.id,
          content: String(result.content ?? ''),
        });
      }
    } else if (String(message.content || '').trim()) {
      repaired.push({ role: 'assistant', content: normalizedContent(message.content) });
    }

    index = cursor - 1;
  }

  const validation = validateMessageHistory(repaired);
  return {
    messages: repaired,
    repaired: issues.length > 0,
    issues: [...issues, ...validation.issues],
    valid: validation.valid,
  };
}

export function safeHistoryKeepStart(messages = [], keepLast = 10) {
  let start = Math.max(0, messages.length - Math.max(0, keepLast));
  while (start > 0 && messages[start]?.role === 'tool') start--;
  if (
    start > 0 &&
    messages[start - 1]?.role === 'assistant' &&
    Array.isArray(messages[start - 1].tool_calls) &&
    messages[start - 1].tool_calls.length
  ) {
    start--;
  }
  return start;
}
