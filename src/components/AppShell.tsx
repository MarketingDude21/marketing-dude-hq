import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useAuth } from "@/hooks/useAuth";
import logoAsset from "@/assets/dude-logo.png.asset.json";

const NAV = [
  { to: "/", label: "Home", exact: true },
  { to: "/database", label: "Build My Database", exact: false },
  { to: "/voice", label: "My Voice DNA", exact: false },
  { to: "/marketing", label: "Monthly Marketing", exact: false },
  { to: "/account", label: "Account", exact: false },
] as const;

export function BrandMark({ size = "h-14 w-auto" }: { size?: string }) {
  return (
    <img
      src={logoAsset.url}
      alt="Your Marketing Dude"
      className={`${size} object-contain`}
    />
  );
}

export function AmbientBackground() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -top-40 -left-24 h-[520px] w-[520px] rounded-full bg-primary/25 blur-3xl [animation:floaty_9s_ease-in-out_infinite]" />
      <div className="absolute top-1/3 -right-32 h-[460px] w-[460px] rounded-full bg-accent/20 blur-3xl [animation:floaty2_11s_ease-in-out_infinite]" />
      <div className="absolute left-1/4 top-0 h-full w-40 -rotate-12 bg-gradient-to-b from-accent/8 to-transparent" />
      <div className="absolute right-1/4 top-0 h-full w-56 rotate-12 bg-gradient-to-b from-primary/10 to-transparent" />
    </div>
  );
}

export function AppShell({ children }: { children?: ReactNode }) {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-background text-foreground">
      <AmbientBackground />
      <header className="relative z-10 mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-5">
        <Link to="/" aria-label="Your Marketing Dude home" className="shrink-0">
          <BrandMark />
        </Link>
        <nav className="hidden items-center gap-1 rounded-full border border-border bg-glass px-1 py-1 backdrop-blur-xl md:flex">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.exact }}
              activeProps={{
                className:
                  "rounded-full bg-secondary px-4 py-1.5 text-sm font-medium text-foreground",
              }}
              inactiveProps={{
                className:
                  "rounded-full px-4 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground",
              }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-3">
          {user ? (
            <>
              <span className="hidden text-sm text-muted-foreground sm:inline">
                {user.email}
              </span>
              <button
                onClick={async () => {
                  await signOut();
                  navigate({ to: "/login" });
                }}
                className="rounded-full border border-border bg-glass px-5 py-2 text-sm font-semibold transition-colors hover:bg-secondary"
              >
                Sign out
              </button>
            </>
          ) : (
            <button
              onClick={() => navigate({ to: "/login" })}
              className="rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-transform hover:-translate-y-0.5"
            >
              Sign in
            </button>
          )}
        </div>
      </header>
      <main className="relative z-10 mx-auto max-w-7xl px-6 pb-20">
        {children ?? <Outlet />}
      </main>
    </div>
  );
}
