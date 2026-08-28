const ACCOUNT_TYPE_LABEL = {
    proprietaire: "Propriétaire",
    agence: "Agence immobilière",
    entreprise: "Entreprise",
};

async function loadProfile() {
    try {
        const { user } = await apiRequest("/auth/me");
        document.getElementById("name").value = user.name || "";
        document.getElementById("email").value = user.email || "";
        document.getElementById("phone").value = user.phone || "";
        document.getElementById("account_type").value =
            ACCOUNT_TYPE_LABEL[user.account_type] || user.account_type;
        setAvatar(user.avatar_url || null);
    } catch (err) {
        showToast(err.message, "error");
    }
}

function setAvatar(url) {
    const img = document.getElementById("avatarPreview");
    if (url) {
        img.src = url;
        document.getElementById("avatarRemoveBtn").style.display = "";
    } else {
        img.src = img.dataset.placeholder || img.src;
        document.getElementById("avatarRemoveBtn").style.display = "none";
    }
}

function fmtDateFR(value) {
    if (!value) return "—";
    const d = new Date(value);
    return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("fr-FR");
}

async function loadSubscription() {
    const panel = document.getElementById("subscriptionPanel");
    try {
        const { subscription } = await apiRequest("/subscription/me");
        if (!subscription) {
            panel.innerHTML =
                '<p class="muted">Aucun abonnement enregistré. Contactez l\'administration MIM pour souscrire.</p>';
            return;
        }
        const badge =
            subscription.statut === "actif"
                ? '<span class="sub-badge sub-ok">Abonnement actif</span>'
                : '<span class="sub-badge sub-exp">Abonnement expiré</span>';
        panel.innerHTML =
            '<div class="sub-card">' +
            '<div class="sub-head">' + badge +
            "<span>Plan : <strong>" + (subscription.plan || "standard") + "</strong></span>" +
            "<span>Jours restants : <strong>" + subscription.joursRestants + "</strong></span>" +
            "</div>" +
            "<ul class='sub-list'>" +
            "<li>Début : " + fmtDateFR(subscription.date_debut) + "</li>" +
            "<li>Expiration : " + fmtDateFR(subscription.date_expiration) + "</li>" +
            "<li>Dernier paiement : " + fmtDateFR(subscription.date_paiement) + "</li>" +
            "<li>Montant : " + (subscription.montant != null ? subscription.montant.toLocaleString("fr-FR") + " FCFA" : "—") + "</li>" +
            "<li>Méthode : " + (subscription.methode_paiement || "—") + "</li>" +
            "<li>Référence : " + (subscription.reference || "—") + "</li>" +
            "</ul></div>";
    } catch (err) {
        panel.innerHTML = "<p class='muted'>Impossible de charger l'abonnement : " + escapeHtml(err.message) + "</p>";
    }
}

const TYPE_LABELS = {
    wave: "Wave",
    orange_money: "Orange Money",
    virement: "Virement bancaire",
    especes: "Espèces",
};

const TYPE_ICONS = { wave: "🟣", orange_money: "🟠", virement: "🏦", especes: "💵" };

const TYPE_FIELDS = {
    wave: ["nom_titulaire", "numero", "lien_paiement"],
    orange_money: ["nom_titulaire", "numero", "lien_paiement"],
    virement: ["banque", "nom_titulaire", "num_compte"],
    especes: [],
};

let moyensCache = [];

async function loadMoyens() {
    const list = document.getElementById("moyensList");
    try {
        const res = await apiRequest("/moyens-paiement");
        const items = res.data || [];
        moyensCache = items;
        if (!items.length) {
            list.innerHTML = '<p class="muted">Aucun moyen configuré. Ajoutez-en un pour permettre à vos locataires de payer.</p>';
            return;
        }
        list.innerHTML = items.map((m) => `
            <div class="crud-card">
                <div>
                    <h3>${TYPE_ICONS[m.type] || "💰"} ${TYPE_LABELS[m.type] || m.type}</h3>
                    ${m.nom_titulaire ? `<p>${escapeHtml(m.nom_titulaire)}</p>` : ""}
                    ${m.numero ? `<p class="pay-methode">${escapeHtml(m.numero)}</p>` : ""}
                    ${m.banque ? `<p class="pay-methode">${escapeHtml(m.banque)}${m.num_compte ? " — " + escapeHtml(m.num_compte) : ""}</p>` : ""}
${m.lien_paiement ? `<p><a href="${escapeAttr(m.lien_paiement)}" target="_blank" rel="noopener">${escapeHtml(m.lien_paiement)}</a></p>` : ""}
                    ${m.paydunya_alias ? `<p class="pay-methode">PayDunya : ${escapeHtml(m.paydunya_alias)}</p>` : ""}
                    ${m.pour_versement ? `<p class="pay-hint">✅ Réception des versements PayDunya</p>` : ""}
                    ${m.instructions ? `<p class="pay-hint">${escapeHtml(m.instructions)}</p>` : ""}
                    <p class="pay-hint">${m.actif ? "Actif" : "Inactif"}</p>
                </div>
                <div class="card-actions">
                    <button class="btn btn-edit" data-editmoyen="${m.id}">Modifier</button>
                    <button class="btn btn-delete" data-deletemoyen="${m.id}">Supprimer</button>
                </div>
            </div>`).join("");
    } catch (err) {
        list.innerHTML = `<p class="muted">${escapeHtml(err.message)}</p>`;
    }
}

function escapeAttr(v) {
    return String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function applyTypeVisibility(type) {
    const fields = TYPE_FIELDS[type] || [];
    const show = (id, visible) => {
        const el = document.getElementById(id);
        if (el) el.style.display = visible ? "block" : "none";
    };
    show("moyenTitulaireGroup", fields.includes("nom_titulaire"));
    show("moyenNumeroGroup", fields.includes("numero"));
    show("moyenLienGroup", fields.includes("lien_paiement"));
    show("moyenBanqueGroup", fields.includes("banque"));
    show("moyenCompteGroup", fields.includes("num_compte"));
}

function openMoyenModal(moyen) {
    document.getElementById("moyenId").value = moyen ? moyen.id : "";
    document.getElementById("moyenModalTitle").textContent = moyen ? "Modifier le moyen de paiement" : "Ajouter un moyen de paiement";
    document.getElementById("moyenType").value = moyen ? moyen.type : "wave";
    document.getElementById("moyenTitulaire").value = moyen?.nom_titulaire || "";
    document.getElementById("moyenNumero").value = moyen?.numero || "";
    document.getElementById("moyenLien").value = moyen?.lien_paiement || "";
    document.getElementById("moyenBanque").value = moyen?.banque || "";
    document.getElementById("moyenCompte").value = moyen?.num_compte || "";
    document.getElementById("moyenInstructions").value = moyen?.instructions || "";
    document.getElementById("moyenAlias").value = moyen?.paydunya_alias || "";
    document.getElementById("moyenPourVersement").checked = moyen?.pour_versement === true;
    applyTypeVisibility(document.getElementById("moyenType").value);
    document.getElementById("moyenModal").style.display = "flex";
}

async function saveMoyen(e) {
    e.preventDefault();
    const id = document.getElementById("moyenId").value;
    const type = document.getElementById("moyenType").value;
    const payload = {
        type,
        nom_titulaire: document.getElementById("moyenTitulaire").value.trim() || null,
        numero: document.getElementById("moyenNumero").value.trim() || null,
        lien_paiement: document.getElementById("moyenLien").value.trim() || null,
        banque: document.getElementById("moyenBanque").value.trim() || null,
num_compte: document.getElementById("moyenCompte").value.trim() || null,
        instructions: document.getElementById("moyenInstructions").value.trim() || null,
        paydunya_alias: document.getElementById("moyenAlias").value.trim() || null,
        pour_versement: document.getElementById("moyenPourVersement").checked,
    };
    try {
        const res = await apiRequest(id ? `/moyens-paiement/${id}` : "/moyens-paiement", {
            method: id ? "PUT" : "POST",
            body: JSON.stringify(payload),
        });
        document.getElementById("moyenModal").style.display = "none";
        showToast(res.message || "Moyen enregistré.");
        loadMoyens();
    } catch (err) {
        showToast(err.message, "error");
    }
}

document.addEventListener("DOMContentLoaded", () => {
    loadProfile();
    loadSubscription();
    loadMoyens();

    Onboarding.needsSetup()
        .then((needs) => {
            const link = document.getElementById("resumeSetupLink");
            if (link) link.hidden = !needs;
        })
        .catch(() => {});

    document.getElementById("profileForm").addEventListener("submit", async (e) => {
        e.preventDefault();

        try {
            await apiRequest("/auth/update-profile", {
                method: "PUT",
                body: JSON.stringify({
                    name: document.getElementById("name").value,
                    phone: document.getElementById("phone").value,
                }),
            });
            showToast("Profil mis à jour avec succès.");
        } catch (err) {
            showToast(err.message, "error");
        }
    });

    const avatarImg = document.getElementById("avatarPreview");
    avatarImg.dataset.placeholder = avatarImg.src;

    document.getElementById("avatarInput").addEventListener("change", async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) {
            showToast("Photo trop lourde : 2 Mo maximum.", "error");
            e.target.value = "";
            return;
        }
        if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
            showToast("Format invalide : JPEG, PNG ou WebP uniquement.", "error");
            e.target.value = "";
            return;
        }
        const reader = new FileReader();
        reader.onload = async () => {
            try {
                const res = await apiRequest("/upload/avatar", {
                    method: "POST",
                    body: JSON.stringify({ dataUri: reader.result }),
                });
                setAvatar(res.avatar_url);
                showToast("Photo de profil mise à jour.");
            } catch (err) {
                showToast(err.message, "error");
            }
            e.target.value = "";
        };
        reader.readAsDataURL(file);
    });

    document.getElementById("avatarRemoveBtn").addEventListener("click", async () => {
        try {
            await apiRequest("/upload/avatar", { method: "DELETE" });
            setAvatar(null);
            showToast("Photo de profil supprimée.");
        } catch (err) {
            showToast(err.message, "error");
        }
    });

    document.getElementById("manualBackupBtn").addEventListener("click", async () => {
        try {
            const data = await apiRequest("/git/backup", { method: "POST" });
            showToast(data.message);
        } catch (err) {
            showToast(err.message, "error");
        }
    });

    document.getElementById("addMoyenBtn").addEventListener("click", () => openMoyenModal(null));

    document.getElementById("moyenForm").addEventListener("submit", saveMoyen);

    document.getElementById("moyenCancel").addEventListener("click", () => {
        document.getElementById("moyenModal").style.display = "none";
    });

    document.getElementById("moyenModal").addEventListener("click", (e) => {
        if (e.target.id === "moyenModal") document.getElementById("moyenModal").style.display = "none";
    });

    document.getElementById("moyenType").addEventListener("change", (e) => applyTypeVisibility(e.target.value));

    document.getElementById("moyensList").addEventListener("click", async (e) => {
        const editBtn = e.target.closest("[data-editmoyen]");
        const delBtn = e.target.closest("[data-deletemoyen]");
        if (editBtn) {
            const m = moyensCache.find((x) => String(x.id) === String(editBtn.dataset.editmoyen));
            if (m) openMoyenModal(m);
            return;
        }
        if (delBtn) {
            if (!confirm("Supprimer ce moyen de paiement ?")) return;
            try {
                const res = await apiRequest(`/moyens-paiement/${delBtn.dataset.deletemoyen}`, { method: "DELETE" });
                showToast(res.message || "Moyen supprimé.");
                loadMoyens();
            } catch (err) {
                showToast(err.message, "error");
}
        }
    });
});
