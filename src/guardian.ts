import process from "node:process";
import { renderPreflightReport, runPreflightChecks } from "./bootstrap/preflight";
import { loadConfig } from "./config";
import { buildSignaturePayload, computeGuardianSignature, verifyGuardianAuthorization } from "./guardian/auth";
import { loadGuardianConfig } from "./guardian/config";
import { GuardianSupervisor } from "./guardian/supervisor";

export { buildSignaturePayload, computeGuardianSignature, loadGuardianConfig, verifyGuardianAuthorization };

async function main(): Promise<void> {
  const guardianConfig = loadGuardianConfig();
  const appConfig = loadConfig();
  const preflight = await runPreflightChecks(appConfig);
  console.log(renderPreflightReport(preflight));
  if (preflight.hasFailures) {
    throw new Error("Startup preflight failed. Fix reported checks before running guardian.");
  }

  const supervisor = new GuardianSupervisor(guardianConfig);
  await supervisor.start();

  const onSigint = () => {
    void supervisor.shutdown("SIGINT").finally(() => process.exit(0));
  };
  const onSigterm = () => {
    void supervisor.shutdown("SIGTERM").finally(() => process.exit(0));
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
}

if (import.meta.main) {
  main().catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`guardian startup error: ${detail}`);
    process.exit(1);
  });
}
