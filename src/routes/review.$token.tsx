import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  getPublicReviewAgent,
  listPublicReviewMonths,
  listPublicReviewPosts,
  approvePublicReviewPost,
  submitPublicReviewFeedback,
  type PostRow,
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
// sharing." This card's markup/classes now mirror PostCard in marketing.tsx
// (same Card look, same photo block, same Canva link/instructions) so an
// agent reviewing here sees literally the same thing the admin does. Still
// deliberately scoped to view + Approve/Flag only, matching exactly what an
// agent could already do on the Posts tab after logging in — no editing, no
// photo swapping, no AI-rewrite, no access to any other agent's content, no
// nav, no AppShell. If Mike wants the edit/AI-feedback tools out here too,
// that's a bigger trust/security/cost call for an unauthenticated public
// link and should be confirmed with him first, not silently added.

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

function ReviewCard({
  post,
  token,
  onChanged,
}: {
  post: PostRow;
  token: string;
  onChanged: (postId: string, status: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [flagging, setFlagging] = useState(false);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      await approvePublicReviewPost({ data: { token, postId: post.id } });
      onChanged(post.id, "approved");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function sendFlag() {
    setBusy(true);
    setError(null);
    try {
      await submitPublicReviewFeedback({
        data: { token, postId: post.id, ...(notes.trim() ? { notes: notes.trim() } : {}) },
      });
      setFlagging(false);
      setNotes("");
      onChanged(post.id, "flagged");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
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
      {/* Header — same layout PostCard uses: type/platform/month line, then
          title, badge on the right. */}
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
        {/* Photo — same block PostCard renders for a post, added here
            2026-09-29 so this page is no longer plain text next to the
            admin view that shows the actual photo. */}
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
          </>
        )}

        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

        {post.status !== "approved" && !flagging && (
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={approve}
              disabled={busy}
              className="rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-all hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Approving…" : "Approve"}
            </button>
            <button
              onClick={() => setFlagging(true)}
              disabled={busy}
              className="rounded-full border border-destructive/40 px-5 py-2 text-sm font-semibold text-destructive transition-all hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Flag this one
            </button>
          </div>
        )}

        {flagging && (
          <div className="mt-4 space-y-2">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What should change? (optional, but helps us get it right next time)"
              className="min-h-[70px] w-full rounded-xl border border-border bg-glass px-3 py-2 text-sm outline-none"
            />
            <div className="flex gap-2">
              <button
                onClick={sendFlag}
                disabled={busy}
                className="rounded-full border border-destructive/40 px-5 py-2 text-sm font-semibold text-destructive transition-all hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "Sending…" : "Send flag"}
              </button>
              <button
                onClick={() => {
                  setFlagging(false);
                  setNotes("");
                }}
                disabled={busy}
                className="rounded-full border border-border bg-glass px-5 py-2 text-sm font-semibold transition-all hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>
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

  function handleChanged(postId: string, status: string) {
    setPosts((cur) => (cur ? cur.map((p) => (p.id === postId ? { ...p, status } : p)) : cur));
    setConfirmNote(status === "approved" ? "Approved — thanks!" : "Flag sent — we'll take a look.");
  }

  const pendingCount = (posts ?? []).filter((p) => p.status !== "approved").length;

  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto w-full max-w-2xl">
        <h1 className="font-display text-xl font-semibold">Review your content</h1>

        {linkError && <p className="mt-3 text-sm text-destructive">{linkError}</p>}

        {!linkError && !agentName && <p className="mt-3 text-sm text-muted-foreground">Loading…</p>}

        {!linkError && agentName && (
          <>
            <p className="mt-1 text-sm text-muted-foreground">
              Hey <span className="font-semibold text-foreground">{agentName}</span> — take a look below. Approve what
              sounds like you, flag anything that doesn't. No account needed.
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

            <div className="mt-4 space-y-4">
              {months !== null && months.length === 0 && (
                <div className="rounded-3xl border border-border bg-glass p-6 backdrop-blur-2xl">
                  <p className="text-sm text-muted-foreground">Nothing here to review yet.</p>
                </div>
              )}
              {posts === null && months && months.length > 0 && (
                <p className="text-sm text-muted-foreground">Loading…</p>
              )}
              {posts !== null &&
                posts.map((p) => <ReviewCard key={p.id} post={p} token={token} onChanged={handleChanged} />)}
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
