import { Channel, invoke } from "@tauri-apps/api/core";
import { renderDrillin, renderTasks } from "./panels";
import { createRenderer, STATUS_COLORS, type DrawEdge, type DrawNode, type Renderer } from "./render/renderer";
import { Sim } from "./sim";
import { Store, type MapEventMsg } from "./store";

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

const visible = () => store.nodes().filter((n) =>
  (!projectFilter || n.project === projectFilter) && (!liveOnly || n.status !== "stale"));

const sim = new Sim(() => {});
let frame = 0;
// `running` must be declared before `loop` references it (the brief's snippet referenced
// `running` before its declaration point); hoisting `let` would still throw a TDZ error at
// runtime, so the declaration is moved above the function that uses it.
let running = false;
function loop() {
  frame++;
  if (!paused && !sim.settled()) sim.tickOnce();
  draw();
  // keep animating while anything is active (pulse), else stop — 0%-idle rule
  if (!sim.settled() || visible().some((n) => n.status === "active")) requestAnimationFrame(loop);
  else running = false;
}
function wake() { if (!running) { running = true; requestAnimationFrame(loop); } }

function draw() {
  if (!renderer) return;
  const pos = sim.positions();
  const nodes: DrawNode[] = [];
  const labels: Array<{ x: number; y: number; text: string; dim: boolean }> = [];
  for (const n of visible()) {
    const p = pos.get(n.id); if (!p) continue;
    const isSession = !n.id.includes("/");
    const pulse = n.status === "active" ? (Math.sin(frame / 12) + 1) / 2 : 0;
    nodes.push({ x: p.x, y: p.y, radius: isSession ? 14 : 8, color: STATUS_COLORS[n.status], pulse });
    labels.push({ x: p.x, y: p.y, text: n.status === "active" ? n.currentActivity : (n.description || n.id), dim: n.status === "stale" });
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
  refreshTopbar(); renderEmptyState(); wake();
};

async function openDrillin(id: string) {
  const a = store.agents.get(id); if (!a) return;
  await renderDrillin(a, document.querySelector("#drillin")!);
}

graphCanvas.parentElement!.addEventListener("click", (ev) => {
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
graphCanvas.parentElement!.addEventListener("mousedown", (e) => { drag = { x: e.clientX, y: e.clientY }; });
window.addEventListener("mouseup", () => { drag = null; });
window.addEventListener("mousemove", (e) => {
  if (!drag) return;
  cam.x -= (e.clientX - drag.x) / cam.zoom; cam.y -= (e.clientY - drag.y) / cam.zoom;
  drag = { x: e.clientX, y: e.clientY }; wake();
});

function refreshTopbar() {
  const bar = document.querySelector("#topbar")!;
  const projects = [...new Set(store.nodes().map((n) => n.project))].sort();
  bar.innerHTML = `<select id="proj"><option value="">all projects</option>${projects.map((p) => `<option ${p === projectFilter ? "selected" : ""}>${p}</option>`).join("")}</select>
    <label><input type="checkbox" id="live" ${liveOnly ? "checked" : ""}/> live only</label>
    <label><input type="checkbox" id="pause" ${paused ? "checked" : ""}/> pause layout</label>
    <span id="disc">${store.discovery ? `${store.discovery.roots.join(", ")} — ${store.discovery.projects} projects, ${store.discovery.sessions} sessions` : "discovering…"}</span>`;
  bar.querySelector<HTMLSelectElement>("#proj")!.onchange = (e) => { projectFilter = (e.target as HTMLSelectElement).value; store.onchange?.(); };
  bar.querySelector<HTMLInputElement>("#live")!.onchange = (e) => { liveOnly = (e.target as HTMLInputElement).checked; store.onchange?.(); };
  bar.querySelector<HTMLInputElement>("#pause")!.onchange = (e) => { paused = (e.target as HTMLInputElement).checked; };
}

async function updateRss() {
  const kb = await invoke<number>("rust_rss_kb");
  document.querySelector("#statusbar")!.textContent = `Kersy — rust rss ${(kb / 1024).toFixed(1)} MB`;
  setTimeout(updateRss, 10_000);   // permitted timer: 1 cheap IPC / 10 s for the RSS budget display
}

const ch = new Channel<MapEventMsg>();
ch.onmessage = (msg) => store.apply(msg);
void invoke("subscribe", { onEvent: ch });
resize();
void updateRss();
