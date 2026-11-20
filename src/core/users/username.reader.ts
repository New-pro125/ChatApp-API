/**
 * Resolves a public username to a user id. Auth owns the users table and
 * publishes the implementation; feature modules never query it directly.
 */
export interface UsernameReader {
  findByUsername(username: string): Promise<string | null>;
}
