export function clipText(value: string, maxChars: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 3))}...`;
}

export function clipRawText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 3))}...`;
}

export function italicizeMultiline(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim().length === 0 ? "" : `_${line}_`))
    .join("\n");
}
