export async function runCommand(
  cmd: string[],
  cwd: string,
): Promise<{ exitCode: number; output: string }> {
  const process = Bun.spawn({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  return {
    exitCode,
    output,
  };
}

export async function runBashCommand(
  command: string,
  cwd: string,
): Promise<{ exitCode: number; output: string }> {
  const process = Bun.spawn({
    cmd: ["/bin/zsh", "-lc", command],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  return {
    exitCode,
    output,
  };
}
