// ============================================================
// MIM - Assistant d'importation de données (PartProprietaires)
//
// Étapes :
//   1. Choix des catégories à importer
//   2. Modèles à télécharger + exemples
//   3. Sélection des fichiers CSV
//   4. Vérification (aperçu + erreurs + doublons)
//   5. Rapport final + téléchargement des identifiants
// ============================================================

const CATS = {
  biens: { label: "Biens" },
  logements: { label: "Logements" },
  locataires: { label: "Locataires" },
  employes: { label: "Employés" },
};

const CATEGORY_ORDER = ["biens", "logements", "locataires", "employes"];

// Exemples affichés à l'étape « Modèle » (les mêmes que ceux du serveur).
// Valeurs génériques : elles ne représentent aucune personne ni aucun bien réel.
const MODEL_EXAMPLES = {
  biens: {
    headers: ["nom", "type", "adresse", "ville", "pays", "description"],
    rows: [
      ["Bien Exemple 1", "immeuble", "Adresse exemple 1", "Dakar", "Sénégal", "Description du bien"],
      ["Bien Exemple 2", "villa", "Adresse exemple 2", "Dakar", "Sénégal", ""],
    ],
    hint: "Type : immeuble, villa, maison, terrain…",
  },
  logements: {
    headers: ["bien", "nom", "type", "loyer", "nombre_chambres", "adresse", "statut", "description"],
    rows: [
      ["Bien Exemple 1", "Logement Exemple 1", "appartement", "150000", "2", "Adresse exemple 1", "libre", "Étage 1, balcon"],
      ["Bien Exemple 1", "Logement Exemple 2", "chambre", "50000", "", "", "libre", ""],
    ],
    hint: "« Bien » doit correspondre à un bien déjà créé (ou importé dans le même fichier). Type : appartement ou chambre.",
  },
  locataires: {
    headers: ["nom", "prenom", "email", "telephone", "bien", "logement", "loyer", "jour_echeance", "date_entree", "statut"],
    rows: [
      ["Nom Exemple 1", "Prenom Exemple 1", "locataire1@exemple.com", "+221700000001", "Bien Exemple 1", "Logement Exemple 1", "150000", "5", "2026-09-01", "actif"],
      ["Nom Exemple 2", "Prenom Exemple 2", "", "+221700000002", "Bien Exemple 1", "Logement Exemple 2", "50000", "10", "2026-09-01", "actif"],
    ],
    hint: "Le username du compte locataire est généré automatiquement (ex. amadou.diop). Mot de passe initial : 1234 (à changer à la première connexion).",
  },
  employes: {
    headers: ["nom", "prenom", "email", "telephone", "poste", "bien", "salaire", "date_embauche", "statut"],
    rows: [
      ["Nom Exemple 1", "Prenom Exemple 1", "employe1@exemple.com", "+221700000003", "Gérant", "", "80000", "2026-09-01", "actif"],
      ["Nom Exemple 2", "Prenom Exemple 2", "", "+221700000004", "Agent d'entretien", "", "35000", "2026-09-01", "actif"],
    ],
    hint: "Salaire : montant mensuel. Le compte employé est créé automatiquement (username généré, mot de passe initial 1234).",
  },
};

const state = {
  step: 1,
  categories: [],
  files: {}, // cat -> { filename, content_b64 }
  preview: null,
  duplicatePolicy: "ignore",
  initialPassword: "1234",
};

// ------------------------------------------------------------
// Navigation entre les étapes
// ------------------------------------------------------------

function setStep(n) {
  state.step = n;
  for (let i = 1; i <= 5; i++) {
    const pane = document.getElementById(`step${i}`);
    if (pane) pane.hidden = i !== n;
    const dot = document.querySelector(`.wizard-step[data-wstep="${i}"]`);
    if (dot) {
      dot.classList.toggle("active", i === n);
      dot.classList.toggle("done", i < n);
    }
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function selectedCats() {
  return CATEGORY_ORDER.filter((c) => state.categories.includes(c));
}

// ------------------------------------------------------------
// Étape 2 : affichage des modèles / exemples
// ------------------------------------------------------------

function renderModels() {
  const list = document.getElementById("modelsList");
  const cats = selectedCats();

  list.innerHTML = cats
    .map((cat) => {
      const ex = MODEL_EXAMPLES[cat];
      const header = `<tr>${ex.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`;
      const rows = ex.rows
        .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
        .join("");
      return `
        <div class="wizard-model">
          <div class="wmodel-head">
            <div>
              <h3>Exemple — ${CATS[cat].label}</h3>
              <p class="muted">${escapeHtml(ex.hint)}</p>
            </div>
            <button type="button" class="btn btn-secondary" data-model="${cat}">Télécharger le modèle CSV</button>
          </div>
          <div class="wmodel-table">
            <table>
              <thead>${header}</thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
          <p class="muted wmodel-note">
            Vous pouvez télécharger cet exemple, le remplir avec vos données, puis le réimporter dans MIM.
          </p>
        </div>`;
    })
    .join("");
}

// ------------------------------------------------------------
// Étape 3 : sélection des fichiers
// ------------------------------------------------------------

function renderFileInputs() {
  const list = document.getElementById("filesList");
  const cats = selectedCats();

  list.innerHTML = cats
    .map((cat) => {
      const f = state.files[cat];
      return `
        <div class="wizard-file">
          <label for="file-${cat}">
            <strong>${CATS[cat].label}</strong>
            ${f ? `<span class="wfile-ok">✓ ${escapeHtml(f.filename)}</span>` : ""}
          </label>
          <input type="file" id="file-${cat}" accept=".csv,.txt,text/csv" data-filecat="${cat}">
          <small class="muted">Format CSV (virgule ou point-virgule). Colonnes du modèle téléchargé.</small>
        </div>`;
    })
    .join("");
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = String(reader.result).split(",")[1] || "";
      resolve(b64);
    };
    reader.onerror = () => reject(new Error("Lecture du fichier impossible."));
    reader.readAsDataURL(file);
  });
}

// ------------------------------------------------------------
// Étape 4 : vérification (preview)
// ------------------------------------------------------------

async function runPreview() {
  const box = document.getElementById("previewLoading");
  const result = document.getElementById("previewResult");
  box.hidden = false;
  result.hidden = true;

  try {
    const files = {};
    for (const cat of selectedCats()) {
      files[cat] = state.files[cat];
    }

    const res = await apiRequest("/import/preview", {
      method: "POST",
      body: JSON.stringify({
        categories: selectedCats(),
        files,
        duplicatePolicy: state.duplicatePolicy,
      }),
    });

    state.preview = res;
    renderPreview(res);
    box.hidden = true;
    result.hidden = false;
  } catch (err) {
    box.hidden = true;
    showToast(err.message, "error");
  }
}

function renderPreview(p) {
  // Résumé global
  const summary = document.getElementById("previewSummary");
  const catsHtml = p.categories
    .map(
      (c) => `
      <span class="wprev-pill ${c.errors.length ? "wprev-err" : c.duplicates.length ? "wprev-dup" : "wprev-ok"}">
        ${escapeHtml(c.label)} : ${c.ok} valide${c.ok > 1 ? "s" : ""}
        ${c.errors.length ? ` · ⚠️ ${c.errors.length} erreur${c.errors.length > 1 ? "s" : ""}` : ""}
        ${c.duplicates.length ? ` · 🔁 ${c.duplicates.length} doublon${c.duplicates.length > 1 ? "s" : ""}` : ""}
      </span>`
    )
    .join("");

  summary.innerHTML = `
    <h3>Résultat de l'analyse</h3>
    <div class="wprev-pills">${catsHtml}</div>
    ${p.totals.errors ? `<p class="wprev-blocked">⚠️ L'import est bloqué : corrigez les erreurs signalées puis revenez.</p>` : ""}
  `;

  // Détail par catégorie
  const cats = document.getElementById("previewCats");
  cats.innerHTML = p.categories
    .map((c) => {
      const errorHtml = c.errors
        .map(
          (e) => `
          <li class="wprev-line">
            <span class="wprev-line-num">${e.line ? "Ligne " + e.line : "En-tête"}</span>
            ${escapeHtml(e.message)}
          </li>`
        )
        .join("");
      const dupHtml = c.duplicates
        .map(
          (d) => `
          <li class="wprev-line">
            <span class="wprev-line-num">${d.line ? "Ligne " + d.line : ""}</span>
            ${escapeHtml(d.message)}
          </li>`
        )
        .join("");
      const warnHtml = c.warnings
        .map(
          (w) => `
          <li class="wprev-line wprev-warn">
            <span class="wprev-line-num">${w.line ? "Ligne " + w.line : ""}</span>
            ${escapeHtml(w.message)}
          </li>`
        )
        .join("");
      const sampleHtml = c.sample
        .map(
          (s) => `
          <tr>
            <td>${s.line}</td>
            <td>${escapeHtml(s.apercu)}</td>
            ${s.username ? `<td>${escapeHtml(s.username)}</td>` : ""}
          </tr>`
        )
        .join("");

      return `
        <div class="wizard-preview-cat ${c.errors.length ? "wprev-cat-err" : ""}">
          <div class="wcat-head">
            <h3>${escapeHtml(c.label)} — ${c.filename ? escapeHtml(c.filename) : "fichier"}</h3>
            <span class="wprev-count">
              ${c.ok} valide${c.ok > 1 ? "s" : ""} / ${c.total} ligne${c.total > 1 ? "s" : ""}
            </span>
          </div>

          ${c.errors.length ? `
            <div class="wprev-errors">
              <h4>❌ Erreurs</h4>
              <ul>${errorHtml}</ul>
            </div>` : ""}

          ${c.duplicates.length ? `
            <div class="wprev-errors wprev-dups">
              <h4>🔁 Doublons (à traiter selon la politique choisie)</h4>
              <ul>${dupHtml}</ul>
            </div>` : ""}

          ${warnHtml ? `
            <div class="wprev-errors wprev-warns">
              <h4>ℹ️ Avertissements</h4>
              <ul>${warnHtml}</ul>
            </div>` : ""}

          ${c.accounts.length ? `
            <p class="muted wprev-accounts">
              👤 ${c.accounts.length} compte${c.accounts.length > 1 ? "s" : ""} de connexion sera${c.accounts.length > 1 ? "ont" : ""} créé${c.accounts.length > 1 ? "s" : ""} automatiquement.
            </p>` : ""}

          ${c.sample.length ? `
            <details class="wprev-sample">
              <summary>Aperçu des données (${c.sample.length} premières lignes)</summary>
              <table class="wprev-table">
                <thead>
                  <tr>
                    <th>Ligne</th>
                    <th>Aperçu</th>
                    ${c.accounts.length ? "<th>Username généré</th>" : ""}
                  </tr>
                </thead>
                <tbody>${sampleHtml}</tbody>
              </table>
            </details>` : ""}
        </div>`;
    })
    .join("");

  // Boîte des doublons (politique) : visible si au moins un doublon.
  const hasDups = p.categories.some((c) => c.duplicates.length > 0);
  document.getElementById("dupsBox").hidden = !hasDups;

  // Bouton importer : bloqué si erreurs de validation.
  const importBtn = document.getElementById("wImport");
  importBtn.disabled = p.totals.errors > 0;
}

// ------------------------------------------------------------
// Étape 5 : exécution + rapport final
// ------------------------------------------------------------

async function runImport() {
  const btn = document.getElementById("wImport");
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Importation en cours…";

  try {
    const files = {};
    for (const cat of selectedCats()) {
      files[cat] = state.files[cat];
    }

    const res = await apiRequest("/import/execute", {
      method: "POST",
      body: JSON.stringify({
        categories: selectedCats(),
        files,
        duplicatePolicy: state.duplicatePolicy,
      }),
    });

    state.initialPassword = res.initialPassword || "1234";
    renderFinal(res);
    setStep(5);
  } catch (err) {
    showToast(err.message, "error");
    if (err.prepared) {
      state.preview = err.prepared;
      renderPreview(err.prepared);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function renderFinal(res) {
  const box = document.getElementById("finalReport");
  const r = res.report;
  const labels = {
    biens: "Biens créés",
    logements: "Logements créés",
    locataires: "Locataires créés",
    employes: "Employés créés",
  };

  const rows = r.categories
    .map((c) => {
      const parts = [`${c.created} ${labels[c.category] || c.label}`];
      if (c.updated) parts.push(`${c.updated} mis à jour`);
      if (c.ignored) parts.push(`${c.ignored} ignorés (doublons)`);
      return `<li>${parts.join(" · ")}</li>`;
    })
    .join("");

  const errCount = r.categories.reduce((s, c) => s + c.rowErrors.length, 0);
  const accounts = r.accounts || [];

  box.innerHTML = `
    <div class="wizard-final">
      <h2>🎉 Importation terminée</h2>
      <ul class="wfinal-list">${rows}</ul>
      <p class="wfinal-accounts">Comptes de connexion créés : <strong>${r.totals.accounts}</strong></p>
      <p class="wfinal-err ${errCount ? "wfinal-err-warn" : ""}">${errCount ? `⚠️ ${errCount} ligne(s) en erreur technique (voir détails ci-dessous).` : "✅ Aucune erreur."}</p>

      <p class="muted">
        Les nouveaux utilisateurs devront changer leur mot de passe lors de leur première connexion.
        Le mot de passe initial <strong>${escapeHtml(state.initialPassword)}</strong> est temporaire : il ne doit pas être conservé comme mot de passe permanent.
      </p>

      ${
        accounts.length
          ? `
        <div class="wfinal-accounts-box">
          <div class="wfinal-acc-head">
            <h3>Informations de connexion</h3>
            <button type="button" class="btn btn-secondary" id="downloadCreds">Télécharger les identifiants</button>
          </div>
          <table class="wprev-table">
            <thead>
              <tr>
                <th>Nom</th>
                <th>Username</th>
                <th>Mot de passe initial</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              ${accounts
                .map(
                  (a) => `
                  <tr>
                    <td>${escapeHtml(a.nom || "")}</td>
                    <td>${escapeHtml(a.username)}</td>
                    <td>${escapeHtml(state.initialPassword)}</td>
                    <td>${escapeHtml(a.account_type === "locataire" ? "Locataire" : "Employé")}</td>
                  </tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>
        <p class="muted">
          ⚠️ Ces identifiants ne sont affichés qu'une fois. Transmettez-les aux personnes concernées :
          elles devront choisir un nouveau mot de passe à leur première connexion.
        </p>`
          : ""
      }

      ${errCount ? `
        <div class="wprev-errors">
          <h4>Détails des lignes en erreur</h4>
          <ul>
            ${r.categories
              .flatMap((c) =>
                c.rowErrors.map(
                  (e) => `<li class="wprev-line"><span class="wprev-line-num">${c.label} · Ligne ${e.line}</span>${escapeHtml(e.message)}</li>`
                )
              )
              .join("")}
          </ul>
        </div>` : ""}
    </div>
  `;

  const dl = document.getElementById("downloadCreds");
  if (dl) dl.addEventListener("click", () => downloadCredentials(accounts));
}

function downloadCredentials(accounts) {
  const header = "Nom;Username;Mot de passe initial;Type";
  const rows = accounts.map((a) =>
    [
      String(a.nom || "").replace(/;/g, ","),
      a.username,
      state.initialPassword,
      a.account_type === "locataire" ? "Locataire" : "Employé",
    ].join(";")
  );
  const csv = "\uFEFF" + [header, ...rows].join("\n") + "\n";
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "identifiants_mim.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ------------------------------------------------------------
// Téléchargement d'un modèle CSV
// ------------------------------------------------------------

async function downloadModel(cat) {
  try {
    const res = await fetch(`${API}/import/templates/${cat}`, { credentials: "include" });
    if (!res.ok) throw new Error("Téléchargement impossible.");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `modele_${cat}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ------------------------------------------------------------
// Initialisation
// ------------------------------------------------------------

function resetToStep1() {
  state.categories = [];
  state.files = {};
  state.preview = null;
  state.duplicatePolicy = "ignore";
  for (const cb of document.querySelectorAll('input[data-cat]')) cb.checked = false;
  setStep(1);
}

document.addEventListener("DOMContentLoaded", () => {
  // Étape 1 → 2
  document.getElementById("wNext1").addEventListener("click", () => {
    const cats = CATEGORY_ORDER.filter((c) => document.querySelector(`input[data-cat="${c}"]`)?.checked);
    if (!cats.length) {
      showToast("Sélectionnez au moins une catégorie.", "error");
      return;
    }
    state.categories = cats;
    renderModels();
    setStep(2);
  });

  document.getElementById("wCancel1").addEventListener("click", () => {
    window.location.href = "dashboard.html";
  });

  // Modèles
  document.getElementById("modelsList").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-model]");
    if (btn) downloadModel(btn.dataset.model);
  });

  document.getElementById("wBack2").addEventListener("click", () => resetToStep1());
  document.getElementById("wNext2").addEventListener("click", () => {
    renderFileInputs();
    setStep(3);
  });

  // Fichiers
  document.getElementById("filesList").addEventListener("change", async (e) => {
    const input = e.target;
    const cat = input.dataset.filecat;
    if (!cat || !input.files?.length) return;
    const file = input.files[0];

    if (file.size > 1_500_000) {
      showToast("Fichier trop volumineux (maximum 1,5 Mo).", "error");
      input.value = "";
      return;
    }

    try {
      const content_b64 = await readFileAsBase64(file);
      state.files[cat] = { filename: file.name, content_b64 };
      renderFileInputs();
    } catch (err) {
      showToast(err.message, "error");
      input.value = "";
    }
  });

  document.getElementById("wBack3").addEventListener("click", () => setStep(2));
  document.getElementById("wNext3").addEventListener("click", () => {
    const missing = selectedCats().filter((c) => !state.files[c]);
    if (missing.length) {
      showToast(`Fichier manquant : ${missing.map((c) => CATS[c].label).join(", ")}.`, "error");
      return;
    }
    setStep(4);
    runPreview();
  });

  // Vérification
  document.getElementById("wBack4").addEventListener("click", () => setStep(3));

  document.querySelectorAll('input[name="dupPolicy"]').forEach((r) => {
    r.addEventListener("change", () => {
      state.duplicatePolicy = document.querySelector('input[name="dupPolicy"]:checked').value;
    });
  });

  document.getElementById("wImport").addEventListener("click", runImport);

  // Terminé
  document.getElementById("wDone5").addEventListener("click", () => resetToStep1());
});