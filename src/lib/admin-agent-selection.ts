// Shared across every admin "Choose an agent" picker in the Monthly
// Marketing side of the app (marketing.tsx's 2 pickers — the inline one in
// MarketingPage and the exported AgentScopedPage used by posts.tsx,
// media.tsx, start-here.tsx — plus voice.tsx's own separate picker).
//
// Added 2026-11-26 per Mike: "whenever you go into an agent's profile, and
// try a different tab it automatically takes to back to the choose agent
// screen... Once you enter into an agent's profile you should remain in
// that profile until you click change agent in upper right hand. Keep
// change agent at all times so we can move in and out of agents accounts."
//
// Every one of those pages is its own top-level route, so each one's plain
// `useState` for "which agent is selected" starts fresh — null — on every
// single navigation, which is exactly the bug Mike's describing. This app
// has no persistent top-level layout wrapping the router's Outlet (AppShell
// itself is called fresh inside each page component), so there's no React
// context that would survive a route change either. sessionStorage is the
// one thing that does: it survives client-side navigation AND a full page
// refresh, for this browser tab only, and clears itself when the tab
// closes — exactly the "stay in this account until I explicitly change it"
// behavior asked for, with no backend or schema changes needed.
//
// This only ever stores WHO is selected (id/name/email), never any of
// their actual data — every page still re-fetches that agent's real data
// itself the same way it always did. If the stored id turns out to be
// stale (the agent was deleted since), a page just fails to find them in
// its own fresh agent list and falls back to clearing this and showing the
// picker again — see callers.
const STORAGE_KEY = "ymd_admin_selected_agent";

export type StoredAdminAgent = { id: string; name: string; email: string | null };

export function getStoredAdminAgent(): StoredAdminAgent | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredAdminAgent> | null;
    if (parsed && typeof parsed.id === "string" && typeof parsed.name === "string") {
      return { id: parsed.id, name: parsed.name, email: parsed.email ?? null };
    }
  } catch {
    // Corrupt or blocked storage (private browsing, etc.) — just behave as
    // if nothing had been stored.
  }
  return null;
}

export function setStoredAdminAgent(agent: StoredAdminAgent | null): void {
  if (typeof window === "undefined") return;
  try {
    if (agent) {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(agent));
    } else {
      window.sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Storage blocked — selection just won't persist across navigation this
    // time, same experience as before this feature existed.
  }
}
