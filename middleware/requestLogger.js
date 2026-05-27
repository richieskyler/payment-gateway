const { v4: uuidv4 } = require("uuid");
const { logger } = require("../utils/logger");


function requestLogger(req, res, next) {
    const correlationId = req.headers["x-correlation-id"] || uuidv4();

    req.correlationId = correlationId;

    logger.info({
        correlationId,
        method: req.method,
        url: req.url,
        message: "Incoming request"
    })

    next();
}

module.exports = {requestLogger};