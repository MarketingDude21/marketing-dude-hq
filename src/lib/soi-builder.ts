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

// Bug fix, 2026-10-15: Mike reported "I went away from the Append Data
// screen and when I came back all data was not saved. I only switched
// windows." That's because the whole feature lived in plain React state -
// switching tabs unmounted the component and threw away the uploaded file
// and its computed matches. Fixed by staging the parsed rows (not the raw
// file - already-parsed JSON round-trips exactly, no re-parsing/CSV-quoting
// edge cases to worry about) in the SAME Storage bucket everything else in
// this file uses, at a fixed per-client path that just gets overwritten on
// every new upload - one file, not a growing history.
//
// Deliberately NOT a row in the `uploads` table: that table is also used to
// tell the real process-upload Edge Function what to process, and a
// DataZapp return file is a completely different shape (its own DataZapp_*
// columns, no mapping) that function has never seen and was never built to
// handle - adding a tracked `uploads` row here risked it getting silently
// swept into a future "Process" run. Storage-only, bypassing that table
// entirely, is the same kind of deliberate bypass as deleteSoiUpload/
// resetSoiDatabase above (talk directly to the backend when the existing
// Edge Function's shape doesn't fit), just via Storage instead of a table.
//
// Known limitation, stated plainly rather than silently: only the uploaded
// file + its computed match tiers are restored. Per-row checkbox changes
// mid-review are NOT persisted - reopening the tab resets to the same
// opt-out default (every confirmed/household row checked) the first upload
// always starts with. Round-tripping every checkbox too would mean writing
// on every single click, which is a lot of chatter for a value that's
// already cheap to recompute from the file.
function appendDataStagingPath(clientId: string): string {
  return `append-data-staging/${clientId}.json`;
}

export const saveAppendDataStaging = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { clientId: string; fileName: string; rows: DatazappRawRow[] }) => data)
  .handler(async ({ data, context }) => {
    const admin = getSoiAdminClient();
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireClientAccess(admin, email, data.clientId);

    const payload = JSON.stringify({ fileName: data.fileName, rows: data.rows });
    const { error } = await admin.storage.from("uploads").upload(appendDataStagingPath(data.clientId), payload, {
      contentType: "application/json",
      upsert: true,
    });
    if (error) throw error;
    return { ok: true };
  });

export const getAppendDataStaging = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { clientId: string }) => data)
  .handler(async ({ data, context }): Promise<{ fileName: string; rows: DatazappRawRow[] } | null> => {
    const admin = getSoiAdminClient();
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireClientAccess(admin, email, data.clientId);

    const { data: file, error } = await admin.storage.from("uploads").download(appendDataStagingPath(data.clientId));
    if (error) {
      // Nothing staged yet is the normal, expected case (first time opening
      // this tab, or right after "Upload another file") - not an error.
      return null;
    }
    try {
      const text = await file.text();
      return JSON.parse(text) as { fileName: string; rows: DatazappRawRow[] };
    } catch {
      return null;
    }
  });

export const clearAppendDataStaging = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { clientId: string }) => data)
  .handler(async ({ data, context }) => {
    const admin = getSoiAdminClient();
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireClientAccess(admin, email, data.clientId);

    await admin.storage.from("uploads").remove([appendDataStagingPath(data.clientId)]);
    return { ok: true };
  });

// Full "start over" for a client, added 2026-10-15 per Mike: "There should
// be a reset button on the Upload screen anytime you want to rerun a new
// database. People may come back and add contacts to it or clean their
// list." Wipes every uploaded file AND every contact this client has, so
// the next upload starts completely clean rather than deduping/merging
// against leftover data from a previous round. Irreversible, on purpose -
// the frontend gates this behind a type-the-client's-name confirmation
// before ever calling it.
export const resetSoiDatabase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { clientId: string }) => data)
  .handler(async ({ data, context }) => {
    const admin = getSoiAdminClient();
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireClientAccess(admin, email, data.clientId);

    // 1. Remove every uploaded file's Storage object(s) + row - same cleanup
    // deleteSoiUpload above already does one file at a time.
    const { data: uploads, error: uploadsErr } = await admin
      .from("uploads")
      .select("id, storage_path")
      .eq("client_id", data.clientId);
    if (uploadsErr) throw uploadsErr;
    for (const u of uploads ?? []) {
      await admin.storage.from("uploads").remove([u.storage_path, `${u.storage_path}.mapped.json`]);
    }
    const { error: deleteUploadsErr } = await admin.from("uploads").delete().eq("client_id", data.clientId);
    if (deleteUploadsErr) throw deleteUploadsErr;

    // 1b. Also clear any staged Append Data file (see saveAppendDataStaging
    // below) - it lives outside the `uploads` table entirely (on purpose, so
    // it never gets picked up by process-upload), so it wouldn't be touched
    // by the loop above at all. Best-effort: a missing object here is not an
    // error, there's just nothing staged.
    await admin.storage.from("uploads").remove([appendDataStagingPath(data.clientId)]);

    // 2. Delete every review flag tied to this client's contacts FIRST -
    // review_flags has no client_id column of its own (it's keyed off
    // contact_id, same note as setSoiReviewFlag below), so this isn't
    // something to leave to an assumed cascade on the contacts delete next.
    let contactIds: string[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data: rows, error } = await admin
        .from("contacts")
        .select("id")
        .eq("client_id", data.clientId)
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      contactIds = contactIds.concat((rows ?? []).map((r) => r.id as string));
      if (!rows || rows.length < PAGE_SIZE) break;
    }
    for (let i = 0; i < contactIds.length; i += 500) {
      const { error } = await admin
        .from("review_flags")
        .delete()
        .in("contact_id", contactIds.slice(i, i + 500));
      if (error) throw error;
    }

    // 3. Delete every contact for this client - the actual reset. One
    // request regardless of row count; Postgrest matches server-side.
    const { error: deleteContactsErr } = await admin.from("contacts").delete().eq("client_id", data.clientId);
    if (deleteContactsErr) throw deleteContactsErr;

    return { deletedContacts: contactIds.length, deletedUploads: (uploads ?? []).length };
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
  // Added 2026-10-15 alongside the new local export path below - the real
  // `contacts` table has had this column the whole time (confirmed in the
  // exact header of a CSV Mike sent: "first_name,last_name,address,
  // address_2,city,state,zip,email,phone,notes,sources"), it just wasn't
  // being selected by either fetch helper below, so every export built from
  // them was silently dropping it.
  address_2: string | null;
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
      .select(
        "id, first_name, last_name, email, phone, address, address_2, city, state, zip, notes, sources, list_assignment",
      )
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

// Same as fetchContactsForList, but with no list_assignment filter at all -
// every contact this client has, regardless of bucket. Used only by the new
// append-data write path below, to find an existing contact to blank-fill-
// merge into by phone number without having to guess which bucket they're
// currently sitting in.
async function fetchAllContactsForClient(admin: SupabaseClient, clientId: string): Promise<SoiContactRow[]> {
  let rows: SoiContactRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await admin
      .from("contacts")
      .select(
        "id, first_name, last_name, email, phone, address, address_2, city, state, zip, notes, sources, list_assignment",
      )
      .eq("client_id", clientId)
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
        "id, first_name, last_name, email, phone, address, address_2, city, state, zip, notes, sources, list_assignment, review_flags(flagged)",
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
    return allContacts.filter((c) => isPrimaryReviewSurvivor(c) && hasAllEightContactFields(c));
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
// REDESIGNED TWICE the same day this first went out, both times from real
// usage, not guessing again:
//   1. First redesign: the very first version auto-applied confirmed/
//      household matches straight into the client's existing `contacts`
//      (looked up by phone) with no review step. Mike tested it live and got
//      "Applied: Updated 0 of 927 contacts," and separately said the
//      no-review design was wrong regardless: "just because the data is
//      appended doesn't mean they're going to keep them."
//   2. Second redesign (this one): Mike then said the whole premise of
//      looking anything up in `contacts` was wrong - "The append data should
//      have nothing to do with the prior contacts... I'm uploading an
//      appended list that's still showing me zero results because I don't
//      have that data from the original upload, so it doesn't make sense."
//      His own words for the actual process: upload the DataZapp file, see
//      every match and mismatch, clean it up, decide who to keep - and the
//      result is its own standalone list, same kind of thing as "Final Full
//      Contact," not written into any contact record. That's what finally
//      explains the "0 of 927" - the old version needed a phone match
//      against stored contacts to find anything at all, and this client's
//      didn't produce one, which should never have been able to block
//      anything in the first place.
//
// What this means structurally: this whole feature no longer reads or
// writes the `contacts` table at all. A DataZapp return file already
// carries its own original First Name/Last Name/Phone/Email columns
// (that's exactly what Mike sent DataZapp to begin with) right alongside
// DataZapp's appended DataZapp_* columns - so confirming a match is purely a
// same-row comparison inside the uploaded file itself, nothing to look up
// anywhere. The nickname-cluster matching logic below is UNCHANGED from the
// very first version and still verified against the same real 927-row file;
// only what the tiers get used for changed - straight into a downloadable
// list, never into any contact record.
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

// One row of a DataZapp return file, exactly as DataZapp's own export names
// its columns (confirmed against two real sample files Mike sent 2026-10-15,
// not guessed). Never user-mapped like the normal Upload tab's files are -
// this is always the same tool's fixed export format, so the frontend reads
// these exact headers directly. Critically, this file already carries the
// ORIGINAL First Name/Last Name/Phone/Email columns Mike sent DataZapp,
// right alongside DataZapp's own appended DataZapp_* columns - so every
// comparison below is a same-row, same-file comparison, nothing looked up
// anywhere else.
type DatazappRawRow = Record<string, string>;

function dzField(row: DatazappRawRow, header: string): string {
  return (row[header] ?? "").trim();
}

type DatazappMatchTier = "confirmed" | "household" | "mismatch" | "no_data";

type DatazappMatchResult = {
  tier: DatazappMatchTier;
  firstName: string;
  lastName: string;
  phone: string;
  originalEmail: string;
  // The raw email DataZapp appended, regardless of tier - added 2026-10-15
  // for Stage 2 ("Email List") below, which trusts it even on a mismatch/
  // no_data row, unlike `finalFields.email` (still tier-gated, used only by
  // Stage 1/"Appended Full Data", which stays exactly as cautious as before
  // about not attaching a mismatched identity's email to a direct mail
  // record). Mike, on Stage 2 specifically: "The people who direct mail does
  // not match does NOT mean we throw away their email because they will
  // just go on email list" - a mismatch row not being trustworthy enough for
  // a mailing address doesn't mean its appended email is worthless too.
  dzEmail: string;
  appendedName: string;
  finalFields: { email: string; address: string; address_2: string; city: string; state: string; zip: string };
  doNotCall: boolean;
  possibleBusiness: string | null;
};

function formatZip(zip: string, zip4: string): string {
  if (!zip) return "";
  return zip4 ? `${zip}-${zip4}` : zip;
}

// The actual matching logic - purely a within-the-row comparison between
// the original name DataZapp was given (First Name/Last Name, right there
// in the file) and the name DataZapp handed back (DataZapp_First/Last, or
// the secondary DataZapp_FIRST2/LAST2 resident slot). Nothing here reads or
// writes any contact record - see this section's header comment for why
// that's the point of this redesign, not an oversight.
function matchDatazappRow(row: DatazappRawRow): DatazappMatchResult {
  const firstName = dzField(row, "First Name");
  const lastName = dzField(row, "Last Name");
  const phone = dzField(row, "FORMATTED_PHONE_Phone 1") || dzField(row, "Phone 1");
  const originalEmail = dzField(row, "Email 1");

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

  const emptyFields = { email: "", address: "", address_2: "", city: "", state: "", zip: "" };

  if (!dzFirst && !dzLast && !dzAddress) {
    return {
      tier: "no_data",
      firstName,
      lastName,
      phone,
      originalEmail,
      dzEmail,
      appendedName: "",
      finalFields: emptyFields,
      doNotCall,
      possibleBusiness: null,
    };
  }

  const appendedName = [dzFirst, dzLast].filter(Boolean).join(" ");

  // Primary slot: exact or nickname-equivalent first name, exact last name.
  const primaryConfirmed = sameLastName(dzLast, lastName) && firstNamesEquivalent(dzFirst, firstName);
  // Secondary resident (DataZapp_FIRST2/LAST2) catches the real match when
  // DataZapp's primary slot handed back a spouse/other household member
  // instead - confirmed against Mike's real sample data, see this section's
  // header comment for a concrete example.
  const secondaryConfirmed = sameLastName(dzLast2, lastName) && firstNamesEquivalent(dzFirst2, firstName);

  if (primaryConfirmed || secondaryConfirmed) {
    return {
      tier: "confirmed",
      firstName,
      lastName,
      phone,
      originalEmail,
      dzEmail,
      appendedName,
      // Keep whatever original email this row already had (it may have one
      // if it was only missing an address) - only fall back to DataZapp's
      // appended email when there wasn't one.
      finalFields: {
        email: originalEmail || dzEmail,
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
  const householdMatch = sameLastName(dzLast, lastName) || sameLastName(dzLast2, lastName);
  if (householdMatch) {
    return {
      tier: "household",
      firstName,
      lastName,
      phone,
      originalEmail,
      dzEmail,
      appendedName,
      finalFields: {
        email: originalEmail,
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

  return {
    tier: "mismatch",
    firstName,
    lastName,
    phone,
    originalEmail,
    dzEmail,
    appendedName,
    finalFields: emptyFields,
    doNotCall,
    possibleBusiness: null,
  };
}

function emptyTierCounts(): Record<DatazappMatchTier, number> {
  return { confirmed: 0, household: 0, mismatch: 0, no_data: 0 };
}

// REDESIGNED TWICE the same day this first went out - see this section's
// header comment for the full story. This second pass is the one Mike
// actually asked for: "The append data should have nothing to do with the
// prior contacts... I'm uploading an appended list that's still showing me
// zero results because I don't have that data from the original upload, so
// it doesn't make sense." His description of the process, in his own words:
// "you upload the appended data file. It's going to give you all the
// matches. It's going to give you all the mismatches, and then it's going
// to clean that list up so that we could only take the correct data at the
// end of the day, and it's going to ask us who we're keeping." That's
// exactly what previewDatazappAppend/finalizeDatazappAppend below do - the
// review table UI itself (checkbox per row, defaulted checked, Select
// all/Clear all, search) is unchanged from the first redesign, since Mike
// confirmed that part was right; what's gone is any read or write against
// the `contacts` table.
//
// One row of what the review wizard shows and lets Mike's team check/uncheck
// - only ever built for the confirmed/household tiers, since mismatch/
// no_data rows have nothing worth keeping either way (they still show up in
// `counts` for visibility, just not as reviewable rows). `rowIndex` is this
// row's position in the uploaded file - the stable key the frontend's
// checkboxes use, and what finalizeDatazappAppend's `includedRowIndexes`
// refers back to.
type DatazappReviewRow = {
  rowIndex: number;
  firstName: string;
  lastName: string;
  phone: string;
  tier: "confirmed" | "household";
  originalEmail: string;
  finalEmail: string;
  finalAddress: string;
  finalAddress2: string;
  finalCity: string;
  finalState: string;
  finalZip: string;
  doNotCall: boolean;
  possibleBusiness: string | null;
};

// Shared by getSoiListView's final_full_contact branch AND the new
// exportSoiListLocal below - hoisted to module scope on 2026-10-15 so there
// is only ever ONE copy of this business rule. There used to be a second,
// independent copy of this exact logic inside the remote export-lists Edge
// Function, and the two quietly drifted apart: this local copy already fixed
// the URL-length-limit bug (see fetchContactsWithFlags's header comment
// above), but the remote copy never got that fix, so for a big-enough client
// "Final: Full Contact (ready to use)" showed a correct nonzero count on
// screen (from this local copy) while its CSV download came back completely
// empty (from the still-broken remote copy) - confirmed directly against a
// real file Mike sent (full_contact_ready_to_use_8.csv: header row only, zero
// data rows) for a client whose Review tab showed "Complete Data 391/470".
// Hoisting this out and having BOTH the on-screen count and the download use
// the same function removes the drift entirely rather than just patching one
// side of it.
function isPrimaryReviewSurvivor(c: SoiContactRow & { flagged: boolean }): boolean {
  if (c.list_assignment === "direct_mail" || c.list_assignment === "email_phone") return !c.flagged;
  if (c.list_assignment === "email_list" || c.list_assignment === "incomplete") return c.flagged;
  return false;
}
function hasAllEightContactFields(c: SoiContactRow): boolean {
  return !!(c.first_name && c.last_name && c.email && c.phone && c.address && c.city && c.state && c.zip);
}

// Read-only dry run: parses + matches a just-uploaded DataZapp return file
// purely against itself (see the matching-logic comment above) and reports
// what's reviewable, without touching any contact record.
export const previewDatazappAppend = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { clientId: string; rows: DatazappRawRow[] }) => data)
  .handler(async ({ data, context }) => {
    const admin = getSoiAdminClient();
    const email = (context.claims as { email?: string } | undefined)?.email;
    // Still gated behind normal client access, same as every other
    // SOI-builder function - just no longer reads anything from `contacts`.
    await requireClientAccess(admin, email, data.clientId);

    const results = data.rows.map((row) => matchDatazappRow(row));

    const counts = emptyTierCounts();
    for (const r of results) counts[r.tier]++;

    const reviewRows: DatazappReviewRow[] = [];
    results.forEach((r, rowIndex) => {
      if (r.tier !== "confirmed" && r.tier !== "household") return;
      reviewRows.push({
        rowIndex,
        firstName: r.firstName,
        lastName: r.lastName,
        phone: r.phone,
        tier: r.tier,
        originalEmail: r.originalEmail,
        finalEmail: r.finalFields.email,
        finalAddress: r.finalFields.address,
        finalAddress2: r.finalFields.address_2,
        finalCity: r.finalFields.city,
        finalState: r.finalFields.state,
        finalZip: r.finalFields.zip,
        doNotCall: r.doNotCall,
        possibleBusiness: r.possibleBusiness,
      });
    });

    // Mismatch rows have nothing to keep, but a small sample is still
    // useful for spot-checking that the "no name in common at all" calls
    // are actually right.
    const sampleMismatch = results
      .filter((r) => r.tier === "mismatch")
      .slice(0, 25)
      .map((r) => ({
        originalName: [r.firstName, r.lastName].filter(Boolean).join(" ") || "(no name)",
        appendedName: r.appendedName,
      }));

    return {
      total: results.length,
      counts,
      doNotCallCount: results.filter((r) => r.doNotCall).length,
      possibleBusinessCount: results.filter((r) => r.possibleBusiness).length,
      reviewRows,
      sampleMismatch,
    };
  });

// What the review wizard hands back per kept row - the shape the
// downloadable CSV is built from. Plain contact-style fields, no tier/match
// metadata, since this is meant to be a clean list Mike can upload straight
// into Suite Assist or anywhere else - its own standalone list, same kind
// of thing as "Final Full Contact," not written into any contact record.
type DatazappKeptRow = {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  address: string;
  address_2: string;
  city: string;
  state: string;
  zip: string;
};

function csvEscape(value: string | null): string {
  const v = value ?? "";
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function buildDatazappCsv(rows: DatazappKeptRow[]): string {
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

// List assignments this append-data write path is allowed to promote a
// contact INTO. The reverse - protecting someone already in one of these
// three from being reassigned OUT by a later append-data run - is what
// PROTECTED_LIST_ASSIGNMENTS below is for.
const PROTECTED_LIST_ASSIGNMENTS = new Set(["direct_mail", "email_phone", "email_list"]);

const CONTACT_MERGE_FIELDS = [
  "first_name",
  "last_name",
  "email",
  "phone",
  "address",
  "address_2",
  "city",
  "state",
  "zip",
] as const;

type AppendWriteFields = {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  address: string;
  address_2: string;
  city: string;
  state: string;
  zip: string;
};

// Writes finalized append-data rows into `contacts` under a new
// list_assignment bucket ("appended_full_data" or "appended_email") - added
// 2026-10-15 per Mike's request to treat these as real exportable buckets
// ("Appended Full Data, and Appended Email" as entries in the new Export tab
// Marketable section, combinable into one final database). This REVERSES
// the "no database write of any kind" decision documented above
// finalizeDatazappAppend's original version - that decision was about the
// MATCHING step never depending on `contacts` (still true, unchanged,
// matchDatazappRow still never reads a contact record), not about where the
// kept results end up once Mike's team has decided who to keep.
//
// Matches by phone only, and only at this write step (never during preview/
// matching) - looks up every one of this client's contacts once up front
// rather than one query per row. Blank-fill-only merge, same philosophy as
// process-upload's own real logic: never overwrites a field that already
// has real data. list_assignment is the one exception - it DOES get
// reassigned on a match, because being found here means DataZapp appended
// something for a person who was missing data, which is the whole point of
// promoting them into this bucket - UNLESS they're already sitting in
// direct_mail/email_phone/email_list, the three buckets the real pipeline
// already considers fully qualified; this never downgrades someone out of
// those on the (unlikely, since Mike only sends DataZapp people missing
// data in the first place) chance they show up in an append file too.
async function upsertAppendedContacts(
  admin: SupabaseClient,
  clientId: string,
  rows: AppendWriteFields[],
  listAssignment: string,
): Promise<{ updated: number; inserted: number }> {
  const existing = await fetchAllContactsForClient(admin, clientId);
  const byPhone = new Map<string, SoiContactRow>();
  for (const c of existing) {
    if (c.phone) byPhone.set(c.phone, c);
  }

  const updates: Promise<unknown>[] = [];
  const toInsert: Record<string, unknown>[] = [];

  for (const row of rows) {
    const match = row.phone ? byPhone.get(row.phone) : undefined;
    if (!match) {
      toInsert.push({ client_id: clientId, list_assignment: listAssignment, ...row });
      continue;
    }
    const merged: Record<string, unknown> = {};
    for (const field of CONTACT_MERGE_FIELDS) {
      if (!match[field] && row[field]) merged[field] = row[field];
    }
    if (!PROTECTED_LIST_ASSIGNMENTS.has(match.list_assignment ?? "")) {
      merged["list_assignment"] = listAssignment;
    }
    if (Object.keys(merged).length > 0) {
      updates.push(
        Promise.resolve(admin.from("contacts").update(merged).eq("id", match.id)).then(({ error }) => {
          if (error) throw error;
        }),
      );
    }
  }

  // Bounded concurrency rather than one giant Promise.all - hundreds of
  // individual updates (each a different row, different merged fields, so
  // they can't be collapsed into one batch statement) fired all at once is
  // more connections than this is worth risking.
  for (let i = 0; i < updates.length; i += 25) {
    await Promise.all(updates.slice(i, i + 25));
  }
  for (let i = 0; i < toInsert.length; i += 500) {
    const { error } = await admin.from("contacts").insert(toInsert.slice(i, i + 500));
    if (error) throw error;
  }

  return { updated: updates.length, inserted: toInsert.length };
}

// Finalizes exactly the rows Mike's team kept checked in the review wizard -
// `includedRowIndexes` are positions in `rows` (same indexing
// previewDatazappAppend's `reviewRows[].rowIndex` used). Re-runs the same
// matching logic (deterministic from the file alone, nothing external to
// drift), builds the same standalone downloadable CSV as before (still
// useful - Mike's own words, "ready to upload wherever you need it, Suite
// Assist or anywhere else"), and ALSO writes the kept rows into `contacts`
// as list_assignment "appended_full_data" (see upsertAppendedContacts above
// for why this is no longer a no-DB-write operation).
export const finalizeDatazappAppend = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { clientId: string; rows: DatazappRawRow[]; includedRowIndexes: number[] }) => data)
  .handler(async ({ data, context }) => {
    const admin = getSoiAdminClient();
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireClientAccess(admin, email, data.clientId);

    const results = data.rows.map((row) => matchDatazappRow(row));
    const included = new Set(data.includedRowIndexes);

    const counts = emptyTierCounts();
    for (const r of results) counts[r.tier]++;

    const keptRows: DatazappKeptRow[] = [];
    results.forEach((r, rowIndex) => {
      const canKeep = (r.tier === "confirmed" || r.tier === "household") && included.has(rowIndex);
      if (!canKeep) return;
      keptRows.push({
        first_name: r.firstName,
        last_name: r.lastName,
        email: r.finalFields.email,
        phone: r.phone,
        address: r.finalFields.address,
        address_2: r.finalFields.address_2,
        city: r.finalFields.city,
        state: r.finalFields.state,
        zip: r.finalFields.zip,
      });
    });

    const written = await upsertAppendedContacts(admin, data.clientId, keptRows, "appended_full_data");

    return {
      total: results.length,
      keptCount: keptRows.length,
      counts,
      csv: keptRows.length > 0 ? buildDatazappCsv(keptRows) : null,
      written,
    };
  });

// Stage 2 - "Email List" pass over whatever Stage 1 (above) didn't keep,
// added 2026-10-15 per Mike: "We should have a secondary screen where it has
// the remaining contacts to clean up next because we can still create an
// email list out of it... if there was an email appended it should be added
// in and we want to create a final list of people that have first name last
// name and email as bare fields."
//
// REVISED the same day, from Mike testing this live and getting a blank
// email list: the first version only ever offered each row's OWN original
// email, never DataZapp's appended one, for any row outside the
// confirmed/household tiers - trying to avoid attaching a mismatched
// identity's email to someone. Mike corrected that directly: "The people
// who direct tmail do not match DOES not mean we throw away their email
// because they will just go on email list... Just want to make sure that
// even if their direct amil did not match we dont remove them if they have
// an email and or phone here. We want them still included." So "usable
// email" here is now `originalEmail || dzEmail` for EVERY row not kept in
// Stage 1, regardless of tier - a mismatch/no_data row not being trustworthy
// enough for a mailing address doesn't mean its appended email is worthless
// too, same reasoning Mike already applied to the household tier's mailing
// address in Stage 1.
type DatazappEmailReviewRow = {
  rowIndex: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  originalTier: DatazappMatchTier;
};

function bestStage2Email(r: DatazappMatchResult): string {
  return r.originalEmail || r.dzEmail;
}

export const previewDatazappEmailList = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { clientId: string; rows: DatazappRawRow[]; keptRowIndexes: number[] }) => data)
  .handler(async ({ data, context }) => {
    const admin = getSoiAdminClient();
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireClientAccess(admin, email, data.clientId);

    const results = data.rows.map((row) => matchDatazappRow(row));
    const kept = new Set(data.keptRowIndexes);

    // Visibility into what happens to everyone NOT on the email list below,
    // broken down by their Stage 1 tier - added per Mike: "What happens to
    // the bottom 2 rows of 275 and 287 people... I'd like to be able to see
    // the data on those." `remainingByTier` counts everyone not kept in
    // Stage 1, by tier; `noEmailByTier` is the subset of each that still had
    // no usable email at all (truly nothing to work with, not just withheld
    // out of caution).
    const remainingByTier = emptyTierCounts();
    const noEmailByTier = emptyTierCounts();

    const reviewRows: DatazappEmailReviewRow[] = [];
    results.forEach((r, rowIndex) => {
      if (kept.has(rowIndex)) return; // already on the Stage 1 "Appended Full Data" list
      remainingByTier[r.tier]++;
      const usableEmail = bestStage2Email(r);
      if (!usableEmail) {
        noEmailByTier[r.tier]++;
        return;
      }
      reviewRows.push({
        rowIndex,
        firstName: r.firstName,
        lastName: r.lastName,
        email: usableEmail,
        phone: r.phone,
        originalTier: r.tier,
      });
    });

    return { total: reviewRows.length, reviewRows, remainingByTier, noEmailByTier };
  });

function buildDatazappEmailCsv(rows: { first_name: string; last_name: string; email: string }[]): string {
  const headers = ["First Name", "Last Name", "Email"];
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push([r.first_name, r.last_name, r.email].map(csvEscape).join(","));
  }
  return lines.join("\n");
}

export const finalizeDatazappEmailList = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { clientId: string; rows: DatazappRawRow[]; includedRowIndexes: number[] }) => data)
  .handler(async ({ data, context }) => {
    const admin = getSoiAdminClient();
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireClientAccess(admin, email, data.clientId);

    const results = data.rows.map((row) => matchDatazappRow(row));
    const included = new Set(data.includedRowIndexes);

    const keptRows: { first_name: string; last_name: string; email: string; phone: string }[] = [];
    results.forEach((r, rowIndex) => {
      const usableEmail = bestStage2Email(r);
      if (!included.has(rowIndex) || !usableEmail) return;
      keptRows.push({ first_name: r.firstName, last_name: r.lastName, email: usableEmail, phone: r.phone });
    });

    const written = await upsertAppendedContacts(
      admin,
      data.clientId,
      keptRows.map((r) => ({
        first_name: r.first_name,
        last_name: r.last_name,
        email: r.email,
        phone: r.phone,
        address: "",
        address_2: "",
        city: "",
        state: "",
        zip: "",
      })),
      "appended_email",
    );

    return {
      keptCount: keptRows.length,
      csv: keptRows.length > 0 ? buildDatazappEmailCsv(keptRows) : null,
      written,
    };
  });

// ============================================================================
// Export tab reorganization, 2026-10-15 - Mike's request: split the flat
// button list into "Marketable" (Full Direct Mail + Email/Phone, Email
// List, the two new Appended buckets above) and "Non-Marketable" (Incomplete,
// Nonqualified, Realtor Excluded, Business Excluded), plus a "combine all
// into one final database" button that dedupes across every Marketable
// bucket. The two new Appended scopes don't exist in the remote export-lists
// Edge Function at all (it predates this feature), and "final_full_contact"
// has the known URL-length-limit bug documented above
// isPrimaryReviewSurvivor - so this is a local export path covering exactly
// those scopes, reusing the exact same fetch helpers and (for
// final_full_contact) the exact same hoisted survivor/complete-record rules
// as getSoiListView's on-screen count, so the download can never disagree
// with what the screen shows again. Every OTHER scope on the Export tab
// (complete, email_list, incomplete, nonqualified, facebook_audience,
// realtor_excluded, business_excluded) is untouched - still the original
// exportSoiList calling the real remote Edge Function, since Mike never
// reported those broken and there's no reason to touch what works.
// ============================================================================

function buildContactsCsvV2(rows: SoiContactRow[]): string {
  const headers = [
    "first_name",
    "last_name",
    "address",
    "address_2",
    "city",
    "state",
    "zip",
    "email",
    "phone",
    "notes",
    "sources",
  ];
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.first_name,
        r.last_name,
        r.address,
        r.address_2,
        r.city,
        r.state,
        r.zip,
        r.email,
        r.phone,
        r.notes,
        (r.sources ?? []).join("; "),
      ]
        .map((v) => csvEscape(v))
        .join(","),
    );
  }
  return lines.join("\n");
}

// Dedupes across the combined Marketable buckets for the new "combine all
// into one final database" button - mirrors process-upload's own stated
// matching priority (email, then phone, then name) as closely as a from-
// scratch reimplementation reasonably can without access to that function's
// source: this is Claude's own implementation of that priority, not a call
// into the real pipeline's dedupe, worth stating plainly rather than
// implying it's byte-identical. Same blank-fill-only merge philosophy as
// everywhere else in this file - the surviving row only ever gains fields
// it was missing, never loses or overwrites a real value it already had.
function dedupeContactRows(rows: SoiContactRow[]): SoiContactRow[] {
  const out: SoiContactRow[] = [];
  const byEmail = new Map<string, number>();
  const byPhone = new Map<string, number>();

  for (const row of rows) {
    const emailKey = (row.email ?? "").toLowerCase().trim();
    const phoneKey = (row.phone ?? "").replace(/\D/g, "");

    let existingIdx: number | undefined;
    if (emailKey && byEmail.has(emailKey)) existingIdx = byEmail.get(emailKey);
    else if (phoneKey && byPhone.has(phoneKey)) existingIdx = byPhone.get(phoneKey);

    if (existingIdx === undefined) {
      out.push({ ...row });
      const idx = out.length - 1;
      if (emailKey) byEmail.set(emailKey, idx);
      if (phoneKey) byPhone.set(phoneKey, idx);
      continue;
    }

    const survivor = out[existingIdx];
    if (!survivor) continue; // existingIdx always came from out.length - 1 above - unreachable in practice
    for (const field of CONTACT_MERGE_FIELDS) {
      if (!survivor[field] && row[field]) survivor[field] = row[field];
    }
    if (row.notes && !survivor.notes) survivor.notes = row.notes;
    survivor.sources = Array.from(new Set([...(survivor.sources ?? []), ...(row.sources ?? [])]));
    if (emailKey) byEmail.set(emailKey, existingIdx);
    if (phoneKey) byPhone.set(phoneKey, existingIdx);
  }

  return out;
}

export const exportSoiListLocal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      clientId: string;
      scope: "final_full_contact" | "appended_full_data" | "appended_email" | "combine_marketable";
    }) => data,
  )
  .handler(async ({ data, context }) => {
    const admin = getSoiAdminClient();
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireClientAccess(admin, email, data.clientId);

    const stamp = new Date().toISOString().slice(0, 10);

    if (data.scope === "appended_full_data" || data.scope === "appended_email") {
      const rows = await fetchContactsForList(admin, data.clientId, data.scope);
      const label = data.scope === "appended_full_data" ? "appended-full-data" : "appended-email";
      return { files: { [`${label}-${stamp}.csv`]: buildContactsCsvV2(rows) }, count: rows.length };
    }

    if (data.scope === "final_full_contact") {
      const reviewLists = ["direct_mail", "email_phone", "email_list", "incomplete"] as const;
      const groups = await Promise.all(
        reviewLists.map((l) => fetchContactsWithFlags(admin, data.clientId, l, "primary")),
      );
      const survivors = groups.flat().filter((c) => isPrimaryReviewSurvivor(c) && hasAllEightContactFields(c));
      return { files: { [`final-full-contact-${stamp}.csv`]: buildContactsCsvV2(survivors) }, count: survivors.length };
    }

    // combine_marketable
    const lists = ["direct_mail", "email_phone", "email_list", "appended_full_data", "appended_email"] as const;
    const groups = await Promise.all(lists.map((l) => fetchContactsForList(admin, data.clientId, l)));
    const combined = dedupeContactRows(groups.flat());
    return {
      files: { [`final-marketable-database-${stamp}.csv`]: buildContactsCsvV2(combined) },
      count: combined.length,
    };
  });
