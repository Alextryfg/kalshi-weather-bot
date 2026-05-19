/**
 * Smoke test for RSA-PSS signing. Generates a fresh RSA keypair, signs a
 * canonical message, and verifies the signature with the public key.
 * Confirms the crypto code path used by KalshiClient.signRequest works.
 */

import * as crypto from 'crypto';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

const timestamp = Date.now().toString();
const method = 'GET';
const pathWithQuery = '/trade-api/v2/markets?status=open&limit=10';
const message = `${timestamp}${method}${pathWithQuery}`;

const signature = crypto
  .sign('sha256', Buffer.from(message, 'utf8'), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  })
  .toString('base64');

const verified = crypto.verify(
  'sha256',
  Buffer.from(message, 'utf8'),
  {
    key: publicKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  },
  Buffer.from(signature, 'base64'),
);

if (!verified) {
  console.error('RSA-PSS signature verification FAILED');
  process.exit(1);
}
console.log('RSA-PSS sign/verify OK');
console.log('  message length:', message.length);
console.log('  signature length (b64):', signature.length);
