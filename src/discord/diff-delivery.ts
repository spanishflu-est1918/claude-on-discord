import { AttachmentBuilder } from "discord.js";

export type DiffDelivery = {
  content: string;
  files?: AttachmentBuilder[];
};

export function buildDiffDelivery(text: string, filePrefix: string): DiffDelivery {
  if (!text.trim()) {
    return { content: "(no diff output)" };
  }

  const safePrefix = filePrefix.replace(/[^a-zA-Z0-9._-]/g, "-").toLowerCase() || "diff";
  const filename = `${safePrefix}-${Date.now().toString(36)}.diff`;
  const attachment = new AttachmentBuilder(Buffer.from(text, "utf8"), { name: filename });
  return { content: `Full output attached as \`${filename}\`.`, files: [attachment] };
}
