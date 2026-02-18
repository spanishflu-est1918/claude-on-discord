#!/usr/bin/env node

import { spawn } from "node:child_process";
import process from "node:process";

function printHelp() {
  console.log("claude-on-discord CLI");
  console.log("");
  console.log("Usage:");
  console.log("  claude-on-discord <command>");
  console.log("");
  console.log("Commands:");
  console.log("  init     Run interactive setup and write .env");
  console.log("  start    Start the Discord bridge");
  console.log("  dev      Start in watch mode");
  console.log("  help     Show this help");
}

function resolveBunArgs(command) {
  switch (command) {
    case "init":
      return ["run", "src/init.ts"];
    case "start":
      return ["run", "src/index.ts"];
    case "dev":
      return ["--watch", "src/index.ts"];
    default:
      return null;
  }
}

const [, , rawCommand, ...rest] = process.argv;
const command = rawCommand ?? "start";
if (command === "help" || command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
}

const bunArgs = resolveBunArgs(command);
if (!bunArgs) {
  console.error(`Unknown command: ${command}`);
  console.error("");
  printHelp();
  process.exit(1);
}

const child = spawn("bun", [...bunArgs, ...rest], {
  stdio: "inherit",
  env: process.env,
});

child.on("error", (error) => {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    console.error("bun executable not found. Install Bun from https://bun.sh and retry.");
    process.exit(1);
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(`failed to launch bun: ${message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
