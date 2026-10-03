import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ArtifactError } from "../artifact/errors.js";
import type { OpenPackageFile } from "../artifact/open-package.js";
import { classifyOpenStoryDirectoryFile } from "../artifact/open-story-directory.js";
import { confinedPath } from "../files/confined-path.js";

interface CheckoutWriteOperation {
	path: string;
	beforeSha256: string | null;
	afterSha256: string | null;
}

interface CheckoutWriteJournal {
	schemaVersion: 1;
	transactionId: string;
	targetRevisionId: string;
	operations: CheckoutWriteOperation[];
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function filesByPath(files: readonly OpenPackageFile[]): Map<string, OpenPackageFile> {
	const result = new Map<string, OpenPackageFile>();
	for (const file of files) {
		const kind = classifyOpenStoryDirectoryFile(file.path);
		if (kind !== "story") {
			throw new ArtifactError("invalid_checkout_snapshot", `Checkout snapshot contains ${file.path}`);
		}
		if (result.has(file.path)) throw new ArtifactError("duplicate_logical_path", `Duplicate path: ${file.path}`);
		result.set(file.path, file);
	}
	return result;
}

function parseJournal(value: unknown): CheckoutWriteJournal {
	if (typeof value !== "object" || value === null) {
		throw new ArtifactError("checkout_journal_corrupt", "Checkout write journal must be an object");
	}
	const journal = value as Partial<CheckoutWriteJournal>;
	if (
		journal.schemaVersion !== 1 ||
		typeof journal.transactionId !== "string" ||
		!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(journal.transactionId) ||
		typeof journal.targetRevisionId !== "string" ||
		journal.targetRevisionId.length === 0 ||
		!Array.isArray(journal.operations)
	) {
		throw new ArtifactError("checkout_journal_corrupt", "Checkout write journal header is invalid");
	}
	for (const operation of journal.operations) {
		if (
			typeof operation !== "object" ||
			operation === null ||
			typeof operation.path !== "string" ||
			(operation.beforeSha256 !== null && !/^[a-f0-9]{64}$/u.test(operation.beforeSha256)) ||
			(operation.afterSha256 !== null && !/^[a-f0-9]{64}$/u.test(operation.afterSha256)) ||
			classifyOpenStoryDirectoryFile(operation.path) !== "story"
		) {
			throw new ArtifactError("checkout_journal_corrupt", "Checkout write journal operation is invalid");
		}
	}
	return journal as CheckoutWriteJournal;
}

async function fileHash(path: string): Promise<string | null> {
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink() || !info.isFile()) {
			throw new ArtifactError("checkout_write_conflict", `Checkout target is not a regular file: ${path}`);
		}
		return sha256(await readFile(path));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export class LocalCheckoutSynchronizer {
	readonly checkoutPath: string;
	readonly #privatePath: string;
	readonly #journalPath: string;
	readonly #stagingRoot: string;

	constructor(checkoutPath: string) {
		this.checkoutPath = checkoutPath;
		this.#privatePath = join(checkoutPath, ".suiming");
		this.#journalPath = join(this.#privatePath, "checkout-write.json");
		this.#stagingRoot = join(this.#privatePath, "checkout-staging");
	}

	async recover(expectedRevisionId: string): Promise<boolean> {
		await confinedPath(this.checkoutPath, this.#journalPath);
		await confinedPath(this.checkoutPath, this.#stagingRoot);
		let journal: CheckoutWriteJournal;
		try {
			journal = parseJournal(JSON.parse(await readFile(this.#journalPath, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				await rm(this.#stagingRoot, { recursive: true, force: true });
				return false;
			}
			if (error instanceof ArtifactError) throw error;
			throw new ArtifactError(
				"checkout_journal_corrupt",
				`Cannot read checkout write journal: ${(error as Error).message}`,
			);
		}
		if (journal.targetRevisionId !== expectedRevisionId) {
			throw new ArtifactError(
				"checkout_journal_revision_mismatch",
				`Checkout journal targets ${journal.targetRevisionId}, but Project head is ${expectedRevisionId}`,
			);
		}
		await this.#apply(journal);
		return true;
	}

	async sync(
		beforeFiles: readonly OpenPackageFile[],
		afterFiles: readonly OpenPackageFile[],
		targetRevisionId: string,
	): Promise<void> {
		await this.recover(targetRevisionId);
		const before = filesByPath(beforeFiles);
		const after = filesByPath(afterFiles);
		const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
		const operations: CheckoutWriteOperation[] = paths.flatMap((path) => {
			const beforeFile = before.get(path);
			const afterFile = after.get(path);
			const beforeSha256 = beforeFile === undefined ? null : sha256(beforeFile.bytes);
			const afterSha256 = afterFile === undefined ? null : sha256(afterFile.bytes);
			return beforeSha256 === afterSha256 ? [] : [{ path, beforeSha256, afterSha256 }];
		});
		if (operations.length === 0) return;

		const transactionId = randomUUID();
		const stagingPath = join(this.#stagingRoot, transactionId);
		for (const operation of operations) {
			await confinedPath(this.checkoutPath, join(this.checkoutPath, operation.path));
			const file = after.get(operation.path);
			if (file === undefined) continue;
			const path = join(stagingPath, operation.path);
			await confinedPath(this.checkoutPath, path);
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			await writeFile(path, file.bytes, { flag: "wx", mode: 0o644 });
		}

		const journal: CheckoutWriteJournal = {
			schemaVersion: 1,
			transactionId,
			targetRevisionId,
			operations,
		};
		await mkdir(this.#privatePath, { recursive: true, mode: 0o700 });
		const temporaryJournal = join(this.#privatePath, `.checkout-write-${randomUUID()}.tmp`);
		try {
			await writeFile(temporaryJournal, `${JSON.stringify(journal)}\n`, { flag: "wx", mode: 0o600 });
			await rename(temporaryJournal, this.#journalPath);
		} catch (error) {
			await rm(temporaryJournal, { force: true }).catch(() => undefined);
			throw error;
		}
		await this.#apply(journal);
	}

	async #apply(journal: CheckoutWriteJournal): Promise<void> {
		const stagingPath = join(this.#stagingRoot, journal.transactionId);
		await confinedPath(this.checkoutPath, stagingPath);
		for (const operation of journal.operations) {
			const targetPath = await confinedPath(this.checkoutPath, operation.path);
			const currentHash = await fileHash(targetPath);
			if (currentHash === operation.afterSha256) continue;
			if (currentHash !== operation.beforeSha256) {
				throw new ArtifactError(
					"checkout_write_conflict",
					`Checkout changed while materializing ${operation.path}`,
				);
			}
			if (operation.afterSha256 === null) {
				await confinedPath(this.checkoutPath, targetPath);
				await rm(targetPath);
				continue;
			}
			const stagedPath = await confinedPath(this.checkoutPath, join(stagingPath, operation.path));
			if ((await fileHash(stagedPath)) !== operation.afterSha256) {
				throw new ArtifactError(
					"checkout_journal_corrupt",
					`Staged checkout file is missing or corrupt: ${operation.path}`,
				);
			}
			await mkdir(dirname(targetPath), { recursive: true });
			await confinedPath(this.checkoutPath, targetPath);
			await confinedPath(this.checkoutPath, stagedPath);
			await rename(stagedPath, targetPath);
		}
		await rm(stagingPath, { recursive: true, force: true });
		await rm(this.#journalPath);
		await rm(this.#stagingRoot, { recursive: true, force: true });
	}
}
