(async () => {
    const token = payStatusTokenFromUrl();
    const home = await payStatusHomeLink();
    document.getElementById("payHome").href = home;
    document.getElementById("payHome2").href = home;

    if (!token) return;

    const cancelled = document.getElementById("payCancelled");
    const pending = document.getElementById("payPendingCheck");
    const success = document.getElementById("payActuallySuccess");
    try {
        cancelled.hidden = true;
        pending.hidden = false;

        const invoice = await pollPaydunyaStatus(token, { intervalMs: 3000, maxAttempts: 5 });

        if (invoice?.status === "completed") {
            document.getElementById("payAmount").textContent = payStatusFormatFcfa(invoice.amount) || "";
            document.getElementById("payMeta").textContent = invoice.description || "";
            const receipt = document.getElementById("payReceiptLink");
            if (invoice.receipt_url) {
                receipt.href = invoice.receipt_url;
                receipt.hidden = false;
            }
            pending.hidden = true;
            success.hidden = false;
            document.title = "Paiement confirmé — MIM";
            return;
        }

        pending.hidden = true;
        cancelled.hidden = false;
    } catch {
        pending.hidden = true;
        cancelled.hidden = false;
    }
})();
