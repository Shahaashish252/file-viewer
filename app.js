"use strict";

const TYPES = {
  image: ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "avif"],
  video: ["mp4", "webm", "mov", "mkv", "m4v", "ogv"],
  audio: ["mp3", "wav", "ogg", "m4a", "flac", "aac"],
  pdf: ["pdf"],
  text: ["txt", "md", "json", "csv", "log", "js", "ts", "html", "css", "xml", "yml", "yaml", "py"],
};
const typeOf = (name) => {
  const ext = name.split(".").pop().toLowerCase();
  return Object.keys(TYPES).find((t) => TYPES[t].includes(ext)) || "other";
};

const $ = (id) => document.getElementById(id);
const state = { root: null, files: [], shown: [], index: -1, type: "all", tag: null, url: null, sel: new Set(), sort: "name", view: "list", lastClicked: -1, thumbs: new Map() };

// ---- persistence: folder handle in IndexedDB, tags/favorites in localStorage ----
const db = () => new Promise((res, rej) => {
  const r = indexedDB.open("file-viewer", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("kv");
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const kv = async (mode, fn) => {
  const d = await db();
  return new Promise((res, rej) => {
    const req = fn(d.transaction("kv", mode).objectStore("kv"));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
};
let meta = {};
const metaKey = () => "meta:" + (state.root?.name || "");
const loadMeta = () => { try { meta = JSON.parse(localStorage.getItem(metaKey())) || {}; } catch { meta = {}; } };
const saveMeta = () => { try { localStorage.setItem(metaKey(), JSON.stringify(meta)); } catch {} };
const m = (path) => (meta[path] ||= { fav: false, tags: [] });

// ---- folder scanning ----
async function scan(dir, prefix = "") {
  for await (const [name, h] of dir.entries()) {
    if (name.startsWith(".")) continue;
    if (h.kind === "directory") await scan(h, prefix + name + "/");
    else state.files.push({ name, path: prefix + name, dir: prefix.slice(0, -1), handle: h, parent: dir, type: typeOf(name) });
  }
}
async function load(handle) {
  state.root = handle; state.files = []; state.index = -1; state.sel.clear();
  state.thumbs.forEach((u) => URL.revokeObjectURL(u)); state.thumbs.clear();
  $("count").textContent = "Scanning…";
  await scan(handle);
  loadMeta(); await sortFiles(); renderChips(); refresh();
}
async function ensureStats(files) {
  for (const f of files) {
    if (f.size === undefined) {
      const file = await f.handle.getFile();
      f.size = file.size; f.lastModified = file.lastModified;
    }
  }
}
async function sortFiles() {
  const s = state.sort;
  if (s === "date-desc" || s === "date-asc" || s === "size-desc" || s === "size-asc") {
    $("count").textContent = "Reading file info…";
    await ensureStats(state.files);
  }
  const byName = (a, b) => a.path.localeCompare(b.path, undefined, { numeric: true });
  const cmp = {
    name: byName,
    type: (a, b) => a.type.localeCompare(b.type) || byName(a, b),
    "date-desc": (a, b) => b.lastModified - a.lastModified || byName(a, b),
    "date-asc": (a, b) => a.lastModified - b.lastModified || byName(a, b),
    "size-desc": (a, b) => b.size - a.size || byName(a, b),
    "size-asc": (a, b) => a.size - b.size || byName(a, b),
  }[s] || byName;
  state.files.sort(cmp);
}
async function openFolder() {
  try {
    const h = await showDirectoryPicker({ mode: "readwrite" });
    await kv("readwrite", (s) => s.put(h, "root"));
    await load(h);
  } catch (e) { if (e.name !== "AbortError") alert(e.message); }
}
async function reopen() {
  const h = await kv("readonly", (s) => s.get("root"));
  if (h && (await h.requestPermission({ mode: "readwrite" })) === "granted") await load(h);
}

// ---- list + filters ----
function refresh() {
  const q = $("search").value.trim().toLowerCase();
  state.shown = state.files.filter((f) =>
    (state.type === "all" || (state.type === "fav" ? m(f.path).fav : f.type === state.type)) &&
    (!state.tag || m(f.path).tags.includes(state.tag)) &&
    (!q || f.path.toLowerCase().includes(q) || m(f.path).tags.some((t) => t.includes(q))));
  $("count").textContent = `${state.shown.length} of ${state.files.length} files`;
  const ul = $("list"); ul.replaceChildren();
  ul.className = "list " + state.view;
  state.shown.forEach((f, i) => {
    const li = document.createElement("li");
    li.className = i === state.index ? "sel" : "";
    const fav = m(f.path).fav;
    li.innerHTML = `<input type="checkbox" aria-label="Select file">` +
      (fav ? `<svg class="star-ic" aria-hidden="true"><use href="#i-star"/></svg>` : "");
    const cb = li.querySelector("input");
    cb.checked = state.sel.has(f.path);
    cb.onclick = (e) => e.stopPropagation();
    cb.onchange = (e) => {
      if (e.shiftKey && state.lastClicked >= 0) {
        const [lo, hi] = [state.lastClicked, i].sort((a, b) => a - b);
        for (let j = lo; j <= hi; j++) state.sel.add(state.shown[j].path);
      } else {
        cb.checked ? state.sel.add(f.path) : state.sel.delete(f.path);
      }
      state.lastClicked = i; refresh();
    };
    if (state.view === "grid") {
      const thumb = document.createElement(f.type === "image" ? "img" : "div");
      thumb.className = "thumb";
      if (f.type === "image") thumbFor(f).then((u) => { thumb.src = u; });
      else thumb.textContent = f.type;
      li.append(thumb);
    }
    const span = document.createElement("span"); span.className = "fname"; span.textContent = f.name;
    if (f.dir && state.view === "list") { const d = document.createElement("span"); d.className = "dir"; d.textContent = f.dir; span.append(d); }
    li.append(span);
    li.onclick = () => show(i);
    ul.append(li);
  });
  updateActions();
}
async function thumbFor(f) {
  if (state.thumbs.has(f.path)) return state.thumbs.get(f.path);
  const file = await f.handle.getFile();
  const url = URL.createObjectURL(file);
  state.thumbs.set(f.path, url);
  return url;
}

// ---- select + copy/move ----
function updateActions() {
  $("actions").hidden = state.sel.size === 0;
  $("selCount").textContent = `${state.sel.size} selected`;
}
async function uniqueName(dir, name) {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 0; ; n++) {
    const candidate = n ? `${base} (${n})${ext}` : name;
    try { await dir.getFileHandle(candidate); } catch (e) { if (e.name === "NotFoundError") return candidate; throw e; }
  }
}
async function transfer(move) {
  const files = state.files.filter((f) => state.sel.has(f.path));
  if (!files.length) return;
  let dest;
  try { dest = await showDirectoryPicker({ mode: "readwrite" }); }
  catch (e) { if (e.name !== "AbortError") alert(e.message); return; }
  const status = $("status"); let done = 0; const failed = [];
  for (const f of files) {
    status.textContent = `${move ? "Moving" : "Copying"} ${done + 1}/${files.length}: ${f.name}`;
    try {
      if (move && (await f.parent.isSameEntry(dest))) { done++; continue; }
      const out = await dest.getFileHandle(await uniqueName(dest, f.name), { create: true });
      const w = await out.createWritable();
      await (await f.handle.getFile()).stream().pipeTo(w);
      if (move) {
        await f.parent.removeEntry(f.name);
        state.files = state.files.filter((x) => x !== f);
        delete meta[f.path]; state.sel.delete(f.path);
      }
      done++;
    } catch (e) { failed.push(`${f.name}: ${e.message}`); }
  }
  if (move) { saveMeta(); state.index = -1; $("stage").replaceChildren(); $("toolbar").hidden = true; renderChips(); }
  refresh();
  status.textContent = `${move ? "Moved" : "Copied"} ${done} of ${files.length} to “${dest.name}”` + (failed.length ? ` — ${failed.length} failed` : "");
  if (failed.length) alert("Some files failed:\n" + failed.join("\n"));
}
function chip(parent, label, pressed, onclick) {
  const b = document.createElement("button");
  b.className = "chip"; b.textContent = label; b.setAttribute("aria-pressed", pressed);
  b.onclick = onclick; parent.append(b);
}
function renderChips() {
  const tc = $("typeChips"); tc.replaceChildren();
  ["all", "fav", "image", "video", "audio", "pdf", "text", "other"].forEach((t) =>
    chip(tc, t === "fav" ? "★ favorites" : t, state.type === t, () => { state.type = t; state.index = -1; renderChips(); refresh(); }));
  const gc = $("tagChips"); gc.replaceChildren();
  const tags = [...new Set(Object.values(meta).flatMap((v) => v.tags))].sort();
  tags.forEach((t) => chip(gc, "#" + t, state.tag === t, () => { state.tag = state.tag === t ? null : t; state.index = -1; renderChips(); refresh(); }));
}

// ---- viewer ----
async function show(i) {
  if (i < 0 || i >= state.shown.length) return;
  state.index = i;
  const f = state.shown[i];
  if (state.url) URL.revokeObjectURL(state.url);
  const stage = $("stage"); stage.replaceChildren();
  $("toolbar").hidden = false; $("fileName").textContent = f.path;
  updateToolbar(); refresh();
  document.querySelector("#list li.sel")?.scrollIntoView({ block: "nearest" });
  const file = await f.handle.getFile();
  f.size = file.size; f.lastModified = file.lastModified;
  $("fileInfo").textContent = `${formatSize(file.size)} · ${new Date(file.lastModified).toLocaleString()}`;
  let el;
  if (f.type === "text") {
    el = document.createElement("pre");
    el.textContent = file.size > 2e6 ? "File too large to preview (>2 MB)." : await file.text();
  } else if (f.type === "other") {
    state.url = URL.createObjectURL(file);
    el = document.createElement("p"); el.className = "empty";
    el.innerHTML = "No preview for this file type.<br>";
    const a = document.createElement("a"); a.href = state.url; a.download = f.name; a.textContent = "Download / open";
    el.append(a);
  } else {
    state.url = URL.createObjectURL(file);
    el = document.createElement({ image: "img", video: "video", audio: "audio", pdf: "iframe" }[f.type]);
    el.src = state.url;
    if (f.type === "video" || f.type === "audio") el.controls = true;
    if (f.type === "audio") el.style.width = "80%";
  }
  if (state.shown[state.index] === f) stage.append(el);
}
function updateToolbar() {
  const f = state.shown[state.index]; if (!f) return;
  $("favBtn").classList.toggle("active", m(f.path).fav);
  const box = $("fileTags"); box.replaceChildren();
  m(f.path).tags.forEach((t) => {
    const s = document.createElement("span"); s.className = "tag"; s.textContent = t; s.title = "Remove tag";
    s.onclick = () => { m(f.path).tags = m(f.path).tags.filter((x) => x !== t); saveMeta(); updateToolbar(); renderChips(); refresh(); };
    box.append(s);
  });
}
function toggleFav() {
  const f = state.shown[state.index]; if (!f) return;
  m(f.path).fav = !m(f.path).fav; saveMeta(); updateToolbar(); refresh();
}
function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  const units = ["KB", "MB", "GB", "TB"]; let v = bytes;
  for (const u of units) { v /= 1024; if (v < 1024) return v.toFixed(1) + " " + u; }
  return v.toFixed(1) + " TB";
}

// ---- rename / duplicate / new folder ----
async function renameCurrent() {
  const f = state.shown[state.index]; if (!f) return;
  const name = prompt("Rename to:", f.name);
  if (!name || name === f.name) return;
  try {
    try { await f.parent.getFileHandle(name); if (!confirm(`“${name}” already exists. Overwrite it?`)) return; } catch {}
    const out = await f.parent.getFileHandle(name, { create: true });
    const w = await out.createWritable();
    await (await f.handle.getFile()).stream().pipeTo(w);
    await f.parent.removeEntry(f.name);
    const oldPath = f.path;
    f.name = name; f.path = f.dir ? f.dir + "/" + name : name; f.handle = out; f.type = typeOf(name);
    meta[f.path] = meta[oldPath] || { fav: false, tags: [] }; if (oldPath !== f.path) delete meta[oldPath];
    saveMeta(); renderChips(); refresh();
    show(state.shown.indexOf(f));
  } catch (e) { alert(e.message); }
}
async function duplicateSelected() {
  const files = state.files.filter((f) => state.sel.has(f.path));
  if (!files.length) return;
  const status = $("status"); let done = 0;
  for (const f of files) {
    status.textContent = `Duplicating ${done + 1}/${files.length}: ${f.name}`;
    const name = await uniqueName(f.parent, f.name);
    const out = await f.parent.getFileHandle(name, { create: true });
    const w = await out.createWritable();
    await (await f.handle.getFile()).stream().pipeTo(w);
    const dup = { ...f, name, path: f.dir ? f.dir + "/" + name : name, handle: out };
    state.files.push(dup); done++;
  }
  await sortFiles(); renderChips(); refresh();
  status.textContent = `Duplicated ${done} file(s).`;
}
async function newFolder() {
  if (!state.root) return;
  const name = prompt("New folder name:");
  if (!name) return;
  try {
    await state.root.getDirectoryHandle(name, { create: true });
    $("status").textContent = `Created folder “${name}”. Move or copy files into it from the list, or reopen the folder to browse into it.`;
  } catch (e) { alert(e.message); }
}

// ---- stats ----
async function showStats() {
  const files = state.shown;
  $("status").textContent = "Computing stats…";
  await ensureStats(files);
  const total = files.reduce((n, f) => n + f.size, 0);
  const byType = {};
  for (const f of files) byType[f.type] = (byType[f.type] || 0) + 1;
  const parts = Object.entries(byType).map(([t, n]) => `${t}: ${n}`).join(", ");
  $("status").textContent = `${files.length} file(s) shown, ${formatSize(total)} total — ${parts}`;
}

// ---- fullscreen ----
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else $("stage").requestFullscreen().catch(() => {});
}

// ---- wiring ----
$("openBtn").onclick = openFolder;
$("search").oninput = () => { state.index = -1; refresh(); };
$("favBtn").onclick = toggleFav;
$("copyBtn").onclick = () => transfer(false);
$("moveBtn").onclick = () => {
  if (confirm(`Move ${state.sel.size} file(s)? They will be removed from their current folder.`)) transfer(true);
};
$("deleteBtn").onclick = async () => {
  const files = state.files.filter((f) => state.sel.has(f.path));
  if (!files.length) return;
  if (!confirm(`PERMANENTLY delete ${files.length} file(s)?\n\nThey will NOT go to the Recycle Bin and cannot be recovered.`)) return;
  const failed = []; let done = 0;
  for (const f of files) {
    try {
      await f.parent.removeEntry(f.name);
      state.files = state.files.filter((x) => x !== f);
      delete meta[f.path]; state.sel.delete(f.path); done++;
    } catch (e) { failed.push(`${f.name}: ${e.message}`); }
  }
  saveMeta(); state.index = -1; $("stage").replaceChildren(); $("toolbar").hidden = true;
  renderChips(); refresh();
  $("status").textContent = `Deleted ${done} of ${files.length}` + (failed.length ? ` — ${failed.length} failed` : "");
  if (failed.length) alert("Some files failed:\n" + failed.join("\n"));
};
$("selAllBtn").onclick = () => { state.shown.forEach((f) => state.sel.add(f.path)); refresh(); };
$("selNoneBtn").onclick = () => { state.sel.clear(); refresh(); };
$("dupBtn").onclick = duplicateSelected;
$("newFolderBtn").onclick = newFolder;
$("renameBtn").onclick = renameCurrent;
$("sortSel").onchange = async (e) => { state.sort = e.target.value; await sortFiles(); refresh(); };
$("statsBtn").onclick = showStats;
$("viewBtn").onclick = () => {
  state.view = state.view === "list" ? "grid" : "list";
  $("viewBtn").querySelector("use").setAttribute("href", state.view === "grid" ? "#i-list" : "#i-grid");
  $("viewBtn").title = state.view === "grid" ? "Switch to list view" : "Switch to grid view";
  refresh();
};
$("fullBtn").onclick = toggleFullscreen;
$("prevBtn").onclick = () => show(state.index - 1);
$("nextBtn").onclick = () => show(state.index + 1);
$("tagInput").onkeydown = (e) => {
  if (e.key !== "Enter") return;
  const t = e.target.value.trim().toLowerCase().replace(/^#/, "");
  const f = state.shown[state.index];
  if (t && f && !m(f.path).tags.includes(t)) { m(f.path).tags.push(t); saveMeta(); updateToolbar(); renderChips(); refresh(); }
  e.target.value = "";
};
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input")) return;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); show(state.index + 1); }
  else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); show(state.index - 1); }
  else if (e.key.toLowerCase() === "f") toggleFav();
  else if (e.key.toLowerCase() === "r") renameCurrent();
  else if (e.key === "Delete") $("deleteBtn").click();
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); $("selAllBtn").click(); }
  else if (e.key === "Escape") $("selNoneBtn").click();
  else if (e.key === "Home") { e.preventDefault(); show(0); }
  else if (e.key === "End") { e.preventDefault(); show(state.shown.length - 1); }
  else if (e.key === "Enter" && state.index >= 0) toggleFullscreen();
});

if (!window.showDirectoryPicker) {
  $("stage").innerHTML = '<p class="empty">This app needs a Chromium browser (Chrome or Edge) to read local folders.</p>';
} else {
  kv("readonly", (s) => s.get("root")).then((h) => {
    if (!h) return;
    const b = $("reopenBtn"); b.hidden = false; b.textContent = "Reopen “" + h.name + "”";
    b.onclick = () => { reopen(); b.hidden = true; };
  }).catch(() => {});
}
