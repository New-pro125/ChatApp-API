/**
 * Read-only view of read-receipt consent for other modules.
 *
 * The auth module owns `user_privacy_settings` and provides the implementation;
 * feature modules resolve this through the root container so they never import
 * auth internals. Consent is mutual: receipts are visible only when both peers
 * have opted in.
 */
export interface ReadReceiptPreferenceReader {
  areEnabledForPair(firstUserId: string, secondUserId: string): Promise<boolean>;
}
