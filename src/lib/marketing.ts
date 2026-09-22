import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { TablesInsert } from "@/integrations/supabase/types";

// ============================================================================
// Monthly Marketing — native integration
//
// Unlike Build My Database, this does NOT talk to a separate Supabase
// project. The agents / generated_posts / feedback_history / agent_photos
// tables already live in THIS dashboard's own project (agents was set up
// for Voice DNA — an agent's row id IS their dashboard auth user id).
//
// Why this file exists: the old standalone tool (a Netlify app) had no
// login and no per-client boundary at all.
//   - Its back-office console (index.html) loaded every agent, unscoped —
//     anyone who opened it saw every client's content.
//   - Its client-facing "review" page (review.html) took the agent to show
//     from a plain ?agent=<id>&batch=<id> URL with zero auth check — anyone
//     with (or guessing) a link could view AND edit that agent's posts.
//
// This file fixes both, using the exact same identity model Voice DNA
// already proved (admin_allowlist for Mike's team, agents.id = auth user id
// for everyone else):
//   - A signed-in agent can only ever see/edit their OWN posts — agentId is
//     always re-derived server-side from their verified session, never
//     trusted from the browser.
//   - Mike's team (admin_allowlist) can look up and act as ANY agent — the
//     "log into anyone's and just do it for them" upsell flow — but every
//     single action re-checks the allowlist fresh, and every write is
//     re-verified against the row it's touching before it's allowed.
// ============================================================================

export type MarketingAccess =
  | { role: "admin" }
  | { role: "agent"; agentId: string; agentName: string }
  | { role: "none" };

async function resolveAccess(userId: string, email: string | undefined): Promise<MarketingAccess> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  if (email) {
    const { data: allow } = await supabaseAdmin
      .from("admin_allowlist")
      .select("email")
      .eq("email", email.toLowerCase().trim())
      .maybeSingle();
    if (allow) return { role: "admin" };
  }

  const { data: agent } = await supabaseAdmin.from("agents").select("id, full_name").eq("id", userId).maybeSingle();
  if (agent) {
    return { role: "agent", agentId: agent.id, agentName: agent.full_name ?? "Your account" };
  }

  return { role: "none" };
}

export const getMarketingAccess = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<MarketingAccess> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    return resolveAccess(context.userId, email);
  });

// Admin-only picker — every agent in the system, so Mike's team can pick who
// to work as. Only ever returned to a caller resolveAccess already confirmed
// is on admin_allowlist.
export const listMarketingAgents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    const access = await resolveAccess(context.userId, email);
    if (access.role !== "admin") {
      throw new Error("Only team members can view the agent list.");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("agents")
      .select("id, full_name, market_area, email")
      .order("full_name", { ascending: true });
    if (error) throw error;
    return data;
  });

// Shared guard used by every per-agent action below — re-resolves the
// caller's access on every call (never trusts an agentId the browser sends)
// so an agent can never read or edit someone else's content, and an admin's
// access is always verified fresh rather than cached client-side.
async function requireAgentAccess(userId: string, email: string | undefined, requestedAgentId: string): Promise<void> {
  const access = await resolveAccess(userId, email);
  if (access.role === "admin") return;
  if (access.role === "agent" && access.agentId === requestedAgentId) return;
  throw new Error("Not authorized for this agent's content");
}

// Guards for the shared content calendar below — it isn't scoped to any one
// agent (every agent reads the same months/items), so these check the
// caller's role directly rather than re-deriving a specific agentId match.
async function requireAnyMarketingAccess(userId: string, email: string | undefined): Promise<void> {
  const access = await resolveAccess(userId, email);
  if (access.role === "none") throw new Error("You don't have access to Monthly Marketing.");
}

async function requireAdmin(userId: string, email: string | undefined): Promise<void> {
  const access = await resolveAccess(userId, email);
  if (access.role !== "admin") throw new Error("Only team members can manage the content calendar.");
}

export type PostMetadata = {
  batch_id?: string | undefined;
  canva_link?: string | undefined;
  canva_instructions?: string | null | undefined;
  goal?: string | undefined;
  image_suggestion?: string | undefined;
  source?: string | undefined;
  drive_file_id?: string | undefined;
  drive_thumbnail_url?: string | undefined;
  media_id?: string | null | undefined;
  media_url?: string | null | undefined;
  media_type?: string | null | undefined;
  // Set when a photo was picked from Unsplash on the per-post picker (added
  // 2026-09-18, per Mike's request for a stock-photo option — mainly meant
  // for emails, whose photos don't come from an agent's own Drive/library).
  // Unsplash's API terms require visible photographer credit on any hotlinked
  // image, so these travel with the post specifically so the UI can render
  // that credit line next to the photo.
  unsplash_photographer?: string | null | undefined;
  unsplash_credit_url?: string | null | undefined;
  // Up to 3 photos attached to an EMAIL specifically — added 2026-09-21 per
  // Mike: "Emails should have the ability to include up to 3 photos from
  // any combination. Those images would come with publishing instructions."
  // A post still only ever has one photo (the media_id/drive_file_id/
  // unsplash_* fields above), so this is deliberately separate rather than
  // turning those into arrays. See the EmailPhoto type and the
  // addEmailPhotoFrom.../updateEmailPhotoInstructions/removeEmailPhoto
  // functions below.
  email_photos?: EmailPhoto[] | undefined;
  [key: string]: string | number | boolean | null | undefined | EmailPhoto[];
};

// Fixed tag vocabulary for the native Media library, ported from the old
// app's separate "Tag Photos" screen (PHOTO_TAGS) so the team keys in the
// same categories they already know — folded into the Media tab itself here
// instead of a separate screen, since there's no Drive-scan step to hang a
// separate screen off of. Exported so the Media tab's tag chips use the
// exact same list the matching logic below understands.
export const PHOTO_TAG_OPTIONS = [
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

// Buckets each fixed tag into one of the same four categories the old app's
// classifyPostType()/classifyPhotoType() used. The old app derived a
// photo's category from a freeform tags string via regex; ours has a fixed
// fixed vocabulary instead (set from the Media tab's tag chips), so this is
// a direct lookup rather than a regex — same four buckets, same intent:
// never put a family/appreciation photo on a straight business post or vice
// versa.
const TAG_CATEGORY: Record<string, "real_estate" | "appreciation" | "community" | "neutral"> = {
  "desk or work": "real_estate",
  "listing or property": "real_estate",
  "with clients": "appreciation",
  family: "appreciation",
  "holiday or seasonal": "appreciation",
  "community event": "community",
  "outdoor portrait": "community",
  "neighborhood walk": "community",
  "coffee or local spot": "community",
  "casual lifestyle": "community",
  "car or on the go": "neutral",
  "behind the scenes": "neutral",
};

// Ported from the old app's classifyPostType() — same keyword signals, same
// four buckets: real estate business posts, appreciation/thank-you posts,
// community/lifestyle posts, or neutral.
function classifyPostType(titleAndCopy: string): "real_estate" | "appreciation" | "community" | "neutral" {
  const text = (titleAndCopy || "").toLowerCase();
  const isRealEstate =
    /list|sold|closing|deal|market|buyer|seller|home|house|property|showing|offer|contract|price|rate|mortgage|commission|referral.*business|database|client|agent|real estate|escrow|inspection|title|pending|equity|invest/.test(
      text,
    );
  const isAppreciation =
    /thank|referral|grateful|appreciate|honor|trust|introduce|word of mouth|client.*friend|friend.*client|mean a lot|support/.test(
      text,
    );
  const isCommunity =
    /local|town|community|neighborhood|area|restaurant|coffee|spot|weekend|summer|fall|spring|winter|beach|park|trail|family|kids|life|morning|routine|enjoy|love where|live here/.test(
      text,
    );
  if (isAppreciation) return "appreciation";
  if (isRealEstate && !isCommunity) return "real_estate";
  if (isCommunity && !isRealEstate) return "community";
  return "neutral";
}

// Ported from the old app's getPreferredPhotoTypes() — the ranked list of
// photo categories acceptable for each post category, best match first.
function getPreferredPhotoTypes(postType: "real_estate" | "appreciation" | "community" | "neutral"): string[] {
  switch (postType) {
    case "real_estate":
      return ["real_estate", "neutral", "video"];
    case "appreciation":
      return ["appreciation", "community", "neutral"];
    case "community":
      return ["community", "appreciation", "neutral"];
    default:
      return ["neutral", "community", "real_estate", "appreciation"];
  }
}

function classifyMediaCategory(tags: string[], mediaType: string): string {
  if (mediaType === "video") return "video";
  for (const tag of tags) {
    const category = TAG_CATEGORY[tag];
    if (category) return category;
  }
  return "neutral";
}

// A suggestion can come from either photo source this app has — the native
// Media Library (which we can mark "used" automatically once approved) or
// the agent's connected Google Drive folder (read-only — see the note on
// verifyDriveFolderAccessible above about why this integration can't write
// back to Drive). The two need different fields written onto the post
// (media_id/media_url vs. drive_file_id/drive_thumbnail_url), so callers
// switch on `source` rather than assuming one shape.
type SuggestedMediaPick =
  | { source: "media"; id: string; url: string; mediaType: string }
  | { source: "drive"; driveFileId: string; driveThumbnailUrl: string; mediaType: string };

// Auto-suggests a photo/video per post from BOTH of the agent's photo
// sources — the native Media library (the "available" pool) and, as of
// 2026-09-18, their connected Google Drive folder too — one request per
// post, each carrying that post's own image direction/title/copy so the
// match is per-post, not one pick reused for the whole batch.
//
// Drive was added per Mike's report the same day that "a lot of photos
// weren't automatically populating" when he ran the content calendar: this
// function previously only ever looked at agent_photos, so any agent whose
// available photos mostly still live in Drive (the common case for
// longer-running clients — native upload is the newer path) came up with
// nothing to suggest for most or all of a batch. Pulling in the same live
// Drive listing the Google Drive tab already uses fixes that directly.
//
// This is the native replacement for the old app's Drive-tag matchPhoto():
// now that the Media tab has a tagging UI (2026-09-17), a Media Library item
// is matched by its tag's category the same way matchPhoto() worked — same
// post/photo category buckets, same "don't put a family photo on a business
// post" rule. A Drive file carries no tag data at all, so it's scored as
// "neutral" (the same safe default an untagged Media Library item gets) —
// this is a real, honest limitation, not a bug: matching a Drive photo by
// what it actually shows (the way Photo Scan's AI captioning reads a photo)
// would mean a vision call per candidate photo on every single generation,
// which is a real latency/cost tradeoff worth deciding on deliberately
// rather than building silently — flagged back to Mike rather than assumed.
// FIFO (oldest-first for Media Library; Drive's own listing order otherwise)
// is the tiebreak within a category, same as before. The "Change photo"
// picker on each post still lets the team override the suggestion, logged to
// feedback_history as a learning signal, same as always.
async function assignSuggestedMedia(
  agentId: string,
  requests: { direction?: string | null; title?: string | null; copy?: string | null }[],
): Promise<(SuggestedMediaPick | null)[]> {
  if (!requests.length) return [];
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("agent_photos")
    .select("id, url, media_type, tags, created_at")
    .eq("agent_id", agentId)
    .eq("status", "available")
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) throw error;

  type Candidate = { key: string; category: string; pick: SuggestedMediaPick };

  const candidates: Candidate[] = (data ?? [])
    .filter((m) => Boolean(m.url))
    .map((m) => ({
      key: `media:${m.id}`,
      category: classifyMediaCategory(m.tags ?? [], m.media_type),
      pick: { source: "media", id: m.id, url: m.url as string, mediaType: m.media_type },
    }));

  // Best-effort: any failure here (no GOOGLE_API_KEY, no folder set, a
  // private/unshared folder, a transient Drive API error) just means Drive
  // contributes zero candidates for this run — it never blocks or fails the
  // batch. A generation should always deliver its best guess with whatever
  // photo source actually works, not error out over an optional one.
  try {
    const { data: agent } = await supabaseAdmin
      .from("agents")
      .select("drive_folder_id")
      .eq("id", agentId)
      .maybeSingle();
    const folderId = agent?.drive_folder_id ?? null;
    const apiKey = process.env["GOOGLE_API_KEY"];
    if (folderId && apiKey) {
      const files = await fetchDriveMediaFiles(folderId, apiKey);
      for (const f of files) {
        candidates.push({
          key: `drive:${f.id}`,
          category: f.isVideo ? "video" : "neutral",
          pick: {
            source: "drive",
            driveFileId: f.id,
            driveThumbnailUrl: f.thumbnailUrl,
            mediaType: f.isVideo ? "video" : "image",
          },
        });
      }
    }
  } catch {
    // Drive is an optional extra source here — see comment above.
  }

  if (!candidates.length) return requests.map(() => null);

  const assignedThisBatch = new Set<string>();

  return requests.map((req) => {
    const combinedText = `${req.direction || ""} ${req.title || ""} ${req.copy || ""}`;
    const postType = classifyPostType(combinedText);
    const preferredTypes = getPreferredPhotoTypes(postType);
    const preferVideo = /clip|reel|video|b-?roll|footage|walking through|short form/i.test(req.direction || "");

    // Prefer media not already handed to an earlier post in this same batch;
    // if that empties the pool (more posts than available media), reset and
    // allow repeats rather than leaving a post with nothing — same fallback
    // the old app used once it ran out of unused photos.
    let pool = candidates.filter((c) => !assignedThisBatch.has(c.key));
    if (!pool.length) pool = candidates;

    const scored = pool
      .map((c) => {
        let score = preferredTypes.indexOf(c.category);
        if (score === -1) score = preferredTypes.length;
        if (preferVideo && c.category === "video") score -= 0.5;
        // Tiny tiebreak toward a Media Library pick over a Drive pick when
        // everything else scores equal — a Media Library item is the one
        // this app can actually mark "used" automatically once the post is
        // approved (see approveBatch/approveAllPending); a Drive pick can't
        // be, since this integration only ever has read access to Drive.
        if (c.pick.source === "drive") score += 0.1;
        return { c, score };
      })
      .sort((a, b) => a.score - b.score);

    const winner = scored[0]?.c ?? null;
    if (!winner) return null;
    assignedThisBatch.add(winner.key);
    return winner.pick;
  });
}

export type PostRow = {
  id: string;
  content: string;
  content_type: string;
  title: string | null;
  platform: string | null;
  status: string;
  month: string | null;
  scheduled_for: string | null;
  created_at: string;
  archived: boolean;
  metadata: PostMetadata | null;
};

export const listMarketingPosts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; month?: string; archivedOnly?: boolean }) => data)
  .handler(async ({ data, context }): Promise<PostRow[]> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    let query = supabaseAdmin
      .from("generated_posts")
      .select(
        "id, content, content_type, title, platform, status, month, scheduled_for, created_at, archived, metadata",
      )
      .eq("agent_id", data.agentId)
      // Archived content (2026-09-20, see archiveMonthContent below) is
      // hidden from the normal list by default — that's the whole point of
      // archiving a month's test batch: get it out of the way so "Generate
      // Now" can be run again cleanly. Pass archivedOnly to see just the
      // archived history instead (used by the "view archived" list).
      .eq("archived", Boolean(data.archivedOnly))
      // Secondary tiebreak on `id` — REAL BUG FIX (2026-09-18). Every post in
      // one calendar batch is written in a single bulk insert, so posts from
      // the same batch (e.g. two emails) can end up with the exact same
      // `created_at` timestamp. `ORDER BY created_at` alone leaves ties in an
      // UNDEFINED order in Postgres — in practice it's whatever the rows'
      // current physical position happens to be, which an UPDATE can change
      // (Postgres writes an updated row as a new row version). That's exactly
      // what was happening here: picking a photo for one email calls
      // setPostUnsplashPhoto/setPostMedia, which UPDATEs that one row, then
      // the picker's onChanged() re-fetches this exact list — and a tied pair
      // could come back in a different order than before, so the photo you
      // just watched attach to "the email in slot 2" visually reappears on
      // whatever email now occupies slot 2. This is Mike's report (2026-09-18):
      // "when I select a photo to use it's placed in the other email and not
      // the one I selected it for" — the save was always going to the right
      // row, only the on-screen ordering was unstable. Adding `id` as a
      // secondary sort gives every fetch of this list one single, repeatable
      // order regardless of ties or intervening updates.
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });
    if (data.month) query = query.eq("month", data.month);
    const { data: posts, error } = await query;
    if (error) throw error;
    return (posts ?? []) as unknown as PostRow[];
  });

// Shared by approveBatch and approveAllPending below — marks every photo/
// video attached to a just-approved batch of posts "used," across BOTH
// sources at once (Media Library rows via a real status flag, Drive files
// via our own agent_drive_used_files tracking — see markDriveFileUsed's
// comment for why Drive can't be a real folder move). Added/split out
// 2026-09-21 after Mike reported "photos on the approve all did not move,
// they need to move to the used folder in both media library and google
// drive as well" — previously only the media_id half of this existed here;
// a Drive-sourced photo on an approved post was never marked used at all.
async function markAttachedMediaUsedForBatch(
  supabaseAdmin: (typeof import("@/integrations/supabase/client.server"))["supabaseAdmin"],
  agentId: string,
  rows: { id: string; metadata: unknown }[],
): Promise<void> {
  const mediaIds = Array.from(
    new Set(rows.map((r) => (r.metadata as PostMetadata | null)?.media_id).filter((id): id is string => Boolean(id))),
  );
  if (mediaIds.length) {
    await supabaseAdmin
      .from("agent_photos")
      .update({ status: "used", used_at: new Date().toISOString() })
      .in("id", mediaIds)
      .eq("status", "available");
  }

  const driveFileIds = Array.from(
    new Set(
      rows.map((r) => (r.metadata as PostMetadata | null)?.drive_file_id).filter((id): id is string => Boolean(id)),
    ),
  );
  if (driveFileIds.length) {
    await supabaseAdmin.from("agent_drive_used_files").upsert(
      driveFileIds.map((driveFileId) => ({
        agent_id: agentId,
        drive_file_id: driveFileId,
        used_at: new Date().toISOString(),
      })),
      { onConflict: "agent_id,drive_file_id" },
    );
  }
}

export const approveBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; batchId: string }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true; updated: number }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error: fetchErr } = await supabaseAdmin
      .from("generated_posts")
      .select("id, metadata")
      .eq("agent_id", data.agentId)
      .eq("metadata->>batch_id", data.batchId);
    if (fetchErr) throw fetchErr;
    const ids = (rows ?? []).map((r) => r.id);
    if (!ids.length) return { ok: true, updated: 0 };
    const { error } = await supabaseAdmin
      .from("generated_posts")
      .update({ status: "approved", updated_at: new Date().toISOString() })
      .in("id", ids);
    if (error) throw error;

    // Same auto-mark-used behavior as the single-post approve path, applied
    // to the whole batch at once, across both photo sources.
    await markAttachedMediaUsedForBatch(supabaseAdmin, data.agentId, rows ?? []);

    return { ok: true, updated: ids.length };
  });

// Bulk-approves every not-yet-approved post for this agent (optionally
// scoped to one month) — added per Mike's request (2026-09-17) for the Posts
// tab, which had no "approve all" of its own (only a calendar batch did, via
// approveBatch above). Same auto-mark-used-media behavior as the other two
// approve paths.
export const approveAllPending = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; month?: string }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true; updated: number }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    let query = supabaseAdmin
      .from("generated_posts")
      .select("id, metadata")
      .eq("agent_id", data.agentId)
      .neq("status", "approved");
    if (data.month) query = query.eq("month", data.month);
    const { data: rows, error: fetchErr } = await query;
    if (fetchErr) throw fetchErr;
    const ids = (rows ?? []).map((r) => r.id);
    if (!ids.length) return { ok: true, updated: 0 };
    const { error } = await supabaseAdmin
      .from("generated_posts")
      .update({ status: "approved", updated_at: new Date().toISOString() })
      .in("id", ids);
    if (error) throw error;

    await markAttachedMediaUsedForBatch(supabaseAdmin, data.agentId, rows ?? []);

    return { ok: true, updated: ids.length };
  });

export const listMarketingMonths = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string }) => data)
  .handler(async ({ data, context }): Promise<string[]> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error } = await supabaseAdmin
      .from("generated_posts")
      .select("month")
      .eq("agent_id", data.agentId);
    if (error) throw error;
    const months = Array.from(new Set((rows ?? []).map((r) => r.month).filter((m): m is string => Boolean(m))));
    months.sort();
    months.reverse();
    return months;
  });

export const updateMarketingPost = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; postId: string; content?: string; status?: string }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Belt-and-suspenders: confirm the row we're about to touch actually
    // belongs to the agentId we just verified access for, so a postId alone
    // can never reach into a different agent's row.
    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from("generated_posts")
      .select("agent_id, metadata")
      .eq("id", data.postId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!existing || existing.agent_id !== data.agentId) {
      throw new Error("Post not found for this agent.");
    }

    const update: { updated_at: string; content?: string; status?: string } = {
      updated_at: new Date().toISOString(),
    };
    if (data.content !== undefined) update.content = data.content;
    if (data.status !== undefined) update.status = data.status;

    const { error } = await supabaseAdmin.from("generated_posts").update(update).eq("id", data.postId);
    if (error) throw error;

    // Auto-mark the attached photo/video "used" the moment a post is
    // approved — the native equivalent of the old app's move-to-used, which
    // also only ever fired once content was actually approved, never at
    // suggestion time. As of 2026-09-21, this covers a Drive-sourced photo
    // too, not just a Media Library one — see markDriveFileUsed above for
    // why Drive's version is a DB flag rather than an actual Drive move.
    if (data.status === "approved") {
      const meta = existing.metadata as PostMetadata | null;
      const mediaId = meta?.media_id;
      if (mediaId) {
        await supabaseAdmin
          .from("agent_photos")
          .update({ status: "used", used_at: new Date().toISOString(), used_in_post_id: data.postId })
          .eq("id", mediaId)
          .eq("status", "available");
      }
      const driveFileId = meta?.drive_file_id;
      if (driveFileId) {
        await supabaseAdmin.from("agent_drive_used_files").upsert(
          {
            agent_id: data.agentId,
            drive_file_id: driveFileId,
            used_at: new Date().toISOString(),
            used_in_post_id: data.postId,
          },
          { onConflict: "agent_id,drive_file_id" },
        );
      }
    }

    return { ok: true };
  });

// Lets the team swap the auto-suggested photo/video on a post for a
// different one from this agent's native Media library, or remove it
// entirely (mediaId: null). Ported concept from the old app's photo picker —
// including logging the swap to feedback_history as a learning signal, same
// as the old app did when a VA picked something other than the suggestion.
export const setPostMedia = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; postId: string; mediaId: string | null }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from("generated_posts")
      .select("agent_id, metadata")
      .eq("id", data.postId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!existing || existing.agent_id !== data.agentId) {
      throw new Error("Post not found for this agent.");
    }
    const prevMediaId = (existing.metadata as PostMetadata | null)?.media_id ?? null;

    let mediaUrl: string | null = null;
    let mediaType: string | null = null;
    if (data.mediaId) {
      const { data: media, error: mediaErr } = await supabaseAdmin
        .from("agent_photos")
        .select("id, url, media_type, agent_id")
        .eq("id", data.mediaId)
        .maybeSingle();
      if (mediaErr) throw mediaErr;
      if (!media || media.agent_id !== data.agentId) {
        throw new Error("That media item doesn't belong to this agent.");
      }
      mediaUrl = media.url;
      mediaType = media.media_type;
    }

    const nextMetadata = {
      ...((existing.metadata as Record<string, unknown> | null) ?? {}),
      media_id: data.mediaId,
      media_url: mediaUrl,
      media_type: mediaType,
      // Clear out any Drive/Unsplash photo that was attached before — a post
      // only ever shows one photo, and without this a stale drive_file_id or
      // Unsplash credit could keep hanging around after switching sources.
      drive_file_id: null,
      drive_thumbnail_url: null,
      unsplash_photographer: null,
      unsplash_credit_url: null,
    };

    const { error } = await supabaseAdmin
      .from("generated_posts")
      .update({ metadata: nextMetadata, updated_at: new Date().toISOString() })
      .eq("id", data.postId);
    if (error) throw error;

    if (data.mediaId !== prevMediaId) {
      await supabaseAdmin.from("feedback_history").insert({
        agent_id: data.agentId,
        post_id: data.postId,
        rating: "photo_changed",
        notes: data.mediaId
          ? `Photo changed to media ${data.mediaId}${prevMediaId ? ` (was ${prevMediaId})` : ""}.`
          : `Photo removed${prevMediaId ? ` (was ${prevMediaId})` : ""}.`,
      });
    }

    return { ok: true };
  });

// Attaches a photo straight from the agent's connected Google Drive folder
// to a post — the "Change photo" panel's Google Drive tab (added 2026-09-18
// per Mike's request; previously the panel only offered the native Media
// Library, with no way to reach the Drive folder that already existed).
// Mirrors setPostMedia above but writes drive_file_id/drive_thumbnail_url
// instead of a media_id, and clears the media-library + Unsplash fields so
// only one photo source is ever active on a post at a time.
export const setPostDrivePhoto = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; postId: string; driveFileId: string; thumbnailUrl: string }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from("generated_posts")
      .select("agent_id, metadata")
      .eq("id", data.postId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!existing || existing.agent_id !== data.agentId) {
      throw new Error("Post not found for this agent.");
    }

    const nextMetadata = {
      ...((existing.metadata as Record<string, unknown> | null) ?? {}),
      drive_file_id: data.driveFileId,
      drive_thumbnail_url: data.thumbnailUrl,
      media_id: null,
      media_url: null,
      media_type: null,
      unsplash_photographer: null,
      unsplash_credit_url: null,
    };

    const { error } = await supabaseAdmin
      .from("generated_posts")
      .update({ metadata: nextMetadata, updated_at: new Date().toISOString() })
      .eq("id", data.postId);
    if (error) throw error;

    await supabaseAdmin.from("feedback_history").insert({
      agent_id: data.agentId,
      post_id: data.postId,
      rating: "photo_changed",
      notes: `Photo changed to Drive file ${data.driveFileId}.`,
    });

    return { ok: true };
  });

// Searches Unsplash for free stock photos and attaches one to a post — added
// 2026-09-18 per Mike's request: emails in particular never had a photo
// option (they don't draw from an agent's own Drive/library the way posts
// do), and the old app used Unsplash for exactly this. Requires an
// UNSPLASH_ACCESS_KEY (a free Unsplash Developer account/app), same
// self-explaining-when-missing pattern as GOOGLE_API_KEY/ANTHROPIC_API_KEY.
export type UnsplashResult = {
  id: string;
  thumbUrl: string;
  fullUrl: string;
  photographerName: string;
  photographerProfileUrl: string;
  unsplashPageUrl: string;
};

export const searchUnsplashPhotos = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; query: string }) => data)
  .handler(async ({ data, context }): Promise<{ results: UnsplashResult[] }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    // .trim() guards against a stray leading/trailing space or newline from
    // copy-pasting the key into Lovable Cloud → Secrets — that alone is
    // enough to make Unsplash reject it with "OAuth error: The access token
    // is invalid" (2026-09-18: Mike hit exactly this error after adding a
    // key). Confirmed against Unsplash's current API docs that `client_id`
    // as a query param is the correct, supported auth method here (the
    // alternative is an `Authorization: Client-ID <key>` header — same
    // credential, same result), so that error means the value Unsplash
    // received didn't match a real access key, not a request-shape bug.
    // The most common causes: the Secret Key was pasted instead of the
    // Access Key (an Unsplash app has both, only the Access Key works here),
    // or whitespace around the value.
    const key = process.env["UNSPLASH_ACCESS_KEY"]?.trim();
    if (!key) {
      throw new Error(
        "Stock photos aren't connected yet — add UNSPLASH_ACCESS_KEY in Lovable Cloud → Secrets (free at unsplash.com/developers).",
      );
    }
    const query = data.query.trim() || "lifestyle";
    const url =
      "https://api.unsplash.com/search/photos?per_page=8&query=" + encodeURIComponent(query) + "&client_id=" + key;
    const res = await fetch(url);
    // Read as text first, then parse — added 2026-09-18 after Mike reported
    // stock photos "still not pulling" with no error text to go on. A plain
    // `res.json()` here throws an opaque "Unexpected token..." parse error
    // whenever Unsplash's response body isn't JSON, which happens on at
    // least one real, common case this app hadn't accounted for: a brand
    // new Unsplash app starts in "Demo" mode, capped at 50 requests/hour,
    // and once that's exceeded the response isn't always the clean JSON
    // error body the code below expects. Reading as text first means a
    // non-JSON response now surfaces a clear, specific message instead of a
    // cryptic parser crash — and the rate-limit case gets its own explicit
    // explanation rather than falling through to a generic one.
    const bodyText = await res.text();
    let json: {
      results?: {
        id: string;
        urls?: { small?: string; regular?: string };
        links?: { html?: string };
        user?: { name?: string; links?: { html?: string } };
      }[];
      errors?: string[];
    };
    try {
      json = JSON.parse(bodyText);
    } catch {
      if (res.status === 403 || res.status === 429) {
        throw new Error(
          `Unsplash blocked this request (status ${res.status}) — likely the app's Demo-mode limit of 50 requests/hour. If stock photos have been used a lot this hour, wait a bit, or apply for production access at unsplash.com/oauth/applications to raise that limit.`,
        );
      }
      throw new Error(
        `Unsplash returned an unexpected (non-JSON) response, status ${res.status}. First part of the response: ${bodyText.slice(0, 200)}`,
      );
    }
    if (!res.ok) {
      const apiError = json.errors?.[0] ?? `Unsplash API error (${res.status})`;
      throw new Error(
        /access token is invalid/i.test(apiError)
          ? `${apiError} — double check UNSPLASH_ACCESS_KEY in Lovable Cloud → Secrets is the app's "Access Key" (not the "Secret Key"), pasted with no extra spaces.`
          : /rate limit/i.test(apiError)
            ? `${apiError} — this Unsplash app is likely still in Demo mode (50 requests/hour cap). Apply for production access at unsplash.com/oauth/applications to raise that limit.`
            : apiError,
      );
    }
    const results: UnsplashResult[] = (json.results ?? [])
      .filter((r) => r.urls?.small && r.urls?.regular)
      .slice(0, 8)
      .map((r) => ({
        id: r.id,
        thumbUrl: r.urls!.small!,
        fullUrl: r.urls!.regular!,
        photographerName: r.user?.name ?? "Unsplash photographer",
        photographerProfileUrl: r.user?.links?.html ?? "https://unsplash.com",
        unsplashPageUrl: r.links?.html ?? "https://unsplash.com",
      }));
    return { results };
  });

export const setPostUnsplashPhoto = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (data: {
      agentId: string;
      postId: string;
      photoUrl: string;
      photographerName: string;
      photographerProfileUrl: string;
    }) => data,
  )
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from("generated_posts")
      .select("agent_id, metadata")
      .eq("id", data.postId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!existing || existing.agent_id !== data.agentId) {
      throw new Error("Post not found for this agent.");
    }

    const nextMetadata = {
      ...((existing.metadata as Record<string, unknown> | null) ?? {}),
      media_id: null,
      media_url: data.photoUrl,
      media_type: "image",
      drive_file_id: null,
      drive_thumbnail_url: null,
      unsplash_photographer: data.photographerName,
      unsplash_credit_url: data.photographerProfileUrl,
    };

    const { error } = await supabaseAdmin
      .from("generated_posts")
      .update({ metadata: nextMetadata, updated_at: new Date().toISOString() })
      .eq("id", data.postId);
    if (error) throw error;

    await supabaseAdmin.from("feedback_history").insert({
      agent_id: data.agentId,
      post_id: data.postId,
      rating: "photo_changed",
      notes: `Photo changed to an Unsplash photo by ${data.photographerName}.`,
    });

    return { ok: true };
  });

// ============================================================================
// Email multi-photo attachments — added 2026-09-21 per Mike: "Emails should
// have the ability to include up to 3 photos from any combination. Those
// images would come with publishing instructions." A post only ever needs
// one photo (setPostMedia/setPostDrivePhoto/setPostUnsplashPhoto above,
// which all write directly onto PostMetadata's media_id/drive_file_id/
// unsplash_* fields), but an email can hold several at once, from different
// sources, each with its own note for whoever ends up actually publishing
// it — so these live in their own metadata.email_photos array instead of
// turning those single-photo fields into arrays (which would also change
// what every post everywhere reads).
//
// One small function per source (mirrors setPostMedia/setPostDrivePhoto/
// setPostUnsplashPhoto's own split above) plus one to edit an existing
// photo's instructions and one to remove a photo — each does its own
// read-modify-write of metadata.email_photos rather than sharing a
// mid-request cache, which costs an extra round trip per call but keeps
// every one of these obviously correct on its own, which matters more than
// the round trip on a feature nobody calls at any real volume.
// ============================================================================

const MAX_EMAIL_PHOTOS = 3;

// A single photo attached to an email. `id` is a small server-generated key
// used purely so the UI can edit or remove one photo without touching the
// others — it has no meaning beyond that (it is NOT the Media Library
// media_id, the Drive file id, or anything else that identifies the photo
// at its source; those are captured separately below when relevant).
export type EmailPhoto = {
  id: string;
  source: "library" | "drive" | "unsplash";
  url: string;
  mediaType: "photo" | "video";
  publishingInstructions: string;
  driveFileId?: string | null | undefined;
  unsplashPhotographer?: string | null | undefined;
  unsplashCreditUrl?: string | null | undefined;
};

// Fetches a post, confirms it belongs to this agent AND is actually an
// email (multi-photo is email-only — a post keeps the single-photo fields
// above), and returns its current email_photos array (empty if none yet).
// Every function below calls this first.
async function requireEmailPost(agentId: string, postId: string): Promise<EmailPhoto[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: existing, error } = await supabaseAdmin
    .from("generated_posts")
    .select("agent_id, content_type, metadata")
    .eq("id", postId)
    .maybeSingle();
  if (error) throw error;
  if (!existing || existing.agent_id !== agentId) {
    throw new Error("Post not found for this agent.");
  }
  if (existing.content_type !== "email") {
    throw new Error("Multi-photo attachments are only available for emails.");
  }
  const metadata = (existing.metadata as Record<string, unknown> | null) ?? {};
  return Array.isArray(metadata["email_photos"]) ? (metadata["email_photos"] as EmailPhoto[]) : [];
}

// Writes a full replacement email_photos array — every add/edit/remove below
// ends with this, same "spread the existing metadata, overwrite one field"
// shape setPostMedia/setPostDrivePhoto/setPostUnsplashPhoto already use.
async function writeEmailPhotos(postId: string, photos: EmailPhoto[]): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from("generated_posts")
    .select("metadata")
    .eq("id", postId)
    .maybeSingle();
  if (fetchErr) throw fetchErr;
  const nextMetadata = {
    ...((existing?.metadata as Record<string, unknown> | null) ?? {}),
    email_photos: photos,
  };
  const { error } = await supabaseAdmin
    .from("generated_posts")
    .update({ metadata: nextMetadata, updated_at: new Date().toISOString() })
    .eq("id", postId);
  if (error) throw error;
}

// Adds a photo from the agent's own native Media Library — re-verifies the
// media item actually belongs to this agent (same trust level setPostMedia
// already applies to library photos) before trusting its URL.
export const addEmailPhotoFromLibrary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; postId: string; mediaId: string }) => data)
  .handler(async ({ data, context }): Promise<{ photos: EmailPhoto[] }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const photos = await requireEmailPost(data.agentId, data.postId);
    if (photos.length >= MAX_EMAIL_PHOTOS) {
      throw new Error(`Emails can only carry up to ${MAX_EMAIL_PHOTOS} photos — remove one first.`);
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: media, error: mediaErr } = await supabaseAdmin
      .from("agent_photos")
      .select("id, url, media_type, agent_id")
      .eq("id", data.mediaId)
      .maybeSingle();
    if (mediaErr) throw mediaErr;
    if (!media || media.agent_id !== data.agentId || !media.url) {
      throw new Error("That media item doesn't belong to this agent.");
    }

    const next: EmailPhoto[] = [
      ...photos,
      {
        id: crypto.randomUUID(),
        source: "library",
        url: media.url,
        mediaType: media.media_type as "photo" | "video",
        publishingInstructions: "",
      },
    ];
    await writeEmailPhotos(data.postId, next);
    await supabaseAdmin.from("feedback_history").insert({
      agent_id: data.agentId,
      post_id: data.postId,
      rating: "photo_changed",
      notes: `Email photo added from Media Library (${next.length}/${MAX_EMAIL_PHOTOS}).`,
    });
    return { photos: next };
  });

// Adds a photo from the agent's connected Google Drive folder — trusts the
// client-supplied thumbnailUrl as-is, same trust level setPostDrivePhoto
// already applies (the Drive listing itself is what's scoped to this agent;
// nothing further to re-verify against a Drive file id here).
export const addEmailPhotoFromDrive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; postId: string; driveFileId: string; thumbnailUrl: string }) => data)
  .handler(async ({ data, context }): Promise<{ photos: EmailPhoto[] }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const photos = await requireEmailPost(data.agentId, data.postId);
    if (photos.length >= MAX_EMAIL_PHOTOS) {
      throw new Error(`Emails can only carry up to ${MAX_EMAIL_PHOTOS} photos — remove one first.`);
    }

    const next: EmailPhoto[] = [
      ...photos,
      {
        id: crypto.randomUUID(),
        source: "drive",
        url: data.thumbnailUrl,
        mediaType: "photo",
        driveFileId: data.driveFileId,
        publishingInstructions: "",
      },
    ];
    await writeEmailPhotos(data.postId, next);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("feedback_history").insert({
      agent_id: data.agentId,
      post_id: data.postId,
      rating: "photo_changed",
      notes: `Email photo added from Google Drive (${next.length}/${MAX_EMAIL_PHOTOS}).`,
    });
    return { photos: next };
  });

// Adds a photo from Unsplash — trusts the client-supplied photo URL as-is,
// same trust level setPostUnsplashPhoto already applies (the URL only ever
// comes from a live searchUnsplashPhotos result, never typed in by hand).
export const addEmailPhotoFromUnsplash = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (data: {
      agentId: string;
      postId: string;
      photoUrl: string;
      photographerName: string;
      photographerProfileUrl: string;
    }) => data,
  )
  .handler(async ({ data, context }): Promise<{ photos: EmailPhoto[] }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const photos = await requireEmailPost(data.agentId, data.postId);
    if (photos.length >= MAX_EMAIL_PHOTOS) {
      throw new Error(`Emails can only carry up to ${MAX_EMAIL_PHOTOS} photos — remove one first.`);
    }

    const next: EmailPhoto[] = [
      ...photos,
      {
        id: crypto.randomUUID(),
        source: "unsplash",
        url: data.photoUrl,
        mediaType: "photo",
        unsplashPhotographer: data.photographerName,
        unsplashCreditUrl: data.photographerProfileUrl,
        publishingInstructions: "",
      },
    ];
    await writeEmailPhotos(data.postId, next);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("feedback_history").insert({
      agent_id: data.agentId,
      post_id: data.postId,
      rating: "photo_changed",
      notes: `Email photo added from Unsplash (${next.length}/${MAX_EMAIL_PHOTOS}).`,
    });
    return { photos: next };
  });

// Edits one already-attached email photo's publishing instructions without
// touching the others — the "Publishing instructions" box under each photo
// in the panel saves through this on blur.
export const updateEmailPhotoInstructions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; postId: string; photoId: string; publishingInstructions: string }) => data)
  .handler(async ({ data, context }): Promise<{ photos: EmailPhoto[] }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const photos = await requireEmailPost(data.agentId, data.postId);
    const next = photos.map((p) =>
      p.id === data.photoId ? { ...p, publishingInstructions: data.publishingInstructions } : p,
    );
    await writeEmailPhotos(data.postId, next);
    return { photos: next };
  });

// Removes one attached email photo, leaving the others as-is.
export const removeEmailPhoto = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; postId: string; photoId: string }) => data)
  .handler(async ({ data, context }): Promise<{ photos: EmailPhoto[] }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const photos = await requireEmailPost(data.agentId, data.postId);
    const next = photos.filter((p) => p.id !== data.photoId);
    await writeEmailPhotos(data.postId, next);
    return { photos: next };
  });

export const submitMarketingFeedback = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; postId: string; rating?: string; notes?: string }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from("generated_posts")
      .select("agent_id")
      .eq("id", data.postId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!existing || existing.agent_id !== data.agentId) {
      throw new Error("Post not found for this agent.");
    }

    const { error } = await supabaseAdmin.from("feedback_history").insert({
      agent_id: data.agentId,
      post_id: data.postId,
      rating: data.rating ?? null,
      notes: data.notes ?? null,
    });
    if (error) throw error;
    return { ok: true };
  });

// Regenerates a post/email/video's content in the agent's voice,
// incorporating whatever the reviewer typed into the Flag/feedback panel —
// added per Mike's request (2026-09-17) as the native version of the old
// app's "Rewrite in their voice" button, same prompt shape: keep the
// original concept, apply the feedback exactly, write it in the agent's
// Voice DNA, output only the finished text. Sets the post back to "pending"
// so the rewritten version goes through review again, and logs the round to
// feedback_history as a learning signal, same as the old app did.
export const rewritePostContent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; postId: string; feedback: string }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true; content: string }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const feedback = data.feedback.trim();
    if (!feedback) throw new Error("Tell us what to fix first.");

    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) {
      throw new Error("Rewriting isn't configured yet — add ANTHROPIC_API_KEY in Lovable Cloud → Secrets.");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from("generated_posts")
      .select("agent_id, content, content_type, title")
      .eq("id", data.postId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!existing || existing.agent_id !== data.agentId) {
      throw new Error("Post not found for this agent.");
    }

    const { data: agent, error: agentErr } = await supabaseAdmin
      .from("agents")
      .select("full_name, market_area, voice_summary")
      .eq("id", data.agentId)
      .maybeSingle();
    if (agentErr) throw agentErr;
    const agentName = agent?.full_name ?? "the agent";
    const firstName = agentName.split(" ")[0] || agentName;
    const agentCity = agent?.market_area ?? "their market";
    const dna =
      agent?.voice_summary ?? "Warm, conversational, authentic real estate agent. Short posts. Real human energy.";

    const kind =
      existing.content_type === "email"
        ? "email"
        : existing.content_type === "video"
          ? "video script"
          : "social media post";
    const formatRule =
      existing.content_type === "post"
        ? "4. 2 to 4 sentences max\n"
        : existing.content_type === "video"
          ? "4. Keep the HOOK / BODY / CLOSE format, written to be spoken, 150 words maximum\n"
          : "4. Keep the SUBJECT OPTIONS / EMAIL BODY format\n";
    const learnedFeedback = await fetchLearnedFeedback(data.agentId);
    const prompt =
      `You are rewriting a ${kind} for ${agentName} in ${agentCity}.\n\n` +
      `VOICE DNA (this is how they actually talk):\n${dna}\n\n` +
      (existing.title ? `ORIGINAL CONCEPT: ${existing.title}\n` : "") +
      `CURRENT VERSION:\n${existing.content}\n\n` +
      `FEEDBACK FROM REVIEWER: ${feedback}${learnedFeedback}\n\n` +
      "YOUR JOB:\n" +
      "1. Keep the same concept and emotional core as the current version\n" +
      "2. Apply the feedback exactly as described\n" +
      `3. Write in ${firstName}'s voice based on their Voice DNA above\n` +
      formatRule +
      "5. No hyphens, no corporate language, sounds like a real person, not a brand\n" +
      "6. Standard capitalization always — never write in all lowercase\n" +
      `7. AUTHENTICITY TEST: would ${firstName} actually say this?\n\n` +
      "Output ONLY the rewritten text. Nothing else. No explanation.";

    const maxTokens = existing.content_type === "email" ? 2000 : existing.content_type === "video" ? 600 : 400;
    const raw = await callClaude(apiKey, prompt, maxTokens);
    if (!raw) throw new Error("Empty response from Claude — try again.");
    const rewritten = cleanCopy(raw);

    const { error } = await supabaseAdmin
      .from("generated_posts")
      .update({ content: rewritten, status: "pending", updated_at: new Date().toISOString() })
      .eq("id", data.postId);
    if (error) throw error;

    await supabaseAdmin.from("feedback_history").insert({
      agent_id: data.agentId,
      post_id: data.postId,
      rating: "rewritten",
      notes: `Feedback: "${feedback}" — rewritten in ${agentName}'s voice.`,
    });

    return { ok: true, content: rewritten };
  });

type PhotoRow = {
  id: string;
  url: string | null;
  caption: string | null;
  tags: string[];
  created_at: string;
};

export const listMarketingPhotos = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string }) => data)
  .handler(async ({ data, context }): Promise<PhotoRow[]> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: photos, error } = await supabaseAdmin
      .from("agent_photos")
      .select("id, url, caption, tags, created_at")
      .eq("agent_id", data.agentId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (photos ?? []) as PhotoRow[];
  });

// ============================================================================
// Native media library (photos + short-form video) — lives in Monthly
// Marketing (not Build My Brand) because this is where the files actually
// get used, each month, to generate content. Coexists with Google Drive:
// each agent's `photo_source` ('drive' | 'upload' | 'both') decides which
// pool(s) get queried once content generation is wired up to read this
// (Phase 2) — existing Drive-based agents default to 'drive' and are
// completely unaffected by any of this until that agent is switched.
//
// Direction confirmed by Mike (2026-09-16): we own the media natively going
// forward. Drive gets no further development — the three Drive functions
// already read (drive-photos.js / analyze-photos.js / move-to-used.js) are
// the last Drive code this touches. No hard upload cap: Mike's own point —
// once a photo/video is marked "used" it drops out of the active pool the
// same way Drive's "used" folder does today, so the *visible/active* set
// stays small on its own without needing an artificial ceiling.
// ============================================================================

export type MediaRow = {
  id: string;
  url: string | null;
  caption: string | null;
  tags: string[];
  media_type: "photo" | "video";
  source: "upload" | "drive";
  status: "available" | "used";
  created_at: string;
  used_at: string | null;
};

export const listMarketingMedia = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; status?: "available" | "used" }) => data)
  .handler(async ({ data, context }): Promise<MediaRow[]> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    let query = supabaseAdmin
      .from("agent_photos")
      .select("id, url, caption, tags, media_type, source, status, created_at, used_at")
      .eq("agent_id", data.agentId)
      .order("created_at", { ascending: false });
    if (data.status) query = query.eq("status", data.status);
    const { data: rows, error } = await query;
    if (error) throw error;
    return (rows ?? []) as MediaRow[];
  });

// Step 1 of a native upload: mint a short-lived signed Storage upload URL for
// this exact agent + file, after re-checking the caller actually has access
// to that agent. The browser uploads the raw bytes straight to Storage using
// this URL — the file itself never passes through this server function (no
// base64/JSON relay), so there's no request-size ceiling to worry about for
// video the way there would be if uploads were proxied through here.
export const createMediaUploadUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; fileName: string }) => data)
  .handler(async ({ data, context }): Promise<{ path: string; token: string }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const safeName = data.fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120);
    const path = `${data.agentId}/${crypto.randomUUID()}-${safeName}`;
    const { data: signed, error } = await supabaseAdmin.storage.from("media").createSignedUploadUrl(path);
    if (error) throw error;
    return { path, token: signed.token };
  });

// Step 2: once the browser's direct upload to Storage succeeds, record the
// new media row. Re-checks access again, and re-checks the path itself
// actually belongs to this agent — never trusts anything the browser reports
// back about its own upload.
export const finalizeMediaUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; storagePath: string; mediaType: "photo" | "video"; caption?: string }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true; id: string }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    if (!data.storagePath.startsWith(`${data.agentId}/`)) {
      throw new Error("Upload path does not belong to this agent.");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: pub } = supabaseAdmin.storage.from("media").getPublicUrl(data.storagePath);
    const { data: row, error } = await supabaseAdmin
      .from("agent_photos")
      .insert({
        agent_id: data.agentId,
        url: pub.publicUrl,
        storage_path: data.storagePath,
        media_type: data.mediaType,
        source: "upload",
        status: "available",
        caption: data.caption ?? null,
        tags: [],
      })
      .select("id")
      .single();
    if (error) throw error;
    return { ok: true, id: row.id };
  });

// Sets a media item's tags from the Media tab's tag-chip editor — added per
// Mike's request (2026-09-17) as the native equivalent of the old app's
// separate "Tag Photos" screen, folded into the Media tab itself since
// there's no Drive-scan step here to hang a separate screen off of. These
// tags are exactly what assignSuggestedMedia() above reads to match photos
// to posts by category instead of pure FIFO.
export const setMediaTags = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; mediaId: string; tags: string[] }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from("agent_photos")
      .select("agent_id")
      .eq("id", data.mediaId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!existing || existing.agent_id !== data.agentId) {
      throw new Error("Media not found for this agent.");
    }
    const allowed = new Set<string>(PHOTO_TAG_OPTIONS);
    const tags = Array.from(new Set(data.tags.filter((t) => allowed.has(t))));
    const { error } = await supabaseAdmin
      .from("agent_photos")
      .update({ tags, updated_at: new Date().toISOString() })
      .eq("id", data.mediaId);
    if (error) throw error;
    return { ok: true };
  });

// Marks one or more media items "used" — the native equivalent of Drive's
// move-to-used.js. Moves the row out of the "available" pool for good
// without ever deleting the file, so there's always a record of what got
// used and when (used_at / used_in_post_id). Content generation isn't native
// yet (Phase 2), so nothing calls this automatically on approve yet — the
// Media tab below exposes it as a manual action so the team can mark
// something used the moment it's actually used in a piece of content,
// same as they'd manually confirm today. Wiring this to fire automatically
// on approval is a Phase 2 item once generation records which photo went
// into which post.
export const markMediaUsed = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; mediaIds: string[]; postId?: string }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true; updated: number }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    if (!data.mediaIds.length) return { ok: true, updated: 0 };
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("agent_photos")
      .update({
        status: "used",
        used_at: new Date().toISOString(),
        used_in_post_id: data.postId ?? null,
      })
      .eq("agent_id", data.agentId)
      .in("id", data.mediaIds);
    if (error) throw error;
    return { ok: true, updated: data.mediaIds.length };
  });

// Added 2026-09-21 per Mike: "photos and videos should be able to be moved
// back to active folder form used folder." There was previously no way to
// undo markMediaUsed (or the automatic used-marking on approve) at all —
// once something was used, it stayed used forever. This is the Media
// Library equivalent of restoreDriveFileToActive below; both undo the same
// kind of mistake (marked used too early, or a piece of content got
// deleted/rejected after all) the same way.
export const restoreMediaToAvailable = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; mediaId: string }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("agent_photos")
      .update({ status: "available", used_at: null, used_in_post_id: null })
      .eq("agent_id", data.agentId)
      .eq("id", data.mediaId);
    if (error) throw error;
    return { ok: true };
  });

export const deleteMarketingMedia = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; mediaId: string }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from("agent_photos")
      .select("agent_id, storage_path, source")
      .eq("id", data.mediaId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!existing || existing.agent_id !== data.agentId) {
      throw new Error("Media not found for this agent.");
    }
    if (existing.storage_path) {
      await supabaseAdmin.storage.from("media").remove([existing.storage_path]);
    }
    const { error } = await supabaseAdmin.from("agent_photos").delete().eq("id", data.mediaId);
    if (error) throw error;
    return { ok: true };
  });

// ============================================================================
// Public media-upload link (2026-09-20) — Mike's request: "I want to create
// a simple link I can send them that will open up directly into the Media
// folder no differently than how we share a google drive link. You would
// click to copy and we can send it to anyone who can click on it and then
// upload photos to that media library without logging in." This is the same
// pattern as a Drive "anyone with the link can upload" folder, deliberately
// scoped to upload-only: the public page below can never list, view, or
// delete anything already in an agent's library, and it never exposes
// agentId, email, or any other agent data — only a display name, so admin
// can confirm they're sending the right person the right link.
//
// Access model: instead of the usual session-based requireAgentAccess, these
// three functions carry NO auth middleware at all (they need to work for
// someone who never logs in) and are gated purely by knowing a long random
// per-agent token — never the agent's real id, which could otherwise be
// guessed/enumerated. Getting or regenerating the token itself IS admin-only
// (mirrors setAgentDriveFolder's pattern) and issuing a fresh token
// invalidates whatever link was shared before, the same way Mike could stop
// sharing a Drive folder by moving it or changing its share setting.
// ============================================================================

// Admin-only: read (creating on first use) this agent's public upload token.
export const getMediaUploadLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string }) => data)
  .handler(async ({ data, context }): Promise<{ token: string }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAdmin(context.userId, email);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: agent, error: fetchErr } = await supabaseAdmin
      .from("agents")
      .select("media_upload_token")
      .eq("id", data.agentId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (agent?.media_upload_token) return { token: agent.media_upload_token };
    const token = crypto.randomUUID();
    const { error } = await supabaseAdmin.from("agents").update({ media_upload_token: token }).eq("id", data.agentId);
    if (error) throw error;
    return { token };
  });

// Admin-only: issue a brand-new token, permanently breaking any link already
// shared — for when a link needs to be revoked (sent to the wrong person,
// been floating around too long, etc.).
export const regenerateMediaUploadLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string }) => data)
  .handler(async ({ data, context }): Promise<{ token: string }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAdmin(context.userId, email);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const token = crypto.randomUUID();
    const { error } = await supabaseAdmin.from("agents").update({ media_upload_token: token }).eq("id", data.agentId);
    if (error) throw error;
    return { token };
  });

async function resolveAgentIdFromUploadToken(token: string): Promise<{ agentId: string; agentName: string }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: agent, error } = await supabaseAdmin
    .from("agents")
    .select("id, full_name")
    .eq("media_upload_token", token)
    .maybeSingle();
  if (error) throw error;
  if (!agent) throw new Error("This upload link isn't valid — ask your team for a new one.");
  return { agentId: agent.id, agentName: agent.full_name ?? "this agent" };
}

// Public — no login required. Only ever returns a display name, never the
// agent's real id or any other data about them.
export const getPublicUploadAgent = createServerFn({ method: "POST" })
  .validator((data: { token: string }) => data)
  .handler(async ({ data }): Promise<{ agentName: string }> => {
    const { agentName } = await resolveAgentIdFromUploadToken(data.token);
    return { agentName };
  });

// Public — mints a signed Storage upload URL, exactly like createMediaUploadUrl
// above, but resolving the agent from the token instead of a logged-in
// session. The browser still uploads the raw bytes straight to Storage.
export const createPublicMediaUploadUrl = createServerFn({ method: "POST" })
  .validator((data: { token: string; fileName: string }) => data)
  .handler(async ({ data }): Promise<{ path: string; uploadToken: string }> => {
    const { agentId } = await resolveAgentIdFromUploadToken(data.token);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const safeName = data.fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120);
    const path = `${agentId}/${crypto.randomUUID()}-${safeName}`;
    const { data: signed, error } = await supabaseAdmin.storage.from("media").createSignedUploadUrl(path);
    if (error) throw error;
    return { path, uploadToken: signed.token };
  });

// Public — records the row once the browser's direct upload succeeds, same
// shape as finalizeMediaUpload, resolved via the token instead of a session.
export const finalizePublicMediaUpload = createServerFn({ method: "POST" })
  .validator((data: { token: string; storagePath: string; mediaType: "photo" | "video" }) => data)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { agentId } = await resolveAgentIdFromUploadToken(data.token);
    if (!data.storagePath.startsWith(`${agentId}/`)) {
      throw new Error("Upload path does not belong to this agent.");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: pub } = supabaseAdmin.storage.from("media").getPublicUrl(data.storagePath);
    const { error } = await supabaseAdmin.from("agent_photos").insert({
      agent_id: agentId,
      url: pub.publicUrl,
      storage_path: data.storagePath,
      media_type: data.mediaType,
      source: "upload",
      status: "available",
      tags: [],
    });
    if (error) throw error;
    return { ok: true };
  });

// ============================================================================
// Google Drive tab — Phase 2, requested by Mike (2026-09-16) on top of the
// native media library above. This is a LIVE, read-only view straight from
// the Drive API of what's actually in an agent's existing Drive folder —
// mainly for agents on YMD's video services, who still send long-form
// footage through Drive. It never writes back to Drive; uploading/marking
// used there still happens exactly as it does today, untouched.
//
// This mirrors the old drive-photos.js logic exactly, including excluding
// the "used" subfolder, for parity with however that client's Drive-side
// used-tracking already works.
//
// Needs two things this project didn't have before:
//   1. GOOGLE_API_KEY in Lovable Cloud → Secrets (a Drive-API-enabled key —
//      read-only is enough, the old app only ever used it for listing).
//   2. Each agent's own agents.drive_folder_id set once — there's no bulk
//      migration for this (the old admin UI's folder-ID field was never
//      backed by a table we inherited), so it's set per-agent via
//      setAgentDriveFolder below, either from this tab or an admin screen.
// ============================================================================

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  isVideo: boolean;
  thumbnailUrl: string;
  viewUrl: string;
  // Direct-content endpoint (added 2026-09-21 per Mike: "photos in all
  // libraries should be downloadable") — unlike thumbnailUrl (a small
  // preview) or viewUrl (opens Drive's own viewer), this serves the actual
  // full-resolution file so a person can save it in one click. Works with
  // the same "anyone with the link" sharing this whole integration already
  // requires — no extra permission needed.
  downloadUrl: string;
  // Set only when this file is returned from the "used" side of
  // listAgentDriveMedia (see below) — the moment our own app marked it used,
  // when known. Undefined/omitted on the "available" listing.
  usedAt?: string | null;
};

// This integration authenticates with a plain Drive API key, not real OAuth
// (see the comment block above) — which means it can only ever see files
// and folders that are shared "Anyone with the link" (or fully public).
// A private folder ID saved to an agent's record looks fully "connected" on
// our side (setAgentDriveFolder succeeds, drive_folder_id is set) but the
// Drive API will just quietly act as if it doesn't exist, since the API key
// has no viewer permission on it. Google returns 404 for this case (not
// 403), which reads exactly like a typo'd folder ID, so this checks the
// folder itself first and gives Mike/the agent something actionable instead
// of a silent "no photos found." Added 2026-09-18 per Mike: "I attached a
// google drive folder for this agent but although connected on the admin
// end is not connected on the google drive end." A real per-agent OAuth
// connection (each agent grants their own Drive access) would remove this
// sharing requirement entirely, but is a separate, much bigger project —
// this is the fix available within the current API-key architecture.
async function verifyDriveFolderAccessible(folderId: string, apiKey: string): Promise<void> {
  const metaUrl = `https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name,mimeType&key=${apiKey}`;
  const res = await fetch(metaUrl);
  if (res.ok) return;
  if (res.status === 404) {
    throw new Error(
      "This Drive folder isn't visible yet — it needs to be shared as \"Anyone with the link can view\" in Google Drive (right-click the folder → Share → General access → Anyone with the link) before photos will show up here. This app only reads Drive with an API key, not a full sign-in, so a private folder looks connected on our side but the folder ID isn't enough on its own.",
    );
  }
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  throw new Error(json.error?.message ?? `Google Drive API error (${res.status}) while checking folder access.`);
}

// Real Drive folders are often organized into subfolders (by month, by
// listing, by whatever) rather than one flat pile of files — but Drive's
// query language only matches a file's DIRECT parent ('X' in parents does
// NOT recurse into subfolders), so every Drive listing in this file used to
// silently miss any photo one folder deeper than the one an agent's
// drive_folder_id points at. Added 2026-09-21 per Mike's bug report: "There
// are photos in google drive but its saying there are not. Theres a bug
// that's not reqading them." — the most likely explanation once the folder
// itself is confirmed shared correctly (verifyDriveFolderAccessible already
// rules out the "not shared" case) is exactly this: the photos are one or
// more folders deep inside the shared root.
//
// This walks the folder tree under rootFolderId a few levels deep and
// returns every folder id worth searching for files, skipping the "used"
// subfolder (and everything inside it) entirely so it never needs a
// separate exclusion pass afterward — capped at MAX_DRIVE_FOLDERS so an
// unexpectedly large folder tree can't blow up the files query or make this
// take forever.
const MAX_DRIVE_FOLDER_DEPTH = 4;
const MAX_DRIVE_FOLDERS = 40;

async function listDriveFolderIds(rootFolderId: string, apiKey: string): Promise<string[]> {
  const ids = [rootFolderId];
  let frontier = [rootFolderId];
  for (let depth = 0; depth < MAX_DRIVE_FOLDER_DEPTH && frontier.length && ids.length < MAX_DRIVE_FOLDERS; depth++) {
    const batches = await Promise.all(
      frontier.map(async (parentId) => {
        const url =
          "https://www.googleapis.com/drive/v3/files?" +
          "q=" +
          encodeURIComponent(
            `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
          ) +
          "&fields=files(id,name)&pageSize=100&key=" +
          apiKey;
        try {
          const res = await fetchWithTimeout(url, {}, 15_000);
          const json = (await res.json()) as { files?: { id: string; name: string }[] };
          return json.files ?? [];
        } catch {
          // A slow/failed subfolder lookup shouldn't take down the whole
          // scan — it just means that one branch's photos won't show up
          // this time, same as any other partial-failure spot in this file.
          return [];
        }
      }),
    );
    const nextFrontier: string[] = [];
    for (const folders of batches) {
      for (const f of folders) {
        if (f.name.trim().toLowerCase() === "used") continue; // never descend into the "used" folder or its contents
        if (ids.length >= MAX_DRIVE_FOLDERS) break;
        ids.push(f.id);
        nextFrontier.push(f.id);
      }
    }
    frontier = nextFrontier;
  }
  return ids;
}

function driveParentsClause(folderIds: string[]): string {
  return "(" + folderIds.map((id) => `'${id}' in parents`).join(" or ") + ")";
}

// Sibling to listDriveFolderIds above, walking the exact same tree, but
// doing the OPPOSITE thing with a folder literally named "used": instead of
// skipping it, this collects its id (without descending further into it,
// matching how listDriveFolderIds treats it as a dead end either way). Added
// 2026-09-21 per Mike: "google drive folder Used needs to show" — a legacy
// Drive-workflow agent may already have real photos sitting in an actual
// "used" subfolder (from the old app's move-to-used, or a manual move), and
// until now nothing in this app ever surfaced that folder's contents
// anywhere — it was just silently excluded, full stop.
async function listDriveUsedFolderIds(rootFolderId: string, apiKey: string): Promise<string[]> {
  const usedIds: string[] = [];
  let frontier = [rootFolderId];
  for (
    let depth = 0;
    depth < MAX_DRIVE_FOLDER_DEPTH && frontier.length && usedIds.length < MAX_DRIVE_FOLDERS;
    depth++
  ) {
    const batches = await Promise.all(
      frontier.map(async (parentId) => {
        const url =
          "https://www.googleapis.com/drive/v3/files?" +
          "q=" +
          encodeURIComponent(
            `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
          ) +
          "&fields=files(id,name)&pageSize=100&key=" +
          apiKey;
        try {
          const res = await fetchWithTimeout(url, {}, 15_000);
          const json = (await res.json()) as { files?: { id: string; name: string }[] };
          return json.files ?? [];
        } catch {
          return [];
        }
      }),
    );
    const nextFrontier: string[] = [];
    for (const folders of batches) {
      for (const f of folders) {
        if (f.name.trim().toLowerCase() === "used") {
          usedIds.push(f.id); // found one — don't descend into it
          continue;
        }
        nextFrontier.push(f.id);
      }
    }
    frontier = nextFrontier;
  }
  return usedIds;
}

// A HEIC/HEIF photo (the default format on an iPhone camera) can be listed
// and thumbnailed by Drive just fine, but Claude's vision API can't read
// its bytes — captioning it just fails. Callers filter these out up front
// so a batch of iPhone photos doesn't silently look like "no photos found."
function isHeicDriveFile(f: { name: string; mimeType: string }): boolean {
  return (
    f.mimeType === "image/heif" || f.mimeType === "image/heic" || /\.heic$/i.test(f.name) || /\.heif$/i.test(f.name)
  );
}

// Lists the images/videos actually in a Drive folder (and its subfolders,
// see listDriveFolderIds above), excluding whatever's in a "used" subfolder
// anywhere in that tree — pulled out of listAgentDriveMedia below so
// assignSuggestedMedia() can call the exact same live Drive listing when
// auto-suggesting a photo for a calendar-generated post, not just when an
// agent opens the Google Drive tab. Caller is responsible for having already
// confirmed the folder is accessible (verifyDriveFolderAccessible) if it
// wants a clear error on a private/unshared folder — this function itself
// just throws whatever the Drive API returns.
function mapDriveApiFile(f: { id: string; name: string; mimeType: string }): DriveFile {
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    isVideo: f.mimeType.startsWith("video/"),
    thumbnailUrl: `https://drive.google.com/thumbnail?id=${f.id}&sz=w400`,
    viewUrl: `https://drive.google.com/file/d/${f.id}/view`,
    downloadUrl: `https://drive.google.com/uc?export=download&id=${f.id}`,
  };
}

// Shared by fetchDriveMediaFiles and fetchDriveUsedFiles below — both just
// query "every image/video directly inside this set of folder ids," they
// only differ in which folder ids they pass in (the active tree vs. a
// "used" folder found inside it).
async function queryDriveFilesInFolders(folderIds: string[], apiKey: string): Promise<DriveFile[]> {
  if (!folderIds.length) return [];
  const q = `${driveParentsClause(folderIds)} and (mimeType contains 'image/' or mimeType contains 'video/') and trashed=false`;
  const url =
    "https://www.googleapis.com/drive/v3/files?" +
    "q=" +
    encodeURIComponent(q) +
    "&fields=files(id,name,mimeType)&pageSize=200&key=" +
    apiKey;
  const res = await fetchWithTimeout(url, {}, 15_000);
  const json = (await res.json()) as {
    files?: { id: string; name: string; mimeType: string }[];
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(json.error?.message ?? `Google Drive API error (${res.status})`);
  return (json.files ?? []).map(mapDriveApiFile);
}

async function fetchDriveMediaFiles(folderId: string, apiKey: string): Promise<DriveFile[]> {
  const folderIds = await listDriveFolderIds(folderId, apiKey);
  return queryDriveFilesInFolders(folderIds, apiKey);
}

// The contents of whatever "used" subfolder(s) exist anywhere in this Drive
// folder's tree — added 2026-09-21 alongside listDriveUsedFolderIds above,
// so the "Used" side of the Drive tab has something real to show.
async function fetchDriveUsedFiles(folderId: string, apiKey: string): Promise<DriveFile[]> {
  const usedFolderIds = await listDriveUsedFolderIds(folderId, apiKey);
  return queryDriveFilesInFolders(usedFolderIds, apiKey);
}

// Looks up a specific set of Drive file ids directly (files.get, one call
// per id — Drive v3 has no bulk multi-get without the more involved batch/
// multipart endpoint, and this is only ever called for a handful of ids at
// once: files OUR app has marked "used" that don't already show up in the
// structural "used" folder listing above). A file that's been deleted,
// trashed, or had its sharing revoked since being marked used is silently
// skipped rather than failing the whole listing — the used-tracking row
// stays either way, but there's nothing to render for it.
async function fetchDriveFilesByIds(fileIds: string[], apiKey: string): Promise<DriveFile[]> {
  const results = await Promise.all(
    fileIds.map(async (id) => {
      try {
        const url = `https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,mimeType,trashed&key=${apiKey}`;
        const res = await fetchWithTimeout(url, {}, 15_000);
        if (!res.ok) return null;
        const json = (await res.json()) as { id: string; name: string; mimeType: string; trashed?: boolean };
        if (json.trashed) return null;
        return mapDriveApiFile(json);
      } catch {
        return null;
      }
    }),
  );
  return results.filter((f): f is DriveFile => Boolean(f));
}

export const listAgentDriveMedia = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; status?: "available" | "used" }) => data)
  .handler(async ({ data, context }): Promise<{ folderId: string | null; files: DriveFile[] }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: agent, error: agentErr } = await supabaseAdmin
      .from("agents")
      .select("drive_folder_id")
      .eq("id", data.agentId)
      .maybeSingle();
    if (agentErr) throw agentErr;
    const folderId = agent?.drive_folder_id ?? null;
    if (!folderId) return { folderId: null, files: [] };

    const apiKey = process.env["GOOGLE_API_KEY"];
    if (!apiKey) {
      throw new Error("Google Drive isn't connected yet — add GOOGLE_API_KEY in Lovable Cloud → Secrets.");
    }
    await verifyDriveFolderAccessible(folderId, apiKey);

    // agent_drive_used_files — our own DB-side "used" tracking for Drive
    // photos, added 2026-09-21 (see markDriveFileUsed below for why this
    // exists rather than a real Drive move).
    const { data: trackedRows, error: trackedErr } = await supabaseAdmin
      .from("agent_drive_used_files")
      .select("drive_file_id, used_at")
      .eq("agent_id", data.agentId);
    if (trackedErr) throw trackedErr;
    const trackedUsed = new Map((trackedRows ?? []).map((r) => [r.drive_file_id as string, r.used_at as string]));

    if ((data.status ?? "available") === "used") {
      // Two sources, merged: (1) whatever's structurally sitting inside a
      // real "used" subfolder in Drive right now (a legacy client's old
      // workflow, or a manual move) — see listDriveUsedFolderIds — and
      // (2) anything OUR app has marked used via approve/Mark used, which
      // may or may not also be one of those structural files. De-duped by
      // file id so something in both places only shows once.
      const structural = await fetchDriveUsedFiles(folderId, apiKey);
      const structuralIds = new Set(structural.map((f) => f.id));
      const onlyTrackedIds = Array.from(trackedUsed.keys()).filter((id) => !structuralIds.has(id));
      const trackedOnly = onlyTrackedIds.length ? await fetchDriveFilesByIds(onlyTrackedIds, apiKey) : [];
      const files = [...structural, ...trackedOnly].map((f) => ({
        ...f,
        usedAt: trackedUsed.get(f.id) ?? null,
      }));
      return { folderId, files };
    }

    // "available" — the normal active-tree listing, minus anything we've
    // separately marked used ourselves (covers a file our app marked used
    // that's still physically sitting in a normal, non-"used" folder, since
    // we can't move the real file without Drive write access — see below).
    const files = (await fetchDriveMediaFiles(folderId, apiKey)).filter((f) => !trackedUsed.has(f.id));
    return { folderId, files };
  });

// Added 2026-09-21 per Mike: "photos on the approve all did not move, they
// need to move to the used folder in both media library and google drive as
// well." For the native Media library, "moving to used" was already just a
// status flag on our own row (agent_photos.status) — that part already
// worked. Google Drive has no equivalent at all: this integration only ever
// had a plain, read-only Drive API key (see the big comment block above
// DriveFile), never the OAuth refresh token real Drive WRITES (moving a file
// between folders) require — that's exactly why the old app's actual
// move-to-used.js needed a different kind of credential than everything
// else in this file. Rather than block this fix on setting up Google OAuth
// (a real, separate infra decision), "used" for Drive is tracked the same
// way as Media Library — as our own flag, in our own database — so approve/
// restore work identically for both sources today. The file itself never
// physically moves in the agent's real Drive; if Mike wants Drive-native
// moves later, that needs OAuth credentials from Google Cloud Console,
// which is worth flagging to him as a follow-up rather than assuming.
export const markDriveFileUsed = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; driveFileId: string; postId?: string }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("agent_drive_used_files").upsert(
      {
        agent_id: data.agentId,
        drive_file_id: data.driveFileId,
        used_at: new Date().toISOString(),
        used_in_post_id: data.postId ?? null,
      },
      { onConflict: "agent_id,drive_file_id" },
    );
    if (error) throw error;
    return { ok: true };
  });

// Undoes markDriveFileUsed above — added 2026-09-21 per Mike: "photos and
// videos should be able to be moved back to active folder from used
// folder." Only clears OUR tracking flag. If the file is genuinely sitting
// inside a real "used" subfolder in the agent's actual Drive (the legacy/
// structural case — see fetchDriveUsedFiles), this can't move the real file
// back out of it — that would need the same Drive write access noted above.
// A file this app itself marked used (without any physical move) restores
// fully and correctly either way.
export const restoreDriveFileToActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; driveFileId: string }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("agent_drive_used_files")
      .delete()
      .eq("agent_id", data.agentId)
      .eq("drive_file_id", data.driveFileId);
    if (error) throw error;
    return { ok: true };
  });

// Admin-only — sets which Drive folder a given agent's tab reads from.
export const setAgentDriveFolder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; driveFolderId: string }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    const access = await resolveAccess(context.userId, email);
    if (access.role !== "admin") {
      throw new Error("Only team members can set an agent's Drive folder.");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("agents")
      .update({ drive_folder_id: data.driveFolderId.trim() || null })
      .eq("id", data.agentId);
    if (error) throw error;
    return { ok: true };
  });

// ============================================================================
// Native "Create content" — Phase 2, step 2. The old app sourced post/email/
// video copy from a Google Drive content calendar (content-calendar.js, one
// Doc per post). Per Mike's explicit call (2026-09-16), that gets replaced
// entirely with a native form: the agent (or an admin acting as them) types
// what they want, and this writes a full draft straight into generated_posts
// using the exact same prompt rules/voice logic the old generateAll() used —
// no Drive dependency anywhere in this path. Reuses the agent's existing
// voice_summary (from Voice DNA) as the "Voice DNA" input, same as before.
// ============================================================================

type GenerateContentInput = {
  agentId: string;
  contentType: "post" | "email" | "video";
  title: string;
  goal: string;
  instructions?: string | undefined;
  hook?: string | undefined;
  useHashtags?: boolean | undefined;
};

// Pulls this agent's most recent reviewer feedback (flags and rewrite
// requests — not photo-swap logging, that's not about the writing) and
// formats it as a short block of "lessons" to fold into a generation prompt.
// Added per Mike's explicit ask (2026-09-17): feedback was already being
// SAVED to feedback_history (flag notes, rewrite requests), but nothing ever
// read it back into future generations — so the "gets smarter over time"
// part of the feedback loop wasn't actually happening yet. This is what
// closes that loop: every new draft (native single-item generate, a
// calendar batch, or an AI rewrite) now sees a digest of what reviewers have
// corrected for this agent before and is told to apply those lessons too.
async function fetchLearnedFeedback(agentId: string): Promise<string> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("feedback_history")
    .select("rating, notes")
    .eq("agent_id", agentId)
    .in("rating", ["flagged", "rewritten"])
    .not("notes", "is", null)
    .order("created_at", { ascending: false })
    .limit(8);
  if (error || !data?.length) return "";
  const lines = data.map((r) => `- ${r.notes}`).filter((l) => l.trim() !== "-");
  if (!lines.length) return "";
  return (
    "\n\nLESSONS FROM PAST REVIEWER FEEDBACK FOR THIS AGENT (apply these too, don't repeat these mistakes):\n" +
    lines.join("\n")
  );
}

function buildContentPrompt(
  input: GenerateContentInput,
  agentName: string,
  agentCity: string,
  voiceDna: string,
  learnedFeedback: string,
): string {
  const extra =
    (input.instructions?.trim() ? `\n\nADDITIONAL DIRECTION:\n${input.instructions.trim()}` : "") + learnedFeedback;

  if (input.contentType === "post") {
    return (
      "You are the best real estate social media copywriter in the country. Your specialty: writing posts that remind people someone is in real estate without ever preaching about it. Every post tells a small story. Every post has a clear point. Every post sounds like a real person.\n\n" +
      `You are writing for ${agentName} in ${agentCity}.\n\n` +
      `VOICE DNA:\n${voiceDna}\n\n` +
      `WHAT THIS POST IS ABOUT:\n${input.goal}${extra}\n\n` +
      "RULES — follow every one:\n" +
      "- Write a COMPLETE post. Every sentence must connect to the next. The post must make full sense start to finish.\n" +
      "- Tell a story or make a single clear point.\n" +
      "- 2 to 4 sentences max. Short. Punchy. Human.\n" +
      "- No hyphens used as dashes anywhere\n" +
      '- No "As a real estate professional" or any version of that\n' +
      '- No "Navigating the market" — never\n' +
      "- No corporate language. No buzzwords. No filler.\n" +
      "- Standard capitalization always.\n" +
      "- Real estate should feel like a casual aside, not the whole point\n" +
      "- AUTHENTICITY CHECK: read it out loud — if a real person would never say this, rewrite it.\n" +
      (input.useHashtags ? "- Add 2-3 relevant hashtags at the very end\n" : "- NO hashtags\n") +
      "\nOutput ONLY the finished post text — no title, no labels, no quotation marks."
    );
  }

  if (input.contentType === "email") {
    return (
      `You are writing a real estate email for ${agentName} in ${agentCity}.\n\n` +
      `VOICE DNA:\n${voiceDna}\n\n` +
      `EMAIL GOAL:\n${input.goal}${extra}\n\n` +
      "Write this email in the voice above. NO hyphens. NO corporate language. NO AI-tell phrases. Standard capitalization always.\n\n" +
      "Output format:\nSUBJECT OPTIONS:\n1. [subject]\n2. [subject]\n3. [subject]\n\nEMAIL BODY:\n[full email in plain text, no HTML tags]"
    );
  }

  return (
    `You are writing a short real estate video script for ${agentName} in ${agentCity}.\n\n` +
    `VOICE DNA:\n${voiceDna}\n\n` +
    `VIDEO GOAL:\n${input.goal}${extra}\n\n` +
    (input.hook?.trim() ? `HOOK DIRECTION:\n${input.hook.trim()}\n\n` : "") +
    `Write a 60 second video script in ${agentName}'s voice. Format:\n` +
    "HOOK (first 3 seconds — grab attention):\n[hook line]\n\n" +
    "BODY (main point, story, or insight):\n[15 to 45 seconds of content]\n\n" +
    "CLOSE (natural ending, no hard sell):\n[closing line]\n\n" +
    "Rules: written to be SPOKEN, not read — short sentences, natural pauses. NO hyphens, NO corporate language, NO AI phrases. Standard capitalization, never all lowercase. 150 words maximum."
  );
}

export const generateMarketingContent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: GenerateContentInput) => data)
  .handler(async ({ data, context }): Promise<{ ok: true; postId: string }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    if (!data.goal?.trim()) throw new Error("Tell us what this should be about first.");

    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) {
      throw new Error("Content generation isn't configured yet — add ANTHROPIC_API_KEY in Lovable Cloud → Secrets.");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: agent, error: agentErr } = await supabaseAdmin
      .from("agents")
      .select("full_name, market_area, voice_summary")
      .eq("id", data.agentId)
      .maybeSingle();
    if (agentErr) throw agentErr;

    const agentName = agent?.full_name ?? "the agent";
    const agentCity = agent?.market_area ?? "their market";
    const voiceDna =
      agent?.voice_summary ?? "Warm, conversational, authentic real estate agent. Short posts. Real human energy.";

    const learnedFeedback = await fetchLearnedFeedback(data.agentId);
    const prompt = buildContentPrompt(data, agentName, agentCity, voiceDna, learnedFeedback);
    const suggestedMedia =
      data.contentType === "post"
        ? ((
            await assignSuggestedMedia(data.agentId, [{ direction: null, title: data.title ?? null, copy: data.goal }])
          )[0] ?? null)
        : null;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: data.contentType === "video" ? 600 : data.contentType === "email" ? 2000 : 800,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const json = (await res.json()) as {
      content?: { text?: string }[];
      error?: { message?: string };
    };
    if (!res.ok) throw new Error(json.error?.message ?? `Claude API error (${res.status})`);
    const raw = (json.content ?? [])
      .map((b) => b.text ?? "")
      .join("")
      .trim();
    if (!raw) throw new Error("Empty response from Claude — try again.");

    const { data: row, error } = await supabaseAdmin
      .from("generated_posts")
      .insert({
        agent_id: data.agentId,
        content: raw,
        content_type: data.contentType,
        title: data.title?.trim() || null,
        status: "pending",
        month: new Date().toISOString().slice(0, 7),
        metadata: {
          goal: data.goal,
          instructions: data.instructions ?? null,
          hook: data.hook ?? null,
          use_hashtags: data.useHashtags ?? null,
          source: "native_generate",
          media_id: suggestedMedia?.source === "media" ? suggestedMedia.id : null,
          media_url: suggestedMedia?.source === "media" ? suggestedMedia.url : null,
          media_type: suggestedMedia?.mediaType ?? null,
          drive_file_id: suggestedMedia?.source === "drive" ? suggestedMedia.driveFileId : null,
          drive_thumbnail_url: suggestedMedia?.source === "drive" ? suggestedMedia.driveThumbnailUrl : null,
        },
      })
      .select("id")
      .single();
    if (error) throw error;
    return { ok: true, postId: row.id };
  });

// ============================================================================
// Individual Posts — "personal marketing dude" chat hub (2026-09-21).
//
// Per Mike's voice note: the old "+ New content" form-and-list should become
// a real, persistent, per-agent chat thread — "your own personal marketing
// dude," embedded in the agent's whole workflow, not a set of separate
// tools. One continuous conversation per agent (backed by
// agent_chat_messages, see monthly-marketing-chat-hub-migration.sql) with a
// content-type switcher (post/email, video script, photo scan — carousel to
// follow once Mike sends a template/brand direction) that changes how the
// NEXT reply gets generated, not a separate siloed thread per mode — a
// correction made while drafting an email should still be visible context
// if the agent switches to video-script mode a minute later.
//
// Full scoping: individual-posts-hub-scoping.md.
// ============================================================================

export type ChatMode = "post" | "email" | "video_script" | "photo_scan";

export type ChatMessageRow = {
  id: string;
  role: string;
  content: string;
  mode: string;
  // Server-fn return values must be serializable: Record<string, unknown> is
  // rejected by the framework's serializer, and every value actually written
  // here (source, sourceId, thumbnailUrl, fileName) is a string anyway.
  metadata: Record<string, string> | null;
  created_at: string;
};

// Mike's actual video-script template (received 2026-09-21), confirmed the
// same day as reference grounding, NOT the only format or a rigid fill-in-
// the-blanks shape: "not the only one, just what I typically feed into AI
// to create scripts now... There is both short form and long form, but tap
// into AI too, these are just for reference." So this is woven into the
// video-script prompt as an EXAMPLE of a shape that's worked before, not a
// template to force every script into.
const VIDEO_SCRIPT_REFERENCE_TEMPLATE =
  "Hook:\n[Insert a strong hook that will get people to stop and watch this video]\n\n" +
  "The Problem(s):\n[Identify a clear problem the intended viewer of this video faces or could face]\n\n" +
  'Twist The Knife:\n[add in another pain point to twist the knife, for example, "Plus if…"]\n\n' +
  "Promise Of Value:\nOver the next few minutes I'm going to show you how [INSERT SITUATION and get INSERT BENEFIT]\n\n" +
  "Intro:\nMy name is [INSERT NAME] And I help people [INSERT END RESULT].\n\n" +
  "Body\n" +
  "Point 1 - The Problem - Clearly Identify the problem:\n" +
  "Point 2 - What most people are doing to solve that problem:\n" +
  "Point 3 - Why what they are doing to solve that problem won't work:\n" +
  "Point 4 - Introduce Your Solution:\n" +
  "Point 5 - Why Your Solution Works:\n  Step 1\n  Step 2\n  Step 3\n\n" +
  "Outro\nIf you need additional assistance or have questions to your specific situation, schedule a consultation with our office. We will spend about 30 minutes going through your scenario and then advise what you might need to do next FREE of charge!";

function buildChatSystemPrompt(
  mode: ChatMode,
  agentName: string,
  agentCity: string,
  voiceDna: string,
  learnedFeedback: string,
): string {
  const base =
    `You are ${agentName}'s own personal marketing assistant — their "Marketing Dude," embedded in their day-to-day workflow. You know their voice and you're having an ongoing conversation with them, not filling out a form. Keep replies focused on the content they're working on; don't pad with generic assistant chatter.\n\n` +
    `You are writing for ${agentName} in ${agentCity}.\n\n` +
    `VOICE DNA:\n${voiceDna}${learnedFeedback}\n\n` +
    'House rules that apply no matter what you\'re writing: no hyphens used as dashes, no "As a real estate professional" or any version of that, no "Navigating the market," no corporate language, no buzzwords, no filler, standard capitalization always, never write in a way a real person wouldn\'t actually say out loud.\n\n';

  if (mode === "email") {
    return (
      base +
      "Right now you're helping draft an EMAIL. When you're ready to give a finished draft, format it as:\nSUBJECT OPTIONS:\n1. [subject]\n2. [subject]\n3. [subject]\n\nEMAIL BODY:\n[full email in plain text]\n\nIt's fine to ask a quick clarifying question first if you genuinely need more to go on, but don't stall on a clear, simple request — just write it."
    );
  }

  if (mode === "video_script") {
    return (
      base +
      "Right now you're helping write a VIDEO SCRIPT. Below is a real example of the kind of script this agency has fed into AI before — treat it as reference grounding for tone and shape, NOT a rigid template to fill in word-for-word every time. This agent's real script library also has a mix of short-form and long-form scripts, so match the length and structure to what THIS video actually needs rather than defaulting to this one example.\n\n" +
      `REFERENCE EXAMPLE (education/single-topic shape):\n${VIDEO_SCRIPT_REFERENCE_TEMPLATE}\n\n` +
      "Write scripts to be SPOKEN, not read — short sentences, natural pauses. Ask what the video is about and whether they want short-form or long-form if it isn't already clear, otherwise just write it."
    );
  }

  // "post" and "photo_scan" — photo_scan messages are logged directly by
  // logPhotoScanToChat below without a Claude call, but this is the
  // sensible default system prompt if this mode is ever routed through here.
  return (
    base +
    "Right now you're helping write a SOCIAL POST. Every post should tell a small story or make one clear point, be short (2-4 sentences), and feel like a text to a friend, not a broadcast. Real estate should feel like a casual aside, not the whole point, unless they're specifically asking for something transaction-focused."
  );
}

export const listAgentChatMessages = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string }) => data)
  .handler(async ({ data, context }): Promise<ChatMessageRow[]> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error } = await supabaseAdmin
      .from("agent_chat_messages")
      .select("id, role, content, mode, metadata, created_at")
      .eq("agent_id", data.agentId)
      .order("created_at", { ascending: true })
      .limit(200);
    if (error) throw error;
    return (rows ?? []) as unknown as ChatMessageRow[];
  });

export const sendAgentChatMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; mode: ChatMode; message: string }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true; reply: ChatMessageRow }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const message = data.message.trim();
    if (!message) throw new Error("Type something first.");

    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) {
      throw new Error("Content generation isn't configured yet — add ANTHROPIC_API_KEY in Lovable Cloud → Secrets.");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: agent } = await supabaseAdmin
      .from("agents")
      .select("full_name, market_area, voice_summary")
      .eq("id", data.agentId)
      .maybeSingle();
    const agentName = agent?.full_name ?? "the agent";
    const agentCity = agent?.market_area ?? "their market";
    const voiceDna =
      agent?.voice_summary ?? "Warm, conversational, authentic real estate agent. Short posts. Real human energy.";

    const learnedFeedback = await fetchLearnedFeedback(data.agentId);
    const systemPrompt = buildChatSystemPrompt(data.mode, agentName, agentCity, voiceDna, learnedFeedback);

    // Save the agent's turn first so it's never lost even if the Claude call
    // below fails, and so it's part of the history the call below reads.
    const { error: userInsertErr } = await supabaseAdmin.from("agent_chat_messages").insert({
      agent_id: data.agentId,
      role: "user",
      mode: data.mode,
      content: message,
    });
    if (userInsertErr) throw userInsertErr;

    // Recent thread as conversational context — capped so a long-running
    // relationship doesn't grow the prompt without bound.
    const { data: history } = await supabaseAdmin
      .from("agent_chat_messages")
      .select("role, content")
      .eq("agent_id", data.agentId)
      .order("created_at", { ascending: false })
      .limit(20);
    const claudeMessages = (history ?? [])
      .slice()
      .reverse()
      .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1200,
        system: systemPrompt,
        messages: claudeMessages,
      }),
    });
    const json = (await res.json()) as {
      content?: { text?: string }[];
      error?: { message?: string };
    };
    if (!res.ok) throw new Error(json.error?.message ?? `Claude API error (${res.status})`);
    const raw = (json.content ?? [])
      .map((b) => b.text ?? "")
      .join("")
      .trim();
    if (!raw) throw new Error("Empty response from Claude — try again.");

    const { data: assistantRow, error: assistantInsertErr } = await supabaseAdmin
      .from("agent_chat_messages")
      .insert({ agent_id: data.agentId, role: "assistant", mode: data.mode, content: raw })
      .select("id, role, content, mode, metadata, created_at")
      .single();
    if (assistantInsertErr) throw assistantInsertErr;

    return { ok: true, reply: assistantRow as unknown as ChatMessageRow };
  });

// Turns one of Claude's chat replies into a real post that goes through the
// same review/approve pipeline as everything else — the thread itself is
// scratch space for drafting and refining, not the review surface, exactly
// like AI-Rewrite already works elsewhere in this app.
export const saveChatMessageAsPost = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (data: { agentId: string; messageId: string; contentType: "post" | "email" | "video"; title?: string }) => data,
  )
  .handler(async ({ data, context }): Promise<{ ok: true; postId: string }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: msg, error: msgErr } = await supabaseAdmin
      .from("agent_chat_messages")
      .select("agent_id, role, content")
      .eq("id", data.messageId)
      .maybeSingle();
    if (msgErr) throw msgErr;
    if (!msg || msg.agent_id !== data.agentId || msg.role !== "assistant") {
      throw new Error("That message can't be saved as a post.");
    }

    const { data: row, error } = await supabaseAdmin
      .from("generated_posts")
      .insert({
        agent_id: data.agentId,
        content: msg.content,
        content_type: data.contentType,
        title: data.title?.trim() || null,
        status: "pending",
        month: new Date().toISOString().slice(0, 7),
        metadata: { source: "chat_hub" },
      })
      .select("id")
      .single();
    if (error) throw error;
    return { ok: true, postId: row.id };
  });

// Drops a photo-scan suggestion straight into the agent's chat thread as an
// assistant message, with no separate Claude call — captionPhotoInVoice
// already wrote the caption when scanAgentDrivePhotos/scanAgentLibraryPhotos
// ran. Keeps "Scan My Photos" inside the hub feeling like part of the same
// conversation instead of a separate screen. "Save as post" on the resulting
// message calls the existing addPhotoPostsToBatch directly from the client
// using this row's metadata, same as the old PhotoScanPanel already does.
export const logPhotoScanToChat = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (data: {
      agentId: string;
      suggestedPost: string;
      source: "drive" | "library";
      sourceId: string;
      thumbnailUrl: string;
      fileName: string;
    }) => data,
  )
  .handler(async ({ data, context }): Promise<{ ok: true; message: ChatMessageRow }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("agent_chat_messages")
      .insert({
        agent_id: data.agentId,
        role: "assistant",
        mode: "photo_scan",
        content: data.suggestedPost,
        metadata: {
          source: data.source,
          sourceId: data.sourceId,
          thumbnailUrl: data.thumbnailUrl,
          fileName: data.fileName,
        },
      })
      .select("id, role, content, mode, metadata, created_at")
      .single();
    if (error) throw error;
    return { ok: true, message: row as unknown as ChatMessageRow };
  });

// ============================================================================
// Content calendar — native and SHARED across every agent (2026-09-17).
//
// Corrected twice from the original Drive-folder port: first to a per-agent
// Drive folder (admin-only add/remove), then — per Mike, after he saw the
// per-agent "Manage months" list and said it was backwards — to this: ONE
// calendar, built once by admin, that every agent generates their own
// personalized version of through their own login. There is no agentId
// dimension on a month or an item anymore; `agentId` still appears on the
// read/generate calls below only because those calls also need to know
// WHICH agent's Voice DNA to write in and whose generated_posts to create.
//
// Mike's explicit reasoning for going fully native here (not a Drive folder
// shared across agents instead): the recurring operational headache with
// Drive has always been the photo "move to used" mechanics, and native
// content also sets up the later Meta-posting integration he's planning.
// He pointed at a real Drive folder of his own briefs as the reference for
// the shape a piece of content needs (goal / image suggestions / canva
// link / copy for a post; goal / subject lines / instructions for an email;
// goal / hook / script for a video) — confirmed by reading it directly.
// That shape is exactly what the old Drive-doc parser below already
// extracts, so admin authors that same shape as plain text per item, and
// the SAME parsing functions run against it — no new prompt/logic was
// invented, only the source changed from a Drive Doc export to a native
// textarea.
// ============================================================================

export type CalendarMonth = { id: string; month: string; archived: boolean };

// Excludes archived months — added 2026-09-18 per Mike: "We also need an
// Archive so we can archive that content and we dont have a long list of
// stuff to do." This is the one every agent's "Create My Monthly Content"
// picker and (by default) ManageCalendarScreen use, so an archived month
// disappears from both without any call-site changes. Archiving is purely a
// visibility flag (see the migration comment) — it hides a finished month,
// it doesn't delete its items or any already-generated posts.
export const listCalendarMonths = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CalendarMonth[]> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAnyMarketingAccess(context.userId, email);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("content_calendar_months")
      .select("id, month, archived")
      .eq("archived", false)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as CalendarMonth[];
  });

// Admin-only, includes archived months too — powers ManageCalendarScreen's
// "Show archived" toggle, since that screen is the only place admin needs
// to find an archived month again (to unarchive it, or just to look back).
export const listAllCalendarMonthsForAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CalendarMonth[]> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAdmin(context.userId, email);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("content_calendar_months")
      .select("id, month, archived")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as CalendarMonth[];
  });

export const setCalendarMonthArchived = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { monthId: string; archived: boolean }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAdmin(context.userId, email);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("content_calendar_months")
      .update({ archived: data.archived })
      .eq("id", data.monthId);
    if (error) throw error;
    return { ok: true };
  });

export const addCalendarMonth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { month: string }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true; month: CalendarMonth }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAdmin(context.userId, email);
    if (!data.month.trim()) throw new Error("Give this month a label.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("content_calendar_months")
      .insert({ month: data.month.trim() })
      .select("id, month, archived")
      .single();
    if (error) throw error;
    return { ok: true, month: row as CalendarMonth };
  });

export const removeCalendarMonth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { monthId: string }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAdmin(context.userId, email);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("content_calendar_months").delete().eq("id", data.monthId);
    if (error) throw error;
    return { ok: true };
  });

// One row per post/email/video admin authors for a month — the native
// replacement for a Google Doc in the old Drive folder. `rawText` is typed
// and structured exactly the way a Drive Doc for that type was (see the
// parsing functions below); admin picks the type explicitly instead of it
// being sniffed from a filename.
export type CalendarItem = { id: string; docType: "post" | "email" | "video"; title: string; rawText: string };

export const listCalendarItems = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((data: { monthId: string }) => data)
  .handler(async ({ data, context }): Promise<CalendarItem[]> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAdmin(context.userId, email);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error } = await supabaseAdmin
      .from("content_calendar_items")
      .select("id, doc_type, title, raw_text")
      .eq("month_id", data.monthId)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) throw error;
    return (rows ?? []).map((r) => ({
      id: r.id,
      docType: r.doc_type as CalendarItem["docType"],
      title: r.title,
      rawText: r.raw_text,
    }));
  });

export const addCalendarItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { monthId: string; docType: "post" | "email" | "video"; title: string; rawText: string }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAdmin(context.userId, email);
    if (!data.title.trim() || !data.rawText.trim()) {
      throw new Error("Give this piece a title and the brief/copy to generate from.");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const row: TablesInsert<"content_calendar_items"> = {
      month_id: data.monthId,
      doc_type: data.docType,
      title: data.title.trim(),
      raw_text: data.rawText.trim(),
    };
    const { error } = await supabaseAdmin.from("content_calendar_items").insert(row);
    if (error) throw error;
    return { ok: true };
  });

export const removeCalendarItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { itemId: string }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAdmin(context.userId, email);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("content_calendar_items").delete().eq("id", data.itemId);
    if (error) throw error;
    return { ok: true };
  });

// ── Calendar item parsing — the exact same extraction logic that was ported
// from the old app's Drive-doc parser (content-calendar.js), just applied to
// natively-authored text instead of a Drive Doc export ─────────────────────

export type CalendarDoc =
  | {
      type: "post";
      title: string;
      goal: string;
      image: string;
      canva: string;
      canvaDirection: string;
      copy: string;
    }
  | { type: "email"; title: string; goal: string; subjects: string[]; instructions: string }
  | { type: "video"; title: string; goal: string; hook: string; script: string };

function extractSection(text: string, startLabel: string, endLabels: string[]): string {
  const startRe = new RegExp("(?:\\d+\\.\\s*)?" + startLabel, "i");
  const startMatch = text.match(startRe);
  if (!startMatch) return "";
  let startIdx = startMatch.index! + startMatch[0].length;
  const newlineAfterHeader = text.indexOf("\n", startIdx);
  if (newlineAfterHeader !== -1) startIdx = newlineAfterHeader + 1;
  let endIdx = text.length;
  for (const label of endLabels) {
    const endRe = new RegExp("(?:\\d+\\.\\s*)?" + label, "i");
    const endMatch = text.slice(startIdx).match(endRe);
    if (endMatch) {
      const candidateIdx = startIdx + endMatch.index!;
      if (candidateIdx < endIdx) endIdx = candidateIdx;
    }
  }
  return text.slice(startIdx, endIdx).trim();
}

// Turns a raw, multi-line calendar-doc section into clean bullet lines —
// added 2026-09-20 per Mike's screenshot feedback: a multi-slide/multi-clip
// brief (several "Image:"/"Text:" pairs, one per slide) was previously
// flattened into a single "; "-joined run-on paragraph, which is exactly
// what he called "too long" and "very confusing." Two real problems in the
// old flattening: (1) a doc that puts a label on its own line and the value
// on the NEXT line (e.g. "Text:\nYou know exactly how to open the broken
// drawer.") produced an orphaned, empty-looking "Text:;" fragment once
// joined — this merges a bare label with whatever line follows it instead;
// (2) a trailing "Template Link:" line (the calendar author's own record of
// the Canva link, inside the very section this reads) was being included as
// a bullet even though the exact same link is already captured separately
// into canva/canva_link — filtered out here so it doesn't show twice.
// Returns an array of clean lines; the frontend (marketing.tsx) renders
// these newline-joined lines as an actual bulleted list instead of a
// paragraph, and — for the handful of already-generated posts made before
// this fix, whose stored image_suggestion/canva_instructions are still
// semicolon-joined — falls back to splitting on "; " there too, so existing
// pending content reads better immediately, not just future generations.
function toBullets(sectionText: string): string[] {
  const rawLines = sectionText
    .split("\n")
    .map((l) =>
      l
        .replace(/^[-*•]\s*/, "")
        .replace(/^Clip\s*\d+:\s*/i, "")
        .replace(/^Option\s*\d+:\s*/i, "")
        .trim(),
    )
    .filter((l) => l.length > 0 && !/^Template Link:/i.test(l));

  const bullets: string[] = [];
  let pendingLabel: string | null = null;
  const bareLabelRe = /^(Image|Text|Caption|Hook|Body|Close)\s*:\s*$/i;
  for (const line of rawLines) {
    if (bareLabelRe.test(line)) {
      // Two bare labels in a row (rare) — the first never got a value, so
      // keep it as its own bullet rather than silently dropping it.
      if (pendingLabel) bullets.push(pendingLabel);
      pendingLabel = line.replace(/\s*:\s*$/, ":");
      continue;
    }
    if (pendingLabel) {
      bullets.push(`${pendingLabel} ${line}`);
      pendingLabel = null;
    } else {
      bullets.push(line);
    }
  }
  if (pendingLabel) bullets.push(pendingLabel);
  return bullets;
}

function parsePostDoc(text: string, title: string): CalendarDoc | null {
  const goal = extractSection(text, "Post Goal", [
    "Post Image",
    "Image\\s*/\\s*Video Suggestions",
    "Canva Template Direction",
    "Post Copy",
  ]);
  const imageSection = extractSection(text, "Post Image\\s*/\\s*Video Suggestions", [
    "Canva Template Direction",
    "Post Copy",
  ]);
  let copy = extractSection(text, "Post Copy", []);
  if (!copy) {
    const lastSectionMatch = text.match(/(?:\d+\.\s*)(?:Post Copy|Copy)[^\n]*/i);
    if (lastSectionMatch) {
      copy = text.slice(lastSectionMatch.index! + lastSectionMatch[0].length).trim();
    }
  }
  if (!copy) {
    const templateLinkIdx = text.search(/Template Link:/i);
    if (templateLinkIdx > -1) {
      const afterLink = text.indexOf("\n", templateLinkIdx);
      copy = text.slice(afterLink > -1 ? afterLink : templateLinkIdx).trim();
    }
  }
  if (!copy) return null;

  const image = toBullets(imageSection).join("\n");

  let canva = "";
  const canvaMatch =
    text.match(/Template Link:\s*<?(\S+?)>?(?:\s|$)/i) ||
    text.match(/\]\((https?:\/\/canva\.[^\s)]+)\)/i) ||
    text.match(/\((https?:\/\/canva\.link\/[^\s)]+)\)/i) ||
    text.match(/<(https?:\/\/canva\.[^\s>]+)>/i) ||
    text.match(/(https?:\/\/canva\.link\/\S+)/i) ||
    text.match(/(https?:\/\/www\.canva\.com\/\S+)/i);
  if (canvaMatch)
    canva = canvaMatch[1]!
      .trim()
      .replace(/[<>()[\]]/g, "")
      .replace(/\*\*/g, "")
      .trim();

  // The "Canva Template Direction" section itself was previously only ever
  // used as a boundary marker (to know where "Post Goal"/"Post Image..."
  // end) — its actual content (what to put in the template: which photo,
  // which headline, layout notes) was never captured anywhere, so a
  // Canva-templated post never had any instructions shown under it, unlike
  // a regular post's "Post Image/Video Suggestions" section. Fixed per
  // Mike's report (2026-09-18): "the Canva images need the instructions
  // posted beneath it, just like they are in the posts."
  const canvaDirection = toBullets(extractSection(text, "Canva Template Direction", ["Post Copy"])).join("\n");

  return { type: "post", title, goal, image, canva, canvaDirection, copy };
}

function parseEmailDoc(text: string, title: string): CalendarDoc | null {
  const goal = extractSection(text, "Email Goal", ["Subject Line Options", "Email Instructions", "SUBJECT LINE"]);
  const subjectSection =
    extractSection(text, "SUBJECT LINE OPTIONS?(?:\\s*\\([^)]*\\))?", [
      "Email Instructions",
      "EMAIL BODY",
      "Hey \\[",
      "Hey,",
    ]) || extractSection(text, "Subject Line Options", ["Email Instructions", "EMAIL BODY", "Hey \\[", "Hey,"]);

  let instructionsText =
    extractSection(text, "Email Instructions", []) ||
    extractSection(text, "EMAIL BODY[^:]*:", []) ||
    extractSection(text, "Hey \\[", []) ||
    extractSection(text, "Hey,", []);

  if (instructionsText) {
    instructionsText = instructionsText
      .replace(/---+[\s\n]*(?:VISUAL ASSETS|Image Idea)[\s\S]*/i, "")
      .replace(/#+\s*VISUAL ASSETS[\s\S]*/i, "")
      .replace(/\*\*VISUAL ASSETS[\s\S]*/i, "")
      .replace(/VISUAL ASSETS[\s\S]*/i, "")
      .replace(/\*\*Image Idea\s*\d*[:\s][^*]+\*\*[\s\S]*?(?=\*\*Image Idea|$)/gi, "")
      .replace(/\*\*Image Idea[\s\S]*/i, "")
      .replace(/Business\/Event Name:.*/gi, "")
      .replace(/Official Website:.*/gi, "")
      .replace(/Source Page:.*/gi, "")
      .replace(/Suggested Image Source:.*/gi, "")
      .replace(/Backup Search Phrase:.*/gi, "")
      .replace(/\*\*Business:.*/gi, "")
      .replace(/\*\*Location:.*/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  if (!instructionsText && !goal) return null;

  const subjects = (subjectSection || "")
    .split("\n")
    .map((l) =>
      l
        .replace(/^[-*•\d.)\s]+/, "")
        .replace(/\*\*/g, "")
        .replace(/\*/g, "")
        .replace(/\\/g, "")
        .trim(),
    )
    .filter((l) => l.length > 5 && !/^Pick\s+\d/i.test(l));

  return { type: "email", title, goal, subjects, instructions: instructionsText };
}

function parseVideoDoc(text: string, title: string): CalendarDoc | null {
  const firstLine = text.split("\n")[0]!.trim();
  const isSimpleFormat = /^video[:\s]/i.test(firstLine);
  if (isSimpleFormat) {
    const lines = text.split("\n");
    const conceptTitle = firstLine.replace(/^video[:\s]*/i, "").trim() || title;
    const scriptContent = lines.slice(1).join("\n").trim() || firstLine;
    return {
      type: "video",
      title: conceptTitle || title,
      goal: "Short form video — " + conceptTitle,
      hook: "",
      script: scriptContent || text,
    };
  }
  const goal = extractSection(text, "Video Goal", ["Hook", "Script Instructions", "Video Script"]);
  const hook = extractSection(text, "Hook", ["Script Instructions", "Video Script", "Body", "Close"]);
  const scriptInstructions = extractSection(text, "Script Instructions", ["Video Script"]);
  const script = extractSection(text, "Video Script", []) || scriptInstructions;
  if (!script && !goal) return null;
  return { type: "video", title, goal, hook, script };
}

function parseCalendarItem(item: { docType: string; title: string; rawText: string }): CalendarDoc | null {
  const cleaned = item.rawText
    .replace(/\r\n/g, "\n")
    .replace(/\\([[\]().*+?^${}|\\])/g, "$1")
    .trim();
  if (item.docType === "email") return parseEmailDoc(cleaned, item.title);
  if (item.docType === "video") return parseVideoDoc(cleaned, item.title);
  return parsePostDoc(cleaned, item.title);
}

async function fetchNativeCalendarDocs(monthId: string): Promise<CalendarDoc[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("content_calendar_items")
    .select("doc_type, title, raw_text")
    .eq("month_id", monthId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  const docs = (data ?? [])
    .map((row) => parseCalendarItem({ docType: row.doc_type, title: row.title, rawText: row.raw_text }))
    .filter((d): d is CalendarDoc => Boolean(d));
  const typeOrder: Record<string, number> = { post: 0, video: 1, email: 2 };
  docs.sort((a, b) => (typeOrder[a.type] ?? 0) - (typeOrder[b.type] ?? 0));
  return docs;
}

export const readContentCalendar = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; monthId: string }) => data)
  .handler(async ({ data, context }): Promise<{ docs: CalendarDoc[] }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const docs = await fetchNativeCalendarDocs(data.monthId);
    return { docs };
  });

// ── Batch generation — ported 1:1 from generateAll()'s per-type prompts ────

// Added 2026-09-20: Mike reported a month stuck on "Generating…" with no
// error (17 pieces landed, then it just hung). generateMonthlyBatch used to
// run its email and video loops fully sequentially — one callClaude() at a
// time, no request timeout anywhere — so a single slow/unresponsive call to
// Claude or Google Drive could stall the whole batch indefinitely (and on a
// serverless platform, risk the function just getting killed mid-request
// with nothing written back to the UI). fetchWithTimeout gives every
// outbound call a hard ceiling so one bad request fails fast and gets
// skipped (existing try/catch-and-continue behavior) instead of hanging.
async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function callClaude(apiKey: string, prompt: string, maxTokens: number): Promise<string> {
  const res = await fetchWithTimeout(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    },
    60_000,
  );
  const json = (await res.json()) as { content?: { text?: string }[]; error?: { message?: string } };
  if (!res.ok) throw new Error(json.error?.message ?? `Claude API error (${res.status})`);
  return (json.content ?? [])
    .map((b) => b.text ?? "")
    .join("")
    .trim();
}

function cleanCopy(text: string): string {
  return text
    .replace(/\*\*/g, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

export const generateMonthlyBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; monthId: string; month: string; useHashtags?: boolean }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true; batchId: string; created: number }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);

    const anthropicKey = process.env["ANTHROPIC_API_KEY"];
    if (!anthropicKey)
      throw new Error("Content generation isn't configured yet — add ANTHROPIC_API_KEY in Lovable Cloud → Secrets.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: agent, error: agentErr } = await supabaseAdmin
      .from("agents")
      .select("full_name, market_area, voice_summary")
      .eq("id", data.agentId)
      .maybeSingle();
    if (agentErr) throw agentErr;
    const agentName = agent?.full_name ?? "the agent";
    const agentCity = agent?.market_area ?? "their market";
    const dna =
      agent?.voice_summary ?? "Warm, conversational, authentic real estate agent. Short posts. Real human energy.";
    const learnedFeedback = await fetchLearnedFeedback(data.agentId);

    const docs = await fetchNativeCalendarDocs(data.monthId);
    const postDocs = docs.filter((d): d is Extract<CalendarDoc, { type: "post" }> => d.type === "post");
    const emailDocs = docs.filter((d): d is Extract<CalendarDoc, { type: "email" }> => d.type === "email");
    const videoDocs = docs.filter((d): d is Extract<CalendarDoc, { type: "video" }> => d.type === "video");

    const batchId = `${data.agentId}-${data.month}-${Date.now()}`;
    const rows: TablesInsert<"generated_posts">[] = [];

    // Posts — one combined prompt, same REWRITTEN-block format the old app used.
    if (postDocs.length) {
      const postPrompt =
        "You are the best real estate social media copywriter in the country. Your specialty: writing posts that remind people someone is in real estate without ever preaching about it. Every post tells a small story. Every post has a clear point. Every post sounds like a real person.\n\n" +
        `You are writing for ${agentName} in ${agentCity}.\n\n` +
        `VOICE DNA:\n${dna}\n\n` +
        "RULES — follow every one:\n" +
        "- Write a COMPLETE post. Every sentence must connect to the next. The post must make full sense start to finish.\n" +
        "- Tell a story or make a single clear point. If you cannot explain what the post is about in one sentence, rewrite it.\n" +
        "- 2 to 4 sentences max. Short. Punchy. Human.\n" +
        "- No hyphens used as dashes anywhere\n" +
        '- No "As a real estate professional" or any version of that\n' +
        '- No "Navigating the market" — never\n' +
        "- No corporate language. No buzzwords. No filler.\n" +
        "- Standard capitalization always. First letter of every sentence capitalized.\n" +
        "- Real estate should feel like a casual aside, not the whole point\n" +
        `- The post should remind people ${agentName} is in real estate — not sell them on it\n` +
        "- AUTHENTICITY CHECK: Read it out loud. If it sounds like an ad, rewrite it. If a real person would never say this, rewrite it.\n" +
        (data.useHashtags ? "- Add 2-3 relevant hashtags at the very end\n" : "- NO hashtags\n") +
        learnedFeedback +
        "\nFor each post below:\n1. Read the CONCEPT and ORIGINAL carefully\n2. Find the story or the human truth in it\n3. Write it clearly in the agent's voice\n4. Make sure the last sentence lands and the whole post makes sense\n\n" +
        "Output format for each post:\nPOST [N]: [TITLE]\nREWRITTEN: [complete caption]\n---\n\n" +
        "Posts to write:\n" +
        postDocs.map((p, i) => `POST ${i + 1}: ${p.title}\nCONCEPT: ${p.goal}\nORIGINAL: ${p.copy}`).join("\n\n");

      const raw = await callClaude(anthropicKey, postPrompt, 4000);
      const blocks = raw.split("---").filter((b) => b.trim());
      const media = await assignSuggestedMedia(
        data.agentId,
        postDocs.map((d) => ({ direction: d.image, title: d.title, copy: d.copy })),
      );
      blocks.forEach((block, i) => {
        const rm = block.match(/REWRITTEN:\s*([\s\S]*?)$/);
        const rewritten = rm ? cleanCopy(rm[1]!.trim()) : "";
        const doc = postDocs[i];
        const pick = media[i] ?? null;
        if (rewritten && doc) {
          rows.push({
            agent_id: data.agentId,
            content: rewritten,
            content_type: "post",
            title: doc.title,
            status: "pending",
            month: data.month,
            metadata: {
              batch_id: batchId,
              month: data.month,
              canva_link: doc.canva || null,
              canva_instructions: doc.canvaDirection || null,
              goal: doc.goal,
              image_suggestion: doc.image || null,
              source: "content_calendar",
              media_id: pick?.source === "media" ? pick.id : null,
              media_url: pick?.source === "media" ? pick.url : null,
              media_type: pick?.mediaType ?? null,
              drive_file_id: pick?.source === "drive" ? pick.driveFileId : null,
              drive_thumbnail_url: pick?.source === "drive" ? pick.driveThumbnailUrl : null,
            },
          });
        }
      });
    }

    // Emails — one prompt per doc, same brief-vs-prewritten detection as
    // before. Changed 2026-09-20 from a sequential for-loop to Promise.all:
    // each email was one full callClaude() round trip, awaited one at a
    // time, so a month with a dozen emails meant a dozen sequential network
    // calls with no timeout — the likely cause of the "stuck Generating…"
    // report. Running them concurrently (each still wrapped in its own
    // try/catch so one bad email doesn't drop the rest) cuts total wall
    // time roughly to the slowest single call instead of the sum of all of
    // them, and the new fetchWithTimeout on callClaude means a stuck one
    // fails and gets skipped instead of hanging the batch.
    const emailResults = await Promise.all(
      emailDocs.map(async (ed): Promise<TablesInsert<"generated_posts"> | null> => {
        const instructions = ed.instructions || "";
        const hasCompleteBody = /Hey\s*\[/.test(instructions) || /Hey,\s*\n/.test(instructions);
        const isPromptBrief =
          !hasCompleteBody &&
          /Opening:|Structure:|Style Rules|AFTER THE EMAIL|SUBJECT LINES|Write a complete email|Blend together:|Create a section|observations|Local Letter|BEFORE YOU WRITE/i.test(
            instructions,
          );
        const isLocalLetter =
          /observations|Local Letter|three to four|reads like a note|newsletter.*rewrite|sound like a note/i.test(
            instructions,
          ) || /CRITICAL RULES FOR THIS FORMAT|Do NOT use headers|Do NOT write bullet/i.test(instructions);

        let emailPrompt: string;
        if (isPromptBrief) {
          if (isLocalLetter) {
            emailPrompt =
              `You are writing a personal community letter for ${agentName} in ${agentCity}.\n\n` +
              `VOICE DNA:\n${dna}\n\n` +
              `EMAIL GOAL:\n${ed.goal || ""}\n\n` +
              `FULL BRIEF:\n${instructions}\n\n` +
              "CRITICAL: Write this as three to four natural observations that flow into each other. Do NOT use headers. Do NOT use bullet lists. Do NOT structure this as a newsletter with named sections. Each observation transitions naturally into the next. The real estate mention is one short paragraph near the end, treated as a casual aside — not a featured section. End with one or two lines. No call to action. No pitch. " +
              `This should read like a personal note from someone who lives in ${agentCity} and noticed a few things worth sharing. If it reads like a newsletter when done, it is wrong. Replace all [CITY], [NAME] placeholders with ${agentName} and ${agentCity}.\n` +
              "NO hyphens. NO corporate language. NO AI tell phrases. Standard capitalization always." +
              learnedFeedback +
              "\n\nOutput format:\nSUBJECT OPTIONS:\n1. [subject]\n2. [subject]\n3. [subject]\n\nEMAIL BODY:\n[full email — reads like a note, not a newsletter]";
          } else {
            emailPrompt =
              `You are writing a real estate email for ${agentName} in ${agentCity}.\n\n` +
              `VOICE DNA:\n${dna}\n\n` +
              `EMAIL GOAL:\n${ed.goal || ""}\n\n` +
              `BRIEF TO FOLLOW:\n${instructions}\n\n` +
              `Write this email EXACTLY as ${agentName} would write it based on their Voice DNA above. Replace all [CITY], [NAME], [CITY, STATE] placeholders with ${agentName} and ${agentCity}.\n` +
              "NO hyphens. NO corporate language. NO AI-tell phrases. Standard capitalization always." +
              learnedFeedback +
              "\n\n" +
              "Output format:\nSUBJECT OPTIONS:\n1. [subject]\n2. [subject]\n3. [subject]\n\nEMAIL BODY:\n[full email in plain text, no HTML tags]";
          }
        } else {
          const preWrittenSubjects = ed.subjects?.length ? ed.subjects : [];
          const subjectBlock = preWrittenSubjects.length
            ? preWrittenSubjects.map((s, i) => `${i + 1}. ${s}`).join("\n")
            : "1. [See email below]\n2. \n3. ";
          emailPrompt =
            `You are personalizing a pre-written real estate email for ${agentName} in ${agentCity}.\n\n` +
            `VOICE DNA (use this to lightly align tone, do NOT rewrite the email):\n${dna}\n\n` +
            `PRE-WRITTEN EMAIL (keep this mostly intact — only replace placeholders and fix any [CITY]/[NAME] references):\n${instructions}\n\n` +
            `Rules:\n- Do NOT rewrite or restructure this email\n- Replace [CITY], [NAME], [CITY, STATE] with ${agentName} and ${agentCity}\n- Fix any placeholder brackets that are still unfilled\n- NO hyphens. NO corporate language. Standard capitalization.\n\n` +
            `Output format:\nSUBJECT OPTIONS:\n${subjectBlock}\n\nEMAIL BODY:\n[the personalized email]`;
        }

        try {
          const eraw = await callClaude(anthropicKey, emailPrompt, 2000);
          const sm = eraw.match(/SUBJECT OPTIONS:([\s\S]*?)EMAIL BODY:/);
          const bm = eraw.match(/EMAIL BODY:([\s\S]*)/);
          const body = cleanCopy(
            (bm ? bm[1]! : eraw)
              .replace(/#+\s*VISUAL ASSETS[\s\S]*/i, "")
              .replace(/\*\*Image Idea:\*\*[\s\S]*/i, "")
              .replace(/# VISUAL[\s\S]*/i, "")
              .replace(/VISUAL ASSETS[\s\S]*/i, "")
              .replace(/\n{3,}/g, "\n\n")
              .trim(),
          );
          const subjectsRaw = sm ? sm[1]!.trim() : "";
          const subjects = subjectsRaw
            .split("\n")
            .filter((s) => s.trim() && /^\d/.test(s.trim()))
            .map((s) => s.replace(/^\d+\.\s*/, "").trim());
          return {
            agent_id: data.agentId,
            content:
              (subjects.length ? `SUBJECT OPTIONS:\n${subjects.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n` : "") +
              body,
            content_type: "email",
            title: ed.title.replace("Email — ", ""),
            status: "pending",
            month: data.month,
            metadata: { batch_id: batchId, month: data.month, goal: ed.goal, source: "content_calendar" },
          };
        } catch {
          // Skip this email but keep generating the rest, same as the old app.
          return null;
        }
      }),
    );
    for (const r of emailResults) if (r) rows.push(r);

    // Video scripts — same Promise.all treatment as emails above, for the
    // same reason: sequential per-video callClaude() calls were another
    // place a single slow request could stall the whole batch.
    const videoResults = await Promise.all(
      videoDocs.map(async (vd): Promise<TablesInsert<"generated_posts"> | null> => {
        const isVideoBrief = /Hook:|Body:|Close:|Structure:|STYLE RULES|Script Instructions/i.test(vd.script || "");
        const videoPrompt =
          `You are writing a short real estate video script for ${agentName} in ${agentCity}.\n\n` +
          `VOICE DNA:\n${dna}\n\n` +
          `VIDEO GOAL:\n${vd.goal || ""}\n\n` +
          (vd.hook ? `HOOK DIRECTION:\n${vd.hook}\n\n` : "") +
          (isVideoBrief ? "SCRIPT BRIEF TO FOLLOW:\n" : "SCRIPT DIRECTION:\n") +
          `${vd.script}\n\n` +
          `Write a 60 second video script in ${agentName}'s voice. Format:\n` +
          "HOOK (first 3 seconds — grab attention):\n[hook line]\n\nBODY (main point, story, or insight):\n[15 to 45 seconds of content]\n\nCLOSE (natural ending, no hard sell):\n[closing line]\n\n" +
          `Rules:\n- Sounds exactly like ${agentName} based on their Voice DNA\n- Written to be SPOKEN, not read — short sentences, natural pauses\n- NO hyphens, NO corporate language, NO AI phrases\n- Standard capitalization, never all lowercase\n- Real estate reminder energy — top of mind, not a pitch\n- 150 words maximum` +
          learnedFeedback;

        try {
          const vraw = cleanCopy(await callClaude(anthropicKey, videoPrompt, 600));
          return {
            agent_id: data.agentId,
            content: vraw,
            content_type: "video",
            title: vd.title,
            status: "pending",
            month: data.month,
            metadata: { batch_id: batchId, month: data.month, goal: vd.goal, source: "content_calendar" },
          };
        } catch {
          // Skip, keep going.
          return null;
        }
      }),
    );
    for (const r of videoResults) if (r) rows.push(r);

    if (rows.length) {
      const { error } = await supabaseAdmin.from("generated_posts").insert(rows);
      if (error) throw error;
    }
    return { ok: true, batchId, created: rows.length };
  });

// The three metadata.source values that mean "this row belongs to a month's
// generated batch" (a calendar generation, or a photo-scan suggestion added
// to one) — as opposed to a one-off post made through "+ New content"
// (source "native_generate"), which never belongs to any month's batch and
// should never be touched by delete/archive/restore below. Shared by all
// three so they stay in sync — this used to be redeclared inline just in
// deleteMonthContent; pulled out when archiveMonthContent needed the exact
// same set (2026-09-20). Mirrors BATCH_SOURCES in marketing.tsx (kept as a
// separate constant there since the frontend needs it for display grouping,
// not data mutation, but the values must always match).
const BATCH_CONTENT_SOURCES = new Set(["content_calendar", "drive_photo_scan", "library_photo_scan"]);

// Deletes a month's generated content for one agent so it can be
// regenerated cleanly — added 2026-09-18 per Mike: "Put a delete in case we
// want to re generate that months content." Without this, clicking
// "Generate Now" a second time just adds a second batch of posts on top of
// the first (generateMonthlyBatch only ever inserts), so a real "start
// over" always needed this. Admin-only, same as the other actions that
// change what an agent's data actually contains rather than just reviewing
// it (approve/flag stay agent-doable; deleting a whole batch is a "done for
// you" action, and it's the one that's actually destructive — archiving,
// added below, is the non-destructive alternative). Scoped to exactly the
// sources this month's workspace shows (batchPosts in MonthWorkspace) —
// content_calendar/drive_photo_scan/library_photo_scan for this agent+month
// — so it never touches a one-off post made through the Posts tab's "+ New
// content" form, which isn't part of any month's batch.
export const deleteMonthContent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; month: string }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true; deleted: number }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAdmin(context.userId, email);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error: selErr } = await supabaseAdmin
      .from("generated_posts")
      .select("id, metadata")
      .eq("agent_id", data.agentId)
      .eq("month", data.month);
    if (selErr) throw selErr;
    const idsToDelete = (rows ?? [])
      .filter((r) => BATCH_CONTENT_SOURCES.has((r.metadata as { source?: string } | null)?.source ?? ""))
      .map((r) => r.id);
    if (!idsToDelete.length) return { ok: true, deleted: 0 };
    const { error: delErr } = await supabaseAdmin.from("generated_posts").delete().in("id", idsToDelete);
    if (delErr) throw delErr;
    return { ok: true, deleted: idsToDelete.length };
  });

// Archives a month's generated content for one agent — added 2026-09-20 per
// Mike: "I'm trying to test and retest, but I can't retest without the
// ability to archive the monthly content." deleteMonthContent above already
// covers "clear it out to regenerate," but it's permanent and admin-only;
// this is the safer, reversible version of the same need, and — per his
// explicit "the admin and or the user needs the ability" — available to the
// agent themselves too, not just admin (requireAgentAccess, same guard
// approveAllPending/submitMarketingFeedback use, not requireAdmin).
// Archiving just flips a flag: listMarketingPosts excludes archived rows by
// default, so an archived batch disappears from the review screen and
// "Generate Now" can be run again cleanly — but nothing is deleted, and
// listArchivedBatchesForMonth/restoreArchivedBatch below can always bring a
// past attempt back. Same BATCH_CONTENT_SOURCES scoping as delete, so a
// one-off "+ New content" post is never swept up by accident.
export const archiveMonthContent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; month: string }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true; archived: number }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error: selErr } = await supabaseAdmin
      .from("generated_posts")
      .select("id, metadata")
      .eq("agent_id", data.agentId)
      .eq("month", data.month)
      .eq("archived", false);
    if (selErr) throw selErr;
    const idsToArchive = (rows ?? [])
      .filter((r) => BATCH_CONTENT_SOURCES.has((r.metadata as { source?: string } | null)?.source ?? ""))
      .map((r) => r.id);
    if (!idsToArchive.length) return { ok: true, archived: 0 };
    const { error } = await supabaseAdmin
      .from("generated_posts")
      .update({ archived: true, updated_at: new Date().toISOString() })
      .in("id", idsToArchive);
    if (error) throw error;
    return { ok: true, archived: idsToArchive.length };
  });

// Groups this agent+month's archived rows by batch_id so the UI can show a
// short history ("14 pieces, generated Sep 18") with a Restore button per
// past attempt, instead of one undifferentiated pile. A batch_id groups
// everything one "Generate Now" click produced (see generateMonthlyBatch);
// photo-scan additions carry their own batch_id from addPhotoPostsToBatch,
// so those group separately too, which is correct — restoring one doesn't
// have to restore the other.
export type ArchivedBatchSummary = { batchId: string; count: number; generatedAt: string };

export const listArchivedBatchesForMonth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; month: string }) => data)
  .handler(async ({ data, context }): Promise<ArchivedBatchSummary[]> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error } = await supabaseAdmin
      .from("generated_posts")
      .select("created_at, metadata")
      .eq("agent_id", data.agentId)
      .eq("month", data.month)
      .eq("archived", true);
    if (error) throw error;
    const groups = new Map<string, { count: number; earliest: string }>();
    for (const r of rows ?? []) {
      const meta = r.metadata as { batch_id?: string; source?: string } | null;
      if (!meta?.batch_id || !BATCH_CONTENT_SOURCES.has(meta.source ?? "")) continue;
      const createdAt = r.created_at as string;
      const g = groups.get(meta.batch_id);
      if (g) {
        g.count += 1;
        if (createdAt < g.earliest) g.earliest = createdAt;
      } else {
        groups.set(meta.batch_id, { count: 1, earliest: createdAt });
      }
    }
    return Array.from(groups.entries())
      .map(([batchId, g]) => ({ batchId, count: g.count, generatedAt: g.earliest }))
      .sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1));
  });

// Un-archives one past batch (by batch_id) for one agent — the recovery
// half of archiveMonthContent. Same access level as archive (agent or
// admin). Scoped to this agent's own rows even though a batch_id is already
// effectively unique per generation, as belt-and-suspenders consistent with
// every other per-post/per-batch action in this file.
export const restoreArchivedBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; batchId: string }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true; restored: number }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error: selErr } = await supabaseAdmin
      .from("generated_posts")
      .select("id")
      .eq("agent_id", data.agentId)
      .eq("archived", true)
      .eq("metadata->>batch_id", data.batchId);
    if (selErr) throw selErr;
    const ids = (rows ?? []).map((r) => r.id);
    if (!ids.length) return { ok: true, restored: 0 };
    const { error } = await supabaseAdmin
      .from("generated_posts")
      .update({ archived: false, updated_at: new Date().toISOString() })
      .in("id", ids);
    if (error) throw error;
    return { ok: true, restored: ids.length };
  });

// ── Photo scan + caption — ported 1:1 from analyze-photos.js ───────────────

// `source` distinguishes where the suggestion came from — added 2026-09-18
// when this panel grew a second source (the native Media Library) per
// Mike's request that the photo-scan tool "scan the media library too and
// all photos", not just Drive. `driveUrl` is kept as the field name for the
// original/full-size view link for BOTH sources (a Drive file's viewer link,
// or a library photo's own URL) rather than renaming it, to avoid touching
// every existing caller.
export type PhotoScanSuggestion = {
  source: "drive" | "library";
  fileId: string;
  fileName: string;
  driveUrl: string;
  thumbnailUrl: string;
  description: string;
  suggestedPost: string;
};

// Shared with scanAgentLibraryPhotos below — one Claude vision call per
// photo, writing a caption in the agent's voice from the raw image bytes.
async function captionPhotoInVoice(
  imageBytes: ArrayBuffer,
  mediaType: string,
  anthropicKey: string,
  agentName: string | undefined,
  agentCity: string | undefined,
  voiceDna: string | undefined,
): Promise<{ description: string; suggestedPost: string } | null> {
  const base64 = Buffer.from(imageBytes).toString("base64");
  const safeMediaType = ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mediaType)
    ? mediaType
    : "image/jpeg";
  // Leans deliberately playful/personality-driven rather than real-estate-y —
  // per Mike's request (2026-09-18): "These should be more fun and playful
  // real estate reminders and just personality driven content that makes
  // them more human since we already have a good balance of real estate
  // ones." The rest of the content plan already covers the real-estate side;
  // this scan is specifically the "make them look like a human, not an
  // agent" lever, so rule 4 below is intentionally stricter than a generic
  // caption prompt would be.
  const prompt =
    `You are creating a social media post for a real estate agent named ${agentName ?? "the agent"} in ${agentCity ?? "their city"}.\n\n` +
    `VOICE DNA:\n${voiceDna ?? "Warm, authentic, conversational. Sounds like a real person, not a real estate agent."}\n\n` +
    "Look at this photo and write a social media post that:\n1. Starts from what you actually see — the setting, the mood, the moment\n2. Sounds EXACTLY like this person based on their Voice DNA above\n3. Is 1-3 sentences max — short, human, texted-a-friend energy\n4. Leans playful, funny, or personality-driven by default — treat this as a chance to make them look like a real person with a life, not an agent. Only mention real estate at all if the photo is unmistakably a real estate moment (a listing, a closing, a sign, a showing); otherwise skip it entirely\n5. Does NOT mention any specific location, city, neighborhood, or place name\n6. NO hyphens, NO corporate language, NO AI-tell phrases\n7. Standard capitalization — never write in all lowercase\n\n" +
    "Also describe what you see in the photo in one short sentence.\n\nOutput format:\nDESCRIPTION: [one sentence of what you see]\nPOST: [the social media caption]";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: safeMediaType, data: base64 } },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });
  const claudeData = (await res.json()) as { content?: { text?: string }[]; error?: { message?: string } };
  if (!res.ok) throw new Error(claudeData.error?.message ?? "Claude API error");
  const raw = (claudeData.content ?? [])
    .map((b) => b.text ?? "")
    .join("")
    .trim();
  const descMatch = raw.match(/DESCRIPTION:\s*(.+)/i);
  const postMatch = raw.match(/POST:\s*([\s\S]+)/i);
  return {
    description: descMatch ? descMatch[1]!.trim() : "Photo",
    suggestedPost: postMatch ? postMatch[1]!.trim() : raw,
  };
}

export const scanAgentDrivePhotos = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; folderId: string; maxPhotos?: number; excludeFileIds?: string[] }) => data)
  .handler(
    async ({
      data,
      context,
    }): Promise<{ suggestions: PhotoScanSuggestion[]; totalPhotos: number; unsupportedFormatCount: number }> => {
      const email = (context.claims as { email?: string } | undefined)?.email;
      await requireAgentAccess(context.userId, email, data.agentId);
      const googleKey = process.env["GOOGLE_API_KEY"];
      const anthropicKey = process.env["ANTHROPIC_API_KEY"];
      if (!googleKey)
        throw new Error("Google Drive isn't connected yet — add GOOGLE_API_KEY in Lovable Cloud → Secrets.");
      if (!anthropicKey)
        throw new Error("Photo captioning isn't configured yet — add ANTHROPIC_API_KEY in Lovable Cloud → Secrets.");
      await verifyDriveFolderAccessible(data.folderId, googleKey);

      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: agent } = await supabaseAdmin
        .from("agents")
        .select("full_name, market_area, voice_summary")
        .eq("id", data.agentId)
        .maybeSingle();
      const agentName = agent?.full_name ?? undefined;
      const agentCity = agent?.market_area ?? undefined;
      const voiceDna = agent?.voice_summary ?? undefined;

      // Searches the whole folder tree under this agent's Drive folder, not
      // just its direct contents — see listDriveFolderIds above for why
      // (Drive's 'in parents' doesn't recurse, so a photo one folder deep
      // used to be invisible to this scan even though it's genuinely in the
      // agent's Drive). listDriveFolderIds already skips any "used" subfolder
      // and everything inside it, so there's no separate used-folder lookup
      // needed here the way there used to be.
      const folderIds = await listDriveFolderIds(data.folderId, googleKey);
      const listUrl =
        "https://www.googleapis.com/drive/v3/files?" +
        "q=" +
        encodeURIComponent(`${driveParentsClause(folderIds)} and mimeType contains 'image/' and trashed=false`) +
        "&fields=files(id,name,mimeType)&pageSize=200&key=" +
        googleKey;
      const listRes = await fetchWithTimeout(listUrl, {}, 15_000);
      const listData = (await listRes.json()) as {
        files?: { id: string; name: string; mimeType: string }[];
        error?: { message?: string };
      };
      if (!listRes.ok) throw new Error(listData.error?.message ?? "Drive list failed");
      const allFiles = listData.files ?? [];

      // HEIC/HEIF (an iPhone's default photo format) can be listed and
      // thumbnailed by Drive, but Claude's vision API can't read its bytes —
      // captioning it always fails. Pulled out up front (instead of
      // discovered one-by-one inside the caption loop below) so the response
      // can tell the difference between "this folder is genuinely empty" and
      // "found photos, but they're all a format we can't scan yet" — added
      // 2026-09-21 after Mike reported photos that are visibly in Drive
      // showing up here as if there were none at all.
      const unsupportedFormatCount = allFiles.filter(isHeicDriveFile).length;
      const usableFiles = allFiles.filter((f) => !isHeicDriveFile(f));

      const excludeIds = new Set(data.excludeFileIds ?? []);
      const maxPhotos = data.maxPhotos ?? 5;
      const toProcess = usableFiles.filter((f) => !excludeIds.has(f.id)).slice(0, maxPhotos);

      const results = await Promise.all(
        toProcess.map(async (f): Promise<PhotoScanSuggestion | null> => {
          try {
            const imgUrl = "https://www.googleapis.com/drive/v3/files/" + f.id + "?alt=media&key=" + googleKey;
            const imgRes = await fetchWithTimeout(imgUrl, {}, 15_000);
            if (!imgRes.ok) return null;
            const arrayBuffer = await imgRes.arrayBuffer();

            const mediaType = f.mimeType || "image/jpeg";
            const caption = await captionPhotoInVoice(
              arrayBuffer,
              mediaType,
              anthropicKey,
              agentName,
              agentCity,
              voiceDna,
            );
            if (!caption) return null;
            const { description, suggestedPost } = caption;
            return {
              source: "drive" as const,
              fileId: f.id,
              fileName: f.name,
              driveUrl: `https://drive.google.com/file/d/${f.id}/view`,
              thumbnailUrl: `https://drive.google.com/thumbnail?id=${f.id}&sz=w400`,
              description,
              suggestedPost,
            };
          } catch {
            return null;
          }
        }),
      );

      return {
        suggestions: results.filter((r): r is PhotoScanSuggestion => Boolean(r)),
        totalPhotos: allFiles.length,
        unsupportedFormatCount,
      };
    },
  );

// Same idea as scanAgentDrivePhotos, but scans the agent's own native Media
// Library instead of their Drive folder — added 2026-09-18 per Mike's
// request that the scan tool "needs to scan the media library too and all
// photos," not just Drive. Library photos already have a public URL (no
// Drive API fetch needed), so this is simpler: pull the same "available,
// not yet attached to any post" pool assignSuggestedMedia draws from, fetch
// each image, and run it through the same voice-captioning call.
export const scanAgentLibraryPhotos = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; maxPhotos?: number; excludeFileIds?: string[] }) => data)
  .handler(async ({ data, context }): Promise<{ suggestions: PhotoScanSuggestion[]; totalPhotos: number }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const anthropicKey = process.env["ANTHROPIC_API_KEY"];
    if (!anthropicKey)
      throw new Error("Photo captioning isn't configured yet — add ANTHROPIC_API_KEY in Lovable Cloud → Secrets.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: agent } = await supabaseAdmin
      .from("agents")
      .select("full_name, market_area, voice_summary")
      .eq("id", data.agentId)
      .maybeSingle();
    const agentName = agent?.full_name ?? undefined;
    const agentCity = agent?.market_area ?? undefined;
    const voiceDna = agent?.voice_summary ?? undefined;

    const { data: photos, error } = await supabaseAdmin
      .from("agent_photos")
      .select("id, url, media_type, created_at")
      .eq("agent_id", data.agentId)
      .eq("status", "available")
      .order("created_at", { ascending: true })
      .limit(50);
    if (error) throw error;

    const maxPhotos = data.maxPhotos ?? 5;
    const excludeIds = new Set(data.excludeFileIds ?? []);
    const toProcess = (photos ?? [])
      .filter((p) => p.url && p.media_type !== "video" && !excludeIds.has(p.id))
      .slice(0, maxPhotos);

    const results = await Promise.all(
      toProcess.map(async (p): Promise<PhotoScanSuggestion | null> => {
        try {
          const imgRes = await fetch(p.url!);
          if (!imgRes.ok) return null;
          const arrayBuffer = await imgRes.arrayBuffer();
          const contentType = imgRes.headers.get("content-type") || "image/jpeg";

          const caption = await captionPhotoInVoice(
            arrayBuffer,
            contentType,
            anthropicKey,
            agentName,
            agentCity,
            voiceDna,
          );
          if (!caption) return null;
          return {
            source: "library" as const,
            fileId: p.id,
            fileName: p.id,
            driveUrl: p.url!,
            thumbnailUrl: p.url!,
            description: caption.description,
            suggestedPost: caption.suggestedPost,
          };
        } catch {
          return null;
        }
      }),
    );

    return {
      suggestions: results.filter((r): r is PhotoScanSuggestion => Boolean(r)),
      totalPhotos: photos?.length ?? 0,
    };
  });

export const addPhotoPostsToBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (data: {
      agentId: string;
      month: string;
      batchId?: string | undefined;
      items: {
        title: string;
        content: string;
        source: "drive" | "library";
        sourceId: string;
        thumbnailUrl: string;
      }[];
    }) => data,
  )
  .handler(async ({ data, context }): Promise<{ ok: true; created: number }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    if (!data.items.length) return { ok: true, created: 0 };
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const rows = data.items.map((item) => ({
      agent_id: data.agentId,
      content: item.content,
      content_type: "post",
      title: item.title,
      status: "pending",
      month: data.month,
      metadata:
        item.source === "drive"
          ? {
              batch_id: data.batchId ?? null,
              month: data.month,
              source: "drive_photo_scan",
              drive_file_id: item.sourceId,
              drive_thumbnail_url: item.thumbnailUrl,
            }
          : {
              batch_id: data.batchId ?? null,
              month: data.month,
              source: "library_photo_scan",
              media_id: item.sourceId,
              media_url: item.thumbnailUrl,
              media_type: "image",
            },
    }));
    const { error } = await supabaseAdmin.from("generated_posts").insert(rows);
    if (error) throw error;
    return { ok: true, created: rows.length };
  });

// ── Send to Agent — admin-only, ported from send-review.js (GoHighLevel) ───
// One deliberate change from the old app: the notification email links to
// this app's own secure login (/marketing) instead of the old public,
// no-auth review.html?agent=...&batch=... link — that link was exactly the
// hole Phase 1 closed, so recreating it would reopen it.

export const sendContentToAgent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; month: string }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    const access = await resolveAccess(context.userId, email);
    if (access.role !== "admin") {
      throw new Error("Only team members can send content to an agent for review.");
    }
    const ghlKey = process.env["GHL_API_KEY"];
    const ghlLocation = process.env["GHL_LOCATION_ID"];
    if (!ghlKey || !ghlLocation) {
      throw new Error(
        "Send to Agent isn't configured yet — add GHL_API_KEY and GHL_LOCATION_ID in Lovable Cloud → Secrets.",
      );
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: agent, error } = await supabaseAdmin
      .from("agents")
      .select("full_name, email")
      .eq("id", data.agentId)
      .maybeSingle();
    if (error) throw error;
    if (!agent?.email) throw new Error("No email address on file for this agent.");

    // NOTE (2026-09-18): this used to send Version: "2021-04-15" on every
    // call here, which is not a version GoHighLevel's v2/LeadConnector API
    // recognizes for either the contacts endpoints or conversations/messages
    // — that mismatch is almost certainly why Send to Agent's email was
    // silently failing even after GHL_API_KEY/GHL_LOCATION_ID were set
    // correctly. 2021-07-28 is the current stable version for both.
    const headers = {
      Authorization: "Bearer " + ghlKey,
      "Content-Type": "application/json",
      Version: "2021-07-28",
    };
    const searchRes = await fetch(
      "https://services.leadconnectorhq.com/contacts/search?locationId=" +
        ghlLocation +
        "&query=" +
        encodeURIComponent(agent.email),
      { headers },
    );
    const searchData = (await searchRes.json()) as { contacts?: { id: string }[] };
    let contactId = searchData.contacts?.[0]?.id ?? null;
    if (!contactId) {
      const createRes = await fetch("https://services.leadconnectorhq.com/contacts/", {
        method: "POST",
        headers,
        body: JSON.stringify({
          locationId: ghlLocation,
          email: agent.email,
          firstName: agent.full_name?.split(" ")[0] ?? "Agent",
          lastName: agent.full_name?.split(" ").slice(1).join(" ") ?? "",
        }),
      });
      const createData = (await createRes.json()) as { contact?: { id?: string }; id?: string };
      contactId = createData.contact?.id ?? createData.id ?? null;
    }
    if (!contactId) throw new Error(`Could not find or create a GoHighLevel contact for ${agent.email}.`);

    const firstName = agent.full_name?.split(" ")[0] ?? "there";
    const reviewUrl = (process.env["APP_URL"] ?? "https://marketing-dude-hq.lovable.app") + "/marketing";
    const emailHtml = `
<html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1A1A18;">
  <h2 style="font-size:22px;font-weight:600;margin-bottom:8px;">Hey ${firstName} — your ${data.month} content is ready!</h2>
  <p style="font-size:15px;color:#5A5A52;line-height:1.6;margin-bottom:24px;">Your social media posts and emails for ${data.month} are ready for your review. Log in and check the Monthly Marketing tab to see everything and let us know if it all sounds like you.</p>
  <a href="${reviewUrl}" style="display:inline-block;background:#1A1A18;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:600;margin-bottom:24px;">Review My Content →</a>
  <p style="font-size:13px;color:#9A9A90;line-height:1.6;">Takes about 5 minutes. The more feedback you give us, the better your content gets every month.<br/><br/>Talk soon,<br/><strong>Your Marketing Dude Team</strong></p>
</body></html>`.trim();

    const emailRes = await fetch("https://services.leadconnectorhq.com/conversations/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "Email",
        contactId,
        locationId: ghlLocation,
        emailFrom: "info@info.yourmarketingdude.com",
        emailTo: agent.email,
        subject: `${firstName} — Your ${data.month} Content Is Ready To Review`,
        html: emailHtml,
        body: emailHtml,
      }),
    });
    if (!emailRes.ok) {
      const emailData = (await emailRes.json()) as { message?: string };
      throw new Error(emailData.message ?? "GoHighLevel email send failed.");
    }
    return { ok: true };
  });
