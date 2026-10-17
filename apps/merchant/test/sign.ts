import { randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { RAILS } from "@boxhaggle/core";

// Test payer: signs real EIP-3009 TransferWithAuthorization payloads for Base USDC.

export function generatePrivateKeyToAccountPair(): PrivateKeyAccount {
  return privateKeyToAccount(generatePrivateKey());
}

export interface SignOptions {
  to: string;
  value: number;
  version: 1 | 2;
  network?: string;
  resource?: string;
  validForSeconds?: number;
  /** Claim this "from" while signing with a different key. */
  forgeFrom?: string;
}

export async function signExactEvm(account: PrivateKeyAccount, o: SignOptions): Promise<{ name: string; value: string }> {
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: (o.forgeFrom ?? account.address) as `0x${string}`,
    to: o.to as `0x${string}`,
    value: String(o.value),
    validAfter: String(now - 30),
    validBefore: String(now + (o.validForSeconds ?? 240)),
    nonce: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
  };
  const signature = await account.signTypedData({
    domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: RAILS.base.usdc as `0x${string}` },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
  const payload = { signature, authorization };
  if (o.version === 1) {
    const body = { x402Version: 1, scheme: "exact", network: o.network ?? "base", payload };
    return { name: "X-PAYMENT", value: Buffer.from(JSON.stringify(body)).toString("base64") };
  }
  const body = {
    x402Version: 2,
    resource: { url: o.resource ?? "" },
    accepted: { scheme: "exact", network: o.network ?? "eip155:8453", amount: String(o.value), asset: RAILS.base.usdc, payTo: o.to },
    payload,
  };
  return { name: "PAYMENT-SIGNATURE", value: Buffer.from(JSON.stringify(body)).toString("base64") };
}
