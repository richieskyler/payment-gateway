const pool = require("../db/pool");
 
 async function idempotencyMiddleware(req, res, next) {
    const idempotencyKey = req.header("Idempotency-Key");

    if (!idempotencyKey) {
        return res.status(400).json({error:"Missing Idempotency-Key"});
    }

    const cached = await pool.query(
        "SELECT response FROM idempotency_keys WHERE key = $1",
        [idempotencyKey]
    );

    if (cached.rowCount > 0) {
            const storedResponse = cached.rows[0].response;

        if (
            storedResponse.payment?.amount_cents === req.body.amount_cents &&
            storedResponse.payment?.order_id === req.body.order_id &&
            storedResponse.payment?.customer_id === req.body.customer_id
        ) {
            return res.json(storedResponse);
        } else {
            return res.status(409).json({
                error: "Idempotency-Key reuse with different parameters"
            });
        }
    }
    req.idempotencyKey = idempotencyKey ;
    next();
}

module.exports = { idempotencyMiddleware};
 