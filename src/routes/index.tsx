import { createFileRoute, Link } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Your Marketing Dude — AI that runs your marketing for you" },
      {
        name: "description",
        content:
          "A real estate marketing OS: mine your sphere, learn your voice, and turn your database into consistent content and follow-up — without adding to your to-do list.",
      },
      { property: "og:title", content: "Your Marketing Dude" },
      {
        property: "og:description",
        content:
          "AI that runs your database and marketing — not AI that gives you more to do.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: HomePage,
});

const MODULES = [
  {
    to: "/database",
    tag: "Sphere mining",
    tagClass: "bg-primary/15 text-primary",
    dotClass: "bg-primary",
    title: "Build My Database",
    desc: "Import your contacts. We find your real sphere, clean it, tag it, and turn it into marketing lists worth mailing.",
    meta: "Who you should actually market to",
    action: "Open",
  },
  {
    to: "/voice",
    tag: "Voice DNA",
    tagClass: "bg-accent/15 text-accent",
    dotClass: "bg-accent",
    title: "My Voice DNA",
    desc: "A short interview teaches the system how you actually talk, so nothing it writes sounds like AI wrote it.",
    meta: "Train it once, use it forever",
    action: "Review",
  },
  {
    to: "/marketing",
    tag: "Content engine",
    tagClass: "bg-secondary text-foreground",
    dotClass: "bg-foreground",
    title: "Monthly Marketing",
    desc: "Your month, written: emails, posts, video scripts and past-client touches — drafted in your voice, ready to approve.",
    meta: "This month is already drafted",
    action: "View",
  },
] as const;

const DOES = [
  ["Mines your sphere", "Finds the people actually worth marketing to"],
  ["Learns your voice", "Writes like you, not like a chatbot"],
  ["Nurtures your database", "Campaigns by relationship, type and timing"],
  ["Finds local stories", "Turns market and neighborhood news into content"],
  ["Feeds your videos", "Topics, hooks, scripts and captions"],
  ["Keeps past clients warm", "Anniversaries, check-ins, referral asks"],
] as const;


function HomePage() {
  return (
    <AppShell>
      <div className="grid grid-cols-12 gap-5 pt-4">
        {/* hero */}
        <section className="col-span-12 lg:col-span-7">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-glass px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur-xl">
            <span className="size-1.5 rounded-full bg-accent" /> Your database ·
            your voice · your marketing, handled
          </div>
          <h1 className="font-display text-5xl font-bold leading-[0.98] tracking-tight md:text-6xl">
            AI that runs your marketing.
            <br />
            <span className="bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
              Not more stuff to do.
            </span>
          </h1>
          <p className="mt-5 max-w-lg text-lg text-muted-foreground">
            Most AI hands you a blank box and a caption. Your Marketing Dude
            already knows your sphere, your market and how you talk — so it
            decides who to reach, writes it in your voice, and hands it to you
            ready to send.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              to="/voice"
              className="rounded-full bg-foreground px-6 py-3 text-sm font-semibold text-ink"
            >
              Teach it my voice
            </Link>
            <Link
              to="/database"
              className="rounded-full border border-input px-6 py-3 text-sm font-semibold text-foreground/80 transition-colors hover:text-foreground"
            >
              Clean up my database
            </Link>
          </div>
          <div className="mt-9 grid max-w-md grid-cols-3 gap-6">
            <div>
              <div className="font-display text-2xl font-bold">1</div>
              <div className="text-xs text-muted-foreground">
                system, not five tools
              </div>
            </div>
            <div>
              <div className="font-display text-2xl font-bold">0</div>
              <div className="text-xs text-muted-foreground">
                blank pages to stare at
              </div>
            </div>
            <div>
              <div className="font-display text-2xl font-bold">30</div>
              <div className="text-xs text-muted-foreground">
                days of marketing, drafted
              </div>
            </div>
          </div>

        </section>

        {/* brain card */}
        <aside className="col-span-12 lg:col-span-5">
          <div className="relative h-full overflow-hidden rounded-3xl border border-border bg-glass p-6 backdrop-blur-2xl">
            <div className="absolute -right-16 -top-16 h-40 w-40 rounded-full bg-accent/20 blur-2xl" />
            <div className="relative">
              <div className="font-display text-base font-semibold">
                It already knows your business
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                One profile behind every module — so nothing starts from
                scratch.
              </p>
              <div className="mt-5 space-y-3">
                {[
                  ["Your sphere", "Who's worth a call, a mailer, an email"],
                  ["Your voice", "How you actually write and speak"],
                  ["Your market", "Local news, listings, neighborhood stories"],
                  ["Your history", "Every edit sharpens the next draft"],
                ].map(([label, detail]) => (
                  <div
                    key={label}
                    className="flex items-center justify-between gap-3 rounded-xl bg-secondary px-4 py-3"
                  >
                    <span className="text-sm text-foreground/70">{label}</span>
                    <span className="text-right text-xs font-medium text-foreground">
                      {detail}
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-5 rounded-xl bg-gradient-to-r from-primary/20 to-accent/20 p-4">
                <div className="text-xs uppercase tracking-widest text-muted-foreground">
                  The idea
                </div>
                <div className="mt-1 font-display text-2xl font-bold">
                  Stop figuring out marketing
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Your relationships and your listings become consistent
                  marketing — without you managing it.
                </div>
              </div>

            </div>
          </div>
        </aside>

        {/* what it does */}
        <section className="col-span-12 mt-4">
          <div className="mb-4 flex items-end justify-between">
            <h2 className="font-display text-xl font-semibold">
              What it handles for you
            </h2>
            <span className="hidden text-sm text-muted-foreground sm:inline">
              Database → voice → content → follow-up
            </span>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {DOES.map(([label, detail]) => (
              <div
                key={label}
                className="rounded-2xl border border-border bg-glass p-5 backdrop-blur-xl"
              >
                <div className="font-display text-sm font-semibold">
                  {label}
                </div>
                <p className="mt-1.5 text-sm text-muted-foreground">{detail}</p>
              </div>
            ))}
          </div>
        </section>

        {/* modules */}
        <section className="col-span-12 mt-4">
          <div className="mb-4 flex items-end justify-between">
            <h2 className="font-display text-xl font-semibold">
              Your workspace
            </h2>
            <span className="text-sm text-muted-foreground">
              Pick up where you left off
            </span>
          </div>

          <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
            {MODULES.map((m) => (
              <Link
                key={m.to}
                to={m.to}
                className="group rounded-3xl border border-border bg-glass p-6 backdrop-blur-2xl transition hover:bg-secondary"
              >
                <div
                  className={`mb-4 inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${m.tagClass}`}
                >
                  <span className={`size-1.5 rounded-full ${m.dotClass}`} />{" "}
                  {m.tag}
                </div>
                <h3 className="font-display text-lg font-semibold">
                  {m.title}
                </h3>
                <p className="mt-2 text-sm text-muted-foreground">{m.desc}</p>
                <div className="mt-5 flex items-center justify-between">
                  <span className="text-xs text-muted-foreground/70">
                    {m.meta}
                  </span>
                  <span className="text-sm font-semibold text-foreground group-hover:text-accent">
                    {m.action} →
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
