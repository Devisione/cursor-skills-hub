export function compareVersions(left?: string, right?: string): number {
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) {
    return 0;
  }
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference > 0 ? 1 : -1;
    }
  }
  return 0;
}

export function shortSha(sha?: string): string {
  if (!sha) {
    return "";
  }
  return sha.slice(0, 7);
}

export function displayVersion(version?: string, commitSha?: string): string {
  if (version && version !== commitSha) {
    return version;
  }
  if (commitSha) {
    return shortSha(commitSha);
  }
  return version || "unknown";
}

export function isPinned(component: { pinned: boolean }): boolean {
  return component.pinned;
}

function parse(version?: string): [number, number, number] | undefined {
  if (!version) {
    return undefined;
  }
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
