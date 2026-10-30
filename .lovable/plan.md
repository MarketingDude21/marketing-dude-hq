# Sweet Assist sign-on endpoint

Sweet Assist's server sends a signed request with an agent's email. The app answers with a one-time link that signs the agent straight into Monthly Marketing. Existing pages, the login screen and current sign-in all stay as they are.

## What gets built

1. **New endpoint:** `POST /api/public/sso/exchange`. Steps run in the order from the brief:
   - **Signature:** read the raw body, compute HMAC-SHA256 with `SA_SSO_SHARED_SECRET` (`_STAGING` also accepted) and compare in constant time. A failure returns 401 `invalid_signature`.
   - **Input:** validate the JSON with Zod (email, a whole-number `issued_at`, a UUID `nonce`). Bad input returns 400 `bad_request`.
   - **Clock:** more than 300 seconds off returns 401 `expired`.
   - **Nonce:** insert it, and return 409 `nonce_reused` on a duplicate. Delete nonces older than 1 hour on each request.
   - **Rate limit:** 30 per minute per IP (from `cf-connecting-ip`, falling back to `x-forwarded-for`) and 5 per minute per email. Over the limit returns 429 `rate_limited`.
   - **User lookup:** trim and lowercase the email, then match it case-insensitively against users through the admin client. No match or an unconfirmed email returns 404 `user_not_found`. More than one match returns 409 `ambiguous_user` and is logged. No user is ever created.
   - **Link:** call `generateLink({ type: "magiclink", email: storedEmail, options: { redirectTo: "https://app.yourmarketingdude.com/marketing" } })`, send no email, and return 200 `{ url }`.
   - **Logs and errors:** each request logs one line (time, normalized email, result code) with no signature, secret or link. Unexpected errors return 500 `server_error` with no stack trace.

2. **Database:** two server-only tables, each with RLS on, no policies, and a grant to `service_role` only:
   - `sso_nonces (nonce text primary key, created_at timestamptz default now())`
   - `sso_rate_limits (bucket text, window_start timestamptz, count int, primary key(bucket, window_start))`, counted with an atomic upsert. An internal function does the insert-or-increment and returns the new count, and only `service_role` can run it.

3. **Landing on /marketing:** the link comes back with sign-in tokens after the `#` in the address. The app's sign-in client already reads those by default, and the Marketing page checks the signed-in user in the browser, not on the server. So no landing change is expected. This will be checked in a fresh browser. If the session doesn't stick, a small handler will be added to the Marketing page to read the tokens, and the change will be explained.

## Technical details
- **Files:**
  - `src/routes/api/public/sso/exchange.ts` holds the route handler.
  - `src/lib/sso.server.ts` holds the HMAC check, user lookup and rate limiting.
  - The admin client is loaded inside the handler.
- **Signing:** HMAC uses Web Crypto, which works on Workers. The signature is compared byte by byte in constant time.
- **Auto-sign-in check:** `https://app.yourmarketingdude.com/**` is already on the allowed redirect list, so the link is allowed to return to /marketing.
- **Duplicate accounts:** michelle@millerregroup.com has two accounts that differ only in capitals, so she will get `ambiguous_user` until they are merged.
- **Verification:**
  - Signed curl calls covering success, bad signature, expired, reused nonce and unknown user.
  - Open the returned link in Playwright and confirm /marketing shows the user signed in.
  - Record the decision in AGENTS.md.
  - Hand over a curl example at the end.
