const paymentService = require("../services/paymentService");
const { logger } = require("../utils/logger");


async function authorize(req, res, next) {
    try {
        //Logging payment authorization process: Starting payment authorization
        logger.info({
            correlationId: req.correlationId,
            //paymentId: result?.payment.id,
            operation: "AUTHORIZE",
            message: "Starting payment authorization"
        });

        const result = await paymentService.authorize(req.body, req.idempotencyKey, req.requestHash,req.correlationId)
        
        //Logging payment authorization process: Bank authorization successful
        logger.info({
            correlationId: req.correlationId,
            paymentId: result?.payment.id,
            operation: "AUTHORIZE",
            message: "Bank authorization successful"
        });

        return res.json(result);

    } catch (err) {
        next(err);
    }
}

async function capture(req, res, next){

    //Logging payment capture process: Starting payment capture
        logger.info({
            correlationId: req.correlationId,
            //paymentId: result?.payment.id,
            operation: "CAPTURE",
            message: "Starting payment capture"
        })
    try {
        const result = await paymentService.capture(req.body, req.headers["idempotency-key"], req.correlationId)

         //Logging payment capture process: Bank capture successful
        logger.info({
            correlationId: req.correlationId,
            paymentId: result?.payment.id,
            operation: "CAPTURE",
            message: "Bank capture successful"
        });

        return res.json(result)

    } catch (err) {
        next(err);
    }
}

async function voidPayment(req, res, next) {
    try {
        const result = await paymentService.voidPayment(req.body, req.headers["idempotency-key"])

        logger.info({
            correlationId: req.correlationId,
            paymentId: result?.paymentId,
            operation: "VOID",
            message: "Calling bank void API"
        });

        return res.json(result)

    } catch (err) {
        next(err)
    }    
}

async function refund(req, res, next) {
    try {
        const result = await paymentService.refund(req.body, req.headers["idempotency-key"])

         logger.info({
            correlationId: req.correlationId,
            paymentId: result?.paymentId,
            operation: "REFUND",
            message: "Calling bank refund API"
        });
        
        return res.json(result)


    } catch (err) {
        next(err)
    }    
}

module.exports = { authorize, capture, voidPayment, refund };