const {v4: uuidv4 } = require("uuid");

///Function that fetches payment for update
async function getPaymentForUpdate(client, paymentId) {
    const result = await client.query(
        `SELECT * FROM payments
        WHERE id = $1
        FOR UPDATE`,
        [paymentId]
    );

    return result.rows[0];
}

//Creating authorized payment
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

//capturing capture attempt
async function startCapture(client, paymentId, idempotencyKey) {
    const attemptResult = await client.query(
        `INSERT INTO payment_attempts 
        (payment_id, status, idempotency_key) 
        VALUES ($1, 'CAPTURING', $2)
        RETURNING *`,
        [paymentId, idempotencyKey]
    );

    //Pending Added to identify capturing process is ongoing
    await client.query(
        `UPDATE payments 
        SET status = 'PENDING',
        type = 'CAPTURE'
        WHERE id = $1
        RETURNING *`,
        [paymentId]
    );

    return attemptResult.rows[0];
}
//starting capture process
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

//capturing void attempt 
async function startVoid(client, paymentId, idempotencyKey) {
    const attemptResult = await client.query(
        `UPDATE payment_attempts
        SET status = 'VOIDING'
        WHERE payment_id = $1 AND idempotency_key = $2
        RETURNING *`,
        [paymentId, idempotencyKey]
    );

    await client.query(
        `UPDATE payments 
        SET status = 'PENDING',
        type = 'VOID'
        WHERE id = $1
        RETURNING *`,
        [paymentId]
    );
    return attemptResult.rows[0];
}
//starting void process
async function createVoidedPayment(client, paymentId, bankResult, idempotencyKey) {
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
        );

    const paymentToBeUpdated = result.rows[0];

    if (paymentToBeUpdated.status !== "PENDING" && paymentToBeUpdated.type !== "VOID") {
        error =  new Error(`ALREADY_PROCESSED: ${paymentToBeUpdated.status}`)
        error.status = 409;
         throw error
    }

    //Updating Database after succeessful void from the bank API
    const paymentUpdated = await client.query(
        `UPDATE payments 
            SET status = 'VOIDED',
            type = 'VOID',
            void_id = $1,
            voided_at = $2
        WHERE id = $3
        RETURNING *`,
        [bankResult.void_id, bankResult.voided_at, paymentId]
    )

    return paymentUpdated.rows[0];

}

//capturing refund attempt
async function startRefund(client, paymentId, idempotencyKey) {
    const attemptResult = await client.query(
        `UPDATE payment_attempts
        SET status = 'REFUNDING'
        WHERE payment_id = $1 AND idempotency_key = $2
        RETURNING *`,
        [paymentId, idempotencyKey]
    );
    
    //Pending Added
    await client.query(
        `UPDATE payments 
        SET status = 'PENDING',
        type = 'REFUND'
        WHERE id = $1
        RETURNING *`,
        [paymentId]
    );

    return attemptResult.rows[0];
    
}
//starting refund process
async function createRefundedPayment(client, paymentId, bankResult, idempotencyKey) {
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
         WHERE  id = $1
         FOR UPDATE`,
        [paymentId]
    )

    const paymentToBeUpdated =  result.rows[0];

    if (paymentToBeUpdated.status !== "PENDING" && paymentToBeUpdated.type !== "REFUND") {
        error = new Error("ALREADY_PROCESSED")
        error.status = 404;
        error.paymentStatus = paymentToBeUpdated.status
        throw error
    }

    const paymentUpdated = await client.query(
        `UPDATE payments
          set status = 'REFUNDED',
          type = 'REFUND',
          refund_id = $1,
          refunded_at = $2
          WHERE id = $3
         RETURNING *`,
        [bankResult.refund_id, bankResult.refunded_at, paymentId]
    )

    return paymentUpdated.rows[0];
}

module.exports = { createAuthorizedPayment, createCapturedPayment, createVoidedPayment, createRefundedPayment, getPaymentForUpdate, startCapture, startRefund, startVoid };