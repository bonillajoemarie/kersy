import { Channel, invoke } from "@tauri-apps/api/core";
import { Explorer } from "./explorer";
import { renderDrillin, renderTasks } from "./panels";
import { PromptBar } from "./promptbar";
import { createRenderer, STATUS_COLORS, type DrawEdge, type DrawNode, type Renderer } from "./render/renderer";
import { Sim } from "./sim";
import { Store, type MapEventMsg } from "./store";
import { ACTIVE_MS, IDLE_MS, statusOf } from "./status";

const store = new Store();
const graphCanvas = document.querySelector<HTMLCanvasElement>("#graph")!;
const overlay = document.querySelector<HTMLCanvasElement>("#overlay")!;
const octx = overlay.getContext("2d")!;

let renderer: Renderer | null = null;
try {
  renderer = createRenderer(graphCanvas);
} catch (err) {
  document.querySelector("#statusbar")!.textContent = `Kersy — renderer error: ${(err as Error).message}`;
}

const cam = { x: 0, y: 0, zoom: 1 };
let projectFilter = "";
let liveOnly = false;
let paused = false;
let selected: string | null = null;

function setStatus(text: string, isError = false): void {
  const bar = document.querySelector<HTMLElement>("#statusbar")!;
  bar.textContent = text;
  bar.classList.toggle("status-error", isError);
}

const explorer = new Explorer(document.querySelector("#explorer")!, (id) => focusSession(id));
const promptBar = new PromptBar(document.querySelector<HTMLFormElement>("#promptbar")!, setStatus);

// Direct camera snap for now (Task 5 brings the lerp-toward-target mechanism that would smooth
// this into a glide); selecting + opening the drill-in is the same path the map's own click
// handler uses below.
function focusSession(id: string): void {
  const pos = sim.positions().get(id);
  if (pos) { cam.x = pos.x; cam.y = pos.y; }
  selected = id;
  void openDrillin(id);
  wake();
}

const visible = () => store.nodes().filter((n) =>
  (!projectFilter || n.project === projectFilter) && (!liveOnly || statusOf(n) !== "stale"));

const sim = new Sim(() => {});
let frame = 0;
// `running` must be declared before `loop` references it (the brief's snippet referenced
// `running` before its declaration point); hoisting `let` would still throw a TDZ error at
// runtime, so the declaration is moved above the function that uses it.
let running = false;
// The single armed one-shot repaint timer (Finding 1b): when the rAF loop stops with some node
// still active/idle, a future status transition is coming (active -> idle -> stale) even though
// nothing else changes. Rather than a polling interval, we compute the earliest such transition
// and arm exactly one setTimeout to wake() at that instant. Re-armed only when the loop stops
// again; cleared/re-armed inside wake() so back-to-back wakes never stack duplicate timers.
let repaintTimer: ReturnType<typeof setTimeout> | null = null;
function armRepaintTimer() {
  if (repaintTimer !== null) { clearTimeout(repaintTimer); repaintTimer = null; }
  const now = Date.now();
  let earliest = Infinity;
  for (const n of visible()) {
    if (n.stub || !n.lastActivityMs) continue;
    const age = now - n.lastActivityMs;
    // next threshold this node will cross, if any
    let next = Infinity;
    if (age < ACTIVE_MS) next = ACTIVE_MS - age;
    else if (age < IDLE_MS) next = IDLE_MS - age;
    if (next < earliest) earliest = next;
  }
  if (earliest < Infinity) {
    repaintTimer = setTimeout(() => { repaintTimer = null; wake(); }, earliest + 50);
  }
}
function loop() {
  frame++;
  if (!paused && !sim.settled()) sim.tickOnce();
  draw();
  // keep animating while (unpaused and unsettled) or anything is pulsing, else stop — 0%-idle
  // rule. `paused` must gate the continue condition too, not just tickOnce(): otherwise pausing
  // before the sim settles leaves rAF spinning forever on frames that do nothing but redraw.
  if ((!paused && !sim.settled()) || visible().some((n) => statusOf(n) === "active")) requestAnimationFrame(loop);
  else { running = false; armRepaintTimer(); }
}
function wake() {
  if (repaintTimer !== null) { clearTimeout(repaintTimer); repaintTimer = null; }
  if (!running) { running = true; requestAnimationFrame(loop); }
}

function draw() {
  if (!renderer) return;
  const pos = sim.positions();
  const nodes: DrawNode[] = [];
  const labels: Array<{ x: number; y: number; text: string; dim: boolean }> = [];
  for (const n of visible()) {
    const p = pos.get(n.id); if (!p) continue;
    const isSession = !n.id.includes("/");
    const st = statusOf(n);
    const pulse = st === "active" ? (Math.sin(frame / 12) + 1) / 2 : 0;
    nodes.push({ x: p.x, y: p.y, radius: isSession ? 14 : 8, color: STATUS_COLORS[st], pulse });
    labels.push({ x: p.x, y: p.y, text: st === "active" ? n.currentActivity : (n.description || n.id), dim: st === "stale" });
  }
  const edges: DrawEdge[] = store.edges().flatMap((e) => {
    const a = pos.get(e.from), b = pos.get(e.to);
    return a && b ? [{ x1: a.x, y1: a.y, x2: b.x, y2: b.y }] : [];
  });
  renderer.draw(nodes, edges, cam);
  octx.clearRect(0, 0, overlay.width, overlay.height);
  octx.font = "11px monospace";
  for (const l of labels) {
    octx.fillStyle = l.dim ? "#808080" : "#A9B7C6";
    octx.fillText(l.text.slice(0, 40), (l.x - cam.x) * cam.zoom + overlay.width / 2 + 16, (l.y - cam.y) * cam.zoom + overlay.height / 2 + 4);
  }
}

function resize() {
  const { clientWidth: w, clientHeight: h } = graphCanvas.parentElement!;
  renderer?.resize(w, h); overlay.width = w; overlay.height = h; wake();
}
window.addEventListener("resize", resize);

function renderEmptyState(): void {
  const stage = document.querySelector<HTMLElement>("#stage")!;
  let panel = stage.querySelector<HTMLElement>("#empty-state");
  const shouldShow = !!store.discovery && store.discovery.sessions === 0;
  if (!shouldShow) {
    panel?.remove();
    return;
  }
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "empty-state";
    stage.append(panel);
  }
  const roots = store.discovery!.roots;
  panel.replaceChildren();
  const title = document.createElement("div");
  title.className = "empty-state-title";
  title.textContent = "No Claude Code data found";
  panel.append(title);
  const list = document.createElement("div");
  list.className = "empty-state-roots";
  for (const r of roots) {
    const row = document.createElement("div");
    row.className = "cmd";
    row.textContent = r;
    list.append(row);
  }
  panel.append(list);
}

store.onchange = () => {
  const ids = visible().map((n) => n.id);
  sim.sync(ids, store.edges().filter((e) => ids.includes(e.from) && ids.includes(e.to)));
  renderTasks(store, document.querySelector("#tasks")!, (sid) => { selected = sid; openDrillin(sid); });
  explorer.render(store);
  promptBar.refresh(store);
  refreshTopbar(); renderEmptyState(); wake();
  // keep the open drill-in panel live: without this it freezes at whatever it showed at the
  // moment of the click until the user re-clicks the node, even as new events/context/files
  // arrive for the selected agent.
  if (selected && store.agents.has(selected)) void openDrillin(selected);
};

// Generation token guarding against the openDrillin/renderDrillin race: store.onchange now
// re-invokes openDrillin(selected) on every event batch to keep the panel live (see above), so
// a slow earlier call's awaited invoke() can resolve after the user has selected a different
// node — without this, agent A's feed could get appended under agent B's freshly-rendered
// header. Each call captures its own generation number and renderDrillin re-checks it after
// every await, dropping stale post-await DOM writes.
let drillinGen = 0;
async function openDrillin(id: string) {
  const a = store.agents.get(id); if (!a) return;
  const gen = ++drillinGen;
  await renderDrillin(a, document.querySelector("#drillin")!, () => gen === drillinGen);
}

graphCanvas.parentElement!.addEventListener("click", (ev) => {
  // a mousedown→drag(pan)→mouseup sequence still dispatches a click at the release point;
  // without this guard every pan gesture mis-selects a node or clears the drill-in panel.
  if (dragMoved) return;
  const pos = sim.positions();
  const wx = (ev.offsetX - overlay.width / 2) / cam.zoom + cam.x;
  const wy = (ev.offsetY - overlay.height / 2) / cam.zoom + cam.y;
  for (const n of visible()) {
    const p = pos.get(n.id); if (!p) continue;
    if (Math.hypot(p.x - wx, p.y - wy) < 16) { selected = n.id; void openDrillin(n.id); return; }
  }
  document.querySelector<HTMLElement>("#drillin")!.hidden = true; selected = null;
});
graphCanvas.parentElement!.addEventListener("wheel", (ev) => {
  cam.zoom = Math.max(0.2, Math.min(4, cam.zoom * (ev.deltaY < 0 ? 1.1 : 0.9))); wake();
});
let drag: { x: number; y: number } | null = null;
let dragStart: { x: number; y: number } | null = null;
let dragMoved = false;
graphCanvas.parentElement!.addEventListener("mousedown", (e) => {
  drag = { x: e.clientX, y: e.clientY }; dragStart = { x: e.clientX, y: e.clientY }; dragMoved = false;
});
window.addEventListener("mouseup", () => { drag = null; dragStart = null; });
window.addEventListener("mousemove", (e) => {
  if (!drag) return;
  if (dragStart && Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y) > 3) dragMoved = true;
  cam.x -= (e.clientX - drag.x) / cam.zoom; cam.y -= (e.clientY - drag.y) / cam.zoom;
  drag = { x: e.clientX, y: e.clientY }; wake();
});

function refreshTopbar() {
  // Built via createElement/textContent rather than innerHTML string interpolation: project
  // slugs and discovery root paths are attacker/filesystem-controlled strings that could
  // otherwise break out of the markup (CSP blocks script execution, but not structural breakage).
  const bar = document.querySelector("#topbar")!;
  const projects = [...new Set(store.nodes().map((n) => n.project))].sort();

  const projSelect = document.createElement("select");
  projSelect.id = "proj";
  const allOpt = document.createElement("option");
  allOpt.value = ""; allOpt.textContent = "all projects";
  projSelect.append(allOpt);
  for (const p of projects) {
    const opt = document.createElement("option");
    opt.textContent = p; opt.selected = p === projectFilter;
    projSelect.append(opt);
  }
  projSelect.onchange = (e) => { projectFilter = (e.target as HTMLSelectElement).value; store.onchange?.(); };

  const liveLabel = document.createElement("label");
  const liveInput = document.createElement("input");
  liveInput.type = "checkbox"; liveInput.id = "live"; liveInput.checked = liveOnly;
  liveInput.onchange = (e) => { liveOnly = (e.target as HTMLInputElement).checked; store.onchange?.(); };
  liveLabel.append(liveInput, " live only");

  const pauseLabel = document.createElement("label");
  const pauseInput = document.createElement("input");
  pauseInput.type = "checkbox"; pauseInput.id = "pause"; pauseInput.checked = paused;
  pauseInput.onchange = (e) => {
    paused = (e.target as HTMLInputElement).checked;
    if (!paused) wake(); // resume the layout loop immediately on uncheck rather than waiting for the next event
  };
  pauseLabel.append(pauseInput, " pause layout");

  const disc = document.createElement("span");
  disc.id = "disc";
  disc.textContent = store.discovery
    ? `${store.discovery.roots.join(", ")} — ${store.discovery.projects} projects, ${store.discovery.sessions} sessions`
    : "discovering…";

  bar.replaceChildren(projSelect, liveLabel, pauseLabel, disc);
}

async function updateRss() {
  const kb = await invoke<number>("rust_rss_kb");
  setStatus(`Kersy — rust rss ${(kb / 1024).toFixed(1)} MB`);
  setTimeout(updateRss, 10_000);   // permitted timer: 1 cheap IPC / 10 s for the RSS budget display
}

const ch = new Channel<MapEventMsg>();
ch.onmessage = (msg) => store.apply(msg);
void invoke("subscribe", { onEvent: ch });
resize();
void updateRss();
