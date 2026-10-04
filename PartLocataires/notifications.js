
        document.addEventListener("DOMContentLoaded", async () => {
            async function renderNotifications() {
            try {
                const data = await tenantRequest("/locataire/dashboard");
                const list = document.getElementById("notificationsList");

                if (!data.linked) {
                    document.getElementById("unlinkedMessage").style.display = "block";
                    list.innerHTML = "";
                    return;
                }

                const notifications = data.notifications || [];

                if (!notifications.length) {
                    list.innerHTML = '<div class="empty-state">Aucune notification.</div>';
                    return;
                }

                list.innerHTML = notifications
                    .map((n) => {
                        const icon = n.type === "paiement" ? "💰" : n.type === "incident" ? "🛠️" : "🔔";
                        const cls = n.niveau === "danger" ? "danger" : n.niveau === "warning" ? "warning" : "success";
                        return `
                            <div class="list-item">
                                <div class="list-item-info">
                                    <h4>${icon} ${escapeHtml(n.message)}</h4>
                                    ${n.date ? `<p>${formatDate(n.date)}</p>` : ""}
                                </div>
                                <span class="status ${cls}">${cls === "danger" ? "Important" : cls === "warning" ? "À suivre" : "Info"}</span>
                            </div>`;
                    })
                    .join("");
            } catch (err) {
                showTenantError(err.message);
            }
            }

            await renderNotifications();

            // Temps réel : nouvelle notification / suppression -> re-render.
            if (window.MIMRealtime) {
                MIMRealtime.onChange((info) => {
                    if (info.table === "notifications") renderNotifications();
                }, 400);
            }
        });
