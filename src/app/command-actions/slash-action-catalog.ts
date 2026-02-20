import { runCostAction } from "./cost-action";
import { runMentionsAction } from "./mentions-action";
import { runPermissionModeAction } from "./permission-mode-action";
import { runSystemPromptAction } from "./systemprompt-action";
import { runForkAction } from "./fork-action";
import { runNewSessionAction } from "./new-action";
import { runCompactAction } from "./compact-action";
import { runModelAction } from "./model-action";
import { runStopAction } from "./stop-action";
import { runBashAction } from "./bash-action";

export const slashActionCatalog = {
  cost: runCostAction,
  mentions: runMentionsAction,
  mode: runPermissionModeAction,
  systemprompt: runSystemPromptAction,
  fork: runForkAction,
  newSession: runNewSessionAction,
  compact: runCompactAction,
  model: runModelAction,
  stop: runStopAction,
  bash: runBashAction,
} as const;

export type SlashActionCatalog = typeof slashActionCatalog;
