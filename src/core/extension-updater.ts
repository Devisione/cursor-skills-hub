import { mkdir, rename, rm, writeFile } from "fs/promises";
import https from "https";
import path from "path";
import { compareVersions } from "./version-manager";
import { HubError } from "../utils/errors";

const OWNER = "Devisione";
const REPO = "cursor-skills-hub";
const ASSET_NAME = "cursor-skills-hub.vsix";
const RELEASE_API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const MAX_VSIX_BYTES = 40 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const DOWNLOAD_HOSTS = new Set([
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

export interface ExtensionRelease {
  version: string;
  vsixUrl: string;
}

export interface ReleaseResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface DownloadResponse {
  status: number;
  headers: { get(name: string): string | undefined };
  body: AsyncIterable<Uint8Array | Buffer | string>;
}

export type DownloadTransport = (url: string) => Promise<DownloadResponse>;

interface GitHubAsset {
  name?: string;
  browser_download_url?: string;
}

interface GitHubRelease {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GitHubAsset[];
}

export function extensionUpdateAvailable(current: string, latest: string): boolean {
  return compareVersions(latest, current) > 0;
}

export function isExtensionAssetUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.hostname !== "github.com") {
      return false;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length === 6
      && parts[0] === OWNER
      && parts[1] === REPO
      && parts[2] === "releases"
      && parts[3] === "download"
      && isReleaseTag(parts[4] ?? "")
      && parts[5] === ASSET_NAME;
  } catch {
    return false;
  }
}

export async function fetchLatestExtensionRelease(
  fetchImpl: (url: string, init?: { headers?: Record<string, string>; cache?: "no-store" }) => Promise<ReleaseResponse> = globalThis.fetch,
): Promise<ExtensionRelease> {
  const response = await fetchImpl(RELEASE_API, {
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "cursor-skills-hub",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new HubError("github-error", `GitHub release check failed (${response.status}).`);
  }
  return parseLatestRelease(await response.json());
}

export function parseLatestRelease(body: unknown): ExtensionRelease {
  if (!body || typeof body !== "object") {
    throw new HubError("github-error", "GitHub returned an unreadable release.");
  }
  const release = body as GitHubRelease;
  if (release.draft || release.prerelease) {
    throw new HubError("github-error", "The latest GitHub release is not a final version.");
  }
  const version = releaseVersion(release.tag_name);
  if (!version) {
    throw new HubError("github-error", "The latest GitHub release has no version.");
  }
  const asset = (release.assets ?? []).find((item) => item.name === ASSET_NAME);
  if (!asset?.browser_download_url || !isExtensionAssetUrl(asset.browser_download_url)) {
    throw new HubError("github-error", "The latest GitHub release has no extension package.");
  }
  return { version, vsixUrl: asset.browser_download_url };
}

export async function downloadExtensionVsix(
  url: string,
  destination: string,
  transport: DownloadTransport = httpsDownloadTransport,
): Promise<void> {
  let current = url;
  for (let hop = 0; hop < 5; hop += 1) {
    if (!(hop === 0 ? isExtensionAssetUrl(current) : isAllowedDownloadUrl(current))) {
      throw new HubError("download-failed", "Refused to download the extension from an unexpected address.");
    }
    let response: DownloadResponse;
    try {
      response = await transport(current);
    } catch (error) {
      throw safeDownloadError(error);
    }
    try {
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new HubError("download-failed", "GitHub redirected the extension download without a destination.");
        }
        current = new URL(location, current).toString();
        continue;
      }
      if (response.status !== 200) {
        throw new HubError("download-failed", `GitHub returned ${response.status} for the extension package.`);
      }
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > MAX_VSIX_BYTES) {
        throw new HubError("download-failed", "The extension package is larger than expected.");
      }
      await writePackage(destination, await readPackage(response.body));
      return;
    } finally {
      stop(response.body);
    }
  }
  throw new HubError("download-failed", "The extension download was redirected too many times.");
}

function httpsDownloadTransport(url: string): Promise<DownloadResponse> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        "User-Agent": "cursor-skills-hub",
        Accept: "application/octet-stream",
      },
    }, (response) => {
      resolve({
        status: response.statusCode ?? 0,
        headers: {
          get(name: string) {
            const value = response.headers[name.toLowerCase()];
            return Array.isArray(value) ? value[0] : value;
          },
        },
        body: response,
      });
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new HubError("download-failed", "The extension download timed out."));
    });
    request.on("error", (error) => reject(safeDownloadError(error)));
  });
}

function isAllowedDownloadUrl(raw: string): boolean {
  if (isExtensionAssetUrl(raw)) {
    return true;
  }
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password && DOWNLOAD_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function isReleaseTag(tag: string): boolean {
  try {
    return /^v?\d+\.\d+\.\d+$/.test(decodeURIComponent(tag));
  } catch {
    return false;
  }
}

function releaseVersion(tag?: string): string | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec((tag ?? "").trim());
  if (!match) {
    return undefined;
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

async function readPackage(body: AsyncIterable<Uint8Array | Buffer | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_VSIX_BYTES) {
      throw new HubError("download-failed", "The extension package is larger than expected.");
    }
    chunks.push(buffer);
  }
  if (size < 4) {
    throw new HubError("download-failed", "The downloaded file is not an extension package.");
  }
  const bytes = Buffer.concat(chunks, size);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    throw new HubError("download-failed", "The downloaded file is not an extension package.");
  }
  return bytes;
}

async function writePackage(destination: string, bytes: Buffer): Promise<void> {
  const temporary = `${destination}.partial`;
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await writeFile(temporary, bytes);
    await rm(destination, { force: true });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function stop(body: AsyncIterable<unknown>): void {
  const stream = body as { destroy?: () => void; resume?: () => void };
  if (stream.destroy) {
    stream.destroy();
    return;
  }
  stream.resume?.();
}

function safeDownloadError(error: unknown): HubError {
  if (error instanceof HubError) {
    return error;
  }
  const message = error instanceof Error ? error.message : "";
  if (message && !/https?:\/\//i.test(message) && message.length < 180) {
    return new HubError("download-failed", `The extension package could not be downloaded. ${message}`);
  }
  return new HubError("download-failed", "The extension package could not be downloaded.");
}
