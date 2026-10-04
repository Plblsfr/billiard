// Déclarations minimales pour le runner de tests intégré à Node,
// afin de ne dépendre d'aucun paquet @types.
declare module 'node:test' {
  type Fn = () => void | Promise<void>;
  export function describe(name: string, fn: Fn): void;
  export function it(name: string, fn: Fn): void;
  export function test(name: string, fn: Fn): void;
}
declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal<T>(actual: T, expected: T, message?: string): void;
    notEqual<T>(actual: T, expected: T, message?: string): void;
    deepEqual<T>(actual: T, expected: T, message?: string): void;
    throws(fn: () => unknown, message?: string | RegExp): void;
  }
  const assert: Assert;
  export default assert;
}
