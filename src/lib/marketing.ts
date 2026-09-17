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
  goal?: string | undefined;
  source?: string | undefined;
  drive_file_id?: string | undefined;
  drive_thumbnail_url?: string | undefined;
  [key: string]: string | number | boolean | null | undefined;
};

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
  metadata: PostMetadata | null;
};

export const listMarketingPosts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; month?: string }) => data)
  .handler(async ({ data, context }): Promise<PostRow[]> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    let query = supabaseAdmin
      .from("generated_posts")
      .select("id, content, content_type, title, platform, status, month, scheduled_for, created_at, metadata")
      .eq("agent_id", data.agentId)
      .order("created_at", { ascending: true });
    if (data.month) query = query.eq("month", data.month);
    const { data: posts, error } = await query;
    if (error) throw error;
    return (posts ?? []) as unknown as PostRow[];
  });

export const approveBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; batchId: string }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true; updated: number }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error: fetchErr } = await supabaseAdmin
      .from("generated_posts")
      .select("id")
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
      .select("agent_id")
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
    return { ok: true };
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
};

export const listAgentDriveMedia = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string }) => data)
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

    // Find the "used" subfolder first so its contents get excluded — same
    // rule the old app always applied.
    const subfolderUrl =
      "https://www.googleapis.com/drive/v3/files?" +
      "q=" +
      encodeURIComponent(
        `name='used' and '${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      ) +
      "&fields=files(id,name)&key=" +
      apiKey;
    const subfolderRes = await fetch(subfolderUrl);
    const subfolderData = (await subfolderRes.json()) as { files?: { id: string }[] };
    const usedFolderId = subfolderData.files?.[0]?.id ?? null;

    const q = `'${folderId}' in parents and (mimeType contains 'image/' or mimeType contains 'video/') and trashed=false`;
    const url =
      "https://www.googleapis.com/drive/v3/files?" +
      "q=" +
      encodeURIComponent(q) +
      "&fields=files(id,name,mimeType,parents)&pageSize=200&key=" +
      apiKey;
    const res = await fetch(url);
    const json = (await res.json()) as {
      files?: { id: string; name: string; mimeType: string; parents?: string[] }[];
      error?: { message?: string };
    };
    if (!res.ok) throw new Error(json.error?.message ?? `Google Drive API error (${res.status})`);

    const files: DriveFile[] = (json.files ?? [])
      .filter((f) => !usedFolderId || !(f.parents ?? []).includes(usedFolderId))
      .map((f) => ({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        isVideo: f.mimeType.startsWith("video/"),
        thumbnailUrl: `https://drive.google.com/thumbnail?id=${f.id}&sz=w400`,
        viewUrl: `https://drive.google.com/file/d/${f.id}/view`,
      }));

    return { folderId, files };
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

function buildContentPrompt(
  input: GenerateContentInput,
  agentName: string,
  agentCity: string,
  voiceDna: string,
): string {
  const extra = input.instructions?.trim() ? `\n\nADDITIONAL DIRECTION:\n${input.instructions.trim()}` : "";

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

    const prompt = buildContentPrompt(data, agentName, agentCity, voiceDna);

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
        },
      })
      .select("id")
      .single();
    if (error) throw error;
    return { ok: true, postId: row.id };
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

export type CalendarMonth = { id: string; month: string };

export const listCalendarMonths = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CalendarMonth[]> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAnyMarketingAccess(context.userId, email);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("content_calendar_months")
      .select("id, month")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as CalendarMonth[];
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
      .select("id, month")
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
  | { type: "post"; title: string; goal: string; image: string; canva: string; copy: string }
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

  const image = imageSection
    .split("\n")
    .map((l) =>
      l
        .replace(/^[-*•]\s*/, "")
        .replace(/^Clip\s*\d+:\s*/i, "")
        .replace(/^Option\s*\d+:\s*/i, "")
        .trim(),
    )
    .filter(Boolean)
    .join("; ");

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

  return { type: "post", title, goal, image, canva, copy };
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

async function callClaude(apiKey: string, prompt: string, maxTokens: number): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
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
  });
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
        "\nFor each post below:\n1. Read the CONCEPT and ORIGINAL carefully\n2. Find the story or the human truth in it\n3. Write it clearly in the agent's voice\n4. Make sure the last sentence lands and the whole post makes sense\n\n" +
        "Output format for each post:\nPOST [N]: [TITLE]\nREWRITTEN: [complete caption]\n---\n\n" +
        "Posts to write:\n" +
        postDocs.map((p, i) => `POST ${i + 1}: ${p.title}\nCONCEPT: ${p.goal}\nORIGINAL: ${p.copy}`).join("\n\n");

      const raw = await callClaude(anthropicKey, postPrompt, 4000);
      const blocks = raw.split("---").filter((b) => b.trim());
      blocks.forEach((block, i) => {
        const rm = block.match(/REWRITTEN:\s*([\s\S]*?)$/);
        const rewritten = rm ? cleanCopy(rm[1]!.trim()) : "";
        const doc = postDocs[i];
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
              goal: doc.goal,
              source: "content_calendar",
            },
          });
        }
      });
    }

    // Emails — one prompt per doc, same brief-vs-prewritten detection as before.
    for (const ed of emailDocs) {
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
            "NO hyphens. NO corporate language. NO AI tell phrases. Standard capitalization always.\n\n" +
            "Output format:\nSUBJECT OPTIONS:\n1. [subject]\n2. [subject]\n3. [subject]\n\nEMAIL BODY:\n[full email — reads like a note, not a newsletter]";
        } else {
          emailPrompt =
            `You are writing a real estate email for ${agentName} in ${agentCity}.\n\n` +
            `VOICE DNA:\n${dna}\n\n` +
            `EMAIL GOAL:\n${ed.goal || ""}\n\n` +
            `BRIEF TO FOLLOW:\n${instructions}\n\n` +
            `Write this email EXACTLY as ${agentName} would write it based on their Voice DNA above. Replace all [CITY], [NAME], [CITY, STATE] placeholders with ${agentName} and ${agentCity}.\n` +
            "NO hyphens. NO corporate language. NO AI-tell phrases. Standard capitalization always.\n\n" +
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
        rows.push({
          agent_id: data.agentId,
          content:
            (subjects.length ? `SUBJECT OPTIONS:\n${subjects.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n` : "") +
            body,
          content_type: "email",
          title: ed.title.replace("Email — ", ""),
          status: "pending",
          month: data.month,
          metadata: { batch_id: batchId, month: data.month, goal: ed.goal, source: "content_calendar" },
        });
      } catch {
        // Skip this email but keep generating the rest, same as the old app.
      }
    }

    // Video scripts
    for (const vd of videoDocs) {
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
        `Rules:\n- Sounds exactly like ${agentName} based on their Voice DNA\n- Written to be SPOKEN, not read — short sentences, natural pauses\n- NO hyphens, NO corporate language, NO AI phrases\n- Standard capitalization, never all lowercase\n- Real estate reminder energy — top of mind, not a pitch\n- 150 words maximum`;

      try {
        const vraw = cleanCopy(await callClaude(anthropicKey, videoPrompt, 600));
        rows.push({
          agent_id: data.agentId,
          content: vraw,
          content_type: "video",
          title: vd.title,
          status: "pending",
          month: data.month,
          metadata: { batch_id: batchId, month: data.month, goal: vd.goal, source: "content_calendar" },
        });
      } catch {
        // Skip, keep going.
      }
    }

    if (rows.length) {
      const { error } = await supabaseAdmin.from("generated_posts").insert(rows);
      if (error) throw error;
    }
    return { ok: true, batchId, created: rows.length };
  });

// ── Photo scan + caption — ported 1:1 from analyze-photos.js ───────────────

export type PhotoScanSuggestion = {
  fileId: string;
  fileName: string;
  driveUrl: string;
  thumbnailUrl: string;
  description: string;
  suggestedPost: string;
};

export const scanAgentDrivePhotos = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; folderId: string; maxPhotos?: number; excludeFileIds?: string[] }) => data)
  .handler(async ({ data, context }): Promise<{ suggestions: PhotoScanSuggestion[]; totalPhotos: number }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const googleKey = process.env["GOOGLE_API_KEY"];
    const anthropicKey = process.env["ANTHROPIC_API_KEY"];
    if (!googleKey)
      throw new Error("Google Drive isn't connected yet — add GOOGLE_API_KEY in Lovable Cloud → Secrets.");
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

    const usedFolderUrl =
      "https://www.googleapis.com/drive/v3/files?" +
      "q=" +
      encodeURIComponent(
        `name='used' and '${data.folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      ) +
      "&fields=files(id,name)&key=" +
      googleKey;
    const usedFolderRes = await fetch(usedFolderUrl);
    const usedFolderData = (await usedFolderRes.json()) as { files?: { id: string }[] };
    const usedFileIds = new Set<string>(data.excludeFileIds ?? []);
    if (usedFolderData.files?.length) {
      const usedFolderId = usedFolderData.files[0]!.id;
      const usedFilesUrl =
        "https://www.googleapis.com/drive/v3/files?" +
        "q=" +
        encodeURIComponent(`'${usedFolderId}' in parents and trashed=false`) +
        "&fields=files(id)&pageSize=200&key=" +
        googleKey;
      const usedFilesRes = await fetch(usedFilesUrl);
      const usedFilesData = (await usedFilesRes.json()) as { files?: { id: string }[] };
      (usedFilesData.files ?? []).forEach((f) => usedFileIds.add(f.id));
    }

    const listUrl =
      "https://www.googleapis.com/drive/v3/files?" +
      "q=" +
      encodeURIComponent(`'${data.folderId}' in parents and mimeType contains 'image/' and trashed=false`) +
      "&fields=files(id,name,mimeType)&pageSize=100&key=" +
      googleKey;
    const listRes = await fetch(listUrl);
    const listData = (await listRes.json()) as {
      files?: { id: string; name: string; mimeType: string }[];
      error?: { message?: string };
    };
    if (!listRes.ok) throw new Error(listData.error?.message ?? "Drive list failed");
    const files = listData.files ?? [];
    const maxPhotos = data.maxPhotos ?? 5;
    const toProcess = files.filter((f) => !usedFileIds.has(f.id)).slice(0, Math.min(files.length, maxPhotos));

    const results = await Promise.all(
      toProcess.map(async (f): Promise<PhotoScanSuggestion | null> => {
        try {
          const imgUrl = "https://www.googleapis.com/drive/v3/files/" + f.id + "?alt=media&key=" + googleKey;
          const imgRes = await fetch(imgUrl);
          if (!imgRes.ok) return null;
          const arrayBuffer = await imgRes.arrayBuffer();
          const base64 = Buffer.from(arrayBuffer).toString("base64");

          let mediaType = f.mimeType || "image/jpeg";
          if (mediaType === "image/heif" || mediaType === "image/heic" || /\.heic$/i.test(f.name)) return null;
          if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mediaType)) mediaType = "image/jpeg";

          const prompt =
            `You are creating a social media post for a real estate agent named ${agentName ?? "the agent"} in ${agentCity ?? "their city"}.\n\n` +
            `VOICE DNA:\n${voiceDna ?? "Warm, authentic, conversational. Sounds like a real person, not a real estate agent."}\n\n` +
            "Look at this photo and write a social media post that:\n1. Starts from what you actually see — the setting, the mood, the moment\n2. Sounds EXACTLY like this person based on their Voice DNA above\n3. Is 1-3 sentences max — short, human, texted-a-friend energy\n4. Does NOT mention real estate directly unless it is obviously a real estate moment\n5. Does NOT mention any specific location, city, neighborhood, or place name\n6. NO hyphens, NO corporate language, NO AI-tell phrases\n7. Standard capitalization — never write in all lowercase\n\n" +
            "Also describe what you see in the photo in one short sentence.\n\nOutput format:\nDESCRIPTION: [one sentence of what you see]\nPOST: [the social media caption]";

          const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": anthropicKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: "claude-haiku-4-5-20251001",
              max_tokens: 300,
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
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
            fileId: f.id,
            fileName: f.name,
            driveUrl: `https://drive.google.com/file/d/${f.id}/view`,
            thumbnailUrl: `https://drive.google.com/thumbnail?id=${f.id}&sz=w400`,
            description: descMatch ? descMatch[1]!.trim() : "Photo from Drive",
            suggestedPost: postMatch ? postMatch[1]!.trim() : raw,
          };
        } catch {
          return null;
        }
      }),
    );

    return { suggestions: results.filter((r): r is PhotoScanSuggestion => Boolean(r)), totalPhotos: files.length };
  });

export const addPhotoPostsToBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (data: {
      agentId: string;
      month: string;
      batchId?: string | undefined;
      items: { title: string; content: string; driveFileId: string; thumbnailUrl: string }[];
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
      metadata: {
        batch_id: data.batchId ?? null,
        month: data.month,
        source: "drive_photo_scan",
        drive_file_id: item.driveFileId,
        drive_thumbnail_url: item.thumbnailUrl,
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

    const headers = {
      Authorization: "Bearer " + ghlKey,
      "Content-Type": "application/json",
      Version: "2021-04-15",
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
