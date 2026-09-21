import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { getPublicUploadAgent, createPublicMediaUploadUrl, finalizePublicMediaUpload } from "@/lib/marketing";
import { Card } from "@/components/ui/card";

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
    meta: [
      { title: "Upload photos — Your Marketing Dude" },
      { name: "robots", content: "noindex, nofollow" },
    ],
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

function PublicMediaUploadPage() {
  const token = Route.useParams().token;
  const [agentName, setAgentName] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    getPublicUploadAgent({ data: { token } })
      .then((r) => setAgentName(r.agentName))
      .catch((e) => setLinkError(e instanceof Error ? e.message : String(e)));
  }, [token]);

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || !fileList.length) return;
    setUploading(true);
    setNote(null);
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
        const { path, uploadToken } = await createPublicMediaUploadUrl({
          data: { token, fileName: toUpload.name },
        });
        const { error: uploadErr } = await supabase.storage
          .from("media")
          .uploadToSignedUrl(path, uploadToken, toUpload);
        if (uploadErr) throw uploadErr;
        await finalizePublicMediaUpload({ data: { token, storagePath: path, mediaType } });
        uploaded++;
      } catch (e) {
        skipped++;
        // eslint-disable-next-line no-console
        console.error("Public media upload failed:", e);
      }
    }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setNote(
      skipped > 0
        ? `Uploaded ${uploaded}, skipped ${skipped} (a video over ${MAX_VIDEO_SECONDS}s, or a file that failed to upload).`
        : uploaded > 0
          ? `Uploaded ${uploaded} file${uploaded === 1 ? "" : "s"}. Thanks!`
          : "Nothing uploaded.",
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-xl">
        <Card className="p-6">
          <h1 className="font-display text-lg font-semibold">Upload photos or video</h1>

          {linkError && <p className="mt-3 text-sm text-destructive">{linkError}</p>}

          {!linkError && !agentName && <p className="mt-3 text-sm text-muted-foreground">Loading…</p>}

          {!linkError && agentName && (
            <>
              <p className="mt-2 text-sm text-muted-foreground">
                Add photos or short videos for {agentName}. No account needed — just pick your files below.
              </p>

              <div className="mt-4 flex flex-wrap items-center gap-3">
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

              {uploading && <p className="mt-2 text-xs text-muted-foreground">Uploading…</p>}
              {note && <p className="mt-2 text-xs text-muted-foreground">{note}</p>}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
