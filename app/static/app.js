const SLICERS = ["OrcaSlicer", "Bambu Studio", "PrusaSlicer", "Cura", "Other"];
const KINDS = [["process", "Print"], ["filament", "Filament"], ["printer", "Printer"]];
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let tips = [], catalog, printers = [];
const defaultsCache = {};
let activeFilters = new Set();

async function api(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
}
const jsonOpts = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const emptyDefaults = () => ({ process: {}, filament: {}, printer: {} });
async function getDefaults(printer) {
  if (!printer) return emptyDefaults();
  return defaultsCache[printer] ??= await api(`/api/printers/${encodeURIComponent(printer)}/defaults`);
}

// ---- value helpers (profile values are strings, or arrays of strings for per-extruder options) ----
function same(a, b) {
  if (a === undefined || b === undefined) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    const la = [].concat(a), lb = [].concat(b), n = Math.min(la.length, lb.length);
    return (n > 0 || (!la.length && !lb.length)) && la.slice(0, n).every((x, i) => same(x, lb[i]));
  }
  a = String(a); b = String(b);
  if (a === b) return true;
  const x = Number(a), y = Number(b);
  return a.trim() !== "" && b.trim() !== "" && !isNaN(x) && !isNaN(y) && x === y;
}
const show = v => v === undefined ? "" : Array.isArray(v) ? v.join(", ") : String(v);
const short = (v, n = 40) => { const s = show(v).replace(/\s+/g, " "); return s.length > n ? s.slice(0, n) + "…" : s; };
const isList = def => /s$/.test(def?.type || "") && def.type !== "coStrings" || def?.type === "coStrings";
const isBool = def => def?.type === "coBool" || def?.type === "coBools";
const label = key => catalog.options[key]?.label || key;
const WHERE = {};
const where = key => WHERE[key] || "";
// "Length" alone is ambiguous on a card, so prefix the group unless the label already says it
const GENERIC_GROUPS = new Set(["Advanced", "Basic information", "Others", "Notes"]);
const nice = key => {
  const l = label(key), g = where(key).split(" › ")[1] || "";
  const stem = g.toLowerCase().split(/[^a-z]+/)[0];
  return !g || GENERIC_GROUPS.has(g) || l.toLowerCase().includes(stem) ? l : `${g}: ${l}`;
};
const modelOf = name => printers.find(p => p.name === name)?.model || "";

async function load() {
  [catalog, printers] = await Promise.all([api("/api/catalog"), api("/api/printers")]);
  for (const pages of Object.values(catalog.kinds))
    for (const pg of pages) for (const g of pg.groups) for (const k of g.options) WHERE[k] ??= `${pg.title} › ${g.title}`;
  tips = await api("/api/tips");
  render();
}

// ---- gallery ----
function matches(t) {
  const q = $("#search").value.trim().toLowerCase();
  if (q) {
    const hay = [t.title, t.base_printer, t.filament, t.notes, t.tags.join(" "), t.slicers.join(" "),
      t.settings.map(s => `${s.key} ${label(s.key)} ${show(s.value)}`).join(" ")].join(" ").toLowerCase();
    if (!q.split(/\s+/).every(w => hay.includes(w))) return false;
  }
  const labels = tipLabels(t);
  return [...activeFilters].every(f => labels.includes(f));
}
const tipLabels = t => [...t.slicers, ...t.tags, ...(t.base_printer ? [modelOf(t.base_printer)] : [])].filter(Boolean);
const countByKind = t => KINDS.map(([k, n]) => [n, t.settings.filter(s => s.kind === k).length]).filter(([, c]) => c);

function render() {
  const labels = [...new Set(tips.flatMap(tipLabels))].sort();
  $("#filters").innerHTML = labels.map(l =>
    `<button class="chip ${activeFilters.has(l) ? "on" : ""}" data-f="${esc(l)}">${esc(l)}</button>`).join("");
  $("#empty").hidden = tips.length > 0;
  $("#grid").innerHTML = tips.filter(matches).map(t => `
    <article class="card" data-id="${t.id}">
      ${t.photo ? `<img src="/photos/${esc(t.photo)}" alt="" loading="lazy">` : ""}
      <div class="body">
        <h3>${esc(t.title)}</h3>
        <div class="meta">${esc([t.base_printer, t.filament].filter(Boolean).join(" · "))}</div>
        <div class="chips">${tipLabels(t).map(l => `<span class="chip static">${esc(l)}</span>`).join("")}</div>
        <div class="kv">${t.settings.slice(0, 3).map(s => `${esc(nice(s.key))}: <b>${esc(short(s.value, 24))}</b>`).join("<br>")}
          ${t.settings.length > 3 ? `<br>+${t.settings.length - 3} more` : ""}
          ${t.settings.length ? `<br>${countByKind(t).map(([n, c]) => `${n} ${c}`).join(" · ")}` : ""}</div>
      </div>
    </article>`).join("");
}

$("#filters").onclick = e => {
  const f = e.target.dataset.f;
  if (!f) return;
  activeFilters.has(f) ? activeFilters.delete(f) : activeFilters.add(f);
  render();
};
$("#search").oninput = render;
$("#grid").onclick = e => {
  const c = e.target.closest(".card");
  if (c) openView(tips.find(t => t.id == c.dataset.id));
};

// ---- detail view: every change next to the printer's default ----
async function openView(t) {
  const v = $("#view");
  const d = await getDefaults(t.base_printer);
  const tables = KINDS.map(([kind, name]) => {
    const rows = t.settings.filter(s => s.kind === kind);
    if (!rows.length) return "";
    return `<h3>${name}</h3><table>${rows.map(s => {
      const def = d[kind][s.key], multi = catalog.options[s.key]?.multiline;
      const fmt = x => multi ? `<pre class="gc">${esc(show(x))}</pre>` : esc(short(x, 80));
      return `<tr class="changed"><td>${esc(label(s.key))}<small>${esc(where(s.key))}${where(s.key) ? " · " : ""}${esc(s.key)}</small></td>
        <td>${def !== undefined ? `<span class="old">${fmt(def)}</span> → ` : ""}<span class="new">${fmt(s.value)}</span></td></tr>`;
    }).join("")}</table>`;
  }).join("");
  v.innerHTML = `
    <h2>${esc(t.title)}</h2>
    ${t.photo ? `<img class="view-img" src="/photos/${esc(t.photo)}" alt="">` : ""}
    <div class="meta">${esc([t.base_printer ? `vs. ${t.base_printer} defaults` : "no base printer", t.filament].filter(Boolean).join(" · "))}</div>
    <div class="chips">${tipLabels(t).map(l => `<span class="chip static">${esc(l)}</span>`).join("")}</div>
    ${tables || `<p class="hint">No overrides.</p>`}
    ${t.notes ? `<p class="notes">${esc(t.notes)}</p>` : ""}
    ${/^https?:\/\//.test(t.source_url) ? `<p><a href="${esc(t.source_url)}" target="_blank" rel="noopener noreferrer">Source</a></p>` : ""}
    <div class="actions">
      <button class="danger" data-a="del">Delete</button>
      <button data-a="copy">Copy settings</button>
      ${KINDS.filter(([k]) => t.settings.some(s => s.kind === k)).map(([k, n]) =>
        `<a href="/api/tips/${t.id}/export?kind=${k}"><button type="button">Export ${n}</button></a>`).join("")}
      <button data-a="edit">Edit</button>
      <button data-a="close" class="primary" autofocus>Close</button>
    </div>`;
  v.onclick = async e => {
    const a = e.target.dataset.a;
    if (a === "close") v.close();
    if (a === "edit") { v.close(); openEdit(t); }
    if (a === "copy") {
      await navigator.clipboard?.writeText(t.settings.map(s => `${s.key} = ${show(s.value)}`).join("\n"));
      e.target.textContent = "Copied";
    }
    if (a === "del" && confirm(`Delete “${t.title}”?`)) {
      await api(`/api/tips/${t.id}`, { method: "DELETE" });
      v.close(); load();
    }
    if (e.target === v) v.close();
  };
  v.showModal();
}

// ---- editor ----
let ov, defaults, editingId = null;
const ed = { kind: "process", page: 0, q: "", changedOnly: false };

$("#slicer-boxes").innerHTML = SLICERS.map(s =>
  `<label style="display:inline-block;margin-right:12px"><input type="checkbox" value="${s}"> ${s}</label>`).join("");
$("#new").onclick = () => openEdit(null);
$("#cancel").onclick = () => $("#edit").close();

function fillPrinterSelect(selected) {
  const models = [...new Set(printers.map(p => p.model))];
  $("#base-printer").innerHTML = `<option value="">(none: nothing to compare against)</option>` +
    models.map(m => `<optgroup label="${esc(m)}">${printers.filter(p => p.model === m).map(p =>
      `<option value="${esc(p.name)}" ${p.name === selected ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</optgroup>`).join("");
}

async function openEdit(t) {
  editingId = t?.id ?? null;
  const f = $("#form");
  f.reset();
  $("#edit-title").textContent = t ? "Edit recipe" : "New recipe";
  f.elements.title.value = t?.title ?? "";
  f.elements.filament.value = t?.filament ?? "";
  f.elements.tags.value = (t?.tags ?? []).join(", ");
  f.elements.source_url.value = t?.source_url ?? "";
  f.elements.notes.value = t?.notes ?? "";
  $("#slicer-boxes").querySelectorAll("input").forEach(i => i.checked = !!t?.slicers.includes(i.value));
  fillPrinterSelect(t?.base_printer ?? "");
  ov = emptyDefaults();
  (t?.settings ?? []).forEach(s => (ov[s.kind] ??= {})[s.key] = s.value);
  $("#diff-msg").textContent = "";
  Object.assign(ed, { kind: "process", page: 0, q: "", changedOnly: false });
  defaults = await getDefaults(t?.base_printer ?? "");
  updateHint();
  renderEditor();
  $("#edit").showModal();
}

const baseName = () => $("#base-printer").value;
function updateHint() {
  $("#base-hint").textContent = baseName()
    ? "Values are compared with this printer's default print, filament and printer presets; differences are highlighted."
    : "Choose a printer to see defaults and highlight differences.";
}
$("#base-printer").onchange = async () => {
  defaults = await getDefaults(baseName());
  updateHint();
  renderEditor();
};

const curValue = (kind, key) => key in ov[kind] ? ov[kind][key] : defaults[kind][key];
const changedCount = kind => Object.keys(ov[kind]).length;

const LEVELS = ["simple", "advanced", "expert"];
const ic = name => name ? `<img class="ic" src="icons/${esc(name)}.svg" alt="">` : "";
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
ed.level = LEVELS.includes(store.get("level")) ? store.get("level") : "advanced";

function optRow(kind, key) {
  const def = catalog.options[key] || {};
  const base = defaults[kind][key], cur = curValue(kind, key);
  const changed = key in ov[kind];
  let ctl;
  if (isBool(def)) {
    const on = String([].concat(cur ?? "0")[0]) === "1";
    ctl = `<input type="checkbox" data-key="${key}" ${on ? "checked" : ""}>`;
  } else if (def.multiline) {
    ctl = `<textarea data-key="${key}" spellcheck="false">${esc(show(cur))}</textarea>`;
  } else if (def.enum && def.type === "coEnum") {
    const cv = String([].concat(cur ?? "")[0]);
    ctl = `<select data-key="${key}">${cv === "" ? `<option value="" selected>not set</option>` : ""}${def.enum.map(o =>
      `<option value="${esc(o.value)}" ${o.value === cv ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`;
  } else {
    const dl = def.enum ? `list="dl-${key}"` : "";
    ctl = `<input data-key="${key}" ${dl} value="${esc(show(cur))}" ${cur === undefined ? 'placeholder="not set"' : ""}>${def.sidetext ? `<span class="unit">${esc(def.sidetext)}</span>` : ""}` +
      (def.enum ? `<datalist id="dl-${key}">${def.enum.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("")}</datalist>` : "");
  }
  const tip = [def.tooltip, `${key}${base !== undefined ? ` · default: ${show(base)}` : ""}`].filter(Boolean).join("\n\n");
  return `<div class="opt ${changed ? "changed" : ""} ${def.multiline ? "wide" : ""}" data-kind="${kind}" data-key="${key}" title="${esc(tip)}">
    <div class="lbl">${esc(def.label || key)}${changed ? `<span class="was">${base === undefined ? "added" : `default ${esc(short(base, 30))}`}</span>` : ""}</div>
    <div class="ctl">${ctl}<button type="button" class="reset" title="Back to default">↺</button></div>
  </div>`;
}

function renderEditor() {
  const kind = ed.kind, pages = catalog.kinds[kind];
  const q = ed.q.trim().toLowerCase();
  const rank = LEVELS.indexOf(ed.level);
  // an override is always shown, whatever the level
  const visible = key => key in ov[kind] || LEVELS.indexOf(catalog.options[key]?.mode) <= rank && catalog.options[key]?.mode !== "develop";
  const wanted = key => {
    if (!visible(key)) return false;
    if (ed.changedOnly && !(key in ov[kind])) return false;
    if (!q) return true;
    const d = catalog.options[key];
    return `${key} ${d.label || ""} ${d.tooltip || ""}`.toLowerCase().includes(q);
  };
  const pageKeys = pg => pg.groups.flatMap(g => g.options.filter(wanted));
  const searching = q || ed.changedOnly;
  const nonEmpty = pages.map((pg, i) => [pg, i]).filter(([pg]) => pageKeys(pg).length);
  if (!nonEmpty.some(([, i]) => i === ed.page)) ed.page = nonEmpty[0]?.[1] ?? 0;
  const shown = searching ? nonEmpty.map(([pg]) => pg) : [pages[ed.page]].filter(Boolean);

  let body = "";
  for (const pg of shown) {
    for (const g of pg.groups) {
      const keys = g.options.filter(wanted);
      if (!keys.length) continue;
      body += `<section class="grp"><h4>${ic(g.icon)}${esc(searching ? `${pg.title} › ${g.title}` : g.title)}</h4>${keys.map(k => optRow(kind, k)).join("")}</section>`;
    }
  }
  // overrides for keys the catalog doesn't lay out (e.g. imported advanced settings)
  const laidOut = new Set(pages.flatMap(p => p.groups.flatMap(g => g.options)));
  const extra = Object.keys(ov[kind]).filter(k => !laidOut.has(k) && (!q || k.includes(q)));
  if (searching && extra.length) body += `<section class="grp"><h4>Other</h4>${extra.map(k => optRow(kind, k)).join("")}</section>`;

  const pageBadge = pg => { const n = pg.groups.flatMap(g => g.options).filter(k => k in ov[kind]).length; return n ? `<span class="n">${n}</span>` : ""; };
  $("#editor").innerHTML = `
    <div class="bar">
      <div class="tabs kinds">${KINDS.map(([k, n]) =>
        `<button type="button" class="tab ${k === kind ? "on" : ""}" data-kind="${k}">${n}${changedCount(k) ? `<span class="n">${changedCount(k)}</span>` : ""}</button>`).join("")}</div>
      <input type="search" id="opt-q" placeholder="Search ${esc(KINDS.find(k => k[0] === kind)[1])} settings…" value="${esc(ed.q)}">
      <select id="level" title="Show settings up to this level">${LEVELS.map(l =>
        `<option value="${l}" ${l === ed.level ? "selected" : ""}>${l[0].toUpperCase() + l.slice(1)}</option>`).join("")}</select>
      <label><input type="checkbox" id="changed-only" ${ed.changedOnly ? "checked" : ""}> Changed only</label>
    </div>
    <div class="split">
      <nav class="rail">${searching ? "" : nonEmpty.map(([pg, i]) =>
        `<button type="button" class="rail-item ${i === ed.page ? "on" : ""}" data-page="${i}">${ic(pg.icon)}<span>${esc(pg.title)}</span>${pageBadge(pg)}</button>`).join("")}</nav>
      <div class="opts">${body || `<p class="hint">Nothing to show${ed.level !== "expert" ? " at this level. Try a higher level." : "."}</p>`}</div>
    </div>`;
  const q$ = $("#opt-q");
  if (ed.refocus) { q$.focus(); q$.setSelectionRange(99, 99); ed.refocus = false; }
}

$("#editor").addEventListener("click", e => {
  const t = e.target.closest(".tab");
  if (t?.dataset.kind) { ed.kind = t.dataset.kind; ed.page = 0; ed.q = ""; renderEditor(); }
  const r = e.target.closest(".rail-item");
  if (r) { ed.page = +r.dataset.page; renderEditor(); }
  if (e.target.classList.contains("reset")) {
    const row = e.target.closest(".opt");
    delete ov[row.dataset.kind][row.dataset.key];
    renderEditor();
  }
});
$("#editor").addEventListener("change", e => {
  if (e.target.id === "changed-only") { ed.changedOnly = e.target.checked; renderEditor(); }
  if (e.target.id === "level") { ed.level = e.target.value; store.set("level", ed.level); renderEditor(); }
});
$("#editor").addEventListener("input", e => {
  if (e.target.id === "opt-q") { ed.q = e.target.value; ed.refocus = true; renderEditor(); return; }
  const row = e.target.closest(".opt");
  if (!row) return;
  const { kind, key } = row.dataset, def = catalog.options[key] || {};
  const base = defaults[kind][key];
  let val;
  if (isBool(def)) {
    const flag = e.target.checked ? "1" : "0";
    val = Array.isArray(base) ? base.map(() => flag) : flag;
  } else if (Array.isArray(base) || (base === undefined && isList(def) && def.type !== "coString")) {
    val = e.target.value.split(",").map(x => x.trim());
  } else val = e.target.value;
  if (base !== undefined && same(val, base)) delete ov[kind][key]; else ov[kind][key] = val;
  row.classList.toggle("changed", key in ov[kind]);
  const lbl = row.querySelector(".lbl");
  lbl.querySelector(".was")?.remove();
  if (key in ov[kind]) lbl.insertAdjacentHTML("beforeend", `<span class="was">${base === undefined ? "added" : `default ${esc(short(base, 30))}`}</span>`);
  refreshBadges();
});
function refreshBadges() {
  $("#editor").querySelectorAll(".tab[data-kind]").forEach(b => {
    const n = changedCount(b.dataset.kind);
    b.querySelector(".n")?.remove();
    if (n) b.insertAdjacentHTML("beforeend", `<span class="n">${n}</span>`);
  });
  const pages = catalog.kinds[ed.kind];
  $("#editor").querySelectorAll(".rail-item").forEach(b => {
    const n = pages[b.dataset.page].groups.flatMap(g => g.options).filter(k => k in ov[ed.kind]).length;
    b.querySelector(".n")?.remove();
    if (n) b.insertAdjacentHTML("beforeend", `<span class="n">${n}</span>`);
  });
}

$("#diff-go").onclick = async e => {
  const p = $("#diff-profile").files[0];
  if (!p) return alert("Choose a profile first");
  const b = $("#diff-baseline").files[0];
  if (!b && !baseName()) return alert("Choose a base printer (or a baseline file) to compare against");
  const fd = new FormData();
  fd.append("profile", p);
  if (b) fd.append("baseline", b); else fd.append("printer", baseName());
  e.target.disabled = true;
  try {
    const r = await api("/api/diff", { method: "POST", body: fd });
    r.settings.forEach(s => (ov[s.kind] ??= {})[s.key] = s.value);
    $("#diff-msg").textContent = `${r.settings.length} overrides imported (of ${r.total_keys} keys).`;
    renderEditor();
  } catch (err) { alert(err.message); }
  e.target.disabled = false;
};

$("#form").onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  const body = {
    title: f.elements.title.value,
    slicers: [...$("#slicer-boxes").querySelectorAll("input:checked")].map(i => i.value),
    base_printer: baseName(), filament: f.elements.filament.value,
    tags: f.elements.tags.value.split(","),
    source_url: f.elements.source_url.value, notes: f.elements.notes.value,
    settings: KINDS.flatMap(([kind]) => Object.entries(ov[kind]).map(([key, value]) => ({ kind, key, value }))),
  };
  try {
    const saved = editingId
      ? await api(`/api/tips/${editingId}`, jsonOpts("PUT", body))
      : await api("/api/tips", jsonOpts("POST", body));
    const file = f.elements.photo.files[0];
    if (file) {
      const fd = new FormData(); fd.append("file", file);
      await api(`/api/tips/${saved.id}/photo`, { method: "POST", body: fd });
    }
    $("#edit").close();
    load();
  } catch (err) { alert(err.message); }
};

load();
