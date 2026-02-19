export async function consumeStreamLines(
  stream: ReadableStream<Uint8Array> | null | undefined,
  onLine: (line: string) => void,
): Promise<void> {
  if (!stream) {
    return;
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    pending += decoder.decode(value, { stream: true });
    while (true) {
      const newlineIndex = pending.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      const line = pending.slice(0, newlineIndex).replace(/\r$/, "");
      pending = pending.slice(newlineIndex + 1);
      if (line.trim().length > 0) {
        onLine(line);
      }
    }
  }
  const rest = pending.trim();
  if (rest.length > 0) {
    onLine(rest);
  }
}
