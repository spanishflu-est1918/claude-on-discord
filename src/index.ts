import { startApp } from "./app";
import { renderPreflightReport, runPreflightChecks } from "./bootstrap/preflight";
import { loadConfig } from "./config";

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
