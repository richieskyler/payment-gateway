const {Pool} = require("pg");

const pool = new Pool({
    host:"localhost",
    port:5432,
    user:"postgres",
    password: "Password",
    database:"payment_gateway"
});

pool.on("connect", () => {
    console.log("connected to PostgreSQL")
});

module.exports = pool;