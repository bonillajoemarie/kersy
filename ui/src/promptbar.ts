import { invoke } from "@tauri-apps/api/core";
import { displayProject } from "./names";
import type { Store } from "./store";

const NO_CLI = "Claude Code CLI not found on PATH";
const NO_PROJECTS = "No projects found — open a project with Claude Code first";
const NO_PROMPT = "Enter a prompt to run";

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

    const noCli = this.cliAvailable === false;
    const noProjects = projectDirs.length === 0;
    const noPrompt = this.input.value.trim().length === 0;

    this.select.disabled = noCli || noProjects;
    this.select.title = noCli ? NO_CLI : noProjects ? NO_PROJECTS : "";
    this.input.disabled = noCli || noProjects;
    this.input.title = noCli ? NO_CLI : noProjects ? NO_PROJECTS : "";

    this.button.disabled = noCli || noProjects || noPrompt;
    this.button.title = noCli ? NO_CLI : noProjects ? NO_PROJECTS : noPrompt ? NO_PROMPT : "";
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
