import { JobEvent } from "../entities/job-event.entity";
import { BaseRepoService } from "./base.repo";

class JobEventRepoService extends BaseRepoService<JobEvent> {
	protected readonly entityName = "JobEvent";
	protected readonly entityTarget = JobEvent;
}

export const jobEventRepo = new JobEventRepoService();
