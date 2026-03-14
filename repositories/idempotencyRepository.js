const { withTransaction } = require("../utils/transaction")

async function save(client, response, idempotencyKey) {
    await client.query(
         `INSERT INTO idempotency_keys (key, response)
         VALUES ($1, $2)`,
         [idempotencyKey, response]
    );
    return response
}

module.exports = {save}