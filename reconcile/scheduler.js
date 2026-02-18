const { reconcilePendingPayment } =  require("./reconciliationWorker");

let isRunning = false;

function startReconciliationScheduler() {
    setInterval(async () => {
        if (isRunning) return;

        isRunning = true;

        try {
            await reconcilePendingPayment();
        } catch (err) {
            console.error("reconciliation scheduler error", err);
        } finally {
            isRunning = false;
        }
    }, 10_000);
}

module.exports = {startReconciliationScheduler} ;