export const THINKING_SPINNER_FRAMES = ["-", "\\", "|", "/"] as const;

export type LiveToolStatus = "queued" | "running" | "done" | "failed" | "interrupted";

export type LiveToolEntry = {
  id: string;
  name: string;
  status: LiveToolStatus;
  inputPreview?: string;
  inputDetails?: string;
  activity?: string;
  summary?: string;
  elapsedSeconds?: number;
  timeline: string[];
  startedAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
};

export type LiveToolTrace = {
  order: string[];
  byId: Map<string, LiveToolEntry>;
  indexToToolId: Map<number, string>;
  inputJsonBufferByToolId: Map<string, string>;
  taskIdToToolId: Map<string, string>;
};

export type LiveToolRenderPayload = {
  flags: number;
  components: [import("discord.js").ContainerBuilder];
};
