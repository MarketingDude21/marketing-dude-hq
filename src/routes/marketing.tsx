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
  listMarketingMedia,
  createMediaUploadUrl,
  finalizeMediaUpload,
  markMediaUsed,
  deleteMarketingMedia,
  listAgentDriveMedia,
  setAgentDriveFolder,
  generateMarketingContent,
  type MarketingAccess,
  type MediaRow,
  type DriveFile,
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
};

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
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
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

function MarketingPage() {
  const [access, setAccess] = useState<MarketingAccess | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [selected, setSelected] = useState<AgentOption | null>(null);

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

  if (access.role === "admin" && !selected) {
    return (
      <AppShell>
        <PageHeader />
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
  const [tab, setTab] = useState<"posts" | "media" | "drive">("posts");
  return (
    <div className="mt-5">
      <div className="flex flex-wrap gap-1 rounded-full border border-border bg-glass p-1 backdrop-blur-xl w-fit">
        {(["posts", "media", "drive"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === t ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t === "posts" ? "Posts" : t === "media" ? "Media" : "Google Drive"}
          </button>
        ))}
      </div>
      <div className="mt-5">
        {tab === "posts" && <PostsTab agentId={agentId} />}
        {tab === "media" && <MediaTab agentId={agentId} />}
        {tab === "drive" && <DriveTab agentId={agentId} isAdmin={isAdmin} />}
      </div>
    </div>
  );
}

function PostsTab({ agentId }: { agentId: string }) {
  const [months, setMonths] = useState<string[]>([]);
  const [month, setMonth] = useState<string>("");
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, month]);

  if (error) {
    return (
      <Card>
        <p className="text-sm text-destructive">{error}</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <CreateContentForm agentId={agentId} onCreated={reload} />

      {months.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
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
        </div>
      )}

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

      {posts !== null &&
        posts.map((post) => (
          <PostCard
            key={post.id}
            post={post}
            agentId={agentId}
            expanded={expanded === post.id}
            onToggle={() => setExpanded((cur) => (cur === post.id ? null : post.id))}
            onChanged={reload}
          />
        ))}
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
        {contentType === "video" && (
          <input
            value={hook}
            onChange={(e) => setHook(e.target.value)}
            placeholder="Any specific hook/opening line direction? (optional)"
            className="w-full rounded-xl border border-border bg-glass px-3 py-2 text-sm outline-none"
          />
        )}
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Anything else it should include? (optional)"
          className="min-h-[60px] w-full rounded-xl border border-border bg-glass px-3 py-2 text-sm outline-none"
        />
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

  const typeLabel = post.content_type === "email" ? "Email" : post.content_type === "video" ? "Video script" : "Post";

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
          {editing ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="min-h-[140px] w-full rounded-2xl bg-muted px-4 py-3 text-sm leading-relaxed outline-none ring-ring transition focus:ring-2"
            />
          ) : (
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{post.content}</p>
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
              </>
            )}
          </div>

          {feedbackOpen && (
            <div className="mt-4 rounded-2xl border border-border bg-background/40 p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                What should change?
              </p>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Tell us what's off — we'll use this to write better next time."
                className="mt-2 min-h-[80px] w-full rounded-2xl bg-muted px-4 py-3 text-sm outline-none ring-ring transition focus:ring-2"
              />
              <div className="mt-3 flex gap-2">
                <Button onClick={sendFeedback} disabled={busy}>
                  Submit feedback
                </Button>
                <Button variant="secondary" onClick={() => setFeedbackOpen(false)} disabled={busy}>
                  Cancel
                </Button>
              </div>
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
