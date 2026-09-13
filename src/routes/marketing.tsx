import { createFileRoute } from "@tanstack/react-router";
import { ModuleEmbed } from "@/components/ModuleEmbed";

export const Route = createFileRoute("/marketing")({
  head: () => ({
    meta: [
      { title: "Monthly Marketing — Your Marketing Dude" },
      {
        name: "description",
        content:
          "Monthly social posts, emails, and video scripts generated in your voice.",
      },
      { property: "og:title", content: "Monthly Marketing — Your Marketing Dude" },
      {
        property: "og:description",
        content:
          "Monthly social posts, emails, and video scripts generated in your voice.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => (
    <ModuleEmbed
      title="Monthly Marketing"
      subtitle="Posts, emails, and video scripts in your voice — every month."
      src="https://lovely-cactus-733e4c.netlify.app"
    />
  ),
});
