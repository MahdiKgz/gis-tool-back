import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, verifyPassword } from "./password.service";

test("hashes passwords with a random salt and verifies without timing-unsafe comparison", async () => {
  const first = await hashPassword("correct horse battery staple");
  const second = await hashPassword("correct horse battery staple");

  assert.notEqual(first, second);
  assert.equal(await verifyPassword("correct horse battery staple", first), true);
  assert.equal(await verifyPassword("incorrect password", first), false);
  assert.equal(await verifyPassword("anything", "not-a-valid-hash"), false);
});
