const API = (() => {
  if (window.MIM_API_BASE) return window.MIM_API_BASE;
  const origin = window.location.origin || "http://localhost:3000";
  const isLocal = origin.includes("localhost") || origin.includes("127.0.0.1");
  return (isLocal ? "http://localhost:3000" : origin) + "/api";
})();

const E = {
  me: "/employe/me",
  dashboard: "/employe/dashboard",
  tasks: "/employe/tasks",
  incidents: "/employe/incidents",
  interventions: "/employe/interventions",
  logements: "/employe/logements",
  locataires: "/employe/locataires",
  notifications: "/employe/notifications",
  paiements: "/employe/paiements",
  moyens: "/employe/moyens-paiement",
  profile: "/employe/profile",
  password: "/employe/password",
  logout: "/auth/logout",
};

const S = {};
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const esc = (x) =>
  String(x ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[c]));

const arr = (x, k) =>
  Array.isArray(x) ? x : Array.isArray(x?.data) ? x.data : Array.isArray(x?.[k]) ? x[k] : [];

function toast(m, t = "success") {
  let x = $("#toast");
  x.textContent = m;
  x.className = "toast show " + t;
  setTimeout(() => (x.className = "toast"), 2800);
}

async function api(p, o = {}) {
  let r = await fetch(API + p, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(o.headers || {}) },
    ...o,
  });
  let b = null;
  try { b = await r.json(); } catch {}
  if (!r.ok) {
    let e = Error(b?.message || b?.error || MIM.httpFallback[r.status] || "Erreur serveur");
    e.status = r.status;
    e.code = b?.code || null;
    e.errors = b?.errors || null;
    MIM.handleAuthError(e);
    throw e;
  }
  return b;
}

function date(x) {
  if (!x) return "—";
  let d = new Date(x);
  return isNaN(d) ? "—" : d.toLocaleDateString("fr-FR");
}

function dateTime(x) {
  if (!x) return "—";
  let d = new Date(x);
  return isNaN(d)
    ? "—"
    : d.toLocaleDateString("fr-FR") + " " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function fmtMoney(x) {
  let n = Number(x ?? 0);
  return (isNaN(n) ? 0 : n).toLocaleString("fr-FR") + " FCFA";
}

const SALAIRE_LABELS = { paye: "Confirmé", attente: "En attente de confirmation", non_recu: "Non reçu" };

const MOYEN_TYPE_LABELS = {
  wave: "Wave",
  orange_money: "Orange Money",
  virement: "Virement bancaire",
  especes: "Espèces",
};

const MOYEN_TYPE_ICONS = { wave: "🟣", orange_money: "🟠", virement: "🏦", especes: "💵" };

const MOYEN_FIELD_LABELS = {
  nom_titulaire: "Nom du titulaire",
  numero: "Numéro",
  lien_paiement: "Lien de paiement",
  banque: "Banque",
  num_compte: "Numéro de compte",
  iban: "IBAN",
  bic: "BIC",
  instructions: "Instructions",
};

const MOYEN_FIELDS = {
  wave: [["nom_titulaire"], ["numero"], ["lien_paiement"], ["instructions"]],
  orange_money: [["nom_titulaire"], ["numero"], ["lien_paiement"], ["instructions"]],
  virement: [["banque"], ["nom_titulaire"], ["num_compte"], ["iban"], ["bic"], ["instructions"]],
  especes: [["instructions"]],
};

function empty(id, m = "Aucune donnée.") {
  $("#" + id).innerHTML = `<div class="empty">${esc(m)}</div>`;
}

function badge(id, n) {
  let x = $("#" + id);
  x.textContent = n;
  x.style.display = n ? "inline-block" : "none";
}

function status(x) {
  return `<span class="status">${esc(x || "—")}</span>`;
}

async function me() {
  let d = await api(E.me),
    u = d?.data || d?.user || d;
  S.me = u;
  let n = u.name || u.full_name || u.username || "Employé";
  $("#sideName").textContent = n;
  $("#topName").textContent = n;
  $("#welcome").textContent = n;
  $("#avatar").textContent = n[0]?.toUpperCase() || "E";
  if (u.avatar_url) {
    $("#avatar").innerHTML = `<img src="${esc(u.avatar_url)}" alt="">`;
  }
  $("#sideRole").textContent = u.role || u.employee_role || "Employé";
  $("#pName").value = u.name || u.full_name || "";
  $("#pUsername").value = u.username || "";
  $("#pRole").value = u.role || u.employee_role || "";
  $("#pEmail").value = u.email || "";
  setAvatar(u.avatar_url || null);
}

function setAvatar(url) {
  const img = $("#pAvatar");
  if (url) {
    img.src = url;
    $("#pAvatarRemove").style.display = "";
  } else {
    img.src = img.dataset.placeholder;
    $("#pAvatarRemove").style.display = "none";
  }
}

$("#pAvatar").dataset.placeholder = $("#pAvatar").src;

$("#pAvatarInput").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) return toast("Photo trop lourde : 2 Mo maximum.", "error");
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return toast("Format invalide : JPEG, PNG ou WebP uniquement.", "error");
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const res = await api("/upload/avatar", { method: "POST", body: JSON.stringify({ dataUri: reader.result }) });
      setAvatar(res.avatar_url);
      toast("Photo de profil mise à jour.");
    } catch (err) {
      toast(err.message, "error");
    }
    e.target.value = "";
  };
  reader.readAsDataURL(file);
});

$("#pAvatarRemove").addEventListener("click", async () => {
  try {
    await api("/upload/avatar", { method: "DELETE" });
    setAvatar(null);
    toast("Photo de profil supprimée.");
  } catch (err) {
    toast(err.message, "error");
  }
});

async function dashboard() {
  try {
    let d = await api(E.dashboard),
      x = d?.data || d;
    $("#sTasks").textContent = x.tasks_count ?? x.tasks ?? 0;
    $("#sTasksSub").textContent = (x.tasks_count ?? 0) === 0 ? "En attente" : `${x.tasks_count} en attente`;
    $("#sIncidents").textContent = x.open_incidents_count ?? x.incidents_open ?? 0;
    $("#sInterventions").textContent = x.interventions_count ?? x.interventions ?? 0;
    $("#sNotifications").textContent = x.unread_notifications_count ?? 0;
    badge("taskBadge", x.tasks_count || 0);
    badge("incidentBadge", x.open_incidents_count || 0);
    badge("notifBadge", x.unread_notifications_count || 0);
    render(
      "priorities",
      arr(x, "priorities"),
      (i) =>
        `<div class="card"><b>${esc(i.title || i.name || "Priorité")}</b>${status(i.status)}<div class="muted">${esc(i.description || "")}</div></div>`
    );
    render(
      "activity",
      arr(x, "recent_activity"),
      (i) => `<div class="card"><b>${esc(i.action || i.title || "Activité")}</b><div class="muted">${date(i.created_at)}</div></div>`
    );
  } catch (e) {
    toast(e.message, "error");
  }
}

function render(id, a, fn) {
  if (!a.length) return empty(id);
  $("#" + id).innerHTML = a.map(fn).join("");
}

// ============================================================
// Mes paiements : salaires + moyens de réception
// ============================================================

async function loadPaiements() {
  try {
    $("#moyensList").innerHTML = '<div class="empty">Chargement…</div>';
    $("#salairesList").innerHTML = '<div class="empty">Chargement…</div>';
    const [p, m] = await Promise.all([
      api(E.paiements).then((d) => arr(d, "paiements")),
      api(E.moyens).then((d) => arr(d, "moyens")),
    ]);
    renderMoyens(m);
    renderSalaires(p);
  } catch (e) {
    empty("moyensList", e.message);
    empty("salairesList", e.message);
    toast(e.message, "error");
  }
}

function renderMoyens(list) {
  S.moyens = list;
  const el = $("#moyensList");
  if (!list.length) {
    el.innerHTML = '<div class="empty">Aucun moyen de réception. Ajoutez-en un pour recevoir vos salaires.</div>';
    return;
  }
  el.innerHTML = list
    .map((m) => {
      const keys = ["nom_titulaire", "numero", "lien_paiement", "banque", "num_compte", "iban", "bic"];
      const details = keys
        .filter((k) => m[k])
        .map((k) => `<span>${MOYEN_FIELD_LABELS[k]} : ${esc(m[k])}</span>`)
        .join("<br>");
      return `<div class="card moyen ${m.actif === false ? "inactif" : ""}"><b>${MOYEN_TYPE_ICONS[m.type] || ""} ${
        esc(MOYEN_TYPE_LABELS[m.type] || m.type)
      }</b> ${m.actif === false ? '<span class="status st-non_recu">Inactif</span>' : ""}<div class="muted small">${
        details || "—"
      }</div>${m.instructions ? `<div class="muted small">${esc(m.instructions)}</div>` : ""}<div class="sal-actions"><button class="secondary small" data-edit="${
        m.id
      }">Modifier</button><button class="danger small" data-del="${m.id}">Supprimer</button></div></div>`;
    })
    .join("");
}

function renderSalaires(list) {
  const el = $("#salairesList");
  if (!list.length) {
    el.innerHTML = '<div class="empty">Aucun salaire enregistré. Votre employeur vous en déclarera ici.</div>';
    return;
  }
  el.innerHTML = list
    .map((p) => {
      const st = p.statut || "attente";
      let body = "";
      if (st === "attente") {
        body = `<div class="sal-actions"><button class="primary small" data-confirm="${p.id}">Confirmer la réception</button><button class="danger small" data-refuse="${p.id}">Je n'ai pas reçu</button></div>`;
      } else if (st === "paye") {
        body = `<div class="muted small ok">✔ Reçu — confirmé le ${dateTime(p.confirmed_at)}</div>`;
      } else if (st === "non_recu") {
        body = `<div class="muted small ko">✖ Non reçu le ${dateTime(p.rejected_at)} — ${esc(p.rejection_reason || "")}</div>`;
      }
      const meta = [p.moyen_label, MOYEN_TYPE_LABELS[p.methode_paiement] || null].filter(Boolean).join(" · ");
      const ref = p.reference ? "Réf. " + esc(p.reference) : "";
      return `<article class="card salaire"><span class="status st-${st}">${esc(SALAIRE_LABELS[st] || st)}</span><h3>${
        esc(p.mois) || "—"
      } — ${fmtMoney(p.montant)}</h3><div class="muted">${esc(meta || "—")}</div><div class="muted small">${
        p.date_paiement ? "Date de paiement : " + date(p.date_paiement) + (ref ? " · " + ref : "") : ref
      }</div>${body}</article>`;
    })
    .join("");
}

async function confirmPaiement(id) {
  if (!confirm("Confirmez-vous avoir bien reçu ce salaire ?")) return;
  try {
    const r = await api(E.paiements + "/" + id + "/confirmer", { method: "POST", body: "{}" });
    toast(r?.message || "Paiement confirmé");
    loadPaiements();
  } catch (x) {
    toast(x.message, "error");
  }
}

let refusId = null;
function openRefus(id) {
  refusId = id;
  $("#refusMotif").value = "Paiement non reçu";
  $("#refusDetail").value = "";
  $("#refusOverlay").classList.remove("hidden");
}
$("#refusSave").onclick = async () => {
  if (!refusId) return;
  let motif = $("#refusMotif").value;
  const detail = $("#refusDetail").value.trim();
  if (detail) motif = (motif + " — " + detail).slice(0, 200);
  try {
    const r = await api(E.paiements + "/" + refusId + "/non-recus", { method: "POST", body: JSON.stringify({ motif }) });
    refusId = null;
    $("#refusOverlay").classList.add("hidden");
    toast(r?.message || "Signalement enregistré");
    loadPaiements();
  } catch (x) {
    toast(x.message, "error");
  }
};

let editingMoyen = null;
function moyenFieldsHtml(type) {
  const fields = MOYEN_FIELDS[type] || [];
  return fields
    .map(([k]) => `<label>${MOYEN_FIELD_LABELS[k]}<input data-field="${k}" type="text"></label>`)
    .join("");
}
function openMoyenModal(m) {
  editingMoyen = m || null;
  $("#moyenModalTitle").textContent = m ? "Modifier le moyen de réception" : "Ajouter un moyen de réception";
  const type = m?.type || "wave";
  $("#moyenType").value = type;
  $("#moyenFields").innerHTML = moyenFieldsHtml(type);
  if (m) {
    for (const k of Object.keys(MOYEN_FIELD_LABELS)) {
      const inp = $(`[data-field="${k}"]`);
      if (inp && m[k] != null) inp.value = m[k];
    }
    $("#moyenActif").checked = m.actif !== false;
  } else {
    $("#moyenActif").checked = true;
  }
  $("#moyenOverlay").classList.remove("hidden");
}
$("#moyenType").onchange = (e) => {
  $("#moyenFields").innerHTML = moyenFieldsHtml(e.target.value);
};
$("#addMoyenBtn").onclick = () => openMoyenModal(null);
$("#moyenSave").onclick = async () => {
  const type = $("#moyenType").value;
  const body = { type, actif: $("#moyenActif").checked };
  for (const k of (MOYEN_FIELDS[type] || []).map((x) => x[0])) {
    const v = $(`[data-field="${k}"]`)?.value.trim();
    if (v) body[k] = v;
  }
  try {
    const r = editingMoyen
      ? await api(E.moyens + "/" + editingMoyen.id, { method: "PUT", body: JSON.stringify(body) })
      : await api(E.moyens, { method: "POST", body: JSON.stringify(body) });
    editingMoyen = null;
    $("#moyenOverlay").classList.add("hidden");
    toast(r?.message || "Moyen de paiement enregistré");
    loadPaiements();
  } catch (x) {
    toast(x.message, "error");
  }
};
$("#moyensList").onclick = (e) => {
  const ed = e.target.closest("[data-edit]");
  const del = e.target.closest("[data-del]");
  if (ed) {
    const m = (S.moyens || []).find((x) => String(x.id) === ed.dataset.edit);
    if (m) openMoyenModal(m);
  } else if (del) {
    if (!confirm("Supprimer ce moyen de réception ?")) return;
    api(E.moyens + "/" + del.dataset.del, { method: "DELETE" })
      .then(() => {
        toast("Moyen de paiement supprimé");
        loadPaiements();
      })
      .catch((x) => toast(x.message, "error"));
  }
};
$("#salairesList").onclick = (e) => {
  const c = e.target.closest("[data-confirm]");
  const r = e.target.closest("[data-refuse]");
  if (c) confirmPaiement(c.dataset.confirm);
  else if (r) openRefus(r.dataset.refuse);
};
$("#incidentsList").onclick = (e) => {
  const r = e.target.closest("[data-resolve]");
  if (r) resolveIncident(r.dataset.resolve);
};

async function resolveIncident(id) {
  try {
    await api(E.incidents + "/" + id + "/resoudre", { method: "POST", body: "{}" });
    toast("Incident résolu. Le propriétaire a été informé.");
    load("incidents");
  } catch (x) {
    toast(x.message, "error");
  }
}
for (const id of ["moyenOverlay", "refusOverlay"]) {
  const ov = $("#" + id);
  ov.addEventListener("click", (e) => {
    if (e.target === ov) ov.classList.add("hidden");
  });
  ov.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => ov.classList.add("hidden")));
}

// Applique les filtres (recherche + statut) sur la liste en cache et rend.
function paint(kind) {
  let id = kind + "List";
  let a = S[kind] || [];
  if (kind === "tasks" || kind === "incidents") {
    let q = ($("#" + kind + "Q")?.value || "").trim().toLowerCase();
    let s = $("#" + kind + "S")?.value || "";
    a = a.filter((x) => {
      if (s && x.status !== s) return false;
      if (!q) return true;
      const hay = `${x.titre || ""} ${x.description || ""} ${x.logement || ""} ${x.name || ""}`.toLowerCase();
      return hay.includes(q);
    });
    if (!a.length) return empty(id, "Aucun résultat pour ces filtres.");
  }
  render(id, a, cardFor(kind));
}

const INCIDENT_LABELS = { nouveau: "Nouveau", en_cours: "En cours", resolu: "Résolu" };

function incidentStatus(x) {
  const label = INCIDENT_LABELS[x] || x || "—";
  const cls = x === "resolu" ? "status ok" : x === "en_cours" ? "status warn" : "status danger";
  return `<span class="${cls}">${esc(label)}</span>`;
}

function cardFor(kind) {
  if (kind === "notifications") {
    return (x) =>
      `<div class="notice ${x.read || x.is_read ? "" : "unread"}"><b>${esc(x.title || "Notification")}</b><div class="muted">${esc(x.message || x.description || "")}</div><small>${date(x.created_at)}</small></div>`;
  }
  if (kind === "incidents") {
    return (x) => {
      const resolved = x.status === "resolu";
      return `<article class="card">
        <h3>${esc(x.titre || "Incident")} ${incidentStatus(x.status)}</h3>
        ${x.logement && x.logement !== "—" ? `<div class="muted"><b>${esc(x.logement)}</b>${x.tenant ? " — " + esc(x.tenant) : ""}</div>` : ""}
        <div class="muted">${esc(x.description || "")}</div>
        <small>${dateTime(x.created_at)}</small>
        ${resolved ? `<small class="muted">Résolu${x.resolved_at ? " le " + date(x.resolved_at) : ""}</small>` : `<button class="primary resolve-btn" data-resolve="${x.id}">Résoudre</button>`}
      </article>`;
    };
  }
  return (x) =>
    `<article class="card"><h3>${esc(x.title || x.name || kind)} ${status(x.status)}</h3><div class="muted">${esc(x.description || "")}</div><small>${date(x.due_date || x.scheduled_at || x.created_at)}</small></article>`;
}

async function load(kind) {
  let id = kind + "List";
  try {
    $("#" + id).innerHTML = '<div class="empty">Chargement…</div>';
    let d = await api(E[kind]),
      a = arr(d, kind);
    S[kind] = a;
    if (kind === "tasks") badge("taskBadge", a.filter((x) => x.status !== "termine").length);
    if (kind === "incidents") badge("incidentBadge", a.filter((x) => x.status !== "resolu").length);
    if (kind === "notifications") badge("notifBadge", a.filter((x) => !x.read && !x.is_read).length);
    if (kind === "logements" || kind === "locataires") {
      if (!a.length) return empty(id);
      let rows = a
        .map(
          (x) =>
            kind === "logements"
              ? `<tr><td>${esc(x.name || x.numero || x.reference)}</td><td>${esc(x.type || "—")}</td><td>${esc(x.tenant_name || x.locataire_name || "Libre")}</td><td>${esc(x.rent ?? x.loyer ?? "—")}</td></tr>`
              : `<tr><td>${esc(x.name || x.full_name)}</td><td>${esc(x.username)}</td><td>${esc(x.logement_name || x.logement || "—")}</td><td>${esc(x.status || "—")}</td></tr>`
        )
        .join("");
      $("#" + id).innerHTML = `<table class="table"><thead><tr>${
        kind === "logements"
          ? "<th>Logement</th><th>Type</th><th>Locataire</th><th>Loyer</th>"
          : "<th>Nom</th><th>Username</th><th>Logement</th><th>Statut</th>"
      }</tr></thead><tbody>${rows}</tbody></table>`;
    } else {
      paint(kind);
    }
  } catch (e) {
    empty(id, e.message);
    toast(e.message, "error");
  }
}

function view(v) {
  $$(".view").forEach((x) => x.classList.toggle("active", x.id === v));
  $$(".nav").forEach((x) => x.classList.toggle("active", x.dataset.view === v));
  $("#title").textContent = {
    overview: "Tableau de bord",
    tasks: "Mes tâches",
    incidents: "Incidents",
    interventions: "Interventions",
    logements: "Logements",
    locataires: "Locataires",
    notifications: "Notifications",
    paiements: "Mes paiements",
    profile: "Mon profil",
  }[v];
  $("#sidebar").classList.remove("open");
  if (v === "overview") dashboard();
  else if (v === "paiements") loadPaiements();
  else if (v !== "profile") load(v);
}

$$("[data-view]").forEach((x) => (x.onclick = () => view(x.dataset.view)));
$$("[data-refresh]").forEach(
  (x) => (x.onclick = () => (x.dataset.refresh === "paiements" ? loadPaiements() : load(x.dataset.refresh)))
);
$("#logout").onclick = async () => {
  try {
    await api(E.logout, { method: "POST", body: "{}" });
  } finally {
    location.href = "/PartPublic/connexion.html";
  }
};
$("#readAll").onclick = async () => {
  try {
    await api(E.notifications + "/read-all", { method: "POST", body: "{}" });
    toast("Notifications marquées comme lues");
    load("notifications");
  } catch (e) {
    toast(e.message, "error");
  }
};
$("#profileForm").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api(E.profile, {
      method: "PUT",
      body: JSON.stringify({
        name: $("#pName").value,
        username: $("#pUsername").value,
        email: $("#pEmail").value,
      }),
    });
    let n = $("#pNew").value;
    if (n) {
      if (n !== $("#pConfirm").value) throw Error("Les mots de passe ne correspondent pas.");
      await api(E.password, {
        method: "PUT",
        body: JSON.stringify({ current_password: $("#pCurrent").value, new_password: n }),
      });
    }
    toast("Profil mis à jour");
    await me();
  } catch (x) {
    toast(x.message, "error");
  }
};
$("#pNew").oninput = (e) => {
  $("#pwdHint").textContent = !e.target.value
    ? ""
    : e.target.value.length < 8
      ? "Faible"
      : e.target.value.length < 12
        ? "Moyen"
        : "Fort";
};

// Filtres de liste (recherche et statut) : re-rendu local, sans rechargement.
for (const kind of ["tasks", "incidents"]) {
  const q = $("#" + kind + "Q");
  const s = $("#" + kind + "S");
  if (q) q.addEventListener("input", () => paint(kind));
  if (s) s.addEventListener("change", () => paint(kind));
}

(async () => {
  try {
    await me();
    await dashboard();
  } catch (e) {
    toast(e.message, "error");
  }
})();
