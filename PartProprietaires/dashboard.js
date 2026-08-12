const API = "http://localhost:3000/api";

function displayMessage(text, type = "error") {
  const el = document.getElementById("apiMessage");
  if (!el) return;
  el.textContent = text;
  el.className = type;
  el.style.display = "block";
  setTimeout(() => (el.style.display = "none"), 4000);
}

async function loadStats() {
  try {
    const res = await fetch(`${API}/stats/dashboard`, {
      credentials: "include",
    });

    if (res.status === 401) {
      window.location.href = "../PartPublic/connexion.html";
      return;
    }

    const data = await res.json();

    if (!data.success) {
      displayMessage(data.message || "Erreur de chargement.");
      return;
    }

    const s = data.stats;

    const map = {
      totalProperties: s.totalProperties,
      occupiedProperties: s.occupiedProperties,
      availableProperties: s.availableProperties,
      expectedRent: `${s.expectedRent.toLocaleString("fr-FR")} FCFA`,
      paidRent: `${s.paidRent.toLocaleString("fr-FR")} FCFA`,
      lateRent: `${s.lateRent.toLocaleString("fr-FR")} FCFA`,
      activeIncidents: s.activeIncidents,
      activeInterventions: s.activeInterventions,
    };

    for (const [id, value] of Object.entries(map)) {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    }
  } catch (error) {
    displayMessage("Impossible de contacter le serveur.");
    console.error(error);
  }
}

async function loadUserName() {
  try {
    const res = await fetch(`${API}/auth/me`, { credentials: "include" });
    const data = await res.json();
    if (data.success) {
      const el = document.getElementById("ownerName");
      if (el) el.textContent = data.user.name;
    }
  } catch (error) {
    console.error(error);
  }
}

async function logout() {
  try {
    await fetch(`${API}/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
  } catch (error) {
    console.error(error);
  }
  window.location.href = "../PartPublic/connexion.html";
}

async function manualBackup() {
  try {
    const res = await fetch(`${API}/git/backup`, {
      method: "POST",
      credentials: "include",
    });
    const data = await res.json();
    displayMessage(data.message, data.success ? "success" : "error");
  } catch (error) {
    displayMessage("Impossible de contacter le serveur.");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadUserName();
  loadStats();

  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) logoutBtn.addEventListener("click", logout);

  const backupBtn = document.getElementById("backupBtn");
  if (backupBtn) backupBtn.addEventListener("click", manualBackup);
});
