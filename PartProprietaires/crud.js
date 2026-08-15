// Collecte les erreurs de champs à partir d'une liste de règles.
// rule : { name, test(input) -> bool (en erreur), message }
function validateFields(form, rules) {
  const errors = {};
  for (const rule of rules) {
    const input = form.querySelector(`[name="${rule.name}"], #${rule.name}`);
    if (!input) continue;
    if (rule.test(input)) errors[rule.name] = rule.message;
  }
  return errors;
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

    if (config.afterInit) config.afterInit(this);

    this.setupSidebar();
  },

  async load() {
    try {
      const { data } = await apiRequest(`/${this.config.resource}`);
      this.render(data);
      if (this.config.afterLoad) this.config.afterLoad(data);
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
    clearFormErrors(this.form);
    if (this.config.onOpenAdd) this.config.onOpenAdd(this.form);
    this.titleEl.textContent = this.config.addTitle || "Ajouter";
    this.modal.style.display = "flex";
  },

  openEdit(item) {
    this.idField.value = item.id;
    this.titleEl.textContent = "Modifier";

    this.form.reset();
    clearFormErrors(this.form);

    for (const field of this.form.elements) {
      if (field.name && field.name !== "id" && item[field.name] != null) {
        field.value = item[field.name];
      }
    }

    if (this.config.onOpenEdit) this.config.onOpenEdit(this.form, item);
    this.modal.style.display = "flex";
  },

  closeModal() {
    this.modal.style.display = "none";
  },

  async handleSubmit(e) {
    e.preventDefault();

    const submitBtn = this.form.querySelector('button[type="submit"]');
    if (submitBtn && submitBtn.disabled) return; // anti double soumission

    clearFormErrors(this.form);

    if (this.config.validate) {
      const errors = this.config.validate(this.form) || {};
      if (Object.keys(errors).length) {
        applyServerErrors(this.form, errors);
        return;
      }
    }

    const payload = {};
    for (const field of this.form.elements) {
      if (field.name && !field.disabled) payload[field.name] = field.value;
    }

    const id = this.idField.value;

    const originalLabel = submitBtn ? submitBtn.textContent : "";
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Enregistrement...";
    }

    try {
      let savedId = id;
      if (id) {
        await apiRequest(`/${this.config.resource}/${id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        showToast(this.config.editSuccess || "Modifié avec succès.");
      } else {
        const res = await apiRequest(`/${this.config.resource}`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        savedId = res?.data?.id || id;
        showToast(this.config.createSuccess || "Ajouté avec succès.");
      }

      this.closeModal();
      await this.load();
      if (this.config.onSaved) await this.config.onSaved(savedId, payload);
    } catch (err) {
      applyServerErrors(this.form, err.errors);
      showToast(err.message, "error");
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = originalLabel;
      }
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
        backupBtn.disabled = true;
        backupBtn.textContent = "Sauvegarde...";
        try {
          const data = await apiRequest("/git/backup", { method: "POST" });
          showToast(data.message);
        } catch (err) {
          showToast(err.message, "error");
        } finally {
          backupBtn.disabled = false;
          backupBtn.textContent = "Sauvegarder";
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
