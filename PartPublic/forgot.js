const API = mimApiBase();

document.getElementById('forgotForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const form = e.target;
    const message = document.getElementById('forgotMessage');
    const button = form.querySelector('button[type="submit"]');

    message.textContent = '';
    button.disabled = true;
    button.textContent = 'Envoi...';

    try {
        const response = await fetch(API + '/auth/forgot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: form.email.value })
        });

        const data = await response.json();
        message.textContent = data.message;
        message.className = data.success ? 'success' : 'error';
    } catch (error) {
        console.error(error);
        message.textContent = 'Impossible de contacter le serveur.';
        message.className = 'error';
    }

    button.disabled = false;
    button.textContent = 'Envoyer le lien';
});
