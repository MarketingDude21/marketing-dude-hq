import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@/hooks/useAuth";
import { Database, Sparkles, Calendar, MessagesSquare, Image, UserCircle, Lock } from "lucide-react";
import { getMarketingAccess } from "@/lib/marketing";
import { getAgentVoiceProfile } from "@/lib/voice-dna";
// Real logo asset (2026-09-23) — restores Mike's actual white "Your
// Marketing Dude" clapperboard logo after an earlier pass accidentally
// reverted the header to a placeholder "YM" box (see the note on BrandMark
// below). This import needs the file to actually exist at
// src/assets/logo-white.png in the Lovable project — see the delivery notes
// for how to add it.
import logoWhite from "@/assets/logo-white.png";

// "Home" removed from this list 2026-09-23 per Mike: "once logged in the
// Home page does not need to show in the menu on desktop or in the app" —
// the marketing landing page at "/" still exists and the header logo still
// links there, this just drops it from the nav itself so a signed-in user
// isn't routed back to the public marketing page from the app's own menu.
//
// RESTRUCTURED 2026-11-13 per Mike: "Create Individual Posts" and "Media"
// used to be tabs one level deep inside Monthly Marketing's "What Do You
// Want To Do?" row (see Workspace in marketing.tsx) — confusing enough that
// Mike flagged it directly off a screenshot of someone getting lost in
// there. They're now their own top-level entries (own routes: /posts and
// /media — see those files), same as everything else in this list. Three
// renames came with it, all per Mike: "Monthly Marketing" → "Create My
// Monthly Content" (now that it's just the content-calendar generator, not
// a 4-way picker), the old "Create Individual Posts" tab → "My Marketing
// Dude" at its new /posts route, and "Build My Brand" → "My Brand". Icons
// added alongside the rename since this list now also drives the mobile
// tile grid below, which needs something more visual than just a label.
//
// RENAMED AGAIN 2026-11-15 per Mike, off the nav screenshot: "Call 'Media'
// Upload Photos/Videos. Make My Marketing Dude to 'Individual Content'" —
// the /posts and /media routes themselves keep their internal names
// (AgentScopedPage's title prop in posts.tsx/media.tsx — updated to match),
// only the label shown here changes.
// `lockable` added 2026-11-16 per Mike's onboarding-gate follow-up: "No
// other module, no app can be opened... until the DNA profile is taken...
// They need to be grayed out, the buttons." The page-level OnboardingGate
// (marketing.tsx) already blocks a locked agent's actual content once
// they're on one of these pages; this is what blocks the NAV ITSELF from
// ever being a clickable path there in the first place. My Brand stays
// unlockable since it's where the gate gets satisfied, and Account stays
// unlockable since it's just sign-out/account settings, not a content
// module — same judgment call as leaving Build My Database out of the
// page-level gate.
const NAV = [
  { to: "/database", label: "Build My Database", exact: false, Icon: Database, lockable: true },
  { to: "/voice", label: "My Brand", exact: false, Icon: Sparkles, lockable: false },
  { to: "/marketing", label: "Create My Monthly Content", exact: false, Icon: Calendar, lockable: true },
  { to: "/posts", label: "Individual Content", exact: false, Icon: MessagesSquare, lockable: true },
  { to: "/media", label: "Upload Photos/Videos", exact: false, Icon: Image, lockable: true },
  { to: "/account", label: "Account", exact: false, Icon: UserCircle, lockable: false },
] as const;

const ONBOARDING_LOCK_TITLE = "Finish your Voice DNA profile, headshot, and logo in My Brand first";

// Exported so index.tsx's home-page module cards (which duplicate this same
// nav) can grey themselves out with the exact same signal instead of
// re-deriving it.
export function useOnboardingLock(): boolean {
  const { user } = useAuth();
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    if (!user) {
      setLocked(false);
      return;
    }
    let cancelled = false;
    getMarketingAccess()
      .then(async (access) => {
        if (access.role !== "agent") {
          if (!cancelled) setLocked(false);
          return;
        }
        const profile = await getAgentVoiceProfile({ data: { agentId: access.agentId } });
        const complete =
          Boolean(profile?.voice_summary) && Boolean(profile?.headshot_url) && Boolean(profile?.logo_url);
        if (!cancelled) setLocked(!complete);
      })
      .catch(() => {
        // A failed access/profile check should never strand someone with a
        // dead nav bar — fail open, same spirit as every other
        // transient-error fallback in this app.
        if (!cancelled) setLocked(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  return locked;
}

// FIXED (2026-09-23) — this used to render a generic "YM" placeholder box.
// Mike pointed out "that removed my all white logo need it back" after an
// earlier same-day pass (removing "Home" from NAV) was built from a stale
// copy of this file that predated his actual logo. Now renders the real
// asset — see the import above.
export function BrandMark({ size = "size-9" }: { size?: string }) {
  return <img src={logoWhite} alt="Your Marketing Dude" className={`${size} object-contain`} />;
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
  const onboardingLocked = useOnboardingLock();
  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-background text-foreground">
      <AmbientBackground />
      <header className="relative z-10 mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-5">
        <Link to="/" className="flex items-center gap-2.5">
          <BrandMark />
        </Link>
        <nav className="hidden items-center gap-1 rounded-full border border-border bg-glass px-1 py-1 backdrop-blur-xl md:flex">
          {NAV.map((item) =>
            onboardingLocked && item.lockable ? (
              <span
                key={item.to}
                title={ONBOARDING_LOCK_TITLE}
                aria-disabled="true"
                className="flex cursor-not-allowed items-center gap-1.5 rounded-full px-4 py-1.5 text-sm text-muted-foreground/40"
              >
                <Lock className="size-3" />
                {item.label}
              </span>
            ) : (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: item.exact }}
                activeProps={{
                  className: "rounded-full bg-secondary px-4 py-1.5 text-sm font-medium text-foreground",
                }}
                inactiveProps={{
                  className:
                    "rounded-full px-4 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground",
                }}
              >
                {item.label}
              </Link>
            ),
          )}
        </nav>
        <div className="flex items-center gap-3">
          {user ? (
            <>
              <span className="hidden text-sm text-muted-foreground sm:inline">{user.email}</span>
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
      {/* Added 2026-11-13 per Mike: nothing stood in for the desktop pill-nav
          above on mobile before this — that `nav` is `hidden` below the `md`
          breakpoint with no equivalent, so none of these sections had any
          way to be reached from a phone at all. A home-screen-style grid of
          tiles (one per NAV entry, icon + label) is what he specifically
          asked for when he said each section needed "its own tile to click
          into" on mobile, not a cut-down version of the desktop pill row. */}
      <nav className="relative z-10 mx-auto grid max-w-7xl grid-cols-3 gap-2 px-6 pb-3 sm:grid-cols-4 md:hidden">
        {NAV.map((item) =>
          onboardingLocked && item.lockable ? (
            <span
              key={item.to}
              title={ONBOARDING_LOCK_TITLE}
              aria-disabled="true"
              className="flex cursor-not-allowed flex-col items-center gap-1.5 rounded-2xl border border-border bg-glass px-2 py-3 text-center text-muted-foreground/30"
            >
              <Lock className="size-5" />
              <span className="text-[11px] font-medium leading-tight">{item.label}</span>
            </span>
          ) : (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.exact }}
              activeProps={{
                className:
                  "flex flex-col items-center gap-1.5 rounded-2xl border border-primary/50 bg-secondary px-2 py-3 text-center text-foreground",
              }}
              inactiveProps={{
                className:
                  "flex flex-col items-center gap-1.5 rounded-2xl border border-border bg-glass px-2 py-3 text-center text-muted-foreground transition-colors hover:text-foreground",
              }}
            >
              <item.Icon className="size-5" />
              <span className="text-[11px] font-medium leading-tight">{item.label}</span>
            </Link>
          ),
        )}
      </nav>
      <main className="relative z-10 mx-auto max-w-7xl px-6 pb-20">{children ?? <Outlet />}</main>
    </div>
  );
}
