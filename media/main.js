(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  let model;
  let screen = "main";
  let section = "installed";
  let installedQuery = "";
  let discoverQuery = "";
  let installedFilter = "all";
  let showUpdates = false;
  let discoverFilter = "all";
  let openMenu = "";
  let opened = "";
  let packageQuery = "";
  let repos = [];
  let repoListOpen = false;
  let activity = "";
  let error = "";

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "state") {
      model = message.model;
      render();
    } else if (message.type === "repos") {
      repos = message.repos || [];
      repoListOpen = true;
      activity = "";
      render();
    } else if (message.type === "done") {
      activity = "";
      if (model?.github?.repository) repoListOpen = false;
      render();
    } else if (message.type === "error") {
      activity = "";
      error = message.message || "Something went wrong.";
      render();
    }
  });

  function render() {
    if (!model) {
      app.textContent = "Loading…";
      return;
    }
    app.replaceChildren(header());
    if (error) app.append(para(error, "error"));
    if (model.conflict && screen === "main") app.append(conflict(model.conflict.reason));
    app.append(screen === "settings" ? settings() : main());
  }

  function header() {
    const wrap = el("div");
    const top = el("div", { class: "top" });
    top.append(el("h1", {}, ["Skills Hub"]));
    const actions = el("div", { class: "top-actions" });
    actions.append(textButton("Donate", () => post("donate"), "primary"));
    actions.append(textButton(screen === "settings" ? "Back" : "Settings", () => {
      screen = screen === "settings" ? "main" : "settings";
      render();
    }, "secondary"));
    top.append(actions);
    const rows = groupRows(model.installed);
    const packages = rows.filter((row) => row.kind === "package").length;
    const separate = rows.length - packages;
    wrap.append(top, para(`${model.installed.length} skills · ${packages} packages · ${separate} separate · ${model.overview.syncLabel}`, "sub"));
    return wrap;
  }

  function main() {
    const wrap = el("div");
    const segment = el("div", { class: "segment" });
    segment.append(segmentButton("Discover", "discover"), segmentButton("Installed", "installed"));
    wrap.append(segment);
    const pool = section === "discover" ? model.catalog : model.installed;
    const openedRow = opened ? groupRows(pool).find((row) => row.kind === "package" && row.id === opened) : undefined;
    wrap.append(openedRow ? packageScreen(openedRow) : section === "discover" ? discover() : installed());
    return wrap;
  }

  function segmentButton(label, id) {
    const button = el("button", { class: section === id ? "active" : "" }, [label]);
    button.addEventListener("click", () => { section = id; openMenu = ""; opened = ""; packageQuery = ""; render(); });
    return button;
  }

  function discover() {
    const wrap = el("div");
    wrap.append(sources());
    wrap.append(searchBox("Search skills and plugins", discoverQuery, (value) => {
      discoverQuery = value;
      paint("results", visibleCatalog());
    }));
    wrap.append(chips([
      ["all", "All"],
      ["skill", "Skills"],
      ["plugin", "Plugins"],
    ], discoverFilter, (value) => { discoverFilter = value; render(); }));
    wrap.append(results(visibleCatalog()));
    return wrap;
  }

  function installed() {
    const wrap = el("div");
    wrap.append(searchBox("Search installed", installedQuery, (value) => {
      installedQuery = value;
      paint("results", visibleInstalled());
    }));
    const row = chips([
      ["all", "All"],
      ["yours", "Yours"],
      ["builtin", "Built-in"],
      ["plugin", "Plugins"],
    ], installedFilter === "updates" ? "all" : installedFilter, (value) => { installedFilter = value; render(); });
    wrap.append(row, updateBar(), installedList(visibleInstalled()));
    return wrap;
  }

  function sources() {
    const panel = el("div", { class: "panel" });
    panel.append(el("div", { class: "panel-title" }, ["Marketplace"]));
    const input = el("input", { placeholder: "https://github.com/owner/repo" });
    const row = el("div", { class: "add-row" });
    row.append(input, textButton("Add", () => post("addMarketplace", { url: input.value }), "primary"));
    panel.append(row);
    panel.append(para("Adding a source only lists what is inside. Nothing is installed until you press Install.", "note"));
    return panel;
  }

  function results(rows) {
    const node = el("div");
    node.id = "results";
    fill(node, rows);
    return node;
  }

  function installedList(rows) {
    const node = el("div");
    node.id = "results";
    paintInstalled(node, rows);
    return node;
  }

  function paint(id, rows) {
    const node = document.getElementById(id);
    if (!node) return;
    node.replaceChildren();
    if (id === "results" && section === "installed" && !opened && installedFilter === "all") paintInstalled(node, rows);
    else fill(node, rows);
  }

  function paintInstalled(node, rows) {
    if (installedFilter !== "all") {
      fill(node, rows);
      return;
    }
    const personal = rows.filter((row) => laneOf(row) === "personal");
    const yours = rows.filter((row) => laneOf(row) === "yours");
    const plugins = rows.filter((row) => laneOf(row) === "plugin");
    const builtin = rows.filter((row) => laneOf(row) === "builtin");
    if (!personal.length && !yours.length && !plugins.length && !builtin.length) {
      fill(node, []);
      return;
    }
    node.append(lane("Your skills", personal, "Skills Cursor keeps for you. They were copied into your account without the GitHub address, so they cannot be checked for updates."));
    node.append(lane("From GitHub", yours, ""));
    node.append(lane("Plugins", plugins, "Installed by Cursor with a plugin. These skills cannot be turned off or updated here. Cursor updates the plugin itself."));
    node.append(lane("Built into Cursor", builtin, "Included with Cursor. They cannot be turned off or removed."));
  }

  function lane(title, rows, note) {
    if (!rows.length) return el("div");
    const block = el("section", { class: "lane" });
    block.append(el("div", { class: "panel-title" }, [title]));
    if (note) block.append(para(note, "note"));
    const list = el("div");
    fill(list, rows);
    block.append(list);
    return block;
  }

  function laneOf(row) {
    const group = row.kind === "package" ? row.skills[0].group : row.card.group;
    if (group === "plugin") return "plugin";
    if (group === "builtin") return "builtin";
    if (group === "personal") return "personal";
    return "yours";
  }

  function fill(node, rows) {
    if (!rows.length) {
      node.append(para(section === "discover" ? "Nothing matches. Add a marketplace or change the filter." : "Nothing matches.", "empty"));
      return;
    }
    for (const row of rows) node.append(row.kind === "package" ? packageCard(row) : componentCard(row.card));
  }

  function visibleCatalog() {
    return filterGroups(model.catalog, discoverQuery, (card) => discoverFilter === "all" || card.type === discoverFilter);
  }

  function visibleInstalled() {
    return filterGroups(model.installed, installedQuery, (card) => {
      if (showUpdates && !card.updateAvailable) return false;
      const source = installedFilter === "updates" ? "all" : installedFilter;
      if (source === "all") return true;
      if (source === "yours") return card.group === "yours" || card.group === "personal";
      return card.group === source;
    });
  }

  function filterGroups(cards, query, accept) {
    const needle = query.trim().toLowerCase();
    const rows = groupRows(cards.filter(accept));
    if (!needle) return rows;
    const matched = [];
    for (const row of rows) {
      if (row.kind === "skill") {
        if (matches(row.card, needle)) matched.push(row);
        continue;
      }
      if (`${row.name} ${row.detail}`.toLowerCase().includes(needle)) {
        matched.push(row);
        continue;
      }
      const skills = row.skills.filter((card) => matches(card, needle));
      if (skills.length) matched.push({ ...row, skills, on: skills.filter((card) => card.enabled !== false).length });
    }
    return matched;
  }

  function groupRows(cards) {
    const buckets = new Map();
    for (const card of cards) {
      const key = card.bundleId || `solo:${card.id}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(card);
    }
    const rows = [];
    for (const [key, skills] of buckets) {
      skills.sort((left, right) => left.name.localeCompare(right.name));
      if (!skills[0].bundleId || skills.length < 2) {
        for (const card of skills) rows.push({ kind: "skill", card });
        continue;
      }
      rows.push({
        kind: "package",
        id: key,
        name: titleOf(skills[0].bundleName),
        detail: skills[0].bundleName,
        place: skills[0].place,
        repoUrl: skills[0].repoUrl || "",
        marketplaceId: skills.every((card) => card.marketplaceId && card.marketplaceId === skills[0].marketplaceId) ? skills[0].marketplaceId : "",
        syncLocal: skills.every((card) => card.syncLocal),
        marketLocal: skills.every((card) => card.marketLocal),
        readOnly: skills.every((card) => card.readOnly),
        skills,
        on: skills.filter((card) => card.enabled !== false).length,
      });
    }
    rows.sort((left, right) => rowLabel(left).localeCompare(rowLabel(right)));
    return rows;
  }

  function packageCard(row) {
    const node = el("div", { class: "card" });
    const head = el("div", { class: "package-head" });
    const text = el("div", { class: "skill-body" });
    text.append(el("h2", {}, [row.name]));
    text.append(el("div", { class: "meta" }, [`${row.skills.length} skills · ${packageState(row)}`]));
    if (row.syncLocal || row.marketLocal) text.append(el("div", { class: "sync-warn" }, ["This device only"]));
    text.append(el("div", { class: "meta" }, [row.place]));
    if (row.detail && row.detail !== row.name) text.append(el("div", { class: "meta" }, [row.detail]));
    head.append(text, packageIcons(row));
    node.append(head);
    if (section === "discover" && row.marketplaceId) {
      const source = model.marketplaces.find((item) => item.id === row.marketplaceId);
      if (source?.lastError) node.append(para(source.lastError, "error"));
    }
    const actions = el("div", { class: "actions" });
    const pending = pendingInstalls(row);
    if (pending.length) actions.append(textButton(pending.length === row.skills.length ? "Install all" : `Install ${pending.length}`, () => post("installMany", { ids: pending.map((card) => card.id) }), "primary"));
    actions.append(textButton("Open", () => { opened = row.id; packageQuery = ""; render(); }, pending.length ? "secondary" : "primary"));
    const keep = syncToggle(row);
    if (keep) actions.append(keep);
    node.append(actions);
    return node;
  }

  function syncToggle(row) {
    if (row.readOnly || !row.skills) return undefined;
    const can = row.skills.some((card) => card.canSync || card.syncLocal || card.marketLocal);
    if (!can) return undefined;
    if (row.marketplaceId) {
      return textButton(row.marketLocal ? "Sync" : "Keep local", () => post("syncVisibility", { kind: "marketplace", id: row.marketplaceId, excluded: !row.marketLocal }), "secondary");
    }
    return textButton(row.syncLocal ? "Sync" : "Keep local", () => post("syncVisibility", { kind: "bundle", id: row.id, excluded: !row.syncLocal }), "secondary");
  }

  function packageIcons(row) {
    const icons = el("div", { class: "icon-row" });
    if (row.repoUrl) icons.append(iconButton("Open repository on GitHub", "github", () => post("openLink", { url: row.repoUrl })));
    if (section === "discover" && row.marketplaceId) {
      icons.append(iconButton("Refresh marketplace", "refresh", () => post("refreshOne", { id: row.marketplaceId })));
      icons.append(iconButton("Remove marketplace", "trash", () => post("removeMarketplace", { id: row.marketplaceId })));
    }
    if (canUpdate(row)) icons.append(iconButton("Update skills from GitHub", "refresh", () => post("updateBundle", { bundleId: row.id })));
    if (canRemove(row)) icons.append(iconButton("Remove", "trash", () => post("removeBundle", { bundleId: row.id })));
    return icons;
  }

  function packageScreen(row) {
    const wrap = el("div", { class: "stack" });
    const needle = packageQuery.trim().toLowerCase();
    const skills = needle ? row.skills.filter((card) => matches(card, needle)) : row.skills;
    wrap.append(searchBox("Search in this package", packageQuery, (value) => {
      packageQuery = value;
      const list = document.getElementById("results");
      if (!list) return;
      const next = value.trim().toLowerCase();
      const visible = next ? row.skills.filter((card) => matches(card, next)) : row.skills;
      list.replaceChildren();
      if (!visible.length) list.append(para("Nothing matches in this package.", "empty"));
      for (const card of visible) list.append(skillRow(card));
    }));
    wrap.append(textButton("Back", () => { opened = ""; packageQuery = ""; render(); }, "back"));
    const head = el("div", { class: "package-head" });
    const text = el("div", { class: "skill-body" });
    text.append(el("h2", {}, [row.name]));
    text.append(el("div", { class: "meta" }, [`${row.skills.length} skills · ${row.place}`]));
    if (row.syncLocal || row.marketLocal) text.append(el("div", { class: "sync-warn" }, ["This device only"]));
    if (row.detail && row.detail !== row.name) text.append(el("div", { class: "meta" }, [row.detail]));
    head.append(text, packageIcons(row));
    wrap.append(head);
    const pending = pendingInstalls(row);
    const packageActions = el("div", { class: "actions" });
    if (pending.length) packageActions.append(textButton(pending.length === row.skills.length ? "Install all" : `Install ${pending.length}`, () => post("installMany", { ids: pending.map((card) => card.id) }), "primary"));
    const keep = syncToggle(row);
    if (keep) packageActions.append(keep);
    if (packageActions.childNodes.length) wrap.append(packageActions);
    if (row.readOnly) {
      wrap.append(para(row.name === "Cursor"
        ? "Included with Cursor. These skills cannot be turned off or removed."
        : "Installed with a plugin. Cursor updates the plugin itself. Individual skills cannot be turned off here.", "note"));
    }
    const list = el("div");
    list.id = "results";
    if (!skills.length) list.append(para("Nothing matches in this package.", "empty"));
    for (const card of skills) list.append(skillRow(card));
    wrap.append(list);
    return wrap;
  }

  function skillRow(card) {
    const node = el("div", { class: "skill-row" });
    if (card.installed && card.canToggle) node.append(slider(card));
    const body = el("div", { class: "skill-body" });
    body.append(el("h2", {}, [card.name]));
    if (card.description) body.append(para(card.description));
    if (card.pathLabel) body.append(el("div", { class: "meta" }, [card.pathLabel]));
    if (card.syncLocal || card.marketLocal) body.append(el("div", { class: "sync-warn" }, ["This device only"]));
    if (!card.enabled) body.append(el("div", { class: "meta" }, ["Off"]));
    if (card.updateAvailable) body.append(el("div", { class: "meta" }, ["Update available"]));
    const actions = el("div", { class: "actions" });
    if (!card.installed) actions.append(textButton("Install", () => post("install", { id: card.id }), "primary"));
    if (card.canSync) actions.append(textButton(card.syncLocal ? "Sync" : "Keep local", () => post("syncVisibility", { kind: "skill", id: card.id, excluded: !card.syncLocal }), "secondary"));
    if (card.updateAvailable) actions.append(textButton("Update", () => post("update", { id: card.id }), "primary"));
    if (actions.childNodes.length) body.append(actions);
    node.append(body, skillIcons(card, false));
    return node;
  }

  function componentCard(card) {
    const node = el("div", { class: "card" });
    const head = el("div", { class: "skill-row bare" });
    if (card.installed && card.canToggle) head.append(slider(card));
    const body = el("div", { class: "skill-body" });
    body.append(el("h2", {}, [card.name]));
    if (card.description) body.append(para(card.description));
    const where = [];
    if (card.bundleName) where.push(card.bundleName);
    if (card.place && card.place !== card.bundleName) where.push(card.place);
    if (card.statusLabel) where.push(card.statusLabel);
    if (where.length) body.append(el("div", { class: "meta" }, [where.join(" · ")]));
    if (card.syncLocal || card.marketLocal) body.append(el("div", { class: "sync-warn" }, ["This device only"]));
    head.append(body, skillIcons(card, true));
    node.append(head);
    const row = el("div", { class: "actions" });
    if (!card.installed) row.append(textButton("Install", () => post("install", { id: card.id }), "primary"));
    if (card.canSync) row.append(textButton(card.syncLocal ? "Sync" : "Keep local", () => post("syncVisibility", { kind: "skill", id: card.id, excluded: !card.syncLocal }), "secondary"));
    else if (section === "discover" && card.marketplaceId) row.append(textButton(card.marketLocal ? "Sync" : "Keep local", () => post("syncVisibility", { kind: "marketplace", id: card.marketplaceId, excluded: !card.marketLocal }), "secondary"));
    if (card.updateAvailable) row.append(textButton("Update", () => post("update", { id: card.id }), "primary"));
    if (card.installed && card.managed && !card.readOnly) {
      row.append(textButton(openMenu === card.id ? "Close" : "More", () => {
        openMenu = openMenu === card.id ? "" : card.id;
        render();
      }, "secondary"));
    }
    if (row.childNodes.length) node.append(row);
    if (openMenu === card.id) node.append(more(card));
    return node;
  }

  function skillIcons(card, allowRemove) {
    const icons = el("div", { class: "icon-row" });
    if (allowRemove && card.repoUrl && card.bundleId && !card.readOnly) {
      icons.append(iconButton("Update from GitHub", "refresh", () => post("updateSkill", { id: card.id })));
    }
    if (card.installed) icons.append(iconButton("Show folder", "files", () => post("reveal", { id: card.id })));
    if (allowRemove && card.installed && !card.readOnly) icons.append(iconButton("Remove", "trash", () => post("uninstall", { id: card.id })));
    return icons;
  }

  function slider(card) {
    const on = card.enabled !== false;
    const button = el("button", { class: on ? "slider on" : "slider", type: "button", title: on ? "On" : "Off" });
    button.setAttribute("role", "switch");
    button.setAttribute("aria-checked", on ? "true" : "false");
    button.append(el("span", { class: "knob" }));
    button.addEventListener("click", () => post("enable", { id: card.id, enabled: !on }));
    return button;
  }

  function iconButton(title, kind, onClick) {
    const button = el("button", { class: "icon", type: "button", title });
    button.setAttribute("aria-label", title);
    button.append(svgIcon(kind));
    button.addEventListener("click", onClick);
    return button;
  }

  function svgIcon(kind) {
    const paths = {
      trash: "M6.2 1.5h3.6l.7 1.2H14v1.4H2V2.7h3.5l.7-1.2zM3.2 5h9.6l-.7 9.1c-.05.6-.5 1-1.1 1H5c-.6 0-1.05-.4-1.1-1L3.2 5z",
      github: "M8 1.2a6.8 6.8 0 00-2.15 13.25c.34.06.46-.15.46-.33v-1.16c-1.94.42-2.35-.94-2.35-.94-.31-.8-.76-1.01-.76-1.01-.62-.43.05-.42.05-.42.69.05 1.05.71 1.05.71.61 1.05 1.6.75 1.99.57.06-.45.24-.75.44-.92-1.55-.18-3.18-.78-3.18-3.46 0-.76.27-1.39.72-1.88-.07-.18-.31-.9.07-1.87 0 0 .59-.19 1.93.72a6.6 6.6 0 013.52 0c1.34-.91 1.93-.72 1.93-.72.38.97.14 1.69.07 1.87.45.49.72 1.12.72 1.88 0 2.69-1.64 3.28-3.2 3.45.25.22.47.64.47 1.3v1.93c0 .18.12.4.47.33A6.8 6.8 0 008 1.2z",
      refresh: "M13.2 8a5.2 5.2 0 01-8.7 3.9L5.8 10.4H2.2v3.6l1.5-1.5A7 7 0 108 1v1.8A5.2 5.2 0 0113.2 8z",
      folder: "M1.5 3.2h4.4l1.5 1.6h7.1v7.9h-13V3.2z",
      files: "M3 1.5h6.2L13 5.3V14.5H3V1.5zm6 1.2v3.2H12",
    };
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "currentColor");
    path.setAttribute("d", paths[kind] || "");
    svg.append(path);
    return svg;
  }

  function more(card) {
    const row = el("div", { class: "actions" });
    if (!card.readOnly && card.managed) {
      row.append(textButton(card.pinned ? "Unpin" : "Pin", () => post("pin", { id: card.id, pinned: !card.pinned }), "secondary"));
      row.append(textButton("Changes", () => post("diff", { id: card.id }), "secondary"));
      row.append(textButton("Rollback", () => post("rollback", { id: card.id }), "secondary"));
      row.append(textButton("Source", () => post("open", { id: card.id }), "secondary"));
    }
    return row;
  }

  function pendingInstalls(row) {
    return row.skills.filter((card) => !card.installed && !card.readOnly);
  }

  function packageState(row) {
    const installed = row.skills.filter((card) => card.installed).length;
    if (row.readOnly) return "included";
    if (installed === 0) return "not installed";
    if (installed < row.skills.length) return `${installed} of ${row.skills.length} installed`;
    const off = row.skills.filter((card) => card.enabled === false).length;
    return off ? `${installed - off} on · ${off} off` : "all on";
  }

  function canRemove(row) {
    return row.skills.length > 0 && row.skills.every((card) => card.installed && !card.readOnly);
  }

  function canUpdate(row) {
    return !!row.repoUrl && row.skills.every((card) => card.installed && !card.readOnly && card.group === "yours");
  }

  function matches(card, needle) {
    return `${card.name} ${card.description} ${card.place} ${card.bundleName} ${card.author}`.toLowerCase().includes(needle);
  }

  function titleOf(name) {
    const parts = String(name || "").split("/");
    return parts[parts.length - 1] || "Package";
  }

  function rowLabel(row) {
    return row.kind === "package" ? row.name : row.card.name;
  }

  function updateBar() {
    const wrap = el("div", { class: "update-bar" });
    const row = el("div", { class: "actions" });
    row.append(textButton("Check for updates", () => post("check"), "secondary"));
    const count = model.overview.updates;
    if (count) {
      row.append(textButton(showUpdates ? "Hide updates" : `Show ${count} update${count === 1 ? "" : "s"}`, () => { showUpdates = !showUpdates; render(); }, showUpdates ? "primary" : "secondary"));
      row.append(textButton("Update all", () => post("updateAll"), "primary"));
    }
    wrap.append(row, para(updateStatus(), "status"));
    return wrap;
  }

  function syncState() {
    const when = model.github.lastSyncedAt ? ` Last sync ${new Date(model.github.lastSyncedAt).toLocaleString()}.` : "";
    if (model.conflict) return para(`Conflict. Both this device and GitHub changed. ${model.conflict.reason}`, "sync-bad");
    switch (model.github.syncStatus) {
      case "synchronized":
        return para(`GitHub matches this device.${when} ${model.github.nextSyncAt}`, "ok");
      case "local-changes":
        return para(`This device has changes that are not on GitHub yet. Push or Sync to send them. ${model.github.nextSyncAt}`, "sync-warn");
      case "remote-changes":
        return para(`GitHub has newer settings. Pull or Sync to apply them here. ${model.github.nextSyncAt}`, "sync-warn");
      case "error":
        return para(`${model.github.syncError || "Sync failed."} ${model.github.nextSyncAt}`, "sync-bad");
      default:
        return para(`Not synchronized yet. Push or Sync to copy this device to GitHub. ${model.github.nextSyncAt}`, "sync-warn");
    }
  }

  function updateStatus() {
    const count = model.overview.updates;
    const at = model.overview.lastCheckedAt;
    if (!at) return "Updates have not been checked yet.";
    const when = new Date(at).toLocaleString();
    if (!count) return `Up to date. Last check ${when}.`;
    return `${count} update${count === 1 ? "" : "s"} available. Last check ${when}.`;
  }

  function settings() {
    const wrap = el("div", { class: "settings" });
    const github = el("div", { class: "panel" });
    github.append(el("div", { class: "panel-title" }, ["GitHub"]));
    github.append(para(model.github.connected ? `Connected as ${model.github.login || "GitHub"}.` : "Not connected. Connect to keep a copy of this device's skill list.", model.github.connected ? "ok" : "note"));
    const account = el("div", { class: "actions" });
    account.append(textButton(model.github.connected ? "Reconnect" : "Connect", () => post("connect"), "primary", !!activity));
    account.append(textButton(activity === "repos" ? "Loading repositories…" : repoListOpen ? "Hide repositories" : "Repositories", () => {
      if (activity) return;
      if (repoListOpen) {
        repoListOpen = false;
        render();
        return;
      }
      activity = "repos";
      render();
      post("listRepos");
    }, "secondary", !!activity));
    if (model.github.connected) account.append(textButton("Disconnect", () => post("disconnect"), "secondary", !!activity));
    github.append(account);
    if (activity === "repos") github.append(para("Loading repositories…", "status"));
    if (repoListOpen && !activity && !repos.length) github.append(para("No repositories found.", "status"));
    if (repoListOpen && repos.length) {
      const select = el("select");
      select.append(el("option", { value: "" }, ["Choose a repository"]));
      for (const repo of repos) select.append(el("option", { value: repo.fullName }, [repo.fullName]));
      select.value = model.github.repository || "";
      if (activity) select.disabled = true;
      select.addEventListener("change", () => {
        if (!select.value || activity) return;
        activity = "select";
        render();
        post("selectRepo", { fullName: select.value });
      });
      github.append(field("Repository", select));
    }
    if (activity === "select") github.append(para("Saving the repository…", "status"));
    if (model.github.repository) {
      github.append(para(`Using ${model.github.repository}`, "using"));
      github.append(syncState());
      if (model.conflict) github.append(conflict(model.conflict.reason));
    } else {
      const name = el("input", { placeholder: "private-repo-name" });
      if (activity) name.disabled = true;
      github.append(field("New private repository", name));
      const create = el("div", { class: "actions" });
      create.append(textButton(activity === "create" ? "Creating…" : "Create", () => {
        if (activity) return;
        const repoName = name.value;
        activity = "create";
        render();
        post("createRepo", { name: repoName });
      }, "primary", !!activity));
      github.append(create);
      if (activity === "create") github.append(para("Creating the repository and saving the skill list…", "status"));
    }
    const sync = el("div", { class: "panel" });
    sync.append(el("div", { class: "panel-title" }, ["Sync"]));
    sync.append(para("Sends the skill list to the private repository and brings it back to this device.", "note"));
    sync.append(para("Ask waits for you. Keep this device or Keep GitHub resolves the next conflict on its own.", "note"));
    const syncButtons = el("div", { class: "actions" });
    syncButtons.append(textButton("Pull", () => post("pull"), "secondary"));
    syncButtons.append(textButton("Push", () => post("push"), "secondary"));
    syncButtons.append(textButton("Sync", () => post("sync"), "primary"));
    sync.append(syncButtons);
    sync.append(choices("How often", "syncFrequency", [
      ["off", "Off"],
      ["startup", "On startup"],
      ["hourly", "Hourly"],
      ["daily", "Daily"],
    ]));
    sync.append(choices("If both sides changed", "conflictResolution", [
      ["ask", "Ask"],
      ["keep-local", "Keep this device"],
      ["keep-remote", "Keep GitHub"],
    ]));
    const install = el("div", { class: "panel" });
    install.append(el("div", { class: "panel-title" }, ["Install"]));
    install.append(para("Where a skill goes when you press Install.", "note"));
    install.append(choices("Install for", "installationScope", [
      ["user", "This device"],
      ["project", "This project"],
    ]));
    install.append(choices("Folder", "defaultSkillLocation", [
      ["cursor-skills", ".cursor/skills"],
      ["agents-skills", ".agents/skills"],
    ]));
    const updates = el("div", { class: "panel" });
    updates.append(el("div", { class: "panel-title" }, ["Updates"]));
    updates.append(para("Applies to skills installed from GitHub. Cursor updates its own built-in skills and plugins.", "note"));
    updates.append(choices("When an update is found", "updateMode", [
      ["manual", "Wait"],
      ["notify", "Notify"],
      ["auto", "Install"],
    ]));
    updates.append(settingCheck("Refresh marketplace lists in the background", "automaticMarketplaceRefresh"));
    updates.append(settingCheck("Check for updates in the background", "automaticUpdateChecks"));
    updates.append(settingCheck("Show a notification", "updateNotifications"));
    updates.append(settingCheck("Back up files before replacing them", "backupBeforeUpdate"));
    updates.append(settingCheck("Let the agent install from trusted sources without asking", "autoApproveTrustedInstalls"));
    wrap.append(github, sync, install, updates);
    return wrap;
  }

  function conflict(reason) {
    const node = el("div", { class: "banner" });
    node.append(el("strong", {}, ["Sync conflict"]));
    node.append(para(reason, "note"));
    const row = el("div", { class: "actions" });
    row.append(textButton("Keep this device", () => post("resolve", { choice: "local" }), "primary"));
    row.append(textButton("Keep GitHub", () => post("resolve", { choice: "remote" }), "secondary"));
    node.append(row);
    return node;
  }

  function chips(items, current, onChange) {
    const row = el("div", { class: "chips" });
    for (const [id, label] of items) {
      const button = el("button", { class: current === id ? "active" : "" }, [label]);
      button.addEventListener("click", () => onChange(id));
      row.append(button);
    }
    return row;
  }

  function searchBox(placeholder, value, onInput) {
    const input = el("input", { placeholder, value });
    input.addEventListener("input", () => onInput(input.value));
    return input;
  }

  function choices(label, key, options) {
    const wrap = el("div", { class: "field" });
    wrap.append(el("span", {}, [label]));
    const row = el("div", { class: "choices" });
    for (const [value, title] of options) {
      const button = el("button", { class: model.settings[key] === value ? "active" : "" }, [title]);
      button.addEventListener("click", () => post("settings", { patch: { [key]: value } }));
      row.append(button);
    }
    wrap.append(row);
    return wrap;
  }

  function settingCheck(label, key) {
    const wrap = el("label", { class: "check" });
    const box = el("input");
    box.type = "checkbox";
    box.checked = !!model.settings[key];
    box.addEventListener("change", () => post("settings", { patch: { [key]: box.checked } }));
    wrap.append(box, text(label));
    return wrap;
  }

  function field(label, control) {
    const wrap = el("label", { class: "field" });
    wrap.append(el("span", {}, [label]), control);
    return wrap;
  }

  function textButton(label, onClick, kind, disabled) {
    const node = el("button", { class: kind || "ghost" }, [label]);
    if (disabled) node.disabled = true;
    node.addEventListener("click", onClick);
    return node;
  }

  function para(value, className) {
    return el("p", { class: className || "" }, [value]);
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value !== "") node.setAttribute(key, String(value));
    }
    for (const child of children || []) node.append(child);
    return node;
  }

  function text(value) {
    return document.createTextNode(value);
  }

  function post(type, payload) {
    error = "";
    vscode.postMessage({ type, ...(payload || {}) });
  }

  vscode.postMessage({ type: "ready" });
}());
