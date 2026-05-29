import { CommitAttempt } from "../entities/commit-attempt.entity";
import { BaseRepoService } from "./base.repo";

class CommitAttemptRepoService extends BaseRepoService<CommitAttempt> {
	protected readonly entityName = "CommitAttempt";
	protected readonly entityTarget = CommitAttempt;
}

export const commitAttemptRepo = new CommitAttemptRepoService();
