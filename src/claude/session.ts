import type { Repository } from "../db/repository";
import type { ChannelBranch, ChannelBranchState, ChannelRecord } from "../types";
import { RingBuffer } from "./ring-buffer";

export interface SessionTurn {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface SessionManagerOptions {
  defaultWorkingDir: string;
  defaultModel: string;
  maxHistoryItems?: number;
}

export interface ChannelSessionState {
  channel: ChannelRecord;
  history: SessionTurn[];
  branch: ChannelBranch;
  branches: ChannelBranch[];
}

const ROOT_BRANCH_ID = "main";
const ROOT_BRANCH_NAME = "main";

function createRootBranch(now = Date.now()): ChannelBranch {
  return {
    id: ROOT_BRANCH_ID,
    name: ROOT_BRANCH_NAME,
    parentBranchId: null,
    createdAt: now,
  };
}

function defaultBranchState(now = Date.now()): ChannelBranchState {
  const root = createRootBranch(now);
  return {
    activeBranchId: root.id,
    branches: [root],
  };
}

function isBranch(value: unknown): value is ChannelBranch {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ChannelBranch>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    (typeof candidate.parentBranchId === "string" || candidate.parentBranchId === null) &&
    typeof candidate.createdAt === "number" &&
    Number.isFinite(candidate.createdAt)
  );
}

function parsePersistedBranchState(raw: string | null): ChannelBranchState | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ChannelBranchState>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (typeof parsed.activeBranchId !== "string" || !Array.isArray(parsed.branches)) {
      return null;
    }

    const branches = parsed.branches.filter(isBranch);
    if (branches.length === 0) {
      return null;
    }
    return {
      activeBranchId: parsed.activeBranchId,
      branches,
    };
  } catch {
    return null;
  }
}

function cloneBranch(branch: ChannelBranch): ChannelBranch {
  return {
    id: branch.id,
    name: branch.name,
    parentBranchId: branch.parentBranchId,
    createdAt: branch.createdAt,
  };
}

export class SessionManager {
  private readonly historyByBranch = new Map<string, RingBuffer<SessionTurn>>();
  private readonly branchStateByChannel = new Map<string, ChannelBranchState>();
  private readonly maxHistoryItems: number;

  constructor(
    private readonly repository: Repository,
    private readonly options: SessionManagerOptions,
  ) {
    this.maxHistoryItems = options.maxHistoryItems ?? 40;
  }

  ensureChannel(channelId: string, guildId: string): ChannelRecord {
    const existing = this.repository.getChannel(channelId);
    if (existing) {
      this.getOrInitBranchState(channelId);
      return existing;
    }
    const created = this.repository.upsertChannel({
      channelId,
      guildId,
      workingDir: this.options.defaultWorkingDir,
      model: this.options.defaultModel,
      sessionId: null,
    });
    this.getOrInitBranchState(channelId);
    return created;
  }

  getState(channelId: string, guildId: string): ChannelSessionState {
    const channel = this.ensureChannel(channelId, guildId);
    const branchState = this.getOrInitBranchState(channelId);
    const activeBranch = this.getActiveBranchFromState(branchState);
    return {
      channel,
      history: this.getHistoryBuffer(channelId, activeBranch.id).toArray(),
      branch: cloneBranch(activeBranch),
      branches: branchState.branches.map(cloneBranch),
    };
  }

  setSessionId(channelId: string, sessionId: string | null): void {
    this.repository.setChannelSession(channelId, sessionId);
  }

  setModel(channelId: string, model: string): void {
    this.repository.setChannelModel(channelId, model);
  }

  setWorkingDir(channelId: string, workingDir: string): void {
    this.repository.setChannelWorkingDir(channelId, workingDir);
  }

  appendTurn(channelId: string, turn: Omit<SessionTurn, "timestamp">): SessionTurn {
    const value: SessionTurn = {
      ...turn,
      timestamp: Date.now(),
    };
    this.getHistoryBuffer(channelId).push(value);
    return value;
  }

  getHistory(channelId: string): SessionTurn[] {
    return this.getHistoryBuffer(channelId).toArray();
  }

  switchProject(
    channelId: string,
    guildId: string,
    workingDir: string,
    opts: { fresh?: boolean } = {},
  ): ChannelSessionState {
    const existing = this.ensureChannel(channelId, guildId);
    const projectChanged = existing.workingDir !== workingDir;

    this.repository.setChannelWorkingDir(channelId, workingDir);
    if (opts.fresh) {
      this.repository.setChannelSession(channelId, null);
      this.resetBranchState(channelId);
      this.clearBranchHistories(channelId);
    } else if (projectChanged) {
      // Session IDs are project-scoped in practice; avoid stale resume errors after switching dirs.
      this.repository.setChannelSession(channelId, null);
    }
    return this.getState(channelId, guildId);
  }

  resetSession(channelId: string): void {
    this.repository.setChannelSession(channelId, null);
    this.getHistoryBuffer(channelId).clear();
  }

  getBranches(channelId: string, guildId: string): ChannelBranch[] {
    this.ensureChannel(channelId, guildId);
    const state = this.getOrInitBranchState(channelId);
    return state.branches.map(cloneBranch);
  }

  getActiveBranch(channelId: string, guildId: string): ChannelBranch {
    this.ensureChannel(channelId, guildId);
    return cloneBranch(this.getActiveBranchFromState(this.getOrInitBranchState(channelId)));
  }

  forkBranch(channelId: string, guildId: string, requestedName?: string): ChannelBranch {
    this.ensureChannel(channelId, guildId);
    const state = this.getOrInitBranchState(channelId);
    const parentBranch = this.getActiveBranchFromState(state);
    const sourceHistory = this.getHistoryBuffer(channelId, parentBranch.id).toArray();
    const branchName = this.makeUniqueBranchName(
      state,
      requestedName ?? `${parentBranch.name}-fork`,
    );
    const createdBranch: ChannelBranch = {
      id: this.createBranchId(),
      name: branchName,
      parentBranchId: parentBranch.id,
      createdAt: Date.now(),
    };
    state.branches.push(createdBranch);
    state.activeBranchId = createdBranch.id;
    this.persistBranchState(channelId, state);

    const targetHistory = this.getHistoryBuffer(channelId, createdBranch.id);
    targetHistory.clear();
    for (const turn of sourceHistory) {
      targetHistory.push({ ...turn });
    }

    this.repository.setChannelSession(channelId, null);
    return cloneBranch(createdBranch);
  }

  switchBranch(channelId: string, guildId: string, branchRef: string): ChannelBranch | null {
    this.ensureChannel(channelId, guildId);
    const state = this.getOrInitBranchState(channelId);
    const trimmedRef = branchRef.trim();
    if (!trimmedRef) {
      return null;
    }
    const resolved = this.findBranch(state, trimmedRef);
    if (!resolved) {
      return null;
    }

    if (state.activeBranchId !== resolved.id) {
      state.activeBranchId = resolved.id;
      this.persistBranchState(channelId, state);
      this.repository.setChannelSession(channelId, null);
    }

    return cloneBranch(resolved);
  }

  private getHistoryBuffer(channelId: string, branchId?: string): RingBuffer<SessionTurn> {
    const selectedBranchId = branchId ?? this.getOrInitBranchState(channelId).activeBranchId;
    const key = this.toBranchHistoryKey(channelId, selectedBranchId);
    const existing = this.historyByBranch.get(key);
    if (existing) {
      return existing;
    }
    const created = new RingBuffer<SessionTurn>(this.maxHistoryItems);
    this.historyByBranch.set(key, created);
    return created;
  }

  private toBranchHistoryKey(channelId: string, branchId: string): string {
    return `${channelId}::${branchId}`;
  }

  private getOrInitBranchState(channelId: string): ChannelBranchState {
    const existing = this.branchStateByChannel.get(channelId);
    if (existing) {
      return existing;
    }

    const loaded = parsePersistedBranchState(this.repository.getChannelBranchState(channelId));
    const normalized = this.normalizeBranchState(loaded);
    this.branchStateByChannel.set(channelId, normalized.state);
    if (normalized.changed) {
      this.persistBranchState(channelId, normalized.state);
    }
    return normalized.state;
  }

  private normalizeBranchState(input: ChannelBranchState | null): {
    state: ChannelBranchState;
    changed: boolean;
  } {
    if (!input) {
      return { state: defaultBranchState(), changed: true };
    }

    const unique = new Map<string, ChannelBranch>();
    for (const branch of input.branches) {
      if (!unique.has(branch.id)) {
        unique.set(branch.id, cloneBranch(branch));
      }
    }

    let changed = unique.size !== input.branches.length;
    if (!unique.has(ROOT_BRANCH_ID)) {
      unique.set(ROOT_BRANCH_ID, createRootBranch());
      changed = true;
    }

    const branches = Array.from(unique.values()).sort((a, b) => a.createdAt - b.createdAt);
    const activeBranchId = unique.has(input.activeBranchId) ? input.activeBranchId : ROOT_BRANCH_ID;
    if (activeBranchId !== input.activeBranchId) {
      changed = true;
    }

    return {
      state: {
        activeBranchId,
        branches,
      },
      changed,
    };
  }

  private persistBranchState(channelId: string, state: ChannelBranchState): void {
    this.repository.setChannelBranchState(channelId, JSON.stringify(state));
  }

  private getActiveBranchFromState(state: ChannelBranchState): ChannelBranch {
    const branch = state.branches.find((entry) => entry.id === state.activeBranchId);
    if (branch) {
      return branch;
    }
    return state.branches[0] ?? createRootBranch();
  }

  private findBranch(state: ChannelBranchState, branchRef: string): ChannelBranch | null {
    const byId = state.branches.find((branch) => branch.id === branchRef);
    if (byId) {
      return byId;
    }
    const needle = branchRef.toLowerCase();
    return state.branches.find((branch) => branch.name.toLowerCase() === needle) ?? null;
  }

  private createBranchId(): string {
    return `branch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private makeUniqueBranchName(state: ChannelBranchState, requestedName: string): string {
    const baseInput = requestedName.trim() || "branch";
    const base = baseInput.replace(/\s+/g, "-").slice(0, 48);
    const existing = new Set(state.branches.map((branch) => branch.name.toLowerCase()));
    if (!existing.has(base.toLowerCase())) {
      return base;
    }

    let index = 2;
    while (true) {
      const candidate = `${base}-${index}`;
      if (!existing.has(candidate.toLowerCase())) {
        return candidate;
      }
      index += 1;
    }
  }

  private clearBranchHistories(channelId: string): void {
    const prefix = `${channelId}::`;
    for (const key of this.historyByBranch.keys()) {
      if (key.startsWith(prefix)) {
        this.historyByBranch.delete(key);
      }
    }
  }

  private resetBranchState(channelId: string): void {
    const reset = defaultBranchState();
    this.branchStateByChannel.set(channelId, reset);
    this.persistBranchState(channelId, reset);
  }
}
