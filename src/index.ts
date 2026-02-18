import { startApp } from "./app";
import { loadConfig } from "./config";

async function main() {
  const config = loadConfig();
  await startApp(config);
}

main().catch((error) => {
  console.error("fatal startup error", error);
  process.exit(1);
});
