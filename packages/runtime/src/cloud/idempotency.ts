import { canonicalJson, sha256Hex } from "@suiming/story";
import { CloudStoreError } from "./errors.js";

export interface CloudIdempotencyScope {
	projectId: string;
	actorId: string;
	operation: string;
}

export interface ExecuteCloudIdempotentInput {
	scope: CloudIdempotencyScope;
	idempotencyKey: string;
	payload: unknown;
}

export interface CloudIdempotencyReceipt {
	scope: CloudIdempotencyScope;
	idempotencyKey: string;
	fingerprint: string;
	result: unknown;
	createdAt: string;
}

export interface InMemoryCloudIdempotencyStoreOptions {
	now?: () => Date;
	receipts?: readonly CloudIdempotencyReceipt[];
}

export interface CloudIdempotencyStore {
	execute<T>(input: ExecuteCloudIdempotentInput, operation: () => T | Promise<T>): Promise<T>;
}

interface PendingOperation {
	fingerprint: string;
	promise: Promise<unknown>;
}

function nonempty(value: string, label: string): string {
	const normalized = value.trim();
	if (normalized.length === 0 || normalized.includes("\0")) {
		throw new CloudStoreError("invalid_cloud_store_input", `${label} must be non-empty and contain no NUL`);
	}
	return normalized;
}

function normalizeScope(scope: CloudIdempotencyScope): CloudIdempotencyScope {
	return {
		projectId: nonempty(scope.projectId, "idempotency.projectId"),
		actorId: nonempty(scope.actorId, "idempotency.actorId"),
		operation: nonempty(scope.operation, "idempotency.operation"),
	};
}

function identity(scope: CloudIdempotencyScope, idempotencyKey: string): string {
	return canonicalJson([scope.projectId, scope.actorId, scope.operation, idempotencyKey]);
}

export function cloudIdempotencyFingerprint(payload: unknown): string {
	try {
		return `sha256:${sha256Hex(canonicalJson(payload))}`;
	} catch (error) {
		throw new CloudStoreError(
			"invalid_cloud_store_input",
			`Idempotency payload must be canonical JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function normalizeFingerprint(value: string): string {
	const normalized = nonempty(value, "idempotency.fingerprint");
	if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) {
		throw new CloudStoreError("invalid_cloud_store_snapshot", "Idempotency fingerprint is invalid");
	}
	return normalized;
}

function normalizeTimestamp(value: string): string {
	const normalized = nonempty(value, "idempotency.createdAt");
	if (!Number.isFinite(Date.parse(normalized))) {
		throw new CloudStoreError("invalid_cloud_store_snapshot", "Idempotency receipt timestamp is invalid");
	}
	return normalized;
}

export class InMemoryCloudIdempotencyStore implements CloudIdempotencyStore {
	readonly #receipts = new Map<string, CloudIdempotencyReceipt>();
	readonly #pending = new Map<string, PendingOperation>();
	readonly #now: () => Date;

	constructor(options: InMemoryCloudIdempotencyStoreOptions = {}) {
		this.#now = options.now ?? (() => new Date());
		for (const source of options.receipts ?? []) {
			const scope = normalizeScope(source.scope);
			const idempotencyKey = nonempty(source.idempotencyKey, "idempotency.key");
			const key = identity(scope, idempotencyKey);
			if (this.#receipts.has(key)) {
				throw new CloudStoreError("invalid_cloud_store_snapshot", `Duplicate idempotency receipt: ${key}`);
			}
			this.#receipts.set(key, {
				scope,
				idempotencyKey,
				fingerprint: normalizeFingerprint(source.fingerprint),
				result: clone(source.result),
				createdAt: normalizeTimestamp(source.createdAt),
			});
		}
	}

	receipts(): CloudIdempotencyReceipt[] {
		return [...this.#receipts.values()]
			.map(clone)
			.sort((left, right) =>
				identity(left.scope, left.idempotencyKey).localeCompare(identity(right.scope, right.idempotencyKey)),
			);
	}

	async execute<T>(input: ExecuteCloudIdempotentInput, operation: () => T | Promise<T>): Promise<T> {
		const scope = normalizeScope(input.scope);
		const idempotencyKey = nonempty(input.idempotencyKey, "idempotency.key");
		const key = identity(scope, idempotencyKey);
		const actualFingerprint = cloudIdempotencyFingerprint(input.payload);
		const receipt = this.#receipts.get(key);
		if (receipt !== undefined) {
			this.#assertFingerprint(receipt.fingerprint, actualFingerprint);
			return clone(receipt.result) as T;
		}
		const pending = this.#pending.get(key);
		if (pending !== undefined) {
			this.#assertFingerprint(pending.fingerprint, actualFingerprint);
			return clone((await pending.promise) as T);
		}

		const promise = Promise.resolve()
			.then(operation)
			.then((result) => {
				const saved = clone(result);
				this.#receipts.set(key, {
					scope,
					idempotencyKey,
					fingerprint: actualFingerprint,
					result: saved,
					createdAt: this.#timestamp(),
				});
				return saved;
			});
		this.#pending.set(key, { fingerprint: actualFingerprint, promise });
		try {
			return clone((await promise) as T);
		} finally {
			if (this.#pending.get(key)?.promise === promise) this.#pending.delete(key);
		}
	}

	#assertFingerprint(expected: string, actual: string): void {
		if (expected !== actual) {
			throw new CloudStoreError(
				"cloud_idempotency_conflict",
				"Idempotency key was already used with different input",
			);
		}
	}

	#timestamp(): string {
		const value = this.#now();
		if (!Number.isFinite(value.getTime())) {
			throw new CloudStoreError("invalid_cloud_store_input", "Clock returned invalid time");
		}
		return value.toISOString();
	}
}
