const express = require("express");
const pool = require("./db/pool")
const { authorize, capture, voidAuth, refund } = require("./bank");
const {authReqValidation} = require("./validation");
const { startReconciliationScheduler } =  require("./reconcile/scheduler");

const {v4: uuidv4} = require("uuid");

const app = express();
const router = express.Router();
app.use(express.json()); 
app.use(router); 





router.get("/", (req, res) =>{
    res.send("Welcome");
});


router.post("/payments/authorize",authReqValidation, async (req, res) =>{

    const paymentId = uuidv4();

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


    //Calling Bank external API
    let bankResult
    
    try {
        bankResult = await authorize(
            {
                amount_cents : req.body.amount_cents,
                card: {
                    card_number: req.body.card_number,
                    cvv: req.body.cvv,
                    expiry_month: req.body.expiry_month,
                    expiry_year: req.body.expiry_year
                },
                idempotencyKey,
            }
        )
    } catch (err) {
        console.error("Bank Authorize error",{
            status: err.response?.status,
            error: err.response?.data
        })

        return res.status(502).json({
            error: err.response?.data?.error || "BANK_ATHUROIZED_FAILED",
            message: err.response?.data?.message || "Bank service unavailable" 
        })

    }
    
    
    const client = await pool.connect();
    
        try {
            await client.query("BEGIN");

            let payment;
            let response;

            if (bankResult.status === "approved") {
                const result =  await client.query(
                    `INSERT INTO payments (id, order_id, customer_id, amount_cents, currency, status,authorization_id,type)
                    VALUES ($1, $2, $3, $4, $5, 'AUTHORIZED', $6, 'AUTHORIZE')
                    RETURNING *`,
                    [
                        paymentId,
                        req.body.order_id,
                        req.body.customer_id,
                        req.body.amount_cents,
                        bankResult.currency,
                        bankResult.authorization_id
                    ]
                );

                payment = result.rows[0];
                response = {payment};
            } else {
                response = {
                    error: bankResult.error,
                    reason: bankResult.message
                };
            }

            await client.query(
                `INSERT INTO idempotency_keys (key, response)
                VALUES ($1, $2)`,
                [idempotencyKey, response]
            );

            await client.query("COMMIT");
            return res.json(response);

        } catch (err) {
            await client.query("ROLLBACK");

            if (err.code == "23505") {
                return res.status(409).json({error:"Payment already exists"});
            }

            console.error(err);
             res.status(500).json({ error: "Internal server error" });
        } finally {
            client.release();
        }


});



router.post("/payments/capture", async (req, res) =>{

        //Request Validation 
        const paymentId = req.body.id;
        if (!paymentId) {
            return res.status(400).json({error:"PaymentId does not exist in the request body"})
        }


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
                storedResponse.payment?.id === req.body.payment_id && 
                storedResponse.payment?.type === 'CAPTURE'
            ) {
                return res.json(storedResponse);
            }
            return res.status(409).json({
                error: "Idempotency-Key reused with different parameters"
            });
        }


        let payment;
        let captureAttempt;

        const client1 = await pool.connect();

        try {
            await client1.query("BEGIN");

            const result = await client1.query(
                `SELECT * FROM payments
                WHERE id = $1
                FOR UPDATE`,
                [paymentId]
            )

            if (result.rowCount === 0) {
                await client1.query("ROLLBACK");
                return res.status(404).json({error:"Payment not found"})
            }

            payment = result.rows[0];

            const validStatuses = ["AUTHORIZED","PENDING"]

            //if (payment.status !== "AUTHORIZED") {
            if (!validStatuses.includes(payment.status)) {
                await client1.query("ROLLBACK");
                return res.status(409).json({
                    error:"INVALID_STATE",
                    status:payment.status
                });
            } 


            //Capture attempt incase of failure
            if (payment.status === "AUTHORIZED") {
                const attemptResult = await client1.query(
                    `INSERT INTO payment_attempts
                        (payment_id, status, idempotency_key)
                    VALUES ($1, 'INITIATED', $2)
                    RETURNING *`,
                    [paymentId, idempotencyKey]
                );

                captureAttempt = attemptResult.rows[0];

                //Pending Added
                await client1.query(
                    `UPDATE payments 
                    SET status = 'PENDING',
                    type = 'CAPTURE'
                    WHERE id = $1
                    RETURNING *`,
                    [paymentId]
                );
            }


            await client1.query("COMMIT");

        } catch (err) {
            await client1.query("ROLLBACK");
            throw err;
        } finally {
            client1.release();
        }

        //calling external Bank API
        
        let bankResult;

        try {
            bankResult = await capture({
                authorization_id: payment.authorization_id,
                amount_cents: payment.amount_cents,
                idempotencyKey
            });
        } catch (err) {
            console.error("Bank capture error:", {
                status: err.response?.status,
                data: err.response?.data
            });

            return res.status(502).json({
                error: err.response?.data?.error || "BANK_CAPTURE_FAILED",
                message: err.response?.data?.message || "Bank service unavailable"
            });

        }

        

        //After successful bank call update payment_attempt

        const clientAfterBank = await pool.connect();
        try {
        await clientAfterBank.query(
            `UPDATE payment_attempts
            SET status = 'SUCCESS',
                bank_response = $1
            WHERE payment_id = $2
            AND idempotency_key = $3`,
            [JSON.stringify(bankResult), paymentId, idempotencyKey]
        );
        } finally {
        clientAfterBank.release();
        }

        // await client1.query(
        //     `UPDATE payment_attempts
        //     SET status = 'SUCCESS',
        //     bank_response=$1
        //     WHERE payment_id=$2`,
        //     [JSON.stringify(bankResult), captureAttempt.payment_id]
        // )
    

        //DB Transaction
        const client2 = await pool.connect();
        try {
            await client2.query("BEGIN")

            const result = await client2.query(
                `SELECT * FROM payments
                WHERE id = $1
                FOR UPDATE`,
                [paymentId]
            )

            const paymentToBeUpdated = result.rows[0];

            if (paymentToBeUpdated.status !== "PENDING" && paymentToBeUpdated.type !== "CAPTURE" ) {
                await client2.query("ROLLBACK");
                return res.status(409).json({
                    error:"ALREADY PROCESSED",
                    status: paymentToBeUpdated.status
                });
            }

            const paymentUpdated = await client2.query(
                `UPDATE payments 
                SET status = 'CAPTURED',
                type = 'CAPTURE',
                capture_id = $1,
                captured_at = $2
                WHERE id = $3
                RETURNING *`,
                [bankResult.capture_id, bankResult.captured_at, paymentId]
            );

            const response = {payment : paymentUpdated.rows[0]};

            await client2.query(
                `INSERT INTO idempotency_keys (key, response)
                 VALUES ($1, $2)`,
                 [idempotencyKey, response]
            );

            await client2.query("COMMIT");
            return res.json(response);

        } catch (err) {
            await client2.query("ROLLBACK");
            throw err;
        } finally {
            client2.release();
        }
    
});

router.post("/payments/void", async (req, res) =>{
    
    //Request Validation
    const paymentId = req.body.id;
    if (!paymentId) {
        return res.status(400).json({error:"PaymentId does not exist in the request body"})
    }

    const idempotencyKey = req.header("Idempotency-Key");
    if (!idempotencyKey) {
        return res.status(400).json({error:"Missing Idempotency-Key"});
    }

    const cached = await pool.query(
        `SELECT response from idempotency_keys WHERE key = $1`,
        [idempotencyKey]
    )

    if (cached.rowCount > 0) {
        const storedResponse = cached.rows[0].response;
        if (
            storedResponse.payment?.id === req.body.payment_id && 
            storedResponse.payment?.type === 'VOID'
        ) {
            return res.json(storedResponse);
        } 
        return res.status(409).json({
            error: "Idempotency-Key reused with different parameters"
        });
    }

    let payment;

     //Payment state validation
    const client1 = await pool.connect();

    try {

        await client1.query("BEGIN");

        const result = await client1.query(
            `SELECT * FROM payments where id = $1
                FOR UPDATE`,
                [paymentId]
        )

        if (result.rowCount === 0) {
            await client1.query("ROLLBACK");
            return res.status(404).json({error: "Payment not found"});  
        }

        payment = result.rows[0];

        if (payment.status !== "AUTHORIZED") {
            await client1.query("ROLLBACK")
            return res.status(409).json({
                error: "Invalid state",
                status: payment.status
            });
        }

        //Pending Added
        await client1.query(
            `UPDATE payments 
            SET status = 'PENDING',
            type = 'VOID'
            WHERE id = $1
            RETURNING *`,
            [paymentId]
        );

        await client1.query("COMMIT");

    } catch (err) {
        await client1.query("ROLLBACK");
        throw err;
    } finally {
        client1.release(); 
    }
        
    //Call Bank API to void
    
    let bankResult
    try {
        bankResult = await voidAuth({
            authorization_id : payment.authorization_id,
            idempotencyKey
        });

    } catch (err) {
        console.error({
            status: err.response?.status,
            data: err.response?.data
        })

        return res.status(502).json({
            error: err.response?.data?.error || "BANK_VOID_FAILED",
            message: err.response?.data?.message || "Bank Service is Unavailable"
        })
    }


    //DB Transaction

    const client2 = await pool.connect();
    try {
        await client2.query("BEGIN");

        const result = await client2.query(
            `SELECT * FROM payments
             WHERE id = $1
             FOR UPDATE`,
             [paymentId]
        );

        const paymentToBeUpdated = result.rows[0];

        if (paymentToBeUpdated.status !== "AUTHORIZED") {
            await client2.query("ROLLBACK");
            return res.status(409).json({
                error: "ALREADY_PROCESSED",
                status: paymentToBeUpdated.status
            });
        }

        const paymentUpdated = await client2.query(
            `UPDATE payments 
            SET status = 'VOIDED',
            type = 'VOID',
            void_id = $1,
            voided_at = $2
            WHERE id = $3
            RETURNING *`,
            [bankResult.void_id, bankResult.voided_at, paymentId]
            
        )

        const response = {payment: paymentUpdated.rows[0]};

        await client2.query(
            `INSERT INTO idempotency_keys (key, response)
             VALUES ($1, $2)`,
             [idempotencyKey, response]
        );

        await client2.query("COMMIT")
        return res.json(response);
    } catch (err) {
        await client2.query("ROLLBACK");
        throw err;
    } finally {
        client2.release();
    }

});

router.post("/payments/refund", async (req, res) =>{

        const paymentId = req.body.id;
        const idempotencyKey = req.header("Idempotency-Key");

        if (!idempotencyKey) {
            return res.status(400).json({error:"Missing Idempotency-Key"});
        }

        const cached = await pool.query(
            `SELECT response from idempotency_keys
             WHERE key = $1`,
             [idempotencyKey]
        )

        if (cached.rowCount > 0) {
            const storedResponse = cached.rows[0].response;
            if (
                storedResponse.payment?.id === req.body.payment_id && 
                storedResponse.payment?.type === 'REFUND'
            ) {
                return res.json(storedResponse);
            }
            return res.status(409).json({
                error: "Idempotency-Key reused with different parameters"
            });
        }

        let payment

        const client1 = await pool.connect();

        try {
            await client1.query("BEGIN")

            const result = await client1.query(
                `SELECT * FROM payments
                 WHERE id = $1
                 FOR UPDATE`,
                 [paymentId]
            )

            if (result.rowCount === 0) {
                await client1.query('ROLLBACK');
                return res.status(404).json({error:"Payment doesn't exist"})
            }

            payment = result.rows[0];

            const validStatuses = ["CAPTURED","PENDING"]

            //if (payment.status !== "CAPTURED") {
            if (!validStatuses.includes(payment.status)) {
                await client1.query("ROLLBACK");
                return res.status(404).json({
                    error : "INVALID STATE",
                    status : payment.status
                })
            }

             //Capture attempt incase of failure

             if (payment.status === "CAPTURED") {
                const attemptResult = await client1.query(
                    `INSERT INTO payment_attempts
                        (payment_id, status, idempotency_key)
                    VALUES ($1, 'INITIATED', $2)
                    RETURNING *`,
                    [paymentId, idempotencyKey]
                );

                const refundAttempt = attemptResult.rows[0];

                //Pending Added
                await client1.query(
                    `UPDATE payments 
                    SET status = 'PENDING',
                    type = 'REFUND'
                    WHERE id = $1
                    RETURNING *`,
                    [paymentId]
                );
            }
            await client1.query("COMMIT");

        } catch (err) {
            await client1.query("ROLLBACK");
            throw err;
        } finally {
            client1.release(); 
        }


        //Call external bank API
        let bankResult

        try {

            bankResult = await refund({
                capture_id: payment.capture_id,
                amount_cents: payment.amount_cents,
                idempotencyKey
            });

        } catch (err){
            console.error({
                status: err.response?.status,
                data: err.response?.data
            })

            return res.status(502).json({
                error: err.response?.data?.error || "BANK_REFUND_FAILED",
                message: err.response?.data.message || "Bank Service Unavailable"
            })

        }

        //After successful bank call update payment_attempt
        await client1.query(
            `UPDATE payment_attempt
            SET status = 'SUCCESS',
            bank_response=$1
            WHERE id=$2`,
            [JSON.stringify(bankResult), refundAttempt.payment_id]
        )
        

        //DB Transaction

        const client2 = await pool.connect();

        try {
            await client2.query("BEGIN")

            const result = await client2.query(`
                SELECT * FROM payments 
                WHERE  id = $1
                FOR UPDATE`,
                [paymentId]
            )

            const paymentToBeUpdated =  result.rows[0];

            if (paymentToBeUpdated.status !== "CAPTURED") {
                await client2.query("ROLLBACK");
                return res.status(404).json({
                    error : "ALREADY_PROCESSED",
                    status : payment.status
                })
            }

            const paymentUpdated = await client2.query(`
                UPDATE payments
                set status = 'REFUNDED',
                type = 'REFUND',
                refund_id = $1,
                refunded_at = $2
                WHERE id = $3
                RETURNING *`,
                [bankResult.refund_id, bankResult.refunded_at, paymentId]
            )

            const response = {payment:paymentUpdated.rows[0]}

            await client2.query(
                `INSERT INTO idempotency_keys (key,response)
                VALUES ($1, $2)`,
                [idempotencyKey, response]
            )

            await client2.query("COMMIT");
            return res.json(response);

        } catch (err) {
            await client2.query("ROLLBACK")
            throw err;
        } finally {
            client2.release();
        }
    
})

startReconciliationScheduler();

app.listen(3000, () => {
    console.log("Server running on http://localhost:3000");
});