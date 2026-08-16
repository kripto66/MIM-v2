// ============================================================
// MIM - Assistant de première configuration (onboarding)
//
// À la première connexion d'un propriétaire dont l'espace est
// encore vide, affiche une modale d'accueil avec deux parcours :
//   📥 Importer mes données      → import.html
//   ⚙️ Configurer manuellement   → continue sur le parcours classique
//   Plus tard                    → mémorise le choix dans localStorage
//
// L'assistant reste accessible depuis le dashboard (bouton de
// configuration) et depuis les paramètres (section Importation).
// ============================================================

const Onboarding = (() => {
  const LS_KEY = "mim_onboarding_dismissed";

  function dismissed() {
    try {
      return localStorage.getItem(LS_KEY) === "1";
    } catch {
      return false;
    }
  }

  function dismiss() {
    try {
      localStorage.setItem(LS_KEY, "1");
    } catch {
      /* stockage indisponible */
    }
  }

  // Vérifie si l'espace du propriétaire est vide (premier accès).
  async function status() {
    const res = await fetch(`${API}/onboarding/status`, { credentials: "include" });
    const parsed = await MIM.parse(res);
    if (!parsed.ok) return null;
    return parsed.data && parsed.data.success ? parsed.data : null;
  }

  // Affiche la modale d'accueil quand l'espace est vide et que le
  // propriétaire ne l'a pas déjà reportée.
  async function maybeShow() {
    if (dismissed()) return false;

    let st = null;
    try {
      st = await status();
    } catch {
      return false;
    }
    if (!st || !st.needsOnboarding) return false;

    renderModal();
    return true;
  }

  function renderModal() {
    if (document.getElementById("onboardingModal")) return;

    const modal = document.createElement("div");
    modal.className = "modal-overlay onboarding-overlay";
    modal.id = "onboardingModal";
    modal.innerHTML = `
      <div class="modal onboarding-modal">
        <div class="onboarding-logo">MIM</div>
        <h2>Bienvenue sur MyImmoManagement 👋</h2>
        <p class="onboarding-sub">
          Configurez votre espace en quelques étapes. Vous pouvez importer vos
          données existantes ou commencer manuellement.
        </p>
        <div class="onboarding-choices">
          <button type="button" class="onboarding-choice" data-action="import">
            <span class="oc-ico">📥</span>
            <span>
              <strong>Importer mes données</strong>
              <small>Biens, logements, locataires et employés via des fichiers CSV.</small>
            </span>
          </button>
          <button type="button" class="onboarding-choice" data-action="manual">
            <span class="oc-ico">⚙️</span>
            <span>
              <strong>Configurer manuellement</strong>
              <small>Créez vos biens, logements, locataires et employés un par un.</small>
            </span>
          </button>
        </div>
        <button type="button" class="onboarding-later" data-action="later">Plus tard</button>
      </div>
    `;

    modal.addEventListener("click", (e) => {
      if (e.target === modal) return; // pas de fermeture au clic extérieur
    });

    modal.querySelector('[data-action="import"]').addEventListener("click", () => {
      window.location.href = "import.html";
    });
    modal.querySelector('[data-action="manual"]').addEventListener("click", () => {
      dismiss();
      modal.remove();
    });
    modal.querySelector('[data-action="later"]').addEventListener("click", () => {
      dismiss();
      modal.remove();
    });

    document.body.appendChild(modal);
  }

  // Indique si l'espace est encore vide (pour les boutons « reprendre »).
  async function needsSetup() {
    const st = await status();
    return Boolean(st && st.needsOnboarding);
  }

  return { maybeShow, needsSetup, dismiss };
})();