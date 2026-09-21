// The retryable part of a tool execution is deliberately independent from an
// Agent instance. Scheduling, caching and turn state stay in Agent; this
// module owns only invoking one handler and retrying transient failures.

export async function executeToolHandler({
  name,
  args,
  handler,
  signal,
  executeWithTimeout,
  isTransientError,
  wait,
  onProgress = null,
  maxRetries = 2,
}) {
  if (!handler) return { output: `Unknown tool: ${name}`, retries: 0 };

  const invoke = () => executeWithTimeout(name, (toolSignal) => handler(args, { signal: toolSignal }), signal);
  let retries = 0;
  let output;
  try {
    output = await invoke();
    while (isTransientError(output) && retries < maxRetries) {
      retries++;
      const backoffMs = Math.min(3000, 700 * (2 ** (retries - 1)));
      onProgress?.({
        name,
        key: args?.file_path || args?.command || '',
        message: `Transient error, retry ${retries}/${maxRetries} in ${Math.round(backoffMs / 1000)}s`,
      });
      await wait(backoffMs, signal);
      output = await invoke();
    }
  } catch (error) {
    output = `Error: ${error?.message || error}`;
  }
  return { output, retries };
}
