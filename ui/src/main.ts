import { Channel, invoke } from "@tauri-apps/api/core";
import { Explorer } from "./explorer";
import { renderDrillin, renderTasks } from "./panels";
import { PromptBar } from "./promptbar";
import { createRenderer, STATUS_COLORS, type DrawEdge, type DrawNode, type Renderer } from "./render/renderer";
import { Sim } from "./sim";
import { Store, type MapEventMsg } from "./store";
import { displayAgent } from "./names";
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
const camTarget = { x: 0, y: 0 };
let projectFilter = "";
let liveOnly = false;
let paused = false;
let selected: string | null = null;

let hovered: { id: string; screenX: number; screenY: number } | null = null;

const spawnTime = new Map<string, number>();

function setStatus(text: string, isError = false): void {
  const bar = document.querySelector<HTMLElement>("#statusbar")!;
  bar.textContent = text;
  bar.classList.toggle("status-error", isError);
}

const explorer = new Explorer(document.querySelector("#explorer")!, (id) => focusSession(id));
const promptBar = new PromptBar(document.querySelector<HTMLFormElement>("#promptbar")!, setStatus);

function focusSession(id: string): void {
  const pos = sim.positions().get(id);
  if (pos) { camTarget.x = pos.x; camTarget.y = pos.y; }
  selected = id;
  void openDrillin(id);
  wake();
}

const visible = () => store.nodes().filter((n) =>
  (!projectFilter || n.project === projectFilter) && (!liveOnly || statusOf(n) !== "stale"));

const sim = new Sim(() => {});
let frame = 0;
let running = false;
let repaintTimer: ReturnType<typeof setTimeout> | null = null;
function armRepaintTimer() {
  if (repaintTimer !== null) { clearTimeout(repaintTimer); repaintTimer = null; }
  const now = Date.now();
  let earliest = Infinity;
  for (const n of visible()) {
    if (n.stub || !n.lastActivityMs) continue;
    const age = now - n.lastActivityMs;
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

  // Camera lerp toward target (only runs while loop is alive, so doesn't prevent sleep)
  const dx = camTarget.x - cam.x;
  const dy = camTarget.y - cam.y;
  if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
    cam.x += dx * 0.2;
    cam.y += dy * 0.2;
  } else {
    cam.x = camTarget.x;
    cam.y = camTarget.y;
  }

  draw();
  if ((!paused && !sim.settled()) || visible().some((n) => statusOf(n) === "active")) requestAnimationFrame(loop);
  else { running = false; armRepaintTimer(); }
}
function wake() {
  if (repaintTimer !== null) { clearTimeout(repaintTimer); repaintTimer = null; }
  if (!running) { running = true; requestAnimationFrame(loop); }
}

// --- Glow sprite (offscreen, pre-rendered once) ---
const GLOW_SIZE = 256;
const glowCanvas = document.createElement("canvas");
glowCanvas.width = GLOW_SIZE;
glowCanvas.height = GLOW_SIZE;
const gctx = glowCanvas.getContext("2d")!;
const glowGrad = gctx.createRadialGradient(GLOW_SIZE / 2, GLOW_SIZE / 2, 0, GLOW_SIZE / 2, GLOW_SIZE / 2, GLOW_SIZE / 2);
glowGrad.addColorStop(0, "rgba(255,255,255,0)");
glowGrad.addColorStop(0.45, "rgba(255,255,255,0.35)");
glowGrad.addColorStop(1, "rgba(255,255,255,0)");
gctx.fillStyle = glowGrad;
gctx.fillRect(0, 0, GLOW_SIZE, GLOW_SIZE);

function draw() {
  if (!renderer) return;
  const pos = sim.positions();
  const now = Date.now();
  const nodes: DrawNode[] = [];
  const labels: Array<{ x: number; y: number; text: string; dim: boolean; active: boolean; n: { id: string; agentType: string; currentActivity: string; contextTokens: number } }> = [];
  for (const n of visible()) {
    const p = pos.get(n.id); if (!p) continue;
    if (!spawnTime.has(n.id)) spawnTime.set(n.id, now);
    const isSession = !n.id.includes("/");
    const st = statusOf(n);
    const pulse = st === "active" ? Math.pow(Math.sin(frame / 12), 2) : 0;
    const baseRadius = isSession ? 14 : 8;
    const spawnEase = Math.min(1, (now - (spawnTime.get(n.id) ?? 0)) / 300);
    nodes.push({ x: p.x, y: p.y, radius: baseRadius * spawnEase, color: STATUS_COLORS[st], pulse });
    labels.push({ x: p.x, y: p.y, text: st === "active" ? n.currentActivity : (n.description || displayAgent(n)), dim: st === "stale", active: st === "active", n });
  }
  const edges: DrawEdge[] = store.edges().flatMap((e) => {
    const a = pos.get(e.from), b = pos.get(e.to);
    return a && b ? [{ x1: a.x, y1: a.y, x2: b.x, y2: b.y }] : [];
  });
  renderer.draw(nodes, edges, cam);

  // --- Overlay: glow halos for active nodes ---
  octx.clearRect(0, 0, overlay.width, overlay.height);
  for (const l of labels) {
    if (l.active) {
      const sx = (l.x - cam.x) * cam.zoom + overlay.width / 2;
      const sy = (l.y - cam.y) * cam.zoom + overlay.height / 2;
      const glowRadius = 14 * 3 * cam.zoom;
      octx.globalAlpha = 0.35;
      octx.drawImage(glowCanvas, sx - glowRadius, sy - glowRadius, glowRadius * 2, glowRadius * 2);
      octx.globalAlpha = 1;
    }
  }

  // --- Overlay: label pills + text ---
  octx.font = "16px 'IBM Plex Sans', sans-serif";
  for (const l of labels) {
    const sx = (l.x - cam.x) * cam.zoom + overlay.width / 2 + 16;
    const sy = (l.y - cam.y) * cam.zoom + overlay.height / 2 + 6;
    const text = l.text.slice(0, 40);
    const showPill = cam.zoom >= 0.5 || l.active;
    if (showPill) {
      const measured = octx.measureText(text);
      const padX = 4, padY = 4;
      const rx = sx - padX;
      const ry = sy - 14;
      const rw = measured.width + padX * 2;
      const rh = 18 + padY * 2;
      const r = 999;
      octx.fillStyle = "rgba(36,36,36,0.85)";
      octx.beginPath();
      octx.moveTo(rx + r, ry);
      octx.lineTo(rx + rw - r, ry);
      octx.quadraticCurveTo(rx + rw, ry, rx + rw, ry + r);
      octx.lineTo(rx + rw, ry + rh - r);
      octx.quadraticCurveTo(rx + rw, ry + rh, rx + rw - r, ry + rh);
      octx.lineTo(rx + r, ry + rh);
      octx.quadraticCurveTo(rx, ry + rh, rx, ry + rh - r);
      octx.lineTo(rx, ry + r);
      octx.quadraticCurveTo(rx, ry, rx + r, ry);
      octx.closePath();
      octx.fill();
    }
    octx.fillStyle = l.dim ? "#808080" : "#A9B7C6";
    octx.fillText(text, sx, sy);
  }

  // --- Overlay: hover tooltip chip ---
  if (hovered) {
    const node = store.agents.get(hovered.id);
    if (node) {
      const st = statusOf(node);
      const text = `${node.agentType} · ${st} · ${node.currentActivity} · ${(node.contextTokens / 1000).toFixed(1)}k ctx`;
      octx.font = "16px 'IBM Plex Sans', sans-serif";
      const measured = octx.measureText(text);
      const padX = 8, padY = 4;
      const chipW = measured.width + padX * 2;
      const chipH = 16 + padY * 2;
      let cx = hovered.screenX + 12;
      let cy = hovered.screenY + 12;
      if (cx + chipW > overlay.width) cx = hovered.screenX - chipW - 12;
      if (cy + chipH > overlay.height) cy = hovered.screenY - chipH - 12;
      octx.fillStyle = "rgba(36,36,36,0.92)";
      octx.strokeStyle = "#323232";
      octx.lineWidth = 1;
      octx.beginPath();
      octx.roundRect(cx, cy, chipW, chipH, 4);
      octx.fill();
      octx.stroke();
      octx.fillStyle = "#A9B7C6";
      octx.fillText(text, cx + padX, cy + padY + 16);
    }
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
  if (selected && store.agents.has(selected)) void openDrillin(selected);
};

let drillinGen = 0;
async function openDrillin(id: string) {
  const a = store.agents.get(id); if (!a) return;
  const gen = ++drillinGen;
  await renderDrillin(a, document.querySelector("#drillin")!, () => gen === drillinGen);
}

function hitTestNode(wx: number, wy: number): { id: string; radius: number } | null {
  const pos = sim.positions();
  let best: { id: string; radius: number } | null = null;
  let bestDist = Infinity;
  for (const n of visible()) {
    const p = pos.get(n.id); if (!p) continue;
    const isSession = !n.id.includes("/");
    const baseR = isSession ? 14 : 8;
    const dist = Math.hypot(p.x - wx, p.y - wy);
    if (dist < baseR + 6 && dist < bestDist) {
      bestDist = dist;
      best = { id: n.id, radius: baseR };
    }
  }
  return best;
}

graphCanvas.parentElement!.addEventListener("click", (ev) => {
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

graphCanvas.parentElement!.addEventListener("pointermove", (ev) => {
  if (drag) { hovered = null; return; }
  const wx = (ev.offsetX - overlay.width / 2) / cam.zoom + cam.x;
  const wy = (ev.offsetY - overlay.height / 2) / cam.zoom + cam.y;
  const hit = hitTestNode(wx, wy);
  if (hit) {
    hovered = { id: hit.id, screenX: ev.offsetX, screenY: ev.offsetY };
  } else {
    hovered = null;
  }
  wake();
});

graphCanvas.parentElement!.addEventListener("pointerleave", () => { hovered = null; wake(); });
graphCanvas.parentElement!.addEventListener("mousedown", () => { hovered = null; });

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
  const dx = (e.clientX - drag.x) / cam.zoom;
  const dy = (e.clientY - drag.y) / cam.zoom;
  cam.x -= dx; cam.y -= dy;
  camTarget.x = cam.x; camTarget.y = cam.y;
  drag = { x: e.clientX, y: e.clientY }; wake();
});

function refreshTopbar() {
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
    if (!paused) wake();
  };
  pauseLabel.append(pauseInput, " pause layout");

  const legendActive = document.createElement("span");
  legendActive.className = "chip active";
  legendActive.textContent = "active";
  const legendIdle = document.createElement("span");
  legendIdle.className = "chip idle";
  legendIdle.textContent = "idle";
  const legendStale = document.createElement("span");
  legendStale.className = "chip stale";
  legendStale.textContent = "stale";

  const disc = document.createElement("span");
  disc.id = "disc";
  disc.textContent = store.discovery
    ? `${store.discovery.roots.join(", ")} — ${store.discovery.projects} projects, ${store.discovery.sessions} sessions`
    : "discovering…";

  bar.replaceChildren(projSelect, liveLabel, pauseLabel, legendActive, legendIdle, legendStale, disc);
}

async function updateRss() {
  const kb = await invoke<number>("rust_rss_kb");
  setStatus(`Kersy — rust rss ${(kb / 1024).toFixed(1)} MB`);
  setTimeout(updateRss, 10_000);
}

const ch = new Channel<MapEventMsg>();
ch.onmessage = (msg) => store.apply(msg);
void invoke("subscribe", { onEvent: ch });
resize();
void updateRss();
