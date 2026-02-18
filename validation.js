function authReqValidation(req, res, next) {
    const amount_cents = req.body.amount_cents;
    const card_number = req.body.card_number;
    const cvv = req.body.cvv;
    const expiry_month = req.body.expiry_month;
    const expiry_year = req.body.expiry_year;
    const order_id = req.body.order_id;
    const customer_id = req.body.customer_id;

    //Amount Validation
    if (!amount_cents) {
        return res.status(400).json({error:"Amount cannot be found"})
    } else if (amount_cents < 0) {
        return res.status(400).json({error:"Invalid amount"}) 
    }

    //Card-Number Validation
    if (!card_number) {
        return res.status(400).json({ error: "Card Number cannot be found" });
    }

    const cardStr = String(card_number);
    if (!/^\d{16}$/.test(cardStr)) {
        return res.status(400).json({ error: "Invalid card number" });
    }

    //CVV Validation
    const cvvStr = String(cvv);

    if (!cvv) {
        return res.status(400).json({ error: "CVV cannot be found" });
    }

    if (!/^\d{3,4}$/.test(cvvStr)) {
        return res.status(400).json({ error: "Invalid CVV" });
    }

    //Expiry Month Validation
    const month = Number(expiry_month);

    if (!expiry_month) {
        return res.status(400).json({ error: "Expiry month cannot be found" });
    }

    if (!Number.isInteger(month) || month < 1 || month > 12) {
        return res.status(400).json({ error: "Invalid expiry month" });
    }

    //Expiry year Validation
    const year = Number(expiry_year);
    const currentYear = new Date().getFullYear();

    if (!expiry_year) {
        return res.status(400).json({ error: "Expiry year cannot be found" });
    }

    if (
        !Number.isInteger(year) ||
        year < currentYear ||
        year > currentYear + 20
    ) {
        return res.status(400).json({ error: "Invalid expiry year" });
    }

    next();
}

module.exports = {authReqValidation};



    