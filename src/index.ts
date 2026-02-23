import { startApp } from "./app";
import { renderPreflightReport, runPreflightChecks } from "./bootstrap/preflight";
import { describeAnthropicAuthMode, sanitizeAnthropicApiKeyEnv } from "./claude/auth-policy";
import { loadConfig } from "./config";

process.on("unhandledRejection", (reason) => {
  const detail = reason instanceof Error ? reason.message : String(reason);
  console.error(`unhandled rejection: ${detail}`);
});

process.on("uncaughtException", (error) => {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`uncaught exception: ${detail}`);
});

async function main() {
  const config = loadConfig();
  const allowApiKey = config.useAnthropicApiKey === true;
  console.log(
    describeAnthropicAuthMode({
      allowApiKey,
      context: "worker startup",
    }),
  );
  const sanitizeResult = sanitizeAnthropicApiKeyEnv({
    allowApiKey,
    context: "worker startup",
  });
  if (!allowApiKey && !sanitizeResult.hadApiKey) {
    console.log("[auth] worker startup: no ANTHROPIC_API_KEY present.");
  }
  const preflight = await runPreflightChecks(config);
  console.log(renderPreflightReport(preflight));
  if (preflight.hasFailures) {
    throw new Error("Startup preflight failed. Fix the reported checks and retry.");
  }
  await startApp(config);
}

main().catch((error) => {
  console.error("fatal startup error", error);
  process.exit(1);
});
