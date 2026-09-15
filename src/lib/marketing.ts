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

async function resolveAccess(
  userId: string,
  email: string | undefined,
): Promise<MarketingAccess> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  if (email) {
    const { data: allow } = await supabaseAdmin
      .from("admin_allowlist")
      .select("email")
      .eq("email", email.toLowerCase().trim())
      .maybeSingle();
    if (allow) return { role: "admin" };
  }

  const { data: agent } = await supabaseAdmin
    .from("agents")
    .select("id, full_name")
    .eq("id", userId)
    .maybeSingle();
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
async function requireAgentAccess(
  userId: string,
  email: string | undefined,
  requestedAgentId: string,
): Promise<void> {
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
  .inputValidator((data: { agentId: string; month?: string }) => data)
  .handler(async ({ data, context }): Promise<PostRow[]> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    let query = supabaseAdmin
      .from("generated_posts")
      .select(
        "id, content, content_type, title, platform, status, month, scheduled_for, created_at",
      )
      .eq("agent_id", data.agentId)
      .order("created_at", { ascending: true });
    if (data.month) query = query.eq("month", data.month);
    const { data: posts, error } = await query;
    if (error) throw error;
    return (posts ?? []) as PostRow[];
  });

export const listMarketingMonths = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { agentId: string }) => data)
  .handler(async ({ data, context }): Promise<string[]> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error } = await supabaseAdmin
      .from("generated_posts")
      .select("month")
      .eq("agent_id", data.agentId);
    if (error) throw error;
    const months = Array.from(
      new Set((rows ?? []).map((r) => r.month).filter((m): m is string => Boolean(m))),
    );
    months.sort();
    months.reverse();
    return months;
  });

export const updateMarketingPost = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: { agentId: string; postId: string; content?: string; status?: string }) => data,
  )
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

    const { error } = await supabaseAdmin
      .from("generated_posts")
      .update(update)
      .eq("id", data.postId);
    if (error) throw error;
    return { ok: true };
  });

export const submitMarketingFeedback = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: { agentId: string; postId: string; rating?: string; notes?: string }) => data,
  )
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
  .inputValidator((data: { agentId: string }) => data)
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
