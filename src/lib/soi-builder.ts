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
  .inputValidator((data: { clientId: string }) => data)
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
  .inputValidator(
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
  .inputValidator((data: { clientId: string; uploadId: string }) => data)
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

type ProcessUploadReport = {
  raw_total: number;
  unique_total: number;
  dedupe_stats: Record<string, number>;
  list_counts: Record<string, number>;
  address_corrections: { name: string; message: string }[];
  borderline_flags: { name: string; email: string; domain: string }[];
};

// Calls the real process-upload Edge Function directly - factored out of
// processSoiUploads below so the new DataZapp-append step (further down)
// can reuse it too, after writing newly-appended email/address fields
// straight into `contacts`, to get everyone correctly reclassified out of
// Incomplete/Nonqualified without duplicating any of the real segmentation
// rules here.
async function runProcessUpload(clientId: string): Promise<ProcessUploadReport> {
  const url = process.env["SOI_SUPABASE_URL"];
  const serviceKey = process.env["SOI_SUPABASE_SERVICE_ROLE_KEY"];
  const res = await fetch(`${url}/functions/v1/process-upload`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey!,
    },
    body: JSON.stringify({ client_id: clientId }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `process-upload failed (${res.status})`);
  return json as ProcessUploadReport;
}

export const processSoiUploads = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { clientId: string }) => data)
  .handler(async ({ data, context }): Promise<ProcessUploadReport> => {
    const admin = getSoiAdminClient();
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireClientAccess(admin, email, data.clientId);
    return runProcessUpload(data.clientId);
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

// Every list that has a checkbox review step at all - direct_mail/email_phone
// are opt-OUT (checked = removed), email_list/incomplete are opt-IN (checked
// = kept). The frontend combines these into "checked/total" (opt-in) or
// "survivors/total" (opt-out, i.e. total minus checked) as appropriate - see
// BREAKDOWN_CARDS in database.tsx. Mike wants this same real-time
// transparency (no downloading needed to see who'll make the final list) on
// every reviewable bucket, not just the opt-in ones.
const CHECKED_COUNT_LISTS = ["direct_mail", "email_phone", "email_list", "incomplete"] as const;

export const getSoiHubCounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { clientId: string }) => data)
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

    // "!inner" forces the join so filtering on the embedded review_flags
    // columns actually restricts which contacts are counted (a plain left
    // join would still count every contact, flagged or not).
    for (const list of CHECKED_COUNT_LISTS) {
      const { count, error } = await admin
        .from("contacts")
        .select("id, review_flags!inner(flagged)", { count: "exact", head: true })
        .eq("client_id", data.clientId)
        .eq("list_assignment", list)
        .eq("review_flags.review_type", "primary")
        .eq("review_flags.flagged", true);
      if (error) throw error;
      counts[`${list}_checked`] = count ?? 0;
    }

    return counts;
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

const PAGE_SIZE = 1000;

// Plain paginated fetch of everyone in one list_assignment bucket. Loops on
// .range() instead of a single unbounded select - PostgREST caps a single
// request at 1000 rows by default, and several of Mike's real buckets
// (nonqualified alone has run past 3000) blow past that easily.
async function fetchContactsForList(
  admin: SupabaseClient,
  clientId: string,
  listAssignment: string,
): Promise<SoiContactRow[]> {
  let rows: SoiContactRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await admin
      .from("contacts")
      .select("id, first_name, last_name, email, phone, address, city, state, zip, notes, sources, list_assignment")
      .eq("client_id", clientId)
      .eq("list_assignment", listAssignment)
      .order("last_name", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows = rows.concat(data ?? []);
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

// Same idea, but also joins in each contact's review_flags.flagged - using
// PostgREST's embedded-resource join (contacts JOIN review_flags server
// side) instead of fetching contacts, collecting their ids, then a second
// "WHERE contact_id IN (id1, id2, id3, ...)" lookup. That second shape is
// exactly what previously broke export-lists outright for a big client (see
// that function's own header comment in the recovered backup) - the id list
// gets long enough to blow past a single request's URL length limit.
// getSoiReviewCandidates and getSoiListView's final_full_contact branch had
// that same latent bug; it just never got exercised by a small enough test
// client until now. Paginated the same way as fetchContactsForList above.
async function fetchContactsWithFlags(
  admin: SupabaseClient,
  clientId: string,
  listAssignment: string,
  reviewType: string,
): Promise<(SoiContactRow & { flagged: boolean })[]> {
  let rows: (SoiContactRow & { flagged: boolean })[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await admin
      .from("contacts")
      .select(
        "id, first_name, last_name, email, phone, address, city, state, zip, notes, sources, list_assignment, review_flags(flagged)",
      )
      .eq("client_id", clientId)
      .eq("list_assignment", listAssignment)
      .eq("review_flags.review_type", reviewType)
      .order("last_name", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []).map((row: Record<string, unknown>) => {
      const { review_flags, ...contact } = row;
      const rf = review_flags as { flagged: boolean }[] | { flagged: boolean } | null;
      const flagged = Array.isArray(rf) ? rf.some((r) => r?.flagged) : !!rf?.flagged;
      return { ...(contact as SoiContactRow), flagged };
    });
    rows = rows.concat(page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

// Review-flag joins for the 3-step wizard (primary review_type only - the
// same lists the original wizard reviewed). Read-only, so reimplementing
// this one small join here (rather than only ever calling export-lists) is
// safe - it doesn't change how any contact is classified.
export const getSoiReviewCandidates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: { clientId: string; listAssignment: "direct_mail" | "email_phone" | "email_list" | "incomplete" }) => data,
  )
  .handler(async ({ data, context }) => {
    const admin = getSoiAdminClient();
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireClientAccess(admin, email, data.clientId);

    return fetchContactsWithFlags(admin, data.clientId, data.listAssignment, "primary");
  });

// Browsable (read-only, no checkboxes) views the old app's tab bar showed
// alongside the 3 review steps: the pure "everyone in this bucket" lists
// (nonqualified/realtor_excluded/business_excluded), and two COMPUTED
// populations that span multiple list_assignment values, matching the exact
// same logic export-lists already uses for those two CSV scopes - safe to
// mirror here since these are read-only, nothing is reclassified.
export const getSoiListView = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
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
    // uses for its matching CSV scope. Uses the same join-based, paginated
    // fetch as getSoiReviewCandidates above - this branch used to build a
    // flat id list across all 4 review lists and look up flags separately,
    // which is exactly the shape that can blow past a URL length limit for
    // a client with a lot of contacts.
    const reviewLists = ["direct_mail", "email_phone", "email_list", "incomplete"] as const;
    const groups = await Promise.all(
      reviewLists.map((l) => fetchContactsWithFlags(admin, data.clientId, l, "primary")),
    );
    const allContacts = groups.flat();

    function isSurvivor(c: SoiContactRow & { flagged: boolean }): boolean {
      if (c.list_assignment === "direct_mail" || c.list_assignment === "email_phone") return !c.flagged;
      if (c.list_assignment === "email_list" || c.list_assignment === "incomplete") return c.flagged;
      return false;
    }
    function isFullContact(c: SoiContactRow): boolean {
      return !!(c.first_name && c.last_name && c.email && c.phone && c.address && c.city && c.state && c.zip);
    }
    return allContacts.filter((c) => isSurvivor(c) && isFullContact(c));
  });

export const setSoiReviewFlag = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { clientId: string; contactId: string; reviewType: string; flagged: boolean }) => data)
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

    const { error } = await admin.from("review_flags").upsert(
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
  .inputValidator((data: { clientId: string; scope: string }) => data)
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

// ============================================================================
// DataZapp append verification — a second-round "Append Data" step added
// 2026-10-15 at Mike's request. The problem it solves: contacts missing an
// email/mailing address get sent out to DataZapp (a third-party append
// service, keyed on first name + last name + phone) to fill those gaps in -
// mainly for direct mail, which is the actual product being sold. DataZapp's
// reply often attaches the WRONG name to the address it finds, because it's
// matching at the household/address level, not the individual - it hands
// back whichever resident it has on file (a spouse, a prior occupant), not
// necessarily the exact person Mike sent it. Mike's own words: "not
// everything that appends matches the names... Mike and Michael, Kate and
// Catherine... we need to know that's probably the same person."
//
// Deliberately a SEPARATE path from processSoiUploads/process-upload above,
// not a variant of it - that function's job is segmenting freshly uploaded
// raw list rows, and its weakest dedupe key (exact first+last name, used
// only when a row has neither email nor phone) is exactly the kind of
// mismatch this guards against, not something to lean on harder here. A
// DataZapp return file already carries one unambiguous key straight back to
// an existing contact - the very phone number Mike sent them - so finding
// the right contact is a plain phone lookup, never a fuzzy one. The only
// real judgment call is whether DataZapp's OWN appended name agrees with the
// original name on that same row, which decides whether its appended
// email/address gets trusted enough to write back.
//
// Built against two real sample files Mike sent (DataZapp's actual export
// format - 44 columns, 927 rows), not guessed. What they showed:
//   - DataZapp returns SOME data (at minimum an address) for 640 of 927 rows
//     here; an appended email is rarer (382 of 927) - address really is the
//     main yield, matching what Mike's actually after.
//   - Of the 640 with a name back, only 209 (~33%) matched the original
//     first+last name exactly. The rest split between genuine nicknames,
//     a same-household resident returned instead of the person asked for
//     (DataZapp_FIRST2/LAST2 carries a second household name on 144 rows,
//     and it's often the real match when the primary slot isn't - e.g. "Don
//     Blevins" came back with primary "Beverly Blevins" [his spouse] and
//     secondary "Donald Blevins" [Don's own formal name]), and outright
//     wrong-address matches sharing no name at all with the original.
//
// REDESIGNED same day, after Mike tested the first version live and got
// "Applied: Updated 0 of 927 contacts" - and separately told us the
// no-review auto-apply design itself was wrong even once that's fixed: "just
// because the data is appended doesn't mean they're going to keep them." See
// the comment on previewDatazappAppend/applyDatazappAppend below for what
// changed - the matching logic above (nickname clusters, confirmed/
// household/mismatch tiers) is unchanged and still verified against the same
// real 927-row file; only what happens with a match changed, from "write it
// automatically" to "show it to Mike's team and let them decide."
// ============================================================================

// Clusters of common American first-name nicknames/formal-name pairs, so
// "Jim" on the original contact and "James" on DataZapp's reply count as
// confirmed, not a mismatch - per Mike, "we need to know that's probably the
// same person." Not exhaustive (there's no complete list of every nickname
// in English) - add a row here any time a real one gets missed; each row is
// its own self-contained cluster, order doesn't matter.
const NICKNAME_CLUSTERS: string[][] = [
  ["james", "jim", "jimmy", "jamie"],
  ["michael", "mike", "mikey", "mick", "mickey", "micheal"],
  ["robert", "bob", "bobby", "rob", "robbie"],
  ["william", "bill", "billy", "will", "willy", "liam"],
  ["richard", "rick", "ricky", "rich", "dick"],
  ["charles", "charlie", "chuck", "chas", "chick"],
  ["thomas", "tom", "tommy"],
  ["christopher", "chris", "topher", "kit"],
  ["daniel", "dan", "danny"],
  ["matthew", "matt", "matty"],
  ["anthony", "tony"],
  ["joseph", "joe", "joey"],
  ["david", "dave", "davey", "davy"],
  ["edward", "ed", "eddie", "eddy", "ted", "teddy"],
  ["donald", "don", "donnie", "donny"],
  ["steven", "stephen", "steve", "stevie"],
  ["kenneth", "ken", "kenny"],
  ["jeffrey", "jeff", "geoff", "geoffrey"],
  ["timothy", "tim", "timmy"],
  ["ronald", "ron", "ronnie"],
  ["gerald", "gerry", "jerry"],
  ["lawrence", "larry"],
  ["patrick", "pat", "paddy", "patsy"],
  ["raymond", "ray"],
  ["gregory", "greg", "gregg"],
  ["alexander", "alex", "xander", "al"],
  ["nicholas", "nick", "nicky", "nico"],
  ["benjamin", "ben", "benny", "benji"],
  ["samuel", "sam", "sammy"],
  ["jonathan", "jon", "jonny"],
  ["john", "johnny", "jack", "jock"],
  ["jacob", "jake", "jakey"],
  ["henry", "hank"],
  ["frederick", "fred", "freddie", "freddy"],
  ["francis", "frank", "frankie"],
  ["walter", "walt", "wally"],
  ["albert", "al", "bert", "bertie"],
  ["arthur", "art", "artie"],
  ["eugene", "gene"],
  ["harold", "harry", "hal"],
  ["howard", "howie"],
  ["joshua", "josh"],
  ["nathaniel", "nathan", "nate"],
  ["zachary", "zach", "zack", "zak"],
  ["peter", "pete", "petey"],
  ["philip", "phillip", "phil"],
  ["vincent", "vince", "vinny"],
  ["martin", "marty"],
  ["douglas", "doug"],
  ["bradley", "brad"],
  ["russell", "russ"],
  ["victor", "vic"],
  ["leonard", "leo", "lenny"],
  ["theodore", "ted", "teddy", "theo"],
  ["dominic", "dom"],
  ["andrew", "andy", "drew"],
  ["marcus", "mark", "marc"],
  ["randall", "randal", "randy"],
  ["dwayne", "dwane", "duane"],
  ["elias", "eli"],
  ["ernest", "ernie", "erny"],
  ["elizabeth", "liz", "lizzie", "beth", "betty", "eliza", "liza", "betsy"],
  ["katherine", "katharine", "catherine", "kathryn", "kate", "katie", "kathy", "cathy", "kit", "kitty", "cat", "kat"],
  ["margaret", "maggie", "peggy", "meg", "margie", "marge", "margo"],
  ["patricia", "pat", "patty", "tricia", "trish"],
  ["jennifer", "jen", "jenny", "jenn"],
  ["barbara", "barb", "babs"],
  ["susan", "sue", "susie", "suzy", "suzanne"],
  ["deborah", "debra", "deb", "debbie"],
  ["sandra", "sandy"],
  ["cynthia", "cindy"],
  ["angela", "angie"],
  ["rebecca", "becky", "becca"],
  ["stephanie", "steph"],
  ["nicole", "nikki", "nicki"],
  ["christina", "christine", "christy", "tina", "christie"],
  ["jacqueline", "jackie", "jacky"],
  ["theresa", "teresa", "terry", "terri", "tess", "tessa"],
  ["frances", "fran", "francie"],
  ["kimberly", "kim", "kimmy"],
  ["sherry", "sheri", "sherri"],
  ["judith", "judy"],
  ["virginia", "ginny", "ginger"],
  ["diane", "diana", "di", "didi"],
  ["carol", "carole", "carrie"],
  ["janet", "jan", "jannie"],
  ["kathleen", "kathy", "kate", "katie"],
  ["michelle", "shelly", "shelley", "shell"],
  ["laura", "lori", "laurie"],
  ["amanda", "mandy"],
  ["melissa", "missy", "mel"],
  ["victoria", "vicky", "vicki", "vickie", "tori"],
  ["samantha", "sam", "sammy"],
  ["jessica", "jess", "jessie"],
  ["gabrielle", "gabby", "gabi"],
  ["isabella", "bella", "izzy"],
  ["olivia", "liv", "livvy"],
  ["natalie", "nat", "natty"],
  ["constance", "connie"],
  ["bonita", "bonnie"],
  ["dorothy", "dot", "dottie"],
  ["lillian", "lily", "lil"],
  ["rosalind", "roz", "rosie"],
  ["penelope", "penny"],
  ["josephine", "jo", "josie"],
  ["geraldine", "gerry", "jerry"],
  ["wilhelmina", "billie", "mina"],
];

const NICKNAME_LOOKUP: Map<string, number> = (() => {
  const map = new Map<string, number>();
  NICKNAME_CLUSTERS.forEach((cluster, idx) => {
    for (const name of cluster) map.set(name, idx);
  });
  return map;
})();

function normalizeNameToken(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z]/g, "");
}

// True if two first names are plausibly the same person - exactly, or via a
// known nickname/formal-name pair above. Blank on either side never counts
// as a match - there's nothing real to compare.
function firstNamesEquivalent(a: string, b: string): boolean {
  const na = normalizeNameToken(a);
  const nb = normalizeNameToken(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ca = NICKNAME_LOOKUP.get(na);
  const cb = NICKNAME_LOOKUP.get(nb);
  return ca !== undefined && ca === cb;
}

function sameLastName(a: string, b: string): boolean {
  const na = normalizeNameToken(a);
  const nb = normalizeNameToken(b);
  return !!na && !!nb && na === nb;
}

// Same last-10-digits normalization process-upload's own phoneKey() uses
// (see the recovered source) - comparing raw phone strings directly misses
// matches over formatting differences alone ("(859) 948-5464" vs
// "8599485464").
function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10);
}

// One row of a DataZapp return file, exactly as DataZapp's own export names
// its columns (confirmed against two real sample files Mike sent 2026-10-15,
// not guessed). Never user-mapped like the normal Upload tab's files are -
// this is always the same tool's fixed export format, so the frontend reads
// these exact headers directly.
type DatazappRawRow = Record<string, string>;

function dzField(row: DatazappRawRow, header: string): string {
  return (row[header] ?? "").trim();
}

type DatazappMatchTier = "confirmed" | "household" | "mismatch" | "no_data" | "no_contact";

type FullContactRow = SoiContactRow & { address_2: string | null };

type DatazappMatchResult = {
  tier: DatazappMatchTier;
  contactId: string | null;
  originalName: string;
  appendedName: string;
  appliedFields: Partial<Record<"email" | "address" | "address_2" | "city" | "state" | "zip", string>>;
  doNotCall: boolean;
  possibleBusiness: string | null;
};

function formatZip(zip: string, zip4: string): string {
  if (!zip) return "";
  return zip4 ? `${zip}-${zip4}` : zip;
}

// The actual matching logic, run against one row of a parsed DataZapp file
// plus a phone -> existing-contact(s) index already built for this client.
// See the file-header comment above for why phone (not name) is the right
// key back to an existing contact, and why the name comparison that follows
// is purely about whether to TRUST the appended data, not about finding who
// it belongs to.
function matchDatazappRow(row: DatazappRawRow, contactsByPhone: Map<string, FullContactRow[]>): DatazappMatchResult {
  const originalFirst = dzField(row, "First Name");
  const originalLast = dzField(row, "Last Name");
  const rawPhone = dzField(row, "FORMATTED_PHONE_Phone 1") || dzField(row, "Phone 1");
  const phoneKeyVal = normalizePhone(rawPhone);
  const originalName = [originalFirst, originalLast].filter(Boolean).join(" ") || "(no name)";

  const candidates = phoneKeyVal ? (contactsByPhone.get(phoneKeyVal) ?? []) : [];
  let contact: FullContactRow | undefined;
  if (candidates.length === 1) {
    contact = candidates[0];
  } else if (candidates.length > 1) {
    // A shared phone (e.g. a landline on two spouses' separate contact rows)
    // - disambiguate using the original name this exact row was built from,
    // since that's guaranteed to be the contact Mike actually exported.
    contact = candidates.find(
      (c) => sameLastName(c.last_name ?? "", originalLast) && firstNamesEquivalent(c.first_name ?? "", originalFirst),
    );
  }
  if (!contact) {
    return {
      tier: "no_contact",
      contactId: null,
      originalName,
      appendedName: "",
      appliedFields: {},
      doNotCall: false,
      possibleBusiness: null,
    };
  }

  const dzFirst = dzField(row, "DataZapp_First");
  const dzLast = dzField(row, "DataZapp_Last");
  const dzFirst2 = dzField(row, "DataZapp_FIRST2");
  const dzLast2 = dzField(row, "DataZapp_LAST2");
  const dzAddress = dzField(row, "DataZapp_Address");
  const dzAddress2 = dzField(row, "DataZapp_ADDRESS2");
  const dzCity = dzField(row, "DataZapp_City");
  const dzState = dzField(row, "DataZapp_State");
  const dzZip = formatZip(dzField(row, "DataZapp_ZIP"), dzField(row, "DataZapp_ZIP_4"));
  const dzEmail = dzField(row, "DataZapp_EMAIL");
  const doNotCall = dzField(row, "DataZapp_DoNotCall").toUpperCase() === "Y";
  const possibleBusiness = dzField(row, "DataZapp_COMPANY_NAME") || null;

  if (!dzFirst && !dzLast && !dzAddress) {
    return {
      tier: "no_data",
      contactId: contact.id,
      originalName,
      appendedName: "",
      appliedFields: {},
      doNotCall,
      possibleBusiness: null,
    };
  }

  const appendedName = [dzFirst, dzLast].filter(Boolean).join(" ");

  // Primary slot: exact or nickname-equivalent first name, exact last name.
  const primaryConfirmed = sameLastName(dzLast, originalLast) && firstNamesEquivalent(dzFirst, originalFirst);
  // Secondary resident (DataZapp_FIRST2/LAST2) catches the real match when
  // DataZapp's primary slot handed back a spouse/other household member
  // instead - confirmed against Mike's real sample data, see this section's
  // header comment for a concrete example.
  const secondaryConfirmed = sameLastName(dzLast2, originalLast) && firstNamesEquivalent(dzFirst2, originalFirst);

  if (primaryConfirmed || secondaryConfirmed) {
    return {
      tier: "confirmed",
      contactId: contact.id,
      originalName,
      appendedName,
      appliedFields: {
        email: dzEmail,
        address: dzAddress,
        address_2: dzAddress2,
        city: dzCity,
        state: dzState,
        zip: dzZip,
      },
      doNotCall,
      possibleBusiness,
    };
  }

  // Last name agrees (either slot) but no first name matches at all - most
  // plausibly the same household (a spouse or other resident), not a wrong
  // address. Direct mail to that address is still almost certainly good -
  // Mike's actual goal ("mainly direct mail, because we want them to order
  // direct mail from us") doesn't depend on the first name being exact. The
  // appended EMAIL is deliberately withheld in this tier: sending under the
  // wrong identity is a real risk an address isn't.
  const householdMatch = sameLastName(dzLast, originalLast) || sameLastName(dzLast2, originalLast);
  if (householdMatch) {
    return {
      tier: "household",
      contactId: contact.id,
      originalName,
      appendedName,
      appliedFields: { address: dzAddress, address_2: dzAddress2, city: dzCity, state: dzState, zip: dzZip },
      doNotCall,
      possibleBusiness,
    };
  }

  return {
    tier: "mismatch",
    contactId: contact.id,
    originalName,
    appendedName,
    appliedFields: {},
    doNotCall,
    possibleBusiness: null,
  };
}

async function fetchAllContactsForClient(admin: SupabaseClient, clientId: string): Promise<FullContactRow[]> {
  let rows: FullContactRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await admin
      .from("contacts")
      .select(
        "id, first_name, last_name, email, phone, address, address_2, city, state, zip, notes, sources, list_assignment",
      )
      .eq("client_id", clientId)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows = rows.concat((data ?? []) as FullContactRow[]);
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

function buildPhoneIndex(contacts: FullContactRow[]): Map<string, FullContactRow[]> {
  const map = new Map<string, FullContactRow[]>();
  for (const c of contacts) {
    if (!c.phone) continue;
    const key = normalizePhone(c.phone);
    if (!key) continue;
    const list = map.get(key);
    if (list) list.push(c);
    else map.set(key, [c]);
  }
  return map;
}

function emptyTierCounts(): Record<DatazappMatchTier, number> {
  return { confirmed: 0, household: 0, mismatch: 0, no_data: 0, no_contact: 0 };
}

// REDESIGNED 2026-10-15, same day as the first build. Mike tested the
// original version (auto-apply confirmed+household, no review) live and it
// came back "Applied: Updated 0 of 927 contacts" - and even once that's
// fixed, he was clear the auto-apply design itself was wrong: "just because
// the data is appended doesn't mean they're going to keep them... it needs
// to pop up the wizard the same way we did before... take them through the
// same exercise as the first part where they said, okay, who here do you
// want to keep? And then you just start slowly start removing people."
// "The same exercise as the first part" is this exact tab's own "Needs Data
// — select who to research" screen (the datazap_append review step further
// up this file) - a table of rows, a checkbox per row defaulted to checked,
// a Select all/Clear all toggle, search. This redesign mirrors that pattern
// instead of silently writing to contacts on upload.
//
// One row of what the review wizard shows and lets Mike's team check/uncheck
// - only ever built for the confirmed/household tiers, since mismatch/
// no_data/no_contact rows have nothing to apply either way (they still show
// up in `counts` for visibility, just not as reviewable rows). `rowIndex` is
// this row's position in the uploaded file - the stable key the frontend's
// checkboxes use, and what applyDatazappAppend's `includedRowIndexes` refers
// back to, since a DataZapp file can have two rows pointing at the same
// contactId (e.g. a landline shared by spouses, each with their own row).
type DatazappReviewRow = {
  rowIndex: number;
  contactId: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  tier: "confirmed" | "household";
  currentEmail: string | null;
  currentAddress: string | null;
  currentCity: string | null;
  currentState: string | null;
  currentZip: string | null;
  appendedEmail: string | null;
  appendedAddress: string | null;
  appendedAddress2: string | null;
  appendedCity: string | null;
  appendedState: string | null;
  appendedZip: string | null;
  doNotCall: boolean;
  possibleBusiness: string | null;
};

// Read-only dry run: parses + matches a just-uploaded DataZapp return file
// against this client's existing contacts and reports what WOULD happen,
// without writing anything - same "preview before apply" shape as the
// Needs Data/Datazap-selection screen already uses elsewhere in this tab.
export const previewDatazappAppend = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { clientId: string; rows: DatazappRawRow[] }) => data)
  .handler(async ({ data, context }) => {
    const admin = getSoiAdminClient();
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireClientAccess(admin, email, data.clientId);

    const contacts = await fetchAllContactsForClient(admin, data.clientId);
    const phoneIndex = buildPhoneIndex(contacts);
    const contactsById = new Map(contacts.map((c) => [c.id, c]));
    const results = data.rows.map((row) => matchDatazappRow(row, phoneIndex));

    const counts = emptyTierCounts();
    for (const r of results) counts[r.tier]++;

    const reviewRows: DatazappReviewRow[] = [];
    results.forEach((r, rowIndex) => {
      if (r.tier !== "confirmed" && r.tier !== "household") return;
      if (!r.contactId) return;
      const contact = contactsById.get(r.contactId);
      reviewRows.push({
        rowIndex,
        contactId: r.contactId,
        firstName: contact?.first_name ?? null,
        lastName: contact?.last_name ?? null,
        phone: contact?.phone ?? null,
        tier: r.tier,
        currentEmail: contact?.email ?? null,
        currentAddress: contact?.address ?? null,
        currentCity: contact?.city ?? null,
        currentState: contact?.state ?? null,
        currentZip: contact?.zip ?? null,
        appendedEmail: r.appliedFields.email ?? null,
        appendedAddress: r.appliedFields.address ?? null,
        appendedAddress2: r.appliedFields.address_2 ?? null,
        appendedCity: r.appliedFields.city ?? null,
        appendedState: r.appliedFields.state ?? null,
        appendedZip: r.appliedFields.zip ?? null,
        doNotCall: r.doNotCall,
        possibleBusiness: r.possibleBusiness,
      });
    });

    // Mismatch rows have nothing to apply, but a small sample is still
    // useful for spot-checking that the "no name in common at all" calls
    // are actually right - same reasoning as before, just no longer needed
    // for confirmed/household since those are now the full review table.
    const sampleMismatch = results
      .filter((r) => r.tier === "mismatch")
      .slice(0, 25)
      .map((r) => ({ originalName: r.originalName, appendedName: r.appendedName }));

    return {
      total: results.length,
      counts,
      doNotCallCount: results.filter((r) => r.doNotCall).length,
      possibleBusinessCount: results.filter((r) => r.possibleBusiness).length,
      reviewRows,
      sampleMismatch,
    };
  });

// What the review wizard hands back per approved row - the shape the
// downloadable CSV is built from. Deliberately just the plain contact
// fields (no tier/match metadata) since this is meant to be a clean list
// Mike can upload straight into Suite Assist or anywhere else.
type DatazappAppliedRow = {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  address_2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
};

function csvEscape(value: string | null): string {
  const v = value ?? "";
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function buildDatazappCsv(rows: DatazappAppliedRow[]): string {
  const headers = ["First Name", "Last Name", "Email", "Phone", "Address", "Address 2", "City", "State", "Zip"];
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(
      [r.first_name, r.last_name, r.email, r.phone, r.address, r.address_2, r.city, r.state, r.zip]
        .map(csvEscape)
        .join(","),
    );
  }
  return lines.join("\n");
}

// Applies exactly the rows Mike's team kept checked in the review wizard -
// `includedRowIndexes` are positions in `rows` (same indexing
// previewDatazappAppend's `reviewRows[].rowIndex` used), not contact ids,
// since a row he unchecked should change nothing even if another row
// matching the same contact stayed checked. Two things happen for every
// kept confirmed/household row, per Mike: the appended fields merge into
// this client's real contacts (blank-fill only, same as every other merge
// in this app, then re-segmented so anyone who just gained an email/address
// moves out of Incomplete/Nonqualified) AND the row goes into a standalone
// CSV of everything just approved, for Mike to upload wherever else he
// wants (Suite Assist, per his own example) - doing both instead of making
// him choose one destination, since he was genuinely unsure which was
// better and said "whatever is the better UI customer experience is the
// right answer." A row that's confirmed/household but NOT checked, or that
// never made the review table at all (mismatch/no_data/no_contact), is
// left alone either way.
export const applyDatazappAppend = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { clientId: string; rows: DatazappRawRow[]; includedRowIndexes: number[] }) => data)
  .handler(async ({ data, context }) => {
    const admin = getSoiAdminClient();
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireClientAccess(admin, email, data.clientId);

    const contacts = await fetchAllContactsForClient(admin, data.clientId);
    const phoneIndex = buildPhoneIndex(contacts);
    const contactsById = new Map(contacts.map((c) => [c.id, c]));
    const results = data.rows.map((row) => matchDatazappRow(row, phoneIndex));
    const included = new Set(data.includedRowIndexes);

    const counts = emptyTierCounts();
    for (const r of results) counts[r.tier]++;

    const updates: Record<string, unknown>[] = [];
    const appliedRows: DatazappAppliedRow[] = [];

    results.forEach((r, rowIndex) => {
      const canApplyFields = (r.tier === "confirmed" || r.tier === "household") && included.has(rowIndex);
      if (!canApplyFields || !r.contactId) return;
      const contact = contactsById.get(r.contactId);
      if (!contact) return;

      // Blank-fill only - never overwrite a field the contact already has
      // real data in, same philosophy the main multi-list merge already
      // uses everywhere else in this app.
      const fields: Partial<Record<"email" | "address" | "address_2" | "city" | "state" | "zip", string>> = {};
      let fieldsChanged = false;
      (Object.keys(r.appliedFields) as Array<keyof typeof r.appliedFields>).forEach((key) => {
        const incoming = r.appliedFields[key];
        if (incoming && !contact[key]) {
          fields[key] = incoming;
          fieldsChanged = true;
        }
      });

      // DataZapp's Do Not Call flag is about the PHONE NUMBER Mike sent it,
      // not about whose name came back - so it's trustworthy regardless of
      // match tier, same as before.
      const existingNotes = contact.notes ?? "";
      const noteAdditions: string[] = [];
      if (r.doNotCall && !existingNotes.includes("[DataZapp: Do Not Call]")) {
        noteAdditions.push("[DataZapp: Do Not Call]");
      }
      if (r.possibleBusiness && !existingNotes.includes("[DataZapp: possible business")) {
        noteAdditions.push(`[DataZapp: possible business — ${r.possibleBusiness}]`);
      }

      const finalRow = {
        id: contact.id,
        // Full existing row, same reason process-upload's own upsert
        // comment gives for doing this - a partial row through upsert risks
        // blanking columns this request doesn't mention.
        first_name: contact.first_name,
        last_name: contact.last_name,
        email: fields.email ?? contact.email,
        phone: contact.phone,
        address: fields.address ?? contact.address,
        address_2: fields.address_2 ?? contact.address_2,
        city: fields.city ?? contact.city,
        state: fields.state ?? contact.state,
        zip: fields.zip ?? contact.zip,
        notes: noteAdditions.length ? [existingNotes, ...noteAdditions].filter(Boolean).join(" ") : contact.notes,
        list_assignment: contact.list_assignment,
        sources: contact.sources,
      };

      // Goes in the download list regardless of whether the merge below
      // actually changed anything - Mike's team reviewed and kept this row,
      // so it belongs in the list they take away, even if blank-fill found
      // nothing new to write (e.g. the contact already had this field from
      // an earlier round).
      appliedRows.push({
        first_name: finalRow.first_name,
        last_name: finalRow.last_name,
        email: finalRow.email,
        phone: finalRow.phone,
        address: finalRow.address,
        address_2: finalRow.address_2,
        city: finalRow.city,
        state: finalRow.state,
        zip: finalRow.zip,
      });

      if (!fieldsChanged && noteAdditions.length === 0) return;
      updates.push(finalRow);
    });

    for (let i = 0; i < updates.length; i += 500) {
      const { error } = await admin.from("contacts").upsert(updates.slice(i, i + 500), { onConflict: "id" });
      if (error) throw error;
    }

    // Reclassify everyone using the real segmentation rules, not a
    // reimplementation of them - only worth calling at all if something
    // actually changed.
    const report = updates.length > 0 ? await runProcessUpload(data.clientId) : null;

    return {
      total: results.length,
      appliedCount: updates.length,
      keptCount: appliedRows.length,
      counts,
      report,
      csv: appliedRows.length > 0 ? buildDatazappCsv(appliedRows) : null,
    };
  });
