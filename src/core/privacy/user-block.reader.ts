/**
 * Read-only view of the block graph for other modules.
 *
 * The auth module owns the `user_blocks` table and provides the implementation;
 * feature modules resolve this through the root container so they never import
 * auth internals. Blocking is directional, but messaging is denied when either
 * side has blocked the other, hence a single "between" query.
 */
export interface UserBlockReader {
  isBlockedBetween(firstUserId: string, secondUserId: string): Promise<boolean>;
}
