import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { supabase } from "@/integrations/supabase/client";
import {
  getMarketingAccess,
  listMarketingAgents,
  listMarketingPosts,
  listMarketingMonths,
  updateMarketingPost,
  submitMarketingFeedback,
  setPostMedia,
  rewritePostContent,
  listMarketingMedia,
  createMediaUploadUrl,
  finalizeMediaUpload,
  setMediaTags,
  markMediaUsed,
  deleteMarketingMedia,
  listAgentDriveMedia,
  setAgentDriveFolder,
  generateMarketingContent,
  listCalendarMonths,
  addCalendarMonth,
  removeCalendarMonth,
  listCalendarItems,
  addCalendarItem,
  removeCalendarItem,
  readContentCalendar,
  generateMonthlyBatch,
  scanAgentDrivePhotos,
  addPhotoPostsToBatch,
  approveBatch,
  approveAllPending,
  sendContentToAgent,
  type MarketingAccess,
  type MediaRow,
  type DriveFile,
  type CalendarMonth,
  type CalendarItem,
  type CalendarDoc,
  type PhotoScanSuggestion,
  type PostMetadata,
} from "@/lib/marketing";

export const Route = createFileRoute("/marketing")({
  head: () => ({
    meta: [
      { title: "Monthly Marketing — Your Marketing Dude" },
      {
        name: "description",
        content: "Monthly social posts, emails, and video scripts generated in your voice.",
      },
      { property: "og:title", content: "Monthly Marketing — Your Marketing Dude" },
      {
        property: "og:description",
        content: "Monthly social posts, emails, and video scripts generated in your voice.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: MarketingPage,
});

type AgentOption = { id: string; name: string };

type Post = {
  id: string;
  content: string;
  content_type: string;
  title: string | null;
  platform: string | null;
  status: string;
  month: string | null;
  scheduled_for: string | null;
  created_at: string;
  metadata: PostMetadata | null;
};

// Content is grouped and ordered by kind everywhere it's shown in a batch
// (the Posts tab and the calendar review screen) so the four different
// pieces of content Mike's team produces each month never get mixed
// together in one visually identical pile — added per Mike's request
// (2026-09-18) for a clearer, more obviously-categorized layout with icons.
// Order is fixed: posts, then Canva templates, then emails, then video
// scripts.
type ContentCategory = "post" | "canva" | "email" | "video";

const CATEGORY_ORDER: ContentCategory[] = ["post", "canva", "email", "video"];

const CATEGORY_META: Record<ContentCategory, { label: string; icon: string; accent: string }> = {
  post: {
    label: "Posts",
    icon: "📝",
    accent: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  canva: {
    label: "Canva Templates",
    icon: "🎨",
    accent: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  },
  email: {
    label: "Emails",
    icon: "✉️",
    accent: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  video: {
    label: "Video Scripts",
    icon: "🎬",
    accent: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
};

function categorizePost(post: Post): ContentCategory {
  if (post.content_type === "email") return "email";
  if (post.content_type === "video") return "video";
  return post.metadata?.canva_link ? "canva" : "post";
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-3xl border border-border bg-glass p-6 backdrop-blur-2xl ${className}`}>{children}</div>
  );
}

function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  title?: string | undefined;
}) {
  const styles =
    variant === "primary"
      ? "bg-primary text-primary-foreground shadow-lg shadow-primary/30 hover:-translate-y-0.5"
      : variant === "danger"
        ? "border border-destructive/40 text-destructive hover:bg-destructive/10"
        : "border border-border bg-glass hover:bg-secondary";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-full px-5 py-2 text-sm font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-50 ${styles}`}
    >
      {children}
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles =
    status === "approved"
      ? "bg-[color-mix(in_oklab,var(--color-primary)_14%,transparent)] text-primary"
      : status === "flagged"
        ? "bg-destructive/10 text-destructive"
        : "bg-muted text-muted-foreground";
  const label = status === "approved" ? "Approved" : status === "flagged" ? "Flagged" : "Pending review";
  return <span className={`rounded-full px-3 py-1 text-xs font-semibold ${styles}`}>{label}</span>;
}

// Minimal ambient typing for the Web Speech API — it isn't in lib.dom.d.ts.
// Same approach voice.tsx's mic already uses; duplicated here (not imported)
// since it's a small, self-contained bit and the two routes don't currently
// share a components module.
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: any) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: any) => void) | null;
  start: () => void;
  abort: () => void;
};

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

function isIOSDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

// A small dictation button for any textarea/input in this page — added per
// Mike's request (2026-09-17, "there is no microphone options here at all").
// Same underlying browser Speech Recognition mechanism Voice DNA's own mic
// already uses (no server cost, no new secret), generalized here to work
// against any value/onChange pair instead of one indexed answers array. Tap
// to start, tap again to stop; speech is appended to whatever was already
// typed, so it can be mixed with typing.
function MicButton({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [supported] = useState<boolean>(() => Boolean(getSpeechRecognitionCtor()));
  const [listening, setListening] = useState(false);
  const [label, setLabel] = useState<string | null>(null);
  const recogRef = useRef<SpeechRecognitionLike | null>(null);
  const userStoppedRef = useRef(false);
  const deniedRef = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    return () => {
      const r = recogRef.current;
      if (r) {
        r.onstart = null;
        r.onresult = null;
        r.onend = null;
        r.onerror = null;
        try {
          r.abort();
        } catch {
          // ignore
        }
        recogRef.current = null;
      }
    };
  }, []);

  function resetUI(msg?: string) {
    setListening(false);
    setLabel(msg ?? null);
  }

  function attemptRestart(baseText: string, attemptNum: number) {
    if (userStoppedRef.current || deniedRef.current) return;
    try {
      startInstance(baseText);
    } catch {
      if (attemptNum < 5) {
        setTimeout(() => attemptRestart(baseText, attemptNum + 1), 150 * (attemptNum + 1));
      } else {
        resetUI("Mic paused — tap to resume, what you said so far is kept.");
      }
    }
  }

  function startInstance(baseTextIn: string) {
    let baseText = baseTextIn;
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    const recog = new Ctor();
    recog.continuous = !isIOSDevice();
    recog.interimResults = true;
    recog.lang = "en-US";
    let finalTranscript = "";

    recog.onstart = () => {
      setListening(true);
      deniedRef.current = false;
      finalTranscript = "";
      setLabel("Listening… tap to stop");
    };
    recog.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalTranscript += e.results[i][0].transcript + " ";
        else interim += e.results[i][0].transcript;
      }
      onChange(baseText + finalTranscript + interim);
    };
    recog.onend = () => {
      setListening(false);
      baseText = baseText + finalTranscript;
      if (!userStoppedRef.current && !deniedRef.current) {
        attemptRestart(baseText, 0);
        return;
      }
      resetUI();
    };
    recog.onerror = (e: any) => {
      setListening(false);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        deniedRef.current = true;
        userStoppedRef.current = true;
        resetUI("Mic access blocked — allow microphone access, or just type.");
        return;
      }
      if (e.error === "no-speech" || e.error === "aborted") return;
      if (e.error === "network") {
        resetUI("Network hiccup — tap to try again.");
        userStoppedRef.current = true;
        return;
      }
      resetUI("Error — please type instead.");
      userStoppedRef.current = true;
    };

    recogRef.current = recog;
    recog.start();
  }

  function toggle() {
    if (!supported) return;
    if (listening) {
      userStoppedRef.current = true;
      const r = recogRef.current;
      if (r) {
        try {
          r.abort();
        } catch {
          // ignore
        }
      }
      resetUI();
      return;
    }
    userStoppedRef.current = false;
    deniedRef.current = false;
    startInstance(valueRef.current);
  }

  if (!supported) return null;

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={toggle}
        title={listening ? "Tap to stop dictating" : "Tap to dictate"}
        className={`inline-flex h-7 w-7 items-center justify-center rounded-full border text-xs transition-colors ${
          listening
            ? "border-primary bg-primary text-primary-foreground animate-pulse"
            : "border-border text-muted-foreground hover:border-primary/50"
        }`}
      >
        🎤
      </button>
      {label && <span className="text-[11px] text-muted-foreground">{label}</span>}
    </span>
  );
}

function MarketingPage() {
  const [access, setAccess] = useState<MarketingAccess | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [selected, setSelected] = useState<AgentOption | null>(null);
  const [showCalendarAdmin, setShowCalendarAdmin] = useState(false);

  useEffect(() => {
    getMarketingAccess()
      .then(async (a) => {
        setAccess(a);
        if (a.role === "admin") {
          const list = await listMarketingAgents();
          setAgents(list.map((ag) => ({ id: ag.id, name: ag.full_name ?? ag.email ?? "Unnamed agent" })));
        } else if (a.role === "agent") {
          setSelected({ id: a.agentId, name: a.agentName });
        }
      })
      .catch((e) => setAccessError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (accessError) {
    return (
      <AppShell>
        <PageHeader />
        <Card className="mt-5">
          <p className="text-sm text-destructive">{accessError}</p>
        </Card>
      </AppShell>
    );
  }

  if (!access) {
    return (
      <AppShell>
        <PageHeader />
        <Card className="mt-5">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </Card>
      </AppShell>
    );
  }

  if (access.role === "none") {
    return (
      <AppShell>
        <PageHeader />
        <Card className="mt-5">
          <p className="text-sm text-muted-foreground">
            Your account isn't set up in Monthly Marketing yet. Ask your team to add you as an agent.
          </p>
        </Card>
      </AppShell>
    );
  }

  if (access.role === "admin" && showCalendarAdmin) {
    return (
      <AppShell>
        <PageHeader />
        <ManageCalendarScreen onBack={() => setShowCalendarAdmin(false)} />
      </AppShell>
    );
  }

  if (access.role === "admin" && !selected) {
    return (
      <AppShell>
        <PageHeader />
        <Card className="mt-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-display text-lg font-semibold">Content Calendar</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                One calendar, shared by every agent — build out each month's posts, emails, and video briefs once here,
                and every agent generates their own personalized version of it from their own login.
              </p>
            </div>
            <Button onClick={() => setShowCalendarAdmin(true)}>Manage Content Calendar</Button>
          </div>
        </Card>
        <Card className="mt-5">
          <h2 className="font-display text-lg font-semibold">Choose an agent</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick who you're working on behalf of. Every action you take here is logged against their account, not yours.
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {agents.map((a) => (
              <button
                key={a.id}
                onClick={() => setSelected(a)}
                className="rounded-2xl border border-border bg-glass px-4 py-3 text-left text-sm font-medium transition-colors hover:bg-secondary"
              >
                {a.name}
              </button>
            ))}
            {agents.length === 0 && <p className="text-sm text-muted-foreground">No agents yet.</p>}
          </div>
        </Card>
      </AppShell>
    );
  }

  if (!selected) return null;

  return (
    <AppShell>
      <PageHeader
        agentName={selected.name}
        onChangeAgent={access.role === "admin" ? () => setSelected(null) : undefined}
      />
      <Workspace agentId={selected.id} isAdmin={access.role === "admin"} />
    </AppShell>
  );
}

function PageHeader({
  agentName,
  onChangeAgent,
}: {
  agentName?: string | undefined;
  onChangeAgent?: (() => void) | undefined;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 pt-2">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Monthly Marketing</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {agentName ? `Viewing as: ${agentName}` : "Posts, emails, and video scripts in your voice — every month."}
        </p>
      </div>
      {onChangeAgent && (
        <Button variant="secondary" onClick={onChangeAgent}>
          Change agent
        </Button>
      )}
    </div>
  );
}

function Workspace({ agentId, isAdmin }: { agentId: string; isAdmin: boolean }) {
  const [tab, setTab] = useState<"posts" | "calendar" | "media" | "drive">("posts");
  return (
    <div className="mt-5">
      <div className="flex flex-wrap gap-1 rounded-full border border-border bg-glass p-1 backdrop-blur-xl w-fit">
        {(["posts", "calendar", "media", "drive"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === t ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t === "posts"
              ? "Posts"
              : t === "calendar"
                ? "Create My Monthly Content"
                : t === "media"
                  ? "Media"
                  : "Google Drive"}
          </button>
        ))}
      </div>
      <div className="mt-5">
        {tab === "posts" && <PostsTab agentId={agentId} isAdmin={isAdmin} />}
        {tab === "calendar" && <ContentCalendarTab agentId={agentId} isAdmin={isAdmin} />}
        {tab === "media" && <MediaTab agentId={agentId} />}
        {tab === "drive" && <DriveTab agentId={agentId} isAdmin={isAdmin} />}
      </div>
    </div>
  );
}

// Redesigned 2026-09-17 per Mike's direct feedback on this tab specifically:
// a grid layout so photo + full copy are visible without clicking anything
// (same always-open-card pattern BatchSection already uses for the calendar
// review screen, applied here too), an "Approve all" for whatever's
// currently in view, a "Send to Agent" button (admin-only — reuses the same
// GHL notification the calendar review screen already has, scoped to the
// selected month since the notification needs one), and the Drive photo-scan
// panel surfaced here too (it already worked without a calendar batch —
// `addPhotoPostsToBatch`'s batchId was always optional — it just wasn't
// exposed outside the calendar flow before).
function PostsTab({ agentId, isAdmin }: { agentId: string; isAdmin: boolean }) {
  const [months, setMonths] = useState<string[]>([]);
  const [month, setMonth] = useState<string>("");
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approvingAll, setApprovingAll] = useState(false);
  const [approveNote, setApproveNote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [driveFolderId, setDriveFolderId] = useState<string | null>(null);
  const [driveError, setDriveError] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);

  function reload() {
    setPosts(null);
    const payload = month ? { agentId, month } : { agentId };
    listMarketingPosts({ data: payload })
      .then((p) => setPosts(p as Post[]))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }

  useEffect(() => {
    setMonths([]);
    setMonth("");
    listMarketingMonths({ data: { agentId } })
      .then((m) => setMonths(m))
      .catch(() => {});
    listAgentDriveMedia({ data: { agentId } })
      .then((d) => {
        setDriveFolderId(d.folderId);
        setDriveError(null);
      })
      .catch((e) => {
        setDriveFolderId(null);
        setDriveError(e instanceof Error ? e.message : String(e));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, month]);

  // Explicit confirmation text after this finishes — added per Mike's
  // report (2026-09-18) that clicking Approve all didn't seem to do
  // anything until he navigated away and back. The status badges on each
  // card do update immediately once reload() resolves, but there was no
  // unmistakable, un-missable confirmation that the click itself worked, so
  // this adds one plainly on the screen without needing to go find it.
  async function approveAll() {
    setApprovingAll(true);
    setActionError(null);
    setApproveNote(null);
    try {
      const res = await approveAllPending({ data: month ? { agentId, month } : { agentId } });
      setApproveNote(
        res.updated > 0
          ? `Approved ${res.updated} post${res.updated === 1 ? "" : "s"}.`
          : "Nothing left to approve — everything here is already approved.",
      );
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setApprovingAll(false);
    }
  }

  async function sendToAgent() {
    if (!month) return;
    setSending(true);
    setActionError(null);
    try {
      await sendContentToAgent({ data: { agentId, month } });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  if (error) {
    return (
      <Card>
        <p className="text-sm text-destructive">{error}</p>
      </Card>
    );
  }

  const pendingCount = (posts ?? []).filter((p) => p.status !== "approved").length;

  return (
    <div className="space-y-4">
      <CreateContentForm agentId={agentId} onCreated={reload} />

      <div className="flex flex-wrap items-center gap-2">
        {months.length > 0 && (
          <>
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Month</span>
            <select
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="rounded-xl border border-border bg-glass px-3 py-1.5 text-sm outline-none"
            >
              <option value="">All months</option>
              {months.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </>
        )}
        {posts !== null && posts.length > 0 && (
          <Button onClick={approveAll} disabled={approvingAll || pendingCount === 0}>
            {approvingAll ? "Approving…" : `Approve all${pendingCount ? ` (${pendingCount})` : ""}`}
          </Button>
        )}
        {isAdmin && (
          <Button
            variant="secondary"
            onClick={sendToAgent}
            disabled={sending || !month}
            title={month ? undefined : "Pick a specific month above first"}
          >
            {sending ? "Sending…" : "Send to Agent"}
          </Button>
        )}
        {driveFolderId ? (
          <PhotoScanPanel
            agentId={agentId}
            folderId={driveFolderId}
            month={month || new Date().toISOString().slice(0, 7)}
            batchId={null}
            open={scanOpen}
            onOpen={() => setScanOpen(true)}
            onClose={() => setScanOpen(false)}
            onAdded={reload}
          />
        ) : (
          <span className="text-xs text-muted-foreground">
            {driveError
              ? driveError
              : "No Google Drive folder set for this agent yet — set one on the Google Drive tab to scan for photo posts."}
          </span>
        )}
      </div>

      {approveNote && <p className="text-xs text-muted-foreground">{approveNote}</p>}
      {actionError && <p className="text-xs text-destructive">{actionError}</p>}

      {posts === null && (
        <Card>
          <p className="text-sm text-muted-foreground">Loading…</p>
        </Card>
      )}

      {posts !== null && posts.length === 0 && (
        <Card>
          <p className="text-sm text-muted-foreground">
            No posts here yet. Once your team generates this month's content, it'll show up here for review.
          </p>
        </Card>
      )}

      {posts !== null && posts.length > 0 && (
        <div className="space-y-6">
          {CATEGORY_ORDER.map((cat) => {
            const group = posts.filter((p) => categorizePost(p) === cat);
            if (!group.length) return null;
            return <BatchSection key={cat} category={cat} posts={group} agentId={agentId} onChanged={reload} />;
          })}
        </div>
      )}
    </div>
  );
}

// Lets an agent (or an admin acting as them) write a quick idea and get a
// full draft back in their own voice — no Drive content calendar involved.
// Works identically whether a normal agent is self-serving or an admin is
// doing it on their behalf via the "act as" picker above, since both cases
// resolve to the same agentId this component already receives.
function CreateContentForm({ agentId, onCreated }: { agentId: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [contentType, setContentType] = useState<"post" | "email" | "video">("post");
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [instructions, setInstructions] = useState("");
  const [hook, setHook] = useState("");
  const [useHashtags, setUseHashtags] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    if (!goal.trim()) {
      setError("Tell us what this should be about first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await generateMarketingContent({
        data: {
          agentId,
          contentType,
          title,
          goal,
          instructions: instructions.trim() || undefined,
          hook: contentType === "video" ? hook.trim() || undefined : undefined,
          useHashtags: contentType === "post" ? useHashtags : undefined,
        },
      });
      setTitle("");
      setGoal("");
      setInstructions("");
      setHook("");
      setOpen(false);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return <Button onClick={() => setOpen(true)}>+ New content</Button>;
  }

  return (
    <Card>
      <h3 className="font-display text-sm font-semibold">Create new content</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Tell us what you want and we'll write a full draft in your voice — it'll show up below for you to approve, edit,
        or flag, same as anything your team generates for you.
      </p>

      <div className="mt-4 flex flex-wrap gap-1 rounded-full border border-border bg-glass p-1 w-fit">
        {(["post", "email", "video"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setContentType(t)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              contentType === t ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t === "post" ? "Social post" : t === "email" ? "Email" : "Video script"}
          </button>
        ))}
      </div>

      <div className="mt-4 space-y-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title (just for your own reference)"
          className="w-full rounded-xl border border-border bg-glass px-3 py-2 text-sm outline-none"
        />
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              What it's about
            </span>
            <MicButton value={goal} onChange={setGoal} />
          </div>
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder={
              contentType === "post"
                ? `What's this post about? e.g. "Just closed a first-time buyer in 12 days, wanted to share the excitement"`
                : contentType === "email"
                  ? `What's the goal of this email? e.g. "Monthly check-in for past clients, mention rates dropped"`
                  : "What's this video about?"
            }
            className="min-h-[90px] w-full rounded-xl border border-border bg-glass px-3 py-2 text-sm outline-none"
          />
        </div>
        {contentType === "video" && (
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Hook direction
              </span>
              <MicButton value={hook} onChange={setHook} />
            </div>
            <input
              value={hook}
              onChange={(e) => setHook(e.target.value)}
              placeholder="Any specific hook/opening line direction? (optional)"
              className="w-full rounded-xl border border-border bg-glass px-3 py-2 text-sm outline-none"
            />
          </div>
        )}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Anything else
            </span>
            <MicButton value={instructions} onChange={setInstructions} />
          </div>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Anything else it should include? (optional)"
            className="min-h-[60px] w-full rounded-xl border border-border bg-glass px-3 py-2 text-sm outline-none"
          />
        </div>
        {contentType === "post" && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={useHashtags} onChange={(e) => setUseHashtags(e.target.checked)} />
            Add hashtags
          </label>
        )}
      </div>

      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

      <div className="mt-4 flex gap-2">
        <Button onClick={generate} disabled={busy}>
          {busy ? "Writing…" : "Generate"}
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

function PostCard({
  post,
  agentId,
  expanded,
  onToggle,
  onChanged,
}: {
  post: Post;
  agentId: string;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState(post.content);
  const [editing, setEditing] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [mediaOptions, setMediaOptions] = useState<MediaRow[] | null>(null);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [rewriteHistory, setRewriteHistory] = useState<{ feedback: string; result: string }[]>([]);

  useEffect(() => {
    setDraft(post.content);
  }, [post.content]);

  async function approve() {
    setBusy(true);
    setSaveError(null);
    try {
      await updateMarketingPost({ data: { agentId, postId: post.id, status: "approved" } });
      onChanged();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    setBusy(true);
    setSaveError(null);
    try {
      await updateMarketingPost({ data: { agentId, postId: post.id, content: draft } });
      setEditing(false);
      onChanged();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function sendFeedback() {
    setBusy(true);
    setSaveError(null);
    try {
      const trimmedNotes = notes.trim();
      const payload = trimmedNotes
        ? { agentId, postId: post.id, rating: "flagged", notes: trimmedNotes }
        : { agentId, postId: post.id, rating: "flagged" };
      await submitMarketingFeedback({ data: payload });
      await updateMarketingPost({ data: { agentId, postId: post.id, status: "flagged" } });
      setFeedbackOpen(false);
      setNotes("");
      onChanged();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function rewrite() {
    const feedback = notes.trim();
    if (!feedback) {
      setSaveError("Tell us what to fix first.");
      return;
    }
    setRewriting(true);
    setSaveError(null);
    try {
      const res = await rewritePostContent({ data: { agentId, postId: post.id, feedback } });
      setRewriteHistory((h) => [...h, { feedback, result: res.content }]);
      setNotes("");
      onChanged();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setRewriting(false);
    }
  }

  async function openPicker() {
    setPickerOpen(true);
    if (!mediaOptions) {
      try {
        const list = await listMarketingMedia({ data: { agentId, status: "available" } });
        setMediaOptions(list);
      } catch {
        setMediaOptions([]);
      }
    }
  }

  async function pickMedia(mediaId: string | null) {
    setMediaBusy(true);
    setSaveError(null);
    try {
      await setPostMedia({ data: { agentId, postId: post.id, mediaId } });
      setPickerOpen(false);
      onChanged();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setMediaBusy(false);
    }
  }

  const typeLabel = post.content_type === "email" ? "Email" : post.content_type === "video" ? "Video script" : "Post";
  const photoUrl = post.metadata?.media_url || post.metadata?.drive_thumbnail_url || null;

  return (
    <Card>
      <button onClick={onToggle} className="flex w-full items-center justify-between gap-3 text-left">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {typeLabel}
            {post.platform ? ` · ${post.platform}` : ""}
            {post.month ? ` · ${post.month}` : ""}
          </p>
          <h3 className="mt-1 font-display text-base font-semibold">
            {post.title || post.content.slice(0, 60) + (post.content.length > 60 ? "…" : "")}
          </h3>
        </div>
        <StatusBadge status={post.status} />
      </button>

      {expanded && (
        <div className="mt-4 border-t border-border pt-4">
          {post.content_type === "post" && photoUrl && (
            <div className="mb-3 overflow-hidden rounded-2xl border border-border bg-muted">
              {post.metadata?.media_type === "video" ? (
                <video src={photoUrl} controls className="max-h-64 w-full object-contain" />
              ) : (
                <img src={photoUrl} alt="" className="max-h-64 w-full object-contain" />
              )}
            </div>
          )}
          {post.content_type === "post" && post.metadata?.image_suggestion && (
            <p className="mb-2 text-xs text-muted-foreground">
              📸 Image direction from the brief: {post.metadata.image_suggestion}
              {!photoUrl &&
                " — no photo on file yet to attach automatically; add one on the Media tab or pick one below."}
            </p>
          )}
          {editing ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="min-h-[140px] w-full rounded-2xl bg-muted px-4 py-3 text-sm leading-relaxed outline-none ring-ring transition focus:ring-2"
            />
          ) : (
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{post.content}</p>
          )}

          {post.metadata?.canva_link && (
            <a
              href={post.metadata.canva_link}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block text-xs font-semibold text-primary hover:underline"
            >
              Open Canva template →
            </a>
          )}

          {saveError && <p className="mt-2 text-xs text-destructive">{saveError}</p>}

          <div className="mt-4 flex flex-wrap gap-2">
            {editing ? (
              <>
                <Button onClick={saveEdit} disabled={busy}>
                  Save
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setDraft(post.content);
                    setEditing(false);
                  }}
                  disabled={busy}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button onClick={approve} disabled={busy || post.status === "approved"}>
                  {post.status === "approved" ? "Approved" : "Approve"}
                </Button>
                <Button variant="secondary" onClick={() => setEditing(true)} disabled={busy}>
                  Edit
                </Button>
                <Button variant="danger" onClick={() => setFeedbackOpen((v) => !v)} disabled={busy}>
                  Flag / feedback
                </Button>
                {post.content_type === "post" && (
                  <Button variant="secondary" onClick={openPicker} disabled={busy}>
                    {photoUrl ? "Change photo" : "Add photo"}
                  </Button>
                )}
              </>
            )}
          </div>

          {pickerOpen && (
            <div className="mt-4 rounded-2xl border border-border bg-background/40 p-4">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Choose from this agent's media library
                </p>
                <button
                  onClick={() => setPickerOpen(false)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Close
                </button>
              </div>
              {mediaOptions === null && <p className="mt-2 text-xs text-muted-foreground">Loading…</p>}
              {mediaOptions !== null && mediaOptions.length === 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  No available photos or videos uploaded for this agent yet — add some on the Media tab, then come back
                  here.
                </p>
              )}
              {mediaOptions !== null && mediaOptions.length > 0 && (
                <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {mediaOptions.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => pickMedia(m.id)}
                      disabled={mediaBusy}
                      className="overflow-hidden rounded-xl border border-border transition-colors hover:border-primary disabled:opacity-50"
                    >
                      {m.media_type === "video"
                        ? m.url && <video src={m.url} className="aspect-square w-full object-cover" />
                        : m.url && (
                            <img src={m.url} alt={m.caption ?? ""} className="aspect-square w-full object-cover" />
                          )}
                    </button>
                  ))}
                </div>
              )}
              {photoUrl && (
                <button
                  onClick={() => pickMedia(null)}
                  disabled={mediaBusy}
                  className="mt-3 text-xs font-semibold text-destructive hover:underline disabled:opacity-50"
                >
                  Remove photo
                </button>
              )}
            </div>
          )}

          {feedbackOpen && (
            <div className="mt-4 rounded-2xl border border-border bg-background/40 p-4">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  What should change?
                </p>
                <MicButton value={notes} onChange={setNotes} />
              </div>
              {rewriteHistory.length > 0 && (
                <div className="mt-2 space-y-2">
                  {rewriteHistory.map((h, i) => (
                    <div key={i} className="rounded-xl bg-muted px-3 py-2 text-xs leading-relaxed">
                      <p className="text-muted-foreground">You asked: "{h.feedback}"</p>
                      <p className="mt-1 italic">Result: {h.result}</p>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="What is off? Too formal, they never say this, make it shorter…"
                className="mt-2 min-h-[80px] w-full rounded-2xl bg-muted px-4 py-3 text-sm outline-none ring-ring transition focus:ring-2"
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button onClick={rewrite} disabled={busy || rewriting}>
                  {rewriting ? "Rewriting…" : "Rewrite in their voice →"}
                </Button>
                <Button onClick={sendFeedback} variant="secondary" disabled={busy || rewriting}>
                  Submit feedback
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setFeedbackOpen(false);
                    setRewriteHistory([]);
                  }}
                  disabled={busy || rewriting}
                >
                  Done
                </Button>
              </div>
              {rewriteHistory.length > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Not right yet? Add more feedback above and rewrite again.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// Photos capped at ~2000px on the long edge before upload — invisible for
// social content (which gets downsized again on posting anyway) but cuts
// storage 70-90% versus a raw phone photo. Runs entirely client-side via
// canvas, no library needed.
async function resizeImage(file: File, maxEdge = 2000, quality = 0.85): Promise<File> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file; // not a decodable image — upload as-is
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  if (scale === 1) return file; // already small enough
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) return file;
  return new File([blob], file.name.replace(/\.\w+$/, ".jpg"), { type: "image/jpeg" });
}

// Short-form video only — reads duration client-side before spending any
// upload bandwidth on something too long to be usable content anyway.
function getVideoDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(video.src);
      resolve(video.duration);
    };
    video.onerror = () => resolve(0);
    video.src = URL.createObjectURL(file);
  });
}

const MAX_VIDEO_SECONDS = 120;

// Same fixed vocabulary marketing.ts's PHOTO_TAG_OPTIONS uses for matching —
// kept as its own small client-side copy rather than importing the server
// module's export, so nothing about the server bundle is a dependency of
// this chip UI. Keep these two lists in sync if the vocabulary ever changes.
const PHOTO_TAG_OPTIONS = [
  "outdoor portrait",
  "desk or work",
  "neighborhood walk",
  "coffee or local spot",
  "with clients",
  "car or on the go",
  "family",
  "holiday or seasonal",
  "listing or property",
  "community event",
  "casual lifestyle",
  "behind the scenes",
] as const;

function MediaTab({ agentId }: { agentId: string }) {
  const [status, setStatus] = useState<"available" | "used">("available");
  const [media, setMedia] = useState<MediaRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function reload() {
    setMedia(null);
    setError(null);
    listMarketingMedia({ data: { agentId, status } })
      .then((m) => setMedia(m))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, status]);

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || !fileList.length) return;
    setUploading(true);
    setUploadNote(null);
    let uploaded = 0;
    let skipped = 0;
    for (const file of Array.from(fileList)) {
      try {
        const isVideo = file.type.startsWith("video/");
        const mediaType: "photo" | "video" = isVideo ? "video" : "photo";

        if (isVideo) {
          const duration = await getVideoDuration(file);
          if (duration > MAX_VIDEO_SECONDS) {
            skipped++;
            continue;
          }
        }

        const toUpload = isVideo ? file : await resizeImage(file);
        const { path, token } = await createMediaUploadUrl({
          data: { agentId, fileName: toUpload.name },
        });
        const { error: uploadErr } = await supabase.storage.from("media").uploadToSignedUrl(path, token, toUpload);
        if (uploadErr) throw uploadErr;
        await finalizeMediaUpload({ data: { agentId, storagePath: path, mediaType } });
        uploaded++;
      } catch (e) {
        skipped++;
        // eslint-disable-next-line no-console
        console.error("Media upload failed:", e);
      }
    }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setUploadNote(
      skipped > 0
        ? `Uploaded ${uploaded}, skipped ${skipped} (a video over ${MAX_VIDEO_SECONDS}s, or a file that failed to upload).`
        : `Uploaded ${uploaded} file${uploaded === 1 ? "" : "s"}.`,
    );
    if (status === "available") reload();
  }

  async function markUsed(id: string) {
    setBusyId(id);
    try {
      await markMediaUsed({ data: { agentId, mediaIds: [id] } });
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: string) {
    setBusyId(id);
    try {
      await deleteMarketingMedia({ data: { agentId, mediaId: id } });
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  // Tags feed assignSuggestedMedia's category matching (marketing.ts) —
  // added per Mike's request (2026-09-17) so photo suggestions can be
  // smarter than plain FIFO. Toggling a chip saves immediately, optimistic
  // in the grid, so tagging a whole library doesn't need a separate save
  // step per item.
  async function toggleTag(item: MediaRow, tag: string) {
    const nextTags = item.tags.includes(tag) ? item.tags.filter((t) => t !== tag) : [...item.tags, tag];
    setMedia((prev) => (prev ? prev.map((m) => (m.id === item.id ? { ...m, tags: nextTags } : m)) : prev));
    try {
      await setMediaTags({ data: { agentId, mediaId: item.id, tags: nextTags } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMedia((prev) => (prev ? prev.map((m) => (m.id === item.id ? { ...m, tags: item.tags } : m)) : prev));
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <h3 className="font-display text-sm font-semibold">Upload photos or short-form video</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Uploaded here, these are used for this agent's content the same way Drive photos are — once something's used
          in a piece of content, mark it used below and it drops out of the active pool so it doesn't get suggested
          again. This is separate from this agent's Google Drive folder — Drive photos still work exactly as they do
          today, they just won't show up in this grid unless they're also uploaded here.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*"
            multiple
            onChange={(e) => handleFiles(e.target.files)}
            disabled={uploading}
            className="text-sm text-muted-foreground file:mr-3 file:rounded-full file:border-0 file:bg-primary file:px-4 file:py-2 file:text-sm file:font-semibold file:text-primary-foreground"
          />
          {uploading && <span className="text-xs text-muted-foreground">Uploading…</span>}
        </div>
        {uploadNote && <p className="mt-2 text-xs text-muted-foreground">{uploadNote}</p>}
      </Card>

      <div className="flex flex-wrap gap-1 rounded-full border border-border bg-glass p-1 backdrop-blur-xl w-fit">
        {(["available", "used"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              status === s ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {s === "available" ? "Available" : "Used"}
          </button>
        ))}
      </div>

      {error && (
        <Card>
          <p className="text-sm text-destructive">{error}</p>
        </Card>
      )}

      {!error && media === null && (
        <Card>
          <p className="text-sm text-muted-foreground">Loading…</p>
        </Card>
      )}

      {!error && media !== null && media.length === 0 && (
        <Card>
          <p className="text-sm text-muted-foreground">
            {status === "available"
              ? "Nothing uploaded natively for this agent yet — use the upload box above, or keep managing their Google Drive folder the way you do today."
              : "Nothing marked used yet."}
          </p>
        </Card>
      )}

      {!error && media !== null && media.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {media.map((m) => (
            <div key={m.id} className="overflow-hidden rounded-2xl border border-border bg-glass">
              {m.media_type === "video"
                ? m.url && <video src={m.url} controls className="aspect-square w-full object-cover" />
                : m.url && <img src={m.url} alt={m.caption ?? ""} className="aspect-square w-full object-cover" />}
              <div className="flex items-center justify-between gap-1 px-2 pt-2">
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {m.media_type}
                </span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {m.source === "upload" ? "Uploaded" : "Drive"}
                </span>
              </div>
              <div className="flex flex-wrap gap-1 px-2 pt-2">
                {PHOTO_TAG_OPTIONS.map((tag) => {
                  const active = m.tags.includes(tag);
                  return (
                    <button
                      key={tag}
                      onClick={() => toggleTag(m, tag)}
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ${
                        active
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border text-muted-foreground hover:border-primary/50"
                      }`}
                    >
                      {tag}
                    </button>
                  );
                })}
              </div>
              <div className="flex gap-1 p-2">
                {status === "available" ? (
                  <button
                    onClick={() => markUsed(m.id)}
                    disabled={busyId === m.id}
                    className="flex-1 rounded-full border border-border px-2 py-1 text-[11px] font-semibold transition-colors hover:bg-secondary disabled:opacity-50"
                  >
                    Mark used
                  </button>
                ) : (
                  <span className="flex-1 text-center text-[11px] text-muted-foreground">
                    {m.used_at ? `Used ${new Date(m.used_at).toLocaleDateString()}` : "Used"}
                  </span>
                )}
                <button
                  onClick={() => remove(m.id)}
                  disabled={busyId === m.id}
                  className="rounded-full border border-destructive/40 px-2 py-1 text-[11px] font-semibold text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Live, read-only view of an agent's actual Google Drive folder — mainly for
// agents on YMD's video services who still send long-form footage through
// Drive. Nothing here ever writes back to Drive; their existing Drive
// workflow (upload, the "used" subfolder move) is completely untouched.
function DriveTab({ agentId, isAdmin }: { agentId: string; isAdmin: boolean }) {
  const [data, setData] = useState<{ folderId: string | null; files: DriveFile[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [folderInput, setFolderInput] = useState("");
  const [saving, setSaving] = useState(false);

  function reload() {
    setData(null);
    setError(null);
    listAgentDriveMedia({ data: { agentId } })
      .then((d) => setData(d))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  async function saveFolder() {
    setSaving(true);
    setError(null);
    try {
      await setAgentDriveFolder({ data: { agentId, driveFolderId: folderInput } });
      setFolderInput("");
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <h3 className="font-display text-sm font-semibold">This agent's Google Drive folder</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          A live, read-only view of what's actually in their Drive folder right now — mainly useful for agents on our
          video services who still send long-form footage through Drive. This never writes anything back to Drive;
          uploading and marking things used still happens exactly as it does today, over there, untouched.
        </p>
        {isAdmin && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              value={folderInput}
              onChange={(e) => setFolderInput(e.target.value)}
              placeholder={data?.folderId ? `Currently: ${data.folderId}` : "Paste this agent's Drive folder ID"}
              className="min-w-[220px] flex-1 rounded-xl border border-border bg-glass px-3 py-1.5 text-sm outline-none"
            />
            <Button onClick={saveFolder} disabled={saving || !folderInput.trim()}>
              Save folder ID
            </Button>
          </div>
        )}
      </Card>

      {error && (
        <Card>
          <p className="text-sm text-destructive">{error}</p>
        </Card>
      )}

      {!error && data === null && (
        <Card>
          <p className="text-sm text-muted-foreground">Loading…</p>
        </Card>
      )}

      {!error && data !== null && !data.folderId && (
        <Card>
          <p className="text-sm text-muted-foreground">
            No Drive folder connected for this agent yet
            {isAdmin ? " — paste their folder ID above." : " — ask your team to connect one."}
          </p>
        </Card>
      )}

      {!error && data !== null && data.folderId && data.files.length === 0 && (
        <Card>
          <p className="text-sm text-muted-foreground">Their Drive folder is connected but empty right now.</p>
        </Card>
      )}

      {!error && data !== null && data.files.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {data.files.map((f) => (
            <a
              key={f.id}
              href={f.viewUrl}
              target="_blank"
              rel="noreferrer"
              className="overflow-hidden rounded-2xl border border-border bg-glass"
            >
              <img src={f.thumbnailUrl} alt={f.name} className="aspect-square w-full object-cover" />
              <div className="flex items-center justify-between gap-1 px-2 py-2">
                <span className="truncate text-[11px] text-muted-foreground">{f.name}</span>
                {f.isVideo && (
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Video
                  </span>
                )}
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Content Calendar — the Google Drive-driven batch generation flow, brought
// back natively so existing clients keep working exactly like they did in
// the old standalone tool: one Drive folder per month, full of post/email/
// video briefs, read and rewritten in the agent's voice with one click. This
// coexists with the native single-item "Create content" form above — Drive
// stays the source for clients already set up that way while a fully native
// baseline-content editor is still on the roadmap.
//
// Month-folder setup (add/remove) is a genuinely separate, admin-only step —
// see ManageMonthsScreen, reached from the agent picker, never from inside
// this tab. This tab itself is the same screen for admin-acting-as-agent and
// the agent's own login: pick an already-set-up month, generate, review. The
// "Send to Agent" button inside MonthWorkspace is the only thing here still
// gated on isAdmin.
// ============================================================================

function ManageCalendarScreen({ onBack }: { onBack: () => void }) {
  const [months, setMonths] = useState<CalendarMonth[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [newMonth, setNewMonth] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [busyMonthId, setBusyMonthId] = useState<string | null>(null);
  const [activeMonth, setActiveMonth] = useState<CalendarMonth | null>(null);

  function reload() {
    setMonths(null);
    setError(null);
    listCalendarMonths()
      .then((m) => setMonths(m))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }

  useEffect(() => {
    reload();
  }, []);

  async function addMonth() {
    if (!newMonth.trim()) {
      setAddError("Give this month a label.");
      return;
    }
    setAddBusy(true);
    setAddError(null);
    try {
      const res = await addCalendarMonth({ data: { month: newMonth.trim() } });
      setMonths((prev) => [res.month, ...(prev ?? [])]);
      setNewMonth("");
      setAddOpen(false);
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddBusy(false);
    }
  }

  async function removeMonth(monthId: string) {
    setBusyMonthId(monthId);
    try {
      await removeCalendarMonth({ data: { monthId } });
      setMonths((prev) => (prev ?? []).filter((m) => m.id !== monthId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyMonthId(null);
    }
  }

  if (activeMonth) {
    return <CalendarMonthItemsScreen month={activeMonth} onBack={() => setActiveMonth(null)} />;
  }

  return (
    <div className="mt-5 space-y-4">
      <button onClick={onBack} className="text-xs font-semibold text-muted-foreground hover:text-foreground">
        ← Back
      </button>

      <Card>
        <h2 className="font-display text-lg font-semibold">Content Calendar</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          One shared calendar for every agent. Add a month, then add the posts, emails, and video briefs that belong to
          it — every agent generates their own personalized version of the same briefs from their own login.
        </p>
      </Card>

      <Card>
        <div className="flex items-center justify-between">
          <h4 className="font-display text-sm font-semibold">Months</h4>
          {!addOpen && <Button onClick={() => setAddOpen(true)}>+ Add month</Button>}
        </div>

        {addOpen && (
          <div className="mt-3 space-y-2 rounded-2xl border border-border bg-background/40 p-4">
            <input
              value={newMonth}
              onChange={(e) => setNewMonth(e.target.value)}
              placeholder='Month label, e.g. "June 2026"'
              className="w-full rounded-xl border border-border bg-glass px-3 py-2 text-sm outline-none"
            />
            {addError && <p className="text-xs text-destructive">{addError}</p>}
            <div className="flex gap-2">
              <Button onClick={addMonth} disabled={addBusy}>
                {addBusy ? "Adding…" : "Add month"}
              </Button>
              <Button variant="secondary" onClick={() => setAddOpen(false)} disabled={addBusy}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
        {months === null && !error && <p className="mt-3 text-sm text-muted-foreground">Loading…</p>}
        {months !== null && months.length === 0 && (
          <p className="mt-3 text-sm text-muted-foreground">No months yet — add one above to get started.</p>
        )}
        {months !== null && months.length > 0 && (
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {months.map((m) => (
              <div
                key={m.id}
                className="flex items-center justify-between gap-2 rounded-2xl border border-border bg-glass px-4 py-3"
              >
                <button onClick={() => setActiveMonth(m)} className="text-left text-sm font-semibold">
                  {m.month}
                </button>
                <button
                  onClick={() => removeMonth(m.id)}
                  disabled={busyMonthId === m.id}
                  className="shrink-0 text-[11px] font-semibold text-destructive hover:underline disabled:opacity-50"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

const DOC_TYPE_LABEL: Record<CalendarItem["docType"], string> = {
  post: "Social post",
  email: "Email",
  video: "Video",
};

const DOC_TYPE_PLACEHOLDER: Record<CalendarItem["docType"], string> = {
  post: "Post Goal:\n...\n\nPost Image/Video Suggestions:\n...\n\nCanva Template Direction:\nTemplate Link: https://...\n\nPost Copy:\n...",
  email: "Email Goal:\n...\n\nSubject Line Options:\n1. ...\n2. ...\n\nEmail Instructions:\n...",
  video: "Video Goal:\n...\n\nHook:\n...\n\nVideo Script:\n...",
};

function CalendarMonthItemsScreen({ month, onBack }: { month: CalendarMonth; onBack: () => void }) {
  const [items, setItems] = useState<CalendarItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [docType, setDocType] = useState<CalendarItem["docType"]>("post");
  const [title, setTitle] = useState("");
  const [rawText, setRawText] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);

  function reload() {
    setItems(null);
    setError(null);
    listCalendarItems({ data: { monthId: month.id } })
      .then((r) => setItems(r))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month.id]);

  async function addItem() {
    if (!title.trim() || !rawText.trim()) {
      setAddError("Give this piece a title and the brief/copy to generate from.");
      return;
    }
    setAddBusy(true);
    setAddError(null);
    try {
      await addCalendarItem({
        data: { monthId: month.id, docType, title: title.trim(), rawText: rawText.trim() },
      });
      setTitle("");
      setRawText("");
      setAddOpen(false);
      reload();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddBusy(false);
    }
  }

  async function removeItem(itemId: string) {
    setBusyItemId(itemId);
    try {
      await removeCalendarItem({ data: { itemId } });
      setItems((prev) => (prev ?? []).filter((it) => it.id !== itemId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyItemId(null);
    }
  }

  return (
    <div className="mt-5 space-y-4">
      <button onClick={onBack} className="text-xs font-semibold text-muted-foreground hover:text-foreground">
        ← All months
      </button>

      <Card>
        <h2 className="font-display text-lg font-semibold">{month.month}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Add each post, email, and video brief for this month below — the same shape a Drive Doc used to have (goal,
          image suggestions/Canva link, and copy for a post; goal, subject lines, and instructions for an email; goal,
          hook, and script for a video). Every agent's Voice DNA turns these into their own personalized version when
          they generate.
        </p>
      </Card>

      <Card>
        <div className="flex items-center justify-between">
          <h4 className="font-display text-sm font-semibold">This month's content</h4>
          {!addOpen && <Button onClick={() => setAddOpen(true)}>+ Add piece</Button>}
        </div>

        {addOpen && (
          <div className="mt-3 space-y-2 rounded-2xl border border-border bg-background/40 p-4">
            <div className="flex flex-wrap gap-1 rounded-full border border-border bg-glass p-1 w-fit">
              {(["post", "email", "video"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setDocType(t)}
                  className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                    docType === t ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {DOC_TYPE_LABEL[t]}
                </button>
              ))}
            </div>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Title"
              className="w-full rounded-xl border border-border bg-glass px-3 py-2 text-sm outline-none"
            />
            <div className="flex justify-end">
              <MicButton value={rawText} onChange={setRawText} />
            </div>
            <textarea
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              rows={10}
              placeholder={DOC_TYPE_PLACEHOLDER[docType]}
              className="w-full rounded-xl border border-border bg-glass px-3 py-2 text-sm outline-none"
            />
            {addError && <p className="text-xs text-destructive">{addError}</p>}
            <div className="flex gap-2">
              <Button onClick={addItem} disabled={addBusy}>
                {addBusy ? "Adding…" : "Add"}
              </Button>
              <Button variant="secondary" onClick={() => setAddOpen(false)} disabled={addBusy}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
        {items === null && !error && <p className="mt-3 text-sm text-muted-foreground">Loading…</p>}
        {items !== null && items.length === 0 && (
          <p className="mt-3 text-sm text-muted-foreground">Nothing added yet — add a post, email, or video above.</p>
        )}
        {items !== null && items.length > 0 && (
          <div className="mt-3 space-y-2">
            {items.map((it) => (
              <div
                key={it.id}
                className="flex items-center justify-between gap-2 rounded-2xl border border-border bg-glass px-4 py-3"
              >
                <div>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {DOC_TYPE_LABEL[it.docType]}
                  </span>
                  <p className="mt-1 text-sm font-semibold">{it.title}</p>
                </div>
                <button
                  onClick={() => removeItem(it.id)}
                  disabled={busyItemId === it.id}
                  className="shrink-0 text-[11px] font-semibold text-destructive hover:underline disabled:opacity-50"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function ContentCalendarTab({ agentId, isAdmin }: { agentId: string; isAdmin: boolean }) {
  const [months, setMonths] = useState<CalendarMonth[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeMonth, setActiveMonth] = useState<CalendarMonth | null>(null);

  useEffect(() => {
    setMonths(null);
    setError(null);
    setActiveMonth(null);
    listCalendarMonths()
      .then((m) => setMonths(m))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [agentId]);

  if (activeMonth) {
    return (
      <MonthWorkspace agentId={agentId} isAdmin={isAdmin} month={activeMonth} onBack={() => setActiveMonth(null)} />
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <h3 className="font-display text-sm font-semibold">Create My Monthly Content</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Pick a month below to generate this month's posts, emails, and video scripts in your own voice, then review
          and approve them.
        </p>
      </Card>

      <Card>
        <h4 className="font-display text-sm font-semibold">Months</h4>

        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
        {months === null && !error && <p className="mt-3 text-sm text-muted-foreground">Loading…</p>}
        {months !== null && months.length === 0 && (
          <p className="mt-3 text-sm text-muted-foreground">No months set up yet — ask your team to add one.</p>
        )}
        {months !== null && months.length > 0 && (
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {months.map((m) => (
              <button
                key={m.id}
                onClick={() => setActiveMonth(m)}
                className="rounded-2xl border border-border bg-glass px-4 py-3 text-left text-sm font-semibold transition-colors hover:bg-secondary"
              >
                {m.month}
              </button>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function MonthWorkspace({
  agentId,
  isAdmin,
  month: folder,
  onBack,
}: {
  agentId: string;
  isAdmin: boolean;
  month: CalendarMonth;
  onBack: () => void;
}) {
  const [docs, setDocs] = useState<CalendarDoc[] | null>(null);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [useHashtags, setUseHashtags] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [lastBatchId, setLastBatchId] = useState<string | null>(null);
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [postsError, setPostsError] = useState<string | null>(null);
  const [photosOpen, setPhotosOpen] = useState(false);
  const [approving, setApproving] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendNote, setSendNote] = useState<string | null>(null);
  const [approveNote, setApproveNote] = useState<string | null>(null);
  // The agent's OWN Drive photo folder (set on the separate Google Drive tab,
  // unrelated to the shared native calendar above) — still how photo
  // suggestions are sourced today; see the panel below.
  const [agentDriveFolderId, setAgentDriveFolderId] = useState<string | null>(null);
  const [driveError, setDriveError] = useState<string | null>(null);

  function loadDocs() {
    setDocs(null);
    setDocsError(null);
    readContentCalendar({ data: { agentId, monthId: folder.id } })
      .then((r) => setDocs(r.docs))
      .catch((e) => setDocsError(e instanceof Error ? e.message : String(e)));
  }

  function loadPosts() {
    setPosts(null);
    setPostsError(null);
    listMarketingPosts({ data: { agentId, month: folder.month } })
      .then((p) => setPosts(p as Post[]))
      .catch((e) => setPostsError(e instanceof Error ? e.message : String(e)));
  }

  useEffect(() => {
    loadDocs();
    loadPosts();
    listAgentDriveMedia({ data: { agentId } })
      .then((r) => {
        setAgentDriveFolderId(r.folderId);
        setDriveError(null);
      })
      .catch((e) => {
        setAgentDriveFolderId(null);
        setDriveError(e instanceof Error ? e.message : String(e));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, folder.id, folder.month]);

  const batchPosts = (posts ?? []).filter(
    (p) => p.metadata?.source === "content_calendar" || p.metadata?.source === "drive_photo_scan",
  );
  const latestFromPosts = batchPosts.length
    ? (batchPosts[batchPosts.length - 1]?.metadata?.batch_id as string | undefined)
    : undefined;
  const activeBatchId = lastBatchId ?? latestFromPosts ?? null;

  async function generate() {
    setGenerating(true);
    setGenError(null);
    try {
      const res = await generateMonthlyBatch({
        data: { agentId, monthId: folder.id, month: folder.month, useHashtags },
      });
      setLastBatchId(res.batchId);
      loadPosts();
    } catch (e) {
      setGenError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }

  // Explicit confirmation text alongside the download — added per Mike's
  // report (2026-09-18) that Approve All seemed to do nothing until he
  // navigated away and back. The download itself is one signal something
  // happened, but it's easy to miss (it just lands in Downloads), so this
  // also puts a plain-language confirmation right on the screen.
  async function approveAllAndDownload() {
    if (!batchPosts.length) return;
    setApproving(true);
    setPostsError(null);
    setApproveNote(null);
    try {
      if (activeBatchId) {
        await approveBatch({ data: { agentId, batchId: activeBatchId } });
      }
      const fileName = `${folder.month.replace(/\s+/g, "-")}-content.txt`;
      const text = batchPosts
        .map((p) => {
          const heading = (p.title || p.content_type).toUpperCase();
          const canva = p.metadata?.canva_link ? `\nCanva template: ${p.metadata.canva_link}` : "";
          return `${heading}\n${p.content}${canva}`;
        })
        .join("\n\n---\n\n");
      const blob = new Blob([text], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      setApproveNote(
        `Approved ${batchPosts.length} piece${batchPosts.length === 1 ? "" : "s"} of content and downloaded ${fileName}.`,
      );
      loadPosts();
    } catch (e) {
      setPostsError(e instanceof Error ? e.message : String(e));
    } finally {
      setApproving(false);
    }
  }

  async function sendToAgent() {
    setSending(true);
    setSendNote(null);
    try {
      await sendContentToAgent({ data: { agentId, month: folder.month } });
      setSendNote("Sent — they'll get an email with a link to review and approve.");
    } catch (e) {
      setSendNote(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  const postCount = (docs ?? []).filter((d) => d.type === "post").length;
  const emailCount = (docs ?? []).filter((d) => d.type === "email").length;
  const videoCount = (docs ?? []).filter((d) => d.type === "video").length;

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="text-xs font-semibold text-muted-foreground hover:text-foreground">
        ← All months
      </button>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-sm font-semibold">{folder.month}</h3>
            {docsError ? (
              <p className="mt-1 text-xs text-destructive">{docsError}</p>
            ) : docs === null ? (
              <p className="mt-1 text-xs text-muted-foreground">Reading this month's calendar…</p>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">
                {postCount} post{postCount === 1 ? "" : "s"}, {emailCount} email
                {emailCount === 1 ? "" : "s"}, {videoCount} video script{videoCount === 1 ? "" : "s"} in this month's
                calendar.
              </p>
            )}
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={useHashtags} onChange={(e) => setUseHashtags(e.target.checked)} />
              Add hashtags to posts
            </label>
            <Button onClick={generate} disabled={generating || docs === null}>
              {generating ? "Generating…" : "Generate Now"}
            </Button>
          </div>
        </div>
        {genError && <p className="mt-2 text-xs text-destructive">{genError}</p>}
      </Card>

      {agentDriveFolderId ? (
        <PhotoScanPanel
          agentId={agentId}
          folderId={agentDriveFolderId}
          month={folder.month}
          batchId={activeBatchId}
          open={photosOpen}
          onOpen={() => setPhotosOpen(true)}
          onClose={() => setPhotosOpen(false)}
          onAdded={loadPosts}
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          {driveError
            ? driveError
            : "No Google Drive folder set for this agent yet — set one on the Google Drive tab to scan for photo posts."}
        </p>
      )}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h4 className="font-display text-sm font-semibold">This month's generated content</h4>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={approveAllAndDownload} disabled={approving || !batchPosts.length}>
              {approving ? "Working…" : "Approve All & Download"}
            </Button>
            {isAdmin && (
              <Button onClick={sendToAgent} disabled={sending || !batchPosts.length}>
                {sending ? "Sending…" : "Send to Agent"}
              </Button>
            )}
          </div>
        </div>
        {approveNote && <p className="mt-2 text-xs text-muted-foreground">{approveNote}</p>}
        {sendNote && <p className="mt-2 text-xs text-muted-foreground">{sendNote}</p>}
        {postsError && <p className="mt-2 text-xs text-destructive">{postsError}</p>}
        {posts !== null && batchPosts.length === 0 && (
          <p className="mt-3 text-sm text-muted-foreground">
            Nothing generated for this month yet — hit "Generate Now" above.
          </p>
        )}
      </Card>

      {CATEGORY_ORDER.map((cat) => {
        const group = batchPosts.filter((p) => categorizePost(p) === cat);
        if (!group.length) return null;
        return <BatchSection key={cat} category={cat} posts={group} agentId={agentId} onChanged={loadPosts} />;
      })}
    </div>
  );
}

// Cards here default to OPEN (photo, full copy, and Approve/Edit/Flag/Change
// photo all visible immediately) to match the old app's always-expanded
// review grid — clicking a card's header collapses just that one, rather
// than everything starting collapsed and needing a click to see anything.
// Grouped and icon-labeled by content kind (Posts / Canva Templates /
// Emails / Video Scripts, in that fixed order) per Mike's request
// (2026-09-18) so the four different pieces of content are never visually
// indistinguishable from each other.
function BatchSection({
  category,
  posts,
  agentId,
  onChanged,
}: {
  category: ContentCategory;
  posts: Post[];
  agentId: string;
  onChanged: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const meta = CATEGORY_META[category];
  return (
    <div>
      <div
        className={`mb-3 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wider ${meta.accent}`}
      >
        <span aria-hidden="true">{meta.icon}</span>
        <span>{meta.label}</span>
        <span className="rounded-full bg-background/70 px-1.5 py-0.5 text-[10px] font-bold">{posts.length}</span>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {posts.map((post) => (
          <PostCard
            key={post.id}
            post={post}
            agentId={agentId}
            expanded={!collapsed.has(post.id)}
            onToggle={() =>
              setCollapsed((cur) => {
                const next = new Set(cur);
                if (next.has(post.id)) next.delete(post.id);
                else next.add(post.id);
                return next;
              })
            }
            onChanged={onChanged}
          />
        ))}
      </div>
    </div>
  );
}

// Scans a handful of unused Drive photos and writes a caption for each, in
// the agent's voice — ported from analyze-photos.js. Selected suggestions
// become pending posts in the same batch via addPhotoPostsToBatch.
function PhotoScanPanel({
  agentId,
  folderId,
  month,
  batchId,
  open,
  onOpen,
  onClose,
  onAdded,
}: {
  agentId: string;
  folderId: string;
  month: string;
  batchId: string | null;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [suggestions, setSuggestions] = useState<PhotoScanSuggestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  async function scan() {
    setScanning(true);
    setError(null);
    try {
      const res = await scanAgentDrivePhotos({ data: { agentId, folderId, maxPhotos: 5 } });
      setSuggestions(res.suggestions);
      setSelected(new Set(res.suggestions.map((s) => s.fileId)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  }

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function addSelected() {
    if (!suggestions) return;
    const items = suggestions
      .filter((s) => selected.has(s.fileId))
      .map((s) => ({
        title: s.description,
        content: s.suggestedPost,
        driveFileId: s.fileId,
        thumbnailUrl: s.thumbnailUrl,
      }));
    if (!items.length) return;
    setAdding(true);
    setError(null);
    try {
      await addPhotoPostsToBatch({ data: { agentId, month, batchId: batchId ?? undefined, items } });
      setSuggestions(null);
      setSelected(new Set());
      onClose();
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" onClick={onOpen}>
        + Add posts from photos
      </Button>
    );
  }

  return (
    <Card>
      <div className="flex items-center justify-between">
        <h4 className="font-display text-sm font-semibold">Add posts from Drive photos</h4>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Scans a handful of unused photos from this agent's Drive folder and writes a caption for each, in their voice.
        Pick the ones worth turning into posts.
      </p>

      {!suggestions && (
        <div className="mt-3">
          <Button onClick={scan} disabled={scanning}>
            {scanning ? "Scanning…" : "Scan photos"}
          </Button>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

      {suggestions && suggestions.length === 0 && (
        <p className="mt-3 text-sm text-muted-foreground">No unused photos found in this folder.</p>
      )}

      {suggestions && suggestions.length > 0 && (
        <div className="mt-3 space-y-3">
          {suggestions.map((s) => (
            <label key={s.fileId} className="flex gap-3 rounded-2xl border border-border bg-glass p-3 text-sm">
              <input
                type="checkbox"
                checked={selected.has(s.fileId)}
                onChange={() => toggle(s.fileId)}
                className="mt-1"
              />
              <img src={s.thumbnailUrl} alt={s.description} className="h-16 w-16 shrink-0 rounded-xl object-cover" />
              <div>
                <p className="text-xs text-muted-foreground">{s.description}</p>
                <p className="mt-1 whitespace-pre-wrap">{s.suggestedPost}</p>
              </div>
            </label>
          ))}
          <Button onClick={addSelected} disabled={adding || selected.size === 0}>
            {adding ? "Adding…" : `Add ${selected.size} selected`}
          </Button>
        </div>
      )}
    </Card>
  );
}
