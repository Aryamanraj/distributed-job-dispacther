import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Index("IX_LeaseHistory_JobID", ["JobID"])
@Entity("LeaseHistory")
export class LeaseHistory {
	@PrimaryGeneratedColumn({ name: "EntryID", type: "bigint" })
	EntryID: string;

	@Column({ name: "JobID", type: "uuid" })
	JobID: string;

	@Column({ name: "WorkerID", type: "text" })
	WorkerID: string;

	// pg driver returns bigint as string; convert to number before returning
	@Column({ name: "Fence", type: "bigint" })
	Fence: string;

	@Column({ name: "IssuedAtMs", type: "bigint" })
	IssuedAtMs: string;

	@Column({ name: "TerminatedAtMs", type: "bigint", nullable: true })
	TerminatedAtMs: string | null;
}
