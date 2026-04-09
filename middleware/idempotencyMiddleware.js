const { request } = require("http");
const pool = require("../db/pool");
const crypto = require("crypto");

//Introduction Hashing 
function hashPayload(payload) {
    return crypto
        .createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex");
}
 
 async function idempotencyMiddleware(req, res, next) {
    const idempotencyKey = req.header("Idempotency-Key");

    if (!idempotencyKey) {
        return res.status(400).json({error:"Missing Idempotency-Key"});
    }

    //console.log("BODY DEBUG:", req.body);

    const requestHash = hashPayload(req.body);

    const cached = await pool.query(
        "SELECT response, request_hash FROM idempotency_keys WHERE key = $1",
        [idempotencyKey]
    );

    if (cached.rowCount > 0) {
            const {response, request_hash} = cached.rows[0];

        if (
            request_hash === requestHash
        ) {
            return res.json(response);
        } else {
            return res.status(409).json({
                error: "Idempotency-Key reuse with different parameters"
            });
        }
    }

    //attached for use in the controller
    req.idempotencyKey = idempotencyKey;
    req.requestHash = requestHash;

    next();
}

module.exports = { idempotencyMiddleware};
 