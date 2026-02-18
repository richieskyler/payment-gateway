##Architecture

This payment gateway is responsible for enforcing correct payment lifecycle and accurate state transition. The gateway owns the full payment process including authorize, capture, void and refund. The bank is treated as an external and unreliable system, therefore the gateway must remain correct even if the bank fails, times out or the network drops.

Postgres is used as the source of truth because every state transition is persisted and controlled through database transactions. Row-level locking is enforced to prevent concurrency issues such as double capture or double refund. Idempotency is also implemented so that repeated requests yield the same result. This prevents double charging, double refunding and incorrect financial accounting. Financial systems must prioritize durability and consistency over speed.

External bank calls introduce uncertainty into the system. For capture and refund operations, the payment is first moved to a PENDING state before calling the bank. This represents temporary uncertainty. If the system crashes before or after the bank responds, reconciliation runs in the background and restores the correct state. Reconciliation is scheduled in-process for simplicity in this implementation, and database locking ensures safe execution even if scaled later. The system favors correctness over immediate certainty.


##State Management

The system enforces strict payment state transitions to prevent illegal money movement. The valid transitions are:

AUTHORIZED → CAPTURED → REFUNDED
AUTHORIZED → VOIDED
PENDING → (CAPTURED | REFUNDED | FAILED)


Only authorized payments can be captured. Only captured payments can be refunded. Only authorized payments can be voided. This ensures accurate money flow:

Authorized represents a hold on funds.

Captured represents collection of held funds.

Refunded represents returning collected funds.

Voided represents releasing the hold before collection.

VOIDED and REFUNDED are terminal states. Once a payment reaches either state, it cannot transition further. Allowing capture after void would attempt to collect money that was already released. Allowing refund after void would mean returning money that was never collected. Terminal states protect financial correctness.

The PENDING state represents uncertainty when interacting with the external bank system. It is used during capture and refund operations before the bank response is confirmed. This protects against crashes between the bank call and database update. It also prevents the system from falsely reporting success when the outcome is unknown. Reconciliation later resolves any remaining uncertainty and restores the correct state. This design ensures durability and crash recovery.

##Failure Handling

Anticipating failures and mitigating them is what makes a payment API reliable. This payment gateway is designed with the assumption that failures will happen at different boundaries: client level, gateway level, and bank level.

Client-level failures such as incorrect card details are validated before processing and rejected with a proper response, ensuring no state transition occurs. Duplicate requests and client retries are handled using idempotency keys. The same request with the same idempotency key always returns the original response. This prevents double charging, double refunding, and inconsistent financial records. Even if a client times out and retries, the system remains safe.

Gateway-level failures are controlled using database transactions and row-level locking. Primary key constraints prevent duplicate authorization inserts. Transactions ensure that partial updates are never committed. If a transaction fails or rolls back, the system state remains consistent. If the server crashes before the bank call, no external money movement has occurred. If the server crashes after the bank call but before updating the database, the payment remains in a PENDING state and reconciliation later restores the correct state. Locks are enforced on every update to prevent concurrent operations such as double capture or double refund.

Bank-level failures such as network timeouts, slow responses, 500 errors, or partial processing are treated as uncertain outcomes. In such cases, the system does not assume success or failure immediately. Instead, it uses the PENDING state and reconciliation to verify the final outcome with the bank. This ensures financial correctness even in distributed failure scenarios.

Overall, the system prioritizes correctness over immediate certainty. Accurate responses are given to the client based on the confirmed state of their payment request, and uncertainty is handled safely through reconciliation and idempotency.


##Idempotency

Idempotency is implemented in this payment gateway to prevent duplicate financial operations caused by retries or duplicate requests. In distributed systems, network timeouts or client retries are common. Without idempotency, the same payment operation (such as capture or refund) could be executed multiple times, leading to double charging, double refunding, or incorrect financial records.

Each payment request requires an idempotency key. The system ensures that the same request with the same idempotency key and identical payload always returns the original response. If the same idempotency key is reused with a different payload, the system rejects the request with a conflict error. This prevents misuse of keys and protects financial correctness.

The idempotency key is stored in the database alongside the payment operation. Persisting it ensures durability even after crashes or restarts. If a client retries a request due to a timeout, the system does not reprocess the payment but instead returns the previously stored response. This guarantees that retries never cause duplicate financial movement.

By enforcing idempotency at the database level and scoping it per operation (authorize, capture, refund), the system ensures accurate and consistent financial processing.