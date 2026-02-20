import { runCostAction } from "./cost-action";
import { runMentionsAction } from "./mentions-action";
import { runPermissionModeAction } from "./permission-mode-action";
import { runSystemPromptAction } from "./systemprompt-action";
import { runForkAction } from "./fork-action";

export const slashActionCatalog = {
  cost: runCostAction,
  mentions: runMentionsAction,
  mode: runPermissionModeAction,
  systemprompt: runSystemPromptAction,
  fork: runForkAction,
} as const;

export type SlashActionCatalog = typeof slashActionCatalog;
