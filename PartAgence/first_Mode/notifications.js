function formatDate(d) {
    if (!d) return "";
    const dt = new Date(d);
    return dt.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

async function load() {
    try {
        const { data } = await apiRequest("/notifications");
        const list = document.getElementById("notificationsList");

        if (!data.length) {
            list.innerHTML = '<div class="empty-state">Aucune notification.</div>';
            return;
        }

        list.innerHTML = data.map((n) => `
            <div class="crud-card ${n.lu ? "notification-read" : ""}">
                <div>
                    <h3>${escapeHtml(n.message)}</h3>
                    <p class="muted">${formatDate(n.created_at)}</p>
                </div>
                <div>
                    <button class="btn btn-edit" data-mark="${n.id}">${n.lu ? "Lue" : "Marquer comme lu"}</button>
                    <button class="btn btn-delete" data-delete-notif="${n.id}">Supprimer</button>
                </div>
            </div>
        `).join("");
    } catch (err) {
        document.getElementById("notificationsList").innerHTML =
            `<div class="empty-state">${escapeHtml(err.message)}</div>`;
    }
}

async function markRead(id) {
    try {
        await apiRequest(`/notifications/${id}`, { method: "PUT", body: JSON.stringify({ lu: true }) });
        showToast("Notification marquée comme lue.");
        load();
    } catch (err) {
        showToast(err.message, "error");
    }
}

async function markAll() {
    const list = document.getElementById("notificationsList");
    const ids = [...list.querySelectorAll("[data-mark]")]
        .filter((btn) => !btn.textContent.startsWith("Lue"))
        .map((btn) => btn.dataset.mark);

    if (!ids.length) {
        showToast("Aucune notification non lue.");
        return;
    }

    try {
        await Promise.all(ids.map((id) =>
            apiRequest(`/notifications/${id}`, { method: "PUT", body: JSON.stringify({ lu: true }) })
        ));
        showToast("Toutes les notifications sont lues.");
        load();
    } catch (err) {
        showToast(err.message, "error");
    }
}

async function deleteNotif(id) {
    try {
        await apiRequest(`/notifications/${id}`, { method: "DELETE" });
        showToast("Notification supprimée.");
        load();
    } catch (err) {
        showToast(err.message, "error");
    }
}

async function deleteAll() {
    if (!confirm("Supprimer toutes vos notifications ? Cette action est irréversible.")) return;
    try {
        await apiRequest("/notifications", { method: "DELETE" });
        showToast("Toutes les notifications ont été supprimées.");
        load();
    } catch (err) {
        showToast(err.message, "error");
    }
}

document.addEventListener("DOMContentLoaded", () => {
    load();

    document.getElementById("notificationsList").addEventListener("click", (e) => {
        const markBtn = e.target.closest("[data-mark]");
        if (markBtn && !markBtn.textContent.startsWith("Lue")) markRead(markBtn.dataset.mark);

        const delBtn = e.target.closest("[data-delete-notif]");
        if (delBtn) deleteNotif(delBtn.dataset.deleteNotif);
    });

    document.getElementById("markAllBtn").addEventListener("click", markAll);
    document.getElementById("deleteAllBtn").addEventListener("click", deleteAll);
});
