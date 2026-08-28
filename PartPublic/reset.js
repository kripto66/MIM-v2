const API = mimApiBase();

const params = new URLSearchParams(window.location.search);
const hash = new URLSearchParams(window.location.hash.replace(/^#/, "?"));

const code = params.get("code") || hash.get("code");
const token_hash = params.get("token_hash") || hash.get("token_hash");
const type = params.get("type") || hash.get("type");
const access_token = hash.get("access_token") || params.get("access_token");
const refresh_token = hash.get("refresh_token") || params.get("refresh_token");

const form = document.getElementById("resetForm");
const message = document.getElementById("resetMessage");
const button = form.querySelector('button[type="submit"]');

if (!code && !token_hash && !access_token) {
    message.textContent = "Lien de réinitialisation invalide ou expiré.";
    message.className = "error";
    form.style.display = "none";
}

form.addEventListener("submit", async (e) => {
    e.preventDefault();

    clearFormErrors(form);
    message.textContent = "";

    const password = document.getElementById("password").value;
    const password_confirm = document.getElementById("password_confirm").value;

    let hasErrors = false;
    const pwRule = mimPasswordRuleMessage(password);
    if (pwRule) {
        formFieldError(form, "password", pwRule);
        hasErrors = true;
    }
    if (!password_confirm) {
        formFieldError(form, "password_confirm", "Confirmez votre nouveau mot de passe.");
        hasErrors = true;
    } else if (password !== password_confirm) {
        formFieldError(form, "password_confirm", "Les mots de passe ne correspondent pas.");
        hasErrors = true;
    }
    if (hasErrors) return;

    button.disabled = true;
    button.textContent = "Réinitialisation...";

    try {
        const response = await fetch(API + "/auth/reset-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code, token_hash, type, access_token, refresh_token, password, password_confirm })
        });

        const data = await response.json();

        if (data.success) {
            message.textContent = data.message;
            message.className = "success";
            form.style.display = "none";
            setTimeout(() => (window.location.href = "connexion.html"), 2000);
        } else {
            message.textContent = data.message;
            message.className = "error";
            applyServerErrors(form, data.errors);
            button.disabled = false;
            button.textContent = "Réinitialiser mon mot de passe";
        }
    } catch (error) {
        console.error(error);
        message.textContent = "Impossible de contacter le serveur.";
        message.className = "error";
        button.disabled = false;
        button.textContent = "Réinitialiser mon mot de passe";
    }
});
