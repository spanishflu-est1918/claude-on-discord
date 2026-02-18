import { loadConfig } from "./config";

function main() {
  const config = loadConfig();
  console.log(
    `claude-on-discord bootstrapped (model=${config.defaultModel}, cwd=${config.defaultWorkingDir})`,
  );
}

main();
