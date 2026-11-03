declare module "jpeg-js" {
  export function encode(
    image: { data: Uint8Array; width: number; height: number },
    quality?: number,
  ): { data: Uint8Array; width: number; height: number };
  export function decode(
    jpeg: Uint8Array,
    options?: { useTArray?: boolean; formatAsRGBA?: boolean },
  ): { data: Uint8Array; width: number; height: number };
}
