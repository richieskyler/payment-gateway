const paymentRepository = require("../repositories/paymentRepository");
const { withTransaction } = require("../utils/transaction");
const bankClient = require("../bank");  
const idempotencyRepository = require("../repositories/idempotencyRepository");

async function authorize(body, idempotencyKey) {
    let bankResult
    try {
        bankResult = await bankClient.authorize(
            {
                amount_cents : body.amount_cents,
                card: {
                    card_number: body.card_number,
                    cvv: body.cvv,
                    expiry_month: body.expiry_month,
                    expiry_year: body.expiry_year
                },
                idempotencyKey,
            }
        )
    } catch (err) {
        console.error("Bank Authorize error",{
            idempotencyKey,
            status: err.response?.status,
            error: err.response?.data
        })

        //Throwing error
        const error = new Error(err.response?.data?.message || "Bank service is unavailable");
        error.status = 502;
        error.code = err.response?.data?.error || "Bank_Authorized_failed";
        throw error
    }

    if (bankResult.status !== "approved") {
        return {
            error: bankResult.error,
            reason: bankResult.message
        };
    }

    return await withTransaction(async (client) => {
        const payment = await paymentRepository.createAuthorizedPayment(
            client,
            body,
            bankResult
        );
        const response = {payment};

        await idempotencyRepository.save(client, response, idempotencyKey);
        return response;
    })

}

async function capture(body, idempotencyKey) {
    const paymentId = body.id;
    if (!paymentId) {
        const error = new Error("PaymentId does not exist in the request body");
        error.status = 400;
        throw error;
    }

    let payment;
    let captureAttempt;
    await withTransaction(async (client) => {
        const result = await client.query(
            `SELECT * FROM payments
            WHERE id = $1
            FOR UPDATE`,
            [paymentId]
        )

        if (result.rowCount === 0) {
            const error = new Error("Payment not found");
            error.status = 404;
            throw error;
        }

        payment = result.rows[0];
        const validStatuses = ["AUTHORIZED","PENDING"]
        if (!validStatuses.includes(payment.status)) {
            const error = new Error("Invalid state ")
                error.status = 409;
                error.paymentStatus = payment.status;
                throw error
        }
        

        //Capture attempt incase of failure
        if (payment.status === "AUTHORIZED") {
            const attemptResult = await client.query(
                `INSERT INTO payment_attempts 
                    (payment_id, status, idempotency_key) 
                VALUES ($1, 'INITIATED', $2)
                RETURNING *`,
                [paymentId, idempotencyKey]
            );

            captureAttempt = attemptResult.rows[0];

            //Pending Added
            await client.query(
                `UPDATE payments 
                SET status = 'PENDING',
                type = 'CAPTURE'
                WHERE id = $1
                RETURNING *`,
                [paymentId]
            );
        }
    })
    
    let bankResult;

    try {
        bankResult = await bankClient.capture({
            authorization_id: payment.authorization_id,
            amount_cents: payment.amount_cents,
            idempotencyKey
        });
    } catch (err) {
        console.error("Bank capture error:", {
            paymentId,
            idempotencyKey,
            status: err.response?.status,
            data: err.response?.data
        });
        
        const errorMessage = err.response?.data?.message || "Bank service unavailable"
        const error = new Error(`BANK_CAPTURED_FAILED: ${errorMessage}`)
        error.status = 502;
        error.code = err.response?.data?.error || "BANK_CAPTURE_FAILED";
        throw error

    }

    return await withTransaction ( async (client) => {
        const payment = await paymentRepository.createCapturedPayment(
            client,
            paymentId,
            bankResult,
            idempotencyKey
        )

        const response = {payment}
        await idempotencyRepository.save(client,response,idempotencyKey)
        return response
    })
}

module.exports = { authorize, capture };