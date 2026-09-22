import argon2 from 'argon2';

/**
 * argon2id via the `argon2` package. Hashing, salting, encoding and the constant-time
 * verify are all the library's; nothing here is hand-rolled.
 *
 * The parameters are OWASP's recommended argon2id floor rather than the package
 * defaults (64 MiB, t=3). An OPDS reader sends Basic credentials on *every* request,
 * so a feed page with twenty-five covers is twenty-five verifies, and argon2 runs on
 * libuv's four-thread pool: 4 × 64 MiB on top of a conversion peak does not fit the
 * container's cap, 4 × 19 MiB does.
 * ponytail: still ~30 ms of CPU per request; cache verified credentials for a few
 * minutes if a reader ever feels slow.
 *
 * The encoded hash starts with `$argon2id$`, which Docker Compose interpolates when
 * it sees it in an env_file. So a hash never goes near the environment: it lives only
 * in the users table, and OPDS_PASSWORD (plaintext) seeds the first row.
 */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

/** False for a malformed stored value rather than a throw: a corrupt row must not 500 a login. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    return await argon2.verify(stored, password);
  } catch {
    return false;
  }
}
