import { JobTransition } from "../entities/job-transition.entity";
import { BaseRepoService } from "./base.repo";

class JobTransitionRepoService extends BaseRepoService<JobTransition> {
	protected readonly entityName = "JobTransition";
	protected readonly entityTarget = JobTransition;
}

export const jobTransitionRepo = new JobTransitionRepoService();
