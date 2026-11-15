// New top-level route added 2026-11-13 per Mike: "Create Individual Posts
// Needs To be it's own section, not within monthly marketing... even on
// mobile it will have its own tile to click into." This used to be one tab
// inside /marketing's "What Do You Want To Do?" row; it's now its own page,
// reusing PostsTab and the AgentScopedPage access/agent-picker flow that
// /marketing already exports — see the comment on AgentScopedPage in
// marketing.tsx for why this isn't just reusing MarketingPage wholesale.
import { createFileRoute } from "@tanstack/react-router";
import { AgentScopedPage, PostsTab } from "@/routes/marketing";

export const Route = createFileRoute("/posts")({
  head: () => ({
    meta: [
      { title: "Individual Content — Your Marketing Dude" },
      {
        name: "description",
        content: "Draft and save one social post, email, video script, or photo scan at a time, in your voice.",
      },
      { property: "og:title", content: "Individual Content — Your Marketing Dude" },
      {
        property: "og:description",
        content: "Draft and save one social post, email, video script, or photo scan at a time, in your voice.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: PostsPage,
});

// Renamed 2026-11-15 per Mike: "Make My Marketing Dude to 'Individual
// Content'." The nav label (AppShell.tsx) and this page's own title move
// together — "My Marketing Dude" still shows up inside the page as the
// chat hub's voice/brand name (ChatHub's "Talk to your Marketing Dude…"),
// that's unchanged, just not the page's own heading anymore.
function PostsPage() {
  return (
    <AgentScopedPage
      title="Individual Content"
      tagline="Draft and save one post, email, or script at a time, in your voice."
    >
      {({ agentId, isAdmin }) => (
        <div className="mt-5">
          <PostsTab agentId={agentId} isAdmin={isAdmin} />
        </div>
      )}
    </AgentScopedPage>
  );
}
