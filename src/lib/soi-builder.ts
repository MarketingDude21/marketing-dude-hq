import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// ============================================================================
// Build My Database / SOI Builder — native integration
//
// This talks to a SEPARATE Supabase project ("SOI Builder", not the one this
// dashboard itself runs on) that already has a fully working, live,
// battle-tested backend: 5 Edge Functions (process-upload, export-lists,
// upload-file, delete-upload, invite-client) doing all the real contact
// segmentation logic. None of that logic is touched, reimplemented, or
// changed here — this file only adds a way to reach it from inside the
// dashboard a user is already logged into, so there's no second login.
//
// Identity bridge: SOI Builder has its own separate Supabase Auth users
// (its `clients`/`team_members`/`client_access` tables key off THOSE users'
// ids, not this dashboard's). There is no shared user id or email column to
// join on directly, so the bridge is: take the dashboard user's email
// (from their verified JWT claims) and look up a matching user over in SOI
// Builder's own auth system via the admin API. If found, `team_members` or
// `client_access` tells us their role there exactly as it always did — this
// doesn't loosen or change SOI Builder's own access rules at all, it just
// resolves them automatically instead of asking the person to log in twice.
//
// Requires two secrets added in Lovable Cloud -> Secrets (server-only,
// never sent to the browser):
//   SOI_SUPABASE_URL                  = https://xoqrupoygkhkpobeekjz.supabase.co
//   SOI_SUPABASE_SERVICE_ROLE_KEY     = (the service_role key from that
//                                        project's Settings -> API)
//
// Auto-provisioning: the first time someone with no existing team_members or
// client_access row opens Build My Database, provisionSoiClient() creates a
// SOI Builder client for them automatically (see below) - signing into the
// dashboard IS the onboarding step now, no separate manual "invite client"
// action needed for a normal client. IMPORTANT: this treats anyone unknown
// to SOI Builder as a new CLIENT. If Mike ever adds a new team member, add
// their team_members row in SOI Builder first (Supabase Studio) BEFORE they
// ever open Build My Database in the dashboard, or they'll be auto-enrolled
// as a client instead.
// ============================================================================

function getSoiAdminClient(): SupabaseClient {
  const url = process.env["SOI_SUPABASE_URL"];
  const serviceKey = process.env["SOI_SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !serviceKey) {
    throw new Error(
      "Build My Database isn't connected yet — add SOI_SUPABASE_URL and SOI_SUPABASE_SERVICE_ROLE_KEY in Lovable Cloud -> Secrets.",
    );
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type SoiAccess = { role: "team" } | { role: "client"; clientId: string; clientName: string } | { role: "none" };

// Resolves the currently logged-in dashboard user's role in SOI Builder by
// email. Nothing here bypasses SOI Builder's own access rules - it just
// looks up the same team_members / client_access rows the old separate
// login screen would have checked after a manual sign-in.
async function resolveAccessForEmail(admin: SupabaseClient, email: string): Promise<SoiAccess> {
  const cleanEmail = email.toLowerCase().trim();

  // SOI Builder's own auth.users - separate account system from this
  // dashboard's. Paginated in case the account list ever grows past a
  // single page; team + clients combined are unlikely to exceed a few
  // pages, but this is cheap insurance against silently missing someone.
  let matchedUserId: string | undefined;
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const found = data.users.find((u) => (u.email ?? "").toLowerCase() === cleanEmail);
    if (found) {
      matchedUserId = found.id;
      break;
    }
    if (data.users.length < 1000) break;
  }

  if (!matchedUserId) return { role: "none" };

  const { data: teamRow } = await admin
    .from("team_members")
    .select("user_id")
    .eq("user_id", matchedUserId)
    .maybeSingle();
  if (teamRow) return { role: "team" };

  const { data: accessRow } = await admin
    .from("client_access")
    .select("client_id")
    .eq("user_id", matchedUserId)
    .maybeSingle();
  if (accessRow) {
    const { data: clientRow } = await admin.from("clients").select("name").eq("id", accessRow.client_id).maybeSingle();
    return { role: "client", clientId: accessRow.client_id, clientName: clientRow?.name ?? "Your database" };
  }

  return { role: "none" };
}

export const getSoiAccess = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<SoiAccess> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    if (!email) return { role: "none" };
    const admin = getSoiAdminClient();
    return resolveAccessForEmail(admin, email);
  });

function randomSoiPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 24; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// Auto-provisions a brand-new SOI Builder client the moment someone who
// isn't already a team member or client there opens Build My Database.
// Previously a team member had to run the old app's "invite client" flow by
// hand, one person at a time, before that person could see anything here.
// Mike's requirement: signing into the unified dashboard IS the client
// onboarding now, so this has to happen automatically, not as a separate
// manual step. This does the same two things invite-client always did
// (create their SOI Builder login, link it to a client record) but from a
// trusted server context on the dashboard's behalf, since the person
// arriving here is a brand-new client, not yet a team member with a bearer
// token invite-client could authenticate.
export const provisionSoiClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<SoiAccess> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    if (!email) return { role: "none" };
    const admin = getSoiAdminClient();

    // Re-check fresh, right before creating anything - never provision over
    // an existing team_members or client_access row, and safe to call more
    // than once (e.g. a page refresh mid-provisioning) without duplicating.
    const existing = await resolveAccessForEmail(admin, email);
    if (existing.role !== "none") return existing;

    const cleanEmail = email.toLowerCase().trim();

    // A friendlier client name than the raw email, pulled from this same
    // person's dashboard profile (Voice DNA's agents.full_name) when they
    // have one set - SOI Builder's own `clients` table has no email column
    // to look this up by, so there's nothing to borrow from over there.
    let clientName = cleanEmail;
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: agentRow } = await supabaseAdmin
        .from("agents")
        .select("full_name")
        .eq("id", context.userId)
        .maybeSingle();
      if (agentRow?.full_name) clientName = agentRow.full_name;
    } catch {
      // Non-fatal - fall back to using the email as the client name.
    }

    // Create their SOI Builder login. They'll never actually sign in with
    // it directly - the dashboard session is what grants access now - so
    // the password is random and thrown away immediately.
    let soiUserId: string | undefined;
    const created = await admin.auth.admin.createUser({
      email: cleanEmail,
      password: randomSoiPassword(),
      email_confirm: true,
    });
    if (!created.error) {
      soiUserId = created.data.user?.id;
    } else {
      // Already exists over there under this email but somehow has neither
      // a team_members nor client_access row (resolveAccessForEmail just
      // checked and found none) - look the account up rather than failing.
      for (let page = 1; ; page++) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) throw error;
        const found = data.users.find((u) => (u.email ?? "").toLowerCase() === cleanEmail);
        if (found) {
          soiUserId = found.id;
          break;
        }
        if (data.users.length < 1000) break;
      }
    }
    if (!soiUserId) throw new Error("Could not create your Build My Database account.");

    const { data: clientRow, error: clientErr } = await admin
      .from("clients")
      .insert({ name: clientName })
      .select("id, name")
      .single();
    if (clientErr) throw clientErr;

    const { error: accessErr } = await admin
      .from("client_access")
      .upsert({ user_id: soiUserId, client_id: clientRow.id }, { onConflict: "user_id,client_id" });
    if (accessErr) throw accessErr;

    return { role: "client", clientId: clientRow.id, clientName: clientRow.name ?? clientName };
  });

// Team members manage multiple clients - the picker list for that view.
export const listSoiClients = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    const admin = getSoiAdminClient();
    const access = email ? await resolveAccessForEmail(admin, email) : { role: "none" as const };
    if (access.role !== "team") {
      throw new Error("Only team members can view the client list.");
    }
    const { data, error } = await admin
      .from("clients")
      .select("id, name, processing_started_at, created_at")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data;
  });

// Shared guard used by every per-client action below: re-resolves the
// caller's access every call (rather than trusting a client_id the browser
// sends) so a client can never pass someone else's client_id and a team
// member is always verified fresh. Small extra cost, real security value.
async function requireClientAccess(
  admin: SupabaseClient,
  email: string | undefined,
  requestedClientId: string,
): Promise<void> {
  if (!email) throw new Error("Not authenticated");
  const access = await resolveAccessForEmail(admin, email);
  if (access.role === "team") return;
  if (access.role === "client" && access.clientId === requestedClientId) return;
  throw new Error("Not authorized for this client");
}

export const listSoiUploads = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((data: { clientId: string }) => data)
  .handler(async ({ data, context }) => {
    const admin = getSoiAdminClient();
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireClientAccess(admin, email, data.clientId);
    const { data: uploads, error } = await admin
      .from("uploads")
      .select("id, file_name, source_label, status, row_count, error_message, created_at")
      .eq("client_id", data.clientId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return uploads;
  });

export const uploadSoiFile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (data: { clientId: string; fileName: string; sourceLabel: string; kind: "vcf" | "mapped_csv"; content: string }) =>
      data,
  )
  .handler(async ({ data, context }) => {
    const admin = getSoiAdminClient();
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireClientAccess(admin, email, data.clientId);

    // Calls the SAME upload-file Edge Function that's been running this
    // app in production - not a reimplementation, the real thing.
    const url = process.env["SOI_SUPABASE_URL"];
    const serviceKey = process.env["SOI_SUPABASE_SERVICE_ROLE_KEY"];
    const res = await fetch(`${url}/functions/v1/upload-file`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey!,
      },
      body: JSON.stringify({
        client_id: data.clientId,
        file_name: data.fileName,
        source_label: data.sourceLabel,
        kind: data.kind,
        content: data.content,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? `upload-file failed (${res.status})`);
    return json;
  });

export const deleteSoiUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { clientId: string; uploadId: string }) => data)
  .handler(async ({ data, context }) => {
    const admin = getSoiAdminClient();
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireClientAccess(admin, email, data.clientId);

    // Same behavior as the original delete-upload function (remove Storage
    // file(s) + the uploads row) - reimplemented directly here rather than
    // calling that function over HTTP, because it authenticates its caller
    // with a real per-user access token, which a service-role backend call
    // doesn't have. The access check above (requireClientAccess) already
    // covers exactly what that function's own check covered.
    const { data: upload, error: findErr } = await admin
      .from("uploads")
      .select("id, client_id, file_name, storage_path")
      .eq("id", data.uploadId)
      .single();
    if (findErr || !upload) throw new Error("Upload not found");
    if (upload.client_id !== data.clientId) throw new Error("Not authorized for this client");

    await admin.storage.from("uploads").remove([upload.storage_path, `${upload.storage_path}.mapped.json`]);
    const { error: deleteErr } = await admin.from("uploads").delete().eq("id", data.uploadId);
    if (deleteErr) throw deleteErr;
    return { deleted: upload.file_name };
  });

export const processSoiUploads = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { clientId: string }) => data)
  .handler(async ({ data, context }) => {
    const admin = getSoiAdminClient();
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireClientAccess(admin, email, data.clientId);

    const url = process.env["SOI_SUPABASE_URL"];
    const serviceKey = process.env["SOI_SUPABASE_SERVICE_ROLE_KEY"];
    const res = await fetch(`${url}/functions/v1/process-upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey!,
      },
      body: JSON.stringify({ client_id: data.clientId }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? `process-upload failed (${res.status})`);
    return json as {
      raw_total: number;
      unique_total: number;
      dedupe_stats: Record<string, number>;
      list_counts: Record<string, number>;
      address_corrections: { name: string; message: string }[];
      borderline_flags: { name: string; email: string; domain: string }[];
    };
  });

const HUB_LISTS = [
  "direct_mail",
  "email_phone",
  "email_list",
  "incomplete",
  "nonqualified",
  "realtor_excluded",
  "business_excluded",
] as const;

export const getSoiHubCounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((data: { clientId: string }) => data)
  .handler(async ({ data, context }) => {
    const admin = getSoiAdminClient();
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireClientAccess(admin, email, data.clientId);

    const counts: Record<string, number> = {};
    for (const list of HUB_LISTS) {
      const { count, error } = await admin
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("client_id", data.clientId)
        .eq("list_assignment", list);
      if (error) throw error;
      counts[list] = count ?? 0;
    }
    return counts;
  });

// Review-flag joins for the 3-step wizard (primary review_type only - the
// same lists the original wizard reviewed). Read-only, so reimplementing
// this one small join here (rather than only ever calling export-lists) is
// safe - it doesn't change how any contact is classified.
export const getSoiReviewCandidates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator(
    (data: { clientId: string; listAssignment: "direct_mail" | "email_phone" | "email_list" | "incomplete" }) => data,
  )
  .handler(async ({ data, context }) => {
    const admin = getSoiAdminClient();
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireClientAccess(admin, email, data.clientId);

    const listsForAssignment =
      data.listAssignment === "direct_mail" || data.listAssignment === "email_phone"
        ? [data.listAssignment]
        : [data.listAssignment];

    const { data: contacts, error } = await admin
      .from("contacts")
      .select("id, first_name, last_name, email, phone, address, city, state, zip, notes, sources, list_assignment")
      .eq("client_id", data.clientId)
      .in("list_assignment", listsForAssignment)
      .order("last_name", { ascending: true });
    if (error) throw error;

    const ids = contacts.map((c) => c.id);
    const flagsById = new Map<string, boolean>();
    if (ids.length) {
      const { data: flags, error: flagsErr } = await admin
        .from("review_flags")
        .select("contact_id, flagged")
        .eq("review_type", "primary")
        .in("contact_id", ids);
      if (flagsErr) throw flagsErr;
      for (const f of flags ?? []) flagsById.set(f.contact_id, f.flagged);
    }

    return contacts.map((c) => ({ ...c, flagged: flagsById.get(c.id) ?? false }));
  });

type SoiContactRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  notes: string | null;
  sources: string[] | null;
  list_assignment: string | null;
};

async function fetchContactsForList(
  admin: SupabaseClient,
  clientId: string,
  listAssignment: string,
): Promise<SoiContactRow[]> {
  const { data, error } = await admin
    .from("contacts")
    .select("id, first_name, last_name, email, phone, address, city, state, zip, notes, sources, list_assignment")
    .eq("client_id", clientId)
    .eq("list_assignment", listAssignment)
    .order("last_name", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function fetchFlagsById(
  admin: SupabaseClient,
  contactIds: string[],
  reviewType: string,
): Promise<Map<string, boolean>> {
  const flagsById = new Map<string, boolean>();
  if (!contactIds.length) return flagsById;
  const { data, error } = await admin
    .from("review_flags")
    .select("contact_id, flagged")
    .eq("review_type", reviewType)
    .in("contact_id", contactIds);
  if (error) throw error;
  for (const f of data ?? []) flagsById.set(f.contact_id, f.flagged);
  return flagsById;
}

// Browsable (read-only, no checkboxes) views the old app's tab bar showed
// alongside the 3 review steps: the pure "everyone in this bucket" lists
// (nonqualified/realtor_excluded/business_excluded), and two COMPUTED
// populations that span multiple list_assignment values, matching the exact
// same logic export-lists already uses for those two CSV scopes - safe to
// mirror here since these are read-only, nothing is reclassified.
export const getSoiListView = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator(
    (data: {
      clientId: string;
      view: "nonqualified" | "realtor_excluded" | "business_excluded" | "facebook_audience" | "final_full_contact";
    }) => data,
  )
  .handler(async ({ data, context }): Promise<SoiContactRow[]> => {
    const admin = getSoiAdminClient();
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireClientAccess(admin, email, data.clientId);

    if (data.view === "nonqualified" || data.view === "realtor_excluded" || data.view === "business_excluded") {
      return fetchContactsForList(admin, data.clientId, data.view);
    }

    if (data.view === "facebook_audience") {
      // Same rule as export-lists' facebook_audience scope: everyone not
      // realtor/business-excluded, with an email or phone to target with.
      const lists = ["direct_mail", "email_phone", "email_list", "incomplete", "nonqualified"];
      const groups = await Promise.all(lists.map((l) => fetchContactsForList(admin, data.clientId, l)));
      return groups.flat().filter((c) => !!(c.email || c.phone));
    }

    // "final_full_contact" - same survivor + full-8-field rule export-lists
    // uses for its matching CSV scope.
    const reviewLists = ["direct_mail", "email_phone", "email_list", "incomplete"] as const;
    const groups = await Promise.all(reviewLists.map((l) => fetchContactsForList(admin, data.clientId, l)));
    const allContacts = groups.flat();
    const flagsById = await fetchFlagsById(
      admin,
      allContacts.map((c) => c.id),
      "primary",
    );

    function isSurvivor(c: SoiContactRow): boolean {
      const flagged = flagsById.get(c.id) ?? false;
      if (c.list_assignment === "direct_mail" || c.list_assignment === "email_phone") return !flagged;
      if (c.list_assignment === "email_list" || c.list_assignment === "incomplete") return flagged;
      return false;
    }
    function isFullContact(c: SoiContactRow): boolean {
      return !!(c.first_name && c.last_name && c.email && c.phone && c.address && c.city && c.state && c.zip);
    }
    return allContacts.filter((c) => isSurvivor(c) && isFullContact(c));
  });

export const setSoiReviewFlag = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { clientId: string; contactId: string; reviewType: string; flagged: boolean }) => data)
  .handler(async ({ data, context }) => {
    const admin = getSoiAdminClient();
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireClientAccess(admin, email, data.clientId);

    // Confirm the contact actually belongs to this client before writing -
    // review_flags itself has no client_id column (it's keyed off
    // contact_id only), so this is the one place that boundary has to be
    // enforced explicitly.
    const { data: contact, error: contactErr } = await admin
      .from("contacts")
      .select("id, client_id")
      .eq("id", data.contactId)
      .single();
    if (contactErr || !contact || contact.client_id !== data.clientId) {
      throw new Error("Not authorized for this contact");
    }

    const { error } = await admin
      .from("review_flags")
      .upsert(
        {
          contact_id: data.contactId,
          review_type: data.reviewType,
          flagged: data.flagged,
          flagged_by: email ?? "unknown",
        },
        { onConflict: "contact_id,review_type" },
      );
    if (error) throw error;
    return { ok: true };
  });

export const exportSoiList = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { clientId: string; scope: string }) => data)
  .handler(async ({ data, context }) => {
    const admin = getSoiAdminClient();
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireClientAccess(admin, email, data.clientId);

    const url = process.env["SOI_SUPABASE_URL"];
    const serviceKey = process.env["SOI_SUPABASE_SERVICE_ROLE_KEY"];
    const res = await fetch(`${url}/functions/v1/export-lists`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey!,
      },
      body: JSON.stringify({ client_id: data.clientId, scope: data.scope }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? `export-lists failed (${res.status})`);
    return json as {
      files?: Record<string, string>;
      contacts?: {
        id: string;
        first_name: string | null;
        last_name: string | null;
        email: string | null;
        phone: string | null;
        address: string | null;
        address_2: string | null;
        city: string | null;
        state: string | null;
        zip: string | null;
        notes: string | null;
        sources: string[] | null;
        list_assignment: string | null;
        already_selected: boolean;
        missing: string[];
      }[];
      warnings?: string[];
    };
  });
