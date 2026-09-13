import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

export const Route = createFileRoute("/account")({
  head: () => ({
    meta: [
      { title: "Account — Your Marketing Dude" },
      {
        name: "description",
        content:
          "Manage your profile, photos, and subscription for Your Marketing Dude.",
      },
      { property: "og:title", content: "Account — Your Marketing Dude" },
      {
        property: "og:description",
        content: "Manage your profile, photos, and subscription.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AccountPage,
});

type Profile = {
  full_name: string;
  brokerage: string;
  market_area: string;
  phone: string;
  website: string;
};

const EMPTY: Profile = {
  full_name: "",
  brokerage: "",
  market_area: "",
  phone: "",
  website: "",
};

const FIELDS: Array<[keyof Profile, string, string]> = [
  ["full_name", "Full name", "Your name"],
  ["brokerage", "Brokerage", "Your brokerage"],
  ["market_area", "Market", "City, State"],
  ["phone", "Phone", "(555) 555-5555"],
  ["website", "Website", "https://"],
];

function AccountPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [profile, setProfile] = useState<Profile>(EMPTY);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [plan, setPlan] = useState<string>("trial");

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    supabase
      .from("agents")
      .select(
        "full_name, brokerage, market_area, phone, website, subscription_status",
      )
      .eq("id", user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled || !data) return;
        setProfile({
          full_name: data.full_name ?? "",
          brokerage: data.brokerage ?? "",
          market_area: data.market_area ?? "",
          phone: data.phone ?? "",
          website: data.website ?? "",
        });
        setPlan(data.subscription_status ?? "trial");
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const save = async () => {
    if (!user) return;
    setSaving(true);
    setStatus(null);
    const { error } = await supabase
      .from("agents")
      .upsert({ id: user.id, email: user.email, ...profile });
    setSaving(false);
    setStatus(error ? error.message : "Profile saved.");
  };

  if (!loading && !user) {
    return (
      <AppShell>
        <div className="mt-16 rounded-3xl border border-border bg-glass p-8 text-center backdrop-blur-2xl">
          <h1 className="font-display text-2xl font-bold">
            Sign in to manage your account
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Your profile powers every tool in the platform.
          </p>
          <Link
            to="/login"
            className="mt-6 inline-block rounded-2xl bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30"
          >
            Go to sign in
          </Link>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <h1 className="pt-2 font-display text-2xl font-bold tracking-tight">
        Account
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Your profile feeds every tool — keep it fresh.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div className="rounded-3xl border border-border bg-glass p-6 backdrop-blur-2xl">
          <h2 className="font-display text-lg font-semibold">Profile</h2>
          <div className="mt-5 space-y-4">
            {FIELDS.map(([key, label, placeholder]) => (
              <label key={key} className="block">
                <span className="text-sm font-medium text-muted-foreground">
                  {label}
                </span>
                <input
                  value={profile[key]}
                  onChange={(e) =>
                    setProfile((p) => ({ ...p, [key]: e.target.value }))
                  }
                  placeholder={placeholder}
                  className="mt-1.5 w-full rounded-2xl bg-muted px-4 py-3 text-sm outline-none ring-ring transition focus:ring-2"
                />
              </label>
            ))}
            <button
              onClick={save}
              disabled={saving}
              className="rounded-2xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-transform hover:-translate-y-0.5 disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save profile"}
            </button>
            {status && (
              <p className="text-xs text-muted-foreground">{status}</p>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-5">
          <div className="rounded-3xl border border-border bg-glass p-6 backdrop-blur-2xl">
            <h2 className="font-display text-lg font-semibold">Subscription</h2>
            <div className="mt-4 flex items-center justify-between rounded-xl bg-secondary px-4 py-3">
              <span className="text-sm capitalize text-foreground/70">
                {plan === "active" ? "Pro plan" : `${plan} plan`}
              </span>
              <span className="font-display text-sm font-bold">$97/mo</span>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Billing management arrives with payments setup.
            </p>
          </div>
          <div className="rounded-3xl border border-border bg-glass p-6 backdrop-blur-2xl">
            <h2 className="font-display text-lg font-semibold">Session</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Signed in as {user?.email ?? "…"}
            </p>
            <button
              onClick={async () => {
                await supabase.auth.signOut();
                navigate({ to: "/login" });
              }}
              className="mt-4 inline-block rounded-2xl border border-border bg-glass px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-secondary"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
