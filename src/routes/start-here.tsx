// New top-level route added 2026-11-25 per Mike's challenge-onboarding
// walkthrough: "Start Here" is a new nav item, rightmost, and everything
// underneath it is a step, not a page of its own — some steps click through
// to their real screen (My Brand, Upload Photos/Videos, Build My Database),
// one (Create your first month's content) just reflects that Create My
// Monthly Content + Individual Content have unlocked. Reuses
// AgentScopedPage the same way every other top-level route in this app
// does (see media.tsx) — this page's whole job is showing real per-step
// status, so unlike AppShell's nav lock it does NOT fail-open/bypass for an
// admin acting as an agent; a dude checking in on someone during a live
// session wants the real answer, not a fake "all done."
import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2, Circle, Lock } from "lucide-react";
import { AgentScopedPage } from "@/routes/marketing";
import { useOnboardingProgressContext } from "@/components/AppShell";
import { getOnboardingProgress, MIN_ONBOARDING_PHOTOS, type OnboardingProgress } from "@/lib/marketing";

export const Route = createFileRoute("/start-here")({
  head: () => ({
    meta: [
      { title: "Start Here — Your Marketing Dude" },
      {
        name: "description",
        content: "The 4 steps that get your account fully set up and your first month's content unlocked.",
      },
      { property: "og:title", content: "Start Here — Your Marketing Dude" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: StartHerePage,
});

function Card({ className = "", children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={`rounded-3xl border border-border bg-glass p-6 backdrop-blur-2xl ${className}`}>{children}</div>
  );
}

function StepRow({
  stepNumber,
  title,
  description,
  done,
  locked,
  lockedNote,
  linkTo,
  linkLabel,
}: {
  stepNumber: number;
  title: string;
  description: string;
  done: boolean;
  locked: boolean;
  lockedNote?: string | undefined;
  linkTo?: string | undefined;
  linkLabel?: string | undefined;
}) {
  return (
    <div
      className={`flex flex-col gap-3 rounded-2xl border px-5 py-4 sm:flex-row sm:items-center sm:justify-between ${
        done
          ? "border-primary/40 bg-primary/5"
          : locked
            ? "border-border bg-background/30 opacity-60"
            : "border-border bg-glass"
      }`}
    >
      <div className="flex items-start gap-3">
        {done ? (
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-primary" />
        ) : locked ? (
          <Lock className="mt-0.5 size-5 shrink-0 text-muted-foreground/50" />
        ) : (
          <Circle className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        )}
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Step {stepNumber}</div>
          <h3 className="font-display text-base font-semibold">{title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          {locked && lockedNote && <p className="mt-1 text-xs text-muted-foreground/70">{lockedNote}</p>}
        </div>
      </div>
      {linkTo && !locked && (
        <Link
          to={linkTo}
          className="shrink-0 rounded-full bg-primary px-5 py-2 text-center text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-transform hover:-translate-y-0.5"
        >
          {done ? "Review" : linkLabel}
        </Link>
      )}
    </div>
  );
}

function StepsChecklist({ agentId }: { agentId: string }) {
  // Added 2026-11-25 (same-day hotfix, see AppShell.tsx's
  // useOnboardingProgressContext) — reuse AppShell's own fetch when it's for
  // this same agentId (true for every ordinary agent looking at their own
  // Start Here page) instead of firing a second identical round trip. Admin
  // viewing a different agent's Start Here still gets a real, independent
  // fetch below — shared.agentId won't match theirs, so this intentionally
  // falls through, keeping the "no fail-open for admin" guarantee this page
  // is built on.
  const shared = useOnboardingProgressContext();
  const [progress, setProgress] = useState<OnboardingProgress | null>(
    shared.agentId === agentId ? shared.progress : null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (shared.agentId === agentId) {
      setProgress(shared.progress);
      setError(null);
      return;
    }
    setProgress(null);
    setError(null);
    getOnboardingProgress({ data: { agentId } })
      .then((p) => {
        if (!cancelled) setProgress(p);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, shared.agentId, shared.progress]);

  if (error) return <Card className="mt-5 text-sm text-destructive">{error}</Card>;
  if (!progress) return <Card className="mt-5 text-sm text-muted-foreground">Loading…</Card>;

  return (
    <div className="mt-5 space-y-5">
      {progress.legacy && (
        <Card className="border-primary/40 bg-primary/5">
          <p className="text-sm font-semibold text-foreground">You're all set.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Your account was already set up before these steps existed, so everything below is unlocked — nothing to do
            here.
          </p>
        </Card>
      )}
      <Card>
        <h2 className="font-display text-lg font-semibold">Get fully set up</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          4 steps, in order. Finish one and the next opens up — once your database is built, your first month's content
          unlocks.
        </p>
        <div className="mt-5 space-y-3">
          <StepRow
            stepNumber={1}
            title="My Brand"
            description="Your Voice DNA interview, headshot, and logo. Come back here any time you need to update them."
            done={progress.step1Brand}
            locked={false}
            linkTo="/voice"
            linkLabel="Start"
          />
          <StepRow
            stepNumber={2}
            title="Upload Photos"
            description={`Upload at least ${MIN_ONBOARDING_PHOTOS} photos — business and personal, anything you're comfortable sharing on social media. (${progress.photoCount} of ${MIN_ONBOARDING_PHOTOS} so far.)`}
            done={progress.step2Photos}
            locked={!progress.step1Brand}
            lockedNote="Finish My Brand first."
            linkTo="/media"
            linkLabel="Upload"
          />
          <StepRow
            stepNumber={3}
            title="Build Your Database"
            description="Upload your contacts so your team can build out your real database for you."
            done={progress.step3Database}
            locked={!progress.step2Photos}
            lockedNote="Upload your photos first."
            linkTo="/database"
            linkLabel="Upload"
          />
          <StepRow
            stepNumber={4}
            title="Create your first month's content"
            description="Once your database is built, your team generates your first month's content, and Create My Monthly Content + Individual Content both unlock."
            done={progress.step3Database}
            locked={!progress.step3Database}
            lockedNote="Finish Step 3 first."
            linkTo={progress.step3Database ? "/marketing" : undefined}
            linkLabel="Open"
          />
        </div>
      </Card>
    </div>
  );
}

function StartHerePage() {
  return (
    <AgentScopedPage
      title="Start Here"
      tagline="The 4 steps that get your account fully set up and your first month's content unlocked."
    >
      {({ agentId }) => <StepsChecklist agentId={agentId} />}
    </AgentScopedPage>
  );
}
