import { invoke } from "@tauri-apps/api/core";
import { ageLabel, displayAgent, displayProject } from "./names";
import { statusOf } from "./status";
import type { Store } from "./store";

interface DirEntry { name: string; isDir: boolean; }

const SPECIAL_DIRS = new Set(["node_modules", "target", ".git"]);

const el = (tag: string, cls: string, text = ""): HTMLElement => {
  const e = document.createElement(tag); e.className = cls; e.textContent = text; return e;
};

const row = (cls: string): HTMLButtonElement => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `explorer-row ${cls}`;
  return b;
};

/**
 * Renders the left-hand Project Explorer pane: discovered projects, each
 * expandable into a lazy `files` tree (backed by `list_dir`) and a
 * `sessions` list (that project's root agents, click focuses the map).
 *
 * State (which rows are expanded, cached `list_dir` results, in-flight
 * loads/errors) lives on the instance and survives re-render — `render()` is
 * called on every `store.onchange`, and without this the whole tree would
 * snap shut on every incoming event.
 */
export class Explorer {
  private container: HTMLElement;
  private onFocusSession: (id: string) => void;

  // Expand/collapse state keyed by a stable string per row (project slug,
  // "<slug>#files"/"<slug>#sessions", or the directory's own absolute path
  // for nested file-tree nodes) — never by array index, which would shift.
  private expanded = new Set<string>();
  private dirCache = new Map<string, DirEntry[]>();
  private dirErrors = new Map<string, string>();
  private loading = new Set<string>();

  private lastStore: Store | null = null;

  constructor(container: HTMLElement, onFocusSession: (id: string) => void) {
    this.container = container;
    this.onFocusSession = onFocusSession;
  }

  render(store: Store): void {
    this.lastStore = store;
    const now = Date.now();
    this.container.replaceChildren(el("h3", "pane-title", "Explorer"));

    const projectDirs = store.discovery?.projectDirs ?? [];
    if (projectDirs.length === 0) {
      const empty = el("div", "explorer-empty", "Projects Claude Code has worked in appear here.");
      this.container.append(empty);
      return;
    }

    for (const pd of projectDirs) this.container.append(this.renderProject(pd, store, now));
  }

  private rerender(): void {
    if (this.lastStore) this.render(this.lastStore);
  }

  private renderProject(
    pd: { slug: string; path: string; exists: boolean },
    store: Store,
    now: number,
  ): HTMLElement {
    const wrap = el("div", "explorer-project");
    const key = `proj:${pd.slug}`;
    const isOpen = this.expanded.has(key);

    const projectDirs = store.discovery?.projectDirs;
    const header = row(pd.exists ? "explorer-project-header" : "explorer-project-header dim");
    header.title = pd.path;
    header.append(el("span", "explorer-caret", pd.exists ? (isOpen ? "▾" : "▸") : "✕"),
      el("span", "explorer-name", displayProject(pd.slug, projectDirs)));
    wrap.append(header);

    if (!pd.exists) {
      header.disabled = true;
      wrap.append(el("div", "explorer-row dim", `path not found: ${pd.path}`));
      return wrap;
    }

    header.onclick = () => {
      if (isOpen) this.expanded.delete(key); else this.expanded.add(key);
      this.rerender();
    };

    if (isOpen) {
      const body = el("div", "explorer-project-body");
      body.append(this.renderGroup(`${pd.slug}#files`, "files", () => this.renderFilesGroup(pd)));
      body.append(this.renderGroup(`${pd.slug}#sessions`, "sessions", () => this.renderSessionsGroup(pd, store, now)));
      wrap.append(body);
    }
    return wrap;
  }

  private renderGroup(key: string, label: string, body: () => HTMLElement): HTMLElement {
    const wrap = el("div", "explorer-group");
    const isOpen = this.expanded.has(key);
    const header = row("explorer-group-header");
    header.append(el("span", "explorer-caret", isOpen ? "▾" : "▸"), el("span", "", label));
    header.onclick = () => {
      if (isOpen) this.expanded.delete(key); else this.expanded.add(key);
      this.rerender();
    };
    wrap.append(header);
    if (isOpen) wrap.append(body());
    return wrap;
  }

  private renderSessionsGroup(pd: { slug: string; path: string }, store: Store, now: number): HTMLElement {
    const list = el("div", "explorer-sessions");
    const sessions = store.nodes().filter((a) => a.project === pd.slug && !a.parentId);
    if (sessions.length === 0) {
      list.append(el("div", "explorer-row dim", "no sessions yet"));
      return list;
    }
    for (const a of sessions) {
      const st = statusOf(a, now);
      const r = row(`explorer-session ${st}`);
      r.append(
        el("span", `explorer-dot ${st}`),
        el("span", "explorer-session-name", displayAgent(a, pd.path)),
        el("span", "explorer-session-age dim", ageLabel(a.lastActivityMs, now)),
      );
      r.title = a.id;
      r.onclick = () => this.onFocusSession(a.id);
      list.append(r);
    }
    return list;
  }

  private renderFilesGroup(pd: { slug: string; path: string }): HTMLElement {
    return this.renderDirTree(pd.path);
  }

  // Renders (and lazily loads) the immediate children of `path`. `node_modules`,
  // `target`, and `.git` render collapsed with a count badge — expanding one
  // reuses this same lazy-loading path, it is just gated behind an extra click.
  private renderDirTree(path: string): HTMLElement {
    const wrap = el("div", "explorer-dir");
    if (this.dirErrors.has(path)) {
      wrap.append(el("div", "explorer-row dim", `⚠ ${this.dirErrors.get(path)}`));
      return wrap;
    }
    const cached = this.dirCache.get(path);
    if (!cached) {
      if (!this.loading.has(path)) this.loadDir(path);
      wrap.append(el("div", "explorer-row dim", "loading…"));
      return wrap;
    }
    for (const entry of cached) {
      const childPath = `${path}/${entry.name}`;
      if (entry.isDir && SPECIAL_DIRS.has(entry.name)) {
        wrap.append(this.renderSpecialDir(childPath, entry.name));
      } else if (entry.isDir) {
        wrap.append(this.renderExpandableDir(childPath, entry.name));
      } else {
        const cls = entry.name.startsWith(".") ? "explorer-row dim" : "explorer-row";
        wrap.append(el("div", cls, entry.name));
      }
    }
    if (cached.length === 0) wrap.append(el("div", "explorer-row dim", "empty"));
    return wrap;
  }

  private renderExpandableDir(childPath: string, name: string): HTMLElement {
    const box = el("div", "explorer-subdir");
    const key = `dir:${childPath}`;
    const isOpen = this.expanded.has(key);
    const r = row("explorer-row explorer-dir-row");
    r.append(el("span", "explorer-caret", isOpen ? "▾" : "▸"), el("span", "", name));
    r.onclick = () => {
      if (isOpen) this.expanded.delete(key); else this.expanded.add(key);
      this.rerender();
    };
    box.append(r);
    if (isOpen) box.append(this.renderDirTree(childPath));
    return box;
  }

  private renderSpecialDir(childPath: string, name: string): HTMLElement {
    const box = el("div", "explorer-subdir");
    const key = `dir:${childPath}`;
    const isOpen = this.expanded.has(key);
    const r = row("explorer-row explorer-dir-row explorer-special-dir");
    const count = this.dirCache.get(childPath)?.length;
    r.append(
      el("span", "explorer-caret", isOpen ? "▾" : "▸"),
      el("span", "", name),
      el("span", "chip dim", count === undefined ? "…" : String(count)),
    );
    r.onclick = () => {
      if (isOpen) this.expanded.delete(key); else this.expanded.add(key);
      if (!this.dirCache.has(childPath) && !this.loading.has(childPath)) this.loadDir(childPath);
      this.rerender();
    };
    box.append(r);
    // Prime the count badge even before the user expands, so it reads
    // "node_modules (128)" rather than a bare caret — one shallow listing,
    // not a recursive scan.
    if (!this.dirCache.has(childPath) && !this.dirErrors.has(childPath) && !this.loading.has(childPath)) {
      this.loadDir(childPath);
    }
    if (isOpen) box.append(this.renderDirTree(childPath));
    return box;
  }

  private loadDir(path: string): void {
    this.loading.add(path);
    invoke<DirEntry[]>("list_dir", { path })
      .then((entries) => {
        this.dirCache.set(path, entries);
        this.loading.delete(path);
        this.rerender();
      })
      .catch((err: unknown) => {
        this.dirErrors.set(path, String(err));
        this.loading.delete(path);
        this.rerender();
      });
  }
}
