import { createFileRoute } from "@tanstack/react-router";
import { ModuleEmbed } from "@/components/ModuleEmbed";

export const Route = createFileRoute("/voice")({
  head: () => ({
    meta: [
      { title: "My Voice DNA — Your Marketing Dude" },
      {
        name: "description",
        content:
          "A 15-question interview that captures your personality and communication style.",
      },
      { property: "og:title", content: "My Voice DNA — Your Marketing Dude" },
      {
        property: "og:description",
        content:
          "A 15-question interview that captures your personality and communication style.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => (
    <ModuleEmbed
      title="My Voice DNA"
      subtitle="15 questions that capture how you write and speak."
      src="https://bejewelled-dusk-94cf27.netlify.app"
    />
  ),
});
