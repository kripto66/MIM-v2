function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

const CrudPage = {
  init(config) {
    this.config = config;

    this.listEl = document.getElementById(config.listEl);
    this.modal = document.getElementById(config.modalId);
    this.form = document.getElementById(config.formId);
    this.titleEl = document.getElementById(config.modalTitleId);
    this.idField = document.getElementById(config.idFieldId);

    this.load();

    document.getElementById(config.addBtnEl).addEventListener("click", () => this.openAdd());
    document.getElementById(config.cancelBtnId).addEventListener("click", () => this.closeModal());
    this.modal.addEventListener("click", (e) => {
      if (e.target === this.modal) this.closeModal();
    });
    this.form.addEventListener("submit", (e) => this.handleSubmit(e));
    this.listEl.addEventListener("click", (e) => this.handleListClick(e));

    this.setupSidebar();
  },

  async load() {
    try {
      const { data } = await apiRequest(`/${this.config.resource}`);
      this.render(data);
    } catch (err) {
      this.listEl.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
    }
  },

  render(items) {
    this._currentItems = items;

    if (!items.length) {
      this.listEl.innerHTML = '<div class="empty-state">Aucun élément pour le moment.</div>';
      return;
    }
    this.listEl.innerHTML = items.map((item) => this.config.renderItem(item)).join("");
  },

  openAdd() {
    this.idField.value = "";
    this.form.reset();
    this.titleEl.textContent = "Ajouter";
    this.modal.style.display = "flex";
  },

  openEdit(item) {
    this.idField.value = item.id;
    this.titleEl.textContent = "Modifier";

    this.form.reset();

    for (const field of this.form.elements) {
      if (field.name && field.name !== "id" && item[field.name] != null) {
        field.value = item[field.name];
      }
    }

    this.modal.style.display = "flex";
  },

  closeModal() {
    this.modal.style.display = "none";
  },

  async handleSubmit(e) {
    e.preventDefault();

    const payload = {};
    for (const field of this.form.elements) {
      if (field.name) payload[field.name] = field.value;
    }

    const id = this.idField.value;

    try {
      if (id) {
        await apiRequest(`/${this.config.resource}/${id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        showToast("Modifié avec succès.");
      } else {
        await apiRequest(`/${this.config.resource}`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        showToast("Ajouté avec succès.");
      }

      this.closeModal();
      this.load();
    } catch (err) {
      showToast(err.message, "error");
    }
  },

  handleListClick(e) {
    const editBtn = e.target.closest("[data-edit]");
    const delBtn = e.target.closest("[data-delete]");

    if (editBtn) {
      const id = editBtn.dataset.edit;
      const item = this._currentItems?.find((i) => String(i.id) === String(id));
      if (item) this.openEdit(item);
    }

    if (delBtn) {
      this.deleteItem(delBtn.dataset.delete);
    }
  },

  async deleteItem(id) {
    if (!confirm("Voulez-vous vraiment supprimer cet élément ?")) return;

    try {
      await apiRequest(`/${this.config.resource}/${id}`, { method: "DELETE" });
      showToast("Supprimé avec succès.");
      this.load();
    } catch (err) {
      showToast(err.message, "error");
    }
  },

  setupSidebar() {
    const backupBtn = document.getElementById("backupBtn");
    const logoutBtn = document.getElementById("logoutBtn");

    if (backupBtn) {
      backupBtn.addEventListener("click", async () => {
        try {
          const data = await apiRequest("/git/backup", { method: "POST" });
          showToast(data.message);
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    }

    if (logoutBtn) {
      logoutBtn.addEventListener("click", async () => {
        try {
          await apiRequest("/auth/logout", { method: "POST" });
        } catch (err) {
          /* on déconnecte quand même */
        }
        window.location.href = "../PartPublic/connexion.html";
      });
    }
  },
};
