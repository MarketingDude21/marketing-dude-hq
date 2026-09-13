import { createFileRoute, Link } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { backendConfigured } from "@/lib/backend";

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

function AccountPage() {
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
            {[
              ["Full name", "Your name"],
              ["Brokerage", "Your brokerage"],
              ["Market", "City, State"],
            ].map(([label, placeholder]) => (
              <label key={label} className="block">
                <span className="text-sm font-medium text-muted-foreground">
                  {label}
                </span>
                <input
                  placeholder={placeholder}
                  className="mt-1.5 w-full rounded-2xl bg-muted px-4 py-3 text-sm outline-none ring-ring transition focus:ring-2"
                />
              </label>
            ))}
            <button className="rounded-2xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-transform hover:-translate-y-0.5">
              Save profile
            </button>
            {!backendConfigured && (
              <p className="text-xs text-muted-foreground">
                Saving turns on once your database is connected in Project
                Settings → Connectors.
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-5">
          <div className="rounded-3xl border border-border bg-glass p-6 backdrop-blur-2xl">
            <h2 className="font-display text-lg font-semibold">Subscription</h2>
            <div className="mt-4 flex items-center justify-between rounded-xl bg-secondary px-4 py-3">
              <span className="text-sm text-foreground/70">Pro plan</span>
              <span className="font-display text-sm font-bold">$97/mo</span>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Billing management arrives with payments setup.
            </p>
          </div>
          <div className="rounded-3xl border border-border bg-glass p-6 backdrop-blur-2xl">
            <h2 className="font-display text-lg font-semibold">Session</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Signed-in details appear here once accounts are connected.
            </p>
            <Link
              to="/login"
              className="mt-4 inline-block rounded-2xl border border-border bg-glass px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-secondary"
            >
              Go to sign in
            </Link>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
