const { capture, refund, getCaptured, getRefunded } = require("../bank");
const pool = require("../db/pool")


async function reconcileSinglePayment(client, payment) {
    try {
        let bankResult;

        if (payment.type === "CAPTURE"){
            if (payment.status === "SUCCESS"){
                bankResult = await getCaptured(payment.bank_response.capture_id)
            } else {
                bankResult = await capture({
                authorization_id: payment.authorization_id,
                amount_cents: payment.amount_cents,
                idempotencyKey : payment.idempotency_key
                });
            }
        } else if (payment.type === "REFUND"){
            if (payment.status === "SUCCESS"){
                bankResult = await getRefunded(payment.bank_response.refund_id)
            } else {
                bankResult = await refund({
                capture_id: payment.capture_id,
                amount_cents: payment.amount_cents,
                idempotencyKey
                });
            }

        } else {
            return;
        }

        const successStatuses = ["approved", "captured", "refunded"];

        if (bankResult?.error === "not_found") {
            await client.query(
                `UPDATE payments
                SET status = 'FAILED'
                WHERE id = $1`,
                [payment.id]
            )
        } else if (successStatuses.includes(bankResult.status)) {
            await client.query(
                `UPDATE payments
                SET status = $1,
                capture_id = $2,
                captured_at = $3
                WHERE id = $4`,
                [payment.type === "CAPTURE" ? "CAPTURED" : "REFUNDED",
                    payment.type === "CAPTURE" ? bankResult.capture_id : bankResult.refund_id,
                    payment.type === "CAPTURE" ? bankResult.captured_at : refunded_at,
                    payment.id
                ]
            )
        }
    } catch (err) {
        console.error("Bank error for payment", payment.id, err)
    }
}


async function reconcilePendingPayment() {
    const client = await pool.connect()

    try {
        await client.query("BEGIN")

        const {rows : payments } = await client.query(
            `SELECT p.id, p.amount_cents, p.authorization_id, p.capture_id,
             p.type, a.bank_response, a.idempotency_key, a.status FROM payments p
            JOIN payment_attempts a 
                ON p.id = a.payment_id
            WHERE p.status = 'PENDING' AND a.status in ('INITIATED','SUCCESS')
            FOR UPDATE SKIP LOCKED
            LIMIT 10`
        )

        console.log(`[Scheduler] Found ${payments.length} pending payments`);

        for (const payment of payments) {
            await reconcileSinglePayment(client, payment);
        }


        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Reconciliation error", err)
    } finally {
        client.release();
    }
}

module.exports = { reconcilePendingPayment }