import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

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

type PostRow = {
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

export const listMarketingPosts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; month?: string }) => data)
  .handler(async ({ data, context }): Promise<PostRow[]> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    let query = supabaseAdmin
      .from("generated_posts")
      .select("id, content, content_type, title, platform, status, month, scheduled_for, created_at")
      .eq("agent_id", data.agentId)
      .order("created_at", { ascending: true });
    if (data.month) query = query.eq("month", data.month);
    const { data: posts, error } = await query;
    if (error) throw error;
    return (posts ?? []) as PostRow[];
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
