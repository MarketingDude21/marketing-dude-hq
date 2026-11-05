// mammoth has no official types and no @types package on npm — this is a
// minimal local declaration covering just the call shape this app uses
// (client-side .docx -> plain text extraction for the Content Branding
// Strategy upload, added 2026-11-05 per Mike: being able to upload a real
// Word doc — e.g. a brand kit he built for an agent, or a custom GPT's
// knowledge file — instead of only plain .txt/.md).
declare module "mammoth" {
  interface ExtractRawTextResult {
    value: string;
    messages: unknown[];
  }
  export function extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<ExtractRawTextResult>;
}
