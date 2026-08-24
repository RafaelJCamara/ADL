import { generateKeyPairSync } from 'node:crypto';

/**
 * A fresh RSA keypair, PKCS8 PEM, for exercising App-auth JWT signing in
 * tests. Thrown away at the end of the process — this is never a real
 * GitHub App's key, and nothing here is persisted.
 */
export function throwawayPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return privateKey;
}
