import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AmbientBackground, BrandMark } from "@/components/AppShell";
import { supabase } from "@/integrations/supabase/client";

// New route (2026-09-24) — the second half of the "lost password" flow
// added to login.tsx. Clicking "Forgot password?" there sends the person a
// Supabase recovery email; the link in that email lands them HERE. Supabase
// JS (detectSessionInUrl, on by default) parses the token out of the URL
// itself and fires an onAuthStateChange event of type "PASSWORD_RECOVERY,"
// which is what unlocks the form below — this page never has to touch the
// token directly.
//
// Deliberately its own standalone page (not wrapped in AppShell, same
// reasoning as login.tsx) since arriving here doesn't mean "normally signed
// in" the way visiting any other route does.
//
// IMPORTANT for Mike to set up in Supabase, not just paste code: this
// redirect only works if "<your app's URL>/reset-password" (e.g.
// https://app.yourmarketingdude.com/reset-password) is added to Supabase →
// Authentication → URL Configuration → Redirect URLs. Without that,
// Supabase silently refuses the redirect and the emailed link won't land
// here correctly.

export const Route = createFileRoute("/reset-password")({
  head: () => ({
    meta: [
      { title: "Reset your password — Your Marketing Dude" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const navigate = useNavigate();
  // "checking" while we wait to see if this visit carries a valid recovery
  // session; "ready" once Supabase confirms one; "invalid" if it never
  // shows up (expired link, or someone just navigated here directly).
  const [status, setStatus] = useState<"checking" | "ready" | "invalid">("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setStatus("ready");
    });
    // Fallback for the (normal) case where the event already fired before
    // this listener was attached — if there's already a session by the
    // time we check, treat that as good enough to let them set a password.
    const timer = setTimeout(() => {
      supabase.auth.getSession().then(({ data }) => {
        setStatus((cur) => (cur === "checking" ? (data.session ? "ready" : "invalid") : cur));
      });
    }, 1500);
    return () => {
      sub.subscription.unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 6) {
      setError("Password needs to be at least 6 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Those passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update your password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-background text-foreground">
      <AmbientBackground />
      <div className="relative z-10 mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-8 px-6 py-16">
        <Link to="/" aria-label="Your Marketing Dude home" className="inline-flex">
          <BrandMark size="h-16 w-auto" />
        </Link>

        <div className="w-full rounded-3xl border border-border bg-glass p-7 backdrop-blur-2xl sm:p-9">
          <h1 className="font-display text-xl font-bold">Reset your password</h1>

          {status === "checking" && (
            <p className="mt-4 text-sm text-muted-foreground">Checking your link…</p>
          )}

          {status === "invalid" && (
            <>
              <p className="mt-4 text-sm text-muted-foreground">
                This link is invalid or has expired. Head back to the sign-in page and click
                "Forgot password?" to get a new one.
              </p>
              <Link
                to="/login"
                className="mt-5 inline-block rounded-2xl bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30"
              >
                Back to sign in
              </Link>
            </>
          )}

          {status === "ready" && !done && (
            <>
              <p className="mt-2 text-sm text-muted-foreground">
                Choose a new password for your account.
              </p>
              <form onSubmit={onSubmit} className="mt-5 space-y-4">
                <label className="block">
                  <span className="text-sm font-medium text-muted-foreground">
                    New password
                  </span>
                  <input
                    type="password"
                    required
                    minLength={6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="mt-1.5 w-full rounded-2xl bg-muted px-4 py-3 text-base outline-none ring-ring transition focus:ring-2"
                  />
                </label>
                <label className="block">
                  <span className="text-sm font-medium text-muted-foreground">
                    Confirm new password
                  </span>
                  <input
                    type="password"
                    required
                    minLength={6}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="••••••••"
                    className="mt-1.5 w-full rounded-2xl bg-muted px-4 py-3 text-base outline-none ring-ring transition focus:ring-2"
                  />
                </label>
                <button
                  type="submit"
                  disabled={busy}
                  className="w-full rounded-2xl bg-primary py-3.5 text-base font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-transform hover:-translate-y-0.5 disabled:opacity-60"
                >
                  {busy ? "Updating…" : "Update password"}
                </button>
              </form>
              {error && (
                <p className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive-foreground">
                  {error}
                </p>
              )}
            </>
          )}

          {done && (
            <>
              <p className="mt-4 rounded-xl border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
                Your password's been updated.
              </p>
              <button
                onClick={() => navigate({ to: "/" })}
                className="mt-5 w-full rounded-2xl bg-primary py-3.5 text-base font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-transform hover:-translate-y-0.5"
              >
                Continue
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
