import { invoke } from "@tauri-apps/api/core";
import { displayProject } from "./names";
import type { Store } from "./store";

const NO_CLI = "Claude Code CLI not found on PATH";
const NO_PROJECTS = "No projects found — open a project with Claude Code first";
const NO_PROMPT = "Enter a prompt to run";

/**
 * Pure precedence rule for the prompt bar's disabled state: no CLI beats no
 * projects beats an empty prompt. Returns the explanatory string to show as
 * a `title` (matching the perpetual-new-hire "disabled things explain
 * themselves" rule), or `null` when nothing should be disabled.
 *
 * `cliAvailable` is `null` while the one-time `cli_available` probe is still
 * in flight — treated the same as "available" (not disabled for that reason
 * yet) until the probe resolves, matching the constructor's initial state.
 */
export function disabledReason(cliAvailable: boolean | null, projectCount: number, promptText: string): string | null {
  if (cliAvailable === false) return NO_CLI;
  if (projectCount === 0) return NO_PROJECTS;
  if (promptText.trim().length === 0) return NO_PROMPT;
  return null;
}

/**
 * Thin prompt bar: project picker + single-line input + Run, launching the
 * real `claude` CLI headless via `run_prompt`. No chat UI here — the new
 * session shows up on the map through the existing watcher.
 */
export class PromptBar {
  private form: HTMLFormElement;
  private select: HTMLSelectElement;
  private input: HTMLInputElement;
  private button: HTMLButtonElement;
  private setStatus: (text: string, isError?: boolean) => void;

  // null until the one-time `cli_available` probe resolves; treated as
  // "not available" for disabling purposes until then.
  private cliAvailable: boolean | null = null;
  private lastStore: Store | null = null;

  constructor(container: HTMLFormElement, setStatus: (text: string, isError?: boolean) => void) {
    this.form = container;
    this.setStatus = setStatus;

    this.select = document.createElement("select");
    this.select.className = "input";
    this.input = document.createElement("input");
    this.input.className = "input";
    this.input.type = "text";
    this.input.placeholder = "Ask Claude to do something in this project…";
    this.button = document.createElement("button");
    this.button.className = "btn primary";
    this.button.type = "submit";
    this.button.textContent = "Run";

    this.form.replaceChildren(this.select, this.input, this.button);
    this.form.onsubmit = (e) => { e.preventDefault(); void this.submit(); };
    this.input.oninput = () => this.refresh();

    void invoke<boolean>("cli_available").then((v) => {
      this.cliAvailable = v;
      this.refresh();
    }).catch(() => {
      this.cliAvailable = false;
      this.refresh();
    });
  }

  refresh(store?: Store): void {
    if (store) this.lastStore = store;
    const projectDirs = (this.lastStore?.discovery?.projectDirs ?? []).filter((p) => p.exists);

    const prevValue = this.select.value;
    this.select.replaceChildren();
    for (const pd of projectDirs) {
      const opt = document.createElement("option");
      opt.value = pd.path;
      opt.textContent = displayProject(pd.slug, this.lastStore?.discovery?.projectDirs);
      opt.title = pd.path;
      this.select.append(opt);
    }
    if (projectDirs.some((p) => p.path === prevValue)) this.select.value = prevValue;

    // The select/input only ever need to be disabled for the CLI/no-projects
    // reasons (typing into them is meaningless either way); a bare
    // "prompt-non-empty" check keeps disabledReason from also gating them on
    // NO_PROMPT, so the precedence check below covers just those two.
    const structuralReason = disabledReason(this.cliAvailable, projectDirs.length, "x");
    this.select.disabled = structuralReason !== null;
    this.select.title = structuralReason ?? "";
    this.input.disabled = structuralReason !== null;
    this.input.title = structuralReason ?? "";

    const reason = disabledReason(this.cliAvailable, projectDirs.length, this.input.value);
    this.button.disabled = reason !== null;
    this.button.title = reason ?? "";
  }

  private async submit(): Promise<void> {
    const projectPath = this.select.value;
    const prompt = this.input.value.trim();
    if (!projectPath || !prompt || this.cliAvailable === false) return;
    try {
      await invoke("run_prompt", { projectPath, prompt });
      this.input.value = "";
      this.refresh();
      this.setStatus("Launched — session will appear on the map");
    } catch (err) {
      this.setStatus(`⚠ ${String(err)}`, true);
    }
  }
}
