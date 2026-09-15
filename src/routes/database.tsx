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
const REVIEW_LISTS = ["direct_mail", "email_phone", "email_list", "incomplete"] as const;
const OPT_OUT_LISTS = new Set(["direct_mail", "email_phone"]);

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
            {t === "upload" ? "Upload" : t === "hub" ? "Hub" : t === "review" ? "Review" : "Export"}
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
  const [pendingFile, setPendingFile] = useState<File | null>(null);
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

  async function handleFilePicked(file: File) {
    setPendingFile(file);
    setError(null);
    if (!file.name.toLowerCase().endsWith(".vcf")) {
      const text = await file.text();
      setCsvPreview(parseCsv(text));
    } else {
      setCsvPreview(null);
    }
    if (!sourceLabel) setSourceLabel(file.name.replace(/\.[^.]+$/, ""));
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
      setPendingFile(null);
      setCsvPreview(null);
      setMapping({});
      await refresh();
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
        <p className="mt-1 text-sm text-muted-foreground">CSV export from your CRM, or a .vcf contacts export.</p>
        <input
          type="file"
          accept=".csv,.vcf"
          onChange={(e) => e.target.files?.[0] && handleFilePicked(e.target.files[0])}
          className="mt-4 block w-full text-sm"
        />
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
                <p className="text-sm text-muted-foreground">Map columns:</p>
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
              {busy ? "Uploading…" : "Upload file"}
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

function ReviewTab({ clientId }: { clientId: string }) {
  const [list, setList] = useState<(typeof REVIEW_LISTS)[number]>("direct_mail");
  const [contacts, setContacts] = useState<
    Array<{
      id: string;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      phone: string | null;
      flagged: boolean;
    }>
  >([]);
  const [loading, setLoading] = useState(true);
  const optOut = OPT_OUT_LISTS.has(list);

  useEffect(() => {
    setLoading(true);
    getSoiReviewCandidates({ data: { clientId, listAssignment: list } })
      .then((rows) => setContacts(rows))
      .finally(() => setLoading(false));
  }, [clientId, list]);

  async function toggle(contactId: string, next: boolean) {
    setContacts((cs) => cs.map((c) => (c.id === contactId ? { ...c, flagged: next } : c)));
    await setSoiReviewFlag({ data: { clientId, contactId, reviewType: "primary", flagged: next } });
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {REVIEW_LISTS.map((l) => (
          <button
            key={l}
            onClick={() => setList(l)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              list === l ? "bg-secondary" : "border border-border hover:bg-secondary/50"
            }`}
          >
            {LIST_LABELS[l]}
          </button>
        ))}
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        {optOut
          ? "Check anyone you don't recognize to remove them from this list."
          : "Check anyone you do recognize to keep them on this list."}
      </p>
      <Card className="mt-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="pb-2">Name</th>
                  <th className="pb-2">Email</th>
                  <th className="pb-2">Phone</th>
                  <th className="pb-2">{optOut ? "Remove" : "Keep"}</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((c) => (
                  <tr key={c.id} className="border-t border-border">
                    <td className="py-2">
                      {c.first_name} {c.last_name}
                    </td>
                    <td className="py-2">{c.email}</td>
                    <td className="py-2">{c.phone}</td>
                    <td className="py-2">
                      <input type="checkbox" checked={c.flagged} onChange={(e) => toggle(c.id, e.target.checked)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {contacts.length === 0 && <p className="text-sm text-muted-foreground">Nobody on this list.</p>}
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
