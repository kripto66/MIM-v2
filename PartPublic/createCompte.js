const API = mimApiBase();

const form = document.getElementById("registerForm");
const message = document.getElementById("formMessage");
const button = document.getElementById("submitButton");

bindAutoClear(form, ["account_type", "name", "email", "phone", "password", "password_confirm"]);

form.addEventListener("submit", async function(event) {
    event.preventDefault();

    clearFormErrors(form);
    message.textContent = "";
    message.className = "";

    const payload = {
        account_type: form.account_type.value,
        name: form.name.value.trim(),
        email: form.email.value.trim(),
        phone: form.phone.value.trim(),
        password: form.password.value,
        password_confirm: form.password_confirm.value
    };

    let hasErrors = false;

    if (!payload.account_type) {
        formFieldError(form, "account_type", "Choisissez votre type de compte.");
        hasErrors = true;
    }

    if (!payload.name) {
        formFieldError(form, "name", "Le nom complet est obligatoire.");
        hasErrors = true;
    }

    if (!payload.email) {
        formFieldError(form, "email", "L'adresse email est obligatoire.");
        hasErrors = true;
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
        formFieldError(form, "email", "Adresse email invalide.");
        hasErrors = true;
    }

    if (!payload.phone) {
        formFieldError(form, "phone", "Le numéro de téléphone est obligatoire.");
        hasErrors = true;
    }

    const pwRule = mimPasswordRuleMessage(payload.password);
    if (pwRule) {
        formFieldError(form, "password", pwRule);
        hasErrors = true;
    }

    if (payload.password !== payload.password_confirm) {
        formFieldError(form, "password_confirm", "Les mots de passe ne correspondent pas.");
        hasErrors = true;
    }

    if (!form.terms.checked) {
        formFieldError(form, "terms", "Vous devez accepter les conditions d'utilisation.");
        hasErrors = true;
    }

    if (hasErrors) return;

    button.disabled = true;
    button.textContent = "Création du compte...";

    try {
        const response = await fetch(API + "/auth/register", {
            method: "POST",
            headers: { 'Content-Type': 'application/json' },
            credentials: "include",
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (data.success) {
            message.textContent = data.message;
            message.className = "success";

            form.reset();

            const redirect = data.redirect;
            const timeout = data.emailConfirmationRequired ? 1500 : 1200;
            const target = data.emailConfirmationRequired
                ? "../PartPublic/connexion.html"
                : "../" + redirect;

            setTimeout(function() {
                window.location.href = target;
            }, timeout);

        } else {
            message.textContent = data.message;
            message.className = "error";
            applyServerErrors(form, data.errors);

            button.disabled = false;
            button.textContent = "Créer mon compte";
        }

    } catch (error) {
        console.error(error);
        message.textContent = "Impossible de contacter le serveur.";
        message.className = "error";
        button.disabled = false;
        button.textContent = "Créer mon compte";
    }
});
