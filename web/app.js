// trellis editor: canvas drawing, tools, layers, properties, presence.
import { Doc, ROOT } from "/src/crdt.js";
import { Sync } from "/src/sync.js";

const $ = (s) => document.querySelector(s);
const replica = (() => {
  try {
    let r = sessionStorage.getItem("trellis-replica");
    if (!r) {
      r = Math.random().toString(36).slice(2, 8);
      sessionStorage.setItem("trellis-replica", r);
    }
    return r;
  } catch {
    return Math.random().toString(36).slice(2, 8);
  }
})();
$("#name").value = `user-${replica.slice(0, 3)}`;

const doc = new Doc(replica);
const cursors = new Map();
const sync = new Sync(doc, `ws://${location.host}/ws`, {
  onStatus: (s) => { $("#status").textContent = `${s} as ${replica}, ${doc.log.length} ops`; },
  onCursor: (c) => { cursors.set(c.replica, c); redraw(); },
  onLeave: (r) => { cursors.delete(r); redraw(); },
});

const canvas = $("#canvas");
const g = canvas.getContext("2d");
let tool = "select";
let selected = null;
let drag = null;  // {kind:"create"|"move", ...}
let scheduled = false;

doc.listeners.add(() => redraw());

function redraw() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    draw();
    drawLayers();
    drawProps();
    $("#status").textContent = `${sync.state} as ${replica}, ${doc.log.length} ops`;
  });
}

// ------------------------------------------------------------ geometry

const num = (id, k, d = 0) => Number(doc.get(id, k, d));

// Absolute top-left of a node: its x/y are relative to the parent frame.
function origin(id) {
  let x = 0, y = 0;
  for (let p = doc.parentOf(id), guard = 0; p && p !== ROOT && guard < 100; p = doc.parentOf(p), guard++) {
    x += num(p, "x");
    y += num(p, "y");
  }
  return [x, y];
}

function box(id) {
  const [ox, oy] = origin(id);
  return { x: ox + num(id, "x"), y: oy + num(id, "y"), w: num(id, "w", 100), h: num(id, "h", 60) };
}

// Topmost node under a point (children after parents, later siblings on top).
function hit(px, py, filter = () => true) {
  const order = doc.visibleTree().map((e) => e.id);
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    if (!filter(id)) continue;
    const b = box(id);
    if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return id;
  }
  return null;
}

// ------------------------------------------------------------ drawing

function resize() {
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.floor(r.width * devicePixelRatio);
  canvas.height = Math.floor(r.height * devicePixelRatio);
  redraw();
}
addEventListener("resize", resize);

function drawNode(id) {
  const kind = doc.nodes.get(id).kind;
  const b = box(id);
  const fill = doc.get(id, "fill", "#4f8cff");
  g.save();
  if (kind === "frame") {
    g.fillStyle = doc.get(id, "fill", "#ffffff");
    g.strokeStyle = "#9aa0a8";
    g.fillRect(b.x, b.y, b.w, b.h);
    g.strokeRect(b.x + 0.5, b.y + 0.5, b.w, b.h);
    g.fillStyle = "#6c7077";
    g.font = "11px system-ui";
    g.fillText(doc.get(id, "name", "Frame"), b.x, b.y - 4);
    g.beginPath();
    g.rect(b.x, b.y, b.w, b.h);
    g.clip();
  } else if (kind === "rect") {
    g.fillStyle = fill;
    g.fillRect(b.x, b.y, b.w, b.h);
  } else if (kind === "ellipse") {
    g.fillStyle = fill;
    g.beginPath();
    g.ellipse(b.x + b.w / 2, b.y + b.h / 2, Math.abs(b.w / 2), Math.abs(b.h / 2), 0, 0, 2 * Math.PI);
    g.fill();
  } else if (kind === "text") {
    g.fillStyle = fill;
    g.font = `${num(id, "size", 16)}px system-ui`;
    g.textBaseline = "top";
    g.fillText(doc.get(id, "text", "Text"), b.x, b.y);
  }
  for (const c of doc.children(id)) drawNode(c);
  g.restore();
}

function draw() {
  g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  g.clearRect(0, 0, canvas.width, canvas.height);
  for (const id of doc.children(ROOT)) drawNode(id);
  if (selected && doc.live(selected)) {
    const b = drag && drag.kind === "move" ? { ...box(selected), x: drag.nx, y: drag.ny } : box(selected);
    g.strokeStyle = "#2f6fed";
    g.lineWidth = 1.5;
    g.strokeRect(b.x, b.y, b.w, b.h);
  }
  if (drag && drag.kind === "create") {
    g.strokeStyle = "#2f6fed";
    g.setLineDash([4, 3]);
    g.strokeRect(drag.x0, drag.y0, drag.x1 - drag.x0, drag.y1 - drag.y0);
    g.setLineDash([]);
  }
  for (const c of cursors.values()) {
    g.fillStyle = `hsl(${[...c.replica].reduce((a, ch) => a + ch.charCodeAt(0) * 37, 0) % 360} 70% 50%)`;
    g.beginPath();
    g.moveTo(c.x, c.y);
    g.lineTo(c.x + 10, c.y + 12);
    g.lineTo(c.x + 3, c.y + 12);
    g.closePath();
    g.fill();
    g.font = "11px system-ui";
    g.fillText(c.name || c.replica, c.x + 12, c.y + 22);
  }
}

function drawLayers() {
  const el = $("#layers");
  el.innerHTML = "";
  for (const { id, depth } of doc.visibleTree()) {
    const d = document.createElement("div");
    d.className = "layer" + (id === selected ? " sel" : "");
    d.style.paddingLeft = `${8 + depth * 14}px`;
    const n = doc.nodes.get(id);
    d.textContent = `${n.kind} ${doc.get(id, "name", "") || doc.get(id, "text", "") || id.split("-").pop()}`;
    d.onclick = () => { selected = id; redraw(); };
    el.appendChild(d);
  }
}

function drawProps() {
  const el = $("#props");
  if (!selected || !doc.live(selected)) {
    el.innerHTML = `<div class="dim">Nothing selected</div>`;
    return;
  }
  const kind = doc.nodes.get(selected).kind;
  const keys = ["x", "y", "w", "h", "fill"].concat(kind === "text" ? ["text", "size"] : kind === "frame" ? ["name"] : []);
  if (el.dataset.for === selected && el.contains(document.activeElement)) return;  // don't clobber typing
  el.dataset.for = selected;
  el.innerHTML = `<div class="dim">${kind} ${selected}</div>`;
  for (const k of keys) {
    const row = document.createElement("label");
    row.className = "prop";
    row.textContent = k;
    const input = document.createElement("input");
    input.value = doc.get(selected, k, "");
    input.onchange = () => {
      const v = ["x", "y", "w", "h", "size"].includes(k) ? Number(input.value) : input.value;
      sync.local(doc.set(selected, k, v));
    };
    row.appendChild(input);
    el.appendChild(row);
  }
}

// ------------------------------------------------------------ input

for (const b of document.querySelectorAll("#tools button")) {
  b.onclick = () => {
    tool = b.dataset.tool;
    document.querySelectorAll("#tools button").forEach((x) => x.classList.toggle("on", x === b));
  };
}

function point(ev) {
  const r = canvas.getBoundingClientRect();
  return [ev.clientX - r.left, ev.clientY - r.top];
}

canvas.addEventListener("pointerdown", (ev) => {
  const [x, y] = point(ev);
  canvas.setPointerCapture(ev.pointerId);
  if (tool === "select") {
    selected = hit(x, y);
    if (selected) {
      const b = box(selected);
      drag = { kind: "move", dx: x - b.x, dy: y - b.y, nx: b.x, ny: b.y };
    }
  } else {
    drag = { kind: "create", x0: x, y0: y, x1: x, y1: y };
  }
  redraw();
});

let lastCursor = 0;
canvas.addEventListener("pointermove", (ev) => {
  const [x, y] = point(ev);
  const now = performance.now();
  if (now - lastCursor > 50) {
    lastCursor = now;
    sync.cursor(x, y, $("#name").value);
  }
  if (!drag) return;
  if (drag.kind === "create") {
    drag.x1 = x;
    drag.y1 = y;
  } else {
    drag.nx = x - drag.dx;
    drag.ny = y - drag.dy;
  }
  redraw();
});

canvas.addEventListener("pointerup", (ev) => {
  const [x, y] = point(ev);
  if (drag && drag.kind === "create") {
    const ax = Math.min(drag.x0, x), ay = Math.min(drag.y0, y);
    const w = Math.max(20, Math.abs(x - drag.x0)), h = Math.max(20, Math.abs(y - drag.y0));
    // New nodes go into the frame under the starting point.
    const parent = hit(drag.x0, drag.y0, (id) => doc.nodes.get(id).kind === "frame") || ROOT;
    const [ox, oy] = parent === ROOT ? [0, 0] : [box(parent).x, box(parent).y];
    const props = { x: ax - ox, y: ay - oy, w, h, fill: tool === "frame" ? "#ffffff" : $("#fill").value };
    if (tool === "text") Object.assign(props, { text: "Text", size: 16 });
    if (tool === "frame") props.name = `Frame ${doc.children(ROOT).length + 1}`;
    const op = doc.create(tool, parent, props);
    sync.local(op);
    selected = op.id;
  } else if (drag && drag.kind === "move" && selected) {
    // Drop target: the topmost frame under the pointer that isn't the node or inside it.
    const target =
      hit(x, y, (id) => id !== selected && doc.nodes.get(id).kind === "frame" && !doc.isAncestor(selected, id)) || ROOT;
    const [ox, oy] = target === ROOT ? [0, 0] : [box(target).x, box(target).y];
    if (target !== doc.parentOf(selected)) sync.local(doc.move(selected, target));
    sync.local(doc.set(selected, "x", Math.round(drag.nx - ox)));
    sync.local(doc.set(selected, "y", Math.round(drag.ny - oy)));
  }
  drag = null;
  redraw();
});

addEventListener("keydown", (ev) => {
  if (ev.target.tagName === "INPUT") return;
  if ((ev.key === "Delete" || ev.key === "Backspace") && selected) {
    sync.local(doc.remove(selected));
    selected = null;
  }
  const keys = { v: "select", f: "frame", r: "rect", o: "ellipse", t: "text" };
  if (keys[ev.key]) document.querySelector(`#tools [data-tool=${keys[ev.key]}]`).click();
});

$("#offline").onclick = () => {
  const off = sync.state !== "offline";
  sync.setOffline(off);
  $("#offline").textContent = off ? "Go online" : "Go offline";
};

resize();
