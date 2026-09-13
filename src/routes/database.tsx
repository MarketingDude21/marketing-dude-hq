import { createFileRoute } from "@tanstack/react-router";
import { ModuleEmbed } from "@/components/ModuleEmbed";

export const Route = createFileRoute("/database")({
  head: () => ({
    meta: [
      { title: "Build My Database — Your Marketing Dude" },
      {
        name: "description",
        content:
          "Clean and segment your contact database into marketing lists.",
      },
      { property: "og:title", content: "Build My Database — Your Marketing Dude" },
      {
        property: "og:description",
        content:
          "Clean and segment your contact database into marketing lists.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => (
    <ModuleEmbed
      title="Build My Database"
      subtitle="Clean and segment your contacts into marketing lists."
      src="https://frabjous-gingersnap-632ba7.netlify.app"
    />
  ),
});
