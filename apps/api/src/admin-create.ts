import argon2 from "argon2";
import { createPostgresPoolFromEnv, PostgresPlatformStore } from "@council/database";

const emailIndex = process.argv.indexOf("--email");
const email = emailIndex >= 0 ? process.argv[emailIndex + 1] : undefined;
if (!email) throw new Error("Usage: admin:create --email <owner-email>; password is read from stdin.");

let password = "";
for await (const chunk of process.stdin) password += chunk.toString();
password = password.trimEnd();
if (password.length < 12) throw new Error("Owner password must contain at least 12 characters.");

const pool = await createPostgresPoolFromEnv();
const store = new PostgresPlatformStore(pool);
try {
  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1
  });
  const owner = await store.createOwner(email, passwordHash);
  process.stdout.write(`Owner created: ${owner.email}\n`);
} finally {
  await store.close();
}
