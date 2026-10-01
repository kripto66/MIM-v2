
        // ============================================================
        // Page « Mes paiements » — flux « Payer mon loyer »
        // Le locataire paie DIRECTEMENT son propriétaire (hors MIM)
        // avec le moyen configuré par celui-ci, puis déclare avoir
        // payé. MIM ne reçoit pas l'argent et ne connaît pas l'heure
        // réelle du transfert : seule la demande de validation est
        // horodatée côté serveur.
        // ============================================================

        const TYPE_ICONS = { wave: "🟣", orange_money: "🟠", virement: "🏦", especes: "💵" };
        const TYPE_LABELS = { wave: "Wave", orange_money: "Orange Money", virement: "Virement bancaire", especes: "Espèces" };
        const TYPE_FIELDS = {
            wave: ["nom_titulaire", "numero"],
            orange_money: ["nom_titulaire", "numero"],
            virement: ["banque", "nom_titulaire", "num_compte"],
            especes: [],
        };

        let moyensCache = [];
        let declareTarget = null;

        async function copyText(text, feedbackEl, successLabel) {
            try {
                if (navigator.clipboard && window.isSecureContext) {
                    await navigator.clipboard.writeText(text);
                } else {
                    const ta = document.createElement("textarea");
                    ta.value = text;
                    ta.style.position = "fixed";
                    ta.style.opacity = "0";
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand("copy");
                    ta.remove();
                }
                if (feedbackEl) {
                    feedbackEl.textContent = successLabel || "✓ Copié";
                    setTimeout(() => { feedbackEl.textContent = ""; }, 2000);
                }
            } catch (err) {
                if (feedbackEl) feedbackEl.textContent = "Copie impossible";
            }
        }

        function copyBtn(label, value, fbId, successLabel) {
            if (!value) return "";
            const id = `${fbId}-${String(value).length}-${Math.random().toString(36).slice(2, 7)}`;
            return `
                <button type="button" class="copy-btn" data-copy="${escapeAttr(value)}" data-fb="${id}">${label}</button>
                <span class="copy-feedback" id="${id}"></span>`;
        }

        function formatDateTime(iso) {
            if (!iso) return "";
            return new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
        }

        function daysRemaining(jourEcheance, mois) {
            if (!jourEcheance || !mois) return null;
            const [y, m] = String(mois).split("-").map(Number);
            const target = new Date(y, m - 1, Number(jourEcheance));
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const diff = Math.round((target - today) / 86400000);
            return diff;
        }

        function renderPayer(data) {
            const zone = document.getElementById("payerContent");
            const subtitle = document.getElementById("payerSubtitle");
            if (!zone) return;

            if (!data.linked) {
                zone.innerHTML = "";
                return;
            }

            const paiements = (data.paiements || [])
                .filter((p) => p.statut !== "paye")
                .sort((a, b) => String(a.mois || "").localeCompare(String(b.mois || "")));
            const pending = paiements[0];

            const loyer = data.stats?.loyer != null ? Number(data.stats.loyer) : null;
            const jourEcheance = data.locataire?.jour_echeance || 1;

            if (!pending) {
                // Tout est payé : affiche le prochain mois (échéance à venir).
                const last = [...(data.paiements || [])].sort((a, b) => String(b.mois || "").localeCompare(String(a.mois || "")))[0];
                const next = nextMonthOf(last?.mois);
                zone.innerHTML = `
                    <div class="payer-card paid">
                        <div class="payer-head">
                            <span class="status success">À jour</span>
                        </div>
                        <p>Tous vos loyers sont validés.</p>
                        ${next ? `<p>Prochaine échéance : <strong>${escapeHtml(formatMois(next))}</strong>${loyer != null ? ` · <strong>${fmtFCFA(loyer)}</strong>` : ""}.</p>` : ""}
                    </div>`;
                if (subtitle) subtitle.textContent = "Votre situation est à jour.";
                return;
            }

            const s = pending.statut;

            if (s === "a_confirmer") {
                zone.innerHTML = `
                    <div class="payer-card pending">
                        <div class="payer-head">
                            <strong>${escapeHtml(formatMois(pending.mois))}</strong>
                            <span class="status info">À confirmer</span>
                        </div>
                        <p>Votre paiement de <strong>${fmtFCFA(pending.montant)}</strong> a bien été reçu. Il attend la validation de votre propriétaire.</p>
                        ${pending.date_paiement ? `<p class="payer-meta">Reçu le ${formatDate(pending.date_paiement)}</p>` : ""}
                        <button type="button" class="btn-primary declare-btn" data-confirm-legacy="${escapeAttr(pending.id)}">Confirmer la réception</button>
                    </div>`;
                if (subtitle) subtitle.textContent = "Votre paiement est enregistré : il attend la validation du propriétaire.";
                return;
            }

            if (s === "en_validation") {
                zone.innerHTML = `
                    <div class="payer-card pending">
                        <div class="payer-head">
                            <strong>${escapeHtml(formatMois(pending.mois))}</strong>
                            <span class="status warning">En attente de validation</span>
                        </div>
                        <p>Votre déclaration de paiement de <strong>${fmtFCFA(pending.montant)}</strong> attend la validation de votre propriétaire.</p>
                        ${pending.validation_requested_at ? `<p class="payer-meta">Demande de validation reçue : ${formatDateTime(pending.validation_requested_at)}</p>` : ""}
                        <p class="payer-note">⏳ Votre paiement est en attente de validation par votre propriétaire.</p>
                    </div>`;
                if (subtitle) subtitle.textContent = "Votre déclaration est en cours de validation.";
                return;
            }

            if (s === "refuse") {
                zone.innerHTML = `
                    <div class="payer-card rejected">
                        <div class="payer-head">
                            <strong>${escapeHtml(formatMois(pending.mois))}</strong>
                            <span class="status danger">Refusé</span>
                        </div>
                        <p>Votre déclaration de <strong>${fmtFCFA(pending.montant)}</strong> a été refusée par votre propriétaire.</p>
                        ${pending.rejection_reason ? `<p>Motif : <strong>${escapeHtml(pending.rejection_reason)}</strong></p>` : ""}
                        <p class="payer-note">Vérifiez votre paiement ou contactez votre propriétaire, puis déclarez à nouveau.</p>
                    </div>`;
                renderPayerMethods(data, pending, jourEcheance);
                return;
            }

            // attente / retard : loyer à payer.
            renderPayerMethods(data, pending, jourEcheance);
        }

        async function renderPayerMethods(data, pending, jourEcheance) {
            const zone = document.getElementById("payerContent");
            if (!zone) return;

            const remaining = daysRemaining(jourEcheance, pending.mois);
            let daysHtml = "";
            if (remaining != null) {
                if (remaining > 7) daysHtml = `<span class="status success">J-${remaining}</span>`;
                else if (remaining > 0) daysHtml = `<span class="status danger">🔴 Il reste ${remaining} jour${remaining > 1 ? "s" : ""}</span>`;
                else if (remaining === 0) daysHtml = `<span class="status danger">🔴 Votre échéance est aujourd'hui</span>`;
                else daysHtml = `<span class="status danger">🔴 Échéance dépassée</span>`;
            }

            const statutLabel = pending.statut === "retard"
                ? `<span class="status danger">En retard</span>`
                : `<span class="status warning">À payer</span>`;

            let moyensHtml = "";
            if (!moyensCache.length) {
                moyensHtml = `<p class="payer-note">Le propriétaire n'a pas encore configuré de moyen de paiement. Contactez-le pour connaître les modalités.</p>`;
            } else {
                moyensHtml = moyensCache.map((m) => {
                    const icon = escapeHtml(TYPE_ICONS[m.type] || "💰");
                    const label = escapeHtml(TYPE_LABELS[m.type] || m.type);
                    const fbBase = `fb-${m.id}`;
                    const lines = [];
                    if (m.nom_titulaire) lines.push(`<div class="method-line"><span>Titulaire</span><strong>${escapeHtml(m.nom_titulaire)}</strong>${copyBtn("Copier le nom", m.nom_titulaire, fbBase + "-n", "✓ Nom copié")}</div>`);
                    if (m.numero) lines.push(`<div class="method-line"><span>Numéro</span><strong>${escapeHtml(m.numero)}</strong>${copyBtn("Copier le numéro", m.numero, fbBase + "-p", "✓ Numéro copié")}</div>`);
                    if (m.banque) lines.push(`<div class="method-line"><span>Banque</span><strong>${escapeHtml(m.banque)}</strong></div>`);
                    if (m.num_compte) lines.push(`<div class="method-line"><span>Compte</span><strong>${escapeHtml(m.num_compte)}</strong>${copyBtn("Copier le compte", m.num_compte, fbBase + "-c", "✓ Compte copié")}</div>`);
                    if (m.lien_paiement && MIM.httpsUrl(m.lien_paiement)) lines.push(`<div class="method-line"><span>Lien de paiement</span><a href="${escapeAttr(MIM.httpsUrl(m.lien_paiement))}" target="_blank" rel="noopener">Ouvrir</a></div>`);
                    if (m.instructions) lines.push(`<p class="method-instructions">${escapeHtml(m.instructions)}</p>`);

                    return `
                        <div class="method-card" data-method="${m.id}">
                            <div class="method-head">
                                <span>${icon} ${label}</span>
                            </div>
                            ${lines.join("")}
                            <button type="button" class="btn-primary declare-btn" data-method="${m.id}">J'ai effectué le paiement</button>
                        </div>`;
                }).join("");
            }

            zone.innerHTML = `
                <div class="payer-card">
                    <div class="payer-head">
                        <strong>${escapeHtml(formatMois(pending.mois))}</strong>
                        ${statutLabel}${daysHtml}
                    </div>
                    <div class="payer-amount">${fmtFCFA(pending.montant)}</div>
                    <p class="payer-meta">Échéance : ${formatDate(new Date(Number(String(pending.mois).split("-")[0]), Number(String(pending.mois).split("-")[1]) - 1, jourEcheance))}</p>
                    <div class="payer-methods">
                        <h4>Payez directement votre propriétaire</h4>
                        <p class="payer-note">Utilisez l'un des moyens ci-dessous, puis revenez déclarer votre paiement ici.</p>
                        ${moyensHtml}
                    </div>
                </div>`;
        }

        function openDeclareModal(methodId) {
            const method = moyensCache.find((m) => String(m.id) === String(methodId));
            if (!method) return;
            declareTarget = methodId;
            document.getElementById("declareReference").value = "";

            const pending = currentPending;
            if (!pending) return;

            document.getElementById("declareModalBody").innerHTML = `
                <p>Êtes-vous certain d'avoir effectué ce paiement ?</p>
                <p><strong>Montant : ${fmtFCFA(pending.montant)}</strong></p>
                <p><strong>Méthode : ${escapeHtml(TYPE_LABELS[method.type] || method.type)}</strong></p>
                <p>Vous confirmez avoir effectué le paiement à votre propriétaire.</p>`;
            document.getElementById("declareModal").classList.remove("hidden");
        }

        async function submitDeclaration() {
            const btn = document.getElementById("declareConfirm");
            if (!declareTarget || btn.disabled) return;
            btn.disabled = true;
            try {
                const reference = document.getElementById("declareReference").value.trim() || null;
                const res = await tenantRequest(`/locataire/paiements/${currentPending.id}/declarer`, {
                    method: "POST",
                    body: JSON.stringify({ moyen_paiement_id: declareTarget, reference }),
                });
                document.getElementById("declareModal").classList.add("hidden");
                showTenantError(res.message || "Déclaration enregistrée.", true);
                await reloadPage();
            } catch (err) {
                btn.disabled = false;
                showTenantError(err.message);
            }
        }

        let currentPending = null;

        async function reloadPage() {
            const data = await tenantRequest("/locataire/dashboard");
            const [moyensRes] = [null];
            try {
                const m = await tenantRequest("/locataire/moyens-paiement");
                moyensCache = m.moyens || m.data || [];
            } catch {
                moyensCache = [];
            }
            const paiements = (data.paiements || [])
                .filter((p) => p.statut !== "paye")
                .sort((a, b) => String(a.mois || "").localeCompare(String(b.mois || "")));
            currentPending = paiements[0] || null;
            renderPayer(data);
            renderHistory(data);
        }

        function renderHistory(data) {
            const list = document.getElementById("paiementsList");
            if (!list) return;
            const paiements = data.paiements || [];
            if (!paiements.length) {
                list.innerHTML = '<div class="empty-state">Aucun paiement enregistré pour le moment.</div>';
                return;
            }
            list.innerHTML = paiements
                .map((p) => `
                    <div class="list-item">
                        <div class="list-item-info">
                            <h4>${escapeHtml(formatMois(p.mois))}</h4>
                            <p>${p.validated_at ? "Validé le " + formatDate(p.validated_at) : p.validation_requested_at ? "Déclaré le " + formatDate(p.validation_requested_at) : p.date_paiement ? "Payé le " + formatDate(p.date_paiement) : "Non réglé"}</p>
                            ${p.rejection_reason && p.statut === "refuse" ? `<p class="payer-note">Motif : ${escapeHtml(p.rejection_reason)}</p>` : ""}
                        </div>
                        <div class="list-item-side">
                            <div class="list-item-amount">${fmtFCFA(p.montant)}</div>
                            <div>${badgeStatut(p.statut, "paiement")}</div>
                        </div>
                    </div>`)
                .join("");
        }

        document.addEventListener("DOMContentLoaded", async () => {
            try {
                await reloadPage();

                document.getElementById("payerContent").addEventListener("click", (e) => {
                    const confirmLegacy = e.target.closest("[data-confirm-legacy]");
                    if (confirmLegacy) {
                        confirmLegacy.disabled = true;
                        tenantRequest(`/locataire/paiements/${encodeURIComponent(confirmLegacy.dataset.confirmLegacy)}/confirmer`, { method: "POST" })
                            .then(() => reloadPage())
                            .catch((err) => {
                                showTenantError(err.message);
                                confirmLegacy.disabled = false;
                            });
                        return;
                    }
                    const btn = e.target.closest(".declare-btn");
                    if (btn) {
                        openDeclareModal(btn.dataset.method);
                        return;
                    }
                    const copy = e.target.closest("[data-copy]");
                    if (copy) {
                        const fb = document.getElementById(copy.dataset.fb);
                        copyText(copy.dataset.copy, fb);
                    }
                });

                document.getElementById("declareCancel").addEventListener("click", () => {
                    document.getElementById("declareModal").classList.add("hidden");
                    document.getElementById("declareConfirm").disabled = false;
                });
                document.getElementById("declareConfirm").addEventListener("click", submitDeclaration);
                document.getElementById("declareModal").addEventListener("click", (e) => {
                    if (e.target.id === "declareModal") {
                        document.getElementById("declareModal").classList.add("hidden");
                        document.getElementById("declareConfirm").disabled = false;
                    }
                });
            } catch (err) {
                showTenantError(err.message);
            }
        });
    