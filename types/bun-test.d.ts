/**
 * Completion of the local `bun:test` stand-in for the plugin test suite.
 *
 * `core/types-bun.d.ts` already declares a minimal `bun:test` module (it is
 * inside `core/**`, which this tsconfig includes, and it exists so the repo
 * needs no `@types/bun` dependency). That stand-in covers only the matchers
 * the `core/**` tests use, so `plugins/opencode/__tests__/plugin.test.ts`
 * cannot use `toMatch`, `toMatchObject`, `resolves`, `rejects` or
 * `expect.stringContaining`, and it cannot import `build` from `bun` or read
 * `import.meta.dir`.
 *
 * Ambient module declarations merge, so re-opening `bun:test` here adds the
 * missing members to the same module. The `expect` overload below is more
 * specific than the `expect(value: any)` overload in the stand-in, so it is
 * the one callers resolve against; it therefore re-declares every member the
 * stand-in already exposes, so nothing under `core/**` changes meaning.
 *
 * Preferred long-term fix, once the operator decides: install `@types/bun`
 * and add it to the tsconfig `types` array, then delete both this file and
 * `core/types-bun.d.ts`. If you do that, delete this file too, otherwise the
 * duplicate `bun:test` and `bun` module declarations collide.
 */

declare module 'bun:test' {
  /** Async assertion surfaces (`expect(promise).resolves.x()`). */
  export interface AsyncMatchers {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toMatchObject(expected: unknown): void;
    toBeUndefined(): void;
    toBeDefined(): void;
    toContain(expected: unknown): void;
  }

  export interface Matchers {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toMatch(expected: string | RegExp): void;
    toMatchObject(expected: unknown): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toContain(expected: unknown): void;
    toHaveLength(expected: number): void;
    toBeInstanceOf(expected: unknown): void;
    toThrow(expected?: unknown): void;
    toBeNull(): void;
    toBeDefined(): void;
    toBeUndefined(): void;
    not: Matchers;
    resolves: AsyncMatchers;
    rejects: AsyncMatchers;
  }

  export function expect<T>(value: T): Matchers;

  export namespace expect {
    /** Asymmetric matcher, used inside `toEqual`/`toMatchObject` objects. */
    export function stringContaining(expected: string): unknown;
  }
}

declare module 'bun' {
  /** Options the plugin test passes to `Bun.build`. */
  export interface BuildConfig {
    entrypoints: string[];
    outdir?: string;
    target?: 'browser' | 'bun' | 'node';
    format?: 'esm' | 'cjs' | 'iife';
  }

  /** Members of `Bun.build`'s result the plugin test reads. */
  export interface BuildOutput {
    success: boolean;
    logs: string[];
  }

  export function build(config: BuildConfig): Promise<BuildOutput>;
}

/** Bun exposes the directory of the running module on `import.meta`. */
interface ImportMeta {
  readonly dir: string;
}
