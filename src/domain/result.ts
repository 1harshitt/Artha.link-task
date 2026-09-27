/**
 * Result type for error handling without exceptions.
 * Inspired by Rust's Result<T, E> and functional programming patterns.
 */

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/**
 * Create a successful result.
 */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/**
 * Create an error result.
 */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/**
 * Check if a result is ok.
 */
export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}

/**
 * Check if a result is an error.
 */
export function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E } {
  return !result.ok;
}

/**
 * Unwrap a result value or throw if error.
 * Use sparingly - prefer pattern matching with if (isOk(result)).
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) {
    return result.value;
  }
  throw new Error(`Attempted to unwrap an error result: ${JSON.stringify(result.error)}`);
}

/**
 * Map a result value through a function.
 */
export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  if (result.ok) {
    return ok(fn(result.value));
  }
  return result;
}

/**
 * FlatMap (bind/chain) a result through a function that returns a result.
 */
export function flatMap<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>
): Result<U, E> {
  if (result.ok) {
    return fn(result.value);
  }
  return result;
}
