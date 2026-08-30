/* oxlint-disable typescript/no-explicit-any */
// Ambient types for `bun:test` — the narrow surface the suite uses, in the
// serve.ts spirit of declaring just what we need instead of adopting
// @types/bun. jest-dom merges its DOM matchers into `Matchers` via its
// types/bun.d.ts (not exported through package exports, hence the path).
/// <reference path="../../node_modules/@testing-library/jest-dom/types/bun.d.ts" />

declare module 'bun:test' {
  type Procedure = (...args: any[]) => any;

  interface MockFunction<TFunction extends Procedure = Procedure> {
    (...args: Parameters<TFunction>): ReturnType<TFunction>;
    mock: {
      calls: Parameters<TFunction>[];
    };
    getMockImplementation(): TFunction | undefined;
    mockImplementation(implementation: TFunction): MockFunction<TFunction>;
    mockImplementationOnce(implementation: TFunction): MockFunction<TFunction>;
    mockReturnValue(value: ReturnType<TFunction>): MockFunction<TFunction>;
    mockReturnValueOnce(value: ReturnType<TFunction>): MockFunction<TFunction>;
    mockResolvedValue(value: Awaited<ReturnType<TFunction>>): MockFunction<TFunction>;
    mockResolvedValueOnce(value: Awaited<ReturnType<TFunction>>): MockFunction<TFunction>;
    mockRejectedValue(value: unknown): MockFunction<TFunction>;
    mockRejectedValueOnce(value: unknown): MockFunction<TFunction>;
    mockClear(): MockFunction<TFunction>;
    mockReset(): MockFunction<TFunction>;
    mockRestore(): MockFunction<TFunction>;
  }

  interface MockCalls<TFunction extends Procedure> {
    calls: Parameters<TFunction>[];
  }

  interface Matchers<T = any> {
    toBe(expected: unknown): T;
    toBeCloseTo(number: number, numDigits?: number): T;
    toBeDefined(): T;
    toBeFalsy(): T;
    toBeGreaterThan(number: number | bigint): T;
    toBeGreaterThanOrEqual(number: number | bigint): T;
    toBeInstanceOf(classType: unknown): T;
    toBeLessThan(number: number | bigint): T;
    toBeLessThanOrEqual(number: number | bigint): T;
    toBeNaN(): T;
    toBeNull(): T;
    toBeTruthy(): T;
    toBeUndefined(): T;
    toContain(expected: unknown): T;
    toContainEqual(expected: unknown): T;
    toEqual(expected: unknown): T;
    toHaveBeenCalled(): T;
    toHaveBeenCalledTimes(expected: number): T;
    toHaveBeenCalledOnce(): T;
    toHaveBeenCalledWith(...expected: unknown[]): T;
    toHaveBeenLastCalledWith(...expected: unknown[]): T;
    toHaveBeenNthCalledWith(nthCall: number, ...expected: unknown[]): T;
    toHaveLength(expected: number): T;
    toHaveProperty(keyPath: string | Array<string | number | symbol>, value?: unknown): T;
    toMatch(expected: string | RegExp): T;
    toMatchObject(expected: Record<string, unknown> | unknown[]): T;
    toStrictEqual(expected: unknown): T;
    toThrow(expected?: string | RegExp | ErrorConstructorLike): T;
  }

  type ErrorConstructorLike = new (...args: any[]) => Error;

  interface Assertion<T = unknown> extends Matchers<Assertion<T>>, Promise<void> {
    not: Assertion<T>;
    resolves: Assertion<Awaited<T>>;
    rejects: Assertion<unknown>;
  }

  interface TestFunction {
    (name: string, fn: (() => void | Promise<unknown>) | undefined, timeout?: number): void;
    skip(name: string, fn?: () => void | Promise<unknown>, timeout?: number): void;
    only(name: string, fn: () => void | Promise<unknown>, timeout?: number): void;
    todo(name: string): void;
    each(table: ReadonlyArray<unknown>): (name: string, fn: (...args: any[]) => void) => void;
  }

  interface DescribeFunction {
    (name: string, fn: () => void): void;
    skip(name: string, fn: () => void): void;
    only(name: string, fn: () => void): void;
    todo(name: string): void;
  }

  interface MockStatic {
    /** Wraps a function in a mock; replaces vitest's vi.fn. */
    fn<TFunction extends Procedure = Procedure>(
      implementation?: TFunction,
    ): MockFunction<TFunction>;
    /** Restores every spy created with spyOn to its original implementation. */
    spyOn<T, K extends keyof T>(
      object: T,
      method: K,
    ): T[K] extends Procedure ? MockFunction<T[K]> : never;
    /** Replaces a module; the factory result is what importers receive. */
    mock(path: string, factory?: () => unknown): void;
    /** Identity cast onto module-mocked functions; bun has no vi.mocked. */
    mocked<TFunction extends Procedure>(item: TFunction): MockFunction<TFunction>;
    restore(): void;
    clearAllMocks(): void;
    resetAllMocks(): void;
    restoreAllMocks(): void;
  }

  interface Vi extends MockStatic {
    useFakeTimers(): void;
    useRealTimers(): void;
    advanceTimersByTime(ms: number): void;
    runAllTimers(): void;
    /** Runs all pending timers, then drains the microtask queue. */
    runAllTimersAsync(): Promise<void>;
    runOnlyPendingTimers(): void;
    clearAllTimers(): void;
    isFakeTimers(): boolean;
    stubGlobal(name: string, value: unknown): void;
    unstubAllGlobals(): void;
    stubEnv(name: string, value: string): void;
    unstubAllEnvs(): void;
  }

  function expect<T = unknown>(actual: T, message?: string): Assertion<T>;
  namespace expect {
    function any(classType: any): any;
    function anything(): any;
    function arrayContaining(sample: readonly unknown[]): any;
    function objectContaining(sample: Record<string, unknown>): any;
    function stringContaining(sample: string): any;
    function stringMatching(sample: string | RegExp): any;
    function extend(matchers: Record<string, (...args: any[]) => any>): void;
  }

  const describe: DescribeFunction;
  const it: TestFunction;
  const test: TestFunction;
  const vi: Vi;
  function beforeAll(fn: () => void | Promise<unknown>): void;
  function beforeEach(fn: () => void | Promise<unknown>): void;
  function afterAll(fn: () => void | Promise<unknown>): void;
  function afterEach(fn: () => void | Promise<unknown>): void;
}
