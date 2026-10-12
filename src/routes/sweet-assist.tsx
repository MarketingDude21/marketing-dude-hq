import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AmbientBackground, BrandMark } from "@/components/AppShell";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

// Dedicated, unlisted entry point for Sweet Assist's own team/users — added
// 2026-10-10 (renamed from an earlier "suite-assist" draft per Mike's
// correction: "its sweet assit niot suite assst"). Per Mike: "we are
// integrating into sweet assist now and the team needs them to be able to
// create a login that bypasses the pay wall." This is a Sweet-Assist-
// branded partnership sign-up page, separate from the public /login page,
// so a Sweet Assist user never sees (or has to click through) whatever
// paywall /login eventually gets once Stripe is wired up there. It is
// otherwise the exact same Supabase email/password sign-up/sign-in used by
// /login — there's no separate Sweet Assist identity check or token to
// verify (Sweet Assist has no backend able to sign one yet), so this is a
// link Sweet Assist's team can point to directly, not a true single-sign-on
// handoff. If Sweet Assist later gains the ability to pass a signed
// identity assertion, this is the natural place to add that verification
// without touching /login at all.
//
// NOTE (2026-10-12): the uploaded version of this page imports a Sweet
// Assist popsicle logo from "@/assets/sweet-assist-logo.png", but that
// image file never reached this project — only the .tsx text did. Until the
// real logo is attached, the lockup renders a styled "Sweet Assist" text
// mark in its place. Swap this for
//   import sweetAssistLogo from "@/assets/sweet-assist-logo.png";
// and restore the <img> the moment the file lands.
export const Route = createFileRoute("/sweet-assist")({
  head: () => ({
    meta: [
      { title: "Sweet Assist × Your Marketing Dude" },
      {
        name: "description",
        content: "Create your Your Marketing Dude account as part of the Sweet Assist partnership.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: SweetAssistPage,
});

// Temporary text stand-in for the Sweet Assist popsicle logo (see the note
// above the Route definition). Kept in one place so the swap is one edit.
function SweetAssistMark() {
  return (
    <span className="inline-flex h-10 items-center rounded-full border border-border bg-glass px-5 font-display text-lg font-bold tracking-tight text-foreground backdrop-blur-xl">
      Sweet Assist
    </span>
  );
}

function SweetAssistPage() {
  // Defaults to "signup" (not "signin" like /login) — most visitors here
  // are arriving for the first time right after unlocking this inside
  // Sweet Assist. A returning user can still flip to "Sign in" with the
  // same toggle /login has.
  const [mode, setMode] = useState<"signin" | "signup">("signup");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
    // Same email normalization /login uses — see its own comment for why
    // (the 2026-09-30 "duplicate accounts" fix): every identity check in
    // this app compares lower(trim(email)), so this entry point has to
    // store/send that same normalized form too, or a Sweet Assist signup
    // and a direct signup for the same inbox in different casing could
    // create two separate accounts instead of recognizing each other.
    const cleanEmail = email.trim().toLowerCase();
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({
          email: cleanEmail,
          password,
        });
        if (error) throw error;
        navigate({ to: "/" });
      } else {
        const { data, error } = await supabase.auth.signUp({
          email: cleanEmail,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/`,
            data: { full_name: fullName },
          },
        });
        if (error) throw error;
        if (data.user && data.user.identities && data.user.identities.length === 0) {
          setError("An account already exists for this email — sign in instead, or use “Forgot password?” below.");
          return;
        }
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

  const onForgotPassword = async () => {
    setError(null);
    setNotice(null);
    if (!email.trim()) {
      setError("Enter your email above first, then click “Forgot password?”");
      return;
    }
    setResetBusy(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
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
          {/* Partnership lockup — Your Marketing Dude's own mark, a small
              "×", and Sweet Assist's logo, so this page reads as the two
              brands together rather than a generic YMD signup page with
              Sweet Assist mentioned only in text. Currently a text mark
              until the real popsicle logo file is attached. */}
          <div className="flex flex-wrap items-center gap-3">
            <Link to="/" aria-label="Your Marketing Dude home" className="inline-flex">
              <BrandMark size="h-16 w-auto" />
            </Link>
            <span className="text-2xl font-light text-muted-foreground">×</span>
            <SweetAssistMark />
          </div>
          <div className="mt-6 inline-flex items-center gap-2 rounded-full border border-border bg-glass px-4 py-1.5 text-sm font-medium text-muted-foreground backdrop-blur-xl">
            <span className="size-1.5 rounded-full bg-accent" /> A Sweet Assist partnership
          </div>
          <h1 className="mt-6 font-display text-5xl font-bold leading-[0.98] tracking-tight md:text-6xl">
            Your marketing,
            <br />
            <span className="bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">on autopilot.</span>
          </h1>
          <p className="mt-5 max-w-md text-lg text-muted-foreground">
            One quick account and you're in — Voice DNA, your database builder, and monthly marketing content, all
            included through Sweet Assist.
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
            {(["signup", "signin"] as const).map((m) => (
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
                {m === "signin" ? "Sign in" : "Create my account"}
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

          {/* Deliberately no "$149/month" line here, unlike /login — and,
              per Mike (2026-10-10): "there should be no price talks on this
              page either it's already part of their sweet assist
              subscriptions" — not even a softer "no separate payment"
              reassurance like the first draft had. Nothing actually charges
              anyone today on EITHER page (no Stripe wired in yet anywhere in
              this app), so this card just ends after the form — the only
              signal that this is a Sweet Assist page at all is the logo
              lockup and copy above, never anything about cost. Once /login
              does get a real paywall, this page is designed to stay exactly
              as-is: a free Supabase sign-up, untouched by that change. */}
        </div>
      </div>
    </div>
  );
}
