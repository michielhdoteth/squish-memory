declare module 'bun:test' {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function beforeAll(fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function expect(value: any): {
    toBe(expected: any): void;
    toEqual(expected: any): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toContain(expected: any): void;
    toHaveLength(expected: number): void;
    toBeInstanceOf(expected: any): void;
    toThrow(): void;
    toBeNull(): void;
    toBeDefined(): void;
    toBeUndefined(): void;
    not: any;
  };
  export function mock<T extends (...args: any[]) => any>(fn?: T): T;
  export function spyOn(obj: any, method: string): any;
}

declare module 'bun:sqlite' {
  /** Options accepted by the `bun:sqlite` Database constructor. */
  export interface DatabaseOptions {
    readonly?: boolean;
    create?: boolean;
    readwrite?: boolean;
    strict?: boolean;
    safeIntegers?: boolean;
  }

  /**
   * A compiled statement, returned by `Database.prepare` (and by `query`,
   * which is `prepare` with an LRU cache). Binding parameters are typed
   * loosely because bun:sqlite accepts string, number, bigint, boolean,
   * null, Uint8Array and Buffer interchangeably.
   */
  export class Statement {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number; lastInsertRowid: number };
    values(...params: unknown[]): unknown[][];
    finalize(): void;
  }

  export class Database {
    constructor(path: string, options?: DatabaseOptions);
    prepare(sql: string): Statement;
    query(sql: string): any;
    exec(sql: string): void;
    close(): void;
  }
}

/**
 * Minimal ambient handle on the Bun global. Declared without a DOM or
 * `@types/bun` dependency so files outside `core/**` can feature-detect the
 * runtime (`typeof Bun !== 'undefined'`) and stay inside this tsconfig program.
 */
declare const Bun: {
  readonly version: string;
};
