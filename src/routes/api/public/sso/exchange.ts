import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const REDIRECT_TO = "https://app.yourmarketingdude.com/marketing";
const MAX_SKEW_SECONDS = 300;
const IP_FAIL_LIMIT = 30;
const EMAIL_LIMIT = 5;

const BodySchema = z.object({
  email: z.string().trim().min(3).max(320).email(),
  issued_at: z.number().int().positive(),
  nonce: z.string().uuid(),
});

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export const Route = createFileRoute("/api/public/sso/exchange")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const sso = await import("@/lib/sso.server");
        let emailForLog: string | null = null;
        const done = (status: number, error: string | null, body?: Record<string, unknown>) => {
          sso.logOutcome(emailForLog, status, error ?? "ok");
          return json(status, body ?? { error });
        };

        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const window = sso.minuteWindow();

          // Opportunistic cleanup (best-effort).
          const cutoff = new Date(Date.now() - 3600_000).toISOString();
          await Promise.all([
            supabaseAdmin.from("sso_nonces").delete().lt("created_at", cutoff),
            supabaseAdmin.from("sso_rate_limits").delete().lt("window_start", cutoff),
          ]);

          // 1. Signature over the raw body.
          const raw = await request.text();
          const valid = await sso.verifySignature(raw, request.headers.get("x-sa-signature"));
          if (!valid) {
            const { data: count } = await supabaseAdmin.rpc("sso_bump_rate_limit", {
              _bucket: `ip:${sso.clientIp(request)}`,
              _window_start: window,
            });
            if ((count ?? 0) > IP_FAIL_LIMIT) return done(429, "rate_limited");
            return done(401, "invalid_signature");
          }

          // 2. Parse + validate.
          let parsed: z.infer<typeof BodySchema>;
          try {
            const r = BodySchema.safeParse(JSON.parse(raw));
            if (!r.success) return done(400, "bad_request");
            parsed = r.data;
          } catch {
            return done(400, "bad_request");
          }
          const email = parsed.email.trim().toLowerCase();
          emailForLog = email;

          // 3. Freshness.
          if (Math.abs(Math.floor(Date.now() / 1000) - parsed.issued_at) > MAX_SKEW_SECONDS) {
            return done(401, "expired");
          }

          // 4. Nonce replay.
          const { error: nonceErr } = await supabaseAdmin.from("sso_nonces").insert({ nonce: parsed.nonce });
          if (nonceErr) {
            if (nonceErr.code === "23505") return done(409, "nonce_reused");
            throw nonceErr;
          }

          // 5. Per-email rate limit.
          const { data: emailCount, error: rlErr } = await supabaseAdmin.rpc("sso_bump_rate_limit", {
            _bucket: `email:${email}`,
            _window_start: window,
          });
          if (rlErr) throw rlErr;
          if ((emailCount ?? 0) > EMAIL_LIMIT) return done(429, "rate_limited");

          // 6. User lookup (never creates users).
          const { data: users, error: findErr } = await supabaseAdmin.rpc("sso_find_auth_user", { _email: email });
          if (findErr) throw findErr;
          const matches = users ?? [];
          if (matches.length > 1) {
            console.warn(JSON.stringify({ evt: "sso_exchange_ambiguous", email, matches: matches.length }));
            return done(409, "ambiguous_user");
          }
          const user = matches[0];
          if (!user || !user.email_confirmed_at || !user.email) return done(404, "user_not_found");

          // 7. One-time link; generateLink does not send email.
          const { data: link, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
            type: "magiclink",
            email: user.email,
            options: { redirectTo: REDIRECT_TO },
          });
          if (linkErr || !link?.properties?.action_link) throw linkErr ?? new Error("no action_link");

          return done(200, null, { url: link.properties.action_link });
        } catch (e) {
          console.error(JSON.stringify({ evt: "sso_exchange_error", email: emailForLog, message: (e as Error)?.message }));
          return done(500, "server_error");
        }
      },
    },
  },
});
