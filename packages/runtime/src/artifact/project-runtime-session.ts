import { ArtifactError } from "./errors.js";
import { InMemoryArtifactStore } from "./memory-store.js";
import { exportOpenPackage, importOpenPackage, type OpenPackageFile } from "./open-package.js";
import { validateStoryProjectCandidate } from "./story-design-validator.js";
import { storyPackageCodec } from "./story-package-codec.js";

export interface ProjectRuntimeSessionOptions {
	projectId: string;
	projectRevisionId: string;
	files: readonly OpenPackageFile[];
	now?: () => Date;
}

/** 一个已提交版本的内存工作集：只有 artifact；审稿与笔记是普通文件，派生状态另外算。 */
export class ProjectRuntimeSession {
	readonly projectId: string;
	readonly artifacts: InMemoryArtifactStore;
	#projectRevisionId: string;

	constructor(options: ProjectRuntimeSessionOptions) {
		this.projectId = options.projectId;
		this.#projectRevisionId = options.projectRevisionId;
		this.artifacts = new InMemoryArtifactStore();
		importOpenPackage(
			this.artifacts,
			this.projectId,
			options.files,
			storyPackageCodec,
			validateStoryProjectCandidate,
			{ revisionId: this.#projectRevisionId },
		);
	}

	get projectRevisionId(): string {
		return this.#projectRevisionId;
	}

	get memoryRevisionId(): string {
		return this.artifacts.headRevisionId(this.projectId);
	}

	exportFiles(): OpenPackageFile[] {
		return exportOpenPackage(this.artifacts, this.projectId, this.memoryRevisionId);
	}

	/** @internal Only a deployment Project service advances this binding after commit. */
	advanceProjectRevision(expected: string, next: string): void {
		if (this.#projectRevisionId !== expected) {
			throw new ArtifactError(
				"revision_conflict",
				`Runtime session is based on ${this.#projectRevisionId}, expected ${expected}`,
			);
		}
		this.#projectRevisionId = next;
	}
}
