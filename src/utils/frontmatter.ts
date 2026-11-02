export interface Frontmatter {
  name?: string;
  description?: string;
  author?: string;
  categories: string[];
  capabilities: string[];
  dependencies: string[];
  raw: Record<string, string | string[]>;
}

export function parseFrontmatter(markdown: string): Frontmatter {
  const raw: Record<string, string | string[]> = {};
  const text = markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!text.startsWith("---")) {
    return empty(raw);
  }
  const end = text.indexOf("\n---", 3);
  if (end < 0) {
    return empty(raw);
  }
  const block = text.slice(text.indexOf("\n") + 1, end);
  const lines = block.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const matched = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!matched) {
      index += 1;
      continue;
    }
    const key = matched[1] ?? "";
    const rest = (matched[2] ?? "").trim();
    if (rest.startsWith("[") && rest.endsWith("]")) {
      raw[key] = rest
        .slice(1, -1)
        .split(",")
        .map((item) => unquote(item.trim()))
        .filter(Boolean);
      index += 1;
      continue;
    }
    if (rest === "" || rest === ">" || rest === ">-" || rest === "|" || rest === "|-") {
      const list: string[] = [];
      let cursor = index + 1;
      while (cursor < lines.length && /^\s+-\s+/.test(lines[cursor] ?? "")) {
        list.push(unquote((lines[cursor] ?? "").replace(/^\s+-\s+/, "").trim()));
        cursor += 1;
      }
      if (list.length > 0 && rest === "") {
        raw[key] = list;
        index = cursor;
        continue;
      }
      const folded = rest.startsWith(">");
      const collected: string[] = [];
      index += 1;
      while (index < lines.length) {
        const current = lines[index] ?? "";
        if (/^[A-Za-z0-9_-]+:\s*/.test(current)) {
          break;
        }
        if (current.trim() === "" || /^\s+/.test(current)) {
          collected.push(current);
          index += 1;
          continue;
        }
        break;
      }
      raw[key] = folded ? fold(collected) : collected.map((item) => item.replace(/^\s{2}/, "")).join("\n").trim();
      continue;
    }
    raw[key] = unquote(rest);
    index += 1;
  }
  return {
    name: asString(raw.name),
    description: asString(raw.description),
    author: asString(raw.author),
    categories: asList(raw.categories ?? raw.keywords ?? raw.tags),
    capabilities: asList(raw.capabilities),
    dependencies: asList(raw.dependencies),
    raw,
  };
}

function empty(raw: Record<string, string | string[]>): Frontmatter {
  return { categories: [], capabilities: [], dependencies: [], raw };
}

function fold(lines: string[]): string {
  const content = lines.map((line) => line.trim()).filter((line, index, all) => line.length > 0 || all[index - 1] !== "");
  return content.join(" ").replace(/\s+/g, " ").trim();
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function asString(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return undefined;
}

function asList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}
