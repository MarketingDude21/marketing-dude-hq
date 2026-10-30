// Server-only helpers for the Sweet Assist SSO exchange endpoint.
const enc = new TextEncoder();

export async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // Compare full length of the longer input so timing doesn't leak length match.
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/** True if the signature matches any configured secret. Always checks every secret. */
export async function verifySignature(body: string, signature: string | null): Promise<boolean> {
  if (!signature) return false;
  const provided = signature.trim().toLowerCase();
  const secrets = [process.env["SA_SSO_SHARED_SECRET"], process.env["SA_SSO_SHARED_SECRET_STAGING"]].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  let ok = false;
  for (const s of secrets) {
    if (constantTimeEqual(await hmacHex(s, body), provided)) ok = true;
  }
  return ok;
}

export function clientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

export function minuteWindow(now = Date.now()): string {
  return new Date(Math.floor(now / 60000) * 60000).toISOString();
}

export function logOutcome(email: string | null, code: number, result: string) {
  console.log(
    JSON.stringify({ evt: "sso_exchange", at: new Date().toISOString(), email, code, result }),
  );
}
