import path from "path";
import { ensureDir } from "../utils/filesystem";

export function storagePaths(globalStorage: string): {
  root: string;
  state: string;
  cache: string;
  backups: string;
  bridge: string;
} {
  return {
    root: globalStorage,
    state: path.join(globalStorage, "state.json"),
    cache: path.join(globalStorage, "cache"),
    backups: path.join(globalStorage, "backups"),
    bridge: path.join(globalStorage, "bridge.json"),
  };
}

export async function ensureStorage(globalStorage: string): Promise<ReturnType<typeof storagePaths>> {
  const paths = storagePaths(globalStorage);
  await ensureDir(paths.root);
  await ensureDir(paths.cache);
  await ensureDir(paths.backups);
  return paths;
}
