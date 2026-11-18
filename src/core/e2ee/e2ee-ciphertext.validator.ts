/** Opaque ciphertext fields accepted by the secret-message send path. */
export interface E2eeCiphertextInput {
  readonly recipientDeviceId: string;
  readonly ciphertext: string;
  readonly nonce: string;
  readonly ephemeralPublicKey: string;
}

/**
 * Validates ciphertext envelope shapes without storing or inspecting secrets.
 *
 * The E2EE module provides the implementation; the messaging module depends on
 * this core port so feature modules never import one another.
 */
export interface E2eeCiphertextValidator {
  assertCiphertextInput(input: E2eeCiphertextInput): void;
}
