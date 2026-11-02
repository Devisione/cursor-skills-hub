import path from "path";
import { CatalogComponent } from "../core/types";
import { ensureDir, readJson, writeJsonAtomic } from "../utils/filesystem";

export class CacheManager {
  constructor(private readonly root: string) {}

  directory(): string {
    return this.root;
  }

  repoDirectory(id: string): string {
    return path.join(this.root, "repos", id);
  }

  async loadCatalog(): Promise<CatalogComponent[]> {
    return (await readJson<CatalogComponent[]>(this.catalogFile())) ?? [];
  }

  async saveCatalog(components: CatalogComponent[]): Promise<void> {
    await ensureDir(this.root);
    await writeJsonAtomic(this.catalogFile(), components);
  }

  async replaceMarketplace(marketplaceId: string, components: CatalogComponent[]): Promise<CatalogComponent[]> {
    const current = await this.loadCatalog();
    const next = current.filter((item) => item.marketplaceId !== marketplaceId).concat(components);
    await this.saveCatalog(next);
    return next;
  }

  async removeMarketplace(marketplaceId: string): Promise<CatalogComponent[]> {
    const next = (await this.loadCatalog()).filter((item) => item.marketplaceId !== marketplaceId);
    await this.saveCatalog(next);
    return next;
  }

  private catalogFile(): string {
    return path.join(this.root, "catalog.json");
  }
}
