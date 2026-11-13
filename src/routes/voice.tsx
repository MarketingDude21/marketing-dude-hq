import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
// Loaded lazily inside handleContentStrategyFile (.docx/.pdf extraction is
// rare enough, and pdfjs-dist in particular is large enough, that neither
// belongs in the main bundle) — this top-level import is just a resolved
// asset URL string for pdf.js's worker file, not the worker code itself, so
// it's cheap to keep static. Its version MUST match pdfjs-dist's own
// version exactly (pdfjs-dist enforces this at runtime), which importing it
// from the same package guarantees.
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { AppShell } from "@/components/AppShell";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import {
  VOICE_DNA_QUESTIONS,
  generateVoiceDnaProfile,
  getAgentVoiceProfile,
  saveAgentVoiceProfile,
  createBrandAssetUploadUrl,
  finalizeBrandAssetUpload,
  saveAgentBusinessInfo,
  saveContentBrandingStrategy,
  saveAgentSocialHandles,
  generateBrandBios,
  scanAgentWebsite,
  generateBrandGraphicAI,
  type VoiceDnaAnswer,
  type VoiceDnaAnswers,
  type AgentBusinessInfo,
  type AgentSocialHandles,
  type BrandBioResult,
  type BrandBioTone,
  type WebsiteScan,
  type BrandGraphicTemplate,
} from "@/lib/voice-dna";
// Reused from Monthly Marketing (2026-09-28) — same admin_allowlist +
// agents identity model, so "who am I working on behalf of" is resolved the
// exact same way here as it already is there, instead of a second copy of
// that logic. See the "Build My Brand — admin act as agent" comment block
// in voice-dna.ts for the full story on why this page needed it.
import { getMarketingAccess, listMarketingAgents, type MarketingAccess } from "@/lib/marketing";

export const Route = createFileRoute("/voice")({
  head: () => ({
    meta: [
      { title: "My Voice DNA — Your Marketing Dude" },
      {
        name: "description",
        content: "Build the Voice DNA profile that powers every post written in your voice.",
      },
      { property: "og:title", content: "My Voice DNA — Your Marketing Dude" },
      {
        property: "og:description",
        content: "Answer 16 questions once; every post sounds like you from then on.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: VoicePage,
});

type Stage = "loading" | "intro" | "basics" | "interview" | "areas" | "generating" | "done";

type Basics = { fullName: string; marketArea: string; phone: string };
const EMPTY_BASICS: Basics = { fullName: "", marketArea: "", phone: "" };
const EMPTY_BUSINESS_INFO: AgentBusinessInfo = { website: "", licenseNumber: "", email: "", officeAddress: "" };
const EMPTY_SOCIAL_HANDLES: AgentSocialHandles = {
  instagram: "",
  facebook: "",
  linkedin: "",
  youtube: "",
  tiktok: "",
  zillow: "",
  trulia: "",
};

function emptyAnswers(): string[] {
  return new Array(VOICE_DNA_QUESTIONS.length).fill("");
}

// Branding Graphics v2 — real AI image generation (2026-11-13). The first
// version of this drew shapes on a <canvas> by hand (a circle, a gradient,
// some text). Off Mike's reaction to that — "worst cover photo ever I
// literally gave you examples... use all your resources... pretend you
// are [a graphic designer]" — this now calls an actual text-to-image model
// (OpenAI's gpt-image-1, the same model behind image generation in
// ChatGPT) server-side, with a real art-directed prompt and the agent's
// headshot/logo/scanned website photo as reference images — see
// generateBrandGraphicAI and buildBrandGraphicPrompt in voice-dna.ts for
// the actual design work. All that's left client-side is the 2 tiny
// helpers below: loading an image, and cropping it (never stretching) to
// fill a target box — reused to turn the single AI-generated "master"
// image into the exact YouTube banner and Facebook cover pixel dimensions
// without a second (paid) API call per format.
type BrandGraphicFormat = "youtube" | "facebook";

const BRAND_GRAPHIC_SIZES: Record<BrandGraphicFormat, { width: number; height: number; fileSuffix: string }> = {
  youtube: { width: 2560, height: 1440, fileSuffix: "YouTube-Banner" },
  facebook: { width: 820, height: 312, fileSuffix: "Facebook-Cover" },
};

function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  return new Promise((resolve, reject) => {
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't load one of your brand images."));
    img.src = url;
  });
}

// Draws `img` into the x/y/w/h box, cropping (never stretching) to fill it —
// the canvas equivalent of CSS `object-fit: cover`.
function drawImageCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const imgRatio = img.naturalWidth / img.naturalHeight;
  const boxRatio = w / h;
  let sx = 0;
  let sy = 0;
  let sw = img.naturalWidth;
  let sh = img.naturalHeight;
  if (imgRatio > boxRatio) {
    sw = img.naturalHeight * boxRatio;
    sx = (img.naturalWidth - sw) / 2;
  } else {
    sh = img.naturalWidth / boxRatio;
    sy = (img.naturalHeight - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

// Crops the AI-generated master image (a fixed 1536x1024 landscape — see
// generateBrandGraphicAI) into one platform's exact final dimensions.
async function cropMasterGraphic(masterUrl: string, format: BrandGraphicFormat): Promise<Blob> {
  const { width, height } = BRAND_GRAPHIC_SIZES[format];
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't prepare this graphic.");
  const master = await loadImage(masterUrl);
  drawImageCover(ctx, master, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Couldn't render this graphic.");
  return blob;
}

const GENERATING_MESSAGES = [
  "Reading your personality...",
  "Finding your real voice...",
  "Pulling what makes you different...",
  "Writing your Voice DNA...",
];

// Minimal ambient typing for the Web Speech API — it isn't in lib.dom.d.ts.
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: any) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: any) => void) | null;
  start: () => void;
  abort: () => void;
};

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

function isIOSDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

type AgentOption = { id: string; name: string; email: string | null };

// FIXED (2026-09-28) — per Mike: he was working on client "John Miller" in
// Build My Database, clicked Build My Brand, and it showed HIS OWN
// (mike@yourmarketingdude.com's) Voice DNA profile instead — "whoever the
// admin is logged in at, that's what should appear under the build my
// brand section, unless they're logged in as themselves." Root cause: this
// page always read/wrote the signed-in user's own `agents` row directly
// (RLS-scoped to auth.uid()), with no concept of "acting as" anyone else.
// Fixed the same way Monthly Marketing already solved this exact problem —
// an admin picks which agent to work on behalf of, then everything below
// operates on THAT agent's id, via server functions that check access
// explicitly rather than relying on browser-side RLS (which can only ever
// see the signed-in user's own row). See voice-dna.ts for the new
// agent-scoped server functions this now calls.
function VoicePage() {
  const { user, loading: authLoading } = useAuth();
  const [access, setAccess] = useState<MarketingAccess | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [selected, setSelected] = useState<AgentOption | null>(null);

  useEffect(() => {
    if (!user) return;
    getMarketingAccess()
      .then(async (a) => {
        setAccess(a);
        if (a.role === "admin") {
          const list = await listMarketingAgents();
          setAgents(
            list.map((ag) => ({
              id: ag.id,
              name: ag.full_name ?? ag.email ?? "Unnamed agent",
              email: ag.email ?? null,
            })),
          );
        } else if (a.role === "agent") {
          setSelected({ id: a.agentId, name: a.agentName, email: null });
        }
      })
      .catch((e) => setAccessError(e instanceof Error ? e.message : String(e)));
  }, [user]);

  if (!authLoading && !user) {
    return (
      <AppShell>
        <div className="mt-16 rounded-3xl border border-border bg-glass p-8 text-center backdrop-blur-2xl">
          <h1 className="font-display text-2xl font-bold">Sign in to build your Voice DNA</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Your Voice DNA profile powers every post written in your voice.
          </p>
          <Link
            to="/login"
            className="mt-6 inline-block rounded-2xl bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30"
          >
            Go to sign in
          </Link>
        </div>
      </AppShell>
    );
  }

  if (accessError) {
    return (
      <AppShell>
        <div className="mt-16 text-center text-sm text-destructive">{accessError}</div>
      </AppShell>
    );
  }

  if (!access) {
    return (
      <AppShell>
        <div className="mt-16 text-center text-sm text-muted-foreground">Loading…</div>
      </AppShell>
    );
  }

  if (access.role === "none") {
    return (
      <AppShell>
        <div className="mt-16 rounded-3xl border border-border bg-glass p-8 text-center backdrop-blur-2xl">
          <h1 className="font-display text-xl font-bold">Not set up yet</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Your account isn't set up in Build My Brand yet. Ask your team to add you as an agent.
          </p>
        </div>
      </AppShell>
    );
  }

  if (access.role === "admin" && !selected) {
    return (
      <AppShell>
        <div className="mx-auto max-w-2xl pt-2">
          <div className="rounded-3xl border border-border bg-glass p-6 backdrop-blur-2xl">
            <h2 className="font-display text-lg font-semibold">Choose an agent</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Pick who you're working on behalf of. Their interview answers, Voice DNA profile, and brand assets are all
              scoped to this choice — not your own account.
            </p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {agents.map((a) => (
                <button
                  key={a.id}
                  onClick={() => setSelected(a)}
                  className="rounded-2xl border border-border bg-glass px-4 py-3 text-left text-sm font-medium transition-colors hover:bg-secondary"
                >
                  {a.name}
                  {a.email && <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{a.email}</span>}
                </button>
              ))}
              {agents.length === 0 && <p className="text-sm text-muted-foreground">No agents yet.</p>}
            </div>
          </div>
        </div>
      </AppShell>
    );
  }

  if (!selected) return null;

  return (
    <VoiceWorkspace
      agentId={selected.id}
      agentName={selected.name}
      isAdmin={access.role === "admin"}
      onChangeAgent={access.role === "admin" ? () => setSelected(null) : undefined}
    />
  );
}

function VoiceWorkspace({
  agentId,
  agentName,
  isAdmin,
  onChangeAgent,
}: {
  agentId: string;
  agentName: string;
  isAdmin: boolean;
  onChangeAgent?: (() => void) | undefined;
}) {
  const [stage, setStage] = useState<Stage>("loading");
  const [basics, setBasics] = useState<Basics>(EMPTY_BASICS);
  const [serviceAreas, setServiceAreas] = useState("");
  const [answers, setAnswers] = useState<string[]>(emptyAnswers());
  const [currentQuestion, setCurrentQuestion] = useState(0);
  const [requireAnswer, setRequireAnswer] = useState(false);

  const [profile, setProfile] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [genMessage, setGenMessage] = useState(GENERATING_MESSAGES[0]);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [micSupported] = useState<boolean>(() => Boolean(getSpeechRecognitionCtor()));
  const [micListening, setMicListening] = useState(false);
  const [micLabel, setMicLabel] = useState("Tap mic and speak your answer");
  const recogRef = useRef<SpeechRecognitionLike | null>(null);
  const userStoppedMicRef = useRef(false);
  const micDeniedRef = useRef(false);

  // Brand assets (2026-09-28) — headshot + logo, live independent of
  // interview stage so they can be uploaded/replaced any time.
  const [headshotUrl, setHeadshotUrl] = useState<string | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [uploadingKind, setUploadingKind] = useState<"headshot" | "logo" | null>(null);
  const [brandAssetError, setBrandAssetError] = useState<string | null>(null);

  // Business Info — phone/website/license/email/office address (2026-10-22),
  // per Mike: "beneath the headshot logo section, we should put in the rest
  // of their information." Live independent of interview stage, same as
  // the brand assets above — saved with their own button, not gated behind
  // finishing the 16-question interview. Phone reuses `basics.phone` above
  // rather than a second copy of it (see handleSaveBusinessInfo below).
  const [businessInfo, setBusinessInfo] = useState<AgentBusinessInfo>(EMPTY_BUSINESS_INFO);
  const [businessInfoSaving, setBusinessInfoSaving] = useState(false);
  const [businessInfoStatus, setBusinessInfoStatus] = useState<string | null>(null);

  // Content Branding Strategy (2026-10-22) — per Mike: "a document that I
  // can upload inside of here that'll also play into their voice DNA
  // profile." Also live independent of interview stage. See
  // handleContentStrategyFile below for why this only auto-reads plain
  // text files, not Word/PDF.
  const [contentStrategy, setContentStrategy] = useState("");
  const [contentStrategySaving, setContentStrategySaving] = useState(false);
  const [contentStrategyStatus, setContentStrategyStatus] = useState<string | null>(null);

  // Social Media Handles (2026-11-13) — per Mike: "we should also plug in
  // their social media handles." Same live-independent-of-interview-stage
  // pattern as Business Info above; the only thing that actually reads
  // these is the Brand Bio Writer below.
  const [socialHandles, setSocialHandles] = useState<AgentSocialHandles>(EMPTY_SOCIAL_HANDLES);
  const [socialHandlesSaving, setSocialHandlesSaving] = useState(false);
  const [socialHandlesStatus, setSocialHandlesStatus] = useState<string | null>(null);

  // Scan My Website (2026-11-13) — per Mike, right after the above shipped:
  // "you should be able to scan their website and create content too, to
  // grab other images etc if need be, but the only thing you should need
  // is headshot and logo." Purely additive: nothing below requires this —
  // bios still generate and graphics still render from just headshot+logo
  // if this is never run. See scanAgentWebsite in voice-dna.ts.
  const [websiteScan, setWebsiteScan] = useState<WebsiteScan | null>(null);
  const [scanningWebsite, setScanningWebsite] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  // Brand Bio Writer (2026-11-13) — per Mike: "we need to create a
  // done-for-you bio section... rate it by professional, personable,
  // funny, relatable." See generateBrandBios in voice-dna.ts for what
  // actually gets sent and why this doesn't try to scrape the agent's
  // actual social profiles.
  const [bioTone, setBioTone] = useState<BrandBioTone>("personable");
  const [bioExtraNotes, setBioExtraNotes] = useState("");
  const [bioGenerating, setBioGenerating] = useState(false);
  const [bioError, setBioError] = useState<string | null>(null);
  const [bioResult, setBioResult] = useState<BrandBioResult | null>(null);
  const [bioCopiedKey, setBioCopiedKey] = useState<string | null>(null);

  // Branding Graphics (2026-11-13) — per Mike: "take the headshot they
  // uploaded and the logo and be able to create really nice-looking
  // YouTube headers, Facebook covers... a couple different versions."
  // Entirely client-side (see renderBrandGraphic below) — no server
  // function, no new storage, same canvas-compositing idea marketing.tsx's
  // photo text-overlay tool already uses, just drawing a banner layout
  // instead of overlaid text.
  const [graphicTemplate, setGraphicTemplate] = useState<BrandGraphicTemplate>("bold-split");
  const [graphicTagline, setGraphicTagline] = useState<string | null>(null);
  const [graphicGenerating, setGraphicGenerating] = useState(false);
  const [graphicError, setGraphicError] = useState<string | null>(null);
  const [graphicPreviews, setGraphicPreviews] = useState<Partial<Record<BrandGraphicFormat, string>>>({});
  // "None" (pure gradient, headshot + logo only — Mike's "only thing you
  // should need") is the default; a scanned website photo is opt-in.
  const [selectedBackgroundImage, setSelectedBackgroundImage] = useState<string | null>(null);

  // Generate My Branding Kit (2026-11-13) — one-click orchestrator over the
  // 3 pieces above; see handleGenerateBrandKit.
  const [kitGenerating, setKitGenerating] = useState(false);
  const [kitStatus, setKitStatus] = useState<string | null>(null);

  // Load whatever profile already exists for the agent we're working on —
  // via the access-checked server function (see voice-dna.ts), not a direct
  // browser Supabase read, since that read used to be RLS-scoped to
  // auth.uid() and could only ever see the SIGNED-IN user's own row. That's
  // exactly the bug Mike reported: an admin acting on behalf of another
  // agent still only ever saw their own profile.
  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    setStage("loading");
    getAgentVoiceProfile({ data: { agentId } })
      .then((data) => {
        if (cancelled) return;
        if (data) {
          setBasics({
            fullName: data.full_name ?? "",
            marketArea: data.market_area ?? "",
            phone: data.phone ?? "",
          });
          setHeadshotUrl(data.headshot_url);
          setLogoUrl(data.logo_url);
          const stored = data.voice_answers;
          setBusinessInfo(stored?.businessInfo ?? EMPTY_BUSINESS_INFO);
          setContentStrategy(stored?.contentBrandingStrategy ?? "");
          setSocialHandles(stored?.socialHandles ?? EMPTY_SOCIAL_HANDLES);
          setWebsiteScan(stored?.websiteScan ?? null);
          setGraphicTagline(data.market_area ? `Real Estate Agent — ${data.market_area}` : "Real Estate Agent");
          if (stored?.answers?.length) {
            const restored = emptyAnswers();
            stored.answers.forEach((a, i) => {
              if (i < restored.length) restored[i] = a.answer ?? "";
            });
            setAnswers(restored);
          }
          if (stored?.serviceAreas) setServiceAreas(stored.serviceAreas);
          if (data.voice_summary) {
            setProfile(data.voice_summary);
            setStage("done");
            return;
          }
        }
        setStage("intro");
      })
      .catch(() => {
        if (!cancelled) setStage("intro");
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  async function uploadBrandAsset(file: File, kind: "headshot" | "logo") {
    setBrandAssetError(null);
    setUploadingKind(kind);
    try {
      const { path, token } = await createBrandAssetUploadUrl({ data: { agentId, fileName: file.name, kind } });
      const { error: uploadErr } = await supabase.storage.from("media").uploadToSignedUrl(path, token, file);
      if (uploadErr) throw uploadErr;
      const result = await finalizeBrandAssetUpload({ data: { agentId, storagePath: path, kind } });
      if (kind === "headshot") setHeadshotUrl(result.url);
      else setLogoUrl(result.url);
    } catch (e) {
      setBrandAssetError(e instanceof Error ? e.message : "Couldn't upload that file.");
    } finally {
      setUploadingKind(null);
    }
  }

  async function handleSaveBusinessInfo() {
    setBusinessInfoSaving(true);
    setBusinessInfoStatus(null);
    try {
      const result = await saveAgentBusinessInfo({
        data: {
          agentId,
          phone: basics.phone,
          website: businessInfo.website,
          licenseNumber: businessInfo.licenseNumber,
          email: businessInfo.email,
          officeAddress: businessInfo.officeAddress,
        },
      });
      setBusinessInfoStatus(result.ok ? "Saved." : `Could not save: ${result.error}`);
    } catch (e) {
      setBusinessInfoStatus(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusinessInfoSaving(false);
    }
  }

  async function handleSaveContentStrategy() {
    setContentStrategySaving(true);
    setContentStrategyStatus(null);
    try {
      const result = await saveContentBrandingStrategy({ data: { agentId, text: contentStrategy } });
      setContentStrategyStatus(result.ok ? "Saved." : `Could not save: ${result.error}`);
    } catch (e) {
      setContentStrategyStatus(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setContentStrategySaving(false);
    }
  }

  async function handleSaveSocialHandles() {
    setSocialHandlesSaving(true);
    setSocialHandlesStatus(null);
    try {
      const result = await saveAgentSocialHandles({ data: { agentId, ...socialHandles } });
      setSocialHandlesStatus(result.ok ? "Saved." : `Could not save: ${result.error}`);
    } catch (e) {
      setSocialHandlesStatus(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setSocialHandlesSaving(false);
    }
  }

  // Returns the fresh scan (or null on failure) rather than just updating
  // state — handleGenerateBrandKit below chains this straight into
  // handleGenerateGraphics within the same function call, and React state
  // set here wouldn't actually be visible yet to code running later in
  // that same synchronous call (a setState doesn't re-render mid-function).
  async function handleScanWebsite(): Promise<WebsiteScan | null> {
    if (!businessInfo.website.trim()) {
      setScanError("Add a website in Business Info above and save it first.");
      return null;
    }
    setScanningWebsite(true);
    setScanError(null);
    try {
      const result = await scanAgentWebsite({ data: { agentId } });
      if (!result.ok) {
        setScanError(result.error);
        return null;
      }
      const { ok: _ok, ...scan } = result;
      setWebsiteScan(scan);
      // Default to the first found photo as the graphics background —
      // agent can still pick "None" below to go back to headshot+logo only.
      if (scan.images[0]) setSelectedBackgroundImage(scan.images[0]);
      return scan;
    } catch (e) {
      setScanError(e instanceof Error ? e.message : "Something went wrong scanning that site.");
      return null;
    } finally {
      setScanningWebsite(false);
    }
  }

  async function handleGenerateBios() {
    setBioGenerating(true);
    setBioError(null);
    try {
      const result = await generateBrandBios({ data: { agentId, tone: bioTone, extraNotes: bioExtraNotes } });
      setBioResult(result);
    } catch (e) {
      setBioError(e instanceof Error ? e.message : "Something went wrong generating these bios.");
    } finally {
      setBioGenerating(false);
    }
  }

  function copyBioText(key: string, text: string) {
    if (!text) return;
    const done = () => {
      setBioCopiedKey(key);
      setTimeout(() => setBioCopiedKey((cur) => (cur === key ? null : cur)), 2500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(done)
        .catch(() => {});
    }
  }

  // overrideBackground lets handleGenerateBrandKit below pass a
  // just-scanned background photo straight through, bypassing the same
  // stale-closure gap described above handleScanWebsite — normal clicks of
  // the "Generate graphics" button pass nothing and just use current
  // state. Brand color doesn't need the same treatment: generateBrandGraphicAI
  // reads it itself, fresh, straight from the agent's row server-side, and
  // by the time this runs (after handleScanWebsite's own write) that row
  // already has whatever this same click just scanned.
  async function handleGenerateGraphics(overrideBackground?: string | null) {
    if (!headshotUrl) {
      setGraphicError("Upload a headshot above first — these are built from it.");
      return;
    }
    setGraphicGenerating(true);
    setGraphicError(null);
    try {
      const tagline = (graphicTagline ?? "Real Estate Agent").trim() || "Real Estate Agent";
      const backgroundImageUrl = overrideBackground !== undefined ? overrideBackground : selectedBackgroundImage;
      // One generation call (the expensive, paid part) produces a single
      // landscape "master" image; both platform sizes are then just a free
      // client-side crop of that same image — see cropMasterGraphic above.
      const { imageUrl } = await generateBrandGraphicAI({
        data: { agentId, template: graphicTemplate, tagline, backgroundImageUrl },
      });
      const formats: BrandGraphicFormat[] = ["youtube", "facebook"];
      const entries = await Promise.all(
        formats.map(async (format) => {
          const blob = await cropMasterGraphic(imageUrl, format);
          return [format, URL.createObjectURL(blob)] as const;
        }),
      );
      setGraphicPreviews((prev) => {
        // Revoke the previous round's object URLs before replacing them —
        // these aren't tiny, and nothing else holds a reference once a new
        // preview replaces the old <img src>.
        Object.values(prev).forEach((url) => url && URL.revokeObjectURL(url));
        return Object.fromEntries(entries);
      });
    } catch (e) {
      setGraphicError(e instanceof Error ? e.message : "Something went wrong generating these graphics.");
    } finally {
      setGraphicGenerating(false);
    }
  }

  // Generate My Branding Kit (2026-11-13) — per Mike: "we want to turn this
  // app into here's who I am and what I look like, now give me a whole
  // branding kit with the click of a button." One button that chains the 3
  // pieces already built above: scan the website (only if one's on file —
  // this step is skipped, not failed, when there isn't one), write the 5
  // bios, then build both graphics — using the freshly scanned background
  // photo right away rather than waiting on a second click, since relying
  // on React state here would mean using last session's scan (or none)
  // instead of the one this same click just produced.
  async function handleGenerateBrandKit() {
    if (!headshotUrl) {
      setKitStatus(null);
      setGraphicError("Upload a headshot above first — your whole kit is built from it.");
      return;
    }
    setKitGenerating(true);
    try {
      let freshScan: WebsiteScan | null = null;
      if (businessInfo.website.trim()) {
        setKitStatus("Scanning your website…");
        freshScan = await handleScanWebsite();
      }
      setKitStatus("Writing your bios…");
      await handleGenerateBios();
      setKitStatus("Building your graphics — this can take up to a minute…");
      await handleGenerateGraphics(freshScan ? (freshScan.images[0] ?? null) : undefined);
    } finally {
      setKitGenerating(false);
      setKitStatus(null);
    }
  }

  function downloadGraphic(format: BrandGraphicFormat) {
    const url = graphicPreviews[format];
    if (!url) return;
    const name = (basics.fullName.trim() || "Agent").replace(/\s+/g, "-");
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}-${BRAND_GRAPHIC_SIZES[format].fileSuffix}.png`;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // Reads a plain-text file straight into the textarea, client side —
  // covers .txt/.md with zero dependencies.
  function readPlainTextFile(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(new Error("Couldn't read that file."));
      reader.readAsText(file);
    });
  }

  // Extracts the plain text out of a .docx file, entirely client side, via
  // mammoth (only loaded when a .docx is actually picked — see the comment
  // on the pdfWorkerUrl import above for why these stay out of the main
  // bundle). mammoth's own "browser" field swaps in its browser-safe
  // internals automatically when bundled by Vite, same as heic2any — no
  // server round trip needed.
  async function extractDocxText(file: File): Promise<string> {
    const mammoth = await import("mammoth");
    const arrayBuffer = await file.arrayBuffer();
    const { value } = await mammoth.extractRawText({ arrayBuffer });
    return value;
  }

  // Extracts the plain text out of a .pdf file, entirely client side, via
  // pdf.js (Mozilla's own PDF library) — one page at a time, joining each
  // page's text items with a blank line between pages so a multi-page brand
  // doc still reads as distinct sections rather than one unbroken run-on.
  async function extractPdfText(file: File): Promise<string> {
    const pdfjsLib = await import("pdfjs-dist");
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pageTexts: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
      pageTexts.push(pageText.trim());
    }
    return pageTexts.join("\n\n").trim();
  }

  // Added 2026-11-05 per Mike: once he's built a brand kit / content
  // strategy for an agent himself (or an agent brings one they already made
  // with their own custom GPT or Claude project), it almost always exists
  // as a real Word doc or PDF, not hand-typed plain text — the old
  // .txt/.md-only version of this made every one of those a manual
  // copy-paste job first. Now auto-extracts .docx (via mammoth) and .pdf
  // (via pdf.js) client side, same as .txt/.md always has, so uploading the
  // actual file is enough. Legacy binary .doc (pre-2007 Word format, a
  // completely different file format from .docx under the hood) isn't
  // supported by either library — told explicitly rather than silently
  // failing, since "Word document" covers both formats from a user's
  // perspective but they're nothing alike to a parser.
  async function handleContentStrategyFile(file: File) {
    const lowerName = file.name.toLowerCase();
    setContentStrategyStatus("Reading file…");
    try {
      let text: string;
      if (lowerName.endsWith(".txt") || lowerName.endsWith(".md")) {
        text = await readPlainTextFile(file);
      } else if (lowerName.endsWith(".docx")) {
        text = await extractDocxText(file);
      } else if (lowerName.endsWith(".pdf")) {
        text = await extractPdfText(file);
      } else if (lowerName.endsWith(".doc")) {
        setContentStrategyStatus(
          "That's the old .doc Word format — re-save it as .docx (File → Save As in Word) and upload that instead, or paste the text into the box below.",
        );
        return;
      } else {
        setContentStrategyStatus(
          "Couldn't read that file type — upload a .txt, .md, .docx, or .pdf file, or paste the text into the box below.",
        );
        return;
      }
      if (!text.trim()) {
        setContentStrategyStatus("That file came back empty — try pasting the text into the box below instead.");
        return;
      }
      setContentStrategy(text.trim());
      setContentStrategyStatus("Loaded from file — click Save to keep it.");
    } catch (e) {
      setContentStrategyStatus(
        e instanceof Error ? `Couldn't read that file: ${e.message}` : "Couldn't read that file.",
      );
    }
  }

  // Rotate the "reading your personality..." messages while generating.
  useEffect(() => {
    if (stage !== "generating") return;
    let i = 0;
    const iv = setInterval(() => {
      i = (i + 1) % GENERATING_MESSAGES.length;
      setGenMessage(GENERATING_MESSAGES[i] ?? GENERATING_MESSAGES[0]);
    }, 2200);
    return () => clearInterval(iv);
  }, [stage]);

  // Tear down the mic whenever we leave the current question.
  useEffect(() => {
    return () => {
      killMic();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentQuestion]);

  function killMic() {
    const r = recogRef.current;
    if (r) {
      r.onstart = null;
      r.onresult = null;
      r.onend = null;
      r.onerror = null;
      try {
        r.abort();
      } catch {
        // ignore
      }
      recogRef.current = null;
    }
    setMicListening(false);
  }

  function resetMicUI(msg?: string) {
    setMicListening(false);
    setMicLabel(msg ?? "Tap mic and speak your answer");
  }

  function attemptRestart(baseText: string, attemptNum: number) {
    if (userStoppedMicRef.current || micDeniedRef.current) return;
    try {
      startRecognitionInstance(baseText);
    } catch {
      if (attemptNum < 5) {
        setTimeout(() => attemptRestart(baseText, attemptNum + 1), 150 * (attemptNum + 1));
      } else {
        resetMicUI("Mic paused — tap to resume, your answer so far is saved.");
      }
    }
  }

  function startRecognitionInstance(baseTextIn: string) {
    let baseText = baseTextIn;
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    const recog = new Ctor();
    recog.continuous = !isIOSDevice();
    recog.interimResults = true;
    recog.lang = "en-US";
    let finalTranscript = "";
    const qIndex = currentQuestion;

    recog.onstart = () => {
      setMicListening(true);
      micDeniedRef.current = false;
      finalTranscript = "";
      setMicLabel("Listening... tap to stop");
    };

    recog.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          finalTranscript += e.results[i][0].transcript + " ";
        } else {
          interim += e.results[i][0].transcript;
        }
      }
      const combined = baseText + finalTranscript + interim;
      setAnswers((prev) => {
        const next = [...prev];
        next[qIndex] = combined;
        return next;
      });
    };

    recog.onend = () => {
      setMicListening(false);
      baseText = baseText + finalTranscript;
      if (!userStoppedMicRef.current && !micDeniedRef.current) {
        attemptRestart(baseText, 0);
        return;
      }
      resetMicUI();
    };

    recog.onerror = (e: any) => {
      setMicListening(false);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        micDeniedRef.current = true;
        userStoppedMicRef.current = true;
        resetMicUI(
          "Mic access blocked — check your browser/site settings and allow microphone access, or just type below.",
        );
        return;
      }
      if (e.error === "no-speech") return;
      if (e.error === "network") {
        resetMicUI("Network hiccup — tap the mic to try again, or type below.");
        userStoppedMicRef.current = true;
        return;
      }
      if (e.error === "aborted") return;
      resetMicUI("Error — please type your answer below.");
      userStoppedMicRef.current = true;
    };

    recogRef.current = recog;
    recog.start();
  }

  function toggleMic() {
    if (!micSupported) return;
    if (micListening) {
      userStoppedMicRef.current = true;
      killMic();
      resetMicUI();
      return;
    }
    userStoppedMicRef.current = false;
    micDeniedRef.current = false;
    killMic();
    let base = answers[currentQuestion] ?? "";
    if (base && !base.endsWith(" ")) base += " ";
    attemptRestart(base, 0);
  }

  function grabCurrentAnswer(): string {
    userStoppedMicRef.current = true;
    killMic();
    resetMicUI();
    return (answers[currentQuestion] ?? "").trim();
  }

  function goToQuestion(index: number) {
    setCurrentQuestion(index);
    setRequireAnswer(false);
  }

  function handleNext() {
    const val = grabCurrentAnswer();
    if (!val) {
      setRequireAnswer(true);
      return;
    }
    setAnswers((prev) => {
      const next = [...prev];
      next[currentQuestion] = val;
      return next;
    });
    if (currentQuestion < VOICE_DNA_QUESTIONS.length - 1) {
      goToQuestion(currentQuestion + 1);
    } else {
      setStage("areas");
    }
  }

  function handleSkip() {
    grabCurrentAnswer();
    setAnswers((prev) => {
      const next = [...prev];
      next[currentQuestion] = "(skipped)";
      return next;
    });
    if (currentQuestion < VOICE_DNA_QUESTIONS.length - 1) {
      goToQuestion(currentQuestion + 1);
    } else {
      setStage("areas");
    }
  }

  function handleBack() {
    const val = grabCurrentAnswer();
    if (val) {
      setAnswers((prev) => {
        const next = [...prev];
        next[currentQuestion] = val;
        return next;
      });
    }
    if (currentQuestion > 0) goToQuestion(currentQuestion - 1);
  }

  async function saveToSupabase(generatedProfile: string) {
    const payload: VoiceDnaAnswers = {
      answers: VOICE_DNA_QUESTIONS.map((q, i) => ({
        question: q.question,
        answer: answers[i] ?? "",
      })),
      serviceAreas,
    };
    const result = await saveAgentVoiceProfile({
      data: {
        agentId,
        fullName: basics.fullName,
        marketArea: basics.marketArea,
        phone: basics.phone,
        voiceAnswers: payload,
        voiceSummary: generatedProfile,
      },
    });
    setSaveStatus(result.ok ? "Saved to your profile." : `Could not save: ${result.error}`);
  }

  async function handleGenerate() {
    setStage("generating");
    setGenError(null);
    setGenerating(true);
    try {
      const qas: VoiceDnaAnswer[] = VOICE_DNA_QUESTIONS.map((q, i) => ({
        question: q.question,
        answer: answers[i] === "(skipped)" ? "" : (answers[i] ?? ""),
      }));
      const result = await generateVoiceDnaProfile({
        data: {
          name: basics.fullName.trim() || "the agent",
          city: basics.marketArea.trim() || "their city",
          answers: qas,
        },
      });
      setProfile(result.profile);
      await saveToSupabase(result.profile);
      setStage("done");
    } catch (e) {
      setGenError(e instanceof Error ? e.message : "Something went wrong generating your profile.");
    } finally {
      setGenerating(false);
    }
  }

  function copyProfile(id: string) {
    if (!profile) return;
    const done = () => {
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 2500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(profile)
        .then(done)
        .catch(() => {});
    }
  }

  function downloadProfile() {
    if (!profile) return;
    const name = (basics.fullName.trim() || "Agent").replace(/\s+/g, "-");
    const blob = new Blob([profile], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}-Voice-DNA.txt`;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 500);
  }

  function restart() {
    killMic();
    setAnswers(emptyAnswers());
    setProfile("");
    setGenError(null);
    setSaveStatus(null);
    setCurrentQuestion(0);
    setStage("basics");
  }

  if (stage === "loading") {
    return (
      <AppShell>
        <div className="mt-16 text-center text-sm text-muted-foreground">Loading your profile…</div>
      </AppShell>
    );
  }

  const question = VOICE_DNA_QUESTIONS[currentQuestion] ?? VOICE_DNA_QUESTIONS[0]!;
  const progressPct = Math.round((currentQuestion / VOICE_DNA_QUESTIONS.length) * 100);

  return (
    <AppShell>
      <div className="mx-auto max-w-2xl pt-2">
        {isAdmin && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-2xl border border-border bg-glass px-4 py-2.5 text-sm">
            <span className="text-muted-foreground">
              Working on <span className="font-semibold text-foreground">{agentName}</span>'s brand
            </span>
            {onChangeAgent && (
              <button
                onClick={onChangeAgent}
                className="rounded-full border border-border px-3 py-1 text-xs font-semibold transition-colors hover:bg-secondary"
              >
                Change agent
              </button>
            )}
          </div>
        )}

        {/* Brand Assets (2026-09-28) — headshot + logo, per Mike: "the whole
            Build My Brand section should be a place where they could take
            their interview. They should also be able to upload their
            headshots and logos to this section... this needs to be the
            build my brand section... it needs to incorporate anything and
            everything that they would have for building their own personal
            brand." Shown above the interview, on every stage, since these
            aren't part of the linear interview flow — upload/replace either
            one any time. Built now: upload + storage + display, tagged so
            we always know whose brand each asset belongs to. NOT built yet
            (no spec from Mike to build against): automatic brand-color
            extraction from these images, a bio builder, and Facebook/
            YouTube header generation — Mike flagged those as "eventually"
            additions to this same section; tracked in build-status.md as
            roadmap, not part of this pass. */}
        <div className="mb-5 rounded-3xl border border-border bg-glass p-6 backdrop-blur-2xl">
          <h2 className="font-display text-lg font-semibold">Headshot & Logo</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Upload a headshot and your logo — these will power your brand colors and everything else we build for you
            going forward.
          </p>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {[
              { kind: "headshot" as const, label: "Headshot", url: headshotUrl },
              { kind: "logo" as const, label: "Logo", url: logoUrl },
            ].map((slot) => (
              <div
                key={slot.kind}
                className="flex items-center gap-4 rounded-2xl border border-border bg-background/40 p-4"
              >
                <div className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-2xl border border-border bg-muted">
                  {slot.url ? (
                    <img src={slot.url} alt={slot.label} className="size-full object-cover" />
                  ) : (
                    <span className="text-[10px] text-muted-foreground">No {slot.label.toLowerCase()}</span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{slot.label}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <label className="inline-block cursor-pointer rounded-full border border-border bg-glass px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-secondary">
                      {uploadingKind === slot.kind ? "Uploading…" : slot.url ? "Replace" : "Choose file"}
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        disabled={uploadingKind !== null}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = "";
                          if (file) uploadBrandAsset(file, slot.kind);
                        }}
                      />
                    </label>
                    {/* Downloadable (2026-10-22) per Mike: "when somebody
                        uploads their headshot and their logo, we need it to
                        be downloadable so that we can download it from
                        there and then use it." These are already public
                        Storage URLs (see finalizeBrandAssetUpload in
                        voice-dna.ts) - this just gives an explicit download
                        affordance instead of relying on right-click-save. */}
                    {slot.url && (
                      <a
                        href={slot.url}
                        download
                        className="inline-block rounded-full border border-border bg-glass px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-secondary"
                      >
                        Download
                      </a>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {brandAssetError && <p className="mt-3 text-xs text-destructive">{brandAssetError}</p>}
        </div>

        {/* Generate My Branding Kit (2026-11-13) — per Mike: "we want to
            turn this app into here's who I am and what I look like, now
            give me a whole branding kit with the click of a button." Runs
            Scan My Website (if a website's on file), the Brand Bio Writer,
            and Branding Graphics in one go — see handleGenerateBrandKit.
            Placed right under Headshot & Logo since that's literally "who
            I am and what I look like," everything else below still works
            on its own for re-runs/tweaks (a different tone, a different
            template, re-picking the background photo). */}
        <div className="mb-5 rounded-3xl border border-primary/40 bg-glass p-6 backdrop-blur-2xl">
          <h2 className="font-display text-lg font-semibold">Generate My Branding Kit</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            One click: scans your website if you've added one, writes all 5 bios below, and builds your YouTube banner
            and Facebook cover — all from your headshot, logo, and Voice DNA.
          </p>
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={handleGenerateBrandKit}
              disabled={kitGenerating || !headshotUrl}
              className="rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-transform hover:-translate-y-0.5 disabled:opacity-60"
            >
              {kitGenerating ? (kitStatus ?? "Building your kit…") : "Generate my branding kit"}
            </button>
            {!headshotUrl && <p className="text-xs text-muted-foreground">Upload a headshot above first.</p>}
          </div>
        </div>

        {/* Business Info (2026-10-22) — per Mike: "beneath the headshot logo
            section, we should put in the rest of their information, where
            they could put their phone number, their website, their license
            number if applicable, their email address, and the address, like
            where their office location is." Live independent of interview
            stage, same as Headshot & Logo above — saved with its own
            button, not gated behind finishing the 16-question interview.
            Phone is the same canonical number the interview's own Basics
            step edits (see handleSaveBusinessInfo). */}
        <div className="mb-5 rounded-3xl border border-border bg-glass p-6 backdrop-blur-2xl">
          <h2 className="font-display text-lg font-semibold">Business Info</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The contact details your brand assets and bio will be built from.
          </p>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium text-muted-foreground">Phone</span>
              <input
                value={basics.phone}
                onChange={(e) => setBasics((b) => ({ ...b, phone: e.target.value }))}
                className="mt-1 w-full rounded-xl border border-border bg-background/60 px-3 py-2 text-sm outline-none ring-ring transition focus:ring-2"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-muted-foreground">Website</span>
              <input
                value={businessInfo.website}
                onChange={(e) => setBusinessInfo((b) => ({ ...b, website: e.target.value }))}
                className="mt-1 w-full rounded-xl border border-border bg-background/60 px-3 py-2 text-sm outline-none ring-ring transition focus:ring-2"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-muted-foreground">License number (if applicable)</span>
              <input
                value={businessInfo.licenseNumber}
                onChange={(e) => setBusinessInfo((b) => ({ ...b, licenseNumber: e.target.value }))}
                className="mt-1 w-full rounded-xl border border-border bg-background/60 px-3 py-2 text-sm outline-none ring-ring transition focus:ring-2"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-muted-foreground">Email</span>
              <input
                value={businessInfo.email}
                onChange={(e) => setBusinessInfo((b) => ({ ...b, email: e.target.value }))}
                className="mt-1 w-full rounded-xl border border-border bg-background/60 px-3 py-2 text-sm outline-none ring-ring transition focus:ring-2"
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="text-xs font-medium text-muted-foreground">Office address</span>
              <input
                value={businessInfo.officeAddress}
                onChange={(e) => setBusinessInfo((b) => ({ ...b, officeAddress: e.target.value }))}
                className="mt-1 w-full rounded-xl border border-border bg-background/60 px-3 py-2 text-sm outline-none ring-ring transition focus:ring-2"
              />
            </label>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={handleSaveBusinessInfo}
              disabled={businessInfoSaving}
              className="rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-transform hover:-translate-y-0.5 disabled:opacity-60"
            >
              {businessInfoSaving ? "Saving…" : "Save business info"}
            </button>
            {businessInfoStatus && <p className="text-xs text-muted-foreground">{businessInfoStatus}</p>}
          </div>

          {/* Scan My Website (2026-11-13) — per Mike: "you should be able to
              scan their website and create content too, to grab other
              images etc if need be, but the only thing you should need is
              headshot and logo." Pulls the page's title/description (woven
              into the bios below as extra context) and a few photos
              (re-hosted, selectable as an optional Branding Graphics
              background further down) — see scanAgentWebsite in
              voice-dna.ts. Entirely optional; nothing downstream requires
              it. */}
          <div className="mt-4 border-t border-border pt-4">
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={handleScanWebsite}
                disabled={scanningWebsite || !businessInfo.website.trim()}
                className="rounded-xl border border-border bg-glass px-4 py-2 text-xs font-semibold transition-colors hover:bg-secondary disabled:opacity-60"
              >
                {scanningWebsite ? "Scanning…" : websiteScan ? "Re-scan website" : "Scan my website"}
              </button>
              <p className="text-xs text-muted-foreground">
                Optional — pulls a bit of copy and a few photos from your own site to help write your bios and build
                your graphics.
              </p>
            </div>
            {scanError && <p className="mt-2 text-xs text-destructive">{scanError}</p>}
            {websiteScan && !scanError && (
              <div className="mt-3 rounded-xl border border-border bg-background/40 p-3">
                <p className="text-xs text-muted-foreground">
                  {websiteScan.title ? <span className="font-medium text-foreground">{websiteScan.title}</span> : null}
                  {websiteScan.description ? ` — ${websiteScan.description}` : ""}
                  {!websiteScan.title && !websiteScan.description
                    ? "Scanned — no page title or description found."
                    : ""}
                </p>
                {websiteScan.images.length > 0 && (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    Found {websiteScan.images.length} photo{websiteScan.images.length === 1 ? "" : "s"} — pick one as a
                    background in Branding Graphics below.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Content Branding Strategy (2026-10-22) — per Mike: "once somebody
            is finished with the interview... I want to add a section...
            called their content branding strategy. This section will just
            have a document that I can upload inside of here that'll also
            play into their voice DNA profile." Also live independent of
            interview stage. UPDATED 2026-11-05 — Mike asked whether this
            could "connect to" an agent's own existing custom GPT or Claude
            project directly; neither OpenAI nor Anthropic expose an API for
            a third party to read someone else's account that way, so this
            is the real answer instead: paste or upload whatever you already
            gave your GPT/Claude (its instructions, its knowledge files)
            right here. Now auto-extracts .docx and .pdf client side too
            (mammoth/pdf.js), not just .txt/.md, since a brand kit or a
            custom GPT's knowledge file is almost always one of those — see
            handleContentStrategyFile. Also doubles as where Mike uploads a
            brand kit/content strategy HE builds for an agent himself — the
            admin "Change agent" picker above switches this whole page to
            any agent, Content Branding Strategy included, same as Business
            Info already does. Once saved, this gets woven into every
            content-generation prompt built from this agent's Voice DNA (see
            withContentBrandingStrategy in marketing.ts). */}
        <div className="mb-5 rounded-3xl border border-border bg-glass p-6 backdrop-blur-2xl">
          <h2 className="font-display text-lg font-semibold">Content Branding Strategy</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Optional — a content/brand strategy doc for this agent (recurring series ideas, content pillars, tone
            notes). Already built a custom GPT or a Claude project for this agent's brand voice? Paste its instructions
            here, or upload the file(s) you gave it — this is where that goes. Upload a file or paste below; it gets
            factored in alongside their Voice DNA every time we write for them.
          </p>
          <label className="mt-3 inline-block cursor-pointer rounded-full border border-border bg-glass px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-secondary">
            Upload a .txt/.md/.docx/.pdf file
            <input
              type="file"
              accept=".txt,.md,.docx,.pdf,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) handleContentStrategyFile(file);
              }}
            />
          </label>
          <textarea
            value={contentStrategy}
            onChange={(e) => setContentStrategy(e.target.value)}
            placeholder="Paste or upload this agent's content branding strategy here…"
            rows={8}
            className="mt-3 w-full resize-y rounded-2xl border border-border bg-background/60 px-4 py-3 text-sm outline-none ring-ring transition focus:ring-2"
          />
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={handleSaveContentStrategy}
              disabled={contentStrategySaving}
              className="rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-transform hover:-translate-y-0.5 disabled:opacity-60"
            >
              {contentStrategySaving ? "Saving…" : "Save content strategy"}
            </button>
            {contentStrategyStatus && <p className="text-xs text-muted-foreground">{contentStrategyStatus}</p>}
          </div>
        </div>

        {/* Social Media Handles (2026-11-13) — per Mike: "we should also
            plug in their social media handles, anywhere else where you
            could pull public information on them, so that you can write a
            bio." We asked Mike whether to actually scrape these live;
            getting no clear answer, we went with the safer default he
            pointed us toward ("you know what my goals are") — these are
            reference text only, fed into the bio prompt below, never
            fetched or scraped. Scraping Instagram/Facebook/LinkedIn/
            Zillow/Trulia is fragile and likely against each platform's
            ToS, and none of them offer a public API for this. */}
        <div className="mb-5 rounded-3xl border border-border bg-glass p-6 backdrop-blur-2xl">
          <h2 className="font-display text-lg font-semibold">Social Media Handles</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Optional — your usernames/profile links. We use these as reference when writing your bios below (never
            scraped or fetched automatically), and weave the relevant ones in naturally.
          </p>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(
              [
                { key: "instagram" as const, label: "Instagram", placeholder: "@yourname" },
                { key: "facebook" as const, label: "Facebook", placeholder: "facebook.com/yourname" },
                { key: "linkedin" as const, label: "LinkedIn", placeholder: "linkedin.com/in/yourname" },
                { key: "youtube" as const, label: "YouTube", placeholder: "youtube.com/@yourname" },
                { key: "tiktok" as const, label: "TikTok", placeholder: "@yourname" },
                { key: "zillow" as const, label: "Zillow profile", placeholder: "zillow.com/profile/yourname" },
                { key: "trulia" as const, label: "Trulia profile", placeholder: "trulia.com/profile/yourname" },
              ] satisfies { key: keyof AgentSocialHandles; label: string; placeholder: string }[]
            ).map((field) => (
              <label key={field.key} className="block">
                <span className="text-xs font-medium text-muted-foreground">{field.label}</span>
                <input
                  value={socialHandles[field.key]}
                  onChange={(e) => setSocialHandles((s) => ({ ...s, [field.key]: e.target.value }))}
                  placeholder={field.placeholder}
                  className="mt-1 w-full rounded-xl border border-border bg-background/60 px-3 py-2 text-sm outline-none ring-ring transition focus:ring-2"
                />
              </label>
            ))}
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={handleSaveSocialHandles}
              disabled={socialHandlesSaving}
              className="rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-transform hover:-translate-y-0.5 disabled:opacity-60"
            >
              {socialHandlesSaving ? "Saving…" : "Save handles"}
            </button>
            {socialHandlesStatus && <p className="text-xs text-muted-foreground">{socialHandlesStatus}</p>}
          </div>
        </div>

        {/* Brand Bio Writer (2026-11-13) — per Mike: "we need to create a
            done-for-you bio section that can be created just based on what
            they've already created in that section... this should be no
            different than I'm just typing in Claude. I need you to write a
            bio based upon who I am... maybe we can rate it by, like, how do
            you want to be — professional, personable, funny, relatable."
            Pulls Voice DNA + Business Info + Content Branding Strategy +
            the handles above into one prompt (see buildBrandBioPrompt in
            voice-dna.ts) and returns 5 platform-specific variants in one
            call. */}
        <div className="mb-5 rounded-3xl border border-border bg-glass p-6 backdrop-blur-2xl">
          <h2 className="font-display text-lg font-semibold">Brand Bio Writer</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Done-for-you bios for everywhere you need one — Instagram, Facebook, LinkedIn, your Zillow/Trulia profile,
            and your website or YouTube About section — written from your Voice DNA, business info, and handles above.
          </p>
          <div className="mt-4">
            <span className="text-xs font-medium text-muted-foreground">Tone</span>
            <div className="mt-1.5 flex flex-wrap gap-1 rounded-full border border-border bg-glass p-1 backdrop-blur-xl w-fit">
              {(["professional", "personable", "funny", "relatable"] as const satisfies BrandBioTone[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setBioTone(t)}
                  className={`rounded-full px-4 py-1.5 text-sm font-medium capitalize transition-colors ${
                    bioTone === t ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <label className="mt-4 block">
            <span className="text-xs font-medium text-muted-foreground">Anything else we should know? (optional)</span>
            <textarea
              value={bioExtraNotes}
              onChange={(e) => setBioExtraNotes(e.target.value)}
              placeholder="Hobbies, background, family, what makes you different — anything you want woven in."
              rows={3}
              className="mt-1 w-full resize-y rounded-2xl border border-border bg-background/60 px-4 py-3 text-sm outline-none ring-ring transition focus:ring-2"
            />
          </label>
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={handleGenerateBios}
              disabled={bioGenerating}
              className="rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-transform hover:-translate-y-0.5 disabled:opacity-60"
            >
              {bioGenerating ? "Writing your bios…" : bioResult ? "Regenerate bios" : "Write my bios"}
            </button>
            {bioError && <p className="text-xs text-destructive">{bioError}</p>}
          </div>
          {bioResult && (
            <div className="mt-5 space-y-4">
              {(
                [
                  { key: "instagram" as const, label: "Instagram bio", counter: true },
                  { key: "facebook" as const, label: "Facebook intro" },
                  { key: "linkedin" as const, label: "LinkedIn about" },
                  { key: "realtorProfile" as const, label: "Realtor profile (Zillow / Trulia)" },
                  { key: "websiteAbout" as const, label: "Website / YouTube about" },
                ] satisfies { key: keyof BrandBioResult; label: string; counter?: boolean }[]
              ).map((variant) => {
                const text = bioResult[variant.key];
                return (
                  <div key={variant.key} className="rounded-2xl border border-border bg-background/40 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold">{variant.label}</p>
                      <button
                        onClick={() => copyBioText(variant.key, text)}
                        className="shrink-0 rounded-full border border-border bg-glass px-3 py-1 text-xs font-semibold transition-colors hover:bg-secondary"
                      >
                        {bioCopiedKey === variant.key ? "Copied!" : "Copy"}
                      </button>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{text}</p>
                    {variant.counter && (
                      <p className="mt-1.5 text-[11px] text-muted-foreground">{text.length} / 150 characters</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Branding Graphics v2 — real AI image generation (2026-11-13).
            Mike's original ask: "take the headshot they uploaded and the
            logo and be able to create really nice-looking YouTube headers,
            Facebook covers... a couple different versions." The first pass
            at this drew shapes on a <canvas> by hand; his reaction to that
            ("worst cover photo ever... use all your resources... pretend
            you are a graphic designer") is why this now calls an actual
            image-generation model (OpenAI's gpt-image-1 — the model behind
            image generation in ChatGPT, which he pointed at directly)
            server-side with a real art-directed prompt, instead of drawing
            shapes ourselves — see generateBrandGraphicAI in voice-dna.ts.
            Needs an OPENAI_API_KEY secret added in Lovable Cloud →
            Secrets (same setup as the existing ANTHROPIC_API_KEY) — the
            error below says so plainly if it's missing. */}
        <div className="mb-5 rounded-3xl border border-border bg-glass p-6 backdrop-blur-2xl">
          <h2 className="font-display text-lg font-semibold">Branding Graphics</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            A YouTube channel banner and a Facebook cover, designed by AI from your headshot, logo, brand color, and (if
            you've scanned it) your website. Pick a style, adjust your tagline, and generate — download either one as a
            PNG. Each generation takes a real image-generation model a little while, so this can take up to a minute.
          </p>
          {!headshotUrl && (
            <p className="mt-3 text-xs text-destructive">Upload a headshot in the section above first.</p>
          )}
          <div className="mt-4">
            <span className="text-xs font-medium text-muted-foreground">Style</span>
            <div className="mt-1.5 flex flex-wrap gap-1 rounded-full border border-border bg-glass p-1 backdrop-blur-xl w-fit">
              {(["bold-split", "photo-backdrop", "centered-minimal"] as const satisfies BrandGraphicTemplate[]).map(
                (t) => (
                  <button
                    key={t}
                    onClick={() => setGraphicTemplate(t)}
                    className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                      graphicTemplate === t
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {t === "bold-split"
                      ? "Bold editorial"
                      : t === "photo-backdrop"
                        ? "Photo backdrop"
                        : "Clean minimal"}
                  </button>
                ),
              )}
            </div>
          </div>
          <label className="mt-4 block">
            <span className="text-xs font-medium text-muted-foreground">Tagline</span>
            <input
              value={graphicTagline ?? ""}
              onChange={(e) => setGraphicTagline(e.target.value)}
              placeholder="Real Estate Agent — Austin, TX"
              className="mt-1 w-full rounded-xl border border-border bg-background/60 px-3 py-2 text-sm outline-none ring-ring transition focus:ring-2"
            />
          </label>
          {/* Background photo (2026-11-13) — optional, only shows up once
              Scan My Website (above, in Business Info) has actually found
              photos. For the Photo Backdrop style this becomes the actual
              background; for the other 2 styles it's used only as color/
              mood inspiration. Picking "None" (the default when nothing's
              been scanned) still produces a full designed graphic from
              just headshot + logo, per Mike's "only thing you should
              need." */}
          {websiteScan && websiteScan.images.length > 0 && (
            <div className="mt-4">
              <span className="text-xs font-medium text-muted-foreground">Background photo (from your website)</span>
              <div className="mt-1.5 flex flex-wrap gap-2">
                <button
                  onClick={() => setSelectedBackgroundImage(null)}
                  className={`grid h-14 w-20 shrink-0 place-items-center rounded-lg border text-[10px] font-medium transition-colors ${
                    selectedBackgroundImage === null
                      ? "border-primary bg-secondary text-foreground"
                      : "border-border bg-background/40 text-muted-foreground hover:bg-secondary"
                  }`}
                >
                  None
                </button>
                {websiteScan.images.map((url) => (
                  <button
                    key={url}
                    onClick={() => setSelectedBackgroundImage(url)}
                    className={`h-14 w-20 shrink-0 overflow-hidden rounded-lg border-2 transition-colors ${
                      selectedBackgroundImage === url ? "border-primary" : "border-transparent hover:border-border"
                    }`}
                  >
                    <img src={url} alt="" className="size-full object-cover" />
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={() => handleGenerateGraphics()}
              disabled={graphicGenerating || !headshotUrl}
              className="rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-transform hover:-translate-y-0.5 disabled:opacity-60"
            >
              {graphicGenerating ? "Designing your graphics…" : "Generate graphics"}
            </button>
            {graphicError && <p className="text-xs text-destructive">{graphicError}</p>}
          </div>
          {(graphicPreviews.youtube || graphicPreviews.facebook) && (
            <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
              {(
                [
                  { key: "youtube" as const, label: "YouTube banner" },
                  { key: "facebook" as const, label: "Facebook cover" },
                ] satisfies { key: BrandGraphicFormat; label: string }[]
              ).map((item) => {
                const url = graphicPreviews[item.key];
                if (!url) return null;
                return (
                  <div key={item.key} className="rounded-2xl border border-border bg-background/40 p-4">
                    <p className="text-sm font-semibold">{item.label}</p>
                    <div className="mt-2 overflow-hidden rounded-xl border border-border bg-muted">
                      <img src={url} alt={item.label} className="w-full object-cover" />
                    </div>
                    <button
                      onClick={() => downloadGraphic(item.key)}
                      className="mt-3 rounded-full border border-border bg-glass px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-secondary"
                    >
                      Download
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {stage === "intro" && (
          <div className="rounded-3xl border border-border bg-glass p-8 backdrop-blur-2xl">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Agent onboarding</p>
            <h1 className="mt-2 font-display text-2xl font-bold tracking-tight">
              Let's figure out who you actually are.
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Not a real estate questionnaire. We want to know about your life and personality so every post we write
              sounds exactly like <em>you</em> — not a template.
            </p>
            <ul className="mt-6 space-y-3 text-sm text-muted-foreground">
              {[
                "Quick basics — name, city, who you work with",
                "16 questions — speak or type your answers",
                "Your Voice DNA profile is built automatically",
                "Our team uses it every month to write in your voice",
              ].map((step, i) => (
                <li key={step} className="flex items-start gap-3">
                  <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border border-border text-xs font-medium">
                    {i + 1}
                  </span>
                  {step}
                </li>
              ))}
            </ul>
            <button
              onClick={() => setStage("basics")}
              className="mt-8 rounded-2xl bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-transform hover:-translate-y-0.5"
            >
              Let's go
            </button>
          </div>
        )}

        {stage === "basics" && (
          <div className="rounded-3xl border border-border bg-glass p-8 backdrop-blur-2xl">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Step 1 of 3</p>
            <h2 className="mt-2 font-display text-xl font-bold tracking-tight">Just a few quick facts first.</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              The only boring part. Everything after this is a real conversation.
            </p>
            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="text-sm font-medium text-muted-foreground">
                  Your name <span className="text-destructive">*</span>
                </span>
                <input
                  value={basics.fullName}
                  onChange={(e) => setBasics((b) => ({ ...b, fullName: e.target.value }))}
                  placeholder="Sarah"
                  className="mt-1.5 w-full rounded-2xl bg-muted px-4 py-3 text-sm outline-none ring-ring transition focus:ring-2"
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-muted-foreground">City / market</span>
                <input
                  value={basics.marketArea}
                  onChange={(e) => setBasics((b) => ({ ...b, marketArea: e.target.value }))}
                  placeholder="Austin, TX"
                  className="mt-1.5 w-full rounded-2xl bg-muted px-4 py-3 text-sm outline-none ring-ring transition focus:ring-2"
                />
              </label>
              <label className="block sm:col-span-2">
                <span className="text-sm font-medium text-muted-foreground">Phone number</span>
                <input
                  value={basics.phone}
                  onChange={(e) => setBasics((b) => ({ ...b, phone: e.target.value }))}
                  placeholder="(555) 123-4567"
                  className="mt-1.5 w-full rounded-2xl bg-muted px-4 py-3 text-sm outline-none ring-ring transition focus:ring-2"
                />
              </label>
            </div>
            {!basics.fullName.trim() && <p className="mt-3 text-xs text-destructive">Add your name to continue.</p>}
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button
                onClick={() => setStage("intro")}
                className="rounded-2xl border border-border bg-glass px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-secondary"
              >
                Back
              </button>
              <button
                onClick={() => {
                  if (!basics.fullName.trim()) return;
                  setStage("interview");
                }}
                disabled={!basics.fullName.trim()}
                className="rounded-2xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-transform hover:-translate-y-0.5 disabled:opacity-40"
              >
                Start the interview
              </button>
            </div>
          </div>
        )}

        {stage === "interview" && (
          <div>
            <div className="mb-2 flex items-center gap-3">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-border">
                <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progressPct}%` }} />
              </div>
              <span className="whitespace-nowrap text-xs text-muted-foreground">
                {currentQuestion + 1} of {VOICE_DNA_QUESTIONS.length}
              </span>
            </div>
            <div className="rounded-3xl border border-border bg-glass p-8 backdrop-blur-2xl">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{question.section}</p>
              <h2 className="mt-2 font-display text-lg font-semibold leading-snug">{question.question}</h2>
              <p className="mt-1.5 text-sm italic text-muted-foreground">{question.nudge}</p>

              {micSupported && (
                <div className="mt-5 flex flex-col items-center gap-2 py-2">
                  <button
                    onClick={toggleMic}
                    className={`grid size-16 place-items-center rounded-full border transition ${
                      micListening
                        ? "animate-pulse border-destructive/40 bg-destructive/10"
                        : "border-border bg-muted hover:bg-secondary"
                    }`}
                    aria-label="Toggle voice input"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      className={`size-6 ${micListening ? "stroke-destructive" : "stroke-foreground"}`}
                      fill="none"
                      strokeWidth={1.8}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      {micListening ? (
                        <rect x="6" y="6" width="12" height="12" rx="2" />
                      ) : (
                        <>
                          <rect x="9" y="2" width="6" height="11" rx="3" />
                          <path d="M5 10a7 7 0 0 0 14 0" />
                          <line x1="12" y1="19" x2="12" y2="22" />
                          <line x1="8" y1="22" x2="16" y2="22" />
                        </>
                      )}
                    </svg>
                  </button>
                  <span
                    className={`text-xs ${micListening ? "font-medium text-destructive" : "text-muted-foreground"}`}
                  >
                    {micLabel}
                  </span>
                </div>
              )}
              {!micSupported && (
                <p className="mt-4 text-xs text-muted-foreground">
                  🎤 Voice input isn't available in this browser — no worries, just type your answer below.
                </p>
              )}

              <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground">
                <div className="h-px flex-1 bg-border" />
                or type your answer
                <div className="h-px flex-1 bg-border" />
              </div>

              <textarea
                value={answers[currentQuestion] ?? ""}
                onChange={(e) =>
                  setAnswers((prev) => {
                    const next = [...prev];
                    next[currentQuestion] = e.target.value;
                    return next;
                  })
                }
                placeholder="Speak above or type here..."
                className="min-h-[100px] w-full rounded-2xl bg-muted px-4 py-3 text-sm leading-relaxed outline-none ring-ring transition focus:ring-2"
              />
              {requireAnswer && <p className="mt-2 text-xs text-destructive">Please answer or tap Skip to continue.</p>}

              <div className="mt-6 flex flex-wrap items-center gap-3">
                <button
                  onClick={handleBack}
                  disabled={currentQuestion === 0}
                  className="rounded-2xl border border-border bg-glass px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-secondary disabled:opacity-40"
                >
                  Back
                </button>
                <button
                  onClick={handleNext}
                  className="rounded-2xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-transform hover:-translate-y-0.5"
                >
                  {currentQuestion === VOICE_DNA_QUESTIONS.length - 1 ? "Build my profile" : "Next"}
                </button>
                <button
                  onClick={handleSkip}
                  className="rounded-2xl px-4 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  Skip
                </button>
              </div>
            </div>
          </div>
        )}

        {stage === "areas" && (
          <div className="rounded-3xl border border-border bg-glass p-8 backdrop-blur-2xl">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Almost done</p>
            <h2 className="mt-2 font-display text-xl font-bold tracking-tight">
              Where do you want your content focused?
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Give us the cities, ZIP codes, or counties you work — this is what we'll pull local flavor and stats from
              for your posts and emails.
            </p>
            <label className="mt-5 block">
              <span className="text-sm font-medium text-muted-foreground">Cities, ZIP codes, or counties</span>
              <textarea
                value={serviceAreas}
                onChange={(e) => setServiceAreas(e.target.value)}
                placeholder="Example: Carlsbad, Oceanside, 92008, San Diego County"
                className="mt-1.5 min-h-[100px] w-full rounded-2xl bg-muted px-4 py-3 text-sm leading-relaxed outline-none ring-ring transition focus:ring-2"
              />
            </label>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button
                onClick={() => goToQuestion(VOICE_DNA_QUESTIONS.length - 1)}
                className="rounded-2xl border border-border bg-glass px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-secondary"
              >
                Back
              </button>
              <button
                onClick={handleGenerate}
                className="rounded-2xl bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-transform hover:-translate-y-0.5"
              >
                Finish →
              </button>
            </div>
          </div>
        )}

        {stage === "generating" && (
          <div className="rounded-3xl border border-border bg-glass p-8 backdrop-blur-2xl">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Step 3 of 3</p>
            <h2 className="mt-2 font-display text-xl font-bold tracking-tight">Building your Voice DNA.</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Reading your answers and finding what makes you genuinely <em>you</em>.
            </p>

            {generating && !genError && (
              <div className="mt-6 flex items-center gap-3 rounded-2xl border border-border bg-background px-5 py-4 text-sm text-muted-foreground">
                <span className="flex gap-1">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="size-1.5 animate-pulse rounded-full bg-muted-foreground"
                      style={{ animationDelay: `${i * 0.2}s` }}
                    />
                  ))}
                </span>
                {genMessage}
              </div>
            )}

            {genError && (
              <div className="mt-6 rounded-2xl border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive">
                <p className="whitespace-pre-wrap">
                  Error: {genError}
                  {"\n\n"}Your answers are saved.
                </p>
                <button
                  onClick={handleGenerate}
                  className="mt-3 rounded-2xl bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30"
                >
                  Try again
                </button>
              </div>
            )}
          </div>
        )}

        {stage === "done" && (
          <div>
            <div className="mb-4 inline-flex items-center gap-2 rounded-xl bg-[color-mix(in_oklab,var(--color-primary)_12%,transparent)] px-4 py-2 text-sm font-medium text-primary">
              Profile complete
            </div>
            <div className="rounded-3xl border border-border bg-glass backdrop-blur-2xl overflow-hidden">
              <div className="flex items-start justify-between gap-4 border-b border-border bg-background/40 px-6 py-4">
                <div>
                  <div className="font-display text-base font-semibold">
                    {basics.fullName || "Agent"}
                    {basics.marketArea ? ` — ${basics.marketArea}` : ""}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">Voice DNA Profile</div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={() => copyProfile("done")}
                    className="rounded-xl border border-border bg-glass px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-secondary"
                  >
                    {copiedId === "done" ? "Copied!" : "Copy"}
                  </button>
                  <button
                    onClick={downloadProfile}
                    className="rounded-xl border border-border bg-glass px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-secondary"
                  >
                    Download
                  </button>
                </div>
              </div>
              <pre className="max-h-[420px] overflow-y-auto whitespace-pre-wrap px-6 py-5 font-mono text-xs leading-relaxed">
                {profile}
              </pre>
            </div>
            {saveStatus && <p className="mt-3 text-xs text-muted-foreground">{saveStatus}</p>}
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button
                onClick={restart}
                className="rounded-2xl border border-border bg-glass px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-secondary"
              >
                Redo the interview
              </button>
              <Link
                to="/marketing"
                className="rounded-2xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-transform hover:-translate-y-0.5"
              >
                Go to Monthly Marketing
              </Link>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
