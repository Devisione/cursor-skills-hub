const TOKEN_PATTERNS = [
  /ghp_[A-Za-z0-9_]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /gho_[A-Za-z0-9_]+/g,
  /Bearer\s+[A-Za-z0-9._\-]+/gi,
  /x-access-token:[^@\s]+/gi,
  /authorization:\s*\S+/gi,
];

export function redactSecrets(value: string): string {
  let result = value;
  for (const pattern of TOKEN_PATTERNS) {
    result = result.replace(pattern, "[redacted]");
  }
  return result;
}

export function assertGitHubToken(token: string): void {
  if (!/^[A-Za-z0-9_\.\-]+$/.test(token) || token.length < 8 || token.length > 300) {
    throw new Error("GitHub token has an unexpected format.");
  }
}

const UNSAFE_SEGMENTS = new Set(["", ".", ".."]);

export function isUnsafeRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.length > 400) {
    return true;
  }
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    return true;
  }
  const parts = normalized.split("/");
  return parts.some((part) => UNSAFE_SEGMENTS.has(part) || part.includes("\0") || part.endsWith("."));
}

export function isExcludedSkillPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (parts.some((part) => part === ".git" || part === "node_modules")) {
    return true;
  }
  const base = parts[parts.length - 1] ?? "";
  return base === ".env" || base.startsWith(".env.");
}

const SKILL_NAME = /^[a-z0-9][a-z0-9._-]{0,80}$/;

export function isSafeComponentName(name: string): boolean {
  if (!SKILL_NAME.test(name)) {
    return false;
  }
  if (name === "." || name === ".." || name.includes("..")) {
    return false;
  }
  return !name.startsWith(".") && !name.endsWith(".");
}

export function assertSafeComponentName(name: string): void {
  if (!isSafeComponentName(name)) {
    throw new Error(`Component name "${name}" cannot be used as a directory name.`);
  }
}
