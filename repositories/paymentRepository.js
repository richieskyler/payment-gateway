const {v4: uuidv4 } = require("uuid");

async function createAuthorizedPayment(client, body, bankResult) {
    const paymentId = uuidv4();

    const result = await client.query(
        `INSERT INTO payments
        (id, order_id, customer_id, amount_cents, currency, status, authorization_id, type)
        VALUES ($1,$2,$3,$4,$5,'AUTHORIZED',$6,'AUTHORIZE')
        RETURNING *`,
        [
        paymentId,
        body.order_id,
        body.customer_id,
        body.amount_cents,
        bankResult.currency,
        bankResult.authorization_id,
        ]
    );
    return result.rows[0];
}

async function createCapturedPayment(client,paymentId, bankResult, idempotencyKey) {
    await client.query(
        `UPDATE payment_attempts
            SET status = 'SUCCESS',
            bank_response = $1
        WHERE payment_id = $2
            AND idempotency_key = $3`,
        [JSON.stringify(bankResult), paymentId, idempotencyKey]
    );

    const result = await client.query(
        `SELECT * FROM payments
        WHERE id = $1
        FOR UPDATE`,
        [paymentId]
    )

    const paymentToBeUpdated = result.rows[0];
    if (paymentToBeUpdated.status !== "PENDING" && paymentToBeUpdated.type !== "CAPTURE" ) {
        const error = new Error("ALREADY PROCESSED");
        error.status = 409
        error.paymentStatus = paymentToBeUpdated.status
        throw error
    }

    const paymentUpdated = await client.query(
        `UPDATE payments 
            SET status = 'CAPTURED',
            type = 'CAPTURE',
            capture_id = $1,
            captured_at = $2
        WHERE id = $3
            RETURNING *`,
        [bankResult.capture_id, bankResult.captured_at, paymentId]
    );

    return paymentUpdated.rows[0];

}

module.exports = { createAuthorizedPayment, createCapturedPayment };