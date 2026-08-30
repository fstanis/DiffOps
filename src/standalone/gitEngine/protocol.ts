/** One file of a picked repository, addressed by its repo-relative path. */
export interface RepoFile {
  path: string;
  file: File;
}

/** Result of a single lg2 invocation: captured stdout/stderr and the exit code. */
export interface GitRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GitWorkerRequest =
  | { id: number; type: 'mount'; repoName: string; files: RepoFile[] }
  | { id: number; type: 'run'; args: string[] }
  | { id: number; type: 'readFile'; path: string };

export type GitWorkerPayload =
  | { kind: 'mount'; warnings: string[] }
  | { kind: 'run'; run: GitRunResult }
  /** Raw bytes of a file inside the mounted repository, or null when absent. */
  | { kind: 'file'; bytes: ArrayBuffer | null };

export type GitWorkerResponse =
  | { id: number; ok: true; payload: GitWorkerPayload }
  | { id: number; ok: false; error: string };

/** Worker-initiated message without a pending request; engine log lines. */
export type GitWorkerNotice = { type: 'log'; line: string };

export const isGitWorkerNotice = (
  data: GitWorkerResponse | GitWorkerNotice,
): data is GitWorkerNotice => 'type' in data && data.type === 'log';
