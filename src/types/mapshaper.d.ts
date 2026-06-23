declare module "mapshaper" {
  export function applyCommands(
    commands: string,
    input: Record<string, string | Buffer>,
    callback: (
      err: Error | null,
      output: Record<string, Buffer | string>,
    ) => void,
  ): void;

  export function runCommands(commands: string, options?: any): Promise<any>;
}
