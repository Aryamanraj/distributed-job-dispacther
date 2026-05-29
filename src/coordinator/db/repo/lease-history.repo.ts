import type { EntityManager } from "typeorm";
import { IsNull } from "typeorm";
import { LeaseHistory } from "../entities/lease-history.entity";
import { BaseRepoService } from "./base.repo";

class LeaseHistoryRepoService extends BaseRepoService<LeaseHistory> {
	protected readonly entityName = "LeaseHistory";
	protected readonly entityTarget = LeaseHistory;

	/** Mark the most recent open lease for a job as terminated. */
	async terminate(
		jobId: string,
		terminatedAtMs: string,
		em?: EntityManager,
	): Promise<void> {
		await this.repo(em).update(
			{ JobID: jobId, TerminatedAtMs: IsNull() },
			{ TerminatedAtMs: terminatedAtMs },
		);
	}
}

export const leaseHistoryRepo = new LeaseHistoryRepoService();
