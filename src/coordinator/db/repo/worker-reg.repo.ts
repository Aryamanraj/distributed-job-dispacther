import { WorkerReg } from "../entities/worker-reg.entity";
import { BaseRepoService } from "./base.repo";

class WorkerRegRepoService extends BaseRepoService<WorkerReg> {
	protected readonly entityName = "WorkerReg";
	protected readonly entityTarget = WorkerReg;
}

export const workerRegRepo = new WorkerRegRepoService();
