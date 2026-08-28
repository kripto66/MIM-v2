(async () => {
    const views = ["payPending", "paySuccess", "payFailure", "payTimeout", "payError"];
    const show = (id) => {
        views.forEach((v) => document.getElementById(v).hidden = v !== id);
        document.title = document.getElementById(id).querySelector("h1").textContent + " — MIM";
    };

    const token = payStatusTokenFromUrl();

    async function renderHomeLinks() {
        const home = await payStatusHomeLink();
        for (const el of [document.getElementById("payTimeoutHome"), document.getElementById("payErrorHome")]) {
            el.href = home;
        }
    }

    function showSuccess(invoice) {
        document.getElementById("paySuccessAmount").textContent =
            payStatusFormatFcfa(invoice.amount) || "";
        const meta = [];
        if (invoice.description) meta.push(invoice.description);
        meta.push(`Session ${String(invoice.token || "").slice(0, 8).toUpperCase()}…`);
        document.getElementById("paySuccessMeta").textContent = meta.filter(Boolean).join(" · ");
        const receipt = document.getElementById("payReceiptLink");
        if (invoice.receipt_url) {
            receipt.href = invoice.receipt_url;
            receipt.hidden = false;
        }
        show("paySuccess");
    }

    function showFailure(message) {
        if (message) document.getElementById("payFailureText").textContent = message;
        show("payFailure");
    }

    async function run() {
        show("payPending");
        await renderHomeLinks();

        if (!token) {
            document.getElementById("payErrorText").textContent =
                "Lien incomplet : aucun identifiant de paiement n'a été fourni.";
            show("payError");
            return;
        }

        try {
            let first = null;
            try { first = await fetchPaydunyaStatus(token); } catch (err) {
                document.getElementById("payErrorText").textContent =
                    err.message === "Facture introuvable."
                        ? "Cette session de paiement est inconnue ou ne vous appartient pas."
                        : `Erreur : ${err.message}`;
                show("payError");
                return;
            }

            let finalInvoice = first;
            if (!["completed", "cancelled", "failed"].includes(first.status)) {
                finalInvoice = await pollPaydunyaStatus(token, {
                    intervalMs: 4000,
                    maxAttempts: 45,
                });
            }

            if (!finalInvoice) {
                show("payTimeout");
                return;
            }
            if (finalInvoice.status === "completed") {
                showSuccess(finalInvoice);
                return;
            }
            showFailure(
                finalInvoice.status === "cancelled"
                    ? "Le paiement a été annulé. Aucun montant n'a été encaissé. Vous pouvez réessayer depuis votre espace."
                    : "Le paiement n'a pas pu être confirmé. Aucun montant n'a été encaissé. Vous pouvez réessayer depuis votre espace."
            );
        } catch (err) {
            document.getElementById("payErrorText").textContent = `Erreur inattendue : ${err.message}`;
            show("payError");
        }
    }

    document.getElementById("payRetryBtn").addEventListener("click", run);
    run();
})();
