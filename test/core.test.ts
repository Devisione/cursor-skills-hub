import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { test } from "node:test";
import { freshState } from "../src/core/state-manager";
import { planSync } from "../src/core/sync-plan";
import { buildRemoteFiles, parseRemoteFiles } from "../src/github/config-sync";
import { detectMarketplaceKind } from "../src/marketplaces/marketplace-adapter";
import { indexCursorMarketplace } from "../src/marketplaces/cursor-adapter";
import { indexSkillsRepository } from "../src/marketplaces/skills-adapter";
import { copyTree, pathExists, removeTree } from "../src/utils/filesystem";
import { parseFrontmatter } from "../src/utils/frontmatter";
import { marketplaceIdFor, parseGitUrl, repoSlug } from "../src/utils/github-url";
import { isUnsafeRelativePath, redactSecrets } from "../src/utils/security";
import { BackupManager } from "../src/core/backup-manager";
import { agentStoreParent } from "../src/core/paths";
import { materializeRepo } from "../src/utils/git";
import { githubFolderUrl } from "../src/ui/view-model";
import { forgetLockedSkills, readSkillLock } from "../src/skills/skill-discovery";
import { InstalledComponent } from "../src/core/types";
import { downloadExtensionVsix, extensionUpdateAvailable, fetchLatestExtensionRelease, isExtensionAssetUrl, parseLatestRelease } from "../src/core/extension-updater";

test("parses Windows frontmatter without dropping the description", () => {
  const parsed = parseFrontmatter("---\r\nname: adding-analytics\r\ndescription: Add PostHog analytics\r\n---\r\n");
  assert.equal(parsed.name, "adding-analytics");
  assert.equal(parsed.description, "Add PostHog analytics");
});

test("parses skill frontmatter", () => {
  const parsed = parseFrontmatter(`---
name: api-designer
description: >-
  Design APIs
  and review contracts
categories:
  - design
---
# Body
`);
  assert.equal(parsed.name, "api-designer");
  assert.match(parsed.description ?? "", /Design APIs/);
  assert.deepEqual(parsed.categories, ["design"]);
});

test("normalizes marketplace urls and rejects local paths", () => {
  assert.equal(parseGitUrl("git@github.com:acme/skills.git").normalized, "https://github.com/acme/skills");
  assert.equal(parseGitUrl("acme/skills").normalized, "https://github.com/acme/skills");
  assert.throws(() => parseGitUrl("C:\\\\secrets"), /Local paths/);
  assert.throws(() => parseGitUrl("https://user:token@github.com/acme/skills"), /credentials/);
  assert.equal(marketplaceIdFor("https://github.com/acme/skills"), marketplaceIdFor("https://github.com/acme/skills"));
});

test("redacts tokens and blocks traversal", () => {
  assert.equal(redactSecrets("token ghp_abcdefghijklmnopqrstuvwxyz"), "token [redacted]");
  assert.equal(isUnsafeRelativePath("../SKILL.md"), true);
  assert.equal(isUnsafeRelativePath("scripts/run.js"), false);
});

test("detects supported repositories and ignores random ones", () => {
  assert.equal(detectMarketplaceKind(["README.md"]), undefined);
  assert.equal(detectMarketplaceKind(["skills/review/SKILL.md"]), "skills-catalog");
  assert.equal(detectMarketplaceKind([".cursor-plugin/plugin.json", "skills/review/SKILL.md"]), "cursor-plugin");
  assert.equal(detectMarketplaceKind([".cursor-plugin/marketplace.json", "teaching/skills/demo/SKILL.md"]), "cursor-marketplace");
});

test("indexes a cursor marketplace without treating every file as a component", () => {
  const files = new Map<string, string>([
    [".cursor-plugin/marketplace.json", JSON.stringify({
      name: "demo",
      plugins: [{ name: "teaching", source: "teaching", description: "Teach", keywords: ["learn"] }],
    })],
    ["teaching/.cursor-plugin/plugin.json", JSON.stringify({ name: "teaching", version: "1.2.0", description: "Teach", author: { name: "Ada" } })],
    ["teaching/skills/demo/SKILL.md", "---\nname: demo\ndescription: Show a demo\n---\n# Demo\n"],
  ]);
  const indexed = indexCursorMarketplace({
    marketplaceId: "mkt_test",
    repositoryUrl: "https://github.com/acme/plugins",
    commitSha: "a".repeat(40),
    paths: [...files.keys()],
    files,
    checkedAt: "2026-11-02T00:00:00.000Z",
  });
  assert.equal(indexed.name, "demo");
  assert.equal(indexed.components.length, 2);
  const skill = indexed.components.find((item) => item.type === "skill");
  assert.equal(skill?.name, "demo");
  assert.equal(skill?.pathInRepo, "teaching/skills/demo");
});

test("indexes a skills repository from SKILL.md files only", () => {
  const files = new Map<string, string>([
    ["review/SKILL.md", "---\nname: review\ndescription: Review code\n---\n"],
    ["README.md", "nope"],
  ]);
  const components = indexSkillsRepository({
    marketplaceId: "mkt_skills",
    repositoryUrl: "https://github.com/acme/skills",
    commitSha: "b".repeat(40),
    paths: ["review/SKILL.md", "README.md"],
    files,
    checkedAt: "2026-11-02T00:00:00.000Z",
  });
  assert.equal(components.length, 1);
  assert.equal(components[0]?.pathInRepo, "review");
});

test("plans sync without overwriting a populated remote on first contact", () => {
  const remote = parseRemoteFiles({
    config: JSON.stringify({ schemaVersion: 1, deviceId: "a", updatedAt: "2026-11-02T00:00:00.000Z" }),
    marketplaces: JSON.stringify({ schemaVersion: 1, marketplaces: [] }),
    installed: JSON.stringify({ schemaVersion: 1, components: [remoteSkill("skill_1")] }),
    settings: JSON.stringify({ schemaVersion: 1 }),
    lock: JSON.stringify({ schemaVersion: 1, components: {} }),
  });
  const first = planSync({
    repository: "acme/config",
    dirty: true,
    remoteSha: "1",
    remote,
    localManaged: [],
  });
  assert.equal(first.action, "pull");
  const conflict = planSync({
    repository: "acme/config",
    dirty: true,
    remoteSha: "2",
    lastRemoteSha: "1",
    remote,
    localManaged: [localSkill("skill_2")],
  });
  assert.equal(conflict.action, "conflict");
});

test("round-trips the remote configuration", () => {
  const state = freshState();
  state.marketplaces.push({
    id: "mkt_1",
    url: "https://github.com/acme/skills",
    normalizedUrl: "https://github.com/acme/skills",
    type: "skills-catalog",
    autoRefresh: true,
    trusted: false,
    componentCount: 1,
    addedAt: "2026-11-02T00:00:00.000Z",
  });
  state.installed.push(localSkill("skill_1"));
  const hidden = localSkill("skill_private");
  hidden.excludeFromSync = true;
  state.installed.push(hidden);
  const hiddenMarket = {
    id: "mkt_private",
    url: "https://github.com/acme/work",
    normalizedUrl: "https://github.com/acme/work",
    type: "skills-catalog" as const,
    autoRefresh: true,
    trusted: false,
    componentCount: 1,
    addedAt: "2026-11-02T00:00:00.000Z",
    excludeFromSync: true,
  };
  state.marketplaces.push(hiddenMarket);
  const files = buildRemoteFiles(state, "2026-11-02T00:00:00.000Z");
  const parsed = parseRemoteFiles({
    config: files["config.json"],
    marketplaces: files["marketplaces.json"],
    installed: files["installed.json"],
    settings: files["settings.json"],
    lock: files["lock.json"],
  });
  assert.equal(parsed.installed.length, 1);
  assert.equal(parsed.installed[0]?.id, "skill_1");
  assert.equal(parsed.marketplaces.length, 1);
  assert.equal(parsed.marketplaces[0]?.id, "mkt_1");
  assert.equal(parsed.lock.skill_1?.commitSha, "abc123");
});

test("finds the agent store skills directory", () => {
  const skill = "C:/Users/me/AppData/Local/Cursor/AgentStores/cursor_agent_stores/user/files/skills/ui-ux-pro-max";
  assert.equal(
    agentStoreParent(skill)?.replace(/\\/g, "/"),
    "C:/Users/me/AppData/Local/Cursor/AgentStores/cursor_agent_stores/user/files/skills",
  );
});

test("copy keeps component files inside the destination and skips secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skills-hub-test-"));
  const source = path.join(root, "source");
  const destination = path.join(root, "dest");
  await mkdir(path.join(source, "scripts"), { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: demo\ndescription: Demo\n---\n");
  await writeFile(path.join(source, ".env"), "SECRET=1");
  await writeFile(path.join(source, "scripts", "run.js"), "console.log(1)\n");
  await copyTree(source, destination);
  assert.match(await readFile(path.join(destination, "SKILL.md"), "utf8"), /name: demo/);
  assert.equal(await pathExists(path.join(destination, "scripts", "run.js")), true);
  assert.equal(await pathExists(path.join(destination, ".env")), false);
  await assert.rejects(() => removeTree(root, root), /outside the install root/);
});

test("copies a component that used to exceed the 2000-file install cap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skills-hub-test-"));
  const source = path.join(root, "source");
  const destination = path.join(root, "dest");
  await mkdir(source, { recursive: true });
  await Promise.all(Array.from({ length: 2001 }, (_, index) => writeFile(path.join(source, `file-${index}.txt`), "x")));
  await copyTree(source, destination);
  assert.equal(await pathExists(path.join(destination, "file-0.txt")), true);
  assert.equal(await pathExists(path.join(destination, "file-2000.txt")), true);
  await removeTree(source, root);
  await removeTree(destination, root);
});

function remoteSkill(id: string) {
  return {
    id,
    type: "skill",
    name: "demo",
    repositoryUrl: "https://github.com/acme/skills",
    pathInRepo: "demo",
    commitSha: "abc123",
    scope: "user",
    location: "cursor-skills",
    pinned: false,
  };
}

test("uses owner and repository as the package id", () => {
  assert.equal(repoSlug("https://github.com/nextlevelbuilder/ui-ux-pro-max-skill"), "nextlevelbuilder/ui-ux-pro-max-skill");
  assert.equal(repoSlug("https://github.com/nextlevelbuilder/ui-ux-pro-max-skill.git"), "nextlevelbuilder/ui-ux-pro-max-skill");
  assert.equal(repoSlug("https://user:ghp_abcdefghijklmnopqrstuvwxyz@github.com/acme/skills"), "unknown");
  assert.equal(repoSlug("https://user:ghp_abcdefghijklmnopqrstuvwxyz@github.com/acme/skills").includes("ghp_"), false);
});

test("refuses to clone a local path, a credential URL, a bad ref, or a path outside the repo", async () => {
  await assert.rejects(() => materializeRepo({ url: "C:\\\\secrets", ref: "main" }), /Local paths/);
  await assert.rejects(() => materializeRepo({ url: "ext::calc", ref: "HEAD" }), /HTTPS|repository URL/);
  await assert.rejects(() => materializeRepo({ url: "https://user:token@github.com/acme/skills", ref: "main" }), /credentials/);
  await assert.rejects(() => materializeRepo({ url: "https://github.com/acme/skills", ref: "--upload-pack=calc" }), /Git ref/);
  await assert.rejects(() => materializeRepo({ url: "https://github.com/acme/skills", ref: "main", subpath: "../outside" }), /cannot be checked out/);
});

test("restores a backup without deleting it or leaving the install root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skills-hub-backup-"));
  const source = path.join(root, "source");
  const skills = path.join(root, "skills");
  const destination = path.join(skills, "demo");
  await mkdir(source, { recursive: true });
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "old\n");
  await writeFile(path.join(destination, "SKILL.md"), "new\n");
  const backups = new BackupManager(path.join(root, "backups"));
  const saved = await backups.keep("skill_1", source);
  await backups.restore(saved, destination, skills);
  assert.match(await readFile(path.join(destination, "SKILL.md"), "utf8"), /old/);
  assert.match(await readFile(path.join(saved, "SKILL.md"), "utf8"), /old/);
  await assert.rejects(() => backups.restore(saved, root, skills), /install root/);
});

test("builds GitHub links for a repository and a skill folder", () => {
  assert.equal(githubFolderUrl("https://github.com/spencerpauly/awesome-cursor-skills.git"), "https://github.com/spencerpauly/awesome-cursor-skills");
  assert.equal(
    githubFolderUrl("https://github.com/spencerpauly/awesome-cursor-skills.git", "resources/adding-analytics/SKILL.md"),
    "https://github.com/spencerpauly/awesome-cursor-skills/tree/main/resources/adding-analytics",
  );
  assert.equal(githubFolderUrl("https://example.com/skills"), "");
});

test("reads a skill lock by repository and forgets removed skills", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skills-hub-lock-"));
  const installPath = path.join(root, "skills", "adding-analytics");
  await mkdir(installPath, { recursive: true });
  const lockFile = path.join(root, ".skill-lock.json");
  await writeFile(lockFile, JSON.stringify({
    version: 3,
    skills: {
      "adding-analytics": { source: "spencerpauly/awesome-cursor-skills", sourceUrl: "https://github.com/spencerpauly/awesome-cursor-skills.git" },
      "find-skills": { source: "vercel-labs/skills" },
    },
  }));
  const map = await readSkillLock(path.join(root, "skills"));
  assert.equal(map.get("adding-analytics")?.source, "spencerpauly/awesome-cursor-skills");
  await forgetLockedSkills([installPath]);
  const after = JSON.parse(await readFile(lockFile, "utf8")) as { skills: Record<string, unknown> };
  assert.equal(after.skills["adding-analytics"], undefined);
  assert.ok(after.skills["find-skills"]);
});

test("reads a Skills Hub release and ignores a package from another place", async () => {
  const asset = "https://github.com/Devisione/cursor-skills-hub/releases/download/v0.1.20/cursor-skills-hub.vsix";
  const release = parseLatestRelease({
    tag_name: "v0.1.20",
    assets: [{ name: "cursor-skills-hub.vsix", browser_download_url: asset }],
  });
  assert.equal(release.version, "0.1.20");
  assert.equal(release.vsixUrl, asset);
  assert.equal(extensionUpdateAvailable("0.1.19", release.version), true);
  assert.equal(extensionUpdateAvailable("0.1.20", release.version), false);
  assert.equal(extensionUpdateAvailable("0.2.0", release.version), false);
  assert.equal(isExtensionAssetUrl("https://github.com/Devisione/cursor-skills-hub/releases/latest/download/cursor-skills-hub.vsix"), false);
  assert.equal(isExtensionAssetUrl("https://user:token@github.com/Devisione/cursor-skills-hub/releases/download/v0.1.20/cursor-skills-hub.vsix"), false);
  assert.throws(() => parseLatestRelease({
    tag_name: "v0.1.20",
    assets: [{ name: "cursor-skills-hub.vsix", browser_download_url: "https://evil.example/cursor-skills-hub.vsix" }],
  }), /no extension package/);
  const fetched = await fetchLatestExtensionRelease(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ tag_name: "v0.2.0", assets: [{ name: "cursor-skills-hub.vsix", browser_download_url: "https://github.com/Devisione/cursor-skills-hub/releases/download/v0.2.0/cursor-skills-hub.vsix" }] }),
  }));
  assert.equal(fetched.version, "0.2.0");
});

test("downloads the extension package through the GitHub release host only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skills-hub-vsix-"));
  const destination = path.join(root, "cursor-skills-hub.vsix");
  const asset = "https://github.com/Devisione/cursor-skills-hub/releases/download/v0.1.20/cursor-skills-hub.vsix";
  const cdn = "https://release-assets.githubusercontent.com/github-production-release-asset/1?name=cursor-skills-hub.vsix";
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
  const seen: string[] = [];
  await downloadExtensionVsix(asset, destination, async (url) => {
    seen.push(url);
    if (url === asset) {
      return {
        status: 302,
        headers: { get: (name) => name.toLowerCase() === "location" ? cdn : undefined },
        body: Readable.from([]),
      };
    }
    return {
      status: 200,
      headers: { get: () => undefined },
      body: Readable.from([zip]),
    };
  });
  assert.deepEqual(seen, [asset, cdn]);
  assert.equal((await readFile(destination))[0], 0x50);
  await assert.rejects(() => downloadExtensionVsix(asset, destination, async () => ({
    status: 302,
    headers: { get: (name) => name.toLowerCase() === "location" ? "https://evil.example/cursor-skills-hub.vsix" : undefined },
    body: Readable.from([]),
  })), /unexpected address/);
  await assert.rejects(() => downloadExtensionVsix("https://evil.example/cursor-skills-hub.vsix", destination, async () => {
    throw new Error("should not fetch");
  }), /unexpected address/);
  await assert.rejects(() => downloadExtensionVsix(asset, destination, async () => ({
    status: 200,
    headers: { get: () => undefined },
    body: Readable.from([Buffer.from("not a package")]),
  })), /not an extension package/);
});

function localSkill(id: string): InstalledComponent {
  return {
    id,
    type: "skill",
    name: "demo",
    description: "Demo",
    repositoryUrl: "https://github.com/acme/skills",
    pathInRepo: "demo",
    version: "1.0.0",
    commitSha: "abc123",
    checksum: "sum",
    scope: "user",
    location: "cursor-skills",
    installPath: path.join(os.homedir(), ".cursor", "skills", "demo"),
    pinned: false,
    status: "up-to-date",
    updateAvailable: false,
    installedAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
    managed: true,
  };
}
