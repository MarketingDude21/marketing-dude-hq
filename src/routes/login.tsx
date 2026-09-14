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
          setNotice(
            "Check your inbox and click the confirmation link to finish setting up your account.",
          );
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

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-background text-foreground">
      <AmbientBackground />
      <div className="relative z-10 mx-auto flex min-h-screen max-w-6xl flex-col items-center justify-center gap-10 px-6 py-16 lg:flex-row lg:gap-16">
        <div className="max-w-xl flex-1">
          <Link to="/" className="flex items-center gap-3">
            <BrandMark size="size-11" />
            <span className="font-display text-xl font-semibold tracking-tight">
              Your Marketing Dude
            </span>
          </Link>
          <h1 className="mt-8 font-display text-5xl font-bold leading-[0.98] tracking-tight md:text-6xl">
            Your marketing,
            <br />
            <span className="bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
              on autopilot.
            </span>
          </h1>
          <p className="mt-5 max-w-md text-lg text-muted-foreground">
            One brain that writes your posts, builds your list, and learns your
            voice every month.
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
                  mode === m
                    ? "bg-foreground text-ink"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {m === "signin" ? "Sign in" : "Sign up"}
              </button>
            ))}
          </div>

          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            {mode === "signup" && (
              <label className="block">
                <span className="text-sm font-medium text-muted-foreground">
                  Full name
                </span>
                <input
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Jane Agent"
                  className="mt-1.5 w-full rounded-2xl bg-muted px-4 py-3 text-base outline-none ring-ring transition focus:ring-2"
                />
              </label>
            )}
            <label className="block">
              <span className="text-sm font-medium text-muted-foreground">
                Email
              </span>
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
              <span className="text-sm font-medium text-muted-foreground">
                Password
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
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-2xl bg-primary py-3.5 text-base font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-transform hover:-translate-y-0.5 disabled:opacity-60"
            >
              {busy
                ? "One moment…"
                : mode === "signin"
                  ? "Sign in"
                  : "Create my account"}
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

          <p className="mt-5 text-center text-sm text-muted-foreground">
            $149/month · cancel anytime
          </p>
        </div>
      </div>
    </div>
  );
}
