export async function runBashAction(input: {
  command: string;
  workingDir: string;
  runBashCommand: (command: string, cwd: string) => Promise<{ exitCode: number; output: string }>;
}): Promise<{
  command: string;
  workingDir: string;
  exitCode: number;
  output: string;
  payload: string;
}> {
  const result = await input.runBashCommand(input.command, input.workingDir);
  const outputText = result.output || "(no output)";
  const payload = `\`\`\`bash\n$ ${input.command}\n${outputText}\n[exit ${result.exitCode}]\n\`\`\``;
  return {
    command: input.command,
    workingDir: input.workingDir,
    exitCode: result.exitCode,
    output: result.output,
    payload,
  };
}
