import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import {
  getSoiAccess,
  provisionSoiClient,
  listSoiClients,
  listSoiUploads,
  uploadSoiFile,
  deleteSoiUpload,
  resetSoiDatabase,
  processSoiUploads,
  getSoiHubCounts,
  getSoiReviewCandidates,
  getSoiListView,
  setSoiReviewFlag,
  exportSoiList,
  previewDatazappAppend,
  finalizeDatazappAppend,
  type SoiAccess,
} from "@/lib/soi-builder";

export const Route = createFileRoute("/database")({
  head: () => ({
    meta: [
      { title: "Build My Database — Your Marketing Dude" },
      {
        name: "description",
        content: "Clean and segment your contact database into marketing lists.",
      },
    ],
  }),
  component: DatabasePage,
});

type ClientOption = { id: string; name: string };

const LIST_LABELS: Record<string, string> = {
  direct_mail: "Full Direct Mail",
  email_phone: "Email + Phone",
  email_list: "Email Only",
  incomplete: "Incomplete",
  nonqualified: "Nonqualified",
  realtor_excluded: "Realtor Excluded",
  business_excluded: "Business Excluded",
};
const HUB_ORDER = [
  "direct_mail",
  "email_phone",
  "email_list",
  "incomplete",
  "nonqualified",
  "realtor_excluded",
  "business_excluded",
] as const;

// Database Breakdown summary cards - separate from LIST_LABELS/HUB_ORDER
// above (those still label each contact's own individual list_assignment for
// the per-row "List" badge on the combined "Your Most Complete Data" review
// step). Mike wants the breakdown itself to show Full Direct Mail and
// Email + Phone combined into one "Complete Data" number, since that matches
// how the review step already treats them as one combined bucket.
// mode picks how the card's number is computed from `lists`' totals and
// `checkedLists`' _checked counts (see getSoiHubCounts): "checked" shows
// checked/total for an opt-IN list (email_list/incomplete - checked = kept);
// "survivors" shows (total - checked)/total for an opt-OUT list (direct_mail/
// email_phone - checked = removed, so survivors are the UNCHECKED ones);
// "none" is just the plain total, no live math. Both live formats give Mike
// real-time transparency on who'll actually make the final list without
// downloading anything.
const BREAKDOWN_CARDS = [
  {
    key: "complete_data",
    label: "Complete Data",
    lists: ["direct_mail", "email_phone"] as const,
    checkedLists: ["direct_mail", "email_phone"] as const,
    mode: "survivors" as const,
  },
  {
    key: "email_list",
    label: "Email Only",
    lists: ["email_list"] as const,
    checkedLists: ["email_list"] as const,
    mode: "checked" as const,
  },
  {
    key: "incomplete",
    label: "Incomplete",
    lists: ["incomplete"] as const,
    checkedLists: ["incomplete"] as const,
    mode: "checked" as const,
  },
  {
    key: "nonqualified",
    label: "Nonqualified",
    lists: ["nonqualified"] as const,
    checkedLists: [] as const,
    mode: "none" as const,
  },
  {
    key: "realtor_excluded",
    label: "Realtor Excluded",
    lists: ["realtor_excluded"] as const,
    checkedLists: [] as const,
    mode: "none" as const,
  },
  {
    key: "business_excluded",
    label: "Business Excluded",
    lists: ["business_excluded"] as const,
    checkedLists: [] as const,
    mode: "none" as const,
  },
] as const;

// direct_mail/email_phone: opt-OUT (checking = remove). email_list/incomplete: opt-IN (checking = keep).
// This whole tab bar matches the original SOI Builder app's own review flow
// tab-for-tab: 3 editable review steps, then read-only browsable lists for
// everything else the old app also let you look through (not just download).
const REVIEW_STEPS = [
  {
    key: "complete",
    label: "Your Most Complete Data",
    kind: "review" as const,
    lists: ["direct_mail", "email_phone"] as const,
    optOut: true,
    description:
      "Full addresses, plus everyone with a first name, last name, email, and phone. Check off anyone you don't actually know.",
  },
  {
    key: "email_list",
    label: "Email List",
    kind: "review" as const,
    lists: ["email_list"] as const,
    optOut: false,
    description: "Everyone else with a usable email. Check off anyone you actually know and want to keep.",
  },
  {
    key: "incomplete",
    label: "Incomplete",
    kind: "review" as const,
    lists: ["incomplete"] as const,
    optOut: false,
    description: "Missing enough info to sort automatically. Check off anyone you actually know and want to keep.",
  },
  {
    key: "final_full_contact",
    label: "Final Combined List",
    kind: "view" as const,
    description: "Everyone who made it through review with a complete record — ready to use.",
  },
  {
    key: "nonqualified",
    label: "Nonqualified",
    kind: "view" as const,
    description: "Didn't qualify for any list.",
  },
  {
    key: "facebook_audience",
    label: "Facebook Audience",
    kind: "view" as const,
    description: "Everyone with an email or phone, excluding realtors and businesses.",
  },
  {
    key: "realtor_excluded",
    label: "Realtors",
    kind: "view" as const,
    description: "Excluded as fellow real estate agents, not clients.",
  },
  {
    key: "business_excluded",
    label: "Businesses",
    kind: "view" as const,
    description: "Excluded as businesses, not individuals.",
  },
] as const;

// Big on-screen headline + a short instructional subheadline for the 3
// editable review steps only (not the read-only browsable views) - matches
// the old app's own "who don't you know on this list" framing, exact copy
// from Mike. Kept as a separate lookup rather than extra fields on
// REVIEW_STEPS above so that array's per-entry shape doesn't need to change.
// Mike's said a short how-to video will eventually go in this same spot too -
// nothing to build for that yet, just keep this location in mind.
const STEP_COPY: Partial<Record<(typeof REVIEW_STEPS)[number]["key"], { headline: string; subheadline: string }>> = {
  complete: {
    headline: "Who Don't You Want To Market To On This List?",
    subheadline:
      "Is there anyone on this list you don't know, like, trust, or want to see your content? This list should be comprised of past clients, family, friends, and anyone whom you'd expect to hire you when moving or refer you to a friend.",
  },
  email_list: {
    headline: "Who Should Receive Your Content?",
    subheadline:
      "Is there anyone on this list that you want to see your content? Place a check next to anyone you want to add to your marketing lists. This list should be comprised of current leads, past clients, family, friends, and anyone whom you'd expect to hire you when moving or refer you to a friend.",
  },
  incomplete: {
    headline: "Who Should Receive Your Content?",
    subheadline:
      "Is there anyone on this list that you want to see your content? Place a check next to anyone you want to add to your marketing lists. This list should be comprised of current leads, past clients, family, friends, and anyone whom you'd expect to hire you when moving or refer you to a friend.",
  },
};

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-3xl border border-border bg-glass p-6 backdrop-blur-2xl ${className}`}>{children}</div>
  );
}

function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
}) {
  const styles =
    variant === "primary"
      ? "bg-primary text-primary-foreground shadow-lg shadow-primary/30 hover:-translate-y-0.5"
      : variant === "danger"
        ? "border border-destructive/40 text-destructive hover:bg-destructive/10"
        : "border border-border bg-glass hover:bg-secondary";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-full px-5 py-2 text-sm font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-50 ${styles}`}
    >
      {children}
    </button>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Excel/ODS/TSV support: SheetJS is loaded from a CDN at runtime instead of
// an npm dependency, so this works the moment the file is pasted in — no
// separate "add a package" step in Lovable needed. Cached after the first
// load so picking a second spreadsheet file in the same session doesn't
// re-fetch it. Typed as `any` on purpose: it's a runtime-loaded module a
// build-time type checker can never see a declaration for.
let sheetJsPromise: Promise<any> | null = null;
async function loadSheetJs(): Promise<any> {
  if (!sheetJsPromise) {
    // @ts-expect-error — CDN URL module specifier, not resolvable at build time.
    sheetJsPromise = import(/* @vite-ignore */ "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");
  }
  return sheetJsPromise;
}

async function parseSpreadsheet(file: File): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  const XLSX = await loadSheetJs();
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const firstSheetName: string | undefined = workbook.SheetNames[0];
  if (!firstSheetName) return { headers: [], rows: [] };
  const sheet = workbook.Sheets[firstSheetName];
  const rawRows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  const firstRow = rawRows[0];
  const headers = firstRow ? Object.keys(firstRow) : [];
  const rows = rawRows.map((row) => {
    const out: Record<string, string> = {};
    for (const h of headers) {
      const v = row[h];
      out[h] = v === null || v === undefined ? "" : String(v);
    }
    return out;
  });
  return { headers, rows };
}

function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const splitLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  };
  const headers = splitLine(lines[0] ?? "").map((h) => h.trim());
  const rows = lines.slice(1).map((line) => {
    const cells = splitLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
  return { headers, rows };
}

const MAPPING_FIELDS = [
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "full_name", label: "Full name (if no separate first/last)" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "address", label: "Address" },
  { key: "address_2", label: "Address 2" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "zip", label: "Zip" },
  { key: "notes", label: "Notes" },
] as const;

// Recognized header spellings per field, so a normal CRM export (WiseAgent,
// Follow Up Boss, a phone contacts export, etc.) maps itself automatically
// instead of making the person pick every dropdown by hand. Anything that
// doesn't match one of these still shows up as "— none —" for a manual pick
// — this only fills in the obvious ones, it never guesses wrong silently
// because the dropdowns stay fully visible and editable either way.
const MAPPING_ALIASES: Record<string, string[]> = {
  first_name: ["first name", "firstname", "first", "fname", "given name"],
  last_name: ["last name", "lastname", "last", "lname", "surname", "family name"],
  full_name: ["full name", "fullname", "name", "contact name", "display name"],
  email: ["email", "e mail", "email address", "e mail address", "primary email", "emails"],
  phone: [
    "phone",
    "phone number",
    "cell",
    "cell phone",
    "mobile",
    "mobile phone",
    "home phone",
    "primary phone",
    "telephone",
    "phones",
  ],
  address: ["address", "address 1", "street address", "address line 1", "mailing address", "street"],
  address_2: ["address 2", "address line 2", "apt", "unit", "suite"],
  city: ["city", "town"],
  state: ["state", "st", "province"],
  zip: ["zip", "zip code", "zipcode", "postal code"],
  notes: ["notes", "note", "comments", "comment"],
};

function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function guessColumnMapping(headers: string[]): Record<string, string> {
  const guessed: Record<string, string> = {};
  const claimed = new Set<string>();
  for (const field of MAPPING_FIELDS) {
    const aliases = MAPPING_ALIASES[field.key] ?? [];
    const match = headers.find((h) => !claimed.has(h) && aliases.includes(normalizeHeader(h)));
    if (match) {
      guessed[field.key] = match;
      claimed.add(match);
    }
  }
  return guessed;
}

function DatabasePage() {
  const [access, setAccess] = useState<SoiAccess | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [selected, setSelected] = useState<ClientOption | null>(null);

  useEffect(() => {
    getSoiAccess()
      .then(async (a) => {
        // First time anyone new opens this: auto-create their Build My
        // Database client record right here, instead of showing a "not set
        // up yet" message and waiting on a team member to do it by hand.
        // Signing into the dashboard is the onboarding step now.
        const resolved = a.role === "none" ? await provisionSoiClient() : a;
        setAccess(resolved);
        if (resolved.role === "team") {
          const list = await listSoiClients();
          setClients(list.map((c) => ({ id: c.id, name: c.name })));
        } else if (resolved.role === "client") {
          setSelected({ id: resolved.clientId, name: resolved.clientName });
        }
      })
      .catch((e) => setAccessError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (accessError) {
    return (
      <AppShell>
        <PageHeader />
        <Card className="mt-5">
          <p className="text-sm text-destructive">{accessError}</p>
        </Card>
      </AppShell>
    );
  }

  if (!access) {
    return (
      <AppShell>
        <PageHeader />
        <Card className="mt-5">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </Card>
      </AppShell>
    );
  }

  if (access.role === "none") {
    return (
      <AppShell>
        <PageHeader />
        <Card className="mt-5">
          <p className="text-sm text-muted-foreground">
            We couldn't set up your Build My Database account automatically. Refresh and try again, or ask your team to
            check your access.
          </p>
        </Card>
      </AppShell>
    );
  }

  if (access.role === "team" && !selected) {
    return (
      <AppShell>
        <PageHeader />
        <Card className="mt-5">
          <h2 className="font-display text-lg font-semibold">Choose a client</h2>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {clients.map((c) => (
              <button
                key={c.id}
                onClick={() => setSelected(c)}
                className="rounded-2xl border border-border bg-glass px-4 py-3 text-left text-sm font-medium transition-colors hover:bg-secondary"
              >
                {c.name}
              </button>
            ))}
            {clients.length === 0 && <p className="text-sm text-muted-foreground">No clients yet.</p>}
          </div>
        </Card>
      </AppShell>
    );
  }

  if (!selected) return null;

  return (
    <AppShell>
      <PageHeader
        clientName={selected.name}
        onChangeClient={access.role === "team" ? () => setSelected(null) : undefined}
      />
      <Workspace clientId={selected.id} clientName={selected.name} />
    </AppShell>
  );
}

function PageHeader({
  clientName,
  onChangeClient,
}: {
  clientName?: string | undefined;
  onChangeClient?: (() => void) | undefined;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 pt-2">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Build My Database</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {clientName ? `Working on: ${clientName}` : "Clean and segment your contacts into marketing lists."}
        </p>
      </div>
      {onChangeClient && (
        <Button variant="secondary" onClick={onChangeClient}>
          Change client
        </Button>
      )}
    </div>
  );
}

// The full report handed back by processSoiUploads - raw/unique counts and a
// dedupe/address/borderline breakdown, straight from the real process-upload
// Edge Function. Pulled from processSoiUploads's own return type (rather than
// hand-duplicated) so it can never drift out of sync with what it returns.
type ProcessReport = Awaited<ReturnType<typeof processSoiUploads>>;

function Workspace({ clientId, clientName }: { clientId: string; clientName: string }) {
  // Upload / Review / Append Data / Export. "Append Data" added 2026-10-15
  // per Mike's request, after a round of real-world DataZapp append files -
  // its own second-round upload step for a file that gets matched/merged
  // straight into contacts already sitting in this client's database,
  // rather than treated like a normal new list (see soi-builder.ts's
  // DataZapp-append section for why that has to be a different code path
  // from the Upload tab below). Sits after Review/Final Combined List and
  // before Export, since it only makes sense once a client's been through a
  // first round already and DataZapp's reply is in hand.
  const [tab, setTab] = useState<"upload" | "review" | "append" | "export">("upload");
  // The most recent Process run's report (raw/unique/dedupe counts) - lives
  // here so it survives switching from Upload to Review right after
  // processing, without needing to persist it anywhere server-side.
  const [lastProcessReport, setLastProcessReport] = useState<ProcessReport | null>(null);
  return (
    <div className="mt-5">
      <div className="flex flex-wrap gap-1 rounded-full border border-border bg-glass p-1 backdrop-blur-xl w-fit">
        {(["upload", "review", "append", "export"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === t ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t === "upload" ? "Upload" : t === "review" ? "Review" : t === "append" ? "Append Data" : "Export"}
          </button>
        ))}
      </div>
      <div className="mt-5">
        {tab === "upload" && (
          <UploadTab
            clientId={clientId}
            clientName={clientName}
            onProcessed={() => setTab("review")}
            onReport={setLastProcessReport}
            onReset={() => setLastProcessReport(null)}
          />
        )}
        {tab === "review" && <ReviewTab clientId={clientId} lastProcessReport={lastProcessReport} />}
        {tab === "append" && <AppendDataTab clientId={clientId} />}
        {tab === "export" && <ExportTab clientId={clientId} />}
      </div>
    </div>
  );
}

// Formats SheetJS can read directly, browser-side, with no server round trip.
const SPREADSHEET_EXTENSIONS = [".xlsx", ".xls", ".xlsm", ".xlsb", ".ods", ".tsv"];

type BatchItem = { file: File; status: "pending" | "uploading" | "done" | "error"; error?: string };

function UploadTab({
  clientId,
  clientName,
  onProcessed,
  onReport,
  onReset,
}: {
  clientId: string;
  clientName: string;
  onProcessed: () => void;
  onReport: (report: ProcessReport) => void;
  onReset: () => void;
}) {
  const [uploads, setUploads] = useState<
    Array<{ id: string; file_name: string; source_label: string; status: string }>
  >([]);
  // "Reset database" confirmation - typing the client's own name is the
  // gate, same spirit as GitHub/Lovable's own "type to confirm" deletes,
  // since resetSoiDatabase is irreversible and wipes every contact this
  // client has, not just the files on this screen.
  const [resetOpen, setResetOpen] = useState(false);
  const [resetConfirmText, setResetConfirmText] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetDone, setResetDone] = useState<{ deletedContacts: number; deletedUploads: number } | null>(null);
  // The current drag/pick batch and how far it's gotten — files upload
  // automatically the moment they're picked (parsed, columns auto-matched,
  // sent) with no per-file "confirm and click Upload" step, so a whole
  // batch goes straight through to the Process step without stopping to
  // ask for anything, matching how the old app worked.
  const [batch, setBatch] = useState<BatchItem[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [processResult, setProcessResult] = useState<Record<string, number> | null>(null);
  // Once Process finishes successfully we jump straight to the Review tab
  // (where the breakdown + report now live) instead of leaving the results
  // sitting inline here — this just remembers that this batch has already
  // been run, so the button still reads "Processed" if he clicks back to
  // this tab.
  const [processed, setProcessed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => listSoiUploads({ data: { clientId } }).then(setUploads);
  useEffect(() => {
    refresh();
  }, [clientId]);

  async function uploadOneFile(file: File): Promise<void> {
    const lowerName = file.name.toLowerCase();
    const sourceLabel = file.name.replace(/\.[^.]+$/, "");
    if (lowerName.endsWith(".numbers")) {
      // Apple's .numbers format is a proprietary bundle, not a spreadsheet
      // format any browser-side library can parse — there's no safe way to
      // read this directly. Numbers itself exports to CSV/Excel in one click.
      throw new Error(
        "Apple Numbers files (.numbers) can't be read directly — use File > Export To > CSV (or Excel) in Numbers first.",
      );
    }
    if (lowerName.endsWith(".vcf")) {
      const content = await fileToBase64(file);
      await uploadSoiFile({ data: { clientId, fileName: file.name, sourceLabel, kind: "vcf", content } });
      return;
    }
    let preview: { headers: string[]; rows: Record<string, string>[] };
    if (SPREADSHEET_EXTENSIONS.some((ext) => lowerName.endsWith(ext))) {
      try {
        preview = await parseSpreadsheet(file);
      } catch {
        throw new Error("Couldn't read that file — try re-saving/exporting it as a .csv instead.");
      }
    } else {
      preview = parseCsv(await file.text());
    }
    // Auto-match columns from the file's own headers (First Name, Email,
    // etc.) — see guessColumnMapping's comment for what counts as
    // recognizable. No manual mapping step; this is what lets a batch go
    // straight through without stopping for each file.
    const mapping = guessColumnMapping(preview.headers);
    await uploadSoiFile({
      data: {
        clientId,
        fileName: file.name,
        sourceLabel,
        kind: "mapped_csv",
        content: JSON.stringify({ mapping, rows: preview.rows }),
      },
    });
  }

  async function handleFilesPicked(files: File[]) {
    if (files.length === 0) return;
    setError(null);
    setProcessed(false);
    const items: BatchItem[] = files.map((file) => ({ file, status: "pending" }));
    setBatch(items);
    setBatchRunning(true);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;
      setBatch((cur) => cur.map((it, idx) => (idx === i ? { ...it, status: "uploading" } : it)));
      try {
        await uploadOneFile(item.file);
        setBatch((cur) => cur.map((it, idx) => (idx === i ? { ...it, status: "done" } : it)));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setBatch((cur) => cur.map((it, idx) => (idx === i ? { ...it, status: "error", error: message } : it)));
      }
    }
    setBatchRunning(false);
    await refresh();
  }

  async function handleProcess() {
    setBusy(true);
    setError(null);
    try {
      const result = await processSoiUploads({ data: { clientId } });
      setProcessResult(result.list_counts);
      setProcessed(true);
      onReport(result);
      // Don't make Mike hunt for the results on this screen — jump straight
      // to the Review tab, where the breakdown + report now live.
      onProcessed();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleReset() {
    if (resetConfirmText.trim() !== clientName.trim()) return;
    setResetBusy(true);
    setResetError(null);
    try {
      const result = await resetSoiDatabase({ data: { clientId } });
      setResetDone(result);
      setResetOpen(false);
      setResetConfirmText("");
      // Clear every bit of local state this screen (and Review, via
      // onReset) was holding, so it's a genuinely clean slate without
      // needing a page reload.
      setUploads([]);
      setBatch([]);
      setProcessed(false);
      setProcessResult(null);
      onReset();
    } catch (e) {
      setResetError(e instanceof Error ? e.message : String(e));
    } finally {
      setResetBusy(false);
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <h2 className="font-display text-lg font-semibold">Add a file</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          CSV, Excel, or OpenDocument spreadsheet export from your CRM, or a .vcf contacts export. (Apple Numbers files
          need to be exported to CSV or Excel first — Numbers can do that in one click via File &gt; Export To.)
        </p>
        <label className="mt-4 flex cursor-pointer flex-col items-start gap-3 rounded-2xl border border-dashed border-border bg-background/40 px-5 py-6 transition-colors hover:bg-secondary/40 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-sm text-muted-foreground">
            {batchRunning
              ? "Uploading…"
              : "Drop one or more files here, or click to browse — they upload automatically."}
          </span>
          <span className="rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-transform hover:-translate-y-0.5">
            Choose files
          </span>
          <input
            type="file"
            multiple
            accept=".csv,.vcf,.xls,.xlsx,.xlsm,.xlsb,.ods,.tsv,.numbers"
            onChange={(e) => handleFilesPicked(Array.from(e.target.files ?? []))}
            className="hidden"
          />
        </label>
        {batch.length > 0 && (
          <ul className="mt-4 space-y-1.5">
            {batch.map((item, idx) => (
              <li key={idx} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate">{item.file.name}</span>
                <span
                  className={
                    item.status === "done"
                      ? "text-xs font-medium text-primary"
                      : item.status === "error"
                        ? "text-xs font-medium text-destructive"
                        : "text-xs text-muted-foreground"
                  }
                >
                  {item.status === "pending" && "Waiting…"}
                  {item.status === "uploading" && "Uploading…"}
                  {item.status === "done" && "Uploaded ✓"}
                  {item.status === "error" && (item.error ?? "Failed")}
                </span>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </Card>

      <Card>
        <h2 className="font-display text-lg font-semibold">Uploaded files</h2>
        <ul className="mt-3 space-y-2">
          {uploads.map((u) => (
            <li
              key={u.id}
              className="flex items-center justify-between rounded-xl border border-border px-3 py-2 text-sm"
            >
              <span>
                {u.file_name} <span className="text-muted-foreground">({u.source_label})</span>
              </span>
              <button
                onClick={() => deleteSoiUpload({ data: { clientId, uploadId: u.id } }).then(refresh)}
                className="text-xs text-destructive hover:underline"
              >
                Remove
              </button>
            </li>
          ))}
          {uploads.length === 0 && <p className="text-sm text-muted-foreground">No files uploaded yet.</p>}
        </ul>
        <div className="mt-5 border-t border-border pt-4">
          <Button onClick={handleProcess} disabled={busy || uploads.length === 0}>
            {busy ? "Processing…" : processed ? "Processed ✓" : "Process all uploads"}
          </Button>
          {processed && processResult && (
            <p className="mt-3 text-sm text-muted-foreground">
              Done — see the breakdown on the{" "}
              <button onClick={onProcessed} className="font-medium text-primary hover:underline">
                Review
              </button>{" "}
              tab.
            </p>
          )}
        </div>
      </Card>

      {/* "There should be a reset button on the Upload screen anytime you
          want to rerun a new database. People may come back and add
          contacts to it or clean their list." — added 2026-10-15. Wipes
          every file and every contact this client has via
          resetSoiDatabase, so a new upload round starts completely clean
          instead of deduping against whatever's already in there. Gated
          behind typing the client's own name, since there's no undo. */}
      <Card className="lg:col-span-2 border-destructive/40">
        <h2 className="font-display text-lg font-semibold text-destructive">Start over</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Permanently deletes every uploaded file and every contact for {clientName} so you can run a brand-new database
          from scratch. This can't be undone — use it when a client wants their whole list wiped and re-cleaned, not
          just a new batch added to what's already here.
        </p>
        {resetDone && !resetOpen && (
          <p className="mt-3 text-sm text-muted-foreground">
            Done — removed {resetDone.deletedContacts} contact{resetDone.deletedContacts === 1 ? "" : "s"} and{" "}
            {resetDone.deletedUploads} uploaded file{resetDone.deletedUploads === 1 ? "" : "s"}. Ready for a fresh
            upload.
          </p>
        )}
        {!resetOpen ? (
          <div className="mt-3">
            <Button variant="danger" onClick={() => setResetOpen(true)}>
              Reset database
            </Button>
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            <p className="text-sm text-muted-foreground">
              Type <span className="font-semibold text-foreground">{clientName}</span> to confirm.
            </p>
            <input
              value={resetConfirmText}
              onChange={(e) => setResetConfirmText(e.target.value)}
              placeholder={clientName}
              className="w-full max-w-sm rounded-2xl border border-border bg-background px-4 py-2.5 text-sm outline-none ring-ring transition focus:ring-2"
            />
            <div className="flex gap-2">
              <Button
                variant="danger"
                onClick={handleReset}
                disabled={resetBusy || resetConfirmText.trim() !== clientName.trim()}
              >
                {resetBusy ? "Resetting…" : "Permanently delete everything"}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setResetOpen(false);
                  setResetConfirmText("");
                  setResetError(null);
                }}
              >
                Cancel
              </Button>
            </div>
            {resetError && <p className="text-sm text-destructive">{resetError}</p>}
          </div>
        )}
      </Card>
    </div>
  );
}

// Turns a dedupe_stats key like "exact_email_match" into "Exact email match" -
// generic on purpose, since the real reason codes live in the process-upload
// Edge Function and could be renamed/added to there without this needing to
// change in lockstep.
function formatDedupeReason(key: string): string {
  const words = key.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

// The breakdown counts used to live on their own separate "Database
// Breakdown" tab - Mike found that confusing and asked for it folded into
// the top of Review instead, directly above the step tabs. Also surfaces the
// duplicate-removal report from the most recent Process run (the "little
// report" the old app had), when there is one.
function DatabaseBreakdown({
  clientId,
  lastProcessReport,
  refreshSignal,
}: {
  clientId: string;
  lastProcessReport: ProcessReport | null;
  // Bumped by ReviewTab any time a checkbox is saved, so the checked/total
  // numbers below stay live instead of only updating on the next Process run
  // or tab switch - this is the "reflect the math in real time" Mike asked for.
  refreshSignal: number;
}) {
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    getSoiHubCounts({ data: { clientId } }).then(setCounts);
    // Re-fetch on a fresh Process run and on every saved checkbox change, not just on client change.
  }, [clientId, lastProcessReport, refreshSignal]);

  const duplicatesRemoved = lastProcessReport ? lastProcessReport.raw_total - lastProcessReport.unique_total : 0;

  return (
    <div className="mb-6">
      <h2 className="font-display text-lg font-semibold">Database Breakdown</h2>
      {counts ? (
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {BREAKDOWN_CARDS.map((card) => {
            const total = card.lists.reduce((sum: number, l) => sum + (counts[l] ?? 0), 0);
            const checkedSum = card.checkedLists.reduce((sum: number, l) => sum + (counts[`${l}_checked`] ?? 0), 0);
            const display =
              card.mode === "checked"
                ? `${checkedSum}/${total}`
                : card.mode === "survivors"
                  ? `${total - checkedSum}/${total}`
                  : total;
            const caption =
              card.mode === "checked"
                ? "checked off / total on list"
                : card.mode === "survivors"
                  ? "will make final list / total on list"
                  : null;
            return (
              <Card key={card.key}>
                <p className="text-sm text-muted-foreground">{card.label}</p>
                <p className="mt-1 font-display text-3xl font-bold">{display}</p>
                {caption && <p className="mt-1 text-xs text-muted-foreground">{caption}</p>}
              </Card>
            );
          })}
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
      )}

      {lastProcessReport && (
        <Card className="mt-4">
          <h3 className="font-display text-base font-semibold">Just processed</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {lastProcessReport.raw_total} contact{lastProcessReport.raw_total === 1 ? "" : "s"} uploaded →{" "}
            {lastProcessReport.unique_total} unique ({duplicatesRemoved} duplicate{duplicatesRemoved === 1 ? "" : "s"}{" "}
            removed).
          </p>
          {Object.keys(lastProcessReport.dedupe_stats).length > 0 && (
            <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
              {Object.entries(lastProcessReport.dedupe_stats).map(([reason, count]) => (
                <li key={reason}>
                  {formatDedupeReason(reason)}: {count}
                </li>
              ))}
            </ul>
          )}
          {lastProcessReport.address_corrections.length > 0 && (
            <p className="mt-2 text-sm text-muted-foreground">
              {lastProcessReport.address_corrections.length} address correction
              {lastProcessReport.address_corrections.length === 1 ? "" : "s"} made.
            </p>
          )}
          {lastProcessReport.borderline_flags.length > 0 && (
            <p className="mt-1 text-sm text-muted-foreground">
              {lastProcessReport.borderline_flags.length} borderline email/domain flag
              {lastProcessReport.borderline_flags.length === 1 ? "" : "s"} worth a second look.
            </p>
          )}
        </Card>
      )}
    </div>
  );
}

// The preview/finalize summary shapes returned by soi-builder.ts's
// DataZapp-append functions - pulled from their own return types rather
// than hand-duplicated, same reasoning as ProcessReport above.
type DatazappPreview = Awaited<ReturnType<typeof previewDatazappAppend>>;
type DatazappFinalizeResult = Awaited<ReturnType<typeof finalizeDatazappAppend>>;
type DatazappReviewRow = DatazappPreview["reviewRows"][number];

const DATAZAPP_TIER_LABELS: Record<string, string> = {
  confirmed: "Confirmed match",
  household: "Same household (address only)",
  mismatch: "Name doesn't match — not reviewable",
  no_data: "DataZapp had nothing to add",
};

function triggerCsvDownload(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Standalone pass over a DataZapp return file, with no connection to this
// client's actual contacts at all. REDESIGNED TWICE the same day this first
// shipped - see soi-builder.ts's header comment on this whole feature for
// the full story. The short version: version 1 looked up each row's phone
// number against this client's stored contacts and auto-applied matches
// with no review; Mike tested it live, got "Applied: Updated 0 of 927
// contacts," and separately said auto-apply was the wrong call regardless.
// Version 2 added a review wizard but kept the contacts lookup - and Mike
// said THAT was the real mistake: "The append data should have nothing to
// do with the prior contacts... I'm uploading an appended list that's still
// showing me zero results because I don't have that data from the original
// upload, so it doesn't make sense." His own description of the process:
// "you upload the appended data file. It's going to give you all the
// matches. It's going to give you all the mismatches, and then it's going
// to clean that list up... and it's going to ask us who we're keeping."
// This version does exactly that and nothing else - the file already
// carries its own original name/phone/email next to DataZapp's appended
// columns, so matching is a same-row comparison, no database lookup
// involved anywhere. The result is a standalone downloadable list, the
// same kind of thing as "Final Full Contact" elsewhere in this tab, not a
// write to any contact record.
function AppendDataTab({ clientId }: { clientId: string }) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, string>[] | null>(null);
  const [preview, setPreview] = useState<DatazappPreview | null>(null);
  const [checkedRows, setCheckedRows] = useState<Set<number>>(new Set());
  const [finalizeResult, setFinalizeResult] = useState<DatazappFinalizeResult | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFilePicked(file: File) {
    setError(null);
    setPreview(null);
    setFinalizeResult(null);
    setSearch("");
    setFileName(file.name);
    setBusy(true);
    try {
      const lowerName = file.name.toLowerCase();
      const parsed = SPREADSHEET_EXTENSIONS.some((ext) => lowerName.endsWith(ext))
        ? await parseSpreadsheet(file)
        : parseCsv(await file.text());
      if (parsed.rows.length === 0) throw new Error("That file doesn't have any rows in it.");
      setRows(parsed.rows);
      const result = await previewDatazappAppend({ data: { clientId, rows: parsed.rows } });
      setPreview(result);
      // Opt-OUT, same as Mike's own description of how this should work:
      // everyone worth reviewing starts checked (kept); his team unchecks
      // the ones they don't want rather than having to check every row by
      // hand.
      setCheckedRows(new Set(result.reviewRows.map((r) => r.rowIndex)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function toggleRow(rowIndex: number, next: boolean) {
    setCheckedRows((cur) => {
      const copy = new Set(cur);
      if (next) copy.add(rowIndex);
      else copy.delete(rowIndex);
      return copy;
    });
  }

  function toggleAllVisible(visible: DatazappReviewRow[], next: boolean) {
    setCheckedRows((cur) => {
      const copy = new Set(cur);
      for (const r of visible) {
        if (next) copy.add(r.rowIndex);
        else copy.delete(r.rowIndex);
      }
      return copy;
    });
  }

  async function handleFinalize() {
    if (!rows) return;
    setBusy(true);
    setError(null);
    try {
      const result = await finalizeDatazappAppend({
        data: { clientId, rows, includedRowIndexes: Array.from(checkedRows) },
      });
      setFinalizeResult(result);
      if (result.csv) {
        triggerCsvDownload(`datazapp-appended-${new Date().toISOString().slice(0, 10)}.csv`, result.csv);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const q = search.trim().toLowerCase();
  const reviewRows = preview?.reviewRows ?? [];
  const filtered = q
    ? reviewRows.filter((r) => [r.firstName, r.lastName, r.phone].some((v) => (v ?? "").toLowerCase().includes(q)))
    : reviewRows;
  const allFilteredChecked = filtered.length > 0 && filtered.every((r) => checkedRows.has(r.rowIndex));
  const checkedCount = checkedRows.size;

  return (
    <div className="space-y-4">
      <Card>
        <h2 className="font-display text-lg font-semibold">Append Data</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload the file DataZapp sent back after appending emails/direct mail addresses to the contacts you sent it.
          This doesn't touch any contact record at all — it's a standalone pass over just this file, checking DataZapp's
          own appended name against the original name already in the same file before trusting the appended data. Common
          nicknames (Mike/Michael, Kate/Catherine) count as a match, and a same-household match (last name agrees, first
          name doesn't) still gets the mailing address, just not the email. The result is its own clean list you review
          and download — same idea as Final Full Contact, just for this file.
        </p>
        <label className="mt-4 flex cursor-pointer items-center justify-center rounded-2xl border border-dashed border-border bg-muted/50 px-4 py-8 text-sm text-muted-foreground transition-colors hover:bg-muted">
          <input
            type="file"
            accept=".csv,.xlsx,.xls,.xlsm,.xlsb,.ods,.tsv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFilePicked(file);
              e.target.value = "";
            }}
          />
          {busy && !preview
            ? "Working…"
            : fileName
              ? `${fileName} — click to replace`
              : "Click to choose the DataZapp file"}
        </label>
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </Card>

      {preview && !finalizeResult && (
        <>
          <Card>
            <h3 className="font-display text-base font-semibold">{preview.total} rows checked</h3>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {(["confirmed", "household", "mismatch", "no_data"] as const).map((tier) => (
                <div key={tier} className="rounded-2xl border border-border bg-glass px-4 py-3">
                  <p className="text-2xl font-bold tabular-nums">{preview.counts[tier]}</p>
                  <p className="text-xs text-muted-foreground">{DATAZAPP_TIER_LABELS[tier]}</p>
                </div>
              ))}
            </div>
            {preview.doNotCallCount > 0 && (
              <p className="mt-3 text-sm text-muted-foreground">
                {preview.doNotCallCount} row{preview.doNotCallCount === 1 ? "" : "s"} came back flagged Do Not Call by
                DataZapp, regardless of whether the name matched or whether it's kept below.
              </p>
            )}
            {preview.possibleBusinessCount > 0 && (
              <p className="mt-1 text-sm text-muted-foreground">
                {preview.possibleBusinessCount} came back with a company name attached — worth a look before treating
                them as a personal contact.
              </p>
            )}
            <p className="mt-4 text-sm text-muted-foreground">
              Only the {preview.counts.confirmed + preview.counts.household} confirmed/same-household matches below are
              worth reviewing. Mismatches and rows DataZapp had nothing for never make the list either way, so there's
              nothing to decide on them.
            </p>
          </Card>

          {reviewRows.length === 0 ? (
            <Card>
              <p className="text-sm text-muted-foreground">
                Nothing here matched well enough to review — DataZapp didn't return anything your team can safely use
                from this file.
              </p>
            </Card>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                  <span className="font-semibold text-foreground">{checkedCount}</span> of {reviewRows.length} kept —
                  uncheck anyone you don't want on the final list.
                </p>
                <Button onClick={handleFinalize} disabled={busy || checkedCount === 0}>
                  {busy ? "Working…" : `Download the list (${checkedCount} kept)`}
                </Button>
              </div>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name or phone…"
                className="w-full max-w-md rounded-2xl border border-border bg-background px-4 py-2.5 text-sm outline-none ring-ring transition focus:ring-2"
              />
              <Card>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="sticky left-0 z-10 w-24 min-w-24 max-w-24 truncate bg-background pb-2 pr-4">
                          First name
                        </th>
                        <th className="sticky left-24 z-10 w-28 min-w-28 max-w-28 truncate border-r border-border bg-background pb-2 pr-4">
                          Last name
                        </th>
                        <th className="whitespace-nowrap pb-2 pr-4">Phone</th>
                        <th className="whitespace-nowrap pb-2 pr-4">Match</th>
                        <th className="pb-2 pr-4">Email</th>
                        <th className="pb-2 pr-4">Address</th>
                        <th className="whitespace-nowrap pb-2 pr-4">City</th>
                        <th className="whitespace-nowrap pb-2 pr-4">State</th>
                        <th className="whitespace-nowrap pb-2 pr-4">Zip</th>
                        <th className="sticky right-0 z-10 whitespace-nowrap border-l border-border bg-background pb-2 pl-3">
                          <div className="flex items-center gap-2">
                            <span>Keep</span>
                            <button
                              type="button"
                              onClick={() => toggleAllVisible(filtered, !allFilteredChecked)}
                              disabled={filtered.length === 0}
                              className="text-xs font-medium normal-case text-primary underline-offset-2 transition-colors hover:underline disabled:opacity-60"
                            >
                              {allFilteredChecked ? "Clear all" : "Select all"}
                            </button>
                          </div>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((r) => (
                        <tr key={r.rowIndex} className="border-t border-border">
                          <td
                            title={r.firstName || undefined}
                            className="sticky left-0 z-10 w-24 min-w-24 max-w-24 truncate bg-background py-2 pr-4"
                          >
                            {r.firstName}
                          </td>
                          <td
                            title={r.lastName || undefined}
                            className="sticky left-24 z-10 w-28 min-w-28 max-w-28 truncate border-r border-border bg-background py-2 pr-4"
                          >
                            {r.lastName}
                          </td>
                          <td className="whitespace-nowrap py-2 pr-4">{r.phone}</td>
                          <td className="py-2 pr-4">
                            <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              {r.tier === "confirmed" ? "Confirmed" : "Household"}
                            </span>
                          </td>
                          <td className="py-2 pr-4">
                            {r.finalEmail || (
                              <span className="text-muted-foreground">
                                {r.tier === "household" ? "— (withheld, household match)" : "—"}
                              </span>
                            )}
                          </td>
                          <td className="py-2 pr-4">
                            {r.finalAddress || <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="whitespace-nowrap py-2 pr-4">{r.finalCity}</td>
                          <td className="whitespace-nowrap py-2 pr-4">{r.finalState}</td>
                          <td className="whitespace-nowrap py-2 pr-4">{r.finalZip}</td>
                          <td className="sticky right-0 z-10 border-l border-border bg-background py-2 pl-3">
                            <input
                              type="checkbox"
                              checked={checkedRows.has(r.rowIndex)}
                              onChange={(e) => toggleRow(r.rowIndex, e.target.checked)}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {filtered.length === 0 && (
                    <p className="text-sm text-muted-foreground">No matches for that search.</p>
                  )}
                </div>
              </Card>
            </>
          )}
        </>
      )}

      {finalizeResult && (
        <Card>
          <h3 className="font-display text-base font-semibold">List ready</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            {finalizeResult.keptCount} contact{finalizeResult.keptCount === 1 ? "" : "s"} on the final list. Nothing
            about this client's existing contacts was touched — this is a standalone download, ready to upload wherever
            you need it (Suite Assist, or anywhere else).
          </p>
          {finalizeResult.csv ? (
            <div className="mt-3">
              <Button
                variant="secondary"
                onClick={() =>
                  triggerCsvDownload(
                    `datazapp-appended-${new Date().toISOString().slice(0, 10)}.csv`,
                    finalizeResult.csv!,
                  )
                }
              >
                Download the list again
              </Button>
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">Nothing was kept, so there's no list to download.</p>
          )}
          <div className="mt-4">
            <Button
              variant="secondary"
              onClick={() => {
                setFinalizeResult(null);
                setPreview(null);
                setRows(null);
                setFileName(null);
              }}
            >
              Upload another file
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

type ReviewContact = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  list_assignment: string | null;
  flagged: boolean;
};

function positionKey(clientId: string, stepKey: string): string {
  return `soi-review-position:${clientId}:${stepKey}`;
}

function ReviewTab({ clientId, lastProcessReport }: { clientId: string; lastProcessReport: ProcessReport | null }) {
  const [stepKey, setStepKey] = useState<(typeof REVIEW_STEPS)[number]["key"]>("complete");
  const step = REVIEW_STEPS.find((s) => s.key === stepKey) ?? REVIEW_STEPS[0];
  const editable = step.kind === "review";
  const [contacts, setContacts] = useState<ReviewContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [leftOffId, setLeftOffId] = useState<string | null>(null);
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  // Bumped after every saved checkbox change, so DatabaseBreakdown's
  // checked/total numbers refetch and stay live rather than only updating on
  // the next Process run.
  const [refreshSignal, setRefreshSignal] = useState(0);
  const rowRefs = useMemo(() => new Map<string, HTMLTableRowElement>(), []);

  useEffect(() => {
    setSearch("");
    setJumpTo(null);
    setLoadError(null);

    // "Final Combined List" gets its own dedicated Full Contact / Needs Data
    // component below (FinalCombinedListStep) instead of the generic table -
    // it fetches its own data, so skip the generic fetch entirely here.
    if (step.key === "final_full_contact") {
      setContacts([]);
      setLoading(false);
      setLeftOffId(null);
      return;
    }

    setLoading(true);
    const request =
      step.kind === "review"
        ? Promise.all(step.lists.map((l) => getSoiReviewCandidates({ data: { clientId, listAssignment: l } })))
        : getSoiListView({ data: { clientId, view: step.key } }).then((rows) => [
            rows.map((r) => ({ ...r, flagged: false })),
          ]);
    request
      .then((results) => setContacts(results.flat()))
      // A failed fetch used to just leave this list empty with no
      // explanation while the error surfaced as an uncaught rejection
      // elsewhere - show it here instead, on the step it actually happened
      // on, so it's obvious this is "the list failed to load" rather than
      // "this list is genuinely empty."
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));

    if (step.kind === "review") {
      try {
        setLeftOffId(localStorage.getItem(positionKey(clientId, step.key)));
      } catch {
        setLeftOffId(null);
      }
    } else {
      setLeftOffId(null);
    }
  }, [clientId, step]);

  function savePosition(contactId: string) {
    try {
      localStorage.setItem(positionKey(clientId, step.key), contactId);
    } catch {
      // Browser storage isn't available - resume just won't be offered next time.
    }
  }

  async function toggle(contactId: string, next: boolean) {
    setContacts((cs) => cs.map((c) => (c.id === contactId ? { ...c, flagged: next } : c)));
    savePosition(contactId);
    await setSoiReviewFlag({ data: { clientId, contactId, reviewType: "primary", flagged: next } });
    setRefreshSignal((n) => n + 1);
  }

  async function toggleAll(next: boolean) {
    const ids = filtered.map((c) => c.id);
    setContacts((cs) => cs.map((c) => (ids.includes(c.id) ? { ...c, flagged: next } : c)));
    await Promise.all(
      ids.map((id) => setSoiReviewFlag({ data: { clientId, contactId: id, reviewType: "primary", flagged: next } })),
    );
    setRefreshSignal((n) => n + 1);
  }

  const q = search.trim().toLowerCase();
  const filtered = q
    ? contacts.filter((c) =>
        [c.first_name, c.last_name, c.email, c.phone].some((v) => (v ?? "").toLowerCase().includes(q)),
      )
    : contacts;
  const allChecked = filtered.length > 0 && filtered.every((c) => c.flagged);
  const showListColumn =
    step.kind === "review"
      ? step.lists.length > 1
      : step.key === "final_full_contact" || step.key === "facebook_audience";
  // Same full-address layout on every screen, not just Incomplete, so Mike
  // can see how the data sorts on any list at a glance.
  const showAddressColumns = true;
  const leftOffContact = leftOffId ? contacts.find((c) => c.id === leftOffId) : undefined;
  const stepCopy = STEP_COPY[step.key];
  // Live "how many will actually make the final list" math for every
  // editable review step, so Mike can reconcile without downloading
  // anything. email_list/incomplete are opt-IN (checked = kept), so the
  // number that matters is how many are checked; "Your Most Complete Data"
  // (direct_mail/email_phone) is opt-OUT (checked = removed), so the number
  // that matters is how many are UNCHECKED - i.e. total minus checked.
  const checkedCount = contacts.filter((c) => c.flagged).length;
  const showCheckedCount = step.kind === "review";
  const makesFinalListCount = step.kind === "review" && step.optOut ? contacts.length - checkedCount : checkedCount;

  useEffect(() => {
    if (!jumpTo) return;
    const row = rowRefs.get(jumpTo);
    if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
    setJumpTo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo]);

  return (
    <div>
      <DatabaseBreakdown clientId={clientId} lastProcessReport={lastProcessReport} refreshSignal={refreshSignal} />
      <div className="flex flex-wrap gap-2">
        {REVIEW_STEPS.map((s) => (
          <button
            key={s.key}
            onClick={() => setStepKey(s.key)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              stepKey === s.key ? "bg-secondary" : "border border-border hover:bg-secondary/50"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
      {step.key === "final_full_contact" ? (
        <FinalCombinedListStep clientId={clientId} />
      ) : (
        <>
          {stepCopy ? (
            <div className="mt-4">
              <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">{stepCopy.headline}</h1>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">{stepCopy.subheadline}</p>
              {showCheckedCount ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  <span className="font-semibold text-foreground">
                    {makesFinalListCount}/{contacts.length}
                  </span>{" "}
                  {step.kind === "review" && step.optOut
                    ? "will make your final list — checked contacts get removed."
                    : "checked off — these are the ones that'll make your final list."}
                </p>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground">
                  {contacts.length} contact{contacts.length === 1 ? "" : "s"} on this list.
                </p>
              )}
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              {contacts.length} contact{contacts.length === 1 ? "" : "s"} on this list. {step.description}
            </p>
          )}

          {leftOffContact && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-background/40 px-4 py-3">
              <p className="text-sm text-muted-foreground">
                You left off around{" "}
                <span className="font-semibold text-foreground">
                  {leftOffContact.first_name} {leftOffContact.last_name}
                </span>{" "}
                last time.
              </p>
              <div className="flex gap-2">
                <Button onClick={() => setJumpTo(leftOffContact.id)}>Jump back there</Button>
                <Button variant="secondary" onClick={() => setLeftOffId(null)}>
                  Start from the top
                </Button>
              </div>
            </div>
          )}

          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email, or phone…"
            className="mt-4 w-full max-w-md rounded-2xl border border-border bg-background px-4 py-2.5 text-sm outline-none ring-ring transition focus:ring-2"
          />

          <Card className="mt-4">
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : loadError ? (
              <p className="text-sm text-destructive">Couldn't load this list: {loadError}</p>
            ) : (
              <div className="overflow-x-auto">
                {/* FIXED (2026-09-25) — per Mike: "we can't see the keep all
                    section from when you look at the name... the user needs
                    to now scroll left to see what the name is and scroll
                    right... the entire view needs to be shifted over or
                    expanded so that you can see every column." Root cause:
                    with 8-9 columns of real address data this table is wider
                    than the page, so the overflow-x-auto div has to scroll —
                    unavoidable on most screens without dropping columns
                    Mike didn't ask to drop. Instead of removing columns,
                    First name / Last name are now frozen (sticky) on the
                    left and the checkbox column is frozen on the right, so
                    whichever way you scroll to read Email/Address/Zip/etc.,
                    the name AND the checkbox stay on screen the whole time
                    — you never lose track of who you're looking at. Padding
                    also tightened slightly (pr-6 → pr-4) so more columns
                    fit before scrolling is even needed. Same fix applied to
                    the "Needs Data" table below in FinalCombinedListStep,
                    which had the identical layout and would hit the same
                    complaint. */}
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="sticky left-0 z-10 w-24 min-w-24 max-w-24 truncate bg-background pb-2 pr-4">
                        First name
                      </th>
                      <th className="sticky left-24 z-10 w-28 min-w-28 max-w-28 truncate border-r border-border bg-background pb-2 pr-4">
                        Last name
                      </th>
                      <th className="pb-2 pr-4">Email</th>
                      <th className="whitespace-nowrap pb-2 pr-4">Phone</th>
                      {showAddressColumns && <th className="pb-2 pr-4">Address</th>}
                      <th className="whitespace-nowrap pb-2 pr-4">City</th>
                      {showAddressColumns && (
                        <>
                          <th className="whitespace-nowrap pb-2 pr-4">State</th>
                          <th className="whitespace-nowrap pb-2 pr-4">Zip</th>
                        </>
                      )}
                      {showListColumn && <th className="whitespace-nowrap pb-2 pr-4">List</th>}
                      {editable && (
                        <th className="sticky right-0 z-10 whitespace-nowrap border-l border-border bg-background pb-2 pl-3">
                          <label className="flex items-center gap-1.5">
                            <input type="checkbox" checked={allChecked} onChange={(e) => toggleAll(e.target.checked)} />
                            {step.optOut ? "Remove all" : "Keep all"}
                          </label>
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((c) => (
                      <tr
                        key={c.id}
                        ref={(el) => {
                          if (el) rowRefs.set(c.id, el);
                          else rowRefs.delete(c.id);
                        }}
                        className={`border-t border-border ${c.id === leftOffId ? "bg-secondary/40" : ""}`}
                      >
                        {/* Sticky cells stay fully opaque (not the row's
                            bg-secondary/40 "left off" tint) on purpose —
                            they need a solid backing so the columns
                            scrolling underneath them don't show through. */}
                        <td
                          title={c.first_name || undefined}
                          className="sticky left-0 z-10 w-24 min-w-24 max-w-24 truncate bg-background py-2 pr-4"
                        >
                          {c.first_name}
                        </td>
                        <td
                          title={c.last_name || undefined}
                          className="sticky left-24 z-10 w-28 min-w-28 max-w-28 truncate border-r border-border bg-background py-2 pr-4"
                        >
                          {c.last_name}
                        </td>
                        <td className="py-2 pr-4">{c.email}</td>
                        <td className="whitespace-nowrap py-2 pr-4">{c.phone}</td>
                        {showAddressColumns && <td className="py-2 pr-4">{c.address}</td>}
                        <td className="whitespace-nowrap py-2 pr-4">{c.city}</td>
                        {showAddressColumns && (
                          <>
                            <td className="whitespace-nowrap py-2 pr-4">{c.state}</td>
                            <td className="whitespace-nowrap py-2 pr-4">{c.zip}</td>
                          </>
                        )}
                        {showListColumn && (
                          <td className="whitespace-nowrap py-2 pr-4">
                            <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              {LIST_LABELS[c.list_assignment ?? ""] ?? c.list_assignment}
                            </span>
                          </td>
                        )}
                        {editable && (
                          <td className="sticky right-0 z-10 border-l border-border bg-background py-2 pl-3">
                            <input
                              type="checkbox"
                              checked={c.flagged}
                              onChange={(e) => toggle(c.id, e.target.checked)}
                            />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filtered.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    {contacts.length === 0 ? "Nobody on this list." : "No matches for that search."}
                  </p>
                )}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

// Type of one entry in exportSoiList's `contacts` array (used by the
// needs_data_list / needs_data_download scopes) - pulled from exportSoiList's
// own return type instead of hand-duplicated, so this can never drift out of
// sync with what the server function actually returns.
type NeedsDataContact = NonNullable<Awaited<ReturnType<typeof exportSoiList>>["contacts"]>[number];

function FinalCombinedListStep({ clientId }: { clientId: string }) {
  const [view, setView] = useState<"summary" | "select">("summary");
  const [fullContactCount, setFullContactCount] = useState<number | null>(null);
  const [needsData, setNeedsData] = useState<NeedsDataContact[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectAllBusy, setSelectAllBusy] = useState(false);

  useEffect(() => {
    setView("summary");
    setLoading(true);
    setLoadError(null);
    Promise.all([
      getSoiListView({ data: { clientId, view: "final_full_contact" } }),
      exportSoiList({ data: { clientId, scope: "needs_data_list" } }),
    ])
      .then(([fullContact, needs]) => {
        setFullContactCount(fullContact.length);
        setNeedsData(needs.contacts ?? []);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [clientId]);

  async function downloadCsv(scope: string) {
    setDownloading(scope);
    try {
      const result = await exportSoiList({ data: { clientId, scope } });
      for (const [name, content] of Object.entries(result.files ?? {})) {
        const blob = new Blob([content], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
      }
    } finally {
      setDownloading(null);
    }
  }

  async function toggleSelected(contactId: string, next: boolean) {
    setNeedsData((cur) => (cur ? cur.map((c) => (c.id === contactId ? { ...c, already_selected: next } : c)) : cur));
    await setSoiReviewFlag({ data: { clientId, contactId, reviewType: "datazap_append", flagged: next } });
  }

  // Bulk version of toggleSelected, added 2026-10-12 per Mike's "select all
  // button" request on this screen — applies to whichever rows are
  // currently visible (so it respects the search box: searching first, then
  // "Select all" only checks off the filtered matches, not the whole list).
  // Only fires a setSoiReviewFlag call for rows that actually need to
  // change, same no-op-skipping care toggleSelected's callers already rely
  // on elsewhere in this file.
  async function toggleAllVisible(contacts: NeedsDataContact[], next: boolean) {
    const ids = new Set(contacts.map((c) => c.id));
    setNeedsData((cur) => (cur ? cur.map((c) => (ids.has(c.id) ? { ...c, already_selected: next } : c)) : cur));
    await Promise.all(
      contacts
        .filter((c) => c.already_selected !== next)
        .map((c) =>
          setSoiReviewFlag({ data: { clientId, contactId: c.id, reviewType: "datazap_append", flagged: next } }),
        ),
    );
  }

  if (loadError) {
    return (
      <Card className="mt-4">
        <p className="text-sm text-destructive">Couldn't load this list: {loadError}</p>
      </Card>
    );
  }

  if (loading || !needsData) {
    return (
      <Card className="mt-4">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </Card>
    );
  }

  if (view === "select") {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? needsData.filter((c) =>
          [c.first_name, c.last_name, c.email, c.phone].some((v) => (v ?? "").toLowerCase().includes(q)),
        )
      : needsData;
    const selectedCount = needsData.filter((c) => c.already_selected).length;
    // Drives the header button's label/behavior — respects the search box,
    // same as toggleAllVisible itself: with no search typed, "filtered" is
    // just everyone, so this is a plain select-all; with a search typed, it
    // only covers the visible matches.
    const allFilteredSelected = filtered.length > 0 && filtered.every((c) => c.already_selected);
    async function onSelectAllClick() {
      setSelectAllBusy(true);
      try {
        await toggleAllVisible(filtered, !allFilteredSelected);
      } finally {
        setSelectAllBusy(false);
      }
    }
    return (
      <div className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-semibold">Needs Data — select who to research</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Datazap charges per contact appended, so check off only the people worth paying to research.{" "}
              {selectedCount} selected.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setView("summary")}>
              ← Back
            </Button>
            <Button
              onClick={() => downloadCsv("needs_data_download")}
              disabled={downloading === "needs_data_download" || selectedCount === 0}
            >
              {downloading === "needs_data_download" ? "Preparing…" : "Download selected for Datazap"}
            </Button>
          </div>
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, email, or phone…"
          className="mt-4 w-full max-w-md rounded-2xl border border-border bg-background px-4 py-2.5 text-sm outline-none ring-ring transition focus:ring-2"
        />
        <Card className="mt-4">
          <div className="overflow-x-auto">
            {/* Same frozen-columns fix as the review table above (2026-09-25) —
                identical column layout, same scrolling complaint would apply. */}
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="sticky left-0 z-10 w-24 min-w-24 max-w-24 truncate bg-background pb-2 pr-4">
                    First name
                  </th>
                  <th className="sticky left-24 z-10 w-28 min-w-28 max-w-28 truncate border-r border-border bg-background pb-2 pr-4">
                    Last name
                  </th>
                  <th className="pb-2 pr-4">Email</th>
                  <th className="whitespace-nowrap pb-2 pr-4">Phone</th>
                  <th className="pb-2 pr-4">Address</th>
                  <th className="whitespace-nowrap pb-2 pr-4">City</th>
                  <th className="whitespace-nowrap pb-2 pr-4">State</th>
                  <th className="whitespace-nowrap pb-2 pr-4">Zip</th>
                  <th className="whitespace-nowrap pb-2 pr-4">Missing</th>
                  <th className="sticky right-0 z-10 whitespace-nowrap border-l border-border bg-background pb-2 pl-3">
                    {/* "Select all" button, added 2026-10-12 per Mike's
                        request on this exact screen — toggles every
                        currently-visible (filtered) row at once instead of
                        making someone click each checkbox by hand. Flips to
                        "Clear all" once everything visible is already
                        checked, so it's reversible with the same button. */}
                    <div className="flex items-center gap-2">
                      <span>Select</span>
                      <button
                        type="button"
                        onClick={onSelectAllClick}
                        disabled={selectAllBusy || filtered.length === 0}
                        className="text-xs font-medium normal-case text-primary underline-offset-2 transition-colors hover:underline disabled:opacity-60"
                      >
                        {selectAllBusy ? "Working…" : allFilteredSelected ? "Clear all" : "Select all"}
                      </button>
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id} className="border-t border-border">
                    <td
                      title={c.first_name || undefined}
                      className="sticky left-0 z-10 w-24 min-w-24 max-w-24 truncate bg-background py-2 pr-4"
                    >
                      {c.first_name}
                    </td>
                    <td
                      title={c.last_name || undefined}
                      className="sticky left-24 z-10 w-28 min-w-28 max-w-28 truncate border-r border-border bg-background py-2 pr-4"
                    >
                      {c.last_name}
                    </td>
                    <td className="py-2 pr-4">{c.email}</td>
                    <td className="whitespace-nowrap py-2 pr-4">{c.phone}</td>
                    <td className="py-2 pr-4">{c.address}</td>
                    <td className="whitespace-nowrap py-2 pr-4">{c.city}</td>
                    <td className="whitespace-nowrap py-2 pr-4">{c.state}</td>
                    <td className="whitespace-nowrap py-2 pr-4">{c.zip}</td>
                    <td className="py-2 pr-4">
                      <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {c.missing.join(", ") || "—"}
                      </span>
                    </td>
                    <td className="sticky right-0 z-10 border-l border-border bg-background py-2 pl-3">
                      <input
                        type="checkbox"
                        checked={c.already_selected}
                        onChange={(e) => toggleSelected(c.id, e.target.checked)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {needsData.length === 0 ? "Nobody needs more data." : "No matches for that search."}
              </p>
            )}
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="mt-4 grid gap-4 sm:grid-cols-2">
      <Card>
        <h2 className="font-display text-lg font-semibold">Full Contact</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Everyone who made it through review with a complete record — ready to use.
        </p>
        <p className="mt-3 font-display text-3xl font-bold">{fullContactCount ?? 0}</p>
        <div className="mt-4">
          <Button onClick={() => downloadCsv("final_full_contact")} disabled={downloading === "final_full_contact"}>
            {downloading === "final_full_contact" ? "Preparing…" : "Download"}
          </Button>
        </div>
      </Card>
      <Card>
        <h2 className="font-display text-lg font-semibold">Needs Data</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Survived review but missing at least one field. Datazap charges per contact appended, so pick exactly who's
          worth paying to research rather than sending everyone.
        </p>
        <p className="mt-3 font-display text-3xl font-bold">{needsData.length}</p>
        <div className="mt-4">
          <Button variant="secondary" onClick={() => setView("select")}>
            Review &amp; select →
          </Button>
        </div>
      </Card>
    </div>
  );
}

const EXPORT_SCOPES = [
  { scope: "complete", label: "Full Direct Mail + Email/Phone" },
  { scope: "email_list", label: "Email List" },
  { scope: "incomplete", label: "Incomplete" },
  { scope: "nonqualified", label: "Nonqualified" },
  { scope: "facebook_audience", label: "Facebook Audience" },
  { scope: "realtor_excluded", label: "Realtor Excluded" },
  { scope: "business_excluded", label: "Business Excluded" },
  { scope: "final_full_contact", label: "Final: Full Contact (ready to use)" },
] as const;

function ExportTab({ clientId }: { clientId: string }) {
  const [busyScope, setBusyScope] = useState<string | null>(null);

  async function handleExport(scope: string) {
    setBusyScope(scope);
    try {
      const result = await exportSoiList({ data: { clientId, scope } });
      for (const [name, content] of Object.entries(result.files ?? {})) {
        const blob = new Blob([content], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
      }
    } finally {
      setBusyScope(null);
    }
  }

  return (
    <Card>
      <h2 className="font-display text-lg font-semibold">Download lists</h2>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {EXPORT_SCOPES.map((s) => (
          <Button
            key={s.scope}
            variant="secondary"
            onClick={() => handleExport(s.scope)}
            disabled={busyScope === s.scope}
          >
            {busyScope === s.scope ? "Preparing…" : s.label}
          </Button>
        ))}
      </div>
    </Card>
  );
}
