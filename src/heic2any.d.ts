// heic2any has no official types and no @types package on npm — this is a
// minimal local declaration covering just the call shape this app uses
// (client-side HEIC/HEIF -> JPEG conversion for the Media Library upload
// paths, added 2026-11-04 per Mike: "HEIC images do not display in media
// center... convert ALL images regardless of their file type to a PNG or
// JPEG.").
declare module "heic2any" {
  interface Heic2AnyOptions {
    blob: Blob;
    toType?: string;
    quality?: number;
    multiple?: boolean;
  }
  export default function heic2any(options: Heic2AnyOptions): Promise<Blob | Blob[]>;
}
