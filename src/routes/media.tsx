// New top-level route added 2026-11-13 per Mike: "Media Needs to be its own
// items as well so it's very easy to see where they can load pictures into."
// This used to be one tab inside /marketing's "What Do You Want To Do?" row;
// it's now its own page, reusing MediaTab and the AgentScopedPage
// access/agent-picker flow that /marketing already exports — see the
// comment on AgentScopedPage in marketing.tsx for why this isn't just
// reusing MarketingPage wholesale.
import { createFileRoute } from "@tanstack/react-router";
import { AgentScopedPage, MediaTab } from "@/routes/marketing";

export const Route = createFileRoute("/media")({
  head: () => ({
    meta: [
      { title: "Upload Photos/Videos — Your Marketing Dude" },
      {
        name: "description",
        content: "Your photo and video library — upload, add notes, and download what's ready to use.",
      },
      { property: "og:title", content: "Upload Photos/Videos — Your Marketing Dude" },
      {
        property: "og:description",
        content: "Your photo and video library — upload, add notes, and download what's ready to use.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: MediaPage,
});

// Renamed 2026-11-15 per Mike: "Call 'Media' Upload Photos/Videos." Tagline
// also dropped "tag" the same round the tag chips came out of the grid
// itself (see MediaTab in marketing.tsx) in favor of free-text notes.
function MediaPage() {
  return (
    <AgentScopedPage
      title="Upload Photos/Videos"
      tagline="Your photo and video library — upload, add notes, and download what's ready to use."
    >
      {({ agentId, isAdmin }) => (
        <div className="mt-5">
          <MediaTab agentId={agentId} isAdmin={isAdmin} />
        </div>
      )}
    </AgentScopedPage>
  );
}
