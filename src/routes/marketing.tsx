```tsx
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
  setPostDrivePhoto,
  searchUnsplashPhotos,
  setPostUnsplashPhoto,
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
  listAllCalendarMonthsForAdmin,
  addCalendarMonth,
  removeCalendarMonth,
  setCalendarMonthArchived,
  listCalendarItems,
  addCalendarItem,
  removeCalendarItem,
  readContentCalendar,
  generateMonthlyBatch,
  deleteMonthContent,
  scanAgentDrivePhotos,
  scanAgentLibraryPhotos,
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
  type UnsplashResult,
} from "@/lib/marketing";
// Type-only import (erased at build) — the runtime docx library is loaded
// lazily inside buildContentDocxBlob() below instead of imported at the top
// of the file, so its ~170KB gzipped bundle only ever downloads for someone
// who actually clicks "Approve All & Download," not on every visit to this
// page.
import type { Paragraph, TextRun, ExternalHyperlink } from "docx";

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

// The three metadata.source values that mean "this post belongs to a
// month's calendar batch" — already fully reviewable on the "Generate My
// Monthly Content Calendar" tab (MonthWorkspace's own batchPosts filter).
// Shared by that filter and by "Create Individual Posts" (PostsTab), which
// excludes exactly this set so the two tabs show disjoint content instead
// of the same posts twice — see the comment on PostsTab (2026-09-18, per
// Mike: "this post section is repetitive to the generate my monthly
// content... we do need to remove everything that displays in it").
const BATCH_SOURCES = new Set(["content_calendar", "drive_photo_scan", "library_photo_scan"]);

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
    <div className={`rounded-3xl border border-border bg-glass p-6 backdrop-blur-2xl ${className}`}>
      {children}
    </div>
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
  return (
    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${styles}`}>{label}</span>
  );
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
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
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
            Your account isn't set up in Monthly Marketing yet. Ask your team to add you as an
            agent.
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
                One calendar, shared by every agent — build out each month's posts, emails, and
                video briefs once here, and every agent generates their own personalized version
                of it from their own login.
              </p>
            </div>
            <Button onClick={() => setShowCalendarAdmin(true)}>Manage Content Calendar</Button>
          </div>
        </Card>
        <Card className="mt-5">
          <h2 className="font-display text-lg font-semibold">Choose an agent</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick who you're working on behalf of. Every action you take here is logged against
            their account, not yours.
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
            {agents.length === 0 && (
              <p className="text-sm text-muted-foreground">No agents yet.</p>
            )}
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
          {agentName
            ? `Viewing as: ${agentName}`
            : "Posts, emails, and video scripts in your voice — every month."}
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
              ? "Create Individual Posts"
              : t === "calendar"
                ? "Generate My Monthly Content Calendar"
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

// Renamed "Posts" → "Create Individual Posts" and cut down substantially
// (2026-09-18) per Mike: "this post section is repetitive to the generate
// my monthly content... we do need to remove everything that displays in it
// because that already displays in create my monthly content... there's
// nothing for you to even look at in there." He's right that it was mixed:
// this tab's grid showed EVERY post for the agent regardless of source, so
// a month's calendar-generated batch (already fully reviewable, with its
// own Approve/Send/Download, on the "Generate My Monthly Content Calendar"
// tab) was also showing up here a second time.
//
// Fix: this tab's grid is now filtered to exclude the three sources that
// already have a home on the calendar tab (content_calendar,
// drive_photo_scan, library_photo_scan — see BATCH_SOURCES below, shared
// with MonthWorkspace's own filter so the two stay exact opposites of each
// other) — what's left here is only content this tab itself creates
// one-off, via "+ New content" (metadata.source "native_generate"). The
// Drive/Media-Library photo-scan panel was removed from this tab entirely
// for the same reason: MonthWorkspace already has its own copy, and a
// suggestion added from either one is a content_calendar-adjacent source
// that would only ever show on the calendar tab anyway — having two
// separate scan buttons that both feed the same one destination was exactly
// the kind of duplication Mike flagged, just one level deeper.
function PostsTab({ agentId, isAdmin }: { agentId: string; isAdmin: boolean }) {
  const [months, setMonths] = useState<string[]>([]);
  const [month, setMonth] = useState<string>("");
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approvingAll, setApprovingAll] = useState(false);
  const [approveNote, setApproveNote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendNote, setSendNote] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Still needed here even without the photo-scan panel — PostCard's own
  // "Change photo" picker has a Google Drive tab gated on this being set.
  const [driveFolderId, setDriveFolderId] = useState<string | null>(null);

  // `clear` only true for a genuine month/agent switch — an action-triggered
  // reload (after Approve, Save, a photo change, etc.) keeps the current
  // posts on screen while the fresh list loads in the background instead of
  // wiping the whole grid to nothing first. Fixes Mike's report (2026-09-18)
  // that editing and saving a post "does a weird timeout and then comes back
  // like a reset" — that was this screen briefly unmounting every card
  // (including whichever ones had feedback/photo panels open) every single
  // time anything changed, not an actual save failure.
  function reload(opts?: { clear?: boolean }) {
    if (opts?.clear) setPosts(null);
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
      .then((d) => setDriveFolderId(d.folderId))
      .catch(() => setDriveFolderId(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  useEffect(() => {
    reload({ clear: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, month]);

  // Explicit confirmation text after this finishes — added per Mike's
  // report (2026-09-18) that clicking Approve all didn't seem to do
  // anything until he navigated away and back. The status badges on each
  // card do update immediately once reload() resolves, but there was no
  // unmistakable, un-missable confirmation that the click itself worked, so
  // this adds one plainly on the screen without needing to go find it.
  //
  // Also downloads the txt+docx export now (2026-09-18, second pass), via
  // the same downloadContentExport() the calendar tab's "Approve All &
  // Download" already used — this tab's "Approve all" previously only
  // flipped statuses with no download at all, which is exactly what Mike
  // meant by "no download comes up when the client or user approves on
  // their end": the client mostly lives on this tab (it's the default one),
  // not the calendar tab, so it's the one that actually needed this. Only
  // downloads when a specific month is picked — "All months" mixes batches
  // together in a way that doesn't make sense as one publishing doc.
  async function approveAll() {
    setApprovingAll(true);
    setActionError(null);
    setApproveNote(null);
    try {
      const res = await approveAllPending({ data: month ? { agentId, month } : { agentId } });
      let noteTail = "";
      if (month) {
        const files = await downloadContentExport(posts ?? [], month);
        if (files) noteTail = ` Downloaded ${files.textFileName} and ${files.docxFileName}.`;
      }
      setApproveNote(
        (res.updated > 0
          ? `Approved ${res.updated} post${res.updated === 1 ? "" : "s"}.`
          : "Nothing left to approve — everything here is already approved.") + noteTail,
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
    setSendNote(null);
    try {
      await sendContentToAgent({ data: { agentId, month } });
      setSendNote("Sent — they'll get an email with a link to review and approve.");
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

  // Only this tab's own one-off content (see BATCH_SOURCES/comment above) —
  // a calendar batch's posts, or ones added via the other tab's photo scan,
  // never show here now, only on "Generate My Monthly Content Calendar".
  const ownPosts = (posts ?? []).filter((p) => !BATCH_SOURCES.has(p.metadata?.source ?? ""));
  const pendingCount = ownPosts.filter((p) => p.status !== "approved").length;

  return (
    <div className="space-y-4">
      <CreateContentForm agentId={agentId} onCreated={reload} />

      <div className="flex flex-wrap items-center gap-2">
        {months.length > 0 && (
          <>
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Month
            </span>
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
        {ownPosts.length > 0 && (
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
      </div>

      {approveNote && <p className="text-xs text-muted-foreground">{approveNote}</p>}
      {sendNote && <p className="text-xs text-muted-foreground">{sendNote}</p>}
      {actionError && <p className="text-xs text-destructive">{actionError}</p>}

      {posts === null && (
        <Card>
          <p className="text-sm text-muted-foreground">Loading…</p>
        </Card>
      )}

      {posts !== null && ownPosts.length === 0 && (
        <Card>
          <p className="text-sm text-muted-foreground">
            Nothing created one-off yet — use "+ New content" above. Content from a month's
            calendar (or its photo scan) lives on the "Generate My Monthly Content Calendar" tab
            instead, not here.
          </p>
        </Card>
      )}

      {ownPosts.length > 0 && (
        <div className="space-y-6">
          {CATEGORY_ORDER.map((cat) => {
            const group = ownPosts.filter((p) => categorizePost(p) === cat);
            if (!group.length) return null;
            return (
              <BatchSection
                key={cat}
                category={cat}
                posts={group}
                agentId={agentId}
                driveFolderId={driveFolderId}
                onChanged={reload}
              />
            );
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
        Tell us what you want and we'll write a full draft in your voice — it'll show up below for
        you to approve, edit, or flag, same as anything your team generates for you.
      </p>

      <div className="mt-4 flex flex-wrap gap-1 rounded-full border border-border bg-glass p-1 w-fit">
        {(["post", "email", "video"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setContentType(t)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              contentType === t
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground"
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
            <input
              type="checkbox"
              checked={useHashtags}
              onChange={(e) => setUseHashtags(e.target.checked)}
            />
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
  driveFolderId,
  onChanged,
}: {
  post: Post;
  agentId: string;
  driveFolderId: string | null;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState(post.content);
  const [editing, setEditing] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTab, setPickerTab] = useState<"library" | "drive" | "unsplash">("library");
  const [mediaOptions, setMediaOptions] = useState<MediaRow[] | null>(null);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [driveOptions, setDriveOptions] = useState<DriveFile[] | null>(null);
  const [driveOptionsError, setDriveOptionsError] = useState<string | null>(null);
  const [unsplashQuery, setUnsplashQuery] = useState("");
  const [unsplashResults, setUnsplashResults] = useState<UnsplashResult[] | null>(null);
  const [unsplashLoading, setUnsplashLoading] = useState(false);
  const [unsplashError, setUnsplashError] = useState<string | null>(null);
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
    setPickerTab("library");
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

  // Google Drive tab of the picker — added 2026-09-18 per Mike's request
  // ("when changing a photo for one of the posts we need to add a button to
  // check google drive photos too"). Reuses the same listing the Google
  // Drive tab already calls, so it's the exact same set of files, minus
  // whatever's already been moved to that folder's "used" subfolder.
  async function openDriveTab() {
    setPickerTab("drive");
    if (!driveOptions && driveFolderId) {
      try {
        const res = await listAgentDriveMedia({ data: { agentId } });
        setDriveOptions(res.files);
        setDriveOptionsError(null);
      } catch (e) {
        setDriveOptions([]);
        setDriveOptionsError(e instanceof Error ? e.message : String(e));
      }
    }
  }

  async function pickDriveFile(file: DriveFile) {
    setMediaBusy(true);
    setSaveError(null);
    try {
      await setPostDrivePhoto({
        data: { agentId, postId: post.id, driveFileId: file.id, thumbnailUrl: file.thumbnailUrl },
      });
      setPickerOpen(false);
      onChanged();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setMediaBusy(false);
    }
  }

  // Stock-photo tab (Unsplash) — added 2026-09-18. Mike specifically flagged
  // emails as missing a photo option entirely (they don't have an agent's
  // own Drive/library photos to draw from the way posts do), and said the
  // old app used Unsplash for this. Defaults the search to the post's own
  // title/topic so there's usually already something useful on first open.
  async function runUnsplashSearch(query: string) {
    setUnsplashLoading(true);
    setUnsplashError(null);
    try {
      const res = await searchUnsplashPhotos({ data: { agentId, query } });
      setUnsplashResults(res.results);
    } catch (e) {
      setUnsplashResults([]);
      setUnsplashError(e instanceof Error ? e.message : String(e));
    } finally {
      setUnsplashLoading(false);
    }
  }

  function openUnsplashTab() {
    setPickerTab("unsplash");
    if (!unsplashResults) {
      const defaultQuery = unsplashQuery.trim() || post.title || "lifestyle real estate";
      setUnsplashQuery(defaultQuery);
      runUnsplashSearch(defaultQuery);
    }
  }

  async function pickUnsplash(r: UnsplashResult) {
    setMediaBusy(true);
    setSaveError(null);
    try {
      await setPostUnsplashPhoto({
        data: {
          agentId,
          postId: post.id,
          photoUrl: r.fullUrl,
          photographerName: r.photographerName,
          photographerProfileUrl: r.photographerProfileUrl,
        },
      });
      setPickerOpen(false);
      onChanged();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setMediaBusy(false);
    }
  }

  const typeLabel =
    post.content_type === "email" ? "Email" : post.content_type === "video" ? "Video script" : "Post";
  const photoUrl = post.metadata?.media_url || post.metadata?.drive_thumbnail_url || null;

  return (
    <Card>
      {/* Header is deliberately not clickable — per Mike's request (2026-09-18)
          after collapsing a card on click turned out to offer no value and
          just made content vanish unexpectedly. Cards always show everything. */}
      <div className="flex w-full items-center justify-between gap-3 text-left">
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
      </div>

      <div className="mt-4 border-t border-border pt-4">
          {/* Was gated to content_type === "post" only, so an email's chosen
              photo (Unsplash, in practice — emails don't have their own Drive/
              library photos the way posts do) was saved successfully server-side
              but never actually rendered here: the picker closed and the card
              looked exactly like nothing had happened. That's the bug behind
              Mike's report (2026-09-18) "email when you choose a photo it
              doesn't allow you to save it, you click it and it just resets and
              doesn't show anything attached" — the save worked, the display
              didn't. Fixed to match the "Add/Change photo" button's own
              condition just below, which already covered both types. */}
          {(post.content_type === "post" || post.content_type === "email") && photoUrl && (
            <div className="mb-3 overflow-hidden rounded-2xl border border-border bg-muted">
              {post.metadata?.media_type === "video" ? (
                <video src={photoUrl} controls className="max-h-64 w-full object-contain" />
              ) : (
                <img src={photoUrl} alt="" className="max-h-64 w-full object-contain" />
              )}
            </div>
          )}
          {photoUrl && post.metadata?.unsplash_photographer && (
            <p className="-mt-2 mb-3 text-[11px] text-muted-foreground">
              Photo by{" "}
              <a
                href={post.metadata.unsplash_credit_url ?? "https://unsplash.com"}
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-foreground"
              >
                {post.metadata.unsplash_photographer}
              </a>{" "}
              on Unsplash
            </p>
          )}
          {post.content_type === "post" && post.metadata?.image_suggestion && (
            <p className="mb-2 text-xs text-muted-foreground">
              📸 Image direction from the brief: {post.metadata.image_suggestion}
              {!photoUrl && " — no photo on file yet to attach automatically; add one on the Media tab or pick one below."}
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
                {(post.content_type === "post" || post.content_type === "email") && (
                  <Button variant="secondary" onClick={openPicker} disabled={busy}>
                    {photoUrl ? "Change photo" : "Add photo"}
                  </Button>
                )}
              </>
            )}
          </div>

          {pickerOpen && (
            <div className="mt-4 rounded-2xl border border-border bg-background/40 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold">
                  Which image or video do you want to use dude? Click and I will make it happen.
                </p>
                <button
                  onClick={() => setPickerOpen(false)}
                  className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
                >
                  Close
                </button>
              </div>

              <div className="mt-3 flex flex-wrap gap-2 border-b border-border pb-3">
                <button
                  onClick={() => setPickerTab("library")}
                  className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                    pickerTab === "library" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Media Library
                </button>
                {driveFolderId && (
                  <button
                    onClick={openDriveTab}
                    className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                      pickerTab === "drive" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Google Drive
                  </button>
                )}
                <button
                  onClick={openUnsplashTab}
                  className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                    pickerTab === "unsplash" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Stock Photos
                </button>
              </div>

              {pickerTab === "library" && (
                <div className="mt-3">
                  {mediaOptions === null && (
                    <p className="text-xs text-muted-foreground">Loading…</p>
                  )}
                  {mediaOptions !== null && mediaOptions.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      No available photos or videos uploaded for this agent yet — add some on the
                      Media tab, then come back here.
                    </p>
                  )}
                  {mediaOptions !== null && mediaOptions.length > 0 && (
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
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
                </div>
              )}

              {pickerTab === "drive" && (
                <div className="mt-3">
                  {driveOptionsError && <p className="text-xs text-destructive">{driveOptionsError}</p>}
                  {!driveOptionsError && driveOptions === null && (
                    <p className="text-xs text-muted-foreground">Loading…</p>
                  )}
                  {!driveOptionsError && driveOptions !== null && driveOptions.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      No unused photos or videos found in this agent's Drive folder.
                    </p>
                  )}
                  {driveOptions !== null && driveOptions.length > 0 && (
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                      {driveOptions.map((f) => (
                        <button
                          key={f.id}
                          onClick={() => pickDriveFile(f)}
                          disabled={mediaBusy}
                          className="overflow-hidden rounded-xl border border-border transition-colors hover:border-primary disabled:opacity-50"
                        >
                          {f.isVideo ? (
                            <video src={f.thumbnailUrl} className="aspect-square w-full object-cover" />
                          ) : (
                            <img src={f.thumbnailUrl} alt={f.name} className="aspect-square w-full object-cover" />
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {pickerTab === "unsplash" && (
                <div className="mt-3">
                  <div className="flex gap-2">
                    <input
                      value={unsplashQuery}
                      onChange={(e) => setUnsplashQuery(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && runUnsplashSearch(unsplashQuery)}
                      placeholder="Search stock photos — coffee, fall, neighborhood…"
                      className="flex-1 rounded-xl border border-border bg-glass px-3 py-1.5 text-sm outline-none"
                    />
                    <Button
                      variant="secondary"
                      onClick={() => runUnsplashSearch(unsplashQuery)}
                      disabled={unsplashLoading}
                    >
                      {unsplashLoading ? "Searching…" : "Search"}
                    </Button>
                  </div>
                  {unsplashError && <p className="mt-2 text-xs text-destructive">{unsplashError}</p>}
                  {!unsplashError && unsplashResults !== null && unsplashResults.length === 0 && !unsplashLoading && (
                    <p className="mt-2 text-xs text-muted-foreground">No results — try a different search.</p>
                  )}
                  {unsplashResults !== null && unsplashResults.length > 0 && (
                    <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
                      {unsplashResults.map((r) => (
                        <button
                          key={r.id}
                          onClick={() => pickUnsplash(r)}
                          disabled={mediaBusy}
                          title={`Photo by ${r.photographerName} on Unsplash`}
                          className="overflow-hidden rounded-xl border border-border transition-colors hover:border-primary disabled:opacity-50"
                        >
                          <img src={r.thumbUrl} alt="" className="aspect-square w-full object-cover" />
                        </button>
                      ))}
                    </div>
                  )}
                  <p className="mt-2 text-[11px] text-muted-foreground">Photos via Unsplash — credit is added automatically.</p>
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
        const { error: uploadErr } = await supabase.storage
          .from("media")
          .uploadToSignedUrl(path, token, toUpload);
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
    const nextTags = item.tags.includes(tag)
      ? item.tags.filter((t) => t !== tag)
      : [...item.tags, tag];
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
          Uploaded here, these are used for this agent's content the same way Drive photos are —
          once something's used in a piece of content, mark it used below and it drops out of the
          active pool so it doesn't get suggested again. This is separate from this agent's Google
          Drive folder — Drive photos still work exactly as they do today, they just won't show up
          in this grid unless they're also uploaded here.
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
              {m.media_type === "video" ? (
                m.url && <video src={m.url} controls className="aspect-square w-full object-cover" />
              ) : (
                m.url && (
                  <img src={m.url} alt={m.caption ?? ""} className="aspect-square w-full object-cover" />
                )
              )}
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
  // Added 2026-09-18 per Mike's report that a folder "still does not appear
  // for the agent" after he believed he'd already connected one — there was
  // no confirmation at all when Save actually succeeded, so there was no way
  // to tell "it didn't save" from "it saved, but for a different agent than
  // I meant to." This makes success (and exactly which agent it applied to)
  // unmissable, the same instinct as the Approve-All confirmation text.
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  function reload() {
    setData(null);
    setError(null);
    listAgentDriveMedia({ data: { agentId } })
      .then((d) => setData(d))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }

  useEffect(() => {
    reload();
    setSaveNote(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  async function saveFolder() {
    setSaving(true);
    setError(null);
    setSaveNote(null);
    try {
      await setAgentDriveFolder({ data: { agentId, driveFolderId: folderInput } });
      setSaveNote(`Saved — this agent's Drive folder is now ${folderInput.trim()}.`);
      setFolderInput("");
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  // "we need a way to remove [a connected folder]" (2026-09-18) — Save was
  // previously the only control here and it's disabled on an empty input,
  // so there was actually no way to clear a folder ID from this screen at
  // all before this. Clears agents.drive_folder_id back to null.
  async function removeFolder() {
    setRemoving(true);
    setError(null);
    setSaveNote(null);
    try {
      await setAgentDriveFolder({ data: { agentId, driveFolderId: "" } });
      setSaveNote("Removed — this agent's Drive connection is cleared.");
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <h3 className="font-display text-sm font-semibold">This agent's Google Drive folder</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          A live, read-only view of what's actually in their Drive folder right now — mainly useful
          for agents on our video services who still send long-form footage through Drive. This
          never writes anything back to Drive; uploading and marking things used still happens
          exactly as it does today, over there, untouched.
        </p>
        {isAdmin && (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                value={folderInput}
                onChange={(e) => setFolderInput(e.target.value)}
                placeholder={
                  data?.folderId ? `Currently: ${data.folderId}` : "Paste this agent's Drive folder ID"
                }
                className="min-w-[220px] flex-1 rounded-xl border border-border bg-glass px-3 py-1.5 text-sm outline-none"
              />
              <Button onClick={saveFolder} disabled={saving || !folderInput.trim()}>
                {saving ? "Saving…" : "Save folder ID"}
              </Button>
              {data?.folderId && (
                <Button variant="danger" onClick={removeFolder} disabled={removing}>
                  {removing ? "Removing…" : "Remove connection"}
                </Button>
              )}
            </div>
            {saveNote && <p className="mt-2 text-xs text-muted-foreground">{saveNote}</p>}
          </>
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
          <p className="text-sm text-muted-foreground">
            Their Drive folder is connected but empty right now.
          </p>
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
  // Added 2026-09-18 per Mike: "We also need an Archive so we can archive
  // that content and we dont have a long list of stuff to do." Off by
  // default (the plain, non-archived listCalendarMonths — same one every
  // agent's month picker uses); flipping it switches to the admin-only
  // listAllCalendarMonthsForAdmin so a past month can still be found again
  // to unarchive it.
  const [showArchived, setShowArchived] = useState(false);

  function reload() {
    setMonths(null);
    setError(null);
    (showArchived ? listAllCalendarMonthsForAdmin() : listCalendarMonths())
      .then((m) => setMonths(m))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showArchived]);

  async function toggleArchived(m: CalendarMonth) {
    setBusyMonthId(m.id);
    setError(null);
    try {
      await setCalendarMonthArchived({ data: { monthId: m.id, archived: !m.archived } });
      if (!showArchived) {
        // Archiving one while looking at the non-archived list makes it
        // disappear immediately; unarchiving can't happen from this list
        // since an archived month was never shown here in the first place.
        setMonths((prev) => (prev ?? []).filter((x) => x.id !== m.id));
      } else {
        setMonths((prev) => (prev ?? []).map((x) => (x.id === m.id ? { ...x, archived: !x.archived } : x)));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyMonthId(null);
    }
  }

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
          One shared calendar for every agent. Add a month, then add the posts, emails, and video
          briefs that belong to it — every agent generates their own personalized version of the
          same briefs from their own login.
        </p>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="font-display text-sm font-semibold">
            {showArchived ? "All months (including archived)" : "Months"}
          </h4>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              Show archived
            </label>
            {!addOpen && <Button onClick={() => setAddOpen(true)}>+ Add month</Button>}
          </div>
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
          <p className="mt-3 text-sm text-muted-foreground">
            No months yet — add one above to get started.
          </p>
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
                  {m.archived && (
                    <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Archived
                    </span>
                  )}
                </button>
                <div className="flex shrink-0 items-center gap-3">
                  <button
                    onClick={() => toggleArchived(m)}
                    disabled={busyMonthId === m.id}
                    className="text-[11px] font-semibold text-muted-foreground hover:text-foreground hover:underline disabled:opacity-50"
                  >
                    {m.archived ? "Unarchive" : "Archive"}
                  </button>
                  <button
                    onClick={() => removeMonth(m.id)}
                    disabled={busyMonthId === m.id}
                    className="text-[11px] font-semibold text-destructive hover:underline disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
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
          Add each post, email, and video brief for this month below — the same shape a Drive Doc
          used to have (goal, image suggestions/Canva link, and copy for a post; goal, subject
          lines, and instructions for an email; goal, hook, and script for a video). Every agent's
          Voice DNA turns these into their own personalized version when they generate.
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
          <p className="mt-3 text-sm text-muted-foreground">
            Nothing added yet — add a post, email, or video above.
          </p>
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
      <MonthWorkspace
        agentId={agentId}
        isAdmin={isAdmin}
        month={activeMonth}
        onBack={() => setActiveMonth(null)}
      />
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <h3 className="font-display text-sm font-semibold">Create My Monthly Content</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Pick a month below to generate this month's posts, emails, and video scripts in your
          own voice, then review and approve them.
        </p>
      </Card>

      <Card>
        <h4 className="font-display text-sm font-semibold">Months</h4>

        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
        {months === null && !error && (
          <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
        )}
        {months !== null && months.length === 0 && (
          <p className="mt-3 text-sm text-muted-foreground">
            No months set up yet — ask your team to add one.
          </p>
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

// Builds the Word-doc version of "Approve All & Download" — added
// 2026-09-18 per Mike's request ("in download is a text file only. Need to
// keep it the same way it was with word document too. Make sure all links
// are in there.") The section headings, numbering, and the
// "PHOTO: Download / View in Drive" line per post are matched to the format
// of the publishing-instructions doc his team used before this app existed,
// so this replaces that doc's format rather than inventing a new one.
const DOCX_SECTION_TITLE: Record<ContentCategory, string> = {
  post: "SOCIAL POSTS",
  canva: "CANVA TEMPLATES",
  email: "EMAILS",
  video: "VIDEO SCRIPTS",
};

function photoLinksForPost(p: Post): { downloadUrl: string | null; driveUrl: string | null } {
  const downloadUrl = p.metadata?.media_url || p.metadata?.drive_thumbnail_url || null;
  const driveUrl = p.metadata?.drive_file_id
    ? `https://drive.google.com/file/d/${p.metadata.drive_file_id}/view`
    : null;
  return { downloadUrl, driveUrl };
}

async function buildContentDocxBlob(batchPosts: Post[], monthLabel: string): Promise<Blob> {
  const docxLib = await import("docx");
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink } = docxLib;

  const children: Paragraph[] = [
    new Paragraph({ text: monthLabel, heading: HeadingLevel.TITLE }),
    new Paragraph({ text: "Publishing Instructions · Your Marketing Dude", spacing: { after: 300 } }),
  ];

  for (const cat of CATEGORY_ORDER) {
    const group = batchPosts.filter((p) => categorizePost(p) === cat);
    if (!group.length) continue;
    children.push(new Paragraph({ text: DOCX_SECTION_TITLE[cat], heading: HeadingLevel.HEADING_1, spacing: { before: 300, after: 150 } }));

    group.forEach((p, i) => {
      const title = p.title || `${DOCX_SECTION_TITLE[cat]} ${i + 1}`;
      children.push(
        new Paragraph({
          spacing: { before: 200 },
          children: [new TextRun({ text: `${i + 1}. ${title}`, bold: true })],
        }),
      );
      for (const line of p.content.split("\n")) {
        children.push(new Paragraph({ text: line || " " }));
      }

      if (cat === "post" || cat === "canva") {
        const { downloadUrl, driveUrl } = photoLinksForPost(p);
        if (downloadUrl || driveUrl) {
          const runs: (TextRun | ExternalHyperlink)[] = [new TextRun({ text: "PHOTO:  " })];
          if (downloadUrl) {
            runs.push(
              new ExternalHyperlink({
                link: downloadUrl,
                children: [new TextRun({ text: "⬇ Download", style: "Hyperlink" })],
              }),
            );
          }
          if (downloadUrl && driveUrl) runs.push(new TextRun({ text: "   " }));
          if (driveUrl) {
            runs.push(
              new ExternalHyperlink({
                link: driveUrl,
                children: [new TextRun({ text: "📁 View in Drive", style: "Hyperlink" })],
              }),
            );
          }
          children.push(new Paragraph({ spacing: { before: 100 }, children: runs }));
        }
        if (p.metadata?.canva_link) {
          children.push(
            new Paragraph({
              children: [
                new TextRun({ text: "Canva template:  " }),
                new ExternalHyperlink({
                  link: p.metadata.canva_link,
                  children: [new TextRun({ text: p.metadata.canva_link, style: "Hyperlink" })],
                }),
              ],
            }),
          );
        }
      }

      if (cat === "email" && p.metadata?.unsplash_photographer) {
        children.push(
          new Paragraph({
            spacing: { before: 100 },
            children: [
              new TextRun({ text: "EMAIL PHOTOS:", bold: true }),
            ],
          }),
        );
        children.push(new Paragraph({ text: `Photo 1: ${p.metadata.unsplash_photographer}` }));
      }
    });
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBlob(doc);
}

// Shared by PostsTab's "Approve all" and MonthWorkspace's "Approve All &
// Download" — added 2026-09-18 per Mike: "No download comes up when the
// client or user approves on their end," plus his broader point that the
// two review screens (the flat Posts tab and the "Create My Monthly
// Content" calendar tab) should behave identically since they're really the
// same app either way. Before this, only the calendar tab's approve button
// actually built and downloaded the txt/docx export — the Posts tab's
// "Approve all" just flipped statuses with no download at all, which is
// exactly what "no download comes up" describes. Now both call this.
function downloadContentExport(posts: Post[], monthLabel: string) {
  if (!posts.length) return;
  const baseName = monthLabel.replace(/\s+/g, "-");

  const textFileName = `${baseName}-content.txt`;
  const text = posts
    .map((p) => {
      const heading = (p.title || p.content_type).toUpperCase();
      const canva = p.metadata?.canva_link ? `\nCanva template: ${p.metadata.canva_link}` : "";
      return `${heading}\n${p.content}${canva}`;
    })
    .join("\n\n---\n\n");
  const textBlob = new Blob([text], { type: "text/plain" });
  const textUrl = URL.createObjectURL(textBlob);
  const textLink = document.createElement("a");
  textLink.href = textUrl;
  textLink.download = textFileName;
  textLink.click();
  URL.revokeObjectURL(textUrl);

  const docxFileName = `${baseName}-content.docx`;
  return buildContentDocxBlob(posts, monthLabel).then((docxBlob) => {
    const docxUrl = URL.createObjectURL(docxBlob);
    const docxLink = document.createElement("a");
    docxLink.href = docxUrl;
    docxLink.download = docxFileName;
    docxLink.click();
    URL.revokeObjectURL(docxUrl);
    return { textFileName, docxFileName };
  });
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
  // Added 2026-09-18 per Mike: "Put a delete in case we want to re generate
  // that months content." generateMonthlyBatch only ever inserts, so a
  // second "Generate Now" click piles a second batch on top of the first —
  // this clears this agent's generated content for this month so a fresh
  // Generate Now actually starts clean. Admin-only (it deletes an agent's
  // data, not just reviews it) and requires clicking twice — Delete arms a
  // "Really delete?" confirm rather than firing immediately, since there's
  // no undo.
  const [deleting, setDeleting] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleteNote, setDeleteNote] = useState<string | null>(null);

  async function deleteContent() {
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setDeleting(true);
    setDeleteNote(null);
    try {
      const res = await deleteMonthContent({ data: { agentId, month: folder.month } });
      setDeleteNote(
        res.deleted > 0
          ? `Deleted ${res.deleted} piece${res.deleted === 1 ? "" : "s"} of generated content for ${folder.month} — hit "Generate Now" above for a fresh batch.`
          : "Nothing to delete — this month has no generated content for this agent yet.",
      );
      setLastBatchId(null);
      loadPosts();
    } catch (e) {
      setDeleteNote(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
      setDeleteArmed(false);
    }
  }

  function loadDocs() {
    setDocs(null);
    setDocsError(null);
    readContentCalendar({ data: { agentId, monthId: folder.id } })
      .then((r) => setDocs(r.docs))
      .catch((e) => setDocsError(e instanceof Error ? e.message : String(e)));
  }

  // Same fix as PostsTab's reload() (2026-09-18): only clear the on-screen
  // list for a genuine month switch, not for every action-triggered refresh
  // — otherwise saving an edit, approving, or changing a photo makes the
  // whole grid disappear and reappear, which read as a broken save.
  function loadPosts(opts?: { clear?: boolean }) {
    if (opts?.clear) setPosts(null);
    setPostsError(null);
    listMarketingPosts({ data: { agentId, month: folder.month } })
      .then((p) => setPosts(p as Post[]))
      .catch((e) => setPostsError(e instanceof Error ? e.message : String(e)));
  }

  useEffect(() => {
    loadDocs();
    loadPosts({ clear: true });
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

  const batchPosts = (posts ?? []).filter((p) => BATCH_SOURCES.has(p.metadata?.source ?? ""));
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
  //
  // Downloads BOTH a .txt and a .docx (2026-09-18, per Mike: "in download is
  // a text file only. Need to keep it the same way it was with word document
  // too. Make sure all links are in there.") — the .docx is the one that
  // matches the old publishing-instructions format, with photo download/
  // Drive links; the .txt is kept too since it was already there and some
  // people just want to paste text.
  async function approveAllAndDownload() {
    if (!batchPosts.length) return;
    setApproving(true);
    setPostsError(null);
    setApproveNote(null);
    try {
      if (activeBatchId) {
        await approveBatch({ data: { agentId, batchId: activeBatchId } });
      }
      const files = await downloadContentExport(batchPosts, folder.month);
      setApproveNote(
        `Approved ${batchPosts.length} piece${batchPosts.length === 1 ? "" : "s"} of content` +
          (files ? ` and downloaded ${files.textFileName} and ${files.docxFileName}.` : "."),
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
      <button
        onClick={onBack}
        className="text-xs font-semibold text-muted-foreground hover:text-foreground"
      >
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
                {emailCount === 1 ? "" : "s"}, {videoCount} video script{videoCount === 1 ? "" : "s"}{" "}
                in this month's calendar.
              </p>
            )}
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={useHashtags}
                onChange={(e) => setUseHashtags(e.target.checked)}
              />
              Add hashtags to posts
            </label>
            <Button onClick={generate} disabled={generating || docs === null}>
              {generating ? "Generating…" : "Generate Now"}
            </Button>
          </div>
        </div>
        {genError && <p className="mt-2 text-xs text-destructive">{genError}</p>}
      </Card>

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
      {!agentDriveFolderId && driveError && <p className="text-xs text-muted-foreground">{driveError}</p>}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h4 className="font-display text-sm font-semibold">This month's generated content</h4>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={approveAllAndDownload}
              disabled={approving || !batchPosts.length}
            >
              {approving ? "Working…" : "Approve All & Download"}
            </Button>
            {isAdmin && (
              <Button onClick={sendToAgent} disabled={sending || !batchPosts.length}>
                {sending ? "Sending…" : "Send to Agent"}
              </Button>
            )}
            {isAdmin && batchPosts.length > 0 && (
              <>
                <Button variant="danger" onClick={deleteContent} disabled={deleting}>
                  {deleting
                    ? "Deleting…"
                    : deleteArmed
                      ? "Click again to confirm delete"
                      : "Delete this month's content"}
                </Button>
                {deleteArmed && !deleting && (
                  <Button variant="secondary" onClick={() => setDeleteArmed(false)}>
                    Cancel
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
        {approveNote && <p className="mt-2 text-xs text-muted-foreground">{approveNote}</p>}
        {sendNote && <p className="mt-2 text-xs text-muted-foreground">{sendNote}</p>}
        {deleteNote && <p className="mt-2 text-xs text-muted-foreground">{deleteNote}</p>}
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
        return (
          <BatchSection
            key={cat}
            category={cat}
            posts={group}
            agentId={agentId}
            driveFolderId={agentDriveFolderId}
            onChanged={loadPosts}
          />
        );
      })}
    </div>
  );
}

// Cards here always show everything at once (photo, full copy, and
// Approve/Edit/Flag/Change photo) — matches the old app's always-expanded
// review grid. Per Mike's request (2026-09-18), the header used to collapse
// a card on click, but that offered no value and just made content vanish
// unexpectedly, so PostCard's header is no longer clickable at all now.
// Grouped and icon-labeled by content kind (Posts / Canva Templates /
// Emails / Video Scripts, in that fixed order) per Mike's request
// (2026-09-18) so the four different pieces of content are never visually
// indistinguishable from each other.
function BatchSection({
  category,
  posts,
  agentId,
  driveFolderId,
  onChanged,
}: {
  category: ContentCategory;
  posts: Post[];
  agentId: string;
  driveFolderId: string | null;
  onChanged: () => void;
}) {
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
          <PostCard key={post.id} post={post} agentId={agentId} driveFolderId={driveFolderId} onChanged={onChanged} />
        ))}
      </div>
    </div>
  );
}

// Scans a handful of unused photos — from the agent's Drive folder AND/OR
// their native Media Library — and writes a caption for each, in the
// agent's voice (Drive scanning ported from analyze-photos.js; Library
// scanning added 2026-09-18 per Mike's request that "this tool is awesome
// but it's only scanning google drive. It needs to scan the media library
// too and all photos"). Also given the prominent title he asked for and a
// bigger closed-state call to action, since this was easy to miss as a
// small secondary button before. Selected suggestions become pending posts
// in the same batch via addPhotoPostsToBatch.
const SCAN_PANEL_TITLE = "Let Your Marketing Dude Scan Your Photos And Create Content That Makes You Human";

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
  folderId: string | null;
  month: string;
  batchId: string | null;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [source, setSource] = useState<"drive" | "library">(folderId ? "drive" : "library");
  const [suggestions, setSuggestions] = useState<PhotoScanSuggestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanningMore, setScanningMore] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  // Per-suggestion caption overrides from the inline Edit control below —
  // keyed by fileId, only set once the user actually edits one. Added
  // 2026-09-18 per Mike: "need ability to add edits to these types of posts
  // too... Use the same UI as others." A suggestion isn't a real post yet
  // (no id in generated_posts until it's added to the batch), so there's
  // nothing to save an edit *to* until then — this just holds the edited
  // text client-side and addSelected() uses it instead of the original
  // suggestedPost when present.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);

  function switchSource(next: "drive" | "library") {
    setSource(next);
    setSuggestions(null);
    setSelected(new Set());
    setEdits({});
    setEditingId(null);
    setError(null);
  }

  async function scan(more = false) {
    if (more) setScanningMore(true);
    else setScanning(true);
    setError(null);
    try {
      // On "scan more," exclude every fileId already shown so far (not just
      // the current list — skipped/removed ones stay excluded too) so the
      // next batch is genuinely new photos, not a repeat of the same 5.
      const excludeFileIds = more ? (suggestions ?? []).map((s) => s.fileId) : [];
      const res =
        source === "drive"
          ? await scanAgentDrivePhotos({
              data: { agentId, folderId: folderId as string, maxPhotos: 5, excludeFileIds },
            })
          : await scanAgentLibraryPhotos({ data: { agentId, maxPhotos: 5, excludeFileIds } });
      setSuggestions((cur) => (more && cur ? [...cur, ...res.suggestions] : res.suggestions));
      setSelected((cur) => {
        const next = more ? new Set(cur) : new Set<string>();
        res.suggestions.forEach((s) => next.add(s.fileId));
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
      setScanningMore(false);
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

  // "Flag / skip" on a suggestion — matches the same button Mike asked to
  // reuse from PostCard, but there's no real post row yet to attach
  // feedback_history to, so this just drops it from the list instead of
  // pretending to record feedback somewhere. If they want it gone, gone is
  // the honest behavior.
  function skip(id: string) {
    setSuggestions((cur) => (cur ? cur.filter((s) => s.fileId !== id) : cur));
    setSelected((cur) => {
      const next = new Set(cur);
      next.delete(id);
      return next;
    });
    setEdits((cur) => {
      if (!(id in cur)) return cur;
      const { [id]: _drop, ...rest } = cur;
      return rest;
    });
    if (editingId === id) setEditingId(null);
  }

  async function addSelected() {
    if (!suggestions) return;
    const items = suggestions
      .filter((s) => selected.has(s.fileId))
      .map((s) => ({
        title: s.description,
        content: edits[s.fileId] ?? s.suggestedPost,
        source: s.source,
        sourceId: s.fileId,
        thumbnailUrl: s.thumbnailUrl,
      }));
    if (!items.length) return;
    setAdding(true);
    setError(null);
    try {
      await addPhotoPostsToBatch({ data: { agentId, month, batchId: batchId ?? undefined, items } });
      setSuggestions(null);
      setSelected(new Set());
      setEdits({});
      setEditingId(null);
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
      <button
        onClick={onOpen}
        className="w-full rounded-2xl border border-primary/30 bg-primary/5 px-5 py-4 text-left transition-colors hover:bg-primary/10"
      >
        <p className="font-display text-base font-semibold">{SCAN_PANEL_TITLE}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Pulls unused photos from Drive and your Media Library, writes a caption in their voice for
          each, and lets you pick the ones worth turning into posts. Click to get started →
        </p>
      </button>
    );
  }

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <h4 className="font-display text-base font-semibold">{SCAN_PANEL_TITLE}</h4>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Scans a handful of unused photos and writes a caption for each, in their voice. Pick the
        ones worth turning into posts.
      </p>

      <div className="mt-3 flex flex-wrap gap-2 border-b border-border pb-3">
        <button
          onClick={() => switchSource("drive")}
          disabled={!folderId}
          title={folderId ? undefined : "No Google Drive folder set for this agent yet"}
          className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            source === "drive" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
          }`}
        >
          Google Drive
        </button>
        <button
          onClick={() => switchSource("library")}
          className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
            source === "library" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
          }`}
        >
          Media Library
        </button>
      </div>

      {!suggestions && (
        <div className="mt-3">
          <Button onClick={() => scan(false)} disabled={scanning}>
            {scanning ? "Scanning…" : "Scan photos"}
          </Button>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

      {suggestions && suggestions.length === 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          No unused photos found in {source === "drive" ? "this Drive folder" : "the Media Library"}.
        </p>
      )}

      {suggestions && suggestions.length > 0 && (
        <div className="mt-3 space-y-3">
          {suggestions.map((s) => (
            <div key={s.fileId} className="flex gap-3 rounded-2xl border border-border bg-glass p-3 text-sm">
              <input
                type="checkbox"
                checked={selected.has(s.fileId)}
                onChange={() => toggle(s.fileId)}
                className="mt-1 shrink-0"
              />
              <img
                src={s.thumbnailUrl}
                alt={s.description}
                className="h-16 w-16 shrink-0 rounded-xl object-cover"
              />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">{s.description}</p>
                {editingId === s.fileId ? (
                  <textarea
                    value={edits[s.fileId] ?? s.suggestedPost}
                    onChange={(e) => setEdits((cur) => ({ ...cur, [s.fileId]: e.target.value }))}
                    className="mt-1 min-h-[90px] w-full rounded-xl bg-muted px-3 py-2 text-sm leading-relaxed outline-none ring-ring transition focus:ring-2"
                  />
                ) : (
                  <p className="mt-1 whitespace-pre-wrap">{edits[s.fileId] ?? s.suggestedPost}</p>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  {editingId === s.fileId ? (
                    <Button variant="secondary" onClick={() => setEditingId(null)}>
                      Done editing
                    </Button>
                  ) : (
                    <Button variant="secondary" onClick={() => setEditingId(s.fileId)}>
                      Edit
                    </Button>
                  )}
                  <Button variant="danger" onClick={() => skip(s.fileId)}>
                    Flag / skip
                  </Button>
                </div>
              </div>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button onClick={addSelected} disabled={adding || selected.size === 0}>
              {adding ? "Adding…" : `Add ${selected.size} selected`}
            </Button>
            <Button variant="secondary" onClick={() => scan(true)} disabled={scanningMore}>
              {scanningMore ? "Scanning…" : "Want to scan more? Click here"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
```