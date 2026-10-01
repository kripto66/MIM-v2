
        document.addEventListener("DOMContentLoaded", async () => {
            const form = document.getElementById("incidentForm");
            const submitBtn = document.getElementById("incidentSubmitBtn");
            const photoInput = document.getElementById("photo");
            const photoStatus = document.getElementById("photoStatus");

            async function compressImage(file) {
                const dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });

                const img = await new Promise((resolve, reject) => {
                    const image = new Image();
                    image.onload = () => resolve(image);
                    image.onerror = reject;
                    image.src = dataUrl;
                });

                const MAX = 1000;
                let { width, height } = img;
                if (width > MAX || height > MAX) {
                    const ratio = Math.min(MAX / width, MAX / height);
                    width = Math.round(width * ratio);
                    height = Math.round(height * ratio);
                }

                const canvas = document.createElement("canvas");
                canvas.width = width;
                canvas.height = height;
                canvas.getContext("2d").drawImage(img, 0, 0, width, height);
                return canvas.toDataURL("image/jpeg", 0.72);
            }

            photoInput.addEventListener("change", async () => {
                photoStatus.textContent = "";
                const file = photoInput.files[0];
                if (!file) return;
                if (!file.type.startsWith("image/")) {
                    photoStatus.textContent = "Le fichier doit être une image.";
                    photoInput.value = "";
                    return;
                }
                if (file.size > 2.5 * 1024 * 1024) {
                    photoStatus.textContent = "Image trop lourde (maximum 2,5 Mo).";
                    photoInput.value = "";
                    return;
                }
                try {
                    const compressed = await compressImage(file);
                    photoInput.dataset.photoDataUrl = compressed;
                    photoStatus.textContent = "Photo prête à être envoyée.";
                } catch (err) {
                    photoStatus.textContent = "Impossible de lire l'image.";
                }
            });

            form.addEventListener("submit", async (e) => {
                e.preventDefault();
                if (submitBtn.disabled) return;

                clearFormErrors(form);
                let hasErrors = false;

                if (!form.titre.value.trim()) {
                    formFieldError(form, "titre", "Le titre de l'incident est obligatoire.");
                    hasErrors = true;
                }
                if (!form.description.value.trim()) {
                    formFieldError(form, "description", "Décrivez l'incident.");
                    hasErrors = true;
                }
                if (hasErrors) return;

                const body = {
                    titre: form.titre.value.trim(),
                    description: form.description.value.trim(),
                    photo: photoInput.dataset.photoDataUrl || null,
                };

                submitBtn.disabled = true;
                submitBtn.textContent = "Envoi...";

                try {
                    const created = await tenantRequest("/locataire/incidents", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(body),
                    });
                    form.reset();
                    photoInput.dataset.photoDataUrl = "";
                    photoStatus.textContent = "";
                    showTenantError(created.message || "Incident signalé.", true);
                    try {
                        const data = await tenantRequest("/locataire/dashboard");
                        const list = document.getElementById("incidentsList");
                        const incidents = data.incidents || [];
                        list.innerHTML = incidents.length
                            ? incidents
                                .map((i) => `
                                    <div class="list-item">
                                        <div class="list-item-info">
                                            <h4>${escapeHtml(i.titre)}</h4>
                                            <p>${i.description ? escapeHtml(i.description) : "Pas de description"}</p>
                                            ${i.photo ? `<img class="incident-photo" src="${escapeHtml(i.photo)}" alt="Photo de l'incident">` : ""}
                                            <p>Signalé le ${formatDate(i.created_at)}</p>
                                        </div>
                                        <div>${badgeStatut(i.statut, "incident")}</div>
                                    </div>`)
                                .join("")
                            : '<div class="empty-state">Aucun incident signalé pour votre logement.</div>';
                    } catch (err) {
                        console.error(err);
                    }
                } catch (err) {
                    applyServerErrors(form, err.errors);
                    showTenantError(err.message);
                } finally {
                    submitBtn.disabled = false;
                    submitBtn.textContent = "Signaler l'incident";
                }
            });

            try {
                const data = await tenantRequest("/locataire/dashboard");
                const list = document.getElementById("incidentsList");

                if (!data.linked) {
                    document.getElementById("unlinkedMessage").style.display = "block";
                    document.getElementById("signalSection").style.display = "none";
                    list.innerHTML = "";
                    return;
                }

                const incidents = data.incidents || [];

                if (!incidents.length) {
                    list.innerHTML = '<div class="empty-state">Aucun incident signalé pour votre logement.</div>';
                    return;
                }

                list.innerHTML = incidents
                    .map((i) => `
                        <div class="list-item">
                            <div class="list-item-info">
                                <h4>${escapeHtml(i.titre)}</h4>
                                <p>${i.description ? escapeHtml(i.description) : "Pas de description"}</p>
                                ${i.photo ? `<img class="incident-photo" src="${escapeHtml(i.photo)}" alt="Photo de l'incident">` : ""}
                                <p>Signalé le ${formatDate(i.created_at)}</p>
                            </div>
                            <div>${badgeStatut(i.statut, "incident")}</div>
                        </div>`)
                    .join("");
            } catch (err) {
                showTenantError(err.message);
            }
        });
    