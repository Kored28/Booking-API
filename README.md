# Clinic booking API (Express + Postgres)

Follows the Koya assessment contract. All routes need header `X-API-Key`
(except `/health` and the web page at `/`). Errors are `{"error": "<message>"}`.

- POST   /reset            body { slots: [{id, provider, start, end}] } replaces all slots, deletes all bookings
- GET    /slots[?provider=]
- POST   /bookings         body { slot_id, name, email }, optional header Idempotency-Key
- GET    /bookings?email=&limit=&cursor=   -> { bookings, next_cursor }
- GET    /bookings/:id
- DELETE /bookings/:id

