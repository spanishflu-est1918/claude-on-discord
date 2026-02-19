import { startApp } from "./app";
import { renderPreflightReport, runPreflightChecks } from "./bootstrap/preflight";
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
