const express = require("express");
const pool = require("./db/pool")
//const idempotencyMiddleware  = require("./middleware/idempotencyMiddleware");
const paymentController = require("./controllers/paymentController");
const { idempotencyMiddleware } = require("./middleware/idempotencyMiddleware");
const { startReconciliationScheduler } =  require("./reconcile/scheduler");



const app = express();
app.use(express.json());

app.post("/payments/authorize",
    idempotencyMiddleware,
    paymentController.authorize
);

app.post("/payments/capture",
  idempotencyMiddleware,
  paymentController.capture
)

//module.exports = app;

startReconciliationScheduler();

app.listen(3000, () => {
  console.log("Server running on port 3000");
});