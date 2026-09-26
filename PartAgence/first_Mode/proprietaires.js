let currentOwners = [];
let portfolioByOwner = new Map();
let selectedOwnerId = null;

function fmtShortFCFA(n) {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} M FCFA`;
  if (v >= 1_000) return `${(v / 1_000).toLocaleString("fr-FR", { maximumFractionDigits: 0 })} k FCFA`;
  return `${v} FCFA`;
}

function formatDate(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}

function openModal(id) {
  document.getElementById(id).style.display = "flex";
}

function closeModal(id) {
  document.getElementById(id).style.display = "none";
}

function ownerRow(o) {
  const biens = portfolioByOwner.get(o.proprietaire_id) || [];
  const expanded = selectedOwnerId === o.proprietaire_id;
  const biensHtml = expanded
    ? `<div class="owner-biens">${biens.length
        ? biens.map((p) => {
            const b = p.bien || {};
            return `
            <div class="owner-bien">
              <div>
                <strong>${escapeHtml(b.nom || `Bien #${p.bien_id}`)}</strong>
                <p class="muted">${escapeHtml(b.type || "")}${b.ville ? " — " + escapeHtml(b.ville) : ""} · ${fmtShortFCFA(b.loyer_total)} de loyers cumulés</p>
              </div>
              <a class="btn btn-edit btn-sm" href="/PartAgence/second_Mode/bien.html?bien=${p.bien_id}">Gérer</a>
            </div>`;
          }).join("")
        : '<div class="muted">Aucun bien géré pour le moment.</div>'}
      <button class="btn btn-primary btn-sm" data-add-bien="${o.proprietaire_id}">+ Ajouter un bien</button>
    </div>`
    : "";
  return `
    <div class="crud-card">
      <div>
        <h3>${escapeHtml(o.nom || "Propriétaire")}</h3>
        <p class="muted">
          ${escapeHtml(o.email || "")}${o.phone ? " · " + escapeHtml(o.phone) : ""}
          ${o.username ? " · @" + escapeHtml(o.username) : ""}
        </p>
        <p class="muted">${o.biens_count} bien(s) géré(s) · rattaché le ${formatDate(o.created_at)}</p>
      </div>
      <div class="crud-actions">
        <button class="btn btn-edit" data-toggle-bien="${o.proprietaire_id}" type="button">
          ${expanded ? "Masquer les biens" : "Voir les biens"}
        </button>
      </div>
      ${biensHtml}
    </div>`;
}

function renderOwners() {
  const el = document.getElementById("ownersList");
  if (!el) return;
  if (!currentOwners.length) {
    el.innerHTML = '<div class="empty-state"><span class="empty-ico">◉</span>Aucun propriétaire géré. Ajoutez votre premier propriétaire.</div>';
    return;
  }
  el.innerHTML = currentOwners.map(ownerRow).join("");
}

async function load() {
  try {
    const [ownersRes, portefeuilleRes] = await Promise.all([
      fetch(`${API}/agence/proprietaires`, { credentials: "include" }),
      fetch(`${API}/agence/portefeuille`, { credentials: "include" }),
    ]);

    for (const res of [ownersRes, portefeuilleRes]) {
      if (!res.ok) {
        const { ok: parsedOk, error } = await MIM.parse(res);
        if (parsedOk || !MIM.handleAuthError(error)) {
          throw new Error(MIM.userMessage(error) || "Erreur de chargement.");
        }
        return;
      }
    }

    const ownersJson = await ownersRes.json();
    const portefeuilleJson = await portefeuilleRes.json();

    currentOwners = (ownersJson.data || []).filter((o) => o.statut === "actif");
    portfolioByOwner = new Map();
    for (const p of portefeuilleJson.data || []) {
      if (p.proprietaire && p.bien) {
        const list = portfolioByOwner.get(p.proprietaire.id) || [];
        list.push(p);
        portfolioByOwner.set(p.proprietaire.id, list);
      }
    }

    renderOwners();
    loadNotificationsBadge();
  } catch (err) {
    const el = document.getElementById("ownersList");
    if (el) el.innerHTML = `<div class="empty-state">Impossible de charger la liste des propriétaires.</div>`;
    console.error(err);
  }
}

async function loadNotificationsBadge() {
  try {
    const { data } = await apiRequest("/notifications");
    const unread = (data || []).filter((n) => !n.lu).length;
    const badgeEl = document.getElementById("notifBadge");
    if (badgeEl) {
      badgeEl.textContent = unread;
      badgeEl.classList.toggle("show", unread > 0);
    }
  } catch (err) {
    console.error(err);
  }
}

/* ----------------------- Création d'un propriétaire ----------------------- */

function ownerFormPayload() {
  const form = document.getElementById("ownerForm");
  const get = (id) => document.getElementById(id).value.trim();
  const payload = { nom: get("nom") };
  if (get("email")) payload.email = get("email");
  if (get("phone")) payload.phone = get("phone");
  if (get("username")) payload.username = get("username");
  if (get("password")) payload.password = get("password");
  return payload;
}

async function submitOwner(e) {
  e.preventDefault();
  const form = document.getElementById("ownerForm");
  if (typeof clearFormErrors === "function") clearFormErrors(form);

  const submitBtn = form.querySelector('button[type="submit"]');
  const originalLabel = submitBtn ? submitBtn.textContent : "";
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Création...";
  }

  try {
    const data = await apiRequest("/agence/proprietaires", {
      method: "POST",
      body: JSON.stringify(ownerFormPayload()),
    });

    const summary = document.getElementById("ownerResultSummary");
    if (summary) {
      if (data.generatedUsername) {
        summary.innerHTML = `<p class="muted">Identifiants générés pour ${escapeHtml(ownerFormPayload().nom)} :</p>`;
      } else {
        summary.textContent = "Le propriétaire a été créé et rattaché à votre agence.";
      }
    }

    const box = document.getElementById("ownerAccountCredentials");
    if (box) {
      if (data.generatedUsername && data.generatedPassword) {
        box.style.display = "";
        const pre = document.createElement("pre");
        pre.textContent = `Nom d'utilisateur : ${data.generatedUsername}\nMot de passe : ${data.generatedPassword}`;
        pre.dataset.credentials = `${data.generatedUsername}\n${data.generatedPassword}`;
        box.prepend(pre);
      } else {
        box.style.display = "none";
      }
    }

    closeModal("ownerModal");
    form.reset();
    openModal("ownerResultModal");
    await load();
  } catch (err) {
    if (typeof applyServerErrors === "function" && err && err.errors) {
      applyServerErrors(form, err.errors);
    }
    showToast(err.message || "Erreur lors de la création.", "error");
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  }
}

/* --------------------------- Ajout d'un bien --------------------------- */

function bienFormPayload() {
  const present = (id) => {
    const v = document.getElementById(id).value.trim();
    return v ? v : undefined;
  };
  const payload = {
    nom: present("bienNom") || "",
    type: present("bienType") || "",
  };
  for (const id of ["bienAdresse", "bienVille", "bienPays", "bienDescription"]) {
    const v = present(id);
    if (v) payload[id.replace("bien", "").toLowerCase()] = v;
  }
  return payload;
}

async function submitBien(e) {
  e.preventDefault();
  const form = document.getElementById("bienForm");
  if (typeof clearFormErrors === "function") clearFormErrors(form);

  const ownerId = document.getElementById("bienOwnerId").value;
  const submitBtn = form.querySelector('button[type="submit"]');
  const originalLabel = submitBtn ? submitBtn.textContent : "";
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Création...";
  }

  try {
    await apiRequest(`/agence/proprietaires/${ownerId}/biens`, {
      method: "POST",
      body: JSON.stringify(bienFormPayload()),
    });
    showToast("Bien créé et ajouté au portefeuille.");
    closeModal("bienModal");
    form.reset();
    await load();
  } catch (err) {
    if (typeof applyServerErrors === "function" && err && err.errors) {
      applyServerErrors(form, err.errors);
    }
    showToast(err.message || "Erreur lors de la création du bien.", "error");
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  }
}

/* ------------------------------- Initialisation ------------------------------- */

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("addOwnerBtn").addEventListener("click", () => {
    document.getElementById("ownerForm").reset();
    if (typeof clearFormErrors === "function") clearFormErrors(document.getElementById("ownerForm"));
    openModal("ownerModal");
  });

  document.getElementById("ownerCancelBtn").addEventListener("click", () => closeModal("ownerModal"));
  document.getElementById("ownerResultCloseBtn").addEventListener("click", () => closeModal("ownerResultModal"));
  document.getElementById("ownerForm").addEventListener("submit", submitOwner);

  document.getElementById("bienCancelBtn").addEventListener("click", () => closeModal("bienModal"));
  document.getElementById("bienForm").addEventListener("submit", submitBien);

  document.getElementById("ownersList").addEventListener("click", (e) => {
    const toggle = e.target.closest("[data-toggle-bien]");
    if (toggle) {
      selectedOwnerId = selectedOwnerId === toggle.dataset.toggleBien ? null : toggle.dataset.toggleBien;
      renderOwners();
      return;
    }
    const addBien = e.target.closest("[data-add-bien]");
    if (addBien) {
      document.getElementById("bienOwnerId").value = addBien.dataset.addBien;
      document.getElementById("bienForm").reset();
      if (typeof clearFormErrors === "function") clearFormErrors(document.getElementById("bienForm"));
      openModal("bienModal");
    }
  });

  const copyBtn = document.getElementById("ownerCopyBtn");
  if (copyBtn) {
    copyBtn.addEventListener("click", () => {
      const pre = document.querySelector("#ownerAccountCredentials pre[data-credentials]");
      if (!pre) return;
      navigator.clipboard.writeText(pre.dataset.credentials).then(
        () => showToast("Identifiants copiés."),
        () => showToast("Copie impossible.", "error")
      );
    });
  }

  for (const [modalId, closeId] of [["ownerModal", "ownerCancelBtn"], ["bienModal", "bienCancelBtn"], ["ownerResultModal", "ownerResultCloseBtn"]]) {
    const overlay = document.getElementById(modalId);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal(modalId);
    });
  }

  load();

  const params = new URLSearchParams(window.location.search);
  const focus = params.get("proprietaire");
  if (focus) {
    window.addEventListener("load", () => {
      setTimeout(() => {
        selectedOwnerId = focus;
        if (currentOwners.some((o) => o.proprietaire_id === focus)) {
          renderOwners();
          const card = document.querySelector(`[data-toggle-bien="${focus}"]`);
          if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, 400);
    });
  }
});