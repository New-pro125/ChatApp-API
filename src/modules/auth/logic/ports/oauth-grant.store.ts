/**
 * Single-use, short-lived grant codes for browser OAuth callbacks.
 *
 * The provider callback redirects the browser to the web client with a grant
 * code, which the client exchanges once for the token pair so tokens never
 * appear in redirect URLs.
 */
export interface OAuthGrantStore {
  issue(userId: string): Promise<string>;
  /** Consumes the code and returns the user id it was issued for. */
  consume(code: string): Promise<string | null>;
}
