const paymentRepository = require("../repositories/paymentRepository");
const { withTransaction } = require("../utils/transaction");
const bankClient = require("../bank");  
const idempotencyRepository = require("../repositories/idempotencyRepository");
const { logger } = require("../utils/logger");

async function authorize(body, idempotencyKey, requestHash, correlationId) {
    let bankResult
    try {
        //Logging payment authorization process: Calling Bank Authorization API
        logger.info({
            correlationId,
            //paymentId: result?.payment.id,
            operation: "AUTHORIZE",
            message: "Calling bank authorize API"
        });

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
        // console.error("Bank Authorize error",{
        //     idempotencyKey,
        //     status: err.response?.status,
        //     error: err.response?.data
        // })

        //Logging payment authorization process: Bank Authorization failed
        logger.error({
            correlationId,
            idempotencyKey,
            operation: "AUTHORIZE",
            error: err.response?.data?.error,
            message: err.response?.data?.message
        })

        //Throwing error
        const error = new Error(err.response?.data?.message || "Bank service is unavailable");
        error.status = 502;
        error.error = err.response?.data?.error;
        throw error
    }

    let response

    //DECLINED
    if (bankResult.status !== "approved") {
        response = {
            paymentStatus : "declined",
            error: bankResult.error,
            reason: bankResult.message
        }

        //Logging payment authorization process: Payment status declined
        logger.error({
            correlationId,
            idempotencyKey,
            operation: "AUTHORIZE",
            bankStatus: bankResult.status,
            bankError: bankResult.error,
            message: bankResult.message || "Payment authorization status failed"
        })
    } else {

        //Payment is being authorized
        return await withTransaction(async (client) => {
        const payment = await paymentRepository.createAuthorizedPayment(
            client,
            body,
            bankResult
        );
        response = {payment}; 
        //Saving idempotency Details to avoid reuse
        await idempotencyRepository.save(client, response, idempotencyKey, requestHash);
        return response;
    })
}
   
    return response;
}

async function capture(body, idempotencyKey, correlationId) {
    const paymentId = body.id;
    if (!paymentId) {
        const error = new Error("PaymentId does not exist in the request body");
        error.status = 400;
        throw error;
    }

    let payment;
    let captureAttempt;
    await withTransaction(async (client) => {
        //Getting the payment details from the DB
        payment = await paymentRepository.getPaymentForUpdate(client, paymentId);
        
        if (!payment) {
            const error = new Error("Payment not found");
            error.status = 404;
            throw error;
        }

        const validStatuses = ["AUTHORIZED","PENDING"]
        if (!validStatuses.includes(payment.status)) {
            const error = new Error(`Invalid State: ${payment.status}`)
                error.status = 409;
                error.paymentStatus = payment.status;
                throw error
        }
        
        //Capture attempt incase of failure
        if (payment.status === "AUTHORIZED") {
            await paymentRepository.startCapture(client,paymentId,idempotencyKey);
        }
    })
    
    let bankResult;

    //Logging payment capture process: Calling Bank CApture API
        logger.info({
            correlationId,
            operation: "CAPTURE",
            message: "Calling bank capture API"
        });

    try {
        bankResult = await bankClient.capture({
            authorization_id: payment.authorization_id,
            amount_cents: payment.amount_cents,
            idempotencyKey
        });
    } catch (err) {
        // console.error("Bank capture error:", {
        //     paymentId,
        //     idempotencyKey,
        //     status: err.response?.status,
        //     data: err.response?.data
        // });

        //Logging payment capture process: Bank capture failed
        logger.error({
            correlationId,
            operation: "CAPTURE",
            error: err.response?.data?.error,
            message: err.response?.data?.message
        })
        
        const errorMessage = err.response?.data?.message || "Bank service unavailable"
        const error = new Error(`BANK_CAPTURED_FAILED: ${errorMessage}`)
        error.status = 502;
        error.error = err.response?.data?.error || "BANK_CAPTURE_FAILED";
        throw error

    }

    //Payment is being captured
    return await withTransaction ( async (client) => {
        const payment = await paymentRepository.createCapturedPayment(
            client,
            paymentId,
            bankResult,
            idempotencyKey
        )

        const response = {payment}

        //Saving Idempotency details to avoid reuse
        await idempotencyRepository.save(client,response,idempotencyKey)
        return response
    })
}

async function voidPayment(body,idempotencyKey, correlationId) {
    const paymentId = body.id;
    if (!paymentId) {
        const error = new Error("PaymentId does not exist in the request body");
        error.status = 400;
        throw error;
    }
    
    let payment;
    await withTransaction(async (client) => {
        //Getting the payment details from the DB
        payment = await paymentRepository.getPaymentForUpdate(client, paymentId)

        if (!payment) {
            error = new Error("Payment not found")
            error.status = 404;
            throw error
        }

        if (payment.status !== "AUTHORIZED") {
            error = new Error(`Invalid State: ${payment.status}`)
            error.status = 409;
            throw error
        }

        //Capture attempt incase of failure 
        await paymentRepository.startVoid(client, paymentId, idempotencyKey)
    })

    let bankResult;

    //Logging payment void process: Calling Bank Void API
        logger.info({
            correlationId,
            //paymentId: result?.payment.id,
            operation: "VOID",
            message: "Calling bank void API"
        });

    try {
        bankResult = await bankClient.voidAuth({
            authorization_id : payment.authorization_id,
            idempotencyKey
        });

    } catch (err) {
        // console.error({
        //     paymentId,
        //     idempotencyKey,
        //     status: err.response?.status,
        //     data: err.response?.data
        // })

        logger.error({
            correlationId: correlationId,
            operation: "VOID",
            error: err.response?.data?.error,
            message: err.response?.data?.message
        })

        errorMessage = err.response?.data?.message
        error = new Error(`Bank Service Unavailable: ${errorMessage}`)
        error.status = 502;
        error.error = err.response?.data?.error || "BANK_VOID_FAILED"
        throw error
    }

    //Payment is being voided
    return await withTransaction(async (client) => {
        const payment = await paymentRepository.createVoidedPayment(
            client,
            paymentId,
            bankResult,
            idempotencyKey
        )

        const response = {payment}
        //Saving idempotency details to avoid reuse
        await idempotencyRepository.save(client,response,idempotencyKey)
        return response
    })
}

async function refund(body, idempotencyKey,correlationId) {
    const paymentId = body.id
    if (!paymentId) {
        const error = new Error("PaymentId does not exist in the request body");
        error.status = 400;
        throw error;
    }

    let payment;
    await withTransaction(async (client) => {
        payment = await paymentRepository.getPaymentForUpdate(client, paymentId)

        if (!payment) {
            error = new Error("Payment doesn't exist ")
            error.status = 404;
            throw error
        }

        const validStatuses = ["CAPTURED","PENDING"]
        if (!validStatuses.includes(payment.status)) {
            error = new Error("INVALID STATE")
            error.status = 404;
            error.paymentStatus = payment.status;
            throw error
        }

        //Capture attempt incase of failure
        if (payment.status === "CAPTURED") {
            await paymentRepository.startRefund(client,paymentId,idempotencyKey)
        }
    })

    //Call external bank API
    let bankResult

    //Logging payment refund process: Calling Bank refund API
        logger.info({
            correlationId,
            //paymentId: result?.payment.id,
            operation: "refund",
            message: "Calling bank refund API"
        });


    try {
        bankResult = await bankClient.refund({
            capture_id: payment.capture_id,
            amount_cents: payment.amount_cents,
            idempotencyKey
        });

    } catch (err){
        // console.error({
        //     status: err.response?.status,
        //     data: err.response?.data
        // })

        logger.error({
            correlationId: req.correlationId,
            operation: "REFUND",
            error: err.response?.data?.error,
            message: err.response?.data?.message
        })

        errorMessage = err.response?.data?.message
        error = new Error(`BANK_REFUND_FAILED: ${errorMessage}`)
        error.status = 502;
        error.error = err.response?.data?.error || "Bank Service Unavailable"
        throw error
    }

    //Payment being refunded
    return await withTransaction(async (client) => {
        const payment = await paymentRepository.createRefundedPayment(
            client,
            paymentId,
            bankResult,
            idempotencyKey
        )

        const response = {payment}
        //Saving idempotency details to avoid reuse
        await idempotencyRepository.save(client,response,idempotencyKey)
        return response
    })

}

module.exports = { authorize, capture, voidPayment, refund};