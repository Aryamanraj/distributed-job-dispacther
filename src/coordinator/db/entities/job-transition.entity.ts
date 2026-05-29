import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Index("IX_JobTransitions_JobID", ["JobID"])
@Entity("JobTransitions")
export class JobTransition {
	@PrimaryGeneratedColumn({ name: "TransitionID", type: "bigint" })
	TransitionID: string;

	@Column({ name: "JobID", type: "uuid" })
	JobID: string;

	@Column({ name: "FromStatus", type: "text" })
	FromStatus: string;

	@Column({ name: "ToStatus", type: "text" })
	ToStatus: string;

	@Column({ name: "AtMs", type: "bigint" })
	AtMs: string;

	@Column({ name: "CoordinatorId", type: "text" })
	CoordinatorId: string;
}
