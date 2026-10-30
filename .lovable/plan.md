# Sweet Assist sign-on endpoint (revised)

Sweet Assist's server sends a signed request with an agent's email. The app answers with a one-time link that signs the agent straight into Monthly Marketing. Existing pages, the login screen and current sign-in all stay as they are. Nothing gets published; testing happens on preview only.

## Flow type check (done)
The app's browser sign-in client is the standard one with no flow type set (version 2.116.0). That means it uses the implicit flow, not PKCE, so it reads the `#access_token` tokens in the address on page load by default. No landing handler is planned. If the fresh-browser test or the "already signed in as someone else" test fails, a small handler will be added to the Marketing page to set the session from the tokens, and the change will be reported.

## Endpoint: `POST /api/public/sso/exchange`
1. **Signature:** read the raw body as text and compute HMAC-SHA256 with `SA_SSO_SHARED_SECRET`, also accepting `SA_SSO_SHARED_SECRET_STAGING`. Compare in constant time.
   - On failure, count the request toward a per-IP limit of 30 per minute. Over the limit returns 429 `rate_limited`; otherwise it returns 401 `invalid_signature`.
   - Requests with a valid signature are never limited by IP.
2. **Input:** validate the JSON with Zod: an email, a whole-number `issued_at` and a UUID `nonce`. Bad input returns 400 `bad_request`.
3. **Clock:** more than 300 seconds off returns 401 `expired`.
4. **Nonce:** insert it, and return 409 `nonce_reused` on a duplicate.
5. **Per-email limit:** 5 per minute for valid requests. Over the limit returns 429 `rate_limited`.
6. **User lookup:** trim and lowercase the email, then look it up through a database function (described under Database).
   - No match or an unconfirmed email returns 404 `user_not_found`.
   - More than one match returns 409 `ambiguous_user` and is logged.
   - No user is ever created.
7. **Link:** call `generateLink({ type: "magiclink", email: storedEmail, options: { redirectTo: "https://app.yourmarketingdude.com/marketing" } })` and send no email. Return 200 `{ url }`.
8. **Cleanup:** every request deletes nonces and rate-limit rows older than 1 hour.
9. **Logs and errors:** each request logs one line (time, normalized email, result code) with no signature, secret or link. Unexpected errors return 500 `server_error` with no stack trace.

## Database (one migration)
- **`sso_nonces`** `(nonce text primary key, created_at timestamptz default now())`.
- **`sso_rate_limits`** `(bucket text, window_start timestamptz, count int, primary key(bucket, window_start))`.
  - Buckets look like `ip:<addr>` or `email:<addr>`.
- **Access for both tables:** RLS on, no policies, and a grant to `service_role` only.
- **`sso_bump_rate_limit(bucket, window_start)`:** an atomic insert-or-increment that returns the new count.
- **`sso_find_auth_user(email)`:** returns id, email and `email_confirmed_at` from users where `lower(email)` equals the normalized email. It is `SECURITY DEFINER` with `search_path` fixed to the empty string, and every name in it is schema-qualified.
- **Permissions on both functions:** execute is revoked from public, anon and authenticated, and granted to `service_role` only.

## Files
- `src/routes/api/public/sso/exchange.ts` holds the route handler. The admin client is loaded inside the handler.
- `src/lib/sso.server.ts` holds the HMAC check using Web Crypto, the constant-time compare and the helpers.
- `AGENTS.md` gets one rule recording the decision.
- `roadmap.md` gets the task added.

## Verification on preview
- Signed curl calls, each expected to return the code shown:
  - Success with the production secret → 200, and with the staging secret → 200.
  - Bad signature → 401.
  - 31 bad-signature calls → 429 `rate_limited`.
  - Valid signature with bad JSON → 400 `bad_request`.
  - Expired timestamp → 401.
  - Reused nonce → 409.
  - Unknown email → 404.
  - michelle@millerregroup.com → 409 `ambiguous_user`.
  - 6 calls for one email → 429.
- In Playwright, open a returned link in a fresh browser and confirm /marketing shows that user signed in.
- Then open a link for user B while signed in as user A, and confirm the page switches to user B. If it doesn't, add the handler and report it.
- Hand over a curl example at the end.

## Test accounts (condition)
- Every test that reaches link generation uses only two test accounts: qaqctest@mailinator.com and ymd-sso-test-b@mailinator.com.
  - This covers the 200s with both secrets, the 6-calls-per-email test and both Playwright tests.
  - Any of these accounts that doesn't exist yet is created as already confirmed, with no email sent, through the admin client.
- The only real account the tests touch is michelle@millerregroup.com, for the ambiguous_user check, which never gets a link.
- Full links are never printed in the summary. Nothing is published.
