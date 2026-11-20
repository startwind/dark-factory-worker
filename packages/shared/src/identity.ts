// Node-only helpers: persistent worker identity (ed25519) + challenge signing.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

export interface WorkerIdentity {
  publicKey: string; // base64 DER (spki)
  privateKey: string; // base64 DER (pkcs8)
}

export function generateIdentity(): WorkerIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

export function fingerprint(publicKey: string): string {
  return createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 32);
}

export function signChallenge(id: WorkerIdentity, challenge: string): string {
  const key = createPrivateKey({ key: Buffer.from(id.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  return sign(null, Buffer.from(challenge), key).toString('base64');
}

export function verifyChallenge(publicKey: string, challenge: string, signature: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(challenge), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}
