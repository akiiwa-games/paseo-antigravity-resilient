declare module "node:fs/promises" {
  export function chmod(path: string, mode: number): Promise<void>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function writeFile(
    path: string,
    data: string | Uint8Array,
    options?: { flag?: string; mode?: number },
  ): Promise<void>;
}

declare module "node:fs" {
  export interface Stats { mode: number; }
  export function readFileSync(path: string): Buffer;
}
