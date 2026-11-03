import { randomUUID } from "crypto";
import path from "path";
import { HubError, errorMessage } from "../utils/errors";
import { pathExists, readJson, writeJsonAtomic } from "../utils/filesystem";
import { Logger } from "../utils/logger";
import { DEFAULT_SETTINGS, HubState, SCHEMA_VERSION, SettingsState } from "./types";

export class StateManager {
  private state: HubState;
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly file: string,
    private readonly logger: Logger,
    state: HubState,
  ) {
    this.state = state;
  }

  static async open(file: string, logger: Logger): Promise<StateManager> {
    try {
      const loaded = await readJson<HubState>(file);
      if (!loaded) {
        return new StateManager(file, logger, freshState());
      }
      if (loaded.schemaVersion !== SCHEMA_VERSION) {
        await writeJsonAtomic(`${file}.unsupported`, loaded);
        logger.error("state", `Configuration schema ${String(loaded.schemaVersion)} is not supported. A copy was saved next to the state file.`);
        return new StateManager(file, logger, freshState());
      }
      return new StateManager(file, logger, normalize(loaded));
    } catch (error) {
      logger.error("state", `The local configuration could not be read and will be recreated. ${errorMessage(error)}`);
      return new StateManager(file, logger, freshState());
    }
  }

  snapshot(): HubState {
    return structuredClone(this.state);
  }

  async update(mutator: (state: HubState) => void): Promise<HubState> {
    const run = this.queue.then(async () => {
      mutator(this.state);
      this.state.settings = { ...DEFAULT_SETTINGS, ...this.state.settings };
      await writeJsonAtomic(this.file, this.state);
    });
    this.queue = run.catch(() => undefined);
    await run;
    return this.snapshot();
  }

  async replace(state: HubState): Promise<void> {
    await this.update((current) => {
      Object.assign(current, state);
    });
  }

  async markDirty(): Promise<void> {
    await this.update((state) => {
      state.sync.dirty = true;
      if (state.sync.status === "synchronized" || state.sync.status === "remote-changes") {
        state.sync.status = state.sync.lastRemoteSha ? "local-changes" : "local-changes";
      }
    });
  }

  filePath(): string {
    return this.file;
  }

  async quarantineCorrupt(error: unknown): Promise<void> {
    if (await pathExists(this.file)) {
      const target = path.join(path.dirname(this.file), `state.broken-${Date.now()}.json`);
      const { copyFile } = await import("fs/promises");
      await copyFile(this.file, target);
      this.logger.error("state", `The local configuration could not be read and was copied to ${path.basename(target)}. ${errorMessage(error)}`);
    }
    this.state = freshState();
    await writeJsonAtomic(this.file, this.state);
  }
}

export function freshState(): HubState {
  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId: randomUUID(),
    marketplaces: [],
    installed: [],
    settings: { ...DEFAULT_SETTINGS },
    sync: { dirty: false, status: "disconnected" },
  };
}

function normalize(state: HubState): HubState {
  if (!state.deviceId || !Array.isArray(state.marketplaces) || !Array.isArray(state.installed)) {
    throw new HubError("corrupt-state", "The local configuration is missing required fields.");
  }
  return {
    ...state,
    settings: { ...DEFAULT_SETTINGS, ...state.settings } as SettingsState,
    sync: {
      dirty: !!state.sync?.dirty,
      status: state.sync?.status ?? "disconnected",
      lastRemoteSha: state.sync?.lastRemoteSha,
      lastSyncedAt: state.sync?.lastSyncedAt,
      lastAttemptedSha: state.sync?.lastAttemptedSha,
      declinedSha: state.sync?.declinedSha,
      lastError: state.sync?.lastError,
    },
  };
}

export function applySettingsPatch(settings: SettingsState, patch: Partial<SettingsState>): SettingsState {
  return { ...settings, ...patch };
}
