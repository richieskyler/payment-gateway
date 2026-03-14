const paymentService = require("../services/paymentService");


async function authorize(req, res, next) {
    try {
        const result = await paymentService.authorize(req.body, req.headers["idempotency-key"])
        return res.json(result);
    } catch (err) {
        next(err);
    }
}

async function capture(req, res, next){
    try {
        const result = await paymentService.capture(req.body, req.headers["idempotency-key"])
        return res.json(result)
    } catch (err) {
        next(err);
    }
}

module.exports = { authorize, capture };