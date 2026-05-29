import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Index("IX_CommitAttempts_JobID", ["JobID"])
@Entity("CommitAttempts")
export class CommitAttempt {
	@PrimaryGeneratedColumn({ name: "AttemptID", type: "bigint" })
	AttemptID: string;

	@Column({ name: "JobID", type: "uuid" })
	JobID: string;

	@Column({ name: "Accepted", type: "boolean" })
	Accepted: boolean;

	// pg driver returns bigint as string; convert to number before returning
	@Column({ name: "Fence", type: "bigint" })
	Fence: string;

	@Column({ name: "WorkerID", type: "text" })
	WorkerID: string;

	@Column({ name: "AtMs", type: "bigint" })
	AtMs: string;
}
