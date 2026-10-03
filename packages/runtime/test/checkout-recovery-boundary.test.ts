import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalCheckoutSynchronizer } from "../src/local/checkout-synchronizer.js";

for (const mutation of ["create", "replace", "delete"] as const) {
	test(`checkout ${mutation} 恢复拒绝父目录 symlink，恢复正常目录后仍可继续`, async () => {
		const root = await mkdtemp(join(tmpdir(), "suiming-checkout-boundary-"));
		try {
			const checkout = join(root, "checkout");
			const outside = join(root, "outside");
			await mkdir(join(checkout, "intent"), { recursive: true });
			await mkdir(outside);
			await writeFile(join(checkout, "intent/test.md"), "conflict");
			if (mutation !== "create") await writeFile(join(outside, "test.md"), "before");
			const files = (content: string) => [
				{ path: "intent/test.md", mediaType: "text/markdown", bytes: Buffer.from(content) },
			];
			const sync = new LocalCheckoutSynchronizer(checkout);
			await assert.rejects(
				sync.sync(
					mutation === "create" ? [] : files("before"),
					mutation === "delete" ? [] : files("after"),
					"revision",
				),
				{ code: "checkout_write_conflict" },
			);
			await rename(join(checkout, "intent"), join(checkout, "original"));
			await symlink(outside, join(checkout, "intent"));
			await assert.rejects(sync.recover("revision"), { code: "unsafe_file_path" });
			if (mutation === "create") await assert.rejects(readFile(join(outside, "test.md")), { code: "ENOENT" });
			else assert.equal(await readFile(join(outside, "test.md"), "utf8"), "before");
			await rm(join(checkout, "intent"));
			await rename(join(checkout, "original"), join(checkout, "intent"));
			if (mutation === "create") await rm(join(checkout, "intent/test.md"));
			else await writeFile(join(checkout, "intent/test.md"), "before");
			assert.equal(await sync.recover("revision"), true);
			if (mutation === "delete")
				await assert.rejects(readFile(join(checkout, "intent/test.md")), { code: "ENOENT" });
			else assert.equal(await readFile(join(checkout, "intent/test.md"), "utf8"), "after");
			assert.equal(await sync.recover("revision"), false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}
