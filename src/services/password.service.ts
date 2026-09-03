import {
  randomBytes,
  scrypt as callbackScrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(callbackScrypt);
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const FORMAT = "scrypt-v1";

export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return `${FORMAT}$${salt.toString("base64url")}$${derivedKey.toString("base64url")}`;
};

export const verifyPassword = async (
  password: string,
  storedHash: string,
): Promise<boolean> => {
  const [format, encodedSalt, encodedHash] = storedHash.split("$");
  if (format !== FORMAT || !encodedSalt || !encodedHash) return false;

  try {
    const salt = Buffer.from(encodedSalt, "base64url");
    const expected = Buffer.from(encodedHash, "base64url");
    const actual = (await scrypt(password, salt, expected.length)) as Buffer;
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
};
