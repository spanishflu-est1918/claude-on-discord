#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function printHelp() {
  console.log("claude-on-discord CLI");
  console.log("");
  console.log("Usage:");
  console.log("  claude-on-discord <command>");
  console.log("");
  console.log("Commands:");
  console.log("  install  Install/update runtime into ~/.claude-on-discord (or custom path)");
  console.log("  setup    Run interactive setup and write .env (alias: init)");
  console.log("  init     Alias for setup");
  console.log("  start    Start self-healing guardian + control API (recommended)");
  console.log("  guardian Alias for start");
  console.log("  worker   Start the Discord bridge directly (no supervisor)");
  console.log("  dev      Start in watch mode");
  console.log("  help     Show this help");
  console.log("");
  console.log("Notes:");
  console.log("  - Outside a repo checkout, commands auto-install to ~/.claude-on-discord");
  console.log("  - Override install location with CLAUDE_ON_DISCORD_HOME");
}

function resolveBunArgs(command) {
  switch (command) {
    case "init":
    case "setup":
      return ["run", "src/init.ts"];
    case "start":
    case "guardian":
      return ["run", "src/guardian.ts"];
    case "worker":
      return ["run", "src/index.ts"];
    case "dev":
      return ["--watch", "src/index.ts"];
    default:
      return null;
  }
}

function runCommand(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: "inherit",
      env: process.env,
      ...options,
    });

    child.on("error", (error) => reject(error));
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

function readPackageName(packageJsonPath) {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return typeof parsed.name === "string" ? parsed.name : "";
  } catch {
    return "";
  }
}

function isRuntimeRoot(dir) {
  const packageJsonPath = path.join(dir, "package.json");
  const entryPath = path.join(dir, "src", "index.ts");
  if (!existsSync(packageJsonPath) || !existsSync(entryPath)) {
    return false;
  }
  return readPackageName(packageJsonPath) === "claude-on-discord";
}

const scriptPath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(scriptPath), "..");
const homeDir = os.homedir() || process.cwd();
const configuredRuntimeHome = process.env.CLAUDE_ON_DISCORD_HOME?.trim();
const defaultRuntimeHome = path.join(homeDir, ".claude-on-discord");
const runtimeHome = path.resolve(configuredRuntimeHome || defaultRuntimeHome);
const installerScriptPath = path.join(packageRoot, "scripts", "install.sh");

function resolveRuntimeRoot() {
  const cwd = process.cwd();
  if (isRuntimeRoot(cwd)) {
    return cwd;
  }
  if (isRuntimeRoot(runtimeHome)) {
    return runtimeHome;
  }
  return null;
}

async function ensureRuntimeInstalled() {
  if (!existsSync(installerScriptPath)) {
    console.error("installer script missing. Reinstall claude-on-discord and retry.");
    process.exit(1);
  }

  console.log(`No runtime found. Installing to ${runtimeHome} ...`);
  const exitCode = await runCommand("bash", [installerScriptPath, runtimeHome], {
    cwd: process.cwd(),
  });
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

const [, , rawCommand, ...rest] = process.argv;
const command = rawCommand ?? "start";
if (command === "help" || command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
}

if (command === "install") {
  const explicitTarget = rest[0] ? path.resolve(rest[0]) : runtimeHome;
  if (!existsSync(installerScriptPath)) {
    console.error("installer script missing. Reinstall claude-on-discord and retry.");
    process.exit(1);
  }

  runCommand("bash", [installerScriptPath, explicitTarget], { cwd: process.cwd() })
    .then((exitCode) => process.exit(exitCode))
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`failed to run installer: ${message}`);
      process.exit(1);
    });
} else {
  const bunArgs = resolveBunArgs(command);
  if (!bunArgs) {
    console.error(`Unknown command: ${command}`);
    console.error("");
    printHelp();
    process.exit(1);
  }

  (async () => {
    let runtimeRoot = resolveRuntimeRoot();
    if (!runtimeRoot) {
      await ensureRuntimeInstalled();
      runtimeRoot = resolveRuntimeRoot();
    }
    if (!runtimeRoot) {
      console.error("runtime installation is incomplete. Run `claude-on-discord install` and retry.");
      process.exit(1);
    }

    try {
      const exitCode = await runCommand("bun", [...bunArgs, ...rest], {
        cwd: runtimeRoot,
      });
      process.exit(exitCode);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        console.error("bun executable not found. Install Bun from https://bun.sh and retry.");
        process.exit(1);
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`failed to launch bun: ${message}`);
      process.exit(1);
    }
  })();
}
