import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import {
  getPublicUploadAgent,
  createPublicMediaUploadUrl,
  finalizePublicMediaUpload,
  listPublicMedia,
  type MediaRow,
} from "@/lib/marketing";

// Public, unauthenticated media-upload page — added 2026-09-20 per Mike:
// "I want to create a simple link I can send them that will open up
// directly into the Media folder no differently than how we share a google
// drive link. You would click to copy and we can send it to anyone who can
// click on it and then upload photos to that media library without logging
// in." No login, no nav, and no other app functionality beyond what's below,
// so it's safe to hand to a client or a photographer with no context on the
// rest of the app. It is NOT wrapped in AppShell, since AppShell assumes a
// signed-in user with access to every module.
//
// UPDATED (2026-09-23) — originally strictly upload-only (never listed,
// showed, or deleted anything already in the library) but Mike asked for it
// to also show what's already there, matching the authenticated Media tab's
// layout: "It should follow the exact layout as the app does. This way they
// can see what's inside there." Still narrowly scoped though — this page
// can VIEW and ADD, but still has no Delete, no Mark used, no tag editing,
// and no access to any other agent's content or their Google Drive folder.
//
// The token in the URL is the only thing that identifies which agent's
// library this reads/uploads into — see marketing.ts's getPublicUploadAgent
// / createPublicMediaUploadUrl / finalizePublicMediaUpload / listPublicMedia,
// none of which require a session; access here is "knows the link," exactly
// like a Drive share link, not "is logged in." An admin can invalidate a
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

// Same fixed vocabulary marketing.ts's PHOTO_TAG_OPTIONS uses — this page
// only ever displays tags an admin/agent already set from the authenticated
// Media tab, never edits them, so this is just for a consistent label list;
// an untagged photo simply shows no chips.
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
  const [media, setMedia] = useState<MediaRow[] | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getPublicUploadAgent({ data: { token } })
      .then((r) => setAgentName(r.agentName))
      .catch((e) => setLinkError(e instanceof Error ? e.message : String(e)));
  }, [token]);

  // NEW (2026-09-23) — loads/reloads the "what's already in there" grid,
  // per Mike: "It should follow the exact layout as the app does. This way
  // they can see what's inside there." Called on first load and again after
  // any successful upload, so a newly-added photo shows up right away.
  const loadMedia = useCallback(() => {
    listPublicMedia({ data: { token } })
      .then((rows) => setMedia(rows))
      .catch((e) => setMediaError(e instanceof Error ? e.message : String(e)));
  }, [token]);

  useEffect(() => {
    loadMedia();
  }, [loadMedia]);

  // REWRITTEN (2026-09-23) per Mike: "very buggy... never uploaded, just
  // frozen." Two independent fixes, both above: getVideoDuration and every
  // network step now time out instead of hanging forever, and files upload
  // with limited concurrency (UPLOAD_CONCURRENCY at once) instead of one at
  // a time — both faster on a phone connection and no longer able to let one
  // bad file silently block everything queued behind it.
  //
  // SECOND FIX (2026-09-23, same day) — separate Photo/Video pickers.
  // Mike's next report showed a DIFFERENT stall than the one above: the
  // native iOS picker itself (Apple's own "Photos / Collections" sheet, not
  // our page) never responded when he tapped its checkmark to confirm a
  // 15-item batch that mixed photos and one video. That happens before any
  // of our JS runs — the file input's change event hadn't even fired yet —
  // so it can't be fixed by code on our page directly; this sandbox also
  // has no real iPhone to reproduce an iOS-Safari-specific picker bug on.
  // What IS a known, documented iOS behavior: before handing files back to
  // a web page, iOS has to export/transcode every selected item (HEIC
  // photos, and especially video) in that one picker session, and a large
  // mixed batch can make that export take a long time or appear to hang,
  // worse on a weak connection or low free storage. Splitting into two
  // separate pickers — Photos only, Video only — means iOS never has to
  // export a big mixed batch in a single operation, which directly reduces
  // the most likely trigger even though it isn't a confirmed fix.
  //
  // THIRD FIX (2026-09-23, same day) — Mike, after it actually worked:
  // "I couldn't tell when it was uploading... thought it was bugging out
  // then suddenly uploaded." The old status line was one small line of
  // text below the buttons — easy to miss, especially once the buttons
  // themselves went gray/disabled, which reads as "broken" rather than
  // "working." Now shows a large, impossible-to-miss progress banner with
  // an actual moving bar the instant a selection is made, and reloads the
  // "already uploaded" grid below once done so the new files visibly appear.
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
    if (photoInputRef.current) photoInputRef.current.value = "";
    if (videoInputRef.current) videoInputRef.current.value = "";
    setNote(
      skipped > 0
        ? `Uploaded ${uploaded}, skipped ${skipped} (a video over ${MAX_VIDEO_SECONDS}s, a slow connection, or a file that failed).`
        : uploaded > 0
          ? `Uploaded ${uploaded} file${uploaded === 1 ? "" : "s"}. Thanks!`
          : "Nothing uploaded.",
    );
    if (uploaded > 0) loadMedia();
  }

  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto w-full max-w-3xl">
        <div className="rounded-3xl border border-border bg-glass p-6 backdrop-blur-2xl">
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
              {/* Split into two separate pickers (2026-09-23) — see the note
                  above handleFiles. Photos first since that's the page's main
                  purpose; Video as its own smaller, separate action. */}
              <div className="mt-4 space-y-2">
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(e) => handleFiles(e.target.files)}
                  disabled={uploading}
                  className="block text-sm text-muted-foreground file:mr-3 file:rounded-full file:border-0 file:bg-primary file:px-4 file:py-2 file:text-sm file:font-semibold file:text-primary-foreground"
                />
                <input
                  ref={videoInputRef}
                  type="file"
                  accept="video/*"
                  multiple
                  onChange={(e) => handleFiles(e.target.files)}
                  disabled={uploading}
                  className="block text-sm text-muted-foreground file:mr-3 file:rounded-full file:border-0 file:bg-secondary file:px-4 file:py-2 file:text-sm file:font-semibold file:text-foreground"
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                If a big batch ever seems stuck picking photos, try again with fewer at a time.
              </p>

              {/* Large, hard-to-miss progress banner (2026-09-23) — replaces
                  the old small status line per Mike's "couldn't tell when it
                  was uploading" report. */}
              {uploading && progress && (
                <div className="mt-4 rounded-2xl border border-primary/40 bg-primary/10 p-4">
                  <p className="text-sm font-semibold text-foreground">
                    Uploading… {progress.done} of {progress.total} done
                  </p>
                  <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{
                        width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%`,
                      }}
                    />
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Keep this page open — it'll say "Thanks!" below when everything's uploaded.
                  </p>
                </div>
              )}
              {note && <p className="mt-3 text-sm font-semibold text-foreground">{note}</p>}

              {/* "What's already in there" grid (2026-09-23), per Mike: "It
                  should follow the exact layout as the app does. This way
                  they can see what's inside there." Mirrors the authenticated
                  Media tab's card layout exactly, view-only — no Delete, no
                  Mark used, no tag editing. */}
              <div className="mt-8 border-t border-border pt-6">
                <h2 className="text-sm font-semibold text-foreground">Already uploaded</h2>
                {mediaError && <p className="mt-2 text-sm text-destructive">{mediaError}</p>}
                {!mediaError && media === null && <p className="mt-2 text-sm text-muted-foreground">Loading…</p>}
                {!mediaError && media !== null && media.length === 0 && (
                  <p className="mt-2 text-sm text-muted-foreground">Nothing uploaded yet.</p>
                )}
                {!mediaError && media !== null && media.length > 0 && (
                  <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {media.map((m) => (
                      <div key={m.id} className="overflow-hidden rounded-2xl border border-border bg-glass">
                        {m.media_type === "video"
                          ? m.url && <video src={m.url} controls className="aspect-square w-full object-cover" />
                          : m.url && (
                              <img src={m.url} alt={m.caption ?? ""} className="aspect-square w-full object-cover" />
                            )}
                        <div className="flex items-center justify-between gap-1 px-2 pt-2">
                          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {m.media_type}
                          </span>
                          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            Uploaded
                          </span>
                        </div>
                        {m.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 p-2">
                            {m.tags.map((tag) => (
                              <span
                                key={tag}
                                className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
