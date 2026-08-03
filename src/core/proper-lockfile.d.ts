declare module "proper-lockfile" {
	interface LockOptions {
		realpath?: boolean;
	}

	export function lockSync(file: string, options?: LockOptions): () => void;
}
