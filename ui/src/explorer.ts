import { invoke } from "@tauri-apps/api/core";
import { ageLabel, displayAgent, displayProject } from "./names";
import { statusOf } from "./status";
import type { Store } from "./store";

interface DirEntry { name: string; isDir: boolean; }

const SPECIAL_DIRS = new Set(["node_modules", "target", ".git"]);

/**
 * Pure, DOM-free state the tree view is built from: which rows are expanded,
 * the `list_dir` cache/error/in-flight bookkeeping keyed by absolute path.
 * Split out from `Explorer` so it can be unit-tested directly (no `document`,
 * no `invoke`) — `render()` never reconstructs this, it only reads it, which
 * is exactly what keeps expand/collapse state alive across re-renders.
 */
export class ExplorerState {
  readonly expanded = new Set<string>();
  readonly dirCache = new Map<string, DirEntry[]>();
  readonly dirErrors = new Map<string, string>();
  readonly loading = new Set<string>();

  toggle(key: string): void {
    if (this.expanded.has(key)) this.expanded.delete(key); else this.expanded.add(key);
  }

  isOpen(key: string): boolean {
    return this.expanded.has(key);
  }

  /** Whether a fresh `list_dir(path)` call should be kicked off — false once cached, errored, or already in flight. */
  shouldFetch(path: string): boolean {
    return !this.dirCache.has(path) && !this.dirErrors.has(path) && !this.loading.has(path);
  }

  /** What a directory node should render as, before any DOM is touched. */
  dirRenderMode(path: string): "error" | "loading" | "ready" {
    if (this.dirErrors.has(path)) return "error";
    if (!this.dirCache.has(path)) return "loading";
    return "ready";
  }
}

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

  // Keyed by a stable string per row (project slug, "<slug>#files"/
  // "<slug>#sessions", or the directory's own absolute path for nested
  // file-tree nodes) — never by array index, which would shift.
  private state = new ExplorerState();

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
    const isOpen = this.state.isOpen(key);

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
      this.state.toggle(key);
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
    const isOpen = this.state.isOpen(key);
    const header = row("explorer-group-header");
    header.append(el("span", "explorer-caret", isOpen ? "▾" : "▸"), el("span", "", label));
    header.onclick = () => {
      this.state.toggle(key);
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
    const mode = this.state.dirRenderMode(path);
    if (mode === "error") {
      wrap.append(el("div", "explorer-row dim", `⚠ ${this.state.dirErrors.get(path)}`));
      return wrap;
    }
    if (mode === "loading") {
      if (this.state.shouldFetch(path)) this.loadDir(path);
      wrap.append(el("div", "explorer-row dim", "loading…"));
      return wrap;
    }
    const cached = this.state.dirCache.get(path)!;
    for (const entry of cached) {
      const childPath = `${path}/${entry.name}`;
      const dim = entry.name.startsWith(".");
      if (entry.isDir && SPECIAL_DIRS.has(entry.name)) {
        wrap.append(this.renderSpecialDir(childPath, entry.name));
      } else if (entry.isDir) {
        wrap.append(this.renderExpandableDir(childPath, entry.name, dim));
      } else {
        wrap.append(el("div", dim ? "explorer-row dim" : "explorer-row", entry.name));
      }
    }
    if (cached.length === 0) wrap.append(el("div", "explorer-row dim", "empty"));
    return wrap;
  }

  private renderExpandableDir(childPath: string, name: string, dim: boolean): HTMLElement {
    const box = el("div", "explorer-subdir");
    const key = `dir:${childPath}`;
    const isOpen = this.state.isOpen(key);
    const r = row(`explorer-row explorer-dir-row${dim ? " dim" : ""}`);
    r.append(el("span", "explorer-caret", isOpen ? "▾" : "▸"), el("span", "", name));
    r.onclick = () => {
      this.state.toggle(key);
      this.rerender();
    };
    box.append(r);
    if (isOpen) box.append(this.renderDirTree(childPath));
    return box;
  }

  private renderSpecialDir(childPath: string, name: string): HTMLElement {
    const box = el("div", "explorer-subdir");
    const key = `dir:${childPath}`;
    const isOpen = this.state.isOpen(key);
    const r = row("explorer-row explorer-dir-row explorer-special-dir");
    const count = this.state.dirCache.get(childPath)?.length;
    r.append(
      el("span", "explorer-caret", isOpen ? "▾" : "▸"),
      el("span", "", name),
      el("span", "chip dim", count === undefined ? "…" : String(count)),
    );
    r.onclick = () => {
      this.state.toggle(key);
      if (this.state.shouldFetch(childPath)) this.loadDir(childPath);
      this.rerender();
    };
    box.append(r);
    // Prime the count badge even before the user expands, so it reads
    // "node_modules (128)" rather than a bare caret — one shallow listing,
    // not a recursive scan.
    if (this.state.shouldFetch(childPath)) this.loadDir(childPath);
    if (isOpen) box.append(this.renderDirTree(childPath));
    return box;
  }

  private loadDir(path: string): void {
    this.state.loading.add(path);
    invoke<DirEntry[]>("list_dir", { path })
      .then((entries) => {
        this.state.dirCache.set(path, entries);
        this.state.loading.delete(path);
        this.rerender();
      })
      .catch((err: unknown) => {
        this.state.dirErrors.set(path, String(err));
        this.state.loading.delete(path);
        this.rerender();
      });
  }
}
