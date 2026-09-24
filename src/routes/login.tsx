import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AmbientBackground, BrandMark } from "@/components/AppShell";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Sign in — Your Marketing Dude" },
      {
        name: "description",
        content:
          "Sign in to Your Marketing Dude — one login for Voice DNA, your database builder, and monthly marketing content.",
      },
      { property: "og:title", content: "Sign in — Your Marketing Dude" },
      {
        property: "og:description",
        content: "One login. Your whole marketing brain.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // NEW (2026-09-24) — "Lost password" flow per Mike: "Also need a lost
  // password button on the login screen." `resetBusy` is separate from
  // `busy` so clicking "Forgot password?" doesn't visually disable/spin the
  // main Sign in button, and vice versa.
  const [resetBusy, setResetBusy] = useState(false);
  const navigate = useNavigate();
  const { session } = useAuth();

  useEffect(() => {
    if (session) navigate({ to: "/" });
  }, [session, navigate]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
        navigate({ to: "/" });
      } else {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/`,
            data: { full_name: fullName },
          },
        });
        if (error) throw error;
        if (!data.session) {
          setNotice("Check your inbox and click the confirmation link to finish setting up your account.");
        } else {
          navigate({ to: "/" });
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  // NEW (2026-09-24) — sends a Supabase password-recovery email to whatever
  // is currently typed in the Email field above (no separate email input,
  // to keep this a single click rather than a whole extra screen). Lands
  // the person on /reset-password (new route, see reset-password.tsx) via
  // the link in that email, where they actually set a new password.
  // requires "https://<your-domain>/reset-password" to be added to
  // Supabase's Auth → URL Configuration → Redirect URLs allow-list, or
  // Supabase will refuse to honor this redirect — flagged in delivery notes.
  const onForgotPassword = async () => {
    setError(null);
    setNotice(null);
    if (!email.trim()) {
      setError("Enter your email above first, then click “Forgot password?”");
      return;
    }
    setResetBusy(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) throw error;
      setNotice("Check your inbox for a link to reset your password.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send that reset email.");
    } finally {
      setResetBusy(false);
    }
  };

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-background text-foreground">
      <AmbientBackground />
      <div className="relative z-10 mx-auto flex min-h-screen max-w-6xl flex-col items-center justify-center gap-10 px-6 py-16 lg:flex-row lg:gap-16">
        <div className="max-w-xl flex-1">
          <Link to="/" aria-label="Your Marketing Dude home" className="inline-flex">
            <BrandMark size="h-24 w-auto" />
          </Link>
          <h1 className="mt-8 font-display text-5xl font-bold leading-[0.98] tracking-tight md:text-6xl">
            Your marketing,
            <br />
            <span className="bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">on autopilot.</span>
          </h1>
          <p className="mt-5 max-w-md text-lg text-muted-foreground">
            One brain that writes your posts, builds your list, and learns your voice every month.
          </p>
          <div className="mt-8 flex flex-wrap gap-2">
            {["Voice DNA", "SOI Database", "Content Engine"].map((t) => (
              <span
                key={t}
                className="inline-flex items-center rounded-full border border-border bg-glass px-4 py-2 text-sm font-medium text-muted-foreground backdrop-blur-xl"
              >
                {t}
              </span>
            ))}
          </div>
        </div>

        <div className="w-full max-w-md rounded-3xl border border-border bg-glass p-7 backdrop-blur-2xl sm:p-9">
          <div className="flex rounded-2xl bg-muted p-1 text-sm font-semibold">
            {(["signin", "signup"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMode(m);
                  setError(null);
                  setNotice(null);
                }}
                className={`flex-1 rounded-xl py-2.5 text-center transition-colors ${
                  mode === m ? "bg-foreground text-ink" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {m === "signin" ? "Sign in" : "Sign up"}
              </button>
            ))}
          </div>

          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            {mode === "signup" && (
              <label className="block">
                <span className="text-sm font-medium text-muted-foreground">Full name</span>
                <input
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Jane Agent"
                  className="mt-1.5 w-full rounded-2xl bg-muted px-4 py-3 text-base outline-none ring-ring transition focus:ring-2"
                />
              </label>
            )}
            <label className="block">
              <span className="text-sm font-medium text-muted-foreground">Email</span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@yourbrokerage.com"
                className="mt-1.5 w-full rounded-2xl bg-muted px-4 py-3 text-base outline-none ring-ring transition focus:ring-2"
              />
            </label>
            <label className="block">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">Password</span>
                {/* "Lost password" button, per Mike (2026-09-24) — only shown
                    on Sign in (a brand-new signup has no password to lose
                    yet). */}
                {mode === "signin" && (
                  <button
                    type="button"
                    onClick={onForgotPassword}
                    disabled={resetBusy}
                    className="text-xs font-medium text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline disabled:opacity-60"
                  >
                    {resetBusy ? "Sending…" : "Forgot password?"}
                  </button>
                )}
              </div>
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
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-2xl bg-primary py-3.5 text-base font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-transform hover:-translate-y-0.5 disabled:opacity-60"
            >
              {busy ? "One moment…" : mode === "signin" ? "Sign in" : "Create my account"}
            </button>
          </form>

          {error && (
            <p className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive-foreground">
              {error}
            </p>
          )}
          {notice && (
            <p className="mt-4 rounded-xl border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
              {notice}
            </p>
          )}

          <p className="mt-5 text-center text-sm text-muted-foreground">$149/month · cancel anytime</p>
        </div>
      </div>
    </div>
  );
}
