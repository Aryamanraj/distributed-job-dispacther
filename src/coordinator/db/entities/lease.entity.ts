import {
	Column,
	Entity,
	Index,
	JoinColumn,
	OneToOne,
	PrimaryColumn,
} from "typeorm";
import { Job } from "./job.entity";

@Index("IX_Leases_ExpiresAt", ["ExpiresAt"])
@Entity("Leases")
export class Lease {
	@PrimaryColumn({ name: "JobID", type: "uuid" })
	JobID: string;

	@OneToOne(() => Job)
	@JoinColumn({ name: "JobID" })
	Job: Job;

	@Column({ name: "WorkerID", type: "text" })
	WorkerID: string;

	// pg driver returns bigint columns as strings
	@Column({ name: "Token", type: "bigint" })
	Token: string;

	@Column({ name: "ExpiresAt", type: "timestamptz" })
	ExpiresAt: Date;
}
