const SLICERS = ["OrcaSlicer", "Bambu Studio", "PrusaSlicer", "Cura", "Other"];
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let tips = [];
let activeFilters = new Set();
let editingId = null;

async function api(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
}
const jsonOpts = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function load() {
  tips = await api("/api/tips");
  render();
}

function matches(t) {
  const q = $("#search").value.trim().toLowerCase();
  if (q) {
    const hay = [t.title, t.printer, t.filament, t.notes, t.tags.join(" "), t.slicers.join(" "),
      t.settings.map(s => `${s.key} ${s.value}`).join(" ")].join(" ").toLowerCase();
    if (!q.split(/\s+/).every(w => hay.includes(w))) return false;
  }
  const labels = new Set([...t.slicers, ...t.tags]);
  return [...activeFilters].every(f => labels.has(f));
}

function render() {
  const labels = [...new Set(tips.flatMap(t => [...t.slicers, ...t.tags]))].sort();
  $("#filters").innerHTML = labels.map(l =>
    `<button class="chip ${activeFilters.has(l) ? "on" : ""}" data-f="${esc(l)}">${esc(l)}</button>`).join("");
  const shown = tips.filter(matches);
  $("#empty").hidden = tips.length > 0;
  $("#grid").innerHTML = shown.map(t => `
    <article class="card" data-id="${t.id}">
      ${t.photo ? `<img src="/photos/${esc(t.photo)}" alt="" loading="lazy">` : ""}
      <div class="body">
        <h3>${esc(t.title)}</h3>
        <div class="meta">${esc([t.printer, t.filament].filter(Boolean).join(" · "))}</div>
        <div class="chips">${[...t.slicers, ...t.tags].map(l => `<span class="chip static">${esc(l)}</span>`).join("")}</div>
        <div class="kv">${t.settings.slice(0, 3).map(s => `${esc(s.key)} = ${esc(s.value)}`).join("<br>")}${t.settings.length > 3 ? `<br>+${t.settings.length - 3} more` : ""}</div>
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

function openView(t) {
  const v = $("#view");
  v.innerHTML = `
    <h2>${esc(t.title)}</h2>
    ${t.photo ? `<img class="view-img" src="/photos/${esc(t.photo)}" alt="">` : ""}
    <div class="meta">${esc([t.printer, t.filament].filter(Boolean).join(" · "))}</div>
    <div class="chips">${[...t.slicers, ...t.tags].map(l => `<span class="chip static">${esc(l)}</span>`).join("")}</div>
    <table>${t.settings.map(s => `<tr><td>${esc(s.key)}</td><td>${esc(s.value)}</td></tr>`).join("")}</table>
    ${t.notes ? `<p class="notes">${esc(t.notes)}</p>` : ""}
    ${/^https?:\/\//.test(t.source_url) ? `<p><a href="${esc(t.source_url)}" target="_blank" rel="noopener noreferrer">Source</a></p>` : ""}
    <div class="actions">
      <button class="danger" data-a="del">Delete</button>
      <button data-a="copy">Copy settings</button>
      <a href="/api/tips/${t.id}/export"><button type="button">Export JSON</button></a>
      <button data-a="edit">Edit</button>
      <button data-a="close" class="primary">Close</button>
    </div>`;
  v.onclick = async e => {
    const a = e.target.dataset.a;
    if (a === "close") v.close();
    if (a === "edit") { v.close(); openEdit(t); }
    if (a === "copy") {
      await navigator.clipboard?.writeText(t.settings.map(s => `${s.key} = ${s.value}`).join("\n"));
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

// ---- edit form ----
$("#slicer-boxes").innerHTML = SLICERS.map(s =>
  `<label style="display:inline-block;margin-right:12px"><input type="checkbox" value="${s}" style="width:auto"> ${s}</label>`).join("");

function addRow(key = "", value = "") {
  const d = document.createElement("div");
  d.className = "srow";
  d.innerHTML = `<input placeholder="key (e.g. support_top_z_distance)" value="${esc(key)}"><input placeholder="value" value="${esc(value)}"><button type="button" title="Remove">✕</button>`;
  d.lastChild.onclick = () => d.remove();
  $("#settings-rows").append(d);
}
$("#add-row").onclick = () => addRow();
$("#new").onclick = () => openEdit(null);
$("#cancel").onclick = () => $("#edit").close();

function openEdit(t) {
  editingId = t?.id ?? null;
  const f = $("#form");
  $("#edit-title").textContent = t ? "Edit tip" : "New tip";
  f.reset();
  $("#settings-rows").innerHTML = "";
  f.title.value = t?.title ?? "";
  f.printer.value = t?.printer ?? "";
  f.filament.value = t?.filament ?? "";
  f.tags.value = (t?.tags ?? []).join(", ");
  f.source_url.value = t?.source_url ?? "";
  f.notes.value = t?.notes ?? "";
  $("#slicer-boxes").querySelectorAll("input").forEach(i => i.checked = !!t?.slicers.includes(i.value));
  (t?.settings.length ? t.settings : [{ key: "", value: "" }]).forEach(s => addRow(s.key, s.value));
  $("#edit").showModal();
}

$("#diff-go").onclick = async e => {
  const p = $("#diff-profile").files[0];
  if (!p) return alert("Choose a profile first");
  const fd = new FormData();
  fd.append("profile", p);
  const b = $("#diff-baseline").files[0];
  if (b) fd.append("baseline", b);
  e.target.disabled = true;
  try {
    const r = await api("/api/diff", { method: "POST", body: fd });
    [...$("#settings-rows").children].forEach(row => { if (!row.firstChild.value.trim()) row.remove(); });
    r.settings.forEach(s => addRow(s.key, s.value));
    if (!b && r.settings.length > 20 && !confirm(`${r.settings.length} keys extracted with no baseline. Keep them all? (Cancel to discard)`)) {
      $("#settings-rows").innerHTML = ""; addRow();
    }
  } catch (err) { alert(err.message); }
  e.target.disabled = false;
};

$("#form").onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  const body = {
    title: f.title.value,
    slicers: [...$("#slicer-boxes").querySelectorAll("input:checked")].map(i => i.value),
    printer: f.printer.value, filament: f.filament.value,
    tags: f.tags.value.split(","),
    source_url: f.source_url.value, notes: f.notes.value,
    settings: [...$("#settings-rows").children].map(r => ({ key: r.children[0].value.trim(), value: r.children[1].value }))
      .filter(s => s.key),
  };
  try {
    const saved = editingId
      ? await api(`/api/tips/${editingId}`, jsonOpts("PUT", body))
      : await api("/api/tips", jsonOpts("POST", body));
    const file = f.photo.files[0];
    if (file) {
      const fd = new FormData(); fd.append("file", file);
      await api(`/api/tips/${saved.id}/photo`, { method: "POST", body: fd });
    }
    $("#edit").close();
    load();
  } catch (err) { alert(err.message); }
};

load();
