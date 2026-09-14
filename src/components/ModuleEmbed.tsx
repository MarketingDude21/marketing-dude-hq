import { AppShell } from "@/components/AppShell";

export function ModuleEmbed({
  title,
  subtitle,
  src,
}: {
  title: string;
  subtitle: string;
  src: string;
}) {
  return (
    <AppShell>
      <div className="flex flex-wrap items-end justify-between gap-3 pt-2">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">
            {title}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <a
          href={src}
          className="rounded-full border border-border bg-glass px-4 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur-xl transition-colors hover:text-foreground"
        >
          Open full page
        </a>
      </div>
      <div className="mt-5 overflow-hidden rounded-3xl border border-border bg-glass backdrop-blur-2xl">
        <iframe
          src={src}
          title={title}
          className="h-[72vh] w-full bg-background"
        />
      </div>
    </AppShell>
  );
}
