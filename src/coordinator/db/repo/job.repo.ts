import { Job } from "../entities/job.entity";
import { BaseRepoService } from "./base.repo";

class JobRepoService extends BaseRepoService<Job> {
	protected readonly entityName = "Job";
	protected readonly entityTarget = Job;
}

export const jobRepo = new JobRepoService();
