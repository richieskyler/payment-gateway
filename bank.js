const axios = require("axios");

const bank = axios.create({
    baseURL: "http://localhost:8787",
    timeout: 7000
})

function bankHeaders (idempotencyKey) {
    return {
        headers: {
            "Idempotency-Key": idempotencyKey,
            "Content-Type": "application/json"
        }
    }
}

//AUTHORIZATION
async function authorize({amount_cents, card, idempotencyKey}) {
    const res = await bank.post(
        "/api/v1/authorizations",
        {
            amount: amount_cents,
            card_number: card.card_number,
            cvv: card.cvv,
            expiry_month: card.expiry_month,
            expiry_year: card.expiry_year
        },
        bankHeaders(idempotencyKey)
    );

    return res.data
}

//GET AUTHORIZATION DETAILS
async function getAuthorized({authorizationId}) {
    const res = await bank.get(`api/v1/authorizations/${authorizationId}`);
    return res.data
}

//CAPTURE
async function capture({ authorization_id, amount_cents, idempotencyKey}) {
    const res = await bank.post(
        "/api/v1/captures",
        {
            authorization_id,
            amount: amount_cents
        },
        bankHeaders(idempotencyKey)
    );

    return res.data
}

async function getCaptured(captureId) {
    const res = await bank.get(`api/v1/captures/${captureId}`);
    return res.data
}

//VOID
async function voidAuth({authorization_id, idempotencyKey}){
    const res = await bank.post(
        "/api/v1/voids",
        {authorization_id},
        bankHeaders(idempotencyKey)
    );

    return res.data
}

//REFUND
async function refund({capture_id, amount_cents, idempotencyKey}) {
    const res = bank.post(
        "/api/v1/refunds",
        {
            capture_id,
            amount: amount_cents
        },
        bankHeaders(idempotencyKey)
    );

    return (await res).data;
}

async function getRefunded(refundId) {
    const res = await bank.get(`api/v1/refunds/${refundId}`);
    return res.data
}


module.exports = {
    authorize,
    capture,
    voidAuth,
    refund,
    getAuthorized,
    getCaptured,
    getRefunded
};


