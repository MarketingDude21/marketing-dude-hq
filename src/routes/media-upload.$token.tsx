import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { getPublicUploadAgent, createPublicMediaUploadUrl, finalizePublicMediaUpload } from "@/lib/marketing";

// Public, unauthenticated media-upload page — added 2026-09-20 per Mike:
// "I want to create a simple link I can send them that will open up
// directly into the Media folder no differently than how we share a google
// drive link. You would click to copy and we can send it to anyone who can
// click on it and then upload photos to that media library without logging
// in." Deliberately upload-only: this page never lists, shows, or deletes
// anything already in the agent's library, and it has no login, no nav, and
// no other app functionality — just a name, a file picker, and a confirm
// message, so it's safe to hand to a client or a photographer with no
// context on the rest of the app. It is NOT wrapped in AppShell, since
// AppShell assumes a signed-in user with access to every module.
//
// The token in the URL is the only thing that identifies which agent's
// library this uploads into — see marketing.ts's getPublicUploadAgent /
// createPublicMediaUploadUrl / finalizePublicMediaUpload, none of which
// require a session; access here is "knows the link," exactly like a Drive
// upload-only share link, not "is logged in." An admin can invalidate a
// link at any time (Media tab → Regenerate link).

export const Route = createFileRoute("/media-upload/$token")({
  head: () => ({
    meta: [{ title: "Social Media Images — Your Marketing Dude" }, { name: "robots", content: "noindex, nofollow" }],
  }),
  component: PublicMediaUploadPage,
});

// Same client-side helpers MediaTab's own upload box uses (marketing.tsx) —
// duplicated here rather than shared, matching this file's existing pattern
// of small, self-contained helpers per route (e.g. MicButton) since this
// page intentionally has no dependency on the authenticated Workspace code.
async function resizeImage(file: File, maxEdge = 2000, quality = 0.85): Promise<File> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  if (scale === 1) return file;
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

// FIXED (2026-09-23) — this is the actual root cause of Mike's "it just
// froze" report. iPhone videos are commonly HEVC-encoded .MOV files, and
// Safari's `loadedmetadata` event for that format doesn't reliably fire in
// every context — when it doesn't, this promise NEVER resolved (no timeout,
// and `onerror` doesn't fire either since nothing actually errored, it just
// never loads). Since uploads ran one-at-a-time in a single for-loop below,
// one stuck video silently blocked every file queued after it too — exactly
// "selected 9 files, it said Uploading… and never finished." Now races
// against an 8-second timeout; if metadata never arrives, this treats
// duration as unknown (0) rather than hanging forever, and the upload
// proceeds instead of silently stalling everything behind it.
function getVideoDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    let settled = false;
    const finish = (value: number) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(video.src);
      resolve(value);
    };
    video.onloadedmetadata = () => finish(video.duration);
    video.onerror = () => finish(0);
    video.src = URL.createObjectURL(file);
    setTimeout(() => finish(0), 8_000);
  });
}

// Generic timeout wrapper for the three network calls in the upload
// pipeline below (mint a signed URL, upload bytes, finalize the row) — same
// fix in spirit as getVideoDuration above: one call hanging on a flaky
// mobile connection used to stall this file (and, in the old sequential
// loop, every file after it) forever with zero feedback. Now it fails that
// one step after 30s so the batch keeps moving and the person sees an
// honest "skipped" count instead of a frozen screen.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// Runs `worker` over `items` with at most `limit` in flight at once, instead
// of one giant Promise.all (which would fire every upload simultaneously —
// rough on a mobile connection and on Supabase Storage) or the old fully
// sequential for-loop (one slow/stuck file blocks every file behind it).
async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>) {
  let next = 0;
  async function runOne() {
    while (next < items.length) {
      const index = next++;
      await worker(items[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
}

const MAX_VIDEO_SECONDS = 120;
const UPLOAD_CONCURRENCY = 3;
const STEP_TIMEOUT_MS = 30_000;

function PublicMediaUploadPage() {
  const token = Route.useParams().token;
  const [agentName, setAgentName] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getPublicUploadAgent({ data: { token } })
      .then((r) => setAgentName(r.agentName))
      .catch((e) => setLinkError(e instanceof Error ? e.message : String(e)));
  }, [token]);

  // REWRITTEN (2026-09-23) per Mike: "very buggy... never uploaded, just
  // frozen." Two independent fixes, both above: getVideoDuration and every
  // network step now time out instead of hanging forever, and files upload
  // with limited concurrency (UPLOAD_CONCURRENCY at once) instead of one at
  // a time — both faster on a phone connection and no longer able to let one
  // bad file silently block everything queued behind it. Progress now
  // updates live ("3 of 9 done") instead of a single unmoving "Uploading…"
  // for the whole batch.
  async function handleFiles(fileList: FileList | null) {
    if (!fileList || !fileList.length) return;
    const files = Array.from(fileList);
    setUploading(true);
    setNote(null);
    setProgress({ done: 0, total: files.length });
    let uploaded = 0;
    let skipped = 0;

    await runWithConcurrency(files, UPLOAD_CONCURRENCY, async (file) => {
      try {
        const isVideo = file.type.startsWith("video/");
        const mediaType: "photo" | "video" = isVideo ? "video" : "photo";
        if (isVideo) {
          const duration = await getVideoDuration(file);
          if (duration > MAX_VIDEO_SECONDS) {
            skipped++;
            return;
          }
        }
        const toUpload = isVideo ? file : await resizeImage(file);
        const { path, uploadToken } = await withTimeout(
          createPublicMediaUploadUrl({ data: { token, fileName: toUpload.name } }),
          STEP_TIMEOUT_MS,
          "Getting an upload slot",
        );
        const { error: uploadErr } = await withTimeout(
          supabase.storage.from("media").uploadToSignedUrl(path, uploadToken, toUpload),
          STEP_TIMEOUT_MS,
          "Uploading the file",
        );
        if (uploadErr) throw uploadErr;
        await withTimeout(
          finalizePublicMediaUpload({ data: { token, storagePath: path, mediaType } }),
          STEP_TIMEOUT_MS,
          "Saving the upload",
        );
        uploaded++;
      } catch (e) {
        skipped++;
        // eslint-disable-next-line no-console
        console.error("Public media upload failed:", e);
      } finally {
        setProgress((cur) => (cur ? { done: cur.done + 1, total: cur.total } : cur));
      }
    });

    setUploading(false);
    setProgress(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setNote(
      skipped > 0
        ? `Uploaded ${uploaded}, skipped ${skipped} (a video over ${MAX_VIDEO_SECONDS}s, a slow connection, or a file that failed).`
        : uploaded > 0
          ? `Uploaded ${uploaded} file${uploaded === 1 ? "" : "s"}. Thanks!`
          : "Nothing uploaded.",
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md rounded-3xl border border-border bg-glass p-6 backdrop-blur-2xl">
        {linkError && <p className="text-sm text-destructive">{linkError}</p>}

        {!linkError && !agentName && <p className="text-sm text-muted-foreground">Loading…</p>}

        {!linkError && agentName && (
          <>
            {/* Personalized header, per Mike (2026-09-23): agent's name, then
                a section label, then the actual instruction/CTA line. */}
            <h1 className="font-display text-xl font-semibold">{agentName}</h1>
            <p className="mt-1 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Social Media Images
            </p>
            <p className="mt-3 text-sm text-muted-foreground">
              Upload Your Social Media Graphics Here So Your Marketing Dude Can Get To Work. No account needed — just
              pick your files below.
            </p>
            <div className="mt-4">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/*"
                multiple
                onChange={(e) => handleFiles(e.target.files)}
                disabled={uploading}
                className="text-sm text-muted-foreground file:mr-3 file:rounded-full file:border-0 file:bg-primary file:px-4 file:py-2 file:text-sm file:font-semibold file:text-primary-foreground"
              />
            </div>
            {uploading && (
              <p className="mt-3 text-xs text-muted-foreground">
                {progress ? `Uploading… ${progress.done} of ${progress.total} done` : "Uploading…"}
              </p>
            )}
            {note && <p className="mt-3 text-sm text-foreground">{note}</p>}
          </>
        )}
      </div>
    </div>
  );
}
