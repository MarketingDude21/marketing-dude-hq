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
  addEmailPhotoFromLibrary,
  addEmailPhotoFromDrive,
  addEmailPhotoFromUnsplash,
  updateEmailPhotoInstructions,
  removeEmailPhoto,
  rewritePostContent,
  listMarketingMedia,
  createMediaUploadUrl,
  finalizeMediaUpload,
  setMediaTags,
  markMediaUsed,
  restoreMediaToAvailable,
  deleteMarketingMedia,
  getMediaUploadLink,
  regenerateMediaUploadLink,
  listAgentDriveMedia,
  markDriveFileUsed,
  restoreDriveFileToActive,
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
  archiveMonthContent,
  listArchivedBatchesForMonth,
  restoreArchivedBatch,
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
  type EmailPhoto,
  type ArchivedBatchSummary,
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

type AgentOption = { id: string; name: string; email: string | null };

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

// A textarea that grows to fit its content instead of staying pinned to a
// small fixed height — added 2026-09-21 per Mike's bug report: "when you
// click edit an email the whole edit screen shrinks." Root cause: the plain
// <textarea> used everywhere content gets edited had only a min-height, so
// a genuinely long piece of content (an email body is often 200+ words)
// rendered as a small scrollable box the moment you clicked Edit, instead of
// showing the same amount of text at once that the read-only view (an
// uncapped <p>) already did — it wasn't actually losing anything, it just
// LOOKED like the card had shrunk. This measures the textarea's own
// scrollHeight on mount and on every keystroke and sets its CSS height to
// match, so the edit view is always at least as tall as its content, same
// as the read view. Used everywhere a piece of already-generated content
// gets edited (a post/email/video card, a photo-scan suggestion) — not the
// small "Publishing instructions" boxes on an email photo, which are meant
// to hold a short note and are fine staying a fixed, manually resizable size.
function AutoResizeTextarea({
  value,
  onChange,
  className,
  placeholder,
  minHeightPx = 140,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  placeholder?: string;
  minHeightPx?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(minHeightPx, el.scrollHeight)}px`;
  }, [value, minHeightPx]);

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={className}
      style={{ overflow: "hidden", resize: "vertical" }}
    />
  );
}

// Renders a calendar brief's image/Canva instructions as an actual bulleted
// list instead of one run-on paragraph — added 2026-09-20 per Mike's
// screenshot feedback ("too long," "very confusing," asked for bullet
// points). New content comes from marketing.ts's parsePostDoc/toBullets
// already newline-joined and cleaned; older, already-generated posts made
// before this fix still have their text semicolon-joined, so this falls
// back to splitting on "; " too, so existing pending content reads better
// immediately rather than only after a fresh Generate. Long briefs (more
// than 4 lines — the common case for a multi-slide carousel/video brief)
// show only the first 3 up front with the rest tucked behind a native
// <details> disclosure, so the card itself stays short without losing any
// detail — this is what actually answers "this is too long."
function SuggestionBullets({ text }: { text: string }) {
  const lines = (text.includes("\n") ? text.split("\n") : text.split("; ")).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  if (lines.length <= 4) {
    return (
      <ul className="list-disc space-y-0.5 pl-4">
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    );
  }
  const shown = lines.slice(0, 3);
  const rest = lines.slice(3);
  return (
    <>
      <ul className="list-disc space-y-0.5 pl-4">
        {shown.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
      <details className="mt-1">
        <summary className="cursor-pointer text-[11px] font-semibold text-primary">+{rest.length} more</summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          {rest.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </details>
    </>
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
          setAgents(
            list.map((ag) => ({
              id: ag.id,
              name: ag.full_name ?? ag.email ?? "Unnamed agent",
              email: ag.email ?? null,
            })),
          );
        } else if (a.role === "agent") {
          setSelected({ id: a.agentId, name: a.agentName, email: null });
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
            {agents.map((a) => {
              // Flags a duplicate display name — added 2026-09-18 while
              // investigating Mike's report that Meghan Simons' Drive folder
              // "still" doesn't appear client-side even after being set here.
              // The code path that reads/writes drive_folder_id is confirmed
              // correct (see DriveTab) — every save/read targets the exact
              // agentId this button carries, so the leading theory left is
              // that two separate agent rows share the same display name and
              // admin is unknowingly saving the folder onto the wrong one.
              // Two identical-looking buttons here would make that mistake
              // invisible, so each one now also shows its email — and any
              // name shared by more than one row gets a visible flag.
              const isDuplicateName = agents.filter((o) => o.name === a.name).length > 1;
              return (
                <button
                  key={a.id}
                  onClick={() => setSelected(a)}
                  className="rounded-2xl border border-border bg-glass px-4 py-3 text-left text-sm font-medium transition-colors hover:bg-secondary"
                >
                  <span className="flex items-center gap-1.5">
                    {a.name}
                    {isDuplicateName && (
                      <span
                        title="Another agent also has this exact name — double check the email below before connecting anything to this one."
                        className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400"
                      >
                        ⚠ duplicate name
                      </span>
                    )}
                  </span>
                  {a.email && <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{a.email}</span>}
                </button>
              );
            })}
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
      <Workspace agentId={selected.id} agentEmail={selected.email} isAdmin={access.role === "admin"} />
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

function Workspace({ agentId, agentEmail, isAdmin }: { agentId: string; agentEmail: string | null; isAdmin: boolean }) {
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
        {tab === "media" && <MediaTab agentId={agentId} isAdmin={isAdmin} />}
        {tab === "drive" && <DriveTab agentId={agentId} agentEmail={agentEmail} isAdmin={isAdmin} />}
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
            Nothing created one-off yet — use "+ New content" above. Content from a month's calendar (or its photo scan)
            lives on the "Generate My Monthly Content Calendar" tab instead, not here.
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

// Multi-photo attachments for EMAILS — added 2026-09-21 per Mike: "Emails
// should have the ability to include up to 3 photos from any combination.
// Those images would come with publishing instructions." Posts keep the
// single-photo picker in PostCard just below (openPicker/pickMedia/etc.),
// since a post only ever needs one photo — this is a separate flow just for
// emails, which can hold up to three at once, from any mix of sources, each
// with its own note for whoever actually publishes the email. Every add/
// edit/remove below calls one of the addEmailPhotoFrom.../
// updateEmailPhotoInstructions/removeEmailPhoto functions in marketing.ts,
// which re-save the post's metadata.email_photos array server-side.
//
// An email generated before this feature existed only has the old
// single-photo fields (media_url/drive_thumbnail_url/unsplash_photographer)
// — those still display read-only below as a "legacy" photo until removed,
// rather than being silently dropped or auto-migrated into the new array.
function EmailPhotosPanel({
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
  // Kept in sync with MAX_EMAIL_PHOTOS in marketing.ts.
  const MAX_PHOTOS = 3;
  const photos = post.metadata?.email_photos ?? [];
  const legacyUrl = photos.length === 0 ? post.metadata?.media_url || post.metadata?.drive_thumbnail_url || null : null;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTab, setPickerTab] = useState<"library" | "drive" | "unsplash">("library");
  const [mediaOptions, setMediaOptions] = useState<MediaRow[] | null>(null);
  const [driveOptions, setDriveOptions] = useState<DriveFile[] | null>(null);
  const [driveOptionsError, setDriveOptionsError] = useState<string | null>(null);
  const [unsplashQuery, setUnsplashQuery] = useState(post.title || "lifestyle real estate");
  const [unsplashResults, setUnsplashResults] = useState<UnsplashResult[] | null>(null);
  const [unsplashLoading, setUnsplashLoading] = useState(false);
  const [unsplashError, setUnsplashError] = useState<string | null>(null);

  async function openPicker() {
    setPickerOpen(true);
    setPickerTab("library");
    setError(null);
    if (!mediaOptions) {
      try {
        setMediaOptions(await listMarketingMedia({ data: { agentId, status: "available" } }));
      } catch {
        setMediaOptions([]);
      }
    }
  }

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
    if (!unsplashResults) runUnsplashSearch(unsplashQuery);
  }

  async function addFromLibrary(mediaId: string) {
    setBusy(true);
    setError(null);
    try {
      await addEmailPhotoFromLibrary({ data: { agentId, postId: post.id, mediaId } });
      setPickerOpen(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function addFromDrive(file: DriveFile) {
    setBusy(true);
    setError(null);
    try {
      await addEmailPhotoFromDrive({
        data: { agentId, postId: post.id, driveFileId: file.id, thumbnailUrl: file.thumbnailUrl },
      });
      setPickerOpen(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function addFromUnsplash(r: UnsplashResult) {
    setBusy(true);
    setError(null);
    try {
      await addEmailPhotoFromUnsplash({
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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function removePhoto(photoId: string) {
    setBusy(true);
    setError(null);
    try {
      await removeEmailPhoto({ data: { agentId, postId: post.id, photoId } });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveInstructions(photoId: string) {
    const value = drafts[photoId];
    if (value === undefined) return;
    setBusy(true);
    setError(null);
    try {
      await updateEmailPhotoInstructions({
        data: { agentId, postId: post.id, photoId, publishingInstructions: value },
      });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeLegacyPhoto() {
    setBusy(true);
    setError(null);
    try {
      await setPostMedia({ data: { agentId, postId: post.id, mediaId: null } });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-3">
      {legacyUrl && (
        <div className="mb-3 rounded-2xl border border-border bg-muted p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Photo (added before multi-photo support)
          </p>
          <div className="overflow-hidden rounded-xl border border-border">
            {post.metadata?.media_type === "video" ? (
              <video src={legacyUrl} controls className="max-h-56 w-full object-contain" />
            ) : (
              <img src={legacyUrl} alt="" className="max-h-56 w-full object-contain" />
            )}
          </div>
          {post.metadata?.unsplash_photographer && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Photo by {post.metadata.unsplash_photographer} on Unsplash
            </p>
          )}
          <button
            onClick={removeLegacyPhoto}
            disabled={busy}
            className="mt-2 text-xs font-semibold text-destructive hover:underline disabled:opacity-50"
          >
            Remove — I'll add new photos below instead
          </button>
        </div>
      )}

      {photos.length > 0 && (
        <div className="mb-3 grid gap-3 sm:grid-cols-3">
          {photos.map((p) => (
            <div key={p.id} className="rounded-2xl border border-border bg-muted p-2">
              <div className="overflow-hidden rounded-xl border border-border">
                {p.mediaType === "video" ? (
                  <video src={p.url} controls className="aspect-square w-full object-cover" />
                ) : (
                  <img src={p.url} alt="" className="aspect-square w-full object-cover" />
                )}
              </div>
              <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                {p.source === "library" ? "Media Library" : p.source === "drive" ? "Google Drive" : "Stock photo"}
              </p>
              {p.source === "unsplash" && p.unsplashPhotographer && (
                <p className="text-[10px] text-muted-foreground">
                  Photo by{" "}
                  <a
                    href={p.unsplashCreditUrl ?? "https://unsplash.com"}
                    target="_blank"
                    rel="noreferrer"
                    className="underline hover:text-foreground"
                  >
                    {p.unsplashPhotographer}
                  </a>{" "}
                  on Unsplash
                </p>
              )}
              <textarea
                value={drafts[p.id] ?? p.publishingInstructions}
                onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                onBlur={() => saveInstructions(p.id)}
                placeholder="Publishing instructions (optional) — e.g. use as header image"
                className="mt-2 min-h-[50px] w-full rounded-lg border border-border bg-glass px-2 py-1.5 text-xs outline-none"
                disabled={busy}
              />
              <div className="mt-1 flex items-center justify-between gap-2">
                {p.url && (
                  <button
                    onClick={() => downloadRemoteFile(p.url!, p.url!.split("/").pop() || `${p.id}`)}
                    className="text-[11px] font-semibold text-muted-foreground hover:text-foreground hover:underline"
                  >
                    ⬇ Download
                  </button>
                )}
                <button
                  onClick={() => removePhoto(p.id)}
                  disabled={busy}
                  className="text-[11px] font-semibold text-destructive hover:underline disabled:opacity-50"
                >
                  Remove photo
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {error && <p className="mb-2 text-xs text-destructive">{error}</p>}

      {photos.length < MAX_PHOTOS && (
        <Button variant="secondary" onClick={openPicker} disabled={busy}>
          {photos.length === 0 && !legacyUrl ? "Add photo" : "Add another photo"} ({photos.length}/{MAX_PHOTOS})
        </Button>
      )}

      {pickerOpen && (
        <div className="mt-3 rounded-2xl border border-border bg-background/40 p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold">Add a photo to this email</p>
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
                pickerTab === "library"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              Media Library
            </button>
            {driveFolderId && (
              <button
                onClick={openDriveTab}
                className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                  pickerTab === "drive"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                }`}
              >
                Google Drive
              </button>
            )}
            <button
              onClick={openUnsplashTab}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                pickerTab === "unsplash"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              Stock Photos
            </button>
          </div>

          {pickerTab === "library" && (
            <div className="mt-3">
              {mediaOptions === null && <p className="text-xs text-muted-foreground">Loading…</p>}
              {mediaOptions !== null && mediaOptions.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No available photos or videos uploaded for this agent yet — add some on the Media tab.
                </p>
              )}
              {mediaOptions !== null && mediaOptions.length > 0 && (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {mediaOptions.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => addFromLibrary(m.id)}
                      disabled={busy}
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
              {!driveOptionsError && driveOptions === null && <p className="text-xs text-muted-foreground">Loading…</p>}
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
                      onClick={() => addFromDrive(f)}
                      disabled={busy}
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
                <Button variant="secondary" onClick={() => runUnsplashSearch(unsplashQuery)} disabled={unsplashLoading}>
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
                      onClick={() => addFromUnsplash(r)}
                      disabled={busy}
                      title={`Photo by ${r.photographerName} on Unsplash`}
                      className="overflow-hidden rounded-xl border border-border transition-colors hover:border-primary disabled:opacity-50"
                    >
                      <img src={r.thumbUrl} alt="" className="aspect-square w-full object-cover" />
                    </button>
                  ))}
                </div>
              )}
              <p className="mt-2 text-[11px] text-muted-foreground">
                Photos via Unsplash — credit is added automatically.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
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
  // Post's own single-photo picker — Media Library + Google Drive (if
  // enabled) only. Stock Photos (Unsplash) was dropped from here 2026-09-21
  // per Mike ("No need for stock photos here. But they do need ability to
  // choose for google drive if enabled.") — posts always have their own
  // Drive/library photos to draw from, so there was never really a need for
  // stock photos on a post the way there was for an email. Emails now have
  // their own separate multi-photo flow — see EmailPhotosPanel below, which
  // still offers Stock Photos since that's genuinely useful there.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTab, setPickerTab] = useState<"library" | "drive">("library");
  const [mediaOptions, setMediaOptions] = useState<MediaRow[] | null>(null);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [driveOptions, setDriveOptions] = useState<DriveFile[] | null>(null);
  const [driveOptionsError, setDriveOptionsError] = useState<string | null>(null);
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

  const typeLabel = post.content_type === "email" ? "Email" : post.content_type === "video" ? "Video script" : "Post";
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
        {/* Single-photo display — posts only now. Emails moved to their
              own multi-photo flow (EmailPhotosPanel, just below) 2026-09-21
              per Mike's request for up to 3 photos per email, each with its
              own publishing instructions — a single photoUrl can no longer
              represent an email's attached photos. */}
        {post.content_type === "post" && photoUrl && (
          <div className="mb-3 overflow-hidden rounded-2xl border border-border bg-muted">
            {post.metadata?.media_type === "video" ? (
              <video src={photoUrl} controls className="max-h-64 w-full object-contain" />
            ) : (
              <img src={photoUrl} alt="" className="max-h-64 w-full object-contain" />
            )}
            <button
              onClick={() => downloadRemoteFile(photoUrl, photoUrl.split("/").pop() || "photo")}
              className="w-full border-t border-border bg-glass py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              ⬇ Download
            </button>
          </div>
        )}
        {post.content_type === "post" && photoUrl && post.metadata?.unsplash_photographer && (
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
        {post.content_type === "email" && (
          <EmailPhotosPanel post={post} agentId={agentId} driveFolderId={driveFolderId} onChanged={onChanged} />
        )}
        {post.content_type === "post" && post.metadata?.image_suggestion && (
          <div className="mb-2 text-xs text-muted-foreground">
            <p className="mb-1 font-semibold">📸 Image direction from the brief</p>
            <SuggestionBullets text={post.metadata.image_suggestion} />
            {!photoUrl && (
              <p className="mt-1">
                No photo on file yet to attach automatically — add one on the Media tab or pick one below.
              </p>
            )}
          </div>
        )}
        {editing ? (
          <AutoResizeTextarea
            value={draft}
            onChange={setDraft}
            minHeightPx={140}
            className="w-full rounded-2xl bg-muted px-4 py-3 text-sm leading-relaxed outline-none ring-ring transition focus:ring-2"
          />
        ) : (
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{post.content}</p>
        )}

        {post.metadata?.canva_link && (
          <>
            <a
              href={post.metadata.canva_link}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block text-xs font-semibold text-primary hover:underline"
            >
              Open Canva template →
            </a>
            {/* Instructions for what to actually put in the template —
                  added 2026-09-18 per Mike: "the Canva images need the
                  instructions posted beneath it, just like they are in the
                  posts." A regular post's own image direction (above) was
                  always being captured from its "Post Image/Video
                  Suggestions" section; a Canva item's "Canva Template
                  Direction" section had the equivalent instructions but that
                  section's actual content was never being read out of the
                  calendar doc at all — only used to know where other
                  sections ended — so nothing ever showed here before this
                  fix. See parsePostDoc's canvaDirection in marketing.ts. */}
            {post.metadata?.canva_instructions && (
              <div className="mt-2 text-xs text-muted-foreground">
                <p className="mb-1 font-semibold">🎨 Instructions for this template</p>
                <SuggestionBullets text={post.metadata.canva_instructions} />
              </div>
            )}
          </>
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

        {post.content_type === "post" && pickerOpen && (
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
                  pickerTab === "library"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                }`}
              >
                Media Library
              </button>
              {driveFolderId && (
                <button
                  onClick={openDriveTab}
                  className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                    pickerTab === "drive"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Google Drive
                </button>
              )}
            </div>

            {pickerTab === "library" && (
              <div className="mt-3">
                {mediaOptions === null && <p className="text-xs text-muted-foreground">Loading…</p>}
                {mediaOptions !== null && mediaOptions.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No available photos or videos uploaded for this agent yet — add some on the Media tab, then come
                    back here.
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

// Added 2026-09-21 per Mike: "photos in all libraries should be
// downloadable." A plain <a href> works for a same-origin file (Media
// Library items, on Supabase Storage) but the browser's `download`
// attribute is unreliable cross-origin, so this fetches the file as a blob
// and saves it directly — the same reliable pattern regardless of source.
// Falls back to just opening the URL in a new tab if the fetch itself fails
// (e.g. a host that blocks cross-origin reads even though it serves the
// file fine to a normal link click — Google Drive's own uc?export=download
// endpoint, for one, doesn't allow that kind of fetch from a browser, but it
// already forces a real download on a plain click, so the fallback covers
// it correctly either way).
async function downloadRemoteFile(url: string, filename: string) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
  } catch {
    window.open(url, "_blank", "noreferrer");
  }
}

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

// Admin-only card on the Media tab that surfaces the public upload link for
// this agent — added 2026-09-20 per Mike: "I want to create a simple link I
// can send them that will open up directly into the Media folder no
// differently than how we share a google drive link... upload photos to
// that media library without logging in." Getting the link lazily creates a
// token the first time (getMediaUploadLink), so nothing changes for an
// agent whose link has never been requested. Regenerating issues a brand
// new token and immediately breaks whatever link was shared before — the
// equivalent of un-sharing a Drive folder.
function PublicUploadLinkCard({ agentId }: { agentId: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setToken(null);
    setError(null);
    getMediaUploadLink({ data: { agentId } })
      .then((r) => setToken(r.token))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [agentId]);

  const link = token && typeof window !== "undefined" ? `${window.location.origin}/media-upload/${token}` : null;

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy automatically — select and copy the link text instead.");
    }
  }

  async function regenerate() {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const r = await regenerateMediaUploadLink({ data: { agentId } });
      setToken(r.token);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h3 className="font-display text-sm font-semibold">Public upload link</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Anyone with this link can open a simple upload page for this agent and add photos or videos straight into this
        Media library — no login needed, same idea as sharing a Google Drive upload link. They can only upload; they
        can't see, download, or delete anything already here.
      </p>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      {link && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            readOnly
            value={link}
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 flex-1 rounded-full border border-border bg-muted px-4 py-2 text-xs text-foreground"
          />
          <Button variant="secondary" onClick={copyLink}>
            {copied ? "Copied ✓" : "Copy link"}
          </Button>
          <Button variant="secondary" onClick={regenerate} disabled={busy}>
            {busy ? "Regenerating…" : "Regenerate link"}
          </Button>
        </div>
      )}
      {!link && !error && <p className="mt-2 text-xs text-muted-foreground">Loading…</p>}
    </Card>
  );
}

function MediaTab({ agentId, isAdmin }: { agentId: string; isAdmin: boolean }) {
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

  // Added 2026-09-21 per Mike: "photos and videos should be able to be moved
  // back to active folder form used folder." Mirrors markUsed above.
  async function restoreToAvailable(id: string) {
    setBusyId(id);
    try {
      await restoreMediaToAvailable({ data: { agentId, mediaId: id } });
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

      {isAdmin && <PublicUploadLinkCard agentId={agentId} />}

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
              <div className="flex flex-wrap gap-1 p-2">
                {status === "available" ? (
                  <button
                    onClick={() => markUsed(m.id)}
                    disabled={busyId === m.id}
                    className="flex-1 rounded-full border border-border px-2 py-1 text-[11px] font-semibold transition-colors hover:bg-secondary disabled:opacity-50"
                  >
                    Mark used
                  </button>
                ) : (
                  <button
                    onClick={() => restoreToAvailable(m.id)}
                    disabled={busyId === m.id}
                    className="flex-1 rounded-full border border-border px-2 py-1 text-[11px] font-semibold transition-colors hover:bg-secondary disabled:opacity-50"
                    title={m.used_at ? `Used ${new Date(m.used_at).toLocaleDateString()}` : "Used"}
                  >
                    Move to active
                  </button>
                )}
                {m.url && (
                  <button
                    onClick={() => downloadRemoteFile(m.url!, m.url!.split("/").pop() || `${m.id}`)}
                    className="rounded-full border border-border px-2 py-1 text-[11px] font-semibold transition-colors hover:bg-secondary"
                  >
                    ⬇ Download
                  </button>
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
function DriveTab({ agentId, agentEmail, isAdmin }: { agentId: string; agentEmail: string | null; isAdmin: boolean }) {
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
  // Added 2026-09-21 per Mike: "google drive folder Used needs to show" —
  // mirrors MediaTab's Available/Used toggle exactly, so both photo sources
  // work the same way. See listAgentDriveMedia in marketing.ts for what
  // "used" means here (a real "used" subfolder's contents, plus anything
  // this app itself has marked used — there's no real Drive write access to
  // physically move a file, see the comment there).
  const [status, setStatus] = useState<"available" | "used">("available");
  const [busyId, setBusyId] = useState<string | null>(null);

  function reload() {
    setData(null);
    setError(null);
    listAgentDriveMedia({ data: { agentId, status } })
      .then((d) => setData(d))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }

  useEffect(() => {
    reload();
    setSaveNote(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, status]);

  async function markUsed(fileId: string) {
    setBusyId(fileId);
    try {
      await markDriveFileUsed({ data: { agentId, driveFileId: fileId } });
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function restoreToActive(fileId: string) {
    setBusyId(fileId);
    try {
      await restoreDriveFileToActive({ data: { agentId, driveFileId: fileId } });
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

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
          A live, read-only view of what's actually in their Drive folder right now — mainly useful for agents on our
          video services who still send long-form footage through Drive. This never writes anything back to Drive;
          uploading and marking things used still happens exactly as it does today, over there, untouched.
        </p>
        {/* Cross-check for admin (2026-09-18) — per Mike's report that a
            Drive folder connection "still" isn't reaching the client-facing
            view even after being set here. The save/read code both target
            this exact agentId (confirmed correct), so if this still happens
            after a Save, the most likely explanation is two agent records
            sharing the same display name — admin saving onto one while the
            agent's real login resolves to the other. Showing the email of
            the record actually being edited, right here, lets that be ruled
            in or out at a glance instead of guessing. */}
        {isAdmin && agentEmail && (
          <p className="mt-1 text-xs text-muted-foreground">
            Editing the Drive connection for: <span className="font-semibold">{agentEmail}</span> — double check this is
            the account they actually log in with if the folder still isn't showing up on their side after saving.
          </p>
        )}
        {isAdmin && (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                value={folderInput}
                onChange={(e) => setFolderInput(e.target.value)}
                placeholder={data?.folderId ? `Currently: ${data.folderId}` : "Paste this agent's Drive folder ID"}
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

      {data?.folderId && (
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
      )}

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
            {status === "available"
              ? "Their Drive folder is connected but empty right now."
              : 'Nothing marked used yet — either a real "used" subfolder in their Drive is empty, or nothing\'s been approved with a Drive photo attached yet.'}
          </p>
        </Card>
      )}

      {!error && data !== null && data.files.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {data.files.map((f) => (
            <div key={f.id} className="overflow-hidden rounded-2xl border border-border bg-glass">
              <a href={f.viewUrl} target="_blank" rel="noreferrer">
                <img src={f.thumbnailUrl} alt={f.name} className="aspect-square w-full object-cover" />
              </a>
              <div className="flex items-center justify-between gap-1 px-2 pt-2">
                <span className="truncate text-[11px] text-muted-foreground">{f.name}</span>
                {f.isVideo && (
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Video
                  </span>
                )}
              </div>
              {status === "used" && (
                <p className="px-2 pt-1 text-[11px] text-muted-foreground">
                  {f.usedAt ? `Used ${new Date(f.usedAt).toLocaleDateString()}` : "Used"}
                </p>
              )}
              <div className="flex flex-wrap gap-1 p-2">
                {status === "available" ? (
                  <button
                    onClick={() => markUsed(f.id)}
                    disabled={busyId === f.id}
                    className="flex-1 rounded-full border border-border px-2 py-1 text-[11px] font-semibold transition-colors hover:bg-secondary disabled:opacity-50"
                  >
                    Mark used
                  </button>
                ) : (
                  <button
                    onClick={() => restoreToActive(f.id)}
                    disabled={busyId === f.id}
                    className="flex-1 rounded-full border border-border px-2 py-1 text-[11px] font-semibold transition-colors hover:bg-secondary disabled:opacity-50"
                    title="If this file is inside a real 'used' folder in Drive itself, this only clears our own tracking — it can't move the actual file back in Drive."
                  >
                    Move to active
                  </button>
                )}
                <button
                  onClick={() => downloadRemoteFile(f.downloadUrl, f.name)}
                  className="rounded-full border border-border px-2 py-1 text-[11px] font-semibold transition-colors hover:bg-secondary"
                >
                  ⬇ Download
                </button>
              </div>
            </div>
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
          One shared calendar for every agent. Add a month, then add the posts, emails, and video briefs that belong to
          it — every agent generates their own personalized version of the same briefs from their own login.
        </p>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="font-display text-sm font-semibold">
            {showArchived ? "All months (including archived)" : "Months"}
          </h4>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
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
  // Added 2026-09-20 per Mike's follow-up screenshot: "On this screen for
  // both admin and agent view there should be an archive button that can be
  // clicked and that month can be archived." The archive/restore machinery
  // itself (archiveMonthContent, requireAgentAccess-gated so it works for
  // both admin-acting-as-agent and the agent's own login) already existed on
  // MonthWorkspace's review screen — this just surfaces the same action one
  // level up, right on the month card, so archiving doesn't require opening
  // the month first. Archiving here only clears this agent's *generated
  // content* for that month (same as the button inside the workspace); the
  // month itself stays in this list, ready for a fresh "Generate Now."
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [noteByMonth, setNoteByMonth] = useState<Record<string, string>>({});
  // Simplified 2026-09-20, third same-day pass, after Mike found the second
  // pass (live counts + an inline Generate button on every card) over-built:
  // "let's not think too hard about this. We're trying to accomplish a very
  // simple task." What he actually wants: "you have months. There's a
  // button that says archive. If you press the archive button, it'll go
  // into the archive folder. There should be an archive folder somewhere on
  // this screen that shows the past months that were ran. But... if it's
  // archived, you should just be able to click on create my monthly content
  // and click the button and it'll generate the content." So the card is
  // back down to just a month name + Archive; counts are still fetched in
  // the background (silently) only to decide which section a month sits in,
  // never shown as text. A month is "archived" once this agent has archived
  // batches for it and no active content left — it then moves out of
  // Months and into the Archived section below. Clicking a card in either
  // section opens MonthWorkspace, where "Generate Now" already works and
  // was never gated on there being no existing content — that's the one
  // place Generate lives, and it can be run as many times as needed.
  const [counts, setCounts] = useState<Record<string, number | null>>({});
  const [archivedCounts, setArchivedCounts] = useState<Record<string, number>>({});

  function loadCountsFor(list: CalendarMonth[]) {
    for (const m of list) {
      listMarketingPosts({ data: { agentId, month: m.month } })
        .then((posts) => {
          const n = posts.filter((p) => BATCH_SOURCES.has(p.metadata?.source ?? "")).length;
          setCounts((prev) => ({ ...prev, [m.id]: n }));
        })
        .catch(() => setCounts((prev) => ({ ...prev, [m.id]: null })));
      listArchivedBatchesForMonth({ data: { agentId, month: m.month } })
        .then((batches) =>
          setArchivedCounts((prev) => ({
            ...prev,
            [m.id]: batches.reduce((sum, b) => sum + b.count, 0),
          })),
        )
        .catch(() => {});
    }
  }

  useEffect(() => {
    setMonths(null);
    setError(null);
    setActiveMonth(null);
    setCounts({});
    setArchivedCounts({});
    listCalendarMonths()
      .then((m) => {
        setMonths(m);
        loadCountsFor(m);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  function setNote(monthId: string, text: string) {
    setNoteByMonth((prev) => ({ ...prev, [monthId]: text }));
  }

  async function archiveFromList(m: CalendarMonth) {
    setArchivingId(m.id);
    setNote(m.id, "");
    try {
      const res = await archiveMonthContent({ data: { agentId, month: m.month } });
      setNote(
        m.id,
        res.archived > 0
          ? `Archived ${res.archived} piece${res.archived === 1 ? "" : "s"} — moved to Archived below.`
          : `Nothing to archive for ${m.month} yet.`,
      );
      loadCountsFor([m]);
    } catch (e) {
      setNote(m.id, e instanceof Error ? e.message : String(e));
    } finally {
      setArchivingId(null);
    }
  }

  if (activeMonth) {
    return (
      <MonthWorkspace agentId={agentId} isAdmin={isAdmin} month={activeMonth} onBack={() => setActiveMonth(null)} />
    );
  }

  const activeMonths: CalendarMonth[] = [];
  const archivedMonths: CalendarMonth[] = [];
  if (months) {
    for (const m of months) {
      const isArchived = (archivedCounts[m.id] ?? 0) > 0 && (counts[m.id] ?? 0) === 0;
      (isArchived ? archivedMonths : activeMonths).push(m);
    }
  }

  function renderMonthCard(m: CalendarMonth, archived: boolean) {
    const busy = archivingId === m.id;
    return (
      <div
        key={m.id}
        className="flex flex-col gap-2 rounded-2xl border border-border bg-glass px-4 py-3 transition-colors hover:bg-secondary"
      >
        <button onClick={() => setActiveMonth(m)} className="min-w-0 text-left text-sm font-semibold">
          {m.month}
        </button>
        {archived ? (
          <p className="text-[11px] text-muted-foreground">Archived — click the month to create fresh content.</p>
        ) : (
          <button
            onClick={() => archiveFromList(m)}
            disabled={busy}
            className="self-start shrink-0 rounded-full border border-border px-2.5 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-background disabled:opacity-50"
            title={`Archive this agent's generated content for ${m.month}`}
          >
            {busy ? "Archiving…" : "Archive"}
          </button>
        )}
        {noteByMonth[m.id] && <p className="text-[11px] text-muted-foreground">{noteByMonth[m.id]}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <h3 className="font-display text-sm font-semibold">Create My Monthly Content</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Pick a month below to generate this month's posts, emails, and video scripts in your own voice, then review
          and approve them. Archive a month to clear it out — it moves to Archived below, and clicking back into it lets
          you generate a fresh batch.
        </p>
      </Card>

      <Card>
        <h4 className="font-display text-sm font-semibold">Months</h4>

        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
        {months === null && !error && <p className="mt-3 text-sm text-muted-foreground">Loading…</p>}
        {months !== null && months.length === 0 && (
          <p className="mt-3 text-sm text-muted-foreground">No months set up yet — ask your team to add one.</p>
        )}
        {months !== null && activeMonths.length > 0 && (
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {activeMonths.map((m) => renderMonthCard(m, false))}
          </div>
        )}
        {months !== null && months.length > 0 && activeMonths.length === 0 && (
          <p className="mt-3 text-sm text-muted-foreground">
            Every month is archived — see Archived below, or click one there to start fresh.
          </p>
        )}
      </Card>

      {archivedMonths.length > 0 && (
        <Card>
          <h4 className="font-display text-sm font-semibold">Archived</h4>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Past months that were archived. Click one to generate fresh content — it moves back up to Months once it has
            content again.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {archivedMonths.map((m) => renderMonthCard(m, true))}
          </div>
        </Card>
      )}
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
    children.push(
      new Paragraph({
        text: DOCX_SECTION_TITLE[cat],
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 300, after: 150 },
      }),
    );

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

      // Up to 3 photos per email, each with its own publishing instructions
      // — added 2026-09-21 per Mike's multi-photo request. Falls back to the
      // old single-credit-line format for an email generated before this
      // feature existed (metadata.email_photos absent, but the legacy
      // unsplash_photographer field still set), so re-exporting an
      // already-approved older email doesn't lose its one credit line.
      if (cat === "email") {
        const emailPhotos = p.metadata?.email_photos ?? [];
        if (emailPhotos.length > 0) {
          children.push(
            new Paragraph({
              spacing: { before: 100 },
              children: [new TextRun({ text: "EMAIL PHOTOS:", bold: true })],
            }),
          );
          emailPhotos.forEach((photo, idx) => {
            const runs: (TextRun | ExternalHyperlink)[] = [
              new TextRun({ text: `Photo ${idx + 1}:  `, bold: true }),
              new ExternalHyperlink({
                link: photo.url,
                children: [new TextRun({ text: "⬇ View/Download", style: "Hyperlink" })],
              }),
            ];
            if (photo.source === "drive" && photo.driveFileId) {
              runs.push(new TextRun({ text: "   " }));
              runs.push(
                new ExternalHyperlink({
                  link: `https://drive.google.com/file/d/${photo.driveFileId}/view`,
                  children: [new TextRun({ text: "📁 View in Drive", style: "Hyperlink" })],
                }),
              );
            }
            if (photo.source === "unsplash" && photo.unsplashPhotographer) {
              runs.push(new TextRun({ text: `   (Photo by ${photo.unsplashPhotographer} on Unsplash)` }));
            }
            children.push(new Paragraph({ spacing: { before: 60 }, children: runs }));
            if (photo.publishingInstructions.trim()) {
              children.push(
                new Paragraph({
                  spacing: { before: 20 },
                  children: [
                    new TextRun({
                      text: `   Instructions: ${photo.publishingInstructions.trim()}`,
                      italics: true,
                    }),
                  ],
                }),
              );
            }
          });
        } else if (p.metadata?.unsplash_photographer) {
          children.push(
            new Paragraph({
              spacing: { before: 100 },
              children: [new TextRun({ text: "EMAIL PHOTOS:", bold: true })],
            }),
          );
          children.push(new Paragraph({ text: `Photo 1: ${p.metadata.unsplash_photographer}` }));
        }
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
  // Defaults open (2026-09-18, per Mike: "have it already open... I want that
  // feature. It should already be open... people can see that you can scan
  // right away.") — previously required a click to expand before an agent
  // could tell the scan feature even existed.
  const [photosOpen, setPhotosOpen] = useState(true);
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
  // Added 2026-09-20 per Mike: "the admin and or the user needs the ability
  // to archive the month's monthly content... I can't retest without the
  // ability to archive the monthly content." Unlike Delete above, this is
  // reversible (a flag, not a delete) and open to the agent themselves too,
  // so no double-click "are you sure" arming is needed — restoring a batch
  // below undoes it just as easily.
  const [archiving, setArchiving] = useState(false);
  const [archiveNote, setArchiveNote] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [archivedBatches, setArchivedBatches] = useState<ArchivedBatchSummary[] | null>(null);
  const [archivedError, setArchivedError] = useState<string | null>(null);
  const [restoringBatchId, setRestoringBatchId] = useState<string | null>(null);

  async function archiveContent() {
    if (!batchPosts.length) return;
    setArchiving(true);
    setArchiveNote(null);
    try {
      const res = await archiveMonthContent({ data: { agentId, month: folder.month } });
      setArchiveNote(
        res.archived > 0
          ? `Archived ${res.archived} piece${res.archived === 1 ? "" : "s"} of content for ${folder.month} — the review screen is clear for a fresh "Generate Now." Nothing was deleted; open "Archived content" below to restore it.`
          : "Nothing to archive — this month has no generated content for this agent yet.",
      );
      setLastBatchId(null);
      loadPosts();
      if (showArchived) loadArchivedBatches();
    } catch (e) {
      setArchiveNote(e instanceof Error ? e.message : String(e));
    } finally {
      setArchiving(false);
    }
  }

  function loadArchivedBatches() {
    setArchivedError(null);
    listArchivedBatchesForMonth({ data: { agentId, month: folder.month } })
      .then((b) => setArchivedBatches(b))
      .catch((e) => setArchivedError(e instanceof Error ? e.message : String(e)));
  }

  function toggleArchivedView() {
    const next = !showArchived;
    setShowArchived(next);
    if (next) {
      setArchivedBatches(null);
      loadArchivedBatches();
    }
  }

  async function restoreBatch(batchId: string) {
    setRestoringBatchId(batchId);
    setArchivedError(null);
    try {
      await restoreArchivedBatch({ data: { agentId, batchId } });
      loadArchivedBatches();
      loadPosts();
    } catch (e) {
      setArchivedError(e instanceof Error ? e.message : String(e));
    } finally {
      setRestoringBatchId(null);
    }
  }

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
  // Added 2026-09-18 per Mike: "once client/user approves all button should
  // change to 'Approved! Download Here' — just in case they want to
  // redownload it." Previously the button always read "Approve All &
  // Download" no matter what, even after everything was already approved —
  // so there was no way for the agent (this screen is shared between admin
  // and an agent's own login) to tell at a glance that they were done, or
  // that clicking again would just redownload rather than re-do anything.
  // The click handler itself needs no change: re-approving an already
  // approved batch is a harmless no-op, and the download always regenerates
  // from the current batchPosts either way, so clicking this again is a
  // safe, genuine "redownload" exactly as asked.
  const allApproved = batchPosts.length > 0 && batchPosts.every((p) => p.status === "approved");

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
          {/* Made bigger/more of a title, plus a call to action — per Mike
              (2026-09-18): "make that font a little bit larger... more of a
              title... add a call to action... check out this month's
              content, dude!" */}
          <h4 className="font-display text-xl font-bold">
            This month's generated content — check out this month's content, dude!
          </h4>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={approveAllAndDownload} disabled={approving || !batchPosts.length}>
              {approving ? "Working…" : allApproved ? "Approved! Download Here" : "Approve All & Download"}
            </Button>
            {isAdmin && (
              <Button onClick={sendToAgent} disabled={sending || !batchPosts.length}>
                {sending ? "Sending…" : "Send to Agent"}
              </Button>
            )}
            {/* Not gated on isAdmin — per Mike (2026-09-20): "the admin and or
                the user needs the ability to archive." Reversible (a flag,
                not a delete), so it needs no arm/confirm step the way Delete
                below does. */}
            {batchPosts.length > 0 && (
              <Button variant="secondary" onClick={archiveContent} disabled={archiving}>
                {archiving ? "Archiving…" : "Archive this month's content"}
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
        {archiveNote && <p className="mt-2 text-xs text-muted-foreground">{archiveNote}</p>}
        {deleteNote && <p className="mt-2 text-xs text-muted-foreground">{deleteNote}</p>}
        {postsError && <p className="mt-2 text-xs text-destructive">{postsError}</p>}
        {posts !== null && batchPosts.length === 0 && (
          <p className="mt-3 text-sm text-muted-foreground">
            Nothing generated for this month yet — hit "Generate Now" above.
          </p>
        )}
        <button
          onClick={toggleArchivedView}
          className="mt-3 text-xs font-semibold text-muted-foreground hover:text-foreground"
        >
          {showArchived ? "▾" : "▸"} Archived content for {folder.month}
        </button>
        {showArchived && (
          <div className="mt-2 space-y-2 border-t border-border pt-2">
            {archivedError && <p className="text-xs text-destructive">{archivedError}</p>}
            {archivedBatches === null && !archivedError && (
              <p className="text-xs text-muted-foreground">Loading archived content…</p>
            )}
            {archivedBatches !== null && archivedBatches.length === 0 && (
              <p className="text-xs text-muted-foreground">Nothing archived for this month yet.</p>
            )}
            {archivedBatches?.map((b) => (
              <div
                key={b.batchId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2"
              >
                <span className="text-xs text-muted-foreground">
                  {b.count} piece{b.count === 1 ? "" : "s"} — generated {new Date(b.generatedAt).toLocaleDateString()}
                </span>
                <Button
                  variant="secondary"
                  onClick={() => restoreBatch(b.batchId)}
                  disabled={restoringBatchId === b.batchId}
                >
                  {restoringBatchId === b.batchId ? "Restoring…" : "Restore"}
                </Button>
              </div>
            ))}
          </div>
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
  // Diagnostic counts from the last scan — added 2026-09-21 alongside the
  // Drive subfolder-recursion fix, so an empty result can say WHY it's
  // empty instead of a flat "no unused photos" that reads as a bug even
  // when it's telling the truth. Only Drive scans currently return
  // unsupportedFormatCount (HEIC/HEIF, an iPhone's default format, which
  // Drive can list but Claude's vision API can't read) — a Library scan's
  // uploads are always converted to JPEG at upload time, so that case
  // doesn't apply there.
  const [scanMeta, setScanMeta] = useState<{ totalPhotos: number; unsupportedFormatCount: number } | null>(null);
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
    setScanMeta(null);
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
      setScanMeta({
        totalPhotos: res.totalPhotos,
        unsupportedFormatCount: (res as { unsupportedFormatCount?: number }).unsupportedFormatCount ?? 0,
      });
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
          Pulls unused photos from Drive and your Media Library, writes a caption in their voice for each, and lets you
          pick the ones worth turning into posts. Click to get started →
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
        Scans a handful of unused photos and writes a caption for each, in their voice. Pick the ones worth turning into
        posts.
      </p>

      <div className="mt-3 flex flex-wrap gap-2 border-b border-border pb-3">
        <button
          onClick={() => switchSource("drive")}
          disabled={!folderId}
          title={folderId ? undefined : "No Google Drive folder set for this agent yet"}
          className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            source === "drive"
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:text-foreground"
          }`}
        >
          Google Drive
        </button>
        <button
          onClick={() => switchSource("library")}
          className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
            source === "library"
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:text-foreground"
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
          {/* Distinguishes "genuinely nothing there" from "found photos but
              couldn't use any of them" — added 2026-09-21 after a report
              that this said "no photos" for a Drive folder that visibly had
              photos in it. A flat "no unused photos" is only ever accurate
              for the first case; the other two have their own real, fixable
              cause and deserve their own message instead of looking like a
              bug. */}
          {scanMeta && scanMeta.unsupportedFormatCount > 0 && scanMeta.totalPhotos === scanMeta.unsupportedFormatCount
            ? `Found ${scanMeta.totalPhotos} photo${scanMeta.totalPhotos === 1 ? "" : "s"} in this Drive folder, but ${scanMeta.totalPhotos === 1 ? "it's" : "all of them are"} HEIC/HEIF (an iPhone's default photo format), which can't be scanned yet. Save them as JPEG first (Photos app → Share → "Options" → JPEG), or switch the phone's camera to the more compatible format in Settings → Camera → Formats → "Most Compatible."`
            : scanMeta && scanMeta.unsupportedFormatCount > 0
              ? `Found ${scanMeta.totalPhotos} photos in this Drive folder — ${scanMeta.unsupportedFormatCount} of them are HEIC/HEIF and got skipped (see above), and the rest are already used or were already shown. Try "Scan more" or add new photos.`
              : scanMeta && scanMeta.totalPhotos > 0
                ? `Found ${scanMeta.totalPhotos} photo${scanMeta.totalPhotos === 1 ? "" : "s"} in ${source === "drive" ? "this Drive folder" : "the Media Library"}, but they're already used or already shown here — add new ones to scan more.`
                : `No photos found in ${source === "drive" ? "this Drive folder (checked its subfolders too)" : "the Media Library"}.`}
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
              <img src={s.thumbnailUrl} alt={s.description} className="h-16 w-16 shrink-0 rounded-xl object-cover" />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">{s.description}</p>
                {editingId === s.fileId ? (
                  <AutoResizeTextarea
                    value={edits[s.fileId] ?? s.suggestedPost}
                    onChange={(v) => setEdits((cur) => ({ ...cur, [s.fileId]: v }))}
                    minHeightPx={90}
                    className="mt-1 w-full rounded-xl bg-muted px-3 py-2 text-sm leading-relaxed outline-none ring-ring transition focus:ring-2"
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
