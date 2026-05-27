const { withTransaction } = require("../utils/transaction")

async function save(client, response, idempotencyKey, requestHash) {
//     console.log("SAVE DEBUG:", {
//   idempotencyKey,
//   requestHash,
//   responseType: typeof response,
// });
    await client.query(
         `INSERT INTO idempotency_keys (key, response, request_hash)
         VALUES ($1, $2, $3)`,
         [idempotencyKey, response, requestHash]
    );
    return response
}

module.exports = {save}