export type McpToolDefinition<Input, Output> = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Input) => Promise<Output> | Output;
};
