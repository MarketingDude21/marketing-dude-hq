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
  processSoiUploads,
  getSoiHubCounts,
  getSoiReviewCandidates,
  getSoiListView,
  setSoiReviewFlag,
  exportSoiList,
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
  direct_mail: "Direct Mail",
  email_phone: "Email + Phone",
  email_list: "Email List",
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
      <Workspace clientId={selected.id} />
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

function Workspace({ clientId }: { clientId: string }) {
  const [tab, setTab] = useState<"upload" | "hub" | "review" | "export">("upload");
  return (
    <div className="mt-5">
      <div className="flex flex-wrap gap-1 rounded-full border border-border bg-glass p-1 backdrop-blur-xl w-fit">
        {(["upload", "hub", "review", "export"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === t ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t === "upload" ? "Upload" : t === "hub" ? "Database Breakdown" : t === "review" ? "Review" : "Export"}
          </button>
        ))}
      </div>
      <div className="mt-5">
        {tab === "upload" && <UploadTab clientId={clientId} onProcessed={() => setTab("hub")} />}
        {tab === "hub" && <HubTab clientId={clientId} />}
        {tab === "review" && <ReviewTab clientId={clientId} />}
        {tab === "export" && <ExportTab clientId={clientId} />}
      </div>
    </div>
  );
}

function UploadTab({ clientId, onProcessed }: { clientId: string; onProcessed: () => void }) {
  const [uploads, setUploads] = useState<
    Array<{ id: string; file_name: string; source_label: string; status: string }>
  >([]);
  // Files picked but not yet uploaded, in order. The one being mapped/
  // uploaded right now is always the front of this queue — selecting
  // several files at once (or dragging a batch in) queues all of them so
  // the person doesn't have to reopen the file picker between each one.
  const [fileQueue, setFileQueue] = useState<File[]>([]);
  const pendingFile = fileQueue[0] ?? null;
  const [sourceLabel, setSourceLabel] = useState("");
  const [csvPreview, setCsvPreview] = useState<{ headers: string[]; rows: Record<string, string>[] } | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [processResult, setProcessResult] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => listSoiUploads({ data: { clientId } }).then(setUploads);
  useEffect(() => {
    refresh();
  }, [clientId]);

  const isVcf = pendingFile?.name.toLowerCase().endsWith(".vcf");
  // Formats SheetJS can read directly, browser-side, with no server round trip.
  const SPREADSHEET_EXTENSIONS = [".xlsx", ".xls", ".xlsm", ".xlsb", ".ods", ".tsv"];

  async function parseAndStage(file: File) {
    setError(null);
    setMapping({});
    const lowerName = file.name.toLowerCase();
    let preview: { headers: string[]; rows: Record<string, string>[] } | null = null;
    if (lowerName.endsWith(".vcf")) {
      preview = null;
    } else if (lowerName.endsWith(".numbers")) {
      // Apple's .numbers format is a proprietary bundle, not a spreadsheet
      // format any browser-side library can parse — there's no safe way to
      // read this directly. Numbers itself exports to CSV/Excel in one click.
      setError(
        "Apple Numbers files (.numbers) can't be read directly. In Numbers, use File > Export To > CSV (or Excel), then upload that file instead.",
      );
    } else if (SPREADSHEET_EXTENSIONS.some((ext) => lowerName.endsWith(ext))) {
      try {
        preview = await parseSpreadsheet(file);
      } catch {
        setError("Couldn't read that file. Try re-saving/exporting it as a .csv and uploading that instead.");
      }
    } else {
      const text = await file.text();
      preview = parseCsv(text);
    }
    setCsvPreview(preview);
    // Pre-fill the mapping from recognizable column headers so a normal
    // export doesn't require mapping every field by hand — see
    // guessColumnMapping's comment above for what counts as "recognizable."
    if (preview) setMapping(guessColumnMapping(preview.headers));
    setSourceLabel(file.name.replace(/\.[^.]+$/, ""));
  }

  async function handleFilesPicked(files: File[]) {
    if (files.length === 0) return;
    // A fresh selection replaces whatever was queued before — picking again
    // is treated as "here's my batch," not "add to the old one."
    setFileQueue(files);
    const first = files[0];
    if (first) await parseAndStage(first);
  }

  async function handleUpload() {
    if (!pendingFile) return;
    setBusy(true);
    setError(null);
    try {
      if (isVcf) {
        const content = await fileToBase64(pendingFile);
        await uploadSoiFile({
          data: {
            clientId,
            fileName: pendingFile.name,
            sourceLabel: sourceLabel || pendingFile.name,
            kind: "vcf",
            content,
          },
        });
      } else {
        if (!csvPreview) throw new Error("No file parsed yet");
        await uploadSoiFile({
          data: {
            clientId,
            fileName: pendingFile.name,
            sourceLabel: sourceLabel || pendingFile.name,
            kind: "mapped_csv",
            content: JSON.stringify({ mapping, rows: csvPreview.rows }),
          },
        });
      }
      await refresh();
      // Move on to the next queued file automatically, so a multi-file
      // batch doesn't require reopening the picker between each one — only
      // the mapping step (which can genuinely differ file to file) still
      // needs a look before each individual upload.
      const rest = fileQueue.slice(1);
      setFileQueue(rest);
      setCsvPreview(null);
      setMapping({});
      const next = rest[0];
      if (next) {
        await parseAndStage(next);
      } else {
        setSourceLabel("");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleProcess() {
    setBusy(true);
    setError(null);
    try {
      const result = await processSoiUploads({ data: { clientId } });
      setProcessResult(result.list_counts);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
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
            {pendingFile ? pendingFile.name : "Drop one or more files here, or click to browse."}
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
        {fileQueue.length > 1 && (
          <p className="mt-2 text-xs text-muted-foreground">
            File 1 of {fileQueue.length} in this batch — the rest will come up automatically after you upload this one.
          </p>
        )}
        {pendingFile && (
          <div className="mt-4 space-y-3">
            <label className="block text-sm">
              <span className="text-muted-foreground">Source label</span>
              <input
                value={sourceLabel}
                onChange={(e) => setSourceLabel(e.target.value)}
                className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
                placeholder="e.g. WiseAgent, Gmail, iPhone"
              />
            </label>
            {csvPreview && (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  We matched your columns automatically below — just check them over and fix anything that's wrong
                  before uploading. (This only tells us which column is which; sorting contacts into lists happens
                  after, when you click Process.)
                </p>
                {MAPPING_FIELDS.map((f) => (
                  <label key={f.key} className="flex items-center justify-between gap-2 text-sm">
                    <span>{f.label}</span>
                    <select
                      value={mapping[f.key] ?? ""}
                      onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value }))}
                      className="rounded-lg border border-border bg-background px-2 py-1 text-sm"
                    >
                      <option value="">— none —</option>
                      {csvPreview.headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            )}
            <Button onClick={handleUpload} disabled={busy}>
              {busy ? "Uploading…" : fileQueue.length > 1 ? `Upload file (1 of ${fileQueue.length})` : "Upload file"}
            </Button>
          </div>
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
            {busy ? "Processing…" : "Process all uploads"}
          </Button>
          {processResult && (
            <div className="mt-3 text-sm text-muted-foreground">
              {HUB_ORDER.map((k) => (
                <div key={k}>
                  {LIST_LABELS[k]}: {processResult[k] ?? 0}
                </div>
              ))}
              <button onClick={onProcessed} className="mt-2 text-sm font-medium text-primary hover:underline">
                Go to Hub →
              </button>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

function HubTab({ clientId }: { clientId: string }) {
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    getSoiHubCounts({ data: { clientId } }).then(setCounts);
  }, [clientId]);

  if (!counts) return <Card>Loading…</Card>;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {HUB_ORDER.map((k) => (
        <Card key={k}>
          <p className="text-sm text-muted-foreground">{LIST_LABELS[k]}</p>
          <p className="mt-1 font-display text-3xl font-bold">{counts[k] ?? 0}</p>
        </Card>
      ))}
    </div>
  );
}

type ReviewContact = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  list_assignment: string | null;
  flagged: boolean;
};

function positionKey(clientId: string, stepKey: string): string {
  return `soi-review-position:${clientId}:${stepKey}`;
}

function ReviewTab({ clientId }: { clientId: string }) {
  const [stepKey, setStepKey] = useState<(typeof REVIEW_STEPS)[number]["key"]>("complete");
  const step = REVIEW_STEPS.find((s) => s.key === stepKey) ?? REVIEW_STEPS[0];
  const editable = step.kind === "review";
  const [contacts, setContacts] = useState<ReviewContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [leftOffId, setLeftOffId] = useState<string | null>(null);
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  const rowRefs = useMemo(() => new Map<string, HTMLTableRowElement>(), []);

  useEffect(() => {
    setLoading(true);
    setSearch("");
    setJumpTo(null);
    const request =
      step.kind === "review"
        ? Promise.all(step.lists.map((l) => getSoiReviewCandidates({ data: { clientId, listAssignment: l } })))
        : getSoiListView({ data: { clientId, view: step.key } }).then((rows) => [
            rows.map((r) => ({ ...r, flagged: false })),
          ]);
    request.then((results) => setContacts(results.flat())).finally(() => setLoading(false));

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
  }

  async function toggleAll(next: boolean) {
    const ids = filtered.map((c) => c.id);
    setContacts((cs) => cs.map((c) => (ids.includes(c.id) ? { ...c, flagged: next } : c)));
    await Promise.all(
      ids.map((id) => setSoiReviewFlag({ data: { clientId, contactId: id, reviewType: "primary", flagged: next } })),
    );
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
  const leftOffContact = leftOffId ? contacts.find((c) => c.id === leftOffId) : undefined;

  useEffect(() => {
    if (!jumpTo) return;
    const row = rowRefs.get(jumpTo);
    if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
    setJumpTo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo]);

  return (
    <div>
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
      <p className="mt-3 text-sm text-muted-foreground">
        {contacts.length} contact{contacts.length === 1 ? "" : "s"} on this list. {step.description}
      </p>

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
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="pb-2">First name</th>
                  <th className="pb-2">Last name</th>
                  <th className="pb-2">Email</th>
                  <th className="pb-2">Phone</th>
                  <th className="pb-2">City</th>
                  {showListColumn && <th className="pb-2">List</th>}
                  {editable && (
                    <th className="pb-2">
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
                    <td className="py-2">{c.first_name}</td>
                    <td className="py-2">{c.last_name}</td>
                    <td className="py-2">{c.email}</td>
                    <td className="py-2">{c.phone}</td>
                    <td className="py-2">{c.city}</td>
                    {showListColumn && (
                      <td className="py-2">
                        <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {LIST_LABELS[c.list_assignment ?? ""] ?? c.list_assignment}
                        </span>
                      </td>
                    )}
                    {editable && (
                      <td className="py-2">
                        <input type="checkbox" checked={c.flagged} onChange={(e) => toggle(c.id, e.target.checked)} />
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
    </div>
  );
}

const EXPORT_SCOPES = [
  { scope: "complete", label: "Direct Mail + Email/Phone" },
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
