// Errors-as-values. No thrown exceptions across module boundaries
// (Constitution §III). Internal helpers MAY throw on programmer-error
// invariants (assertions); recoverable errors return Err.

export interface Ok<T> { readonly ok: true; readonly value: T }
export interface Err<E> { readonly ok: false; readonly error: E }
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

// Test/dev helper — throws if used on Err. Production code MUST branch on `ok`.
export const unwrap = <T, E>(r: Result<T, E>): T => {
  if (r.ok) return r.value;
  throw new Error(`unwrap on Err: ${JSON.stringify(r.error)}`);
};

export const map = <T, U, E>(r: Result<T, E>, f: (v: T) => U): Result<U, E> =>
  r.ok ? ok(f(r.value)) : r;

export const mapErr = <T, E, F>(r: Result<T, E>, f: (e: E) => F): Result<T, F> =>
  r.ok ? r : err(f(r.error));

export const andThen = <T, U, E>(
  r: Result<T, E>,
  f: (v: T) => Result<U, E>,
): Result<U, E> => (r.ok ? f(r.value) : r);
