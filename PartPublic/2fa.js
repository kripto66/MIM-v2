const API = mimApiBase();

const form = document.getElementById("verifyForm");
const message = document.getElementById("verifyMessage");
const codeInput = document.getElementById("code");
const button = form.querySelector('button[type="submit"]');

codeInput.addEventListener("input", () => {
    codeInput.value = codeInput.value.replace(/\D/g, "").slice(0, 6);
});

form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const code = codeInput.value;

    if (!/^\d{6}$/.test(code)) {
        message.textContent = "Veuillez saisir le code à 6 chiffres.";
        message.className = "error";
        return;
    }

    message.textContent = "";
    button.disabled = true;
    button.textContent = "Vérification...";

    try {
        const response = await fetch(API + "/auth/verify-2fa", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ code })
        });

        const data = await response.json();

        if (data.success) {
            message.textContent = data.message;
            message.className = "success";
            if (data.mustChangePassword && data.redirect) {
                window.location.href = "../PartPublic/change-password.html?next=" +
                    encodeURIComponent("../" + data.redirect);
            } else {
                window.location.href = "../" + data.redirect;
            }
            return;
        }

        message.textContent = data.message;
        message.className = "error";
    } catch (error) {
        console.error(error);
        message.textContent = "Impossible de contacter le serveur.";
        message.className = "error";
    }

    button.disabled = false;
    button.textContent = "Vérifier";
    codeInput.focus();
});
