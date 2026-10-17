import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

// Commit-reveal fairness.
// At session start the merchant publishes H = SHA-256( F || "|" || salt ), where
// F is the hidden floor as a decimal string of atomic USDC and salt is 32 random
// bytes as 64 lowercase hex characters. At session end it reveals F and salt.
// Anyone can recompute H; a match proves the floor never moved mid-game.

export const SALT_HEX_LENGTH = 64;

export function commitmentPreimage(floorAtomic: number, saltHex: string): string {
  if (!Number.isSafeInteger(floorAtomic) || floorAtomic <= 0) {
    throw new Error("floor must be a positive safe integer of atomic USDC");
  }
  if (!new RegExp(`^[0-9a-f]{${SALT_HEX_LENGTH}}$`).test(saltHex)) {
    throw new Error("salt must be 64 lowercase hex characters");
  }
  return `${floorAtomic}|${saltHex}`;
}

export function commit(floorAtomic: number, saltHex: string): string {
  return bytesToHex(sha256(utf8ToBytes(commitmentPreimage(floorAtomic, saltHex))));
}

export interface RevealCheck {
  verified: boolean;
  recomputed: string | null;
  reason?: string;
}

export function verifyReveal(commitment: string, floorAtomic: number, saltHex: string): RevealCheck {
  try {
    const recomputed = commit(floorAtomic, saltHex);
    return { verified: recomputed === commitment.toLowerCase(), recomputed };
  } catch (error) {
    return { verified: false, recomputed: null, reason: error instanceof Error ? error.message : "invalid reveal" };
  }
}

export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}
