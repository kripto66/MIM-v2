        async function loadPrestataires() {
            const listEl = document.getElementById("prestatairesList");
            try {
                const { data } = await apiRequest("/prestataires");

                if (!data.length) {
                    listEl.innerHTML = '<div class="empty-state">Aucun prestataire associé. Ils sont gérés par le propriétaire géré.</div>';
                    return;
                }

                const bienId = window.MIM && MIM.agenceBien ? MIM.agenceBien.id : "";
                listEl.innerHTML = data.map((p) => `
                    <div class="crud-card">
                        <div>
                            <h3>${escapeHtml(p.nom)}</h3>
                            <p>${escapeHtml(p.specialite || "")}</p>
                            <p>${p.phone ? escapeHtml(p.phone) : ""}${p.email ? ' — ' + escapeHtml(p.email) : ""}</p>
                        </div>
                        <div class="card-actions">
                            <a class="btn btn-pay" href="/PartAgence/second_Mode/interventions.html?prestataire=${encodeURIComponent(p.id)}${bienId ? `&bien=${encodeURIComponent(bienId)}` : ""}">Planifier</a>
                        </div>
                    </div>`).join("");
            } catch (err) {
                listEl.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
            }
        }

        document.addEventListener("DOMContentLoaded", loadPrestataires);
    