import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  getPublicReviewAgent,
  listPublicReviewMonths,
  listPublicReviewPosts,
  approvePublicReviewPost,
  submitPublicReviewFeedback,
  updatePublicReviewPostContent,
  rewritePublicReviewPost,
  listPublicReviewMedia,
  setPublicReviewPostMedia,
  listPublicReviewDriveMedia,
  setPublicReviewDrivePhoto,
  getPublicReviewDriveFolderId,
  type PostRow,
  type MediaRow,
  type DriveFile,
} from "@/lib/marketing";

// Public, unauthenticated review page — added 2026-09-22 per Mike: "it is
// not sending the file for the agent to review... this must be a public
// facing link that does not require login." Deliberately NOT the old app's
// review.html?agent=...&batch=... (a guessable URL that let anyone view AND
// edit any agent's content — the exact hole this whole native rewrite
// closed). Access here is "knows the unguessable token in the link," same
// trust model as media-upload.$token.tsx's public upload page, not "is
// logged in." An admin can invalidate a link at any time (regenerate it via
// getReviewLink/regenerateReviewLink in marketing.ts).
//
// RESTYLED (2026-09-29) per Mike, after seeing this next to the admin view:
// "The public review link looks terrible it should match the exact same
// view we see. There should not be any difference in the screen we're
// sharing." First pass matched the CARD's look (photo, styling) and the
// page's 2-column grouped layout, but deliberately kept the action set to
// Approve/Flag only — that scoping was called out explicitly as its own
// decision, not silently assumed.
//
// THAT SCOPING WAS THEN OVERRIDDEN, same day, per Mike's direct follow-up:
// "you're missing all the editing features... the UI should match exactly
// as it is in our admin view, where they can speak to it, they can have it
// rewrite it, the exact same features that we have to edit and add posts.
// They could change photos. They have the exact same interface. Let's not
// overthink it... everything on this review screen... should be identical.
// Every aspect of it." So this page's card (PublicPostCard below) is now a
// full twin of marketing.tsx's PostCard: direct text edit with mic
// dictation, AI "Rewrite in their voice," and a Change/Add photo picker
// (Media Library + Google Drive), not just Approve/Flag. Every write this
// page can make goes through a token-resolved twin of the matching
// authenticated function in marketing.ts (resolveAgentIdFromReviewToken in
// place of a Supabase session) — same feedback_history logging either way,
// so a client's own edit/rewrite/photo-change here feeds fetchLearnedFeedback
// exactly like a team member's would on the admin side.

export const Route = createFileRoute("/review/$token")({
  head: () => ({
    meta: [{ title: "Review your content — Your Marketing Dude" }, { name: "robots", content: "noindex, nofollow" }],
  }),
  component: PublicReviewPage,
});

const CONTENT_TYPE_LABEL: Record<string, string> = {
  post: "Social post",
  email: "Email",
  video: "Video script",
};

// Same grouping the admin calendar view uses (marketing.tsx's CATEGORY_ORDER
// / CATEGORY_META / categorizePost / BatchSection) — duplicated here rather
// than imported since routes don't currently share a components module.
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

function categorizePost(post: PostRow): ContentCategory {
  if (post.content_type === "email") return "email";
  if (post.content_type === "video") return "video";
  return post.metadata?.canva_link ? "canva" : "post";
}

// Same reliable cross-origin download pattern PostCard uses in
// marketing.tsx (a plain `download` attribute is unreliable cross-origin) —
// duplicated here rather than imported since routes don't currently share a
// components module.
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

// Below: Button / AutoResizeTextarea / MicButton (+ its small Speech
// Recognition helpers) are duplicated verbatim from marketing.tsx rather
// than imported, same reasoning as downloadRemoteFile above — this route
// doesn't share a components module with the admin app yet.

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

// Minimal ambient typing for the Web Speech API — it isn't in lib.dom.d.ts.
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

function PublicPostCard({
  post,
  token,
  driveFolderId,
  onChanged,
}: {
  post: PostRow;
  token: string;
  driveFolderId: string | null;
  // No status arg means "something changed, refetch" without claiming a
  // particular status (a direct edit, rewrite, or photo swap) — the parent
  // does a full refetch either way, since those can change content/metadata
  // that a status-only patch would miss.
  onChanged: (postId: string, status?: string) => void;
}) {
  const [draft, setDraft] = useState(post.content);
  const [editorOpen, setEditorOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [rewriting, setRewriting] = useState(false);
  const [rewriteHistory, setRewriteHistory] = useState<{ feedback: string; result: string }[]>([]);
  // Change/Add photo picker — Media Library + Google Drive, same as
  // PostCard's. No Stock Photos tab here either, matching the admin post
  // picker (Unsplash stays email-only there too).
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTab, setPickerTab] = useState<"library" | "drive">("library");
  const [mediaOptions, setMediaOptions] = useState<MediaRow[] | null>(null);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [driveOptions, setDriveOptions] = useState<DriveFile[] | null>(null);
  const [driveOptionsError, setDriveOptionsError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(post.content);
  }, [post.content]);

  async function approve() {
    setBusy(true);
    setSaveError(null);
    try {
      await approvePublicReviewPost({ data: { token, postId: post.id } });
      onChanged(post.id, "approved");
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
      await updatePublicReviewPostContent({ data: { token, postId: post.id, content: draft } });
      // Deliberately leave the panel open, same as the admin's Edit /
      // Feedback panel — saving a direct edit doesn't have to end the visit.
      onChanged(post.id);
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
      await submitPublicReviewFeedback({
        data: { token, postId: post.id, ...(trimmedNotes ? { notes: trimmedNotes } : {}) },
      });
      setNotes("");
      onChanged(post.id, "flagged");
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
      const res = await rewritePublicReviewPost({ data: { token, postId: post.id, feedback } });
      setRewriteHistory((h) => [...h, { feedback, result: res.content }]);
      setNotes("");
      onChanged(post.id);
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
        const list = await listPublicReviewMedia({ data: { token } });
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
      await setPublicReviewPostMedia({ data: { token, postId: post.id, mediaId } });
      setPickerOpen(false);
      onChanged(post.id);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setMediaBusy(false);
    }
  }

  async function openDriveTab() {
    setPickerTab("drive");
    if (!driveOptions && driveFolderId) {
      try {
        const res = await listPublicReviewDriveMedia({ data: { token } });
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
      await setPublicReviewDrivePhoto({
        data: { token, postId: post.id, driveFileId: file.id, thumbnailUrl: file.thumbnailUrl },
      });
      setPickerOpen(false);
      onChanged(post.id);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setMediaBusy(false);
    }
  }

  const statusStyles =
    post.status === "approved"
      ? "bg-[color-mix(in_oklab,var(--color-primary)_14%,transparent)] text-primary"
      : post.status === "flagged"
        ? "bg-destructive/10 text-destructive"
        : "bg-muted text-muted-foreground";
  const statusLabel =
    post.status === "approved" ? "Approved" : post.status === "flagged" ? "Flagged" : "Pending review";
  const typeLabel = CONTENT_TYPE_LABEL[post.content_type] ?? post.content_type;
  const photoUrl = post.metadata?.media_url || post.metadata?.drive_thumbnail_url || null;

  return (
    <div className="rounded-3xl border border-border bg-glass p-6 backdrop-blur-2xl">
      <div className="flex w-full items-center justify-between gap-3 text-left">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {typeLabel}
            {post.platform ? ` · ${post.platform}` : ""}
            {post.month ? ` · ${post.month}` : ""}
          </p>
          {post.title && <h3 className="mt-1 font-display text-base font-semibold">{post.title}</h3>}
        </div>
        <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${statusStyles}`}>{statusLabel}</span>
      </div>

      <div className="mt-4 border-t border-border pt-4">
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

        <p className="whitespace-pre-wrap text-sm leading-relaxed">{post.content}</p>

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
            {post.metadata?.canva_instructions && (
              <div className="mt-2 text-xs text-muted-foreground">
                <p className="mb-1 font-semibold">🎨 Instructions for this template</p>
                <p className="whitespace-pre-wrap">{post.metadata.canva_instructions}</p>
              </div>
            )}
          </>
        )}

        {saveError && <p className="mt-2 text-xs text-destructive">{saveError}</p>}

        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={approve} disabled={busy || post.status === "approved"}>
            {post.status === "approved" ? "Approved" : "Approve"}
          </Button>
          <Button variant="secondary" onClick={() => setEditorOpen((v) => !v)} disabled={busy}>
            Edit / Feedback
          </Button>
          {post.content_type === "post" && (
            <Button variant="secondary" onClick={openPicker} disabled={busy}>
              {photoUrl ? "Change photo" : "Add photo"}
            </Button>
          )}
        </div>

        {post.content_type === "post" && pickerOpen && (
          <div className="mt-4 rounded-2xl border border-border bg-background/40 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold">Which photo do you want to use?</p>
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
                  <p className="text-xs text-muted-foreground">No available photos or videos for this agent yet.</p>
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

        {editorOpen && (
          <div className="mt-4 space-y-4 rounded-2xl border border-border bg-background/40 p-4">
            {/* Direct edit — on top, same layout as the admin's Edit /
                Feedback panel: type, paste, or dictate with the mic, then
                Save. */}
            <div>
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Edit directly</p>
                <MicButton value={draft} onChange={setDraft} />
              </div>
              <AutoResizeTextarea
                value={draft}
                onChange={setDraft}
                minHeightPx={120}
                className="mt-2 w-full rounded-2xl bg-muted px-4 py-3 text-sm leading-relaxed outline-none ring-ring transition focus:ring-2"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <Button onClick={saveEdit} disabled={busy || draft === post.content}>
                  {busy ? "Saving…" : "Save"}
                </Button>
              </div>
            </div>

            {/* AI feedback — same rewrite/flag flow PostCard offers. */}
            <div className="border-t border-border pt-4">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Or tell us what to change
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
                placeholder="What is off? Too formal, I never say this, make it shorter…"
                className="mt-2 min-h-[80px] w-full rounded-2xl bg-muted px-4 py-3 text-sm outline-none ring-ring transition focus:ring-2"
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button onClick={rewrite} disabled={busy || rewriting}>
                  {rewriting ? "Rewriting…" : "Rewrite in my voice →"}
                </Button>
                <Button onClick={sendFeedback} variant="secondary" disabled={busy || rewriting}>
                  Submit feedback
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setEditorOpen(false);
                    setDraft(post.content);
                    setNotes("");
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
          </div>
        )}
      </div>
    </div>
  );
}

function PublicReviewPage() {
  const token = Route.useParams().token;
  const [agentName, setAgentName] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [months, setMonths] = useState<string[] | null>(null);
  const [month, setMonth] = useState<string>("");
  const [posts, setPosts] = useState<PostRow[] | null>(null);
  const [confirmNote, setConfirmNote] = useState<string | null>(null);
  // For the Change/Add photo picker's Google Drive tab — same role
  // agentDriveFolderId plays in the admin's MonthWorkspace.
  const [driveFolderId, setDriveFolderId] = useState<string | null>(null);

  useEffect(() => {
    getPublicReviewAgent({ data: { token } })
      .then((r) => setAgentName(r.agentName))
      .catch((e) => setLinkError(e instanceof Error ? e.message : String(e)));
    listPublicReviewMonths({ data: { token } })
      .then((r) => {
        setMonths(r.months);
        if (r.months.length) setMonth(r.months[0]!);
      })
      .catch(() => setMonths([]));
    getPublicReviewDriveFolderId({ data: { token } })
      .then((r) => setDriveFolderId(r.folderId))
      .catch(() => setDriveFolderId(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (!month) return;
    setPosts(null);
    listPublicReviewPosts({ data: { token, month } })
      .then((p) => setPosts(p))
      .catch((e) => setLinkError(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, month]);

  function handleChanged(_postId: string, status?: string) {
    // Full refetch rather than patching one field locally — a direct edit,
    // AI rewrite, or photo swap changes content/metadata, not just status,
    // so a status-only patch (the old Approve/Flag-only version) would
    // leave a stale card on screen after those actions. Mirrors the admin's
    // onChanged={loadPosts} pattern.
    if (month) {
      listPublicReviewPosts({ data: { token, month } })
        .then((p) => setPosts(p))
        .catch((e) => setLinkError(e instanceof Error ? e.message : String(e)));
    }
    if (status === "approved") setConfirmNote("Approved — thanks!");
    else if (status === "flagged") setConfirmNote("Flag sent — we'll take a look.");
    else setConfirmNote(null);
  }

  const pendingCount = (posts ?? []).filter((p) => p.status !== "approved").length;

  return (
    <div className="min-h-screen bg-background px-4 py-10">
      {/* max-w-7xl matches AppShell's own content width (the admin app's
          <main> wrapper) so this page isn't artificially narrower than the
          admin view it's supposed to be identical to. */}
      <div className="mx-auto w-full max-w-7xl">
        <h1 className="font-display text-xl font-semibold">Review your content</h1>

        {linkError && <p className="mt-3 text-sm text-destructive">{linkError}</p>}

        {!linkError && !agentName && <p className="mt-3 text-sm text-muted-foreground">Loading…</p>}

        {!linkError && agentName && (
          <>
            <p className="mt-1 text-sm text-muted-foreground">
              Hey <span className="font-semibold text-foreground">{agentName}</span> — take a look below. Approve what
              sounds like you, edit it directly, or tell us what to change. No account needed.
            </p>

            {months && months.length > 1 && (
              <div className="mt-4 flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Month</span>
                <select
                  value={month}
                  onChange={(e) => setMonth(e.target.value)}
                  className="rounded-xl border border-border bg-glass px-3 py-1.5 text-sm outline-none"
                >
                  {months.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {confirmNote && <p className="mt-4 text-sm font-semibold text-primary">{confirmNote}</p>}

            <div className="mt-4 space-y-6">
              {months !== null && months.length === 0 && (
                <div className="rounded-3xl border border-border bg-glass p-6 backdrop-blur-2xl">
                  <p className="text-sm text-muted-foreground">Nothing here to review yet.</p>
                </div>
              )}
              {posts === null && months && months.length > 0 && (
                <p className="text-sm text-muted-foreground">Loading…</p>
              )}
              {posts !== null &&
                CATEGORY_ORDER.map((cat) => {
                  const group = posts.filter((p) => categorizePost(p) === cat);
                  if (!group.length) return null;
                  const meta = CATEGORY_META[cat];
                  return (
                    <div key={cat}>
                      <div
                        className={`mb-3 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wider ${meta.accent}`}
                      >
                        <span aria-hidden="true">{meta.icon}</span>
                        <span>{meta.label}</span>
                        <span className="rounded-full bg-background/70 px-1.5 py-0.5 text-[10px] font-bold">
                          {group.length}
                        </span>
                      </div>
                      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                        {group.map((p) => (
                          <PublicPostCard
                            key={p.id}
                            post={p}
                            token={token}
                            driveFolderId={driveFolderId}
                            onChanged={handleChanged}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
            </div>

            {posts !== null && posts.length > 0 && (
              <p className="mt-4 text-xs text-muted-foreground">
                {pendingCount > 0
                  ? `${pendingCount} still need a look.`
                  : "Everything here is approved — thanks for reviewing!"}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
