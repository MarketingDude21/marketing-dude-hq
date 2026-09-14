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

export type SoiAccess =
  | { role: "team" }
  | { role: "client"; clientId: string; clientName: string }
  | { role: "none" };

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
    const { data: clientRow } = await admin
      .from("clients")
      .select("name")
      .eq("id", accessRow.client_id)
      .maybeSingle();
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
    (data: {
      clientId: string;
      fileName: string;
      sourceLabel: string;
      kind: "vcf" | "mapped_csv";
      content: string;
    }) => data,
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

export const processSoiUploads = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { clientId: string }) => data)
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
    return counts;
  });

// Review-flag joins for the 3-step wizard (primary review_type only - the
// same lists the original wizard reviewed). Read-only, so reimplementing
// this one small join here (rather than only ever calling export-lists) is
// safe - it doesn't change how any contact is classified.
export const getSoiReviewCandidates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { clientId: string; listAssignment: "direct_mail" | "email_phone" | "email_list" | "incomplete" }) => data)
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

    const { error } = await admin
      .from("review_flags")
      .upsert(
        { contact_id: data.contactId, review_type: data.reviewType, flagged: data.flagged, flagged_by: email ?? "unknown" },
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
