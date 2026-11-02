import { createHash } from "crypto";
import { lstat, mkdir, readdir, readFile, readlink, realpath, rm, writeFile } from "fs/promises";
import path from "path";
import { HubError } from "./errors";
import { isExcludedSkillPath, isUnsafeRelativePath } from "./security";

export const MAX_FILE_BYTES = 100_000_000;
export const MAX_TREE_BYTES = 1_000_000_000;
export const MAX_TREE_FILES = 100_000;

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    const text = await readFile(file, "utf8");
    return JSON.parse(text) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await rm(file, { force: true });
  const { rename } = await import("fs/promises");
  await rename(temporary, file);
}

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function assertRealInside(root: string, candidate: string): Promise<void> {
  const resolvedRoot = await existingReal(root);
  const resolvedCandidate = path.resolve(candidate);
  if (!isInside(resolvedRoot, resolvedCandidate)) {
    throw new HubError("path-traversal", "A component tried to write outside its install directory.");
  }
}

async function existingReal(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return path.resolve(target);
  }
}

export async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walk(root, files);
  return files.sort();
}

async function walk(dir: string, files: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new HubError("symlink-rejected", `Symlink "${entry.name}" is not allowed in a component.`);
    }
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      await walk(full, files);
      continue;
    }
    if (entry.isFile()) {
      files.push(full);
    }
  }
}

export async function checksumDirectory(root: string): Promise<string> {
  const files = await listFiles(root);
  const hash = createHash("sha256");
  for (const file of files) {
    const relative = path.relative(root, file).replace(/\\/g, "/");
    if (isExcludedSkillPath(relative) || isUnsafeRelativePath(relative)) {
      continue;
    }
    const content = await readFile(file);
    hash.update(relative);
    hash.update("\0");
    hash.update(createHash("sha256").update(content).digest("hex"));
    hash.update("\n");
  }
  return hash.digest("hex");
}

export async function copyTree(source: string, destination: string): Promise<void> {
  const sourceRoot = await existingReal(source);
  await ensureDir(destination);
  const destinationRoot = path.resolve(destination);
  let total = 0;
  let count = 0;
  await copyInner(sourceRoot, sourceRoot, destinationRoot, {
    add(size: number) {
      total += size;
      count += 1;
      if (count > MAX_TREE_FILES) {
        throw new HubError("component-too-large", `The component has ${count} files, above the install limit of ${MAX_TREE_FILES}.`);
      }
      if (total > MAX_TREE_BYTES) {
        throw new HubError("component-too-large", `The component is ${megabytes(total)} MB, above the install limit of ${megabytes(MAX_TREE_BYTES)} MB.`);
      }
    },
  });
}

async function copyInner(
  sourceRoot: string,
  current: string,
  destinationRoot: string,
  budget: { add(size: number): void },
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(current, entry.name);
    const relative = path.relative(sourceRoot, from);
    if (isUnsafeRelativePath(relative) || isExcludedSkillPath(relative)) {
      if (entry.isDirectory() && (entry.name === ".git" || entry.name === "node_modules")) {
        continue;
      }
      if (isExcludedSkillPath(relative)) {
        continue;
      }
      throw new HubError("path-traversal", `Blocked unsafe path "${relative}".`);
    }
    const target = path.join(destinationRoot, relative);
    if (!isInside(destinationRoot, target)) {
      throw new HubError("path-traversal", `Blocked unsafe path "${relative}".`);
    }
    const stat = await lstat(from);
    if (stat.isSymbolicLink()) {
      const link = await readlink(from);
      throw new HubError("symlink-rejected", `Symlink "${relative}" points to "${link}" and was rejected.`);
    }
    if (stat.isDirectory()) {
      await ensureDir(target);
      await copyInner(sourceRoot, from, destinationRoot, budget);
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) {
      throw new HubError("component-too-large", `File "${relative}" is ${megabytes(stat.size)} MB, above the file limit of ${megabytes(MAX_FILE_BYTES)} MB.`);
    }
    budget.add(stat.size);
    await ensureDir(path.dirname(target));
    const { copyFile } = await import("fs/promises");
    await copyFile(from, target);
  }
}

export async function removeTree(target: string, allowedRoot: string): Promise<void> {
  const resolved = path.resolve(target);
  if (!isInside(allowedRoot, resolved) || path.resolve(allowedRoot) === resolved) {
    throw new HubError("path-traversal", "Refusing to delete a directory outside the install root.");
  }
  await rm(resolved, { recursive: true, force: true });
}

export async function moveAside(target: string, aside: string): Promise<void> {
  await ensureDir(path.dirname(aside));
  const { rename } = await import("fs/promises");
  await rename(target, aside);
}

function megabytes(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / 1_000_000));
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}
