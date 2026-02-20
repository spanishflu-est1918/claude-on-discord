export function shouldForceToollessModeForPrompt(prompt: string): boolean {
  return (
    /\baskUserQuestion\b/i.test(prompt) ||
    /\bask\s*user\s*question\b/i.test(prompt) ||
    /do not load that skill/i.test(prompt)
  );
}

export function shouldApplyRunnerSafetyGuards(prompt: string): boolean {
  return (
    shouldForceToollessModeForPrompt(prompt) ||
    /\bmcp\b/i.test(prompt) ||
    (/\b(investigate|research|analy[sz]e)\b/i.test(prompt) && /https?:\/\//i.test(prompt))
  );
}

export function withNoInteractiveToolDirective(prompt: string): string {
  if (!shouldForceToollessModeForPrompt(prompt)) {
    return prompt;
  }
  const directive =
    "System override: do not call askUserQuestion (or any interactive user-input tool). " +
    "Respond with a direct proposal in one pass, without follow-up questions. " +
    "Use no tools, and keep the response concise (maximum 12 bullets).";
  return `${directive}\n\n${prompt}`;
}
