const { capture, refund, getCaptured, getRefunded } = require("../bank");
const pool = require("../db/pool")

///Reconcilation
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

        const successStatuses = [
            "approved", 
            "captured", 
            "refunded"];
        
        // if (bankResult?.error === "not_found") {
        // if (failedStatuses.includes(bankResult?.response?.data?.error)) {
        //     await client.query(
        //         `UPDATE payments
        //         SET status = 'FAILED'
        //         WHERE id = $1`,
        //         [payment.id]
        //     )
        // } else 
        if (successStatuses.includes(bankResult.status)) {
            await client.query(
                `UPDATE payments
                SET status = $1,
                capture_id = $2,
                captured_at = $3
                WHERE id = $4`,
                [payment.type === "CAPTURE" ? "CAPTURED" : "REFUNDED",
                    payment.type === "CAPTURE" ? bankResult.capture_id : bankResult.refund_id,
                    payment.type === "CAPTURE" ? bankResult.captured_at : bankResult.refunded_at,
                    payment.id
                ]
            )
        }
    } catch (err) {
        const failedStatuses = [
            "authorization_expired",
            "authorization_already_used",
            "already_captured",
            "already_voided",
            "already_refunded",
            "amount_mismatch",
            "capture_not_found",
            "refund_not_found",
            "not_found"
        ];

        const retryableStatues = [
            "internal_error"
        ]

        const bankError = err?.response?.data?.error;
        //Permanent failure 
        if (failedStatuses.includes(bankError)) {
            await client.query("BEGIN");
            try {
                await client.query(
                    `UPDATE payments
                    SET status = 'FAILED'
                    WHERE id = $1`,
                    [payment.id]
                );

                await client.query(
                    `UPDATE payment_attempts
                    SET status = 'FAILED',
                        last_error = $1
                    WHERE payment_id = $2`,
                    [bankError, payment.id]
                );

                await client.query("COMMIT");
            } catch (err) {
                await client.query("ROLLBACK");
                throw err;
            }
        }
        // //Retry later
        // else if (retryableStatues.includes(bankError)) {

        //     await client.query(
        //         `UPDATE payments
        //          SET status = 'PENDING_RECONCILIATION'
        //          WHERE id = $1`,
        //         [payment.id]
        //     )

        // // Unknown/system/network failure
        // } else {

        //     await client.query(
        //         `UPDATE payments
        //          SET status = 'UNKNOWN'
        //          WHERE id = $1`,
        //         [payment.id]
        //     )
        // }

        console.error("Bank error for payment", 
            payment.id, 
            err.response?.data)
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
            WHERE p.status = 'PENDING' AND a.status not in ('INITIATED','SUCCESS')
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