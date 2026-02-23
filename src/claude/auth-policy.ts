import process from "node:process";

function parseBooleanFlag(rawValue: string | undefined): boolean {
  if (!rawValue || rawValue.trim().length === 0) {
    return false;
  }
  const normalized = rawValue.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return false;
}

export function shouldUseAnthropicApiKey(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return parseBooleanFlag(env.USE_ANTHROPIC_API_KEY);
}

export function sanitizeAnthropicApiKeyEnv(input: {
  allowApiKey: boolean;
  env?: Record<string, string | undefined>;
  context: string;
  log?: (line: string) => void;
}): { removed: boolean } {
  const env = input.env ?? process.env;
  if (input.allowApiKey) {
    return { removed: false };
  }
  const currentApiKey = env.ANTHROPIC_API_KEY;
  if (!currentApiKey || currentApiKey.trim().length === 0) {
    return { removed: false };
  }
  delete env.ANTHROPIC_API_KEY;
  const log = input.log ?? ((line: string) => console.warn(line));
  log(
    `[auth] ${input.context}: ignoring ANTHROPIC_API_KEY because USE_ANTHROPIC_API_KEY is not true.`,
  );
  return { removed: true };
}

export function isAnthropicCreditBalanceError(message: string): boolean {
  return /(credit balance too low|insufficient credits?|quota exceeded|billing|payment required)/i.test(
    message,
  );
}
