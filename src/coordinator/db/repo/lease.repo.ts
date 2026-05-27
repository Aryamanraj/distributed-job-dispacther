import { Lease } from "../entities/lease.entity";
import { BaseRepoService } from "./base.repo";

class LeaseRepoService extends BaseRepoService<Lease> {
	protected readonly entityName = "Lease";
	protected readonly entityTarget = Lease;
}

export const leaseRepo = new LeaseRepoService();
