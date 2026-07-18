const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const SECRET_KEY = process.env.JWT_SECRET || 'schoolos_secret_key_123';

// Derive a 32-byte key from the secret
const KEY = crypto.scryptSync(SECRET_KEY, 'salt_schoolos_invitations', 32);

function encrypt(text) {
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    // Format: iv:encryptedText
    return `${iv.toString('hex')}:${encrypted}`;
  } catch (err) {
    console.error('Encryption failed:', err);
    return null;
  }
}

function decrypt(hash) {
  try {
    const [ivHex, encryptedHex] = hash.split(':');
    if (!ivHex || !encryptedHex) return null;
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    // Decryption failed (tampered key, bad input etc.)
    return null;
  }
}

module.exports = {
  encrypt,
  decrypt
};
